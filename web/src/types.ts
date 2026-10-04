export type Business = { id: string; name: string; trade: string; on_time_pct: number; avg_days_late: number; policy: string; notes: string };
export type Invoice = {
  id: string; paypal_id: string; number: string; creditor: string; debtor: string; amount: number; open: number;
  due: string; memo: string; evidence: string; status: "open" | "held" | "disputed" | "settled"; flag: string | null; from_round: number | null;
};
export type Round = { id: number; status: "running" | "cleared" | "failed"; phase: string; gross: number; left: number; snapshot: string | null; error: string | null };
export type Step = { id: number; kind: "loop" | "redirect"; path: string; amount: number; status: "proposed" | "agreed" | "refused"; terms: string | null };
export type Leg = { id: number; round_id: number; kind: "setoff" | "new_invoice" | "payout"; invoice_id: string; amount: number; marker: string; status: string; ref: string | null; error: string | null };
export type Event = { id: number; round_id: number | null; at: string; actor: string; kind: string; text: string; data: string | null };
export type Received = { id: string; business: string; type: string; ref: string | null; verified: string; at: string; outcome: string | null };
export type State = {
  paypal: "sandbox" | "simulated"; agents: "claude" | "scripted"; webhooks: boolean; busy: string | null;
  businesses: Business[]; invoices: Invoice[]; round: Round | null; steps: Step[]; legs: Leg[]; events: Event[]; received: Received[];
};

export const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const usd0 = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
