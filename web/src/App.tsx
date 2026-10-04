import { useEffect, useMemo, useRef, useState } from "react";
import { Graph, type Debt } from "./Graph.tsx";
import { Ledger } from "./Ledger.tsx";
import type { Event, State, Step } from "./types.ts";
import { usd, usd0 } from "./types.ts";

const STEP_KINDS = new Set(["loop", "redirect"]);
const TONE: Record<string, string> = {
  hold: "no", dispute: "no", reject: "no", error: "no", counter: "maybe",
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
  const feedEnd = useRef<HTMLLIElement>(null);

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

  useEffect(() => { feedEnd.current?.scrollIntoView({ block: "nearest" }); }, [shown]);

  if (!state) return <main className="page"><p className="loading">{problem ?? "Opening the books…"}</p></main>;

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

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>OFFSET</h1>
          <p className="pitch">Small businesses owe each other in circles. Their agents cancel what cancels, and PayPal moves only what is left.</p>
        </div>
        <div className="controls">
          {action && <button className="primary" onClick={action.go} disabled={!action.go}>{action.label}</button>}
          {invoices.length > 0 && <button className="quiet" onClick={() => post("/api/seed")} disabled={running}>Start over</button>}
          <p className="modes">
            {state.paypal === "sandbox" ? "PayPal: real sandbox accounts" : "PayPal: simulated, no keys set"}<br />
            {state.agents === "claude" ? "Agents: Claude" : "Agents: fixed rules, no AI key set"}
          </p>
        </div>
      </header>
      {problem && <p className="problem" role="alert">{problem}</p>}

      <div className="work">
        <section className="map" aria-label="Debts between the businesses">
          <Graph businesses={businesses} debts={debts} net={net} hot={hot} scale={scale} />
          <p className="key">
            <span className="swatch owed" /> owed on an invoice
            <span className="swatch redirected" /> redirected by agreement
            <span className="swatch held" /> held back for a person to look at
          </p>
        </section>

        <aside className="side">
          <table className="sum">
            <tbody>
              <tr><th scope="row">Owed between the six</th><td>{usd(owed)}</td></tr>
              <tr className="minus"><th scope="row">Cancelled, no money moved</th><td>{cancelled ? `− ${usd(cancelled)}` : "—"}</td></tr>
              {held > 0 && <tr className="minus"><th scope="row">Held back</th><td>− {usd(held)}</td></tr>}
              {paid > 0 && <tr className="minus"><th scope="row">Paid through PayPal</th><td>− {usd(paid)}</td></tr>}
              <tr className="total"><th scope="row">Still to pay</th><td>{usd(still)}</td></tr>
            </tbody>
          </table>
          {finished && owed - held > 0 && (
            <p className="takeaway">
              {still > 0
                ? `${usd0(owed - held - cancelled)} of real money will settle ${usd0(owed - held)} of invoices. Clearing changed nobody's net position.`
                : `${usd0(paid)} of real money settled ${usd0(owed - held)} of invoices.`}
            </p>
          )}

          <h2>What happened</h2>
          <ol className="feed" aria-live="polite">
            {visible.length === 0 && <li className="quiet-note">Nothing yet. Clear the debts to watch the agents work.</li>}
            {visible.map((e) => (
              <li key={e.id} className={`tone-${TONE[e.kind] ?? "plain"}`}>
                <strong>{actorName(e.actor)}</strong> {e.text}
              </li>
            ))}
            <li ref={feedEnd} aria-hidden="true" className="feed-end" />
          </ol>
        </aside>
      </div>

      <Ledger state={state} />
      <footer className="foot">
        The clearing maths is plain code and never touches a model. Agents only say yes, no, or yes-if. Every entry above is a real call to the PayPal sandbox when keys are set.
      </footer>
    </main>
  );
}
