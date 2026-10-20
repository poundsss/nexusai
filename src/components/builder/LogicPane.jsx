import React, { useCallback, useEffect, useState } from "react";
import { Workflow, FileCode2, Loader2, Ban, RotateCcw, AlertCircle, Lock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { formatDistanceToNow } from "date-fns";
import WorkflowCard from "./WorkflowCard";

// Builder Logic pane — the app's own backend surface. Definitions, trigger management,
// validation, finalization and execution history all flow through the EXISTING authorized
// workflow API; function files open in the editor. No second automation system is invented.
const RUN_ACTIVE = /PEND|RUN|WAIT|START|QUEUED|ACTIVE|PAUSED/i;
const RUN_FAILED = /FAIL|CANCEL|TIMEOUT/i;
const TERMINAL_RE = /SUCCEED|COMPLETE|FAIL|CANCEL|TIMEOUT|SUPERSEDED/i;

export default function LogicPane({ projectId, files, onOpenFile }) {
  const [tab, setTab] = useState("workflows");
  const [workflows, setWorkflows] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);
  const [reports, setReports] = useState({});

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true); setError(null);
    try {
      const [defs, recent] = await Promise.all([
        base44.functions.invoke("workflows", { action: "list", project_id: projectId }),
        base44.functions.invoke("workflows", { action: "runs", project_id: projectId, limit: 30 }),
      ]);
      setWorkflows(defs.data.workflows || []);
      setRuns(recent.data.runs || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  // Poll only while a run is in flight, exactly like the deployment surface does.
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

  const functions = (files || []).filter((f) => f.path.startsWith("functions/"));
  const defById = Object.fromEntries(workflows.map((d) => [d.workflow_definition_id, d]));

  return (
    <div className="h-full overflow-auto p-5 scrollbar-thin max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Workflow className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold tracking-tight">Logic</h2>
        <div className="ml-auto flex items-center rounded-lg bg-muted p-0.5">
          <button onClick={() => setTab("workflows")} className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${tab === "workflows" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Workflows</button>
          <button onClick={() => setTab("functions")} className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${tab === "functions" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Functions</button>
        </div>
      </div>
      <p className="text-muted-foreground mb-4">
        {tab === "workflows"
          ? "Automations, their triggers and execution history. Only a FINALIZED version runs — a draft never executes."
          : "This app's backend functions — the executable steps workflows and the runtime call."}
      </p>

      {tab === "functions" ? (
        functions.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-muted-foreground/60">No backend functions yet. Ask the assistant to add one.</div>
        ) : (
          <div className="rounded-md border border-border divide-y divide-border">
            {functions.map((f) => (
              <button key={f.id} onClick={() => onOpenFile(f.path)} className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-muted/50 transition-colors">
                <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="font-mono text-[12px] truncate">{f.path.slice("functions/".length)}</span>
                <span className="ml-auto text-[11px] text-muted-foreground/60 whitespace-nowrap">{formatDistanceToNow(new Date(f.updated_date), { addSuffix: true })}</span>
              </button>
            ))}
          </div>
        )
      ) : loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div><div className="font-medium">Failed to load workflows</div><div className="text-[12px]">{error}</div></div>
        </div>
      ) : (
        <div className="space-y-4">
          {workflows.length === 0 && (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-muted-foreground/60">No workflows yet. Ask the assistant to build an automation.</div>
          )}
          {workflows.map((w) => (
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

          {runs.length > 0 && (
            <div>
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

          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
            <Lock className="h-3 w-3" />Workflows are project-scoped — every action is re-authorized server-side against this project.
          </p>
        </div>
      )}
    </div>
  );
}