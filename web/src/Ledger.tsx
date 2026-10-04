import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import type { State } from "./types.ts";
import { usd } from "./types.ts";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  backgroundColor: "#FFFFFF", foregroundColor: "#001435", headerBackgroundColor: "#F7F5F0", headerTextColor: "#001435",
  borderColor: "#E3E0DA", rowHoverColor: "#F0F6FF", accentColor: "#0070E0",
  fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 14, headerFontWeight: 700, wrapperBorderRadius: 0, borderRadius: 6, spacing: 8,
});

const money: Partial<ColDef> = { valueFormatter: (p) => (p.value == null ? "" : usd(p.value)), type: "rightAligned", cellClass: "num", width: 130 };
const WHAT: Record<string, string> = { setoff: "Set-off recorded on invoice", new_invoice: "New invoice for redirected debt", payout: "Payout to creditor" };
const LEG_STATUS: Record<string, string> = { pending: "Queued", sent: "Sent, waiting for PayPal", done: "Confirmed", failed: "Failed", reverted: "Reversed" };

export function Ledger({ state, log }: { state: State; log: { id: number; at: string; who: string; source: string; text: string }[] }) {
  const [tab, setTab] = useState<"invoices" | "written" | "heard" | "log">("invoices");
  const name = useMemo(() => new Map(state.businesses.map((b) => [b.id, b.name])), [state.businesses]);

  const tabs = [
    { id: "invoices" as const, label: `Invoices (${state.invoices.length})` },
    { id: "written" as const, label: `Written to PayPal (${state.legs.length})` },
    { id: "heard" as const, label: `Heard from PayPal (${state.received.length})` },
    { id: "log" as const, label: `Full log (${log.length})` },
  ];

  const invoiceCols: ColDef[] = [
    { field: "number", headerName: "Invoice", width: 110, pinned: "left" },
    { field: "debtor", headerName: "Owed by", valueFormatter: (p) => name.get(p.value) ?? p.value, width: 170 },
    { field: "creditor", headerName: "Owed to", valueFormatter: (p) => name.get(p.value) ?? p.value, width: 170 },
    { field: "memo", headerName: "For", flex: 1, minWidth: 200 },
    { field: "amount", headerName: "Invoiced", ...money },
    { field: "open", headerName: "Still owed", ...money },
    {
      headerName: "Status", flex: 1.4, minWidth: 220, tooltipField: "flag",
      valueGetter: (p) => ({ open: p.data.open < p.data.amount ? "Part settled" : "Open", settled: "Settled", held: `Held back: ${p.data.flag}`, disputed: `Disputed: ${p.data.flag}` })[p.data.status as string],
      cellClassRules: { "is-flagged": (p) => p.data.status === "held" || p.data.status === "disputed", "is-settled": (p) => p.data.status === "settled" },
    },
    { field: "due", headerName: "Due", width: 115 },
    { field: "paypal_id", headerName: "PayPal invoice ID", width: 230 },
  ];
  const writtenCols: ColDef[] = [
    { field: "round_id", headerName: "Round", width: 90 },
    { field: "kind", headerName: "What was written", valueFormatter: (p) => WHAT[p.value] ?? p.value, flex: 1, minWidth: 230 },
    { field: "invoice_id", headerName: "Invoice", width: 120 },
    { field: "amount", headerName: "Amount", ...money },
    { field: "status", headerName: "Result", valueFormatter: (p) => LEG_STATUS[p.value] ?? p.value, width: 210, cellClassRules: { "is-flagged": (p) => p.value === "failed", "is-settled": (p) => p.value === "done" } },
    { field: "ref", headerName: "PayPal reference", width: 240 },
    { field: "marker", headerName: "Retry-safe marker", width: 230 },
    { field: "error", headerName: "Problem", flex: 1, minWidth: 160 },
  ];
  const heardCols: ColDef[] = [
    { field: "at", headerName: "Received", valueFormatter: (p) => new Date(p.value).toLocaleTimeString(), width: 130 },
    { field: "business", headerName: "Business", valueFormatter: (p) => name.get(p.value) ?? p.value, width: 180 },
    { field: "type", headerName: "Event", flex: 1, minWidth: 260 },
    { field: "ref", headerName: "About", width: 140 },
    { field: "verified", headerName: "Check", width: 170 },
    { field: "outcome", headerName: "What we did", flex: 1, minWidth: 180 },
    { field: "id", headerName: "PayPal event ID", width: 260 },
  ];

  const logCols: ColDef[] = [
    { field: "at", headerName: "Time", valueFormatter: (p) => new Date(p.value).toLocaleTimeString(), width: 120 },
    { field: "who", headerName: "Who", width: 210 },
    { field: "source", headerName: "Decided by", width: 130 },
    { field: "text", headerName: "What happened", flex: 1, minWidth: 400, wrapText: true, autoHeight: true },
  ];

  const [rows, cols, empty] =
    tab === "invoices" ? [state.invoices, invoiceCols, "No invoices yet. Issue them to begin."]
    : tab === "log" ? [log, logCols, "Nothing yet. Clear the debts to watch the agents work."]
    : tab === "written" ? [state.legs, writtenCols, "Nothing written yet. Clear the debts and every entry made on PayPal is listed here."]
    : [state.received, heardCols, state.webhooks ? "No webhooks yet. They arrive after payments are sent." : "Webhooks are off because this server has no public address. Payments are confirmed by asking PayPal directly instead."];

  return (
    <section className="card ledger">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="grid">
        <AgGridReact key={tab} theme={theme} rowData={rows as object[]} columnDefs={cols} getRowId={(p) => String((p.data as { id: string | number }).id)}
          overlayNoRowsTemplate={`<span class="empty">${empty}</span>`} tooltipShowDelay={300} suppressCellFocus domLayout="normal" />
      </div>
    </section>
  );
}
