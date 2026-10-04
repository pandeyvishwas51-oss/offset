# Phase 1: Intelligence & Ideation

> **Decision (2026-10-04):** none of the three ideas below was built. Another team was already building idea B, and A was too likely to be duplicated. The project is **OFFSET**, multilateral debt clearing negotiated by agents. See [design.md](design.md). Sections 1.1 to 1.3 below (rules, PayPal's strategy, sandbox APIs) still apply.

_PayPal AI Hackathon 2026 · prepared 2026-10-04 · 39 days to deadline_

---

## 1. Intelligence

### 1.1 What the rules actually say (checked on Devpost, Oct 4)

| | |
|---|---|
| Window | Oct 1 to **Nov 12, 2026, 12:00 PM PT** (39 days left) |
| Judging | Dec 1–15, winners announced around Dec 21 |
| Hard requirements | A working prototype: hosted URL **or** complete run instructions. Mockups fail Stage 1. A public GitHub repo with an OSS license. A **YouTube video under 3 minutes showing it actually running**. A text description and a list of the tools used. |
| Must use | PayPal Developer Platform (sandbox) plus any AI. The rules say "PayPal integration is central". |
| Stage 1 | Pass/fail viability check |
| Stage 2 | 5 equally weighted criteria: Technological Implementation, Design, Potential Impact, Innovation, Presentation |
| Prizes | 1st $12k, 2nd $8k, 3rd $5k. Honorable mentions $5k each: Most Creative, Most Impactful, Best Demo Delivery, Best Use of PayPal + AI, **Best Use of Agentic Commerce** |
| Sponsor prizes | AG Grid $5k / $2k / $1k ×3, Channel3 $1.5k, APIMatic $1k + subscription ×3, Bryntum $1k ×3, Render credits |
| Stacking rule | At most **one Grand prize or one honorable mention, plus one sponsor prize** |
| Field size | About 5,000 registrants |

**Prize strategy.** The ceiling is 1st place ($12k) plus AG Grid 1st ($5k), so $17k. The floor is "Best Use of Agentic Commerce". Each idea below needs a transaction ledger grid anyway, so going for the AG Grid prize costs no extra work.

**The lane to avoid:** "AI shopping assistant + PayPal checkout button." It's the obvious build, and public repos for it already exist (e.g. ShopGenie). With about 5,000 entrants, expect dozens of these.

### 1.2 What PayPal is doing in agentic commerce, and what it isn't

**Merchant side, already covered by PayPal:**
- **Agent Ready**: merchants accept payments from agents with zero code changes.
- **Store Sync**: puts merchant catalogs into ChatGPT, Perplexity, Gemini and Copilot.
- The Cymbio acquisition (Jan 2026) and the Meta Muse partnership (Sept 22, 2026).
- It works across all the agent protocols: ACP, UCP, AP2, A2A.

**Developer side:** the Agent Toolkit (TypeScript and Python) and an MCP server, either local (`@paypal/mcp`) or hosted (`mcp.sandbox.paypal.com`).

**Gaps, which are our opening:**
1. **Nothing controls what an agent spends on the buyer's side.** The Agent Toolkit has no built-in human confirmation step and no spending caps. It only has action allowlists and OAuth scopes, and the credential owner is liable for everything the agent does. PayPal's Agentic Commerce Services launch says nothing about buyer spending controls.
2. **There is no reference implementation of AP2 mandates on PayPal**, even though PayPal was an AP2 launch partner. A mandate is a signed statement from a person saying what their agent may spend, where, and until when.
3. **Machine-to-machine micropayments are moving off cards and wallets to stablecoins.** x402 (Coinbase/Cloudflare, settles in USDC) did 75.4M transactions worth $24.2M in the 30 days to late Sept 2026. Stripe launched a regular-money answer in March 2026 (Machine Payments Protocol). PayPal has nothing equivalent for its wallet.
4. **PayPal has no way to pay only when a job is verified done**, beyond raw authorize and capture.

A line from industry writing worth borrowing: *"the rail is the easy 20 percent."* The unsolved part is enforcing budgets, checking spend against mandates, and auditing agent spending.

### 1.3 Sandbox APIs we can actually build on

| Primitive | Endpoint | What it gives an agent |
|---|---|---|
| OAuth2 | `POST /v1/oauth2/token` | A server-side bearer token. Agents never see the secrets. |
| Vault v3 | `POST /v3/vault/setup-tokens`, then the buyer approves, then `POST /v3/vault/payment-tokens` | The human consents once. After that the platform can charge the saved wallet with nobody present. |
| Orders v2 | `POST /v2/checkout/orders` with `intent: CAPTURE \| AUTHORIZE` and `payment_source.paypal.vault_id` | The agent pays without a human clicking anything |
| Authorizations | `/v2/payments/authorizations/{id}/capture \| void \| reauthorize` | **A built-in funds hold**: a 3-day honor period, valid for up to 29 days, and it can be captured in parts |
| Refunds | `POST /v2/payments/captures/{id}/refund` | Reversals |
| Payouts | `POST /v1/payments/payouts` | Send money to many recipients by email in one batch |
| Webhooks | `/v1/notifications/webhooks`, `verify-webhook-signature`, `simulate-event` | Asynchronous events from PayPal; the source of truth for whether money moved |
| Disputes | `/v1/customer/disputes` | A place to send contested payments |
| Idempotency | `PayPal-Request-Id` header | A retried POST runs only once |

**Don't let the demo depend on these:** Agent Ready and Store Sync (they need program onboarding) and multiparty `platform_fees` (needs partner approval). Design the production version around them, but don't block the demo on them.

### 1.4 Where adding AI on top of PayPal creates revenue

| Friction | Who loses money | What the AI does | What PayPal earns |
|---|---|---|---|
| Nobody trusts an agent with a wallet | Every company piloting agents | Checks each purchase against rules and the agent's actual task | Agent spending goes through the PayPal wallet, which is PayPal-branded payment volume |
| Paying for results, not effort | Buyers of work from agents or freelancers | Checks the delivered work automatically | Captured volume plus Payouts fees |
| Payments under a cent between machines | API, data and content sellers | An agent that buys within a budget | A new transaction category that otherwise goes to x402 or Stripe MPP |
| Cross-border supplier payments (currency fees, invoice fraud) | SMB finance teams | Reads invoices and matches them to orders and receipts | Payouts plus currency conversion. **Rejected:** crowded (Tipalti, Bill, Ramp) and a weak fit for agentic commerce |

---

## 2. The Unthinkable 3

### A. MANDATE: a spending firewall for AI agents on PayPal (recommended)

**What it is.** A person or a finance team saves their PayPal wallet once. Then they give each agent a signed, AP2-style mandate:
- a cap per transaction
- a rolling budget
- a list of allowed merchants and categories
- a stated purpose
- an expiry date

Agents never hold credentials. They call one MCP tool, `request_payment`, from Claude, ChatGPT, LangChain or anything else. Every request passes through three checks:

1. **Rules check** (fixed code): caps, budget, allowlist, expiry, and how fast it's spending.
2. **Intent check** (LLM): does this purchase match the mandate's purpose and what the agent was actually asked to do? This catches purchases planted by prompt injection, and purchases the agent hallucinated, even when they're under the dollar limits.
3. **Human approval**: if the amount is over the threshold or the purchase was flagged, the human gets a one-tap approve link on their phone.

Once approved, the platform creates an Orders v2 charge against the saved wallet, or authorizes now and captures on delivery. PayPal webhooks reconcile each payment into an append-only ledger where each entry is hash-chained to the one before, shown in AG Grid.

Who buys it: every company running procurement, ops, travel or ad-buying agents, plus consumers with personal agents. Think "corporate card for agents," built on PayPal.

**How PayPal makes money.**
- **It protects branded checkout.** The PayPal button is widely reported as PayPal's most profitable business. The risk in agentic checkout is that agents pay with tokenized cards and skip the PayPal wallet entirely. MANDATE makes the PayPal wallet the controlled funding source for agents, so PayPal keeps that volume.
- **SaaS fee:** a monthly fee per active agent for business accounts.
- **Fraud data:** every agent transaction comes labeled with what the agent was trying to do. That's training data for PayPal's fraud models and lowers losses on agent traffic.

**PayPal APIs used.**
- OAuth2
- Vault v3: setup token, then payment token, with `usage_type: MERCHANT`
- Orders v2 with `vault_id`, both CAPTURE and AUTHORIZE
- Authorizations capture and void
- Refunds
- Webhooks, with signature verification:
  - `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`
  - `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`
  - `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`
- Payouts, to pay the merchants in the sandbox demo
- Agent Toolkit for read-only tools like order and tracking lookups
- `PayPal-Request-Id` on every POST

Sandbox accounts: 1 platform business account that owns the REST app, 1 personal buyer account whose wallet gets saved, and 2–3 demo merchant business accounts.

**Pre-mortem: what an auditor would flag.**

| Flag | How the design answers it |
|---|---|
| "You're holding customer funds, so you're a money transmitter" | In production, use multiparty (`payee` + `platform_fees`) so money goes straight from buyer to merchant and we never hold it. The sandbox demo pays merchants with Payouts and says clearly that this stands in for multiparty. |
| "An LLM is approving payments" | The LLM can only **block or escalate**. It can never approve anything the fixed rules didn't already allow. If it errors or times out, the payment is blocked. |
| "Prompt injection gets past the intent check" | The intent check treats the request as data and returns structured output. Injected text from product pages is quoted, not followed. A red-team test suite runs in CI. |
| "An agent replays a request and the buyer is charged twice" | Signed payment intents can be used once, every POST carries a `PayPal-Request-Id`, and the database enforces unique state transitions. |
| "Someone steals the saved-wallet token" | The token stays on the server, encrypted at rest. Agents only get revocable mandate keys with limited scope. Revoking a mandate takes effect immediately, and the user can delete the saved wallet. |
| "Who's liable when something goes wrong?" | The mandate is a signed record of what the human authorized (AP2 meaning), which gives clean evidence in disputes. Every decision is logged with its reasons. |

---

### B. VERDICT: escrow that pays only when the work is verified

**What it is.** A buyer (a person or an agent) posts a job with acceptance criteria a machine can check. The money is held with Orders v2 `intent: AUTHORIZE`. That's a hold on the buyer's own PayPal account, not money sitting in ours. A provider (an agent or a person) delivers the work. Then a verification pipeline runs:
- Fixed checks first: tests pass, the schema is valid, the URL is live.
- Then several AI models grade it against a rubric.

What happens next:
- **Pass:** capture the payment and pay the provider with Payouts.
- **Partial pass:** capture part of it and void the rest.
- **Fail:** void the hold.
- **Contested:** a human arbiter decides, with the Disputes API as backup.

Who buys it: marketplaces for agent services, data labeling, bug bounties, content operations, and milestone payments under statements of work.

**How PayPal makes money.** Fees on captured volume and Payouts, plus a fee per verification. PayPal becomes where agent work gets paid.

**PayPal APIs used.**
- OAuth2
- Orders v2 AUTHORIZE
- Authorizations: `/capture` (partial captures via `final_capture`), `/void`, `/reauthorize`
- Payouts, plus the `PAYMENT.PAYOUTS-ITEM.*` webhooks
- Disputes
- Webhook signature verification

**Pre-mortem.**

| Flag | Answer |
|---|---|
| Escrow licensing | We never hold the money. The hold is a PayPal authorization on the buyer's own account. |
| Authorizations expire after 29 days | Keep each milestone to 29 days or less, and reauthorize after the 3-day honor period. |
| "AI decides who gets paid" | The fixed checks come first, and the AI grade can't overrule a failed test. There's an appeal window and a human arbiter. |
| The delivered work contains a prompt injection aimed at the grader | Deliverables are handled as untrusted data in a sandbox, the verdict has a fixed schema, and the test suite includes planted injections. |
| Buyer and provider collude, or trade with themselves | Both sides use identity-verified PayPal accounts, there are velocity limits, and accounts with the same owner get detected. |

**Weakness for judging:** the demo is slow (post a job, do the work, verify it), and "escrow marketplace" sounds familiar.

---

### C. TOLLGATE: HTTP 402 on PayPal

**What it is.** PayPal's regular-money answer to x402 and Stripe MPP. API, data and content sellers add a small layer to their servers. When an agent calls without credit, the server answers `402 Payment Required` with a PayPal payment request. The agent's Tollgate wallet then opens a tab:

1. It puts an **authorization hold** on the saved wallet, for example $10.
2. Each call is metered against that hold at prices under a cent.
3. When the tab closes or hits a threshold, it settles with **partial captures**.

So thousands of calls become one PayPal transaction. Sellers get paid in batches through Payouts.

Where the AI comes in: an agent that decides which paid source is worth buying, within its budget, and anomaly detection on the seller side.

**How PayPal makes money.** It opens a transaction category PayPal currently leaves to stablecoins. Rolling many calls into one charge makes the fixed fee bearable. PYUSD can come later. Sellers pay a SaaS fee.

**PayPal APIs used.**
- Vault v3
- Orders v2 AUTHORIZE with `vault_id`
- Partial capture (`final_capture: false`) and voiding the remainder
- Payouts in batches
- Webhooks

**Pre-mortem.**

| Flag | Answer |
|---|---|
| Stored value or prepaid balances | There is no prepaid balance. The hold sits on the payer's own PayPal and only what was used gets captured. |
| Fees eat small payments | PayPal's fixed fee per transaction dominates small charges, so enforce a minimum settlement size and roll many calls into one charge. |
| The agent runs up a tab, then deletes the saved wallet | Credit is capped at the hold amount, and the hold is already authorized. |
| A seller reports calls that never happened | The agent side signs a receipt for each call, and there's a dispute window before capture. |

**Weakness:** hardest to make gripping in 3 minutes, and the fee math invites skepticism from judges.

---

### Scoreboard

| | A Mandate | B Verdict | C Tollgate |
|---|---|---|---|
| Demo punch in 3 minutes | ★★★ a live attack gets blocked | ★★ | ★★ |
| Innovation | ★★ known concept, nobody has done it on PayPal | ★★ | ★★★ |
| Fit with PayPal's strategy | ★★★ protects branded checkout, matches AP2 | ★★ | ★★★ answers x402 and Stripe MPP |
| How deeply it uses PayPal APIs | ★★★ | ★★★ | ★★★ |
| Risk of not finishing in 39 days | low to medium | medium | medium to high |
| Risk that others build the same thing | medium ("guardrails" is the second most obvious idea) | low | low |

**Recommendation: A.** Add C's authorization-hold tab as an optional extra payment mode inside Mandate in week 5, only if we're ahead of schedule.

A wins on the two criteria that are hardest to fake:
- **Presentation:** a prompt injection gets blocked live, then a human approves the real purchase on a phone.
- **Impact:** it's the layer the industry says is unsolved, and it protects PayPal's most profitable product.

The risk that other teams build guardrails too is real. We beat it on execution:
- the intent check reads what the agent was asked to do, not just dollar limits
- it drops into any agent through MCP
- real charges against a saved PayPal wallet with no human present
- webhook reconciliation that survives deliberately broken conditions

---

## Setup you can do now (no decision needed)

1. developer.paypal.com → **Sandbox → Accounts.** Create these, all with country **US**:
   - a **Business** account called `platform`
   - a **Personal** account called `buyer`
   - two more **Business** accounts called `merchant-a` and `merchant-b`

   Vault and Payouts are most reliable on US sandbox accounts.
2. **Apps & Credentials → Sandbox → Create App**, linked to the `platform` business account. In the app's features, make sure **Vault (save payment methods)** and **Payouts** are on.
3. Keep the Client ID and Secret in a local `.env` file only. Never paste them in chat or commit them to git.

## Sources

- [Devpost overview](https://paypalaihackathon.devpost.com/) · [Rules](https://paypalaihackathon.devpost.com/rules) · [Resources](https://paypalaihackathon.devpost.com/resources) · [PayPal hackathon blog](https://developer.paypal.com/community/blog/PayPal_AI_Hackathon/)
- [PayPal Agent Toolkit blog](https://developer.paypal.com/community/blog/paypal-agentic-ai-toolkit/) · [Agent Toolkit gaps (Vorp Labs)](https://vorplabs.com/agent-tools/paypal-agent-toolkit)
- [Agentic Commerce Services press release](https://www.prnewswire.com/news-releases/paypal-launches-agentic-commerce-services-to-power-ai-driven-shopping-302596548.html) · [Agent Ready & Store Sync overview](https://stellagent.ai/insights/paypal-agentic-commerce-agent-ready) · [PayPal agentic commerce explained (Eco)](https://eco.com/support/en/articles/14730447-paypal-agentic-commerce-explained)
- [AP2 explained](https://eco.com/support/en/articles/14845479-ap2-agent-payments-protocol-explained) · [The metering gap (UsageBox)](https://usagebox.com/articles/ai-agent-payment-stack-2026-x402-ap2-agent-pay-metering-gap) · [Protocol war: UCP vs x402 vs PayPal](https://bex.co/blog/2026/04/18/google-ucp-vs-x402-paypal-ai-agent-payment-protocol-war)
- [ShopGenie (example of the crowded lane)](https://github.com/Parithosh-Varma/paypal-ai-hackathon)
