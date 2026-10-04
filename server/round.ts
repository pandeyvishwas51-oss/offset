// A clearing round, start to finish, and the payments that follow it.
// Order of trust: the engine does the maths, the agents make the judgment calls, PayPal holds the record.
import type { Brain } from "./brain.ts";
import type { Db, Invoice, Leg } from "./db.ts";
import { applyRedirect, buildGraph, cancelLoops, nextRedirect, outcome, refuse, totalOwed, type Inv } from "./engine.ts";
import type { PayPal, PayoutItem } from "./paypal.ts";

export type Deps = { db: Db; paypal: PayPal; brain: Brain };

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runRound({ db, paypal, brain }: Deps): Promise<number> {
  const roundId = Number(db.run("INSERT INTO round (status, phase, started) VALUES ('running', 'sync', ?)", db.now()).lastInsertRowid);
  const say = (actor: string, kind: string, text: string, about?: { invoice?: string; step?: number }) => db.say(roundId, actor, kind, text, about);
  const phase = (p: string) => db.run("UPDATE round SET phase = ? WHERE id = ?", p, roundId);
  const name = (id: string) => db.business(id).name;

  try {
    // 1. PayPal is the record of what is owed, so start from its figures, not ours.
    await Promise.all(db.invoices().filter((i) => i.status !== "settled").map(async (inv) => {
      const live = await paypal.getInvoice(inv.creditor, inv.paypal_id);
      db.run("UPDATE invoice SET open = ?, status = CASE WHEN ? = 0 THEN 'settled' ELSE 'open' END, flag = NULL WHERE id = ?", live.due, live.due, inv.id);
    }));
    const gross = db.invoices().reduce((sum, i) => sum + i.open, 0);
    db.run("UPDATE round SET gross = ?, left = ? WHERE id = ?", gross, gross, roundId);
    say("offset", "info", `${usd(gross)} is owed across ${db.invoices().filter((i) => i.open > 0).length} open invoices.`);

    // 2. Paperwork check. Anything the checker cannot stand behind stays out of the round.
    phase("verify");
    await Promise.all(db.invoices().filter((i) => i.status === "open").map(async (inv) => {
      const verdict = await brain.verify(inv).catch((e) => ({ ok: false, reason: `Could not be checked, so it is held back (${errText(e)}).` }));
      if (verdict.ok) return;
      db.run("UPDATE invoice SET status = 'held', flag = ? WHERE id = ?", verdict.reason, inv.id);
      say("checker", "hold", `Held back ${inv.number} (${usd(inv.open)}): ${verdict.reason}`, { invoice: inv.id });
    }));

    // 3. Each business's agent can hold back invoices its owner does not want settled.
    phase("books");
    await Promise.all(db.businesses().map(async (biz) => {
      const mine = db.invoices().filter((i) => i.status === "open" && (i.creditor === biz.id || i.debtor === biz.id));
      if (!mine.length) return;
      // If an agent cannot answer, its business sits this round out rather than being settled without a say.
      const check = await brain.checkBooks(biz, mine).catch((e) => ({
        disputed: mine.map((i) => ({ invoiceId: i.id, reason: `${biz.name}'s agent could not be reached (${errText(e)}).` })),
      }));
      for (const d of check.disputed) {
        const changed = db.run("UPDATE invoice SET status = 'disputed', flag = ? WHERE id = ? AND status = 'open'", d.reason, d.invoiceId).changes;
        if (changed) say(biz.id, "dispute", `Holding back ${d.invoiceId}: ${d.reason}`, { invoice: d.invoiceId });
      }
      if (!check.disputed.length) say(biz.id, "ok", "Our books agree with every invoice. Go ahead.");
    }));

    // 4. Cancel loops. No business ends up better or worse off, so this needs no negotiation.
    phase("loops");
    const cleared: Inv[] = db.invoices().filter((i) => i.status === "open").map((i) => ({ id: i.id, debtor: i.debtor, creditor: i.creditor, open: i.open, due: i.due }));
    const graph = buildGraph(cleared);
    // The debts as they stood before clearing, kept so the interface can replay the round step by step.
    db.run("UPDATE round SET snapshot = ? WHERE id = ?", JSON.stringify([...graph.values()].map((e) => ({ debtor: e.debtor, creditor: e.creditor, amount: e.start }))), roundId);
    for (const loop of cancelLoops(graph)) {
      const step = Number(db.run("INSERT INTO step (round_id, kind, path, amount, status) VALUES (?, 'loop', ?, ?, 'agreed')", roundId, JSON.stringify(loop.path), loop.amount).lastInsertRowid);
      say("offset", "loop", `Loop found: ${loop.path.map(name).join(" owes ")} owes ${name(loop.path[0])}. Cancelled ${usd(loop.amount)} from each debt.`, { step });
    }

    // 5. Shorten chains. This changes who a creditor relies on, so the agents negotiate each one.
    phase("chains");
    const refused = new Set<string>();
    for (let r = nextRedirect(graph, refused); r; r = nextRedirect(graph, refused)) {
      const [payer, middle, creditor] = [db.business(r.from), db.business(r.via), db.business(r.to)];
      const step = Number(db.run("INSERT INTO step (round_id, kind, path, amount, status) VALUES (?, 'redirect', ?, ?, 'proposed')", roundId, JSON.stringify([r.from, r.via, r.to]), r.amount).lastInsertRowid);
      const about = { step };
      const close = (status: "agreed" | "refused", terms: object) => db.run("UPDATE step SET status = ?, terms = ? WHERE id = ?", status, JSON.stringify(terms), step);
      say("offset", "propose", `Proposal: ${payer.name} pays ${creditor.name} ${usd(r.amount)} directly, and ${middle.name} drops out of the chain.`, about);

      const decision = await brain.judgeNewPayer(creditor, { amount: r.amount, newPayer: payer, currentPayer: middle })
        .catch((e) => ({ decision: "reject" as const, dueDays: 0, reason: `Our agent could not decide, so the answer is no (${errText(e)}).` }));
      say(creditor.id, decision.decision, decision.reason, about);

      let agreed = decision.decision === "accept";
      if (decision.decision === "counter") {
        const answer = await brain.answerTerms(payer, { amount: r.amount, creditor, dueDays: decision.dueDays })
          .catch((e) => ({ accept: false, reason: `Our agent could not decide, so the answer is no (${errText(e)}).` }));
        say(payer.id, answer.accept ? "accept" : "reject", answer.reason, about);
        agreed = answer.accept;
      }
      if (agreed) {
        applyRedirect(graph, r, decision.dueDays);
        close("agreed", { dueDays: decision.dueDays });
        say("offset", "redirect", `Agreed. ${payer.name} now owes ${creditor.name} ${usd(r.amount)}, due in ${decision.dueDays} days. One debt gone.`, about);
      } else {
        refuse(refused, r);
        close("refused", { dueDays: decision.dueDays });
        say("offset", "nodeal", "No deal. Looking for another route.", about);
      }
    }

    // 6. Write the result to PayPal: all of it, or none of it.
    phase("settle");
    const plan = outcome(cleared, graph);
    for (const s of plan.setoffs) {
      db.run("INSERT INTO leg (round_id, kind, invoice_id, amount, marker, status) VALUES (?, 'setoff', ?, ?, ?, 'pending')", roundId, s.invoiceId, s.amount, `OFFSET-R${roundId}-${s.invoiceId}`);
    }
    plan.newDebts.forEach((d, n) => {
      const id = `OF-${roundId}-${n + 1}`;
      const due = new Date(Date.now() + d.dueDays * 86400000).toISOString().slice(0, 10);
      db.run("INSERT INTO invoice (id, paypal_id, number, creditor, debtor, amount, open, due, memo, evidence, status, from_round) VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, '{}', 'open', ?)",
        id, id, d.creditor, d.debtor, d.amount, d.amount, due, `Debt redirected by OFFSET round ${roundId}`, roundId);
      db.run("INSERT INTO leg (round_id, kind, invoice_id, amount, marker, status) VALUES (?, 'new_invoice', ?, ?, ?, 'pending')", roundId, id, d.amount, `OFFSET-R${roundId}-${id}`);
    });
    await execute({ db, paypal, brain }, roundId);

    const toPay = totalOwed(graph);
    const heldBack = db.invoices().filter((i) => i.status === "held" || i.status === "disputed").reduce((s, i) => s + i.open, 0);
    db.run("UPDATE round SET status = 'cleared', phase = 'done', left = ?, finished = ? WHERE id = ?", toPay + heldBack, db.now(), roundId);
    say("offset", "done", `Round complete. ${usd(gross)} was owed. ${usd(gross - toPay - heldBack)} is cancelled without any money moving. ${usd(toPay)} is left to pay${heldBack ? `, and ${usd(heldBack)} is held back for a person to look at` : ""}.`);
  } catch (e) {
    db.run("UPDATE round SET status = 'failed', phase = 'failed', error = ?, finished = ? WHERE id = ?", errText(e), db.now(), roundId);
    say("offset", "error", `Round stopped and undone: ${errText(e)}`);
  }
  return roundId;
}

// Records a payment on a PayPal invoice exactly once. The marker in the note lets a retry, or a restart after
// a crash, find a payment that already went through instead of recording it twice.
async function recordOnce(paypal: PayPal, inv: Invoice, leg: Leg, method: "OTHER" | "PAYPAL", note: string): Promise<string> {
  const live = await paypal.getInvoice(inv.creditor, inv.paypal_id);
  const already = live.payments.find((p) => p.note.includes(leg.marker));
  return already ? already.id : paypal.recordPayment(inv.creditor, inv.paypal_id, { amount: leg.amount, method, note: `${note} [${leg.marker}]` });
}

// Runs every pending PayPal action for a round. If any one fails, the ones already done are reversed,
// so a round either lands completely or leaves every invoice as it was.
export async function execute({ db, paypal }: Deps, roundId: number) {
  const legs = () => db.all<Leg>("SELECT * FROM leg WHERE round_id = ? AND kind != 'payout' ORDER BY id", roundId);
  const mark = (leg: Leg, status: Leg["status"], ref: string | null = leg.ref, error: string | null = null) =>
    db.run("UPDATE leg SET status = ?, ref = ?, error = ? WHERE id = ?", status, ref, error, leg.id);
  try {
    for (const leg of legs().filter((l) => l.status === "pending" || l.status === "sent")) {
      const inv = db.invoice(leg.invoice_id);
      mark(leg, "sent");
      if (leg.kind === "setoff") {
        const ref = await recordOnce(paypal, inv, leg, "OTHER", `Set off against other debts by OFFSET round ${roundId}`);
        mark(leg, "done", ref);
      } else {
        const debtor = db.business(inv.debtor);
        const paypalId = await paypal.createInvoice(inv.creditor, {
          debtorEmail: debtor.email, debtorName: debtor.name, creditorName: db.business(inv.creditor).name,
          amount: inv.amount, memo: inv.memo, due: inv.due, reference: leg.marker,
        });
        db.run("UPDATE invoice SET paypal_id = ? WHERE id = ?", paypalId, inv.id);
        mark(leg, "done", paypalId);
      }
    }
  } catch (e) {
    await undo({ db, paypal } as Deps, roundId);
    throw new Error(`PayPal rejected part of the settlement, so all of it was reversed. ${errText(e)}`);
  }
  // Only now, with every action confirmed, do our own figures change.
  for (const leg of legs().filter((l) => l.kind === "setoff")) {
    db.run("UPDATE invoice SET open = open - ?, status = CASE WHEN open - ? = 0 THEN 'settled' ELSE status END WHERE id = ?", leg.amount, leg.amount, leg.invoice_id);
  }
  db.say(roundId, "paypal", "settled", `${legs().length} entries written to PayPal invoices and confirmed.`);
}

export async function undo({ db, paypal }: Deps, roundId: number) {
  const legs = db.all<Leg>("SELECT * FROM leg WHERE round_id = ? AND kind != 'payout' AND status IN ('sent', 'done') ORDER BY id DESC", roundId);
  for (const leg of legs) {
    const inv = db.invoice(leg.invoice_id);
    try {
      if (leg.kind === "setoff") {
        // A leg marked 'sent' may or may not have reached PayPal; the marker tells us.
        const live = await paypal.getInvoice(inv.creditor, inv.paypal_id);
        const payment = live.payments.find((p) => p.note.includes(leg.marker));
        if (payment) await paypal.deletePayment(inv.creditor, inv.paypal_id, payment.id);
      } else if (inv.paypal_id) {
        await paypal.cancelInvoice(inv.creditor, inv.paypal_id);
      }
      db.run("UPDATE leg SET status = 'reverted' WHERE id = ?", leg.id);
    } catch (e) {
      // Left as 'sent'/'done' with the error, so the next start-up tries again and a person can see it.
      db.run("UPDATE leg SET error = ? WHERE id = ?", `Could not reverse: ${errText(e)}`, leg.id);
    }
  }
  db.run("UPDATE leg SET status = 'reverted' WHERE round_id = ? AND kind != 'payout' AND status = 'pending'", roundId);
  db.run("DELETE FROM invoice WHERE from_round = ?", roundId);
}

// Pays whatever is still owed after clearing: each debtor sends one PayPal payout covering its open invoices.
export async function payRemaining({ db, paypal }: Deps): Promise<void> {
  const round = db.latestRound();
  if (!round || round.status !== "cleared") throw new Error("Clear the debts first; there is nothing to pay yet.");
  const unpaid = db.invoices().filter((i) => i.status === "open" && i.open > 0 &&
    !db.get("SELECT 1 FROM leg WHERE invoice_id = ? AND kind = 'payout' AND status IN ('pending', 'sent', 'done')", i.id));
  for (const debtor of new Set(unpaid.map((i) => i.debtor))) {
    const mine = unpaid.filter((i) => i.debtor === debtor);
    const total = mine.reduce((s, i) => s + i.open, 0);
    // A failed attempt leaves its rows behind as a record, so each new attempt gets its own marker and batch id.
    const attempt = 1 + Math.max(...mine.map((inv) => db.all("SELECT 1 FROM leg WHERE kind = 'payout' AND invoice_id = ?", inv.id).length));
    for (const inv of mine) {
      db.run("INSERT INTO leg (round_id, kind, invoice_id, amount, marker, status) VALUES (?, 'payout', ?, ?, ?, 'pending')", round.id, inv.id, inv.open, `OFFSET-PAY-R${round.id}-${inv.id}-${attempt}`);
    }
    const pending = "kind = 'payout' AND status = 'pending' AND invoice_id IN (SELECT id FROM invoice WHERE debtor = ?)";
    try {
      const batch = await paypal.createPayout(debtor, `OFFSET-PAY-R${round.id}-${debtor}-${attempt}`, mine.map((inv) => ({
        email: db.business(inv.creditor).email, amount: inv.open, itemId: inv.id, note: `Settles invoice ${inv.number} after OFFSET round ${round.id}`,
      })));
      db.run(`UPDATE leg SET status = 'sent', ref = ? WHERE ${pending}`, batch, debtor);
      db.say(round.id, debtor, "pay", `Sent ${usd(total)} through PayPal to ${[...new Set(mine.map((i) => db.business(i.creditor).name))].join(", ")}. Waiting for PayPal to confirm.`);
    } catch (e) {
      db.run(`UPDATE leg SET status = 'failed', error = ? WHERE ${pending}`, errText(e), debtor);
      const why = errText(e).includes("INSUFFICIENT_FUNDS") ? `Our PayPal balance is too low to send ${usd(total)}.` : `PayPal did not accept our payment of ${usd(total)}.`;
      db.say(round.id, debtor, "error", `${why} These invoices stay open and can be paid again.`);
    }
  }
}

const PAYOUT_FAILED = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"]);

// One payout item has reached a final state. Called by the webhook and by the poller; whichever arrives
// first does the work and the other finds nothing left to do.
export async function payoutSettled({ db, paypal }: Deps, item: PayoutItem): Promise<string> {
  const leg = db.get<Leg>("SELECT * FROM leg WHERE kind = 'payout' AND invoice_id = ? AND status = 'sent'", item.itemId);
  if (!leg) return "nothing waiting on this payment";
  const inv = db.invoice(leg.invoice_id);
  if (PAYOUT_FAILED.has(item.status)) {
    db.run("UPDATE leg SET status = 'failed', error = ? WHERE id = ? AND status = 'sent'", `PayPal reported ${item.status}`, leg.id);
    db.say(leg.round_id, "paypal", "error", `Payment for ${inv.number} did not go through (${item.status}). The invoice stays open.`);
    return "marked failed";
  }
  if (item.status !== "SUCCESS") return `still ${item.status}`;
  await recordOnce(paypal, inv, leg, "PAYPAL", `Paid by PayPal payout ${item.ref}`);
  // The status guard makes this safe if the webhook and the poller race: only one of them changes the row.
  const won = db.run("UPDATE leg SET status = 'done', ref = ? WHERE id = ? AND status = 'sent'", item.ref, leg.id).changes;
  if (!won) return "already recorded";
  db.run("UPDATE invoice SET open = open - ?, status = CASE WHEN open - ? = 0 THEN 'settled' ELSE status END WHERE id = ?", leg.amount, leg.amount, inv.id);
  db.say(leg.round_id, "paypal", "paid", `Confirmed ${usd(leg.amount)} from ${db.business(inv.debtor).name} to ${db.business(inv.creditor).name}. Invoice ${inv.number} is settled.`);
  return "recorded";
}

// Safety net for webhooks that never arrive: ask PayPal directly about every payment still waiting.
export async function reconcile(deps: Deps) {
  const waiting = deps.db.all<{ ref: string; debtor: string }>(
    "SELECT DISTINCT leg.ref AS ref, invoice.debtor AS debtor FROM leg JOIN invoice ON invoice.id = leg.invoice_id WHERE leg.kind = 'payout' AND leg.status = 'sent' AND leg.ref IS NOT NULL");
  for (const batch of waiting) {
    try {
      for (const item of await deps.paypal.getPayout(batch.debtor, batch.ref)) await payoutSettled(deps, item);
    } catch (e) {
      console.error(`reconcile ${batch.ref}: ${errText(e)}`);
    }
  }
}

// After a restart: a round caught mid-settlement is reversed, so nothing is ever left half-written.
export async function recover(deps: Deps) {
  for (const round of deps.db.all<{ id: number }>("SELECT id FROM round WHERE status = 'running'")) {
    await undo(deps, round.id);
    deps.db.run("UPDATE round SET status = 'failed', phase = 'failed', error = 'Interrupted by a restart; reversed.', finished = ? WHERE id = ?", deps.db.now(), round.id);
  }
}
