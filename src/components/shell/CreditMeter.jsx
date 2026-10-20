import React from "react";

// One credit row: label, used/limit and a progress bar. A limit the platform does not define
// renders as "no limit" with no bar — never as a fabricated ceiling.
export default function CreditMeter({ label, used, limit }) {
  const known = typeof limit === "number" && limit > 0;
  const spent = typeof used === "number" ? used : null;
  const pct = known && spent !== null ? Math.min(100, Math.round((spent / limit) * 100)) : null;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-muted-foreground">{label}</span>
        <span className="text-[12px] font-medium tabular-nums">
          {spent === null ? "—" : spent.toLocaleString()}
          {known ? <span className="text-muted-foreground font-normal"> / {limit.toLocaleString()}</span> : <span className="text-muted-foreground font-normal"> · no limit</span>}
        </span>
      </div>
      {pct !== null && (
        <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}