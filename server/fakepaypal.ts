// In-memory stand-in for PayPal with the same behaviour OFFSET depends on: partial payments on invoices,
// deletable payments, and payouts that finish a moment later. Used by the tests and when no credentials are set.
import type { PayPal, PayPalInvoice, PayoutItem } from "./paypal.ts";

export function fakePayPal(opts: { failOn?: (op: string, n: number) => boolean; payoutStatus?: (itemId: string) => string } = {}) {
  const invoices = new Map<string, PayPalInvoice & { amount: number; owner: string }>();
  const payouts = new Map<string, PayoutItem[]>();
  const batchIds = new Set<string>();
  const calls: string[] = [];
  let seq = 0;

  const step = (op: string) => {
    calls.push(op);
    if (opts.failOn?.(op, calls.filter((c) => c === op).length)) throw new Error(`Simulated PayPal failure on ${op}`);
  };
  const owned = (business: string, id: string) => {
    const inv = invoices.get(id);
    if (!inv || inv.owner !== business) throw new Error(`Invoice ${id} not found for ${business}`);
    return inv;
  };

  const api: PayPal & { calls: string[]; invoices: typeof invoices } = {
    mode: "simulated",
    calls,
    invoices,
    async createInvoice(business, inv) {
      step("createInvoice");
      const id = `INV2-SIM-${String(++seq).padStart(4, "0")}`;
      invoices.set(id, { owner: business, amount: inv.amount, due: inv.amount, status: "SENT", payments: [] });
      return id;
    },
    async getInvoice(business, id) {
      step("getInvoice");
      const { due, status, payments } = owned(business, id);
      return { due, status, payments: payments.map((p) => ({ ...p })) };
    },
    async recordPayment(business, id, p) {
      step("recordPayment");
      const inv = owned(business, id);
      if (inv.status === "CANCELLED") throw new Error("Invoice is cancelled");
      if (p.amount <= 0 || p.amount > inv.due) throw new Error(`Payment of ${p.amount} exceeds amount due ${inv.due}`);
      const paymentId = `EXTR-SIM-${++seq}`;
      inv.payments.push({ id: paymentId, amount: p.amount, note: p.note });
      inv.due -= p.amount;
      inv.status = inv.due === 0 ? "MARKED_AS_PAID" : "PARTIALLY_PAID";
      return paymentId;
    },
    async deletePayment(business, id, paymentId) {
      step("deletePayment");
      const inv = owned(business, id);
      const at = inv.payments.findIndex((p) => p.id === paymentId);
      if (at < 0) throw new Error(`Payment ${paymentId} not found`);
      inv.due += inv.payments[at].amount;
      inv.payments.splice(at, 1);
      inv.status = inv.payments.length ? "PARTIALLY_PAID" : "SENT";
    },
    async cancelInvoice(business, id) {
      step("cancelInvoice");
      owned(business, id).status = "CANCELLED";
    },
    async createPayout(_business, batchId, items) {
      step("createPayout");
      if (batchIds.has(batchId)) throw new Error("Duplicate sender_batch_id");
      batchIds.add(batchId);
      const payoutBatchId = `PAYOUT-SIM-${++seq}`;
      payouts.set(payoutBatchId, items.map((i) => ({ itemId: i.itemId, ref: `ITEM-SIM-${++seq}`, status: opts.payoutStatus?.(i.itemId) ?? "SUCCESS" })));
      return payoutBatchId;
    },
    async getPayout(_business, payoutBatchId) {
      step("getPayout");
      return payouts.get(payoutBatchId) ?? [];
    },
  };
  return api;
}
