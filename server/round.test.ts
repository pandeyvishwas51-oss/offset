import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { fakePayPal } from "./fakepaypal.ts";
import { scriptedBrain } from "./brain.ts";
import { seed } from "./seed.ts";
import { payRemaining, payoutSettled, reconcile, runRound } from "./round.ts";

async function world(opts: Parameters<typeof fakePayPal>[0] = {}) {
  const db = openDb(":memory:");
  const paypal = fakePayPal(opts);
  const deps = { db, paypal, brain: scriptedBrain() };
  await seed(db, paypal, {});
  return deps;
}
const sum = (xs: { open: number }[]) => xs.reduce((s, x) => s + x.open, 0);
const paypalDue = (paypal: ReturnType<typeof fakePayPal>) => [...paypal.invoices.values()].filter((i) => i.status !== "CANCELLED").reduce((s, i) => s + i.due, 0);

test("a round cancels debt, keeps bad invoices out, and PayPal agrees with our books", async () => {
  const deps = await world();
  await runRound(deps);
  const round = deps.db.latestRound()!;
  assert.equal(round.status, "cleared");
  assert.equal(round.gross, 6425000);

  const invoices = deps.db.invoices();
  assert.equal(invoices.find((i) => i.id === "BX-3340")!.status, "held", "inflated invoice is held");
  assert.equal(invoices.find((i) => i.id === "HD-2231")!.status, "disputed", "disputed invoice is kept out");
  assert.equal(invoices.find((i) => i.id === "BX-3340")!.open, 480000, "held invoice is untouched");

  assert.equal(sum(invoices), round.left);
  assert.equal(paypalDue(deps.paypal), round.left, "PayPal's amounts due match ours");
  assert.ok(round.left < round.gross / 2, "more than half the debt is gone");
});

test("if PayPal fails halfway through settlement, everything is reversed", async () => {
  const deps = await world({ failOn: (op, n) => op === "recordPayment" && n === 5 });
  const before = paypalDue(deps.paypal);
  await runRound(deps);
  assert.equal(deps.db.latestRound()!.status, "failed");
  assert.equal(paypalDue(deps.paypal), before, "no invoice on PayPal changed");
  assert.equal(sum(deps.db.invoices()), before, "no invoice in our books changed");
  assert.equal(deps.db.all("SELECT 1 FROM leg WHERE status IN ('sent', 'done')").length, 0);
  assert.equal(deps.db.invoices().filter((i) => i.from_round).length, 0, "no redirected invoices left behind");
});

test("paying what is left settles every clean invoice, and a repeated webhook changes nothing", async () => {
  const deps = await world();
  await runRound(deps);
  await payRemaining(deps);
  await reconcile(deps);
  const clean = deps.db.invoices().filter((i) => i.status !== "held" && i.status !== "disputed");
  assert.equal(sum(clean), 0);
  assert.equal(paypalDue(deps.paypal), 480000 + 240000, "only the held and disputed invoices remain due on PayPal");

  const count = (op: string) => deps.paypal.calls.filter((c) => c === op).length;
  const [recorded, payouts] = [count("recordPayment"), count("createPayout")];
  const leg = deps.db.get<{ invoice_id: string; ref: string }>("SELECT invoice_id, ref FROM leg WHERE kind = 'payout' LIMIT 1")!;
  assert.equal(await payoutSettled(deps, { itemId: leg.invoice_id, ref: leg.ref, status: "SUCCESS" }), "nothing waiting on this payment");
  await payRemaining(deps); // pressing the button twice must not pay twice
  assert.equal(count("recordPayment"), recorded);
  assert.equal(count("createPayout"), payouts, "no second payout");
});

test("a failed payout leaves its invoice open", async () => {
  const deps = await world({ payoutStatus: (id) => (id === "SF-7742" ? "FAILED" : "SUCCESS") });
  await runRound(deps);
  await payRemaining(deps);
  await reconcile(deps);
  const inv = deps.db.invoice("SF-7742");
  assert.equal(inv.status, "open");
  assert.ok(inv.open > 0);
});

test("an agent that cannot answer means no, never yes", async () => {
  const deps = await world();
  const brain = { ...scriptedBrain(), verify: async () => { throw new Error("model unavailable"); } };
  await runRound({ ...deps, brain });
  assert.equal(deps.db.invoices().filter((i) => i.status === "held").length, 14);
  assert.equal(deps.paypal.calls.filter((c) => c === "recordPayment").length, 0);
});

test("a payout PayPal rejects can be sent again, and starting over resets the sandbox", async () => {
  const deps = await world({ failOn: (op, n) => op === "createPayout" && n === 1 });
  await runRound(deps);
  await payRemaining(deps); // the first debtor's payout is rejected
  assert.ok(deps.db.all("SELECT 1 FROM leg WHERE kind = 'payout' AND status = 'failed'").length > 0);
  await payRemaining(deps); // second attempt goes through
  await reconcile(deps);
  assert.equal(sum(deps.db.invoices().filter((i) => i.status === "open")), 0);

  const payouts = deps.paypal.calls.filter((c) => c === "createPayout").length;
  await seed(deps.db, deps.paypal, {});
  assert.ok(deps.paypal.calls.filter((c) => c === "createPayout").length > payouts, "last run's payments are sent back");
  assert.equal(deps.paypal.calls.filter((c) => c === "cancelInvoice").length, 2, "the held and disputed invoices are withdrawn");
  assert.equal(deps.db.invoices().length, 14);
});
