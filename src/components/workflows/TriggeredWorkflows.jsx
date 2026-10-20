import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Ban, RotateCcw, AlertCircle, Search } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { formatDistanceToNow } from "date-fns";
import WorkflowCard from "@/components/builder/WorkflowCard";

// Triggered Workflows tab — the EXISTING certified WorkflowDefinition surface (the workflows
// endpoint + WorkflowCard), re-projected with discovery controls. Every action (trigger,
// trigger edit, validate, finalize, cancel, retry) is the existing authorized API; nothing new
// is invented here and no new workflow type is introduced.
const RUN_ACTIVE = /PEND|RUN|WAIT|START|QUEUED|ACTIVE|PAUSED/i;
const RUN_FAILED = /FAIL|CANCEL|TIMEOUT/i;
const TERMINAL_RE = /SUCCEED|COMPLETE|FAIL|CANCEL|TIMEOUT|SUPERSEDED/i;

// Triggered-workflow statuses map to definition lifecycle, not the schedule lifecycle.
const TRIGGERED_FILTERS = [
  { key: "all", label: "All" },
  { key: "finalized", label: "Finalized" },
  { key: "draft", label: "Draft" },
  { key: "superseded", label: "Superseded" },
];
const statusKeyOf = (w) => (["FINALIZED", "DRAFT", "SUPERSEDED"].includes(w.status) ? w.status.toLowerCase() : "all");

export default function TriggeredWorkflows({ projectId, reloadKey, onEmpty }) {
  const [workflows, setWorkflows] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);
  const [reports, setReports] = useState({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [defs, recent] = await Promise.all([
        base44.functions.invoke("workflows", { action: "list", project_id: projectId }),
        base44.functions.invoke("workflows", { action: "runs", project_id: projectId, limit: 30 }),
      ]);
      const list = defs.data.workflows || [];
      setWorkflows(list);
      setRuns(recent.data.runs || []);
      setError(null);
      if (onEmpty) onEmpty(list.length === 0);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load, reloadKey]);
  // Poll only while a run is in flight, exactly like the Logic pane does.
  useEffect(() => {
    if (!runs.some((r) => !TERMINAL_RE.test(r.status || ""))) return;
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [runs, load]);

  const act = async (label, payload) => {
    setWorking(true);
    try {
      await base44.functions.invoke("workflows", { project_id: projectId, ...payload });
      toast({ title: label });
      await load();
      return true;
    } catch (e) {
      toast({ variant: "destructive", title: "Action failed", description: e.response?.data?.error || e.message });
      return false;
    } finally {
      setWorking(false);
    }
  };

  const onTrigger = (w) => act(`Triggered ${w.name}`, { action: "trigger", workflow_definition_id: w.workflow_definition_id });
  const onSaveTrigger = (w, trigger) => act(`${w.name}: trigger updated`, { action: "update", workflow_definition_id: w.workflow_definition_id, trigger });
  const onFinalize = (w) => act(`${w.name} finalized — it can now run`, { action: "finalize", workflow_definition_id: w.workflow_definition_id });
  const onValidate = async (w) => {
    try {
      const res = await base44.functions.invoke("workflows", { project_id: projectId, action: "validate", workflow_definition_id: w.workflow_definition_id });
      setReports((r) => ({ ...r, [w.workflow_definition_id]: res.data }));
    } catch (e) {
      toast({ variant: "destructive", title: "Validation failed", description: e.response?.data?.error || e.message });
    }
  };

  // Discovery: client-side search over existing definition fields.
  const q = query.trim().toLowerCase();
  const visible = (workflows || []).filter((w) =>
    (statusFilter === "all" || statusKeyOf(w) === statusFilter) &&
    (!q || [w.name, w.description, w.workflow_key, w.trigger_type, w.trigger_event]
      .some((v) => String(v || "").toLowerCase().includes(q))));

  const defById = Object.fromEntries((workflows || []).map((d) => [d.workflow_definition_id, d]));

  return (
    <div>
      {/* Discovery controls */}
      {workflows && workflows.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <div className="relative min-w-40 flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workflows…"
              aria-label="Search workflows"
              className="w-full rounded-md border border-border bg-background pl-7 pr-2 py-1 text-[11.5px] outline-none focus:ring-1 ring-ring"
            />
          </div>
          <div className="flex items-center gap-1">
            {TRIGGERED_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusFilter(f.key)}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${statusFilter === f.key ? "bg-foreground text-background" : "border border-border text-muted-foreground hover:text-foreground"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="text-[12px]">{error}</div>
        </div>
      ) : !workflows ? (
        <div className="rounded-md border border-border p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
      ) : workflows.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted-foreground/60">No triggered workflows yet.</div>
      ) : visible.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted-foreground/60">No workflows match the current filters.</div>
      ) : (
        <div className="space-y-2.5">
          {visible.map((w) => (
            <WorkflowCard
              key={w.workflow_definition_id}
              workflow={w}
              working={working}
              report={reports[w.workflow_definition_id]}
              onTrigger={onTrigger}
              onSaveTrigger={onSaveTrigger}
              onValidate={onValidate}
              onFinalize={onFinalize}
            />
          ))}
        </div>
      )}

      {/* Execution history — the same runs list and actions the Logic pane shows */}
      {runs.length > 0 && (
        <div className="mt-4">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Execution history</h3>
          <div className="mt-2 rounded-md border border-border divide-y divide-border">
            {runs.map((r) => {
              const runId = r.workflow_run_id || r.id;
              const def = defById[r.workflow_id];
              const active = RUN_ACTIVE.test(r.status || "");
              const failed = RUN_FAILED.test(r.status || "");
              return (
                <div key={runId} className="px-3 py-2 text-[12px]">
                  <div className="flex items-center gap-2">
                    {active ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : failed ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                    <span className="truncate min-w-0 max-w-[220px]">{def?.name || r.workflow_key || "Workflow"}</span>
                    <span className="font-mono text-[11px] text-muted-foreground/70">{r.status}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground/60 whitespace-nowrap">{formatDistanceToNow(new Date(r.started_at || r.created_date), { addSuffix: true })}</span>
                    {active && (
                      <button onClick={() => act("Cancellation requested", { action: "cancel", workflow_run_id: runId })} disabled={working} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-destructive disabled:opacity-50 transition-colors">
                        <Ban className="h-3 w-3" />Cancel
                      </button>
                    )}
                    {!active && failed && (
                      <button onClick={() => act("Retry started", { action: "retry", workflow_run_id: runId })} disabled={working} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors">
                        <RotateCcw className="h-3 w-3" />Retry
                      </button>
                    )}
                  </div>
                  {r.error && <p className="mt-1 font-mono text-[11px] text-destructive truncate">{r.error}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}