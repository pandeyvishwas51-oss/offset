// The decision behind the latest entry, drawn as a conversation: who is talking, what each agent answered,
// and (one click away) the owner's instructions that produced the answer.
import { useState } from "react";
import type { Business, Event, Invoice, Step } from "./types.ts";
import { usd, usd0 } from "./types.ts";

export type Focus =
  | { kind: "invoice"; invoice: Invoice; events: Event[] }
  | { kind: "step"; step: Step; events: Event[] }
  | null;

export const initialsOf = (name: string) => name.split(/[^A-Za-z]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const VERDICT: Record<string, string> = { accept: "Yes", counter: "Yes, if", reject: "No", dispute: "Hold", hold: "Held" };

function Face({ biz, small }: { biz: Business; small?: boolean }) {
  return <span className={`face${small ? " face-small" : ""}`} aria-hidden="true">{initialsOf(biz.name)}</span>;
}

// One agent's turn in the conversation. The owner's instructions sit behind a disclosure, not in the way.
function Turn({ biz, event, side, rule, ruleLabel }: { biz: Business; event: Event | undefined; side: "left" | "right"; rule: string; ruleLabel: string }) {
  return (
    <div className={`turn turn-${side} ${event ? `said-${event.kind}` : "is-thinking"}`}>
      <Face biz={biz} />
      <div className="bubble">
        <p className="who">{biz.name}'s agent{event && <b>{VERDICT[event.kind]}</b>}</p>
        {event ? <p>{event.text}</p> : <p className="dots" aria-label="Deciding"><i /><i /><i /></p>}
        <details><summary>{ruleLabel}</summary><blockquote>{rule}</blockquote></details>
      </div>
    </div>
  );
}

export function Agents({ focus, businesses, agents }: { focus: Focus; businesses: Business[]; agents: "claude" | "scripted" }) {
  const [tab, setTab] = useState<"focus" | "all">("focus");
  const biz = (id: string) => businesses.find((b) => b.id === id)!;
  const showAll = tab === "all" || !focus;

  let body: React.ReactNode;
  if (showAll) {
    body = (
      <ul className="roster">
        {businesses.map((b) => (
          <li key={b.id}>
            <Face biz={b} />
            <div>
              <h4>{b.name}<span>{b.trade}</span></h4>
              <div className="meter-row" title={`${b.on_time_pct}% of invoices paid on time`}>
                <span className="reliab"><i style={{ width: `${b.on_time_pct}%` }} /></span>{b.on_time_pct}% on time
              </div>
              <details><summary>What its owner told its agent</summary><blockquote>{b.policy}</blockquote></details>
            </div>
          </li>
        ))}
      </ul>
    );
  } else if (focus.kind === "invoice") {
    const { invoice, events } = focus;
    const said = events.at(-1)!;
    const evidence = JSON.parse(invoice.evidence || "{}") as { po?: string; delivery?: string };
    const byChecker = said.actor === "checker";
    body = (
      <>
        <div className="deal">
          <span className="pill"><Face biz={biz(invoice.debtor)} small />{biz(invoice.debtor).name}</span>
          <span className="arrow">owes</span>
          <span className="pill"><Face biz={biz(invoice.creditor)} small />{biz(invoice.creditor).name}</span>
          <strong>{usd0(invoice.amount)}</strong>
          <span className="tag">{invoice.number}</span>
        </div>
        <div className={`turn turn-left said-${said.kind}`}>
          <span className="face face-check" aria-hidden="true">{byChecker ? "✓?" : initialsOf(biz(said.actor).name)}</span>
          <div className="bubble">
            <p className="who">{byChecker ? "Paperwork check" : `${biz(said.actor).name}'s agent`}<b>{VERDICT[said.kind]}</b></p>
            <p>{said.text.replace(/^(Held back|Holding back) [^:]+: /, "")}</p>
            {byChecker
              ? <details><summary>The paperwork it read</summary><blockquote>{evidence.po}</blockquote><blockquote>{evidence.delivery}</blockquote></details>
              : <details><summary>What its owner told it</summary><blockquote>{biz(said.actor).notes}</blockquote></details>}
          </div>
        </div>
        <p className="outcome is-no">Kept out of the round for a person to look at</p>
      </>
    );
  } else if (focus.step.kind === "loop") {
    const path = (JSON.parse(focus.step.path) as string[]).map(biz);
    body = (
      <>
        <div className="loop">
          {[...path, path[0]].map((b, i) => (
            <span key={i} className="loop-node">{i > 0 && <span className="arrow">owes</span>}<span className="pill"><Face biz={b} small />{b.name}</span></span>
          ))}
        </div>
        <p className="outcome is-yes">{usd(focus.step.amount)} cancelled from each debt</p>
        <p className="code-note"><span className="by by-code">Plain code, no AI</span>Nobody ends up better or worse off, so there is nothing for an agent to judge.</p>
      </>
    );
  } else {
    const [from, via, to] = (JSON.parse(focus.step.path) as string[]).map(biz);
    const creditorSaid = focus.events.find((e) => e.actor === to.id);
    const payerSaid = focus.events.find((e) => e.actor === from.id);
    const agreed = focus.events.some((e) => e.kind === "redirect");
    const refused = focus.events.some((e) => e.kind === "nodeal");
    body = (
      <>
        <div className="deal">
          <span className="pill"><Face biz={from} small />{from.name}</span>
          <span className="arrow">pays</span>
          <span className="pill"><Face biz={to} small />{to.name}</span>
          <strong>{usd0(focus.step.amount)}</strong>
          <span className="tag tag-out">{via.name} drops out</span>
        </div>
        <Turn biz={to} event={creditorSaid} side="left" rule={to.policy} ruleLabel="What its owner told it" />
        {(creditorSaid?.kind === "counter" || payerSaid) && <Turn biz={from} event={payerSaid} side="right" rule={from.policy} ruleLabel="What its owner told it" />}
        {agreed && <p className="outcome is-yes">Deal. One debt gone from the chain</p>}
        {refused && <p className="outcome is-no">No deal. Trying another route</p>}
      </>
    );
  }

  return (
    <section className="card agents">
      <div className="agents-head">
        <h2>{showAll ? "The six agents" : "Agents at work"}</h2>
        {agents === "scripted" && <span className="chip">Fixed rules, not Claude</span>}
        {focus && (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={!showAll} onClick={() => setTab("focus")}>Live</button>
            <button role="tab" aria-selected={showAll} onClick={() => setTab("all")}>All agents</button>
          </div>
        )}
      </div>
      {body}
    </section>
  );
}
