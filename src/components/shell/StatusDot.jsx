import React from "react";

const TONE = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-rose-500",
  idle: "bg-muted-foreground/40",
};

// Neutral status marker: a dot plus a word, used instead of colored pill badges.
export default function StatusDot({ tone = "idle", label, className = "" }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${TONE[tone] || TONE.idle}`} />
      {label}
    </span>
  );
}