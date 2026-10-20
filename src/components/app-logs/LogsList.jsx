import React from "react";
import { AlertCircle, CheckCircle2, Loader2, Ban } from "lucide-react";

const STATUS = {
  ok: { icon: CheckCircle2, cls: "text-emerald-600" },
  error: { icon: AlertCircle, cls: "text-destructive" },
  running: { icon: Loader2, cls: "text-muted-foreground" },
  cancelled: { icon: Ban, cls: "text-muted-foreground" },
};

const fmtTime = (at) => { try { return new Date(at).toLocaleString(); } catch { return String(at); } };

export default function LogsList({ events, loading, selected, onSelect, hasMore }) {
  if (loading && !events.length) {
    return <div className="py-16 flex justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  if (!events.length) {
    return <div className="py-16 text-center text-[13px] text-muted-foreground">No events match these filters.</div>;
  }
  return (
    <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
      {events.map((ev) => {
        const S = STATUS[ev.status] || STATUS.ok;
        const Icon = S.icon;
        const isSel = selected && selected.id === ev.id && selected.source === ev.source;
        return (
          <button
            key={ev.source + ":" + ev.id}
            onClick={() => onSelect(ev)}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left text-[12px] hover:bg-muted/60 transition-colors ${isSel ? "bg-muted" : ""}`}
          >
            <Icon className={`h-3.5 w-3.5 shrink-0 ${S.cls} ${ev.status === "running" ? "animate-spin" : ""}`} />
            <span className="shrink-0 w-[150px] truncate text-muted-foreground">{fmtTime(ev.at)}</span>
            <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">{ev.event_type}</span>
            <span className="flex-1 truncate">{ev.name}</span>
            {ev.duration_ms != null && <span className="shrink-0 text-muted-foreground">{Math.round(ev.duration_ms)}ms</span>}
          </button>
        );
      })}
      {hasMore && <div className="px-3 py-2 text-[11px] text-muted-foreground bg-muted/30">More events exist beyond this page.</div>}
    </div>
  );
}