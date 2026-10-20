import React from "react";

// One dense divided strip instead of a grid of oversized metric cards.
// items: [{ label, value, sub }]
export default function MetricRow({ items }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-border rounded-lg border border-border overflow-hidden">
      {items.map((it) => (
        <div key={it.label} className="px-4 py-3.5 min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground truncate">{it.label}</div>
          <div className="mt-1 text-[19px] font-semibold tabular-nums leading-none truncate">{it.value}</div>
          {it.sub && <div className="mt-1.5 text-[11px] text-muted-foreground truncate">{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}