import { useEffect, useMemo, useRef, useState } from "react";
import { Agents, type Focus } from "./Agents.tsx";
import { Graph, type Debt, type Proposal } from "./Graph.tsx";
import { Ledger } from "./Ledger.tsx";
import type { Event, State, Step } from "./types.ts";
import { usd, usd0 } from "./types.ts";

const STEP_KINDS = new Set(["loop", "redirect"]);
const TONE: Record<string, string> = {
  hold: "no", dispute: "no", reject: "no", error: "no", nodeal: "no", counter: "maybe",
  accept: "yes", ok: "yes", loop: "yes", redirect: "yes", settled: "yes", paid: "yes", done: "yes",
};

type Pair = { debtor: string; creditor: string; owed: number; redirected: number };

// Replays the round on the page: the debts as they stood, minus each agreed step revealed so far.
function replay(snapshot: { debtor: string; creditor: string; amount: number }[], steps: Step[]): Map<string, Pair> {
  const pairs = new Map<string, Pair>(snapshot.map((p) => [`${p.debtor}>${p.creditor}`, { debtor: p.debtor, creditor: p.creditor, owed: p.amount, redirected: 0 }]));
  const cut = (debtor: string, creditor: string, amount: number) => {
    const p = pairs.get(`${debtor}>${creditor}`);
    if (!p) return;
    const fromOwed = Math.min(p.owed, amount);
    p.owed -= fromOwed;
    p.redirected -= amount - fromOwed;
  };
  for (const s of steps) {
    const path = JSON.parse(s.path) as string[];
    if (s.kind === "loop") path.forEach((node, i) => cut(node, path[(i + 1) % path.length], s.amount));
    else {
      const [from, via, to] = path;
      cut(from, via, s.amount);
      cut(via, to, s.amount);
      const key = `${from}>${to}`;
      const p = pairs.get(key) ?? { debtor: from, creditor: to, owed: 0, redirected: 0 };
      p.redirected += s.amount;
      pairs.set(key, p);
    }
  }
  return pairs;
}

const stepKeys = (s: Step): string[] => {
  const path = JSON.parse(s.path) as string[];
  return s.kind === "loop" ? path.map((n, i) => `${n}>${path[(i + 1) % path.length]}`) : [`${path[0]}>${path[1]}`, `${path[1]}>${path[2]}`, `${path[0]}>${path[2]}`];
};

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(0);
  const [hot, setHot] = useState<Set<string>>(new Set());
  const firstLoad = useRef(true);
  const feed = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let live = true;
    const load = () => fetch("/api/state").then((r) => r.json()).then((s) => live && setState(s)).catch(() => live && setProblem("Cannot reach the OFFSET server."));
    load();
    const timer = setInterval(load, 800);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const round = state?.round ?? null;
  const events: Event[] = useMemo(() => (state?.events ?? []).filter((e) => e.round_id === null || e.round_id === round?.id), [state?.events, round?.id]);

  // Entries appear one at a time so the round can be followed; a page opened later shows everything at once.
  useEffect(() => {
    if (!state) return;
    if (firstLoad.current) { firstLoad.current = false; setShown(events.length); return; }
    if (shown > events.length) { setShown(events.length); return; }
    if (shown < events.length) {
      const timer = setTimeout(() => setShown((n) => n + 1), 420);
      return () => clearTimeout(timer);
    }
  }, [state === null, events.length, shown]);

  const visible = events.slice(0, shown);
  const caughtUp = shown >= events.length;
  const undone = round?.status === "failed";
  const agreed = (state?.steps ?? []).filter((s) => s.status === "agreed");
  const revealed = undone ? [] : agreed.slice(0, visible.filter((e) => STEP_KINDS.has(e.kind)).length);

  useEffect(() => {
    const last = revealed.at(-1);
    if (!last) return;
    setHot(new Set(stepKeys(last)));
    const timer = setTimeout(() => setHot(new Set()), 1500);
    return () => clearTimeout(timer);
  }, [revealed.length]);

  // Scrolls the feed itself, never the page.
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight; }, [shown]);

  if (!state) return <main className="page"><p className="loading">{problem ?? "Loading…"}</p></main>;

  const { invoices, businesses, legs } = state;
  const flagged = invoices.filter((i) => i.status === "held" || i.status === "disputed");
  const replaying = round?.snapshot && !undone && !(round.status === "cleared" && caughtUp);

  let pairs: Map<string, Pair>;
  if (replaying) pairs = replay(JSON.parse(round.snapshot!), revealed);
  else {
    pairs = new Map();
    for (const i of invoices.filter((i) => i.status === "open" || i.status === "settled")) {
      const key = `${i.debtor}>${i.creditor}`;
      const p = pairs.get(key) ?? { debtor: i.debtor, creditor: i.creditor, owed: 0, redirected: 0 };
      if (i.from_round) p.redirected += i.open; else p.owed += i.open;
      pairs.set(key, p);
    }
  }
  const debts: Debt[] = [
    ...[...pairs.values()].map((p) => ({ debtor: p.debtor, creditor: p.creditor, amount: p.owed + p.redirected, kind: p.owed > 0 || p.redirected === 0 ? "owed" as const : "redirected" as const })),
    ...flagged.map((i) => ({ debtor: i.debtor, creditor: i.creditor, amount: i.open, kind: "held" as const, note: `${i.number}: ${i.flag}` })),
  ];
  const net = new Map<string, number>();
  for (const d of debts.filter((d) => d.kind !== "held")) {
    net.set(d.creditor, (net.get(d.creditor) ?? 0) + d.amount);
    net.set(d.debtor, (net.get(d.debtor) ?? 0) - d.amount);
  }
  const byPair = new Map<string, number>();
  for (const i of invoices.filter((i) => !i.from_round)) byPair.set(`${i.debtor}>${i.creditor}`, (byPair.get(`${i.debtor}>${i.creditor}`) ?? 0) + i.amount);
  const scale = Math.max(1, ...byPair.values());

  const owed = round?.gross || invoices.reduce((s, i) => s + i.open, 0);
  const cancelled = revealed.reduce((s, st) => s + st.amount * (st.kind === "loop" ? (JSON.parse(st.path) as string[]).length : 1), 0);
  const held = round && !undone ? flagged.reduce((s, i) => s + i.open, 0) : 0;
  const paid = legs.filter((l) => l.kind === "payout" && l.status === "done" && l.round_id === round?.id).reduce((s, l) => s + l.amount, 0);
  const still = owed - cancelled - held - paid;

  const payoutFor = (id: string) => legs.some((l) => l.kind === "payout" && l.invoice_id === id && ["pending", "sent", "done"].includes(l.status));
  const payable = round?.status === "cleared" ? invoices.filter((i) => i.status === "open" && i.open > 0 && !payoutFor(i.id)) : [];
  const waiting = legs.some((l) => l.kind === "payout" && l.status === "sent");

  const post = async (path: string) => {
    setProblem(null);
    const res = await fetch(path, { method: "POST" }).catch(() => null);
    if (!res) return setProblem("Cannot reach the OFFSET server.");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setProblem(body.error ?? "Something went wrong.");
    else if (body.invoices) setState(body);
  };

  const running = Boolean(state.busy) || round?.status === "running" || !caughtUp;
  let action: { label: string; go?: () => void } | null = null;
  if (!invoices.length) action = { label: state.busy ? "Issuing invoices…" : "Issue the invoices on PayPal", go: state.busy ? undefined : () => post("/api/seed") };
  else if (running) action = { label: state.busy === "sending payments" ? "Sending payments…" : "Agents are working…" };
  else if (!round || undone) action = { label: "Clear the debts", go: () => post("/api/round") };
  else if (payable.length) action = { label: `Pay the ${usd0(payable.reduce((s, i) => s + i.open, 0))} that is left`, go: () => post("/api/pay") };
  else if (waiting) action = { label: "Waiting for PayPal to confirm…" };

  const actorName = (id: string) => {
    const b = businesses.find((b) => b.id === id);
    return b ? `${b.name}'s agent` : id === "checker" ? "Paperwork check" : id === "paypal" ? "PayPal" : "OFFSET";
  };
  const finished = round?.status === "cleared" && caughtUp;

  // The latest entry that is about a decision, and every entry so far about the same invoice or step.
  let focus: Focus = null;
  const lastAbout = visible.findLast((e) => e.data);
  if (lastAbout && round && !undone) {
    const about = JSON.parse(lastAbout.data!) as { invoice?: string; step?: number };
    const same = visible.filter((e) => e.data === lastAbout.data);
    const invoice = invoices.find((i) => i.id === about.invoice);
    const step = state.steps.find((st) => st.id === about.step);
    focus = invoice ? { kind: "invoice", invoice, events: same } : step ? { kind: "step", step, events: same } : null;
  }
  let proposal: Proposal | null = null;
  if (focus?.kind === "step" && focus.step.kind === "redirect" && !focus.events.some((e) => e.kind === "redirect" || e.kind === "nodeal")) {
    const [from, via, to] = JSON.parse(focus.step.path) as string[];
    proposal = { from, via, to, amount: focus.step.amount };
  }
  const last = visible.at(-1);
  const active = !last || !round || undone ? 0 : finished && !running ? 5
    : ["hold", "dispute", "ok"].includes(last.kind) ? 1 : last.kind === "loop" ? 2
    : ["propose", "accept", "counter", "reject", "redirect", "nodeal"].includes(last.kind) ? 3
    : ["settled", "done", "pay", "paid", "error"].includes(last.kind) ? 4 : 1;
  const speaking = !caughtUp || round?.status === "running" ? (businesses.find((b) => b.id === last?.actor)?.id ?? null) : null;
  const who = state.agents === "claude" ? "Claude agents" : "Rule-based agents";
  const stage = (n: number) => (active > n ? "is-done" : active === n ? "is-active" : "");
  const source = (actor: string) => (businesses.some((b) => b.id === actor) || actor === "checker" ? (state.agents === "claude" ? "Claude" : "Rules") : actor === "paypal" ? "PayPal" : "Code");

  const initials = (id: string) => {
    const b = businesses.find((b) => b.id === id);
    return b ? b.name.split(/[^A-Za-z]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() : id === "checker" ? "PC" : id === "paypal" ? "PP" : "OF";
  };
  const sandbox = state.paypal === "sandbox";

  return (
    <div className="shell">
      <header className="bar">
        <div className="bar-in">
          <span className="wordmark">OFFSET</span>
          <span className="built">Built on the PayPal Developer Platform</span>
          <span className="chips">
            <span className={`chip ${sandbox ? "chip-on" : ""}`}>{sandbox ? "PayPal sandbox" : "Simulated PayPal"}</span>
            <span className={`chip ${state.agents === "claude" ? "chip-on" : ""}`}>{state.agents === "claude" ? "Claude agents" : "Rule-based agents"}</span>
          </span>
        </div>
      </header>
      <p className="strip">
        {sandbox
          ? "You're in sandbox mode. Every invoice, set-off and payout here is a real call to PayPal's sandbox. No real money moves."
          : "Simulated mode. No PayPal keys are set, so PayPal's replies are imitated in memory."}
        {state.agents !== "claude" && " No AI key is set, so fixed rules stand in for the agents."}
      </p>

      <main className="page">
        <section className="intro">
          <div>
            <h1>Clear what cancels. Pay only what's left.</h1>
            <p className="pitch">Small businesses owe each other in circles. Their agents cancel what cancels, and PayPal moves only what is left.</p>
          </div>
          <div className="controls">
            {action && <button className="primary" onClick={action.go} disabled={!action.go}>{action.label}</button>}
            {invoices.length > 0 && <button className="quiet" onClick={() => post("/api/seed")} disabled={running}>Start over</button>}
          </div>
        </section>
        {problem && <p className="problem" role="alert">{problem}</p>}

        <ol className="steps" aria-label="How a round works">
          <li className={stage(1)}><strong>Check the paperwork</strong><em className="by by-ai">{who}</em>A checker compares every invoice with its purchase order and delivery record. Each business's agent can hold back an invoice its owner disputes.</li>
          <li className={stage(2)}><strong>Cancel the loops</strong><em className="by by-code">Plain code, no AI</em>A owes B, B owes C, C owes A. The circle cancels. No money moves and nobody's position changes.</li>
          <li className={stage(3)}><strong>Shorten the chains</strong><em className="by by-ai">{who}</em>A pays C directly and B drops out. C's agent judges A's payment record and can ask for faster payment. A's agent answers.</li>
          <li className={stage(4)}><strong>Pay what's left</strong><em className="by by-paypal">PayPal API</em>The result is written to the real PayPal invoices, and one PayPal payout per business settles the remainder.</li>
        </ol>

        <section className="card totals" aria-label="The sum">
          <dl>
            <div><dt>Owed between the six</dt><dd>{usd(owed)}</dd></div>
            <div className="good"><dt>Cancelled, no money moved</dt><dd>{cancelled ? `− ${usd(cancelled)}` : "—"}</dd></div>
            <div className="warn"><dt>Held back</dt><dd>{held ? `− ${usd(held)}` : "—"}</dd></div>
            <div><dt>Paid through PayPal</dt><dd>{paid ? `− ${usd(paid)}` : "—"}</dd></div>
            <div className="still"><dt>Still to pay</dt><dd>{usd(still)}</dd></div>
          </dl>
          {finished && owed - held > 0 && (
            <p className="takeaway">
              {still > 0
                ? `${usd0(owed - held - cancelled)} of real money will settle ${usd0(owed - held)} of invoices. Clearing changed nobody's net position.`
                : `${usd0(paid)} of real money settled ${usd0(owed - held)} of invoices.`}
            </p>
          )}
        </section>

        <div className="work">
          <section className="card map" aria-label="Debts between the businesses">
            <h2>Who owes whom</h2>
            <Graph businesses={businesses} debts={debts} net={net} hot={hot} scale={scale} speaking={speaking} proposal={proposal} />
            <p className="key">
              <span><i className="swatch owed" />Owed on an invoice</span>
              <span><i className="swatch redirected" />Redirected by agreement</span>
              <span><i className="swatch held" />Held back for a person to look at</span>
              <span><i className="swatch proposed" />Shortcut being negotiated</span>
            </p>
          </section>

          <Agents focus={focus} businesses={businesses} agents={state.agents} />
        </div>

        <section className="card activity">
          <h2>Activity</h2>
          <ol className="feed" aria-live="polite" ref={feed}>
            {visible.length === 0 && <li className="quiet-note">Nothing yet. Clear the debts to watch the agents work.</li>}
            {visible.map((e) => (
              <li key={e.id} className={`tone-${TONE[e.kind] ?? "plain"}`}>
                <span className="avatar" aria-hidden="true">{initials(e.actor)}</span>
                <div><strong>{actorName(e.actor)}</strong><em className={`src src-${source(e.actor).toLowerCase()}`}>{source(e.actor)}</em><p>{e.text}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <Ledger state={state} />

        <section className="card worth">
          <h2>What it's worth</h2>
          <div className="worth-cols">
            <div>
              <h3>For a small business</h3>
              <p>Invoices get settled without waiting for the business in front of you to be paid first. {cancelled > 0 && owed - held > 0
                ? `In this run ${Math.round((cancelled / (owed - held)) * 100)}% of the debt was cleared with no cash at all.`
                : "Most of the debt in a supply chain can clear with no cash at all."}</p>
            </div>
            <div>
              <h3>For PayPal</h3>
              <p>Invoices between small businesses are mostly paid by bank transfer today. Clearing needs every trading partner on one ledger, which pulls those invoices onto PayPal, where a fee on cleared value and short loans to unblock a chain become possible. This is our projection, not PayPal data.</p>
            </div>
            <div>
              <h3>Why we believe it</h3>
              <p>
                59% of US small businesses carry invoices over 30 days late (<a href="https://quickbooks.intuit.com/r/small-business-data/small-business-late-payments-report-2026/">QuickBooks, 2026</a>).
                Slovenia has cleared debts this way nationally for 30 years.
                On 133,191 real invoices, loops cleared 21% of debt and chains 54% (<a href="https://arxiv.org/abs/2606.26126">2026 study</a>).
              </p>
            </div>
          </div>
        </section>

        <footer className="foot">
          <p>The clearing maths is plain code and never touches a model. Agents only say yes, no, or yes-if.</p>
          <p>OFFSET is a hackathon project. It is not a PayPal product and is not endorsed by PayPal.</p>
        </footer>
      </main>
    </div>
  );
}
