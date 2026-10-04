import type { Business } from "./types.ts";
import { usd0 } from "./types.ts";

export type Debt = { debtor: string; creditor: string; amount: number; kind: "owed" | "redirected" | "held"; note?: string };

const W = 760, H = 560, CX = W / 2, CY = H / 2, RX = 268, RY = 200;
const BOX_W = 148, BOX_H = 56;

// Where a line leaving the centre of a business's box in direction (dx, dy) crosses the box edge.
function edgeOfBox(cx: number, cy: number, dx: number, dy: number) {
  const t = Math.min(dx === 0 ? Infinity : (BOX_W / 2 + 5) / Math.abs(dx), dy === 0 ? Infinity : (BOX_H / 2 + 5) / Math.abs(dy));
  return [cx + dx * t, cy + dy * t];
}

export function Graph({ businesses, debts, net, hot, scale }: {
  businesses: Business[]; debts: Debt[]; net: Map<string, number>; hot: Set<string>; scale: number;
}) {
  const at = new Map(businesses.map((b, i) => {
    const a = (-90 + (i * 360) / businesses.length) * (Math.PI / 180);
    return [b.id, [CX + RX * Math.cos(a), CY + RY * Math.sin(a)] as const];
  }));

  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Who owes whom">
      <defs>
        {(["owed", "redirected", "held", "hot"] as const).map((k) => (
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
      {businesses.map((b) => {
        const [x, y] = at.get(b.id)!;
        const n = net.get(b.id) ?? 0;
        return (
          <g key={b.id} className="biz" transform={`translate(${x - BOX_W / 2} ${y - BOX_H / 2})`}>
            <rect width={BOX_W} height={BOX_H} />
            <text className="biz-name" x={BOX_W / 2} y={23}>{b.name}</text>
            <text className={`biz-net ${n < 0 ? "is-owing" : ""}`} x={BOX_W / 2} y={42}>
              {n === 0 ? "even" : n < 0 ? `owes ${usd0(-n)} net` : `is owed ${usd0(n)} net`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
