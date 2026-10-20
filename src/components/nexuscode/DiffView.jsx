import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { lineDiff } from "@/lib/lineDiff";
import { ArrowLeft, Loader2 } from "lucide-react";

// Per-file before/after line diff: the server returns both file contents (bounded) and the
// client computes the LCS diff locally.
export default function DiffView({ sessionId, path, onClose }) {
  const [lines, setLines] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLines(null);
    setError(null);
    base44.functions.invoke("nexusCode", { action: "diff_file", session_id: sessionId, path })
      .then((r) => { if (alive) setLines(lineDiff(r.data?.before || "", r.data?.after || "")); })
      .catch((e) => { if (alive) setError(e.response?.data?.error || e.message); });
    return () => { alive = false; };
  }, [sessionId, path]);

  return (
    <div className="h-full flex flex-col">
      <div className="h-9 shrink-0 border-b border-border flex items-center gap-2 px-3">
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" title="Back to changes">
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="font-mono text-[12px] truncate">{path}</span>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin font-mono text-[12px] leading-5">
        {error && <p className="p-3 text-destructive text-[12px]">{error}</p>}
        {!lines && !error && (
          <div className="grid place-items-center h-24"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        )}
        {lines && lines.map((l, i) => (
          <div key={i} className={`flex ${l.type === "add" ? "bg-emerald-500/10" : l.type === "del" ? "bg-destructive/10" : ""}`}>
            <span className="w-4 shrink-0 text-center select-none">{l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</span>
            <span className="whitespace-pre-wrap pr-4">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}