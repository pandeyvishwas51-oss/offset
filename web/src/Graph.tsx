import type { Business } from "./types.ts";
import { usd0 } from "./types.ts";

export type Debt = { debtor: string; creditor: string; amount: number; kind: "owed" | "redirected" | "held"; note?: string };

const W = 760, H = 580, CX = W / 2, CY = H / 2, RX = 268, RY = 196;
const BOX_W = 148, BOX_H = 56;

// Where a line leaving the centre of a business's box in direction (dx, dy) crosses the box edge.
function edgeOfBox(cx: number, cy: number, dx: number, dy: number) {
  const t = Math.min(dx === 0 ? Infinity : (BOX_W / 2 + 5) / Math.abs(dx), dy === 0 ? Infinity : (BOX_H / 2 + 5) / Math.abs(dy));
  return [cx + dx * t, cy + dy * t];
}

export type Proposal = { from: string; via: string; to: string; amount: number };

export type Bubble = { id: string; text: string; tone: "yes" | "no" | "maybe" };

export function Graph({ businesses, debts, net, hot, scale, speaking, proposal, bubbles }: {
  businesses: Business[]; debts: Debt[]; net: Map<string, number>; hot: Set<string>; scale: number;
  speaking: string | null; proposal: Proposal | null; bubbles: Bubble[];
}) {
  const at = new Map(businesses.map((b, i) => {
    const a = (-90 + (i * 360) / businesses.length) * (Math.PI / 180);
    return [b.id, [CX + RX * Math.cos(a), CY + RY * Math.sin(a)] as const];
  }));

  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Who owes whom">
      <defs>
        {(["owed", "redirected", "held", "hot", "proposed"] as const).map((k) => (
          <marker key={k} id={`tip-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M0 0 L10 5 L0 10 z" className={`tip tip-${k}`} />
          </marker>
        ))}
      </defs>
      {debts.map((d) => {
        const a = at.get(d.debtor), b = at.get(d.creditor);
        if (!a || !b) return null;
        const [mx, my] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const len = Math.hypot(dx, dy);
        const bow = d.kind === "held" ? 74 : 34; // curves to one side, so the two directions between a pair never overlap
        const [qx, qy] = [mx - (dy / len) * bow, my + (dx / len) * bow];
        const [sx, sy] = edgeOfBox(a[0], a[1], qx - a[0], qy - a[1]);
        const [ex, ey] = edgeOfBox(b[0], b[1], qx - b[0], qy - b[1]);
        // Labels sit a third of the way along, nearer the debtor: curves cross in the middle of the ring, labels there collide.
        const t = 0.3;
        const [lx, ly] = [(1 - t) ** 2 * sx + 2 * t * (1 - t) * qx + t * t * ex, (1 - t) ** 2 * sy + 2 * t * (1 - t) * qy + t * t * ey];
        const key = `${d.debtor}>${d.creditor}`;
        const isHot = hot.has(key) && d.kind !== "held";
        const gone = d.amount <= 0;
        return (
          <g key={`${key}:${d.kind}`} className={`debt debt-${d.kind}${isHot ? " is-hot" : ""}${gone ? " is-gone" : ""}`}>
            <path d={`M${sx} ${sy} Q${qx} ${qy} ${ex} ${ey}`} strokeWidth={gone ? 0 : 1.5 + 11 * Math.min(1, d.amount / scale)} markerEnd={`url(#tip-${isHot ? "hot" : d.kind})`}>
              {d.note && <title>{d.note}</title>}
            </path>
            <text x={lx} y={ly} dy="0.35em">{usd0(d.amount)}{d.kind === "held" ? " held" : ""}</text>
          </g>
        );
      })}
      {proposal && (() => {
        // The shortcut on the table, drawn dotted until the agents agree or refuse.
        const a = at.get(proposal.from)!, b = at.get(proposal.to)!;
        const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
        const len = Math.hypot(dx, dy);
        const [qx, qy] = [(a[0] + b[0]) / 2 + (dy / len) * 46, (a[1] + b[1]) / 2 - (dx / len) * 46];
        const [sx, sy] = edgeOfBox(a[0], a[1], qx - a[0], qy - a[1]);
        const [ex, ey] = edgeOfBox(b[0], b[1], qx - b[0], qy - b[1]);
        return (
          <g className="debt debt-proposed">
            <path d={`M${sx} ${sy} Q${qx} ${qy} ${ex} ${ey}`} strokeWidth={3} markerEnd="url(#tip-proposed)" />
            <text x={0.25 * sx + 0.5 * qx + 0.25 * ex} y={0.25 * sy + 0.5 * qy + 0.25 * ey} dy="0.35em">proposed {usd0(proposal.amount)}</text>
          </g>
        );
      })()}
      {businesses.map((b) => {
        const [x, y] = at.get(b.id)!;
        const n = net.get(b.id) ?? 0;
        const role = speaking === b.id ? " is-speaking" : proposal?.via === b.id ? " is-leaving" : proposal && (proposal.from === b.id || proposal.to === b.id) ? " is-party" : "";
        return (
          <g key={b.id} className={`biz${role}`} transform={`translate(${x - BOX_W / 2} ${y - BOX_H / 2})`}>
            <rect width={BOX_W} height={BOX_H} rx={14} />
            <text className="biz-name" x={BOX_W / 2} y={23}>{b.name}</text>
            <text className={`biz-net ${n < 0 ? "is-owing" : ""}`} x={BOX_W / 2} y={42}>
              {n === 0 ? "even" : n < 0 ? `owes ${usd0(-n)} net` : `is owed ${usd0(n)} net`}
            </text>
            <circle className="agent-dot" cx={BOX_W - 3} cy={3} r={7} />
          </g>
        );
      })}
      {bubbles.map((bubble) => {
        // What an agent just said, in two or three words, beside its business. Outside the ring, so it never covers a debt.
        const [x, y] = at.get(bubble.id)!;
        const w = bubble.text.length * 7.4 + 26;
        const above = y < CY;
        const by = above ? y - BOX_H / 2 - 36 : y + BOX_H / 2 + 10;
        return (
          <g key={bubble.id} className={`say say-${bubble.tone}`} transform={`translate(${Math.min(Math.max(x - w / 2, 4), W - w - 4)} ${by})`}>
            <rect width={w} height={26} rx={13} />
            <text x={w / 2} y={13} dy="0.36em">{bubble.text}</text>
          </g>
        );
      })}
    </svg>
  );
}
