import React, { useEffect, useState } from "react";
import { Loader2, ChevronRight } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { formatDistanceToNow } from "date-fns";

// Scheduled Workflow Activity — the documented Base44 experience, derived UI-only: run history
// comes from the certified fire-path audit rows (action "agent_schedule.fired",
// resource_id = schedule.id → metadata.agent_run_id) plus the schedule's last_agent_run_id as a
// resilience fallback. No schema, endpoint or scheduler change; skipped occurrences are never
// invented — only runs that actually fired appear.
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];
const STATUS_CLASS = {
  COMPLETED: "text-emerald-600 dark:text-emerald-400",
  FAILED: "text-destructive",
  CANCELLED: "text-muted-foreground",
  STALE: "text-muted-foreground",
};
const LIVE = ["QUEUED", "RUNNING", "PLANNING", "EXECUTING", "OBSERVING", "VERIFYING"];

const fmt = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? formatDistanceToNow(new Date(t), { addSuffix: true }) : "—"; };
const fmtDuration = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${n}ms`;
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

export default function ScheduleActivity({ schedule }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [openRun, setOpenRun] = useState(null);
  const [steps, setSteps] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const audits = await base44.entities.AuditLog.filter(
          { action: "agent_schedule.fired", resource_id: schedule.schedule_id }, "-created_date", 50);
        const ids = [];
        const seen = new Set();
        for (const a of audits || []) {
          const id = a.metadata?.agent_run_id;
          if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
        }
        // Resilience fallback: the latest fire must appear even if its audit row is unavailable.
        if (schedule.last_agent_run_id && !seen.has(schedule.last_agent_run_id)) ids.push(schedule.last_agent_run_id);
        const loaded = (await Promise.all(ids.map((id) => base44.entities.AgentRun.get(id).catch(() => null))))
          .filter(Boolean)
          .sort((a, b) => String(b.created_date || "").localeCompare(String(a.created_date || "")));
        if (!cancelled) { setRuns(loaded); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.response?.data?.error || e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [schedule.schedule_id, schedule.last_agent_run_id]);

  const terminal = (runs || []).filter((r) => TERMINAL.includes(r.status));
  const successCount = terminal.filter((r) => r.status === "COMPLETED").length;
  const successRate = terminal.length ? `${Math.round((100 * successCount) / terminal.length)}%` : "—";
  const durations = terminal.map((r) => Number(r.duration_ms)).filter((n) => Number.isFinite(n));
  const avgRuntime = durations.length ? fmtDuration(Math.round(durations.reduce((s, n) => s + n, 0) / durations.length)) : "—";

  const openSteps = async (run) => {
    const next = openRun === run.id ? null : run.id;
    setOpenRun(next);
    if (next && !steps[run.id]) {
      const rows = (await base44.entities.AgentStep.filter({ agent_run_id: run.id }, { sort: "-step_number", limit: 50 }).catch(() => ({ items: [] }))).items;
      setSteps((m) => ({ ...m, [run.id]: (rows || []).slice().reverse() }));
    }
  };

  return (
    <div className="rounded-md border border-border p-3 text-[11.5px]">
      <p className="font-medium">Activity</p>
      {!runs ? (
        <div className="mt-1 text-muted-foreground/60"><Loader2 className="h-3 w-3 animate-spin" /></div>
      ) : error ? (
        <p className="mt-1 text-destructive">{error}</p>
      ) : runs.length === 0 ? (
        <p className="mt-1 text-muted-foreground/60">No runs fired yet.</p>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap gap-x-4 text-muted-foreground">
            <span>{runs.length} run(s)</span>
            <span>success rate: {successRate}</span>
            <span>avg runtime: {avgRuntime}</span>
          </div>
          <ul className="mt-1.5 divide-y divide-border border-t border-border">
            {runs.map((r) => (
              <li key={r.id} className="py-1.5">
                <button onClick={() => openSteps(r)} className="flex w-full items-start gap-2 text-left">
                  <ChevronRight className={`h-3 w-3 mt-0.5 text-muted-foreground shrink-0 transition-transform ${openRun === r.id ? "rotate-90" : ""}`} />
                  <span className="shrink-0 text-muted-foreground">{fmt(r.created_date)}</span>
                  <span className="min-w-0 flex-1 truncate">{r.goal || schedule.goal}</span>
                  <span className={`shrink-0 font-mono text-[10px] uppercase ${STATUS_CLASS[r.status] || "text-muted-foreground"}`}>{r.status}</span>
                  <span className="shrink-0 text-muted-foreground">{LIVE.includes(r.status) ? "running…" : fmtDuration(r.duration_ms)}</span>
                </button>
                {openRun === r.id && (
                  <div className="mt-1 ml-5">
                    {!steps[r.id] ? (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />
                    ) : steps[r.id].length === 0 ? (
                      <p className="text-muted-foreground/60">No steps recorded.</p>
                    ) : (
                      <ul className="space-y-0.5">
                        {steps[r.id].map((st) => (
                          <li key={st.id} className="truncate text-muted-foreground">
                            <span className="font-medium text-foreground">{st.step_number}. {st.action_type}</span>
                            {st.summary || st.result_summary ? ` — ${st.summary || st.result_summary}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}