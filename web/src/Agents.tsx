// Shows the decision behind the latest entry: what the agent was told, and what it decided.
import { useState } from "react";
import type { Business, Event, Invoice, Step } from "./types.ts";
import { usd } from "./types.ts";

export type Focus =
  | { kind: "invoice"; invoice: Invoice; events: Event[] }
  | { kind: "step"; step: Step; events: Event[] }
  | null;

const ANSWER: Record<string, string> = { accept: "Accepts", counter: "Accepts on a condition", reject: "Refuses", dispute: "Holds it back", hold: "Held back" };

function Told({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="told"><span>{label}</span><blockquote>{children}</blockquote></div>;
}

function Voice({ biz, event, told, toldLabel }: { biz: Business; event: Event | undefined; told: string; toldLabel: string }) {
  return (
    <div className={`voice ${event ? `said-${event.kind}` : "is-thinking"}`}>
      <h4>{biz.name}'s agent</h4>
      <Told label={toldLabel}>{told}</Told>
      <div className="said">
        <span>{event ? ANSWER[event.kind] ?? "Answers" : "Deciding…"}</span>
        {event && <p>{event.text}</p>}
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
      <>
        <p className="lead">Each business has one agent. It acts only on what its owner wrote, in plain English:</p>
        <ul className="roster">
          {businesses.map((b) => (
            <li key={b.id}>
              <h4>{b.name} <span>{b.trade}, pays {b.on_time_pct}% of invoices on time</span></h4>
              <blockquote>{b.policy}</blockquote>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (focus.kind === "invoice") {
    const { invoice, events } = focus;
    const said = events.at(-1)!;
    const evidence = JSON.parse(invoice.evidence || "{}") as { po?: string; delivery?: string };
    const byChecker = said.actor === "checker";
    body = (
      <>
        <p className="lead">
          Invoice {invoice.number}, {usd(invoice.amount)}, from {biz(invoice.creditor).name} to {biz(invoice.debtor).name}.
        </p>
        <div className={`voice said-${said.kind}`}>
          <h4>{byChecker ? "Paperwork check" : `${biz(said.actor).name}'s agent`}</h4>
          {byChecker ? (
            <>
              <Told label="Purchase order it read">{evidence.po}</Told>
              <Told label="Delivery record it read">{evidence.delivery}</Told>
            </>
          ) : (
            <Told label="What the owner told it">{biz(said.actor).notes}</Told>
          )}
          <div className="said"><span>{ANSWER[said.kind]}</span><p>{said.text}</p></div>
        </div>
        <p className="outcome is-no">This invoice stays out of the round and is left for a person to look at.</p>
      </>
    );
  } else if (focus.step.kind === "loop") {
    const path = JSON.parse(focus.step.path) as string[];
    body = (
      <>
        <p className="lead">{path.map((id) => biz(id).name).join(" owes ")} owes {biz(path[0]).name}.</p>
        <div className="voice said-code">
          <h4>Plain code, no agent</h4>
          <div className="said"><span>Cancelled {usd(focus.step.amount)} from each debt</span>
            <p>Everyone in the loop owes and is owed the same amount less, so nobody ends up better or worse off. There is nothing to judge, so no model is asked.</p>
          </div>
        </div>
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
        <p className="lead">
          Proposed shortcut: {from.name} pays {to.name} {usd(focus.step.amount)} directly, and {via.name} drops out.
          That changes who {to.name} is relying on, so its agent decides.
        </p>
        <Voice biz={to} event={creditorSaid} told={to.policy} toldLabel="What its owner told it" />
        {(creditorSaid?.kind === "counter" || payerSaid) && <Voice biz={from} event={payerSaid} told={from.policy} toldLabel="What its owner told it" />}
        {agreed && <p className="outcome is-yes">Agreed. One debt is gone from the chain.</p>}
        {refused && <p className="outcome is-no">No deal. OFFSET looks for another route.</p>}
      </>
    );
  }

  return (
    <section className="card agents">
      <div className="agents-head">
        <h2>{showAll ? "The agents" : "The decision being made"}</h2>
        {agents === "scripted" && <span className="chip">Fixed rules standing in for Claude</span>}
        {focus && (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={!showAll} onClick={() => setTab("focus")}>This decision</button>
            <button role="tab" aria-selected={showAll} onClick={() => setTab("all")}>All six agents</button>
          </div>
        )}
      </div>
      {body}
    </section>
  );
}
