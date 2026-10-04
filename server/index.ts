import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { payRemaining, payoutSettled, reconcile, recover, runRound, type Deps } from "./round.ts";
import { seed } from "./seed.ts";

const config = loadConfig();
// The simulated PayPal lives in memory, so its books must too; otherwise a restart would leave them disagreeing.
const db = openDb(config.sandbox ? undefined : ":memory:");
const deps: Deps = { db, paypal: config.paypal, brain: config.brain };

let busy: string | null = null;
const roundTimes: number[] = [];
const MAX_ROUNDS_PER_HOUR = 30; // each round costs real model calls; this caps what a public demo link can spend

async function exclusive(label: string, work: () => Promise<unknown>) {
  if (busy) throw Object.assign(new Error(`Busy: ${busy}. Try again in a moment.`), { status: 409 });
  busy = label;
  try {
    await work();
  } finally {
    busy = null;
  }
}

function state() {
  const round = db.latestRound() ?? null;
  return {
    paypal: config.paypal.mode,
    agents: config.brain.kind,
    webhooks: Boolean(config.sandbox && config.publicUrl),
    busy,
    businesses: db.businesses().map(({ id, name, trade, on_time_pct, avg_days_late, policy }) => ({ id, name, trade, on_time_pct, avg_days_late, policy })),
    invoices: db.invoices(),
    round,
    steps: round ? db.all("SELECT * FROM step WHERE round_id = ? ORDER BY id", round.id) : [],
    legs: db.all("SELECT * FROM leg ORDER BY id"),
    events: db.all("SELECT * FROM event ORDER BY id"),
    received: db.all("SELECT * FROM webhook ORDER BY at DESC"),
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// PayPal calls this when a payout item changes state. Nothing here is trusted until PayPal confirms the signature.
async function webhook(req: IncomingMessage, business: string): Promise<{ status: number; body: object }> {
  const raw = await readBody(req);
  const biz = db.get<{ webhook_id: string | null }>("SELECT webhook_id FROM business WHERE id = ?", business);
  if (!config.sandbox || !biz?.webhook_id) return { status: 404, body: { error: "No webhook registered for this business" } };
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  if (!(await config.sandbox.verifyWebhook(business, biz.webhook_id, headers, raw))) return { status: 400, body: { error: "Signature check failed" } };

  const event = JSON.parse(raw) as { id: string; event_type: string; resource?: { payout_item_id?: string; transaction_status?: string; payout_item?: { sender_item_id?: string }; id?: string } };
  const ref = event.resource?.payout_item?.sender_item_id ?? event.resource?.id ?? null;
  const fresh = db.run("INSERT OR IGNORE INTO webhook (id, business, type, ref, verified, at) VALUES (?, ?, ?, ?, 'signature verified', ?)", event.id, business, event.event_type, ref, db.now()).changes;
  if (!fresh) return { status: 200, body: { duplicate: true } }; // PayPal retries; the first delivery already did the work

  let outcome = "noted";
  const item = event.resource;
  if (event.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.") && item?.payout_item?.sender_item_id && item.payout_item_id && item.transaction_status) {
    outcome = await payoutSettled(deps, { itemId: item.payout_item.sender_item_id, ref: item.payout_item_id, status: item.transaction_status });
  }
  db.run("UPDATE webhook SET outcome = ? WHERE id = ?", outcome, event.id);
  return { status: 200, body: { outcome } };
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
const DIST = join(import.meta.dirname, "..", "dist");

async function serveStatic(path: string, res: ServerResponse) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  const file = join(DIST, safe === "/" || !extname(safe) ? "index.html" : safe);
  if (!file.startsWith(DIST)) return send(res, 403, { error: "Forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, { error: "Not found. Run `npm run build` to build the interface." });
  }
}

function send(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /api/state") return send(res, 200, state());
    if (route === "POST /api/seed") {
      await exclusive("issuing invoices", () => seed(db, config.paypal, config.emails).then(registerWebhooks));
      return send(res, 200, state());
    }
    if (route === "POST /api/round") {
      const hourAgo = Date.now() - 3600_000;
      while (roundTimes.length && roundTimes[0] < hourAgo) roundTimes.shift();
      if (roundTimes.length >= MAX_ROUNDS_PER_HOUR) return send(res, 429, { error: "This demo has run its limit of rounds for the hour. Try again later." });
      if (!db.invoices().length) return send(res, 409, { error: "Issue the invoices first." });
      if (busy) return send(res, 409, { error: `Busy: ${busy}.` });
      roundTimes.push(Date.now());
      // Runs in the background; the interface follows along through /api/state.
      void exclusive("clearing debts", () => runRound(deps)).catch((e) => console.error(e));
      return send(res, 202, { started: true });
    }
    if (route === "POST /api/pay") {
      await exclusive("sending payments", () => payRemaining(deps));
      return send(res, 200, state());
    }
    const hook = url.pathname.match(/^\/webhooks\/paypal\/([a-z]+)$/);
    if (req.method === "POST" && hook) {
      const out = await webhook(req, hook[1]);
      return send(res, out.status, out.body);
    }
    if (req.method === "GET") return serveStatic(url.pathname, res);
    send(res, 404, { error: "Not found" });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

// Points each business's PayPal app at this server, when it has a public address PayPal can reach.
async function registerWebhooks() {
  if (!config.sandbox || !config.publicUrl) return;
  for (const b of db.businesses()) {
    try {
      const id = await config.sandbox.registerWebhook(b.id, `${config.publicUrl}/webhooks/paypal/${b.id}`);
      db.run("UPDATE business SET webhook_id = ? WHERE id = ?", id, b.id);
    } catch (e) {
      console.error(`webhook registration for ${b.id} failed:`, e instanceof Error ? e.message : e);
    }
  }
}

await recover(deps);
if (!config.sandbox) await seed(db, config.paypal, config.emails);
else await registerWebhooks();
// Webhooks are the fast path. This poll is the safety net for the ones that never arrive.
setInterval(() => void reconcile(deps), config.sandbox ? 8000 : 1500).unref();

server.listen(config.port, () => {
  console.log(`OFFSET on http://localhost:${config.port}  |  PayPal: ${config.paypal.mode}  |  agents: ${config.brain.kind}  |  webhooks: ${config.publicUrl ? "on" : "off (polling only)"}`);
});
