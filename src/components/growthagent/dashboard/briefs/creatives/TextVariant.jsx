import React from "react";

const LIMIT = { HEADLINE: 30, DESCRIPTION: 90, LONG_HEADLINE: 90 };

// One copy variant: select checkbox + inline edit. "In brief" = persisted on the brief.
export default function TextVariant({ type, value, selected, inBrief, selectable, onToggle, onChange }) {
  const max = LIMIT[type] || 90;
  return (
    <li className="flex items-center gap-2 py-1">
      <input type="checkbox" disabled={!selectable} checked={selected} onChange={onToggle} className="h-3.5 w-3.5 shrink-0 accent-foreground" />
      <input value={value} maxLength={max} onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[12px] text-foreground" />
      <span className={`shrink-0 text-[10.5px] ${value.length > max ? "text-destructive" : "text-muted-foreground"}`}>{value.length}/{max}</span>
      {inBrief && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground">In brief</span>}
    </li>
  );
}