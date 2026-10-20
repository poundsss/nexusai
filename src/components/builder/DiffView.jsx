import React from "react";
import { lineDiff } from "@/lib/lineDiff";

export default function DiffView({ before, after }) {
  const rows = lineDiff(before, after).filter((r, i, arr) => r.type !== "same" || arr.slice(Math.max(0, i - 2), i + 3).some((x) => x.type !== "same"));
  return (
    <pre className="max-h-72 overflow-auto rounded border border-border bg-background text-[11px] leading-[18px] font-mono">
      {rows.map((r, i) => (
        <div key={i} className={`px-3 whitespace-pre ${r.type === "add" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : r.type === "del" ? "bg-destructive/10 text-destructive" : "text-muted-foreground"}`}>
          <span className="inline-block w-4 select-none">{r.type === "add" ? "+" : r.type === "del" ? "-" : " "}</span>{r.text}
        </div>
      ))}
      {rows.length === 0 && <div className="px-3 py-2 text-muted-foreground/60">No textual changes</div>}
    </pre>
  );
}