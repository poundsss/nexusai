import React, { useState } from "react";
import { Zap, Clock, Radio, Play, Loader2, ChevronRight, CheckCircle2, AlertCircle, Save, ShieldCheck, Webhook } from "lucide-react";
import ConnectorTriggerFields from "@/components/workflows/ConnectorTriggerFields";

const TRIGGERS = [
  { id: "manual", label: "Manual", icon: Zap },
  { id: "schedule", label: "Scheduled", icon: Clock },
  { id: "event", label: "Event", icon: Radio },
  { id: "connector", label: "Connector", icon: Webhook },
];
const STATUS_STYLE = {
  FINALIZED: "bg-emerald-500/10 text-emerald-600",
  DRAFT: "bg-amber-500/10 text-amber-600",
  SUPERSEDED: "bg-muted text-muted-foreground",
};

// One workflow: identity on the row, the detail surface underneath — steps, trigger
// management, validation and finalization. Editing a FINALIZED version creates the next
// DRAFT of its lineage (the API never rewrites what existing runs execute).
export default function WorkflowCard({ workflow: w, working, report, onTrigger, onSaveTrigger, onValidate, onFinalize }) {
  const [open, setOpen] = useState(false);
  const [tType, setTType] = useState(w.trigger_type || "manual");
  const [tConnector, setTConnector] = useState(w.trigger?.connector || "");
  const [tEvent, setTEvent] = useState(w.trigger_event || "");
  const [tCondition, setTCondition] = useState(w.trigger?.condition || "");
  const [tCron, setTCron] = useState(w.trigger?.cron || "");
  const [tFn, setTFn] = useState(w.trigger?.function_name || "");
  const dirty = tType !== (w.trigger_type || "manual") || tConnector !== (w.trigger?.connector || "") || tEvent !== (w.trigger_event || "") || tCondition !== (w.trigger?.condition || "") || tCron !== (w.trigger?.cron || "") || tFn !== (w.trigger?.function_name || "");
  const runnable = w.status === "FINALIZED";
  const TriggerIcon = (TRIGGERS.find((t) => t.id === tType) || TRIGGERS[0]).icon;
  const stepCount = (w.steps || []).length;

  const saveTrigger = () => {
    const trigger = { type: tType };
    if (tType === "connector") {
      if (tConnector.trim()) trigger.connector = tConnector.trim();
      if (tEvent.trim()) trigger.event = tEvent.trim();
      // DOCUMENTED (Base44): slack/slackbot connector automations REQUIRE a trigger condition —
      // sent only when the user typed one; finalization enforces it.
      if ((tConnector === "slack" || tConnector === "slackbot") && tCondition.trim()) {
        trigger.condition = tCondition.trim();
      }
    }
    if (tType === "event" && tEvent.trim()) trigger.event = tEvent.trim();
    if (tType === "schedule") {
      if (tCron.trim()) trigger.cron = tCron.trim();
      if (tFn.trim()) trigger.function_name = tFn.trim();
    }
    onSaveTrigger(w, trigger);
  };

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-2 p-3">
        <button
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label={open ? "Collapse workflow" : "Expand workflow"}
        >
          <ChevronRight className={"h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform " + (open ? "rotate-90" : "")} />
          <span className="truncate font-medium text-[13px]">{w.name}</span>
          <span className={"shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold " + (STATUS_STYLE[w.status] || "bg-muted text-muted-foreground")}>{w.status}</span>
        </button>
        <span className="flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          <TriggerIcon className="h-3 w-3" />
          {tType}
          {tType === "connector" && w.trigger?.connector ? " · " + w.trigger.connector : ""}
          {w.trigger_event ? " · " + w.trigger_event : ""}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground/60">{"v" + w.version + " · " + stepCount + (stepCount === 1 ? " step" : " steps")}</span>
        <button
          onClick={() => onTrigger(w)}
          disabled={!runnable || working}
          title={runnable ? "Run this workflow now" : "Only a FINALIZED version can run"}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium hover:bg-muted disabled:opacity-40 transition-colors"
        >
          {working ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Run
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border p-3">
          {w.description && <p className="text-[12px] text-muted-foreground">{w.description}</p>}

          {/* Steps */}
          <div>
            <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Steps</h4>
            {stepCount === 0 ? (
              <p className="text-[12px] text-muted-foreground/60">No steps yet — the workflow cannot finalize without at least one.</p>
            ) : (
              <ol className="space-y-1">
                {(w.steps || []).map((s, i) => (
                  <li key={i} className="flex items-center gap-2 text-[12px]">
                    <span className="w-4 font-mono text-[10px] text-muted-foreground/50">{i + 1}</span>
                    <span className="truncate font-medium">{s.name || s.type}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{s.type + (s.function_name ? " · " + s.function_name : "")}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Trigger management — routes through the authorized update action */}
          <div>
            <h4 className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">Trigger</h4>
            <div className="flex flex-wrap items-center gap-1.5">
              <select value={tType} onChange={(e) => setTType(e.target.value)} aria-label="Trigger type" className="rounded-md border border-border bg-background px-2 py-1 text-[11.5px]">
                {TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
              {tType === "connector" && (
                <ConnectorTriggerFields connector={tConnector} event={tEvent} condition={tCondition} onCondition={setTCondition} onConnector={setTConnector} onEvent={setTEvent} />
              )}
              {tType === "event" && (
                <input value={tEvent} onChange={(e) => setTEvent(e.target.value)} placeholder="event name, e.g. order.created" className="min-w-[180px] flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] outline-none focus:ring-1 ring-ring" />
              )}
              {tType === "schedule" && (
                <>
                  <input value={tCron} onChange={(e) => setTCron(e.target.value)} placeholder="cron expression" className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11.5px] outline-none focus:ring-1 ring-ring" />
                  <input value={tFn} onChange={(e) => setTFn(e.target.value)} placeholder="function name" className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11.5px] outline-none focus:ring-1 ring-ring" />
                </>
              )}
              <button onClick={saveTrigger} disabled={!dirty || working} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium hover:bg-muted disabled:opacity-40 transition-colors">
                <Save className="h-3 w-3" />
                Save trigger
              </button>
              {w.status !== "DRAFT" && dirty && <span className="text-[10.5px] text-muted-foreground/60">saving creates the next draft version</span>}
            </div>
          </div>

          {/* Validation report */}
          {report && (
            <div className={"rounded-md p-2 text-[11.5px] " + (report.ok ? "bg-emerald-500/5 text-emerald-600" : "bg-destructive/5 text-destructive")}>
              <span className="flex items-center gap-1.5 font-medium">
                {report.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
                {report.ok ? "Validation passed — this workflow can finalize" : (report.errors || []).length + " problem(s) before it can finalize"}
              </span>
              {(report.errors || []).slice(0, 5).map((e, i) => <p key={i} className="mt-0.5">{e}</p>)}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button onClick={() => onValidate(w)} disabled={working} className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11.5px] font-medium hover:bg-muted disabled:opacity-40 transition-colors">
              <ShieldCheck className="h-3 w-3" />
              Validate
            </button>
            {w.status === "DRAFT" && (
              <button onClick={() => onFinalize(w)} disabled={working} className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors">
                Finalize
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}