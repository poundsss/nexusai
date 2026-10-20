import React, { useEffect, useState } from "react";
import { Bot, Loader2, Play, Ban, Sparkles, ChevronRight, FileCode2, Wrench, Plus, Pencil, Copy, Trash2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { formatDistanceToNow } from "date-fns";
import { AGENT_TERMINAL } from "@/hooks/useAgentRun";
import AgentEditorDialog from "@/components/builder/AgentEditorDialog";
import CloneAgentDialog from "@/components/builder/CloneAgentDialog";
import AgentConnectorsCard from "@/components/builder/AgentConnectorsCard";
import ScheduledWorkflows from "@/components/builder/ScheduledWorkflows";
import MemoryPanel from "@/components/builder/MemoryPanel";
import RewardsPanel from "@/components/builder/RewardsPanel";
import TrainingCyclePanel from "@/components/builder/TrainingCyclePanel";

const STATUS_COLOR = {
  COMPLETED: "text-emerald-600 dark:text-emerald-400",
  FAILED: "text-destructive",
  CANCELLED: "text-muted-foreground",
  STALE: "text-muted-foreground",
};
const STEP_DOT = { done: "bg-emerald-500", failed: "bg-destructive", cancelled: "bg-muted-foreground/50", running: "bg-blue-500 animate-pulse" };

export default function AgentsPane({ projectId, projectSlug, onOpenSecrets, agent, files, onOpenFile, version, onReload }) {
  const [history, setHistory] = useState(null);
  const [goal, setGoal] = useState("");
  const [starting, setStarting] = useState(false);
  const [openRun, setOpenRun] = useState(null);
  const [runSteps, setRunSteps] = useState({});
  const [editor, setEditor] = useState(null);
  const [cloneFrom, setCloneFrom] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const agentNameOf = (p) => String(p).split("/").pop().replace(/\.jsonc$/, "");
  const doDelete = async (name) => {
    if (lifecycleBusy) return;
    setLifecycleBusy(true);
    try {
      await base44.functions.invoke("agentEditor", { action: "delete", project_id: projectId, agent_name: name });
      toast({ title: "Agent deleted", description: "Restorable from Recently deleted for 30 days (Agent Settings)." });
      setConfirmDelete(null);
      await onReload();
    } catch (e) {
      toast({ variant: "destructive", title: e.response?.data?.error || e.message });
    } finally { setLifecycleBusy(false); }
  };

  const loadHistory = async () => {
    const rows = (await base44.entities.AgentRun.filter({ project_id: projectId }, { sort: "-created_date", limit: 20 }).catch(() => ({ items: [] }))).items;
    setHistory(rows);
  };

  useEffect(() => { loadHistory(); }, [projectId]);
  useEffect(() => {
    if (!agent?.run || AGENT_TERMINAL.includes(agent.run.status)) return;
    const t = setInterval(() => { agent.refresh(); loadHistory(); }, 5000);
    return () => clearInterval(t);
  }, [agent?.run?.id, agent?.run?.status, agent?.refresh]);

  const start = async () => {
    const g = goal.trim();
    if (!g || starting || agent?.active) return;
    setStarting(true);
    try { await agent.start(g); setGoal(""); await loadHistory(); }
    finally { setStarting(false); }
  };

  const openDetails = async (runId) => {
    if (openRun === runId) { setOpenRun(null); return; }
    setOpenRun(runId);
    if (!runSteps[runId]) {
      const steps = await base44.entities.AgentStep.filter({ agent_run_id: runId }, "step_number", 60).catch(() => []);
      setRunSteps((s) => ({ ...s, [runId]: steps }));
    }
  };

  const activeRun = agent?.active ? agent.run : null;
  // Agent policy files may live under either path scheme: the canonical base44/agents/ (the
  // certified agentEditor contract's output) or the legacy relative agents/.
  const policyFiles = (files || []).filter((f) => f.path.startsWith("agents/") || f.path.startsWith("base44/agents/"));
  const toolsUsed = [...new Set(Object.values(runSteps).flat().map((s) => s.tool || s.action_type).filter(Boolean))];

  return (
    <div className="h-full overflow-auto p-5 scrollbar-thin max-w-3xl">
      <div className="flex items-center gap-2 mb-1">
        <Bot className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-semibold tracking-tight">Agents</h2>
      </div>
      <p className="text-muted-foreground mb-4">Give a high-level goal — the agent plans, edits, verifies and versions the project autonomously. Every run is durable and audited.</p>

      <div className="rounded-xl border border-border bg-card p-3">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); start(); } }}
          rows={2}
          disabled={!!activeRun}
          placeholder={activeRun ? "An agent is already working on this project…" : "Turn this into a better dashboard…"}
          className="w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60"
          aria-label="Agent goal"
        />
        <div className="flex items-center justify-end mt-1">
          <button
            onClick={start}
            disabled={!goal.trim() || starting || !!activeRun}
            className="flex items-center gap-1.5 rounded-lg bg-foreground text-background px-3 py-1.5 text-[12px] font-semibold hover:opacity-90 disabled:opacity-30 transition-opacity"
          >
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}Start agent
          </button>
        </div>
      </div>

      {activeRun && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 p-3 text-[12px]">
          <div className="flex items-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="font-medium">{agent.run.current_phase || "Working"}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60 uppercase">{agent.run.status}</span>
            <span className="ml-auto text-[11px] text-muted-foreground/60">step {agent.run.current_step || 0}/{agent.run.max_steps}</span>
            <button onClick={agent.cancel} disabled={agent.run.cancel_requested} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-destructive disabled:opacity-50 transition-colors">
              <Ban className="h-3 w-3" />{agent.run.cancel_requested ? "Cancelling…" : "Cancel"}
            </button>
          </div>
          <p className="mt-2 text-muted-foreground">{agent.run.goal}</p>
          {agent.steps.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-border pt-2">
              {agent.steps.slice(-8).map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-muted-foreground">
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${STEP_DOT[s.status] || "bg-muted-foreground/50"}`} />
                  <span className="truncate">{s.summary || s.result_summary || `Step ${s.step_number}`}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <h3 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Run history</h3>
      <div className="mt-2 rounded-md border border-border divide-y divide-border">
        {!history ? (
          <div className="p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
        ) : history.length === 0 ? (
          <div className="p-4 text-center text-[12px] text-muted-foreground/60">No agent runs yet.</div>
        ) : history.map((r) => {
          const steps = runSteps[r.id];
          const open = openRun === r.id;
          return (
            <div key={r.id} className="px-3 py-2.5 text-[12px]">
              <div className="flex items-start gap-2.5">
                <button onClick={() => openDetails(r.id)} className="flex items-start gap-2 min-w-0 flex-1 text-left">
                  <ChevronRight className={`h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
                  {r.status === "COMPLETED" ? <Sparkles className="h-3.5 w-3.5 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" /> : <Bot className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{r.goal}</p>
                    {r.result_summary && <p className="mt-0.5 text-muted-foreground truncate">{r.result_summary}</p>}
                  </div>
                </button>
                <span className={`shrink-0 font-mono text-[10px] ${STATUS_COLOR[r.status] || "text-brand"}`}>{r.status}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground/60 whitespace-nowrap">{formatDistanceToNow(new Date(r.created_date), { addSuffix: true })}</span>
              </div>

              {open && (
                <div className="mt-2 ml-6 space-y-1.5">
                  <p className="text-[11px] text-muted-foreground/70">
                    {r.current_step || 0} step(s){r.version_number ? ` · produced v${r.version_number}` : ""}{r.failure_code ? ` · ${r.failure_code}` : ""}
                  </p>
                  {!steps ? (
                    <div className="text-muted-foreground/60"><Loader2 className="h-3 w-3 animate-spin" /></div>
                  ) : steps.length === 0 ? (
                    <p className="text-[11.5px] text-muted-foreground/60">No step records for this run.</p>
                  ) : (
                    <ol className="space-y-1">
                      {steps.map((s) => (
                        <li key={s.id} className="flex items-start gap-2 text-[11.5px]">
                          <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${STEP_DOT[s.status] || "bg-muted-foreground/50"}`} />
                          <div className="min-w-0">
                            <span className="font-medium">{s.action_type}</span>
                            {s.tool && <span className="ml-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{s.tool}</span>}
                            {(s.summary || s.result_summary) && <p className="text-muted-foreground">{s.summary || s.result_summary}</p>}
                            {s.error_code && <p className="text-destructive">{s.error_code}</p>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ScheduledWorkflows projectId={projectId} />

      <div className="flex items-center justify-between mt-5">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Configuration</h3>
        <button onClick={() => setEditor({ file: null })} className="flex items-center gap-1 rounded-lg border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors">
          <Plus className="h-3 w-3" />New agent
        </button>
      </div>
      <div className="mt-2 rounded-md border border-border p-3">
        <p className="text-[12px] text-muted-foreground mb-2">
          Runs use a bounded step budget and the workspace's model policy. Agent behaviour is defined by the project's policy files:
        </p>
        {policyFiles.length === 0 ? (
          <p className="text-[12px] text-muted-foreground/60">No agent policy files in this project — the default agent behaviour applies.</p>
        ) : (
          <div className="divide-y divide-border">
            {policyFiles.map((f) => (
              <div key={f.id} className="flex items-center gap-2 py-1.5">
                <button onClick={() => onOpenFile(f.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground">
                  <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-mono text-[12px] truncate">{f.path}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground/60">{formatDistanceToNow(new Date(f.updated_date), { addSuffix: true })}</span>
                </button>
                <button onClick={() => setCloneFrom(agentNameOf(f.path))} aria-label={`Clone ${f.path}`} title="Clone agent" className="shrink-0 rounded border border-border p-1 text-muted-foreground transition-colors hover:text-foreground hover:border-foreground/30">
                  <Copy className="h-3 w-3" />
                </button>
                <button
                  onClick={() => { const n = agentNameOf(f.path); if (confirmDelete === n) doDelete(n); else setConfirmDelete(n); }}
                  aria-label={`Delete ${f.path}`}
                  title={confirmDelete === agentNameOf(f.path) ? "Click again to confirm" : "Delete agent — restorable for 30 days"}
                  className={`shrink-0 rounded border border-border p-1 transition-colors ${confirmDelete === agentNameOf(f.path) ? "text-destructive border-destructive/40" : "text-muted-foreground hover:text-destructive hover:border-destructive/30"}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                <button onClick={() => setEditor({ file: f.path })} aria-label={`Edit ${f.path}`} className="shrink-0 rounded border border-border p-1 text-muted-foreground transition-colors hover:text-foreground hover:border-foreground/30">
                  <Pencil className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {toolsUsed.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Wrench className="h-3 w-3" />tools used: {toolsUsed.slice(0, 10).map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{t}</span>)}
          </p>
        )}
      </div>

      <AgentConnectorsCard projectId={projectId} files={files} version={version} onReload={onReload} />

      <MemoryPanel projectId={projectId} />
      <RewardsPanel projectId={projectId} />
      <TrainingCyclePanel projectId={projectId} />

      {editor && (
        <AgentEditorDialog
          projectId={projectId}
          projectSlug={projectSlug}
          onOpenSecrets={onOpenSecrets}
          files={files}
          file={editor.file}
          version={version}
          onClose={() => setEditor(null)}
          onSaved={onReload}
        />
      )}

      {cloneFrom && (
        <CloneAgentDialog projectId={projectId} agentName={cloneFrom} onClose={() => setCloneFrom(null)} onSaved={onReload} />
      )}
    </div>
  );
}