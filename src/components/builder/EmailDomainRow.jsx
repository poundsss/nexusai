import React, { useState } from "react";
import { CheckCircle2, Clock, Loader2, RefreshCw, Trash2, XCircle } from "lucide-react";
import EmailDomainForm from "@/components/builder/EmailDomainForm";

// One email-domain row, rendered VERBATIM from the certified emailDomain surface: the status
// string and dns_records (name/type/value/ttl) are shown exactly as the API returned them —
// active is the only state that sends mail, pending and failed states are never invented here.
export default function EmailDomainRow({ domain: d, working, onRecheck, onReplace, onDisable }) {
  const [replacing, setReplacing] = useState(false);
  const failed = String(d.status || "").startsWith("failed");
  const active = d.status === "active";
  const tone = active ? "bg-emerald-500/10 text-emerald-600" : failed ? "bg-red-500/10 text-red-600" : "bg-amber-500/10 text-amber-600";
  const Icon = active ? CheckCircle2 : failed ? XCircle : Clock;

  const records = Array.isArray(d.dns_records) ? d.dns_records : [];

  return (
    <div className={`rounded-md border p-2.5 transition-colors ${active ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"}`}>
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${tone}`}>
          <Icon className="h-3 w-3" />{d.status || "unknown"}
        </span>
        <span className="truncate font-mono text-[12px] text-foreground">{d.domain}</span>
        {active && d.from_email && (
          <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
            {d.sender_name ? `${d.sender_name} <${d.from_email}>` : d.from_email}
          </span>
        )}
      </div>

      {records.length > 0 && (
        <div className="mt-2 rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,0.6fr)_minmax(0,0.5fr)_minmax(0,3fr)] gap-2">
            <span className="font-medium">name</span><span>type</span><span>ttl</span><span className="font-medium">value</span>
            {records.map((r, i) => (
              <React.Fragment key={r.name || i}>
                <span className="break-all text-foreground">{r.name}</span>
                <span>{r.type}</span>
                <span>{r.ttl ?? "—"}</span>
                <span className="break-all text-foreground">{r.value}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
      {d.last_check && <p className="mt-1 text-[11px] text-muted-foreground/60">last check {new Date(d.last_check).toLocaleString()}</p>}

      <div className="mt-1.5 flex items-center gap-3 text-[11px]">
        {replacing ? (
          <EmailDomainForm
            initial={{ domain: d.domain, sender_name: d.sender_name || "", prefix: String(d.from_email || "").split("@")[0] }}
            working={working}
            submitLabel="Replace"
            onSubmit={async (dom, name, prefix) => { await onReplace(dom, name, prefix); setReplacing(false); }}
            onCancel={() => setReplacing(false)}
          />
        ) : (
          <>
            <button onClick={() => onRecheck(d.domain)} disabled={working} className="ml-auto inline-flex items-center gap-1 text-foreground underline hover:text-foreground/80 transition-colors disabled:opacity-50">
              {working && <Loader2 className="h-3 w-3 animate-spin" />}<RefreshCw className="h-3 w-3" />Recheck
            </button>
            <button onClick={() => setReplacing(true)} disabled={working} className="text-foreground underline hover:text-foreground/80 transition-colors disabled:opacity-50">Replace</button>
            <button onClick={() => onDisable(d.domain)} disabled={working} className="text-destructive hover:text-destructive/80 transition-colors disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>
          </>
        )}
      </div>
    </div>
  );
}