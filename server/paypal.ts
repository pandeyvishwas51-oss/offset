// The slice of PayPal that OFFSET uses. Two implementations: the real sandbox (below) and an in-memory
// stand-in (fakepaypal.ts) for tests and for running the app with no credentials.

export type PaidEntry = { id: string; amount: number; note: string };
export type PayPalInvoice = { due: number; status: string; payments: PaidEntry[] };
export type PayoutItem = { itemId: string; ref: string; status: string }; // status: SUCCESS, PENDING, FAILED, ...
export type NewInvoice = { debtorEmail: string; debtorName: string; creditorName: string; amount: number; memo: string; due: string; reference: string };

export interface PayPal {
  readonly mode: "sandbox" | "simulated";
  createInvoice(business: string, inv: NewInvoice): Promise<string>;
  getInvoice(business: string, invoiceId: string): Promise<PayPalInvoice>;
  recordPayment(business: string, invoiceId: string, p: { amount: number; note: string; method: "OTHER" | "PAYPAL" }): Promise<string>;
  deletePayment(business: string, invoiceId: string, paymentId: string): Promise<void>;
  cancelInvoice(business: string, invoiceId: string): Promise<void>;
  createPayout(business: string, batchId: string, items: { email: string; amount: number; itemId: string; note: string }[]): Promise<string>;
  getPayout(business: string, payoutBatchId: string): Promise<PayoutItem[]>;
}

export const toDollars = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
export function toCents(value: string): number {
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export class PayPalError extends Error {
  status: number;
  debugId: string | undefined;
  constructor(status: number, message: string, debugId?: string) {
    super(message);
    this.status = status;
    this.debugId = debugId;
  }
}

export type Creds = { clientId: string; secret: string };

// ponytail: sandbox only, on purpose. Live money needs PayPal's multiparty partner setup, not a changed URL.
const BASE = "https://api-m.sandbox.paypal.com";

export function sandboxPayPal(creds: Record<string, Creds>) {
  const tokens = new Map<string, { token: string; expires: number }>();

  async function token(business: string): Promise<string> {
    const cached = tokens.get(business);
    if (cached && cached.expires > Date.now()) return cached.token;
    const c = creds[business];
    if (!c) throw new PayPalError(0, `No PayPal credentials for ${business}`);
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError(res.status, `PayPal sign-in failed for ${business}: ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    tokens.set(business, { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 });
    return body.access_token;
  }

  // requestId makes a retried POST safe where PayPal supports it. Retries only on rate limits and server errors.
  async function call<T>(business: string, method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await token(business)}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new PayPalError(res.status, `${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`, res.headers.get("paypal-debug-id") ?? undefined);
    }
  }

  const api: PayPal & {
    registerWebhook(business: string, url: string): Promise<string>;
    verifyWebhook(business: string, webhookId: string, headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
  } = {
    mode: "sandbox",

    async createInvoice(business, inv) {
      const created = await call<{ id?: string; href?: string }>(business, "POST", "/v2/invoicing/invoices", {
        detail: {
          currency_code: "USD",
          reference: inv.reference,
          note: inv.memo,
          payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: inv.due },
        },
        invoicer: { business_name: inv.creditorName },
        primary_recipients: [{ billing_info: { email_address: inv.debtorEmail, business_name: inv.debtorName } }],
        items: [{ name: inv.memo.slice(0, 200), quantity: "1", unit_amount: { currency_code: "USD", value: toDollars(inv.amount) } }],
        configuration: { partial_payment: { allow_partial_payment: true } },
      }, inv.reference);
      const id = created.id ?? created.href?.split("/").pop();
      if (!id) throw new PayPalError(0, "PayPal created an invoice but returned no id");
      // A draft cannot take payments; sending moves it to an unpaid state. No emails needed between sandbox accounts.
      await call(business, "POST", `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: false });
      return id;
    },

    async getInvoice(business, invoiceId) {
      const inv = await call<{
        status: string;
        due_amount?: { value: string };
        payments?: { transactions?: { payment_id: string; note?: string; amount: { value: string } }[] };
      }>(business, "GET", `/v2/invoicing/invoices/${invoiceId}`);
      return {
        status: inv.status,
        due: toCents(inv.due_amount?.value ?? "0"),
        payments: (inv.payments?.transactions ?? []).map((t) => ({ id: t.payment_id, amount: toCents(t.amount.value), note: t.note ?? "" })),
      };
    },

    async recordPayment(business, invoiceId, p) {
      const res = await call<{ payment_id: string }>(business, "POST", `/v2/invoicing/invoices/${invoiceId}/payments`, {
        method: p.method,
        payment_date: new Date().toISOString().slice(0, 10),
        amount: { currency_code: "USD", value: toDollars(p.amount) },
        note: p.note,
      });
      return res.payment_id;
    },

    async deletePayment(business, invoiceId, paymentId) {
      await call(business, "DELETE", `/v2/invoicing/invoices/${invoiceId}/payments/${paymentId}`);
    },

    async cancelInvoice(business, invoiceId) {
      await call(business, "POST", `/v2/invoicing/invoices/${invoiceId}/cancel`, { send_to_invoicer: false, send_to_recipient: false });
    },

    async createPayout(business, batchId, items) {
      // PayPal rejects a repeated sender_batch_id, which is what makes a retried payout safe.
      const res = await call<{ batch_header: { payout_batch_id: string } }>(business, "POST", "/v1/payments/payouts", {
        sender_batch_header: { sender_batch_id: batchId, email_subject: "OFFSET settlement" },
        items: items.map((i) => ({
          recipient_type: "EMAIL",
          receiver: i.email,
          amount: { value: toDollars(i.amount), currency: "USD" },
          sender_item_id: i.itemId,
          note: i.note,
        })),
      });
      return res.batch_header.payout_batch_id;
    },

    async getPayout(business, payoutBatchId) {
      const res = await call<{ items?: { payout_item_id: string; transaction_status: string; payout_item: { sender_item_id: string } }[] }>(
        business, "GET", `/v1/payments/payouts/${payoutBatchId}`);
      return (res.items ?? []).map((i) => ({ itemId: i.payout_item.sender_item_id, ref: i.payout_item_id, status: i.transaction_status }));
    },

    async registerWebhook(business, url) {
      const existing = await call<{ webhooks: { id: string; url: string }[] }>(business, "GET", "/v1/notifications/webhooks");
      const found = existing.webhooks.find((w) => w.url === url);
      if (found) return found.id;
      const created = await call<{ id: string }>(business, "POST", "/v1/notifications/webhooks", {
        url,
        event_types: [
          "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "PAYMENT.PAYOUTS-ITEM.FAILED", "PAYMENT.PAYOUTS-ITEM.DENIED", "PAYMENT.PAYOUTS-ITEM.BLOCKED",
          "PAYMENT.PAYOUTS-ITEM.RETURNED", "PAYMENT.PAYOUTS-ITEM.UNCLAIMED", "PAYMENT.PAYOUTSBATCH.SUCCESS", "PAYMENT.PAYOUTSBATCH.DENIED",
          "INVOICING.INVOICE.PAID", "INVOICING.INVOICE.UPDATED", "INVOICING.INVOICE.CANCELLED",
        ].map((name) => ({ name })),
      });
      return created.id;
    },

    async verifyWebhook(business, webhookId, headers, rawBody) {
      // The event is spliced in as raw text: re-serialising it can change bytes and break PayPal's signature check.
      const envelope = JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: webhookId,
      });
      const res = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await token(business)}`, "Content-Type": "application/json" },
        body: `${envelope.slice(0, -1)},"webhook_event":${rawBody}}`,
      });
      if (!res.ok) return false;
      return ((await res.json()) as { verification_status: string }).verification_status === "SUCCESS";
    },
  };
  return api;
}

export type SandboxPayPal = ReturnType<typeof sandboxPayPal>;
