import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Pause, Play, Zap, ExternalLink, AlertCircle, Clock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { STATUS_LABEL } from "@/components/builder/ScheduledWorkflows";
import { formatDistanceToNow } from "date-fns";

// Automations — the Agent Settings section over the CERTIFIED AgentSchedule lifecycle
// (agentSchedules list/pause/resume/run_now; archive is the tombstone, restore the only way
// back, no hard delete — documented Base44 Superagent workflow semantics). Shows the schedules
// declared for THIS agent and executes the real lifecycle actions through the authorized
// endpoint; the fire itself stays with the certified sweeper + Agent Executor. Root agents have
// no project, so their card points at the workspace-level Workflows page.
const timingLabel = (s) => {
  if (s.one_time_at) return `One-time · ${new Date(s.one_time_at).toLocaleString()}`;
  if (s.interval_seconds) return `Every ${s.interval_seconds}s`;
  return s.cron || "—";
};

export default function AgentAutomationsCard({ agent, isRoot }) {
  const [schedules, setSchedules] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (isRoot || !agent?.project_id) { setSchedules([]); return; }
    try {
      const res = await base44.functions.invoke("agentSchedules", { action: "list", project_id: agent.project_id, limit: 50 });
      const all = res.data?.schedules || res.data?.items || [];
      setSchedules(all.filter((s) => s.agent_name === agent.name));
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setSchedules([]);
    }
  }, [isRoot, agent?.project_id, agent?.name]);

  useEffect(() => { load(); }, [load]);

  const act = async (action, schedule) => {
    setBusy(`${action}:${schedule.schedule_id || schedule.id}`);
    try {
      await base44.functions.invoke("agentSchedules", { project_id: agent.project_id, action, schedule_id: schedule.schedule_id || schedule.id });
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setBusy(null); }
  };

  if (isRoot) {
    return (
      <div className="text-[12px] text-muted-foreground">
        Automations run on your apps. <Link to="/workflows" className="underline hover:text-foreground">Open Workflows</Link> to create and manage scheduled agent workflows.
      </div>
    );
  }

  return (
    <div>
      {!agent?.project_id ? null : schedules === null ? (
        <div className="text-muted-foreground py-1"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : schedules.length === 0 ? (
        <div className="text-[12px] text-muted-foreground">
          No automations for this agent yet.{" "}
          <Link to="/workflows" className="underline hover:text-foreground">Create a scheduled workflow</Link>.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {schedules.map((s) => {
            const id = s.schedule_id || s.id;
            const label = STATUS_LABEL(s);
            const active = s.enabled !== false && s.paused_reason !== "archived";
            return (
              <li key={id} className="px-3 py-2 flex items-start gap-2.5">
                <Clock className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap text-[12.5px]">
                    <span className="font-medium truncate">{s.goal}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${
                      label === "Active" ? "bg-emerald-500/10 text-emerald-600" :
                      label.startsWith("Paused") ? "bg-amber-500/10 text-amber-600" : "bg-muted text-muted-foreground"}`}>{label}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {timingLabel(s)}
                    {s.next_run_at && <> · next {formatDistanceToNow(new Date(s.next_run_at), { addSuffix: true })}</>}
                  </div>
                </div>
                <button onClick={() => act("run_now", s)} disabled={busy !== null} title="Run now" className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                  {busy === `run_now:${id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                </button>
                {active ? (
                  <button onClick={() => act("pause", s)} disabled={busy !== null} title="Pause" className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                    <Pause className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button onClick={() => act("resume", s)} disabled={busy !== null} title="Resume" className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                    <Play className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="mt-2 flex items-start gap-1.5 text-[11.5px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />{error}
        </div>
      )}
      <Link to="/workflows" className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors">All workflows <ExternalLink className="h-3 w-3" /></Link>
    </div>
  );
}