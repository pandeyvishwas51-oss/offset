// The clearing maths. Pure functions over integer cents: no I/O, no AI.
// Every judgment call lives in brain.ts; nothing in this file is ever decided by a model.

export type Inv = { id: string; debtor: string; creditor: string; open: number; due: string };

// orig = what is still owed on real invoices for this pair; virt = debt redirected onto this pair this round.
type Edge = { debtor: string; creditor: string; start: number; orig: number; virt: number; dueDays: number | null };
export type Graph = Map<string, Edge>;

export type Loop = { kind: "loop"; path: string[]; amount: number }; // path [A,B,C]: A owes B owes C owes A
export type Redirect = { kind: "redirect"; from: string; via: string; to: string; amount: number };
export type Step = Loop | Redirect;

const key = (debtor: string, creditor: string) => `${debtor}>${creditor}`;
const owed = (e: Edge | undefined) => (e ? e.orig + e.virt : 0);

export function buildGraph(invoices: Inv[]): Graph {
  const g: Graph = new Map();
  for (const inv of invoices) {
    if (inv.open <= 0) continue;
    const k = key(inv.debtor, inv.creditor);
    const e = g.get(k) ?? { debtor: inv.debtor, creditor: inv.creditor, start: 0, orig: 0, virt: 0, dueDays: null };
    e.start += inv.open;
    e.orig += inv.open;
    g.set(k, e);
  }
  return g;
}

function reduce(e: Edge, amount: number) {
  const fromOrig = Math.min(e.orig, amount);
  e.orig -= fromOrig;
  e.virt -= amount - fromOrig;
}

function liveEdges(g: Graph): Edge[] {
  return [...g.values()].filter((e) => owed(e) > 0).sort((a, b) => key(a.debtor, a.creditor).localeCompare(key(b.debtor, b.creditor)));
}

function findLoop(g: Graph): string[] | null {
  const out = new Map<string, string[]>();
  for (const e of liveEdges(g)) out.set(e.debtor, [...(out.get(e.debtor) ?? []), e.creditor]);
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (node: string): string[] | null => {
    const at = stack.indexOf(node);
    if (at >= 0) return stack.slice(at);
    if (done.has(node)) return null;
    stack.push(node);
    for (const next of out.get(node) ?? []) {
      const loop = visit(next);
      if (loop) return loop;
    }
    stack.pop();
    done.add(node);
    return null;
  };
  for (const node of [...out.keys()].sort()) {
    const loop = visit(node);
    if (loop) return loop;
  }
  return null;
}

// Cancels every loop of debt. Nobody's net position changes, so no judgment is needed.
// ponytail: greedy depth-first loop cancelling, not the maximum possible; switch to min-cost circulation if graphs get big.
export function cancelLoops(g: Graph): Loop[] {
  const loops: Loop[] = [];
  for (let path = findLoop(g); path; path = findLoop(g)) {
    const edges = path.map((node, i) => g.get(key(node, path[(i + 1) % path.length]))!);
    const amount = Math.min(...edges.map(owed));
    for (const e of edges) reduce(e, amount);
    loops.push({ kind: "loop", path, amount });
  }
  return loops;
}

const tripleKey = (r: { from: string; via: string; to: string }) => `${r.from}>${r.via}>${r.to}`;

// The biggest chain A owes B owes C that has not been refused. A would pay C directly and B drops out.
// This changes who C is relying on, so it is only a proposal: the agents decide.
export function nextRedirect(g: Graph, refused: Set<string>): Redirect | null {
  let best: Redirect | null = null;
  const edges = liveEdges(g);
  for (const first of edges) {
    for (const second of edges) {
      if (second.debtor !== first.creditor || second.creditor === first.debtor) continue;
      const r: Redirect = { kind: "redirect", from: first.debtor, via: first.creditor, to: second.creditor, amount: Math.min(owed(first), owed(second)) };
      if (refused.has(tripleKey(r))) continue;
      if (!best || r.amount > best.amount) best = r;
    }
  }
  return best;
}

export const refuse = (refused: Set<string>, r: Redirect) => refused.add(tripleKey(r));

export function applyRedirect(g: Graph, r: Redirect, dueDays: number) {
  reduce(g.get(key(r.from, r.via))!, r.amount);
  reduce(g.get(key(r.via, r.to))!, r.amount);
  const k = key(r.from, r.to);
  const e = g.get(k) ?? { debtor: r.from, creditor: r.to, start: 0, orig: 0, virt: 0, dueDays: null };
  e.virt += r.amount;
  e.dueDays = e.dueDays === null ? dueDays : Math.min(e.dueDays, dueDays);
  g.set(k, e);
}

export type Outcome = {
  setoffs: { invoiceId: string; amount: number }[]; // amount to mark as settled on each real invoice
  newDebts: { debtor: string; creditor: string; amount: number; dueDays: number }[]; // redirected debt needing a new invoice
};

// Turns the cleared graph back into actions on real invoices, oldest invoice first.
export function outcome(invoices: Inv[], g: Graph): Outcome {
  const setoffs: Outcome["setoffs"] = [];
  const newDebts: Outcome["newDebts"] = [];
  for (const e of g.values()) {
    let toSetOff = e.start - e.orig;
    const pairInvoices = invoices
      .filter((i) => i.debtor === e.debtor && i.creditor === e.creditor && i.open > 0)
      .sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
    for (const inv of pairInvoices) {
      const amount = Math.min(inv.open, toSetOff);
      if (amount > 0) setoffs.push({ invoiceId: inv.id, amount });
      toSetOff -= amount;
    }
    if (e.virt > 0) newDebts.push({ debtor: e.debtor, creditor: e.creditor, amount: e.virt, dueDays: e.dueDays ?? 30 });
  }
  return { setoffs, newDebts };
}

export const totalOwed = (g: Graph) => [...g.values()].reduce((sum, e) => sum + owed(e), 0);

// What each business is owed minus what it owes. Clearing must never change this.
export function netPositions(g: Graph): Map<string, number> {
  const net = new Map<string, number>();
  for (const e of g.values()) {
    net.set(e.creditor, (net.get(e.creditor) ?? 0) + owed(e));
    net.set(e.debtor, (net.get(e.debtor) ?? 0) - owed(e));
  }
  return net;
}
