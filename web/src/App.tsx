import { useEffect, useMemo, useRef, useState } from "react";
import { Agents, type Focus } from "./Agents.tsx";
import { Graph, type Bubble, type Debt, type Proposal } from "./Graph.tsx";
import { Ledger } from "./Ledger.tsx";
import type { Event, State, Step } from "./types.ts";
import { usd, usd0 } from "./types.ts";

const STEP_KINDS = new Set(["loop", "redirect"]);

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
  type About = { invoice?: string; step?: number; days?: number };
  const about = (e: Event): About => (e.data ? JSON.parse(e.data) : {});
  let focus: Focus = null;
  const lastAbout = visible.findLast((e) => e.data);
  if (lastAbout && round && !undone) {
    const key = about(lastAbout);
    const same = visible.filter((e) => e.data && (key.step ? about(e).step === key.step : about(e).invoice === key.invoice));
    const invoice = invoices.find((i) => i.id === key.invoice);
    const step = state.steps.find((st) => st.id === key.step);
    focus = invoice ? { kind: "invoice", invoice, events: same } : step ? { kind: "step", step, events: same } : null;
  }

  // On the graph: the shortcut on the table, and what each agent just said in a few words.
  let proposal: Proposal | null = null;
  const bubbles: Bubble[] = [];
  const live = !finished || running;
  if (live && focus?.kind === "step" && focus.step.kind === "redirect") {
    const [from, via, to] = JSON.parse(focus.step.path) as string[];
    const closed = focus.events.some((e) => e.kind === "redirect" || e.kind === "nodeal");
    if (!closed) proposal = { from, via, to, amount: focus.step.amount };
    const creditorSaid = focus.events.find((e) => e.actor === to);
    const payerSaid = focus.events.find((e) => e.actor === from);
    if (creditorSaid) bubbles.push(creditorSaid.kind === "accept" ? { id: to, text: "Yes", tone: "yes" } : creditorSaid.kind === "counter" ? { id: to, text: `Only within ${about(creditorSaid).days} days`, tone: "maybe" } : { id: to, text: "No", tone: "no" });
    if (payerSaid) bubbles.push(payerSaid.kind === "accept" ? { id: from, text: "Deal", tone: "yes" } : { id: from, text: "Can't do that", tone: "no" });
  }
  if (live && focus?.kind === "invoice" && focus.events.at(-1)!.kind === "dispute") bubbles.push({ id: focus.events.at(-1)!.actor, text: `Hold ${focus.invoice.number}`, tone: "no" });

  const last = visible.at(-1);
  const active = !last || !round || undone ? 0 : finished && !running ? 5
    : ["hold", "dispute", "ok"].includes(last.kind) ? 1 : last.kind === "loop" ? 2
    : ["propose", "accept", "counter", "reject", "redirect", "nodeal"].includes(last.kind) ? 3
    : ["settled", "done", "pay", "paid", "error"].includes(last.kind) ? 4 : 1;
  const speaking = live && round ? (businesses.find((b) => b.id === last?.actor)?.id ?? null) : null;
  const who = state.agents === "claude" ? "Claude agents" : "Rule-based agents";
  const stage = (n: number) => (active > n ? "is-done" : active === n ? "is-active" : "");
  const source = (actor: string) => (businesses.some((b) => b.id === actor) || actor === "checker" ? (state.agents === "claude" ? "Claude" : "Rules") : actor === "paypal" ? "PayPal" : "Code");
  const sandbox = state.paypal === "sandbox";
  const share = (cents: number) => `${owed ? (cents / owed) * 100 : 0}%`;
  const clearedPct = owed - held > 0 ? Math.round((cancelled / (owed - held)) * 100) : 0;

  return (
    <div className="shell">
      <header className="bar">
        <div className="bar-in">
          <span className="wordmark">OFFSET</span>
          <span className="built">Built on the PayPal Developer Platform</span>
          <span className="chips">
            <span className={`chip ${sandbox ? "chip-on" : ""}`}>{sandbox ? "PayPal sandbox" : "Simulated PayPal"}</span>
            <span className={`chip ${state.agents === "claude" ? "chip-on" : ""}`}>{who}</span>
          </span>
        </div>
      </header>
      <p className="strip">{sandbox ? "Sandbox mode: real PayPal API calls, no real money." : "Simulated mode: no PayPal keys set."}</p>

      <main className="page">
        <section className="intro">
          <h1>Clear what cancels. Pay only what's left.</h1>
          <div className="controls">
            {action && <button className="primary" onClick={action.go} disabled={!action.go}>{action.label}</button>}
            {invoices.length > 0 && <button className="quiet" onClick={() => post("/api/seed")} disabled={running}>Start over</button>}
          </div>
        </section>
        {problem && <p className="problem" role="alert">{problem}</p>}

        <ol className="steps" aria-label="How a round works">
          <li className={stage(1)} title="A checker compares every invoice with its purchase order and delivery record. Each business's agent can hold back an invoice its owner disputes."><strong>Check the paperwork</strong><em className="by by-ai">{who}</em></li>
          <li className={stage(2)} title="A owes B, B owes C, C owes A. The circle cancels. No money moves and nobody's position changes."><strong>Cancel the loops</strong><em className="by by-code">Plain code, no AI</em></li>
          <li className={stage(3)} title="A pays C directly and B drops out. C's agent judges A's payment record and can ask for faster payment. A's agent answers."><strong>Shorten the chains</strong><em className="by by-ai">{who}</em></li>
          <li className={stage(4)} title="The result is written to the real PayPal invoices, and one PayPal payout per business settles the remainder."><strong>Pay what's left</strong><em className="by by-paypal">PayPal API</em></li>
        </ol>

        <section className="card totals" aria-label="The sum">
          <dl>
            <div><dt>Owed</dt><dd>{usd0(owed)}</dd></div>
            <div className="good"><dt><i />Cancelled, no money moved</dt><dd>{usd0(cancelled)}</dd></div>
            <div className="warn"><dt><i />Held back</dt><dd>{usd0(held)}</dd></div>
            <div className="paid"><dt><i />Paid through PayPal</dt><dd>{usd0(paid)}</dd></div>
            <div className="still"><dt><i />Still to pay</dt><dd>{usd0(still)}</dd></div>
          </dl>
          <div className="meter" role="img" aria-label={`${usd0(cancelled)} cancelled, ${usd0(held)} held back, ${usd0(paid)} paid, ${usd0(still)} still to pay`}>
            <i className="m-good" style={{ width: share(cancelled) }} />
            <i className="m-warn" style={{ width: share(held) }} />
            <i className="m-paid" style={{ width: share(paid) }} />
            <i className="m-still" style={{ width: share(still) }} />
          </div>
        </section>

        <div className="work">
          <section className="card map" aria-label="Debts between the businesses">
            <Graph businesses={businesses} debts={debts} net={net} hot={hot} scale={scale} speaking={speaking} proposal={proposal} bubbles={bubbles} />
            <p className="key">
              <span><i className="swatch owed" />Owed</span>
              <span><i className="swatch redirected" />Redirected by agreement</span>
              <span><i className="swatch proposed" />Being negotiated</span>
              <span><i className="swatch held" />Held back</span>
            </p>
          </section>
          <Agents focus={focus} businesses={businesses} agents={state.agents} />
        </div>

        <Ledger state={state} log={visible.map((e) => ({ id: e.id, at: e.at, who: actorName(e.actor), source: source(e.actor), text: e.text }))} />

        <section className="tiles" aria-label="What it's worth">
          <div className="tile tile-live">
            <strong>{clearedPct ? `${clearedPct}%` : "—"}</strong>
            <span>of this debt cleared with no cash moving</span>
          </div>
          <div className="tile">
            <strong>59%</strong>
            <span>of US small businesses carry invoices over 30 days late <a href="https://quickbooks.intuit.com/r/small-business-data/small-business-late-payments-report-2026/">QuickBooks 2026</a></span>
          </div>
          <div className="tile">
            <strong>54%</strong>
            <span>of debt cleared this way across 133,191 real invoices <a href="https://arxiv.org/abs/2606.26126">2026 study</a></span>
          </div>
          <div className="tile">
            <strong>30 yrs</strong>
            <span>Slovenia has cleared business debt like this, nationally</span>
          </div>
        </section>

        <footer className="foot">
          <p>The maths is plain code. Agents only answer yes, no, or yes-if. OFFSET is a hackathon project, not a PayPal product.</p>
        </footer>
      </main>
    </div>
  );
}
