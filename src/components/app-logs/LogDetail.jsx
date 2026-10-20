import React, { useState } from "react";
import { Loader2 } from "lucide-react";

function Tab({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={`px-3 py-1.5 text-[12px] font-medium border-b-2 ${active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
      {children}
    </button>
  );
}

export default function LogDetail({ selected, detail, detailLoading }) {
  const [tab, setTab] = useState("details");
  if (!selected) {
    return <div className="py-16 text-center text-[13px] text-muted-foreground">Select an event to inspect its details.</div>;
  }
  if (detail?.error) {
    return <div className="border border-border rounded-lg p-3 text-[12px] text-destructive">{detail.error}</div>;
  }
  const ev = detail?.event || selected;
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-muted/30">
        <div className="text-[13px] font-semibold truncate">{ev.name}</div>
        <div className="text-[11px] text-muted-foreground">{ev.event_type} · {ev.source}</div>
      </div>
      <div className="flex border-b border-border px-2">
        <Tab active={tab === "details"} onClick={() => setTab("details")}>Details</Tab>
        <Tab active={tab === "outputs"} onClick={() => setTab("outputs")}>Outputs</Tab>
        <Tab active={tab === "error"} onClick={() => setTab("error")}>Error</Tab>
      </div>
      <div className="p-3 text-[12px] space-y-3 max-h-[60vh] overflow-y-auto scrollbar-thin">
        {detailLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            {tab === "details" && <DetailsView ev={ev} detail={detail} />}
            {tab === "outputs" && <OutputsView detail={detail} />}
            {tab === "error" && <ErrorView ev={ev} detail={detail} />}
          </>
        )}
      </div>
    </div>
  );
}

function DetailsView({ ev, detail }) {
  const meta = ev.metadata || {};
  const rows = Object.entries({
    trace_id: ev.trace_id, reference_id: ev.reference_id, user_id: ev.user_id,
    action: ev.action, resource: ev.resource, resource_id: ev.resource_id, duration_ms: ev.duration_ms,
  }).filter(([, v]) => v != null && v !== "");
  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <dl className="grid grid-cols-[120px_1fr] gap-y-1">
          {rows.map(([k, v]) => (
            <React.Fragment key={k}>
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono break-all">{String(v)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {detail?.spans?.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Trace spans ({detail.spans.length})</div>
          <div className="space-y-1">
            {detail.spans.map((s) => (
              <div key={s.id} className="flex gap-2 text-[11px]">
                <span className={`h-2 w-2 mt-1 rounded-full shrink-0 ${s.status === "error" ? "bg-destructive" : "bg-emerald-500"}`} />
                <span className="truncate">{s.event_type}: {s.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {Object.keys(meta).length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Metadata</div>
          <pre className="text-[11px] font-mono bg-muted/40 rounded p-2 overflow-x-auto scrollbar-thin">{JSON.stringify(meta, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function OutputsView({ detail }) {
  const invs = detail?.invocations || (detail?.invocation ? [detail.invocation] : []);
  if (!invs.length) return <div className="text-muted-foreground">No function output recorded for this event.</div>;
  return (
    <div className="space-y-3">
      {invs.map((inv) => (
        <div key={inv.id} className="space-y-1.5">
          <div className="font-mono text-[11px] text-muted-foreground">
            {inv.function_name} · {inv.trigger} · {inv.status ?? "—"} · {inv.duration_ms ?? "—"}ms
          </div>
          {inv.logs?.length > 0 && (
            <pre className="text-[11px] font-mono bg-muted/40 rounded p-2 overflow-x-auto scrollbar-thin max-h-40">{inv.logs.join("\n")}</pre>
          )}
          {inv.external_calls?.length > 0 && (
            <div className="text-[11px] space-y-0.5">
              {inv.external_calls.map((c, i) => (
                <div key={i} className="font-mono">{c.method} {c.host} → {c.status} ({c.duration_ms}ms)</div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ErrorView({ ev, detail }) {
  const inv = detail?.invocation;
  const code = ev.error_code || inv?.error_class;
  const msg = ev.error_message || inv?.error_message;
  if (!code && !msg) return <div className="text-muted-foreground">No error recorded for this event.</div>;
  return (
    <div className="space-y-2">
      {code && <div><span className="text-muted-foreground">Code: </span><span className="font-mono">{code}</span></div>}
      {msg && <pre className="text-[11px] font-mono bg-destructive/10 text-destructive rounded p-2 whitespace-pre-wrap">{msg}</pre>}
    </div>
  );
}