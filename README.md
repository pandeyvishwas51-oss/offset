# OFFSET

**Small businesses owe each other in circles. Their AI agents cancel what cancels, and PayPal moves only what is left.**

Built for the PayPal AI Hackathon 2026.

**Demo video (2:46):** [video/offset-demo.mp4](video/offset-demo.mp4). One unedited run against the real PayPal sandbox with Claude agents, with quiet stretches sped up.

The demo has six businesses in one supply chain holding $64,250 of unpaid invoices against each other. In a run against the real PayPal sandbox, OFFSET cleared $42,850 of that with no money moving at all, kept $7,200 of suspect invoices out, and settled the rest with $14,200 of PayPal payouts. The exact split depends on what the agents agree; the least that could ever need paying is $13,400.

## The problem

Late payment is a chain reaction: A cannot pay B until C pays A, and C is waiting on B. In 2026, 59% of US small businesses carry invoices more than 30 days overdue ([QuickBooks](https://quickbooks.intuit.com/r/small-business-data/small-business-late-payments-report-2026/)).

Much of that debt is circular, and circular debt can be cancelled without anyone paying anyone. Slovenia and Romania have run national clearing systems on this principle for decades. A 2026 study of 133,191 real invoices found that cancelling loops clears 21% of the debt, and also shortening chains clears 54% ([de la Rosa Esteva & Madugula](https://arxiv.org/abs/2606.26126)).

It does not happen between ordinary small businesses because every company in a loop has to agree at the same moment that its invoices are valid, and shortening a chain asks a creditor to trust a different payer. That coordination costs more than it saves when people do it by phone. Agents make it free.

## What happens in a round

1. **Read the books from PayPal.** Open invoices come from the PayPal Invoicing API, the record both sides already share.
2. **Check the paperwork.** An AI checker compares each invoice with its purchase order and delivery record. An invoice it cannot stand behind is held back. The demo includes an inflated invoice whose delivery note tells "any automated reviewer" to approve it; it is held.
3. **Each business's agent checks its own books.** An agent can hold back an invoice its owner disputes. In the demo, Kite's agent refuses to settle an invoice for water-damaged stock.
4. **Cancel the loops.** Plain code finds every loop of debt and cancels it. Nobody's net position changes, so this needs no negotiation.
5. **Shorten the chains, by negotiation.** If A owes B and B owes C, A can pay C directly and B drops out. That changes who C relies on, so C's agent judges A's payment record against its owner's instructions and can accept, refuse, or ask for faster payment. A's agent answers.
6. **Write the result to PayPal, all or nothing.** Each cancelled amount is recorded as a payment on the real invoice. Each redirected debt becomes a new PayPal invoice. If any call fails, every earlier one is reversed.
7. **Pay what is left.** One PayPal payout per debtor. Webhooks confirm each payment and the invoice is marked paid.

## Where the AI is, and where it is not

The clearing maths is deterministic code over integer cents ([server/engine.ts](server/engine.ts)). No model ever does arithmetic on money.

Claude makes the judgment calls ([server/brain.ts](server/brain.ts)): whether paperwork supports an invoice, whether an owner would want an invoice held back, whether to accept a new payer, whether a business can meet the terms asked of it. Each business's agent acts on instructions its owner wrote in plain English.

An agent can only say yes, no, or yes-if. If an agent errors, times out or refuses, the answer is no: the invoice is held, or the business sits the round out. There is a test for this.

## How PayPal is used

| PayPal API | What OFFSET does with it |
|---|---|
| `POST /v1/oauth2/token` | One token per business, cached, fetched server-side only |
| `POST /v2/invoicing/invoices` + `/send` | Issues every demo invoice, and a new invoice for each redirected debt |
| `GET /v2/invoicing/invoices/{id}` | Reads the amount due before each round; PayPal is the source of truth |
| `POST /v2/invoicing/invoices/{id}/payments` | Records each set-off (partial payments included) and each confirmed payout |
| `DELETE /v2/invoicing/invoices/{id}/payments/{id}` | Reverses a set-off when a round has to be undone |
| `POST /v2/invoicing/invoices/{id}/cancel` | Withdraws a redirect invoice when a round is undone |
| `POST /v1/payments/payouts` | Pays what is left, one batch per debtor |
| `GET /v1/payments/payouts/{id}` | Polls for payments whose webhook never arrived |
| `POST /v1/notifications/webhooks` | Registers a webhook per business at start-up |
| `POST /v1/notifications/verify-webhook-signature` | Checks every incoming webhook before trusting it |

## Run it

Needs Node 22.18 or newer. No build tools beyond npm.

```bash
npm install
npm run build
npm start
```

Open http://localhost:8787.

With no configuration, OFFSET runs against a simulated PayPal with rule-based agents, and the page says so. That is enough to see the whole flow.

For the real thing, copy `.env.example` to `.env` and fill it in:

- `ANTHROPIC_API_KEY` turns on the Claude agents. With no API key, `OFFSET_AGENTS=claude-plan` runs the same agents through the Claude Agent SDK, using the Claude subscription signed in on your machine.
- Six PayPal sandbox apps (one per business, Invoicing and Payouts enabled) turn on the real sandbox. `npm run smoke` checks the PayPal calls against two of them.
- `PUBLIC_URL` turns on webhooks. Without it, payments are confirmed by polling.

`render.yaml` deploys the same thing to Render.

## Proof that it holds up

```bash
npm test
```

| Test | What it proves |
|---|---|
| Net positions on 300 random debt graphs | Clearing never makes any business better or worse off, and the actions on invoices add up to the cent |
| PayPal fails on the fifth write | Every earlier write is reversed; no invoice changes on PayPal or locally |
| Webhook delivered twice, button pressed twice | One payment is recorded, one payout is sent |
| A payout fails | Its invoice stays open |
| The model is unavailable | Nothing is settled |

How the failure handling works:

- **Retries cannot double-record.** Every PayPal write carries a marker in its note. Before writing, OFFSET reads the invoice and looks for its own marker.
- **Payouts cannot double-send.** PayPal rejects a repeated `sender_batch_id`.
- **Webhooks are verified and deduplicated.** The signature is checked with PayPal; the event id is a primary key.
- **Webhooks are not trusted to arrive.** A poller asks PayPal about every payment still waiting. Whichever of the two gets there first does the work.
- **A crash mid-round is reversed on restart.**

## Built with

- **PayPal**: Invoicing v2, Payouts, Webhooks, OAuth2 (sandbox)
- **Claude Opus 5.5** with structured outputs, through the Anthropic TypeScript SDK (API key) or the Claude Agent SDK (Claude subscription)
- **AG Grid** for the invoice ledger, the PayPal entries and the webhook log
- **Render** for hosting
- Node.js (built-in HTTP server, SQLite and test runner), React, Vite, TypeScript

## Limits, stated plainly

- Sandbox only. The PayPal base URL is fixed in code.
- Sandbox balances are finite. "Start over" sends the last run's payouts back, but the sandbox takes tens of minutes before returned money can be spent again, so full runs started back to back can hit a low balance. A rejected payout is reported, leaves its invoice open, and can be retried.
- Each demo business has its own PayPal app and keys. A real service would act for businesses through PayPal's partner permissions.
- A redirect is an agreement between three parties that OFFSET records. Whether set-off and payment direction are enforceable depends on the contract and the country.
- The loop finder is greedy, not optimal. It is fine for small networks.
- Without an API key the agents are fixed rules, labelled as such.

## More

- [docs/design.md](docs/design.md): architecture, data model, sandbox setup, sequence
- [docs/demo-script.md](docs/demo-script.md): the three-minute demo and the Devpost text
- [docs/phase1-intel-and-ideas.md](docs/phase1-intel-and-ideas.md): research and the ideas that were rejected

MIT licensed.
