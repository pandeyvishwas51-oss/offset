import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRedirect, buildGraph, cancelLoops, netPositions, nextRedirect, outcome, refuse, totalOwed, type Inv } from "./engine.ts";

const inv = (id: string, debtor: string, creditor: string, open: number, due = "2026-10-01"): Inv => ({ id, debtor, creditor, open, due });

test("a three-business loop cancels by its smallest debt", () => {
  const invoices = [inv("1", "A", "B", 500000), inv("2", "B", "C", 300000), inv("3", "C", "A", 400000)];
  const g = buildGraph(invoices);
  const loops = cancelLoops(g);
  assert.deepEqual(loops, [{ kind: "loop", path: ["A", "B", "C"], amount: 300000 }]);
  assert.equal(totalOwed(g), 300000); // $12,000 of invoices, $3,000 left
  assert.deepEqual(outcome(invoices, g).setoffs, [
    { invoiceId: "1", amount: 300000 },
    { invoiceId: "2", amount: 300000 },
    { invoiceId: "3", amount: 300000 },
  ]);
});

test("a chain redirect removes the middle business and creates one new debt", () => {
  const invoices = [inv("1", "A", "B", 200000), inv("2", "B", "C", 200000)];
  const g = buildGraph(invoices);
  const r = nextRedirect(g, new Set())!;
  assert.deepEqual(r, { kind: "redirect", from: "A", via: "B", to: "C", amount: 200000 });
  applyRedirect(g, r, 7);
  assert.equal(totalOwed(g), 200000);
  assert.deepEqual(outcome(invoices, g).newDebts, [{ debtor: "A", creditor: "C", amount: 200000, dueDays: 7 }]);
});

test("a refused redirect is not proposed again", () => {
  const g = buildGraph([inv("1", "A", "B", 100), inv("2", "B", "C", 100)]);
  const refused = new Set<string>();
  refuse(refused, nextRedirect(g, refused)!);
  assert.equal(nextRedirect(g, refused), null);
});

test("set-off is spread across a pair's invoices oldest first", () => {
  const invoices = [inv("new", "A", "B", 300, "2026-11-01"), inv("old", "A", "B", 200, "2026-09-01"), inv("back", "B", "A", 400)];
  const g = buildGraph(invoices);
  cancelLoops(g);
  assert.deepEqual(outcome(invoices, g).setoffs.filter((s) => s.invoiceId !== "back"), [
    { invoiceId: "old", amount: 200 },
    { invoiceId: "new", amount: 200 },
  ]);
});

test("clearing never changes any business's net position, on random debt graphs", () => {
  let seed = 42;
  const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let run = 0; run < 300; run++) {
    const names = ["A", "B", "C", "D", "E", "F", "G"];
    const invoices: Inv[] = [];
    for (let i = 0; i < 3 + rand(18); i++) {
      const debtor = names[rand(names.length)];
      const creditor = names[rand(names.length)];
      if (debtor !== creditor) invoices.push(inv(`i${i}`, debtor, creditor, 1 + rand(900000)));
    }
    const g = buildGraph(invoices);
    const before = netPositions(g);
    const gross = totalOwed(g);
    cancelLoops(g);
    const refused = new Set<string>();
    for (let r = nextRedirect(g, refused); r; r = nextRedirect(g, refused)) {
      if (rand(4) === 0) refuse(refused, r); // some agents say no
      else applyRedirect(g, r, 7 + rand(30));
    }
    const after = netPositions(g);
    for (const name of names) assert.equal(after.get(name) ?? 0, before.get(name) ?? 0, `net position of ${name}`);
    assert.ok(totalOwed(g) <= gross);

    // The actions on real invoices must add up to exactly what the graph says.
    const { setoffs, newDebts } = outcome(invoices, g);
    const setOffTotal = setoffs.reduce((s, x) => s + x.amount, 0);
    const newTotal = newDebts.reduce((s, x) => s + x.amount, 0);
    assert.equal(gross - setOffTotal + newTotal, totalOwed(g));
    for (const s of setoffs) assert.ok(s.amount > 0 && s.amount <= invoices.find((i) => i.id === s.invoiceId)!.open);
  }
});
