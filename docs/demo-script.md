# Demo video script (under 3 minutes)

Record the hosted app with real sandbox keys and the Claude agents on. Keep the PayPal sandbox dashboard open in a second tab. Click "Start over" before recording so the invoices are fresh.

| Time | On screen | Say |
|---|---|---|
| 0:00 | The graph, all red lines | "Six small businesses. $64,250 in unpaid invoices between them. Each one is waiting to be paid before it can pay." |
| 0:12 | Point at a loop on the graph | "But look: Harbor owes Lumen, Lumen owes Kite, Kite owes Harbor. That debt goes in a circle. It can cancel without anyone paying. Slovenia has done this nationally for thirty years. It doesn't happen between small businesses because everyone has to agree at once. So we gave each business an agent." |
| 0:32 | Switch to the PayPal dashboard, show one sandbox invoice | "These are real PayPal invoices in the sandbox." |
| 0:38 | Back to OFFSET, click **Clear the debts** | "Watch the feed." |
| 0:42 | Feed: paperwork check holds BX-3340 | "First, a paperwork check. This invoice says $4,800 but the purchase order says $3,800. Its delivery note even tells an automated reviewer to approve it. Held." |
| 0:55 | Feed: Kite's agent holds HD-2231 | "Kite's agent knows something the paperwork doesn't: that stock arrived water-damaged. It refuses to settle that invoice." |
| 1:05 | Graph: loops flash and shrink | "Now the loops cancel. This part is plain maths, no AI. Watch the total drop." |
| 1:18 | Feed: a counter-offer and its answer | "Chains are harder. If Kite pays Boxwell directly, Harbor drops out. But Kite pays late. So Boxwell's agent says: only if you pay within ten days. Kite's agent checks what its owner allows, and agrees." |
| 1:38 | Feed: a refusal, then another route | "Swift's agent wants seven days. Kite can't do that. No deal, and OFFSET finds another route." |
| 1:48 | The sum panel | "Result: about $43,000 cancelled, and no money has moved. Every business's net position is exactly what it was." |
| 1:58 | "Written to PayPal" tab | "Each cancellation is a payment recorded on the real PayPal invoice. If one of these writes had failed, all of them would have been reversed. There's a test for that." |
| 2:10 | Click **Pay the $… that is left** | "Now the only money that needs to move." |
| 2:15 | Feed: PayPal confirmations; "Heard from PayPal" tab | "Real PayPal payouts. Each webhook is signature-checked and deduplicated, and if a webhook never arrives, a poller asks PayPal directly." |
| 2:32 | PayPal dashboard: same invoice now paid | "Back in PayPal: paid." |
| 2:38 | The finished sum | "$14,000 of real money settled $57,000 of invoices. PayPal has millions of businesses on one ledger. No bank can do this. PayPal can." |
| 2:52 | Terminal: `npm test` passing | "Open source, runs with one command. Thank you." |

The exact dollar figures depend on what the agents agree in that run. Read them off the screen rather than memorising these.

# Devpost text

**Name:** OFFSET

**Tagline:** AI agents cancel the debts small businesses owe each other in circles. PayPal moves only what's left.

**Inspiration**
Late payment is a chain reaction. A can't pay B until C pays A, and C is waiting on B. Much of that debt is circular, and circular debt can be cancelled without money moving. Slovenia and Romania run national clearing systems on this idea. It never reached ordinary small businesses because every party has to agree at once. Agents remove that cost.

**What it does**
OFFSET reads open invoices from PayPal, checks each against its paperwork, lets each business's agent hold back anything its owner disputes, cancels every loop of debt, and then has the agents negotiate shortcuts along chains ("pay my supplier directly, within ten days"). The result is written back to the real PayPal invoices, and the remainder is paid with PayPal payouts.

**How we built it**
Node.js and TypeScript with no framework. PayPal Invoicing v2, Payouts and Webhooks through plain REST calls, one sandbox app per business. Claude Opus 5.5 with structured outputs for every judgment. SQLite for state. React, AG Grid and a hand-drawn SVG graph for the interface. Hosted on Render.

**Challenges**
PayPal has no transaction that spans several businesses, so a round is written as a set of reversible entries: if one fails, the rest are deleted. Recording a payment on an invoice has no idempotency key, so each entry carries a marker in its note and OFFSET looks for the marker before writing.

**What we're proud of**
The split between maths and judgment. No model ever does arithmetic on money, and a model that fails to answer means no. A property test over 300 random debt graphs shows clearing never changes any business's net position.

**What we learned**
The PayPal Invoicing API already supports everything clearing needs: partial recorded payments, deletable payments, and notes that come back on read.

**What's next**
Bridge loans placed where the smallest amount unlocks the most clearing, which is a natural fit for PayPal Working Capital. Acting for businesses through partner permissions instead of one app each.

**Built with:** PayPal Invoicing API, PayPal Payouts API, PayPal Webhooks, Claude (Anthropic API), AG Grid, Render, Node.js, TypeScript, React, SQLite
