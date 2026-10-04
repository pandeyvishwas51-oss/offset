// Proves the PayPal calls OFFSET depends on against the real sandbox, using two of the businesses.
// Run: npm run smoke
import { sandboxPayPal, toDollars } from "../server/paypal.ts";

const env = process.env;
const [creditor, debtor] = ["harbor", "kite"];
const cred = (id: string) => ({ clientId: env[`PAYPAL_${id.toUpperCase()}_CLIENT_ID`]!, secret: env[`PAYPAL_${id.toUpperCase()}_SECRET`]! });
const email = (id: string) => env[`PAYPAL_${id.toUpperCase()}_EMAIL`]!;
const pp = sandboxPayPal({ [creditor]: cred(creditor), [debtor]: cred(debtor) });
const show = async (label: string, id: string) => {
  const inv = await pp.getInvoice(creditor, id);
  console.log(`  ${label}: status ${inv.status}, due $${toDollars(inv.due)}, payments ${JSON.stringify(inv.payments)}`);
  return inv;
};

console.log("1. Create and send a $10.00 invoice");
const id = await pp.createInvoice(creditor, {
  debtorEmail: email(debtor), debtorName: "Kite & Co", creditorName: "Harbor Distribution",
  amount: 1000, memo: "OFFSET smoke test", due: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), reference: `SMOKE-${Date.now()}`,
});
console.log("  invoice", id);
await show("after send", id);

console.log("2. Record a partial set-off of $4.00");
const paymentId = await pp.recordPayment(creditor, id, { amount: 400, method: "OTHER", note: "Set off by OFFSET [OFFSET-SMOKE]" });
const partial = await show("after partial", id);
if (partial.due !== 600) throw new Error("Partial payment did not reduce the amount due to $6.00");
if (!partial.payments.some((p) => p.note.includes("OFFSET-SMOKE"))) throw new Error("Payment note marker did not come back from PayPal");

console.log("3. Reverse it");
await pp.deletePayment(creditor, id, paymentId);
const reverted = await show("after reversal", id);
if (reverted.due !== 1000) throw new Error("Reversal did not restore the amount due");

console.log("4. Cancel the invoice");
await pp.cancelInvoice(creditor, id);
await show("after cancel", id);

console.log("5. Payout of $1.00 from Kite to Harbor");
const batch = await pp.createPayout(debtor, `SMOKE-${Date.now()}`, [{ email: email(creditor), amount: 100, itemId: "SMOKE-1", note: "OFFSET smoke test" }]);
console.log("  batch", batch);
for (let i = 0; i < 20; i++) {
  const items = await pp.getPayout(debtor, batch);
  console.log("  items", JSON.stringify(items));
  if (items.length && items.every((it) => it.status !== "PENDING" && it.status !== "NEW")) break;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("Smoke test finished.");
