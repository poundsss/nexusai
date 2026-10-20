import React from "react";
import { CheckCircle2, Clock, Loader2, Star, Trash2 } from "lucide-react";

// A pending domain resolves to nothing until its TXT record is found, so the DNS record to
// publish stays visible until verification actually passes.
export default function DomainRow({ domain: d, working, onVerify, onSetPrimary, onRemove }) {
  const active = d.status === "active";
  return (
    <div className={`rounded-md border p-2.5 transition-colors ${active ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${active ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>
          {active ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}{active ? "active" : "pending"}
        </span>
        <span className="truncate font-mono text-[12px] text-foreground">{d.hostname}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{d.environment}</span>
        {d.is_primary && <span className="inline-flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground"><Star className="h-2.5 w-2.5" />primary</span>}
      </div>

      {!active && d.dns && (
        <div className="mt-2 rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">
          <div>{d.dns.type} {d.dns.name}</div>
          <div className="break-all text-foreground">{d.dns.value}</div>
        </div>
      )}
      {d.last_error && <p className="mt-1 text-[11px] text-destructive">{d.last_error}</p>}

      <div className="mt-1.5 flex items-center gap-3 text-[11px]">
        {d.last_checked_at && <span className="text-muted-foreground/60">checked {new Date(d.last_checked_at).toLocaleString()}</span>}
        <button onClick={() => onVerify(d.id)} disabled={working} className="ml-auto inline-flex items-center gap-1 text-foreground underline hover:text-foreground/80 transition-colors disabled:opacity-50">
          {working && <Loader2 className="h-3 w-3 animate-spin" />}{active ? "Re-check DNS" : "Verify DNS"}
        </button>
        {active && !d.is_primary && <button onClick={() => onSetPrimary(d.id)} disabled={working} className="text-foreground underline hover:text-foreground/80 transition-colors disabled:opacity-50">Make primary</button>}
        <button onClick={() => onRemove(d.id)} disabled={working} className="text-destructive hover:text-destructive/80 transition-colors disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}