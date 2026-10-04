# OFFSET: design

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js 22.18+, TypeScript run directly, built-in `node:http` | One process, no framework, no compile step |
| Database | SQLite through built-in `node:sqlite` | Transactions and constraints with nothing to install |
| Agents | Claude Opus 5.5, Anthropic TypeScript SDK, structured outputs (`messages.parse` with Zod) | Every answer is a typed yes, no or yes-if |
| PayPal | Plain `fetch` against the REST API | Ten endpoints; a client library would hide the calls judges want to see |
| Interface | React, Vite, AG Grid, hand-drawn SVG graph | AG Grid for the three ledgers; the graph is 100 lines of SVG |
| Hosting | Render (`render.yaml`) | Public address for PayPal webhooks |
| Tests | Built-in `node --test` | Runs the real round logic against an in-memory PayPal |

## 2. Sandbox setup and sign-in

1. In the PayPal Developer dashboard, under Testing Tools > Sandbox Accounts, create six **US Business** accounts with a balance (bulk CSV upload does all six at once).
2. Under Apps & Credentials, create one REST app per account (type Merchant). On each app turn on **Invoicing**; Payouts is on by default. Save.
3. Put each app's Client ID, Secret and account email in `.env` (see `.env.example`).
4. `npm run smoke` proves the calls on two of the accounts: issue an invoice, record a partial payment, reverse it, cancel, send a payout and watch it reach `SUCCESS`.

Sign-in: for each business the server calls `POST /v1/oauth2/token` with HTTP Basic auth (`client_id:secret`) and `grant_type=client_credentials`, and caches the bearer token until a minute before it expires. Tokens and secrets stay on the server; the browser and the agents never see them.

Webhooks: at start-up, when the server has a public address, it registers `POST {PUBLIC_URL}/webhooks/paypal/{business}` on each app through `POST /v1/notifications/webhooks` and stores the webhook id. Locally there is no public address, so the poller confirms payments instead. To exercise webhooks without deploying, point `PUBLIC_URL` at a tunnel, or send test events from the dashboard's Webhook Simulator (simulated events do not pass signature verification, which is the correct behaviour).

## 3. How data moves

```
Browser            OFFSET server                 Claude                PayPal sandbox
   |  POST /api/round  |                            |                        |
   |------------------>|  GET invoice (x14)        |                        |
   |                   |---------------------------------------------------->|  amounts due
   |                   |  verify(invoice, PO, delivery note) x14             |
   |                   |--------------------------->|  ok / hold + reason    |
   |                   |  checkBooks(business) x6   |                        |
   |                   |--------------------------->|  disputed invoices     |
   |                   |  engine: cancel loops (no model, no network)        |
   |                   |  engine: propose next chain                         |
   |                   |  judgeNewPayer(creditor)   |                        |
   |                   |--------------------------->|  accept/counter/reject |
   |                   |  answerTerms(payer)        |                        |
   |                   |--------------------------->|  accept / refuse       |
   |                   |  ... repeat until no chain is left ...              |
   |                   |  record set-off on each invoice                     |
   |                   |---------------------------------------------------->|  payment_id
   |                   |  create + send invoice for each redirected debt     |
   |                   |---------------------------------------------------->|  invoice id
   |  GET /api/state   |  (any failure: delete payments, cancel invoices)    |
   |<------------------|                            |                        |
   |  POST /api/pay    |  POST payouts, one batch per debtor                 |
   |------------------>|---------------------------------------------------->|
   |                   |  webhook PAYMENT.PAYOUTS-ITEM.SUCCEEDED             |
   |                   |<----------------------------------------------------|
   |                   |  verify signature, dedupe on event id               |
   |                   |  record payment on the invoice                      |
   |                   |---------------------------------------------------->|
```

The browser polls `/api/state` and replays the round one entry at a time.

## 4. Data model

SQLite, defined in `server/db.ts`. Money is integer cents everywhere.

**business**

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | `lumen`, `harbor`, ... |
| name, trade, email | TEXT | email is the PayPal sandbox account |
| policy | TEXT | the owner's instructions to their agent, in plain English |
| notes | TEXT | what the owner knows that the paperwork does not show |
| on_time_pct, avg_days_late | INTEGER | payment record other agents judge |
| webhook_id | TEXT | PayPal webhook id, needed to verify signatures |

**invoice**

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | invoice number |
| paypal_id | TEXT | PayPal invoice id |
| creditor, debtor | TEXT FK | |
| amount, open | INTEGER | `CHECK (open >= 0 AND open <= amount)` |
| due, memo, evidence | TEXT | evidence is the purchase order and delivery record |
| status | TEXT | `open`, `held`, `disputed`, `settled` |
| flag | TEXT | why it was held or disputed |
| from_round | INTEGER | set on invoices created for redirected debt |

**round**

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| status | TEXT | `running`, `cleared`, `failed` |
| phase | TEXT | `sync`, `verify`, `books`, `loops`, `chains`, `settle`, `done` |
| gross, left | INTEGER | owed before, owed after |
| snapshot | TEXT | the debts before clearing, for replay in the interface |
| started, finished, error | TEXT | |

**step**: one row per loop or chain proposal.

| Column | Type | Notes |
|---|---|---|
| round_id | INTEGER FK | |
| kind | TEXT | `loop`, `redirect` |
| path | TEXT | JSON list of business ids |
| amount | INTEGER | |
| status | TEXT | `agreed`, `refused` |
| terms | TEXT | JSON, e.g. `{"dueDays": 10}` |

**leg**: one row per action on PayPal. This table is the state machine.

| Column | Type | Notes |
|---|---|---|
| round_id | INTEGER FK | |
| kind | TEXT | `setoff`, `new_invoice`, `payout` |
| invoice_id | TEXT | |
| amount | INTEGER | `CHECK (amount > 0)` |
| marker | TEXT UNIQUE | written into the PayPal note so a retry can find its own earlier attempt |
| status | TEXT | `pending` > `sent` > `done`, or `failed`, or `reverted` |
| ref | TEXT | PayPal payment id, invoice id or payout item id |
| error | TEXT | |

**event**: the feed shown in the interface (`round_id, at, actor, kind, text`).

**webhook**: `id TEXT PRIMARY KEY` is PayPal's event id, so a webhook delivered twice is processed once. Also `business, type, ref, verified, at, outcome`.

## 5. What a security or compliance reviewer would ask

| Question | Answer in the design |
|---|---|
| Does OFFSET hold customer money? | No. Set-off is bookkeeping on invoices; payouts go straight from debtor to creditor. |
| Can a model move money? | No. Models return yes, no or yes-if. Amounts come from the engine. A model error counts as no. |
| Can a fake invoice be used to wipe out a real debt? | The paperwork check holds invoices that do not match their purchase order, and each business's agent can hold back its own. Held invoices never enter the graph. |
| Prompt injection through an invoice document? | Documents are passed as quoted evidence, and the checker is told that text instructing a reviewer is itself suspicious. The demo data contains such an attempt. |
| Double payment on retry? | Marker lookup before every invoice write; unique `sender_batch_id` on payouts; guarded status transitions in SQL. |
| Half-finished settlement? | A round's PayPal writes are reversed together if any one fails, and on restart if the process died. |
| Forged webhook? | Signature verified with PayPal before the body is used. |
| Who agreed to what? | Every proposal, answer and reason is stored in `step` and `event`. |

## 6. What comes next

- Act for businesses through PayPal partner permissions instead of one app per business.
- A bridge loan: when one business's cash gap blocks a chain, find where the smallest short loan unlocks the most clearing. This is where PayPal Working Capital fits.
- Replace the greedy loop finder with a minimum-cost flow for large networks.
