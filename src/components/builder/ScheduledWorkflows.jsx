import React, { useCallback, useEffect, useState } from "react";
import { Clock, ChevronRight, Loader2, Pause, Play, Archive, ArchiveRestore, CalendarClock, AlertCircle, Zap } from "lucide-react";
import ScheduleActivity from "@/components/builder/ScheduleActivity";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { formatDistanceToNow } from "date-fns";

// Builder Agents pane — Scheduled section: the project's Scheduled Superagent Workflows. A thin
// projection over the CERTIFIED AgentSchedule lifecycle — every mutation goes through the
// authorized endpoint (create/update/pause/resume/archive/restore/run_now; archive is the tombstone and
// restore the only way back, no hard delete). The fire itself stays with the certified sweeper +
// Agent Executor: this UI never enqueues, claims or schedules anything.
export const STATUS_LABEL = (s) => {
  if (s.paused_reason === "archived") return "Archived";
  if (s.paused_reason === "completed") return "Completed";
  if (s.paused_reason === "schedule_ended") return "Ended";
  if (s.paused_reason === "consecutive_failures") return "Paused · failures";
  if (s.paused_reason === "paused") return "Paused";
  return s.enabled ? "Active" : "Disabled";
};
const STATUS_STYLE = {
  Active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Paused: "bg-amber-500/10 text-amber-600",
  "Paused · failures": "bg-destructive/10 text-destructive",
  Archived: "bg-muted text-muted-foreground",
  Completed: "bg-muted text-muted-foreground",
  Ended: "bg-muted text-muted-foreground",
  Disabled: "bg-muted text-muted-foreground",
};
const LAST_STYLE = { success: "text-emerald-600 dark:text-emerald-400", failed: "text-destructive", running: "text-brand", pending: "text-muted-foreground", skipped: "text-muted-foreground" };

// Discovery controls — client-side only, over the already-loaded projection (no new endpoint).
// Archived schedules are grouped with Completed: both are non-active, terminal tombstone rows.
const SCHEDULE_FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "completed", label: "Completed" },
];
const statusKeyOf = (s) => {
  if (s.paused_reason === "archived" || s.paused_reason === "completed" || s.paused_reason === "schedule_ended") return "completed";
  if (!s.enabled || s.paused_reason === "paused" || s.paused_reason === "consecutive_failures") return "paused";
  return "active";
};

export const fmt = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? formatDistanceToNow(new Date(t), { addSuffix: true }) : "—"; };
export const timingOf = (s) => (s.one_time_at ? `one-time · ${fmt(s.one_time_at)}` : s.interval_seconds ? `every ${s.interval_seconds}s` : s.cron || "—");

const emptyForm = { goal: "", agent_name: "", mode: "cron", cron: "", interval_seconds: "", one_time_at: "", timezone: "UTC", ends_type: "never", ends_on_date: "", ends_after_count: "" };
const formOf = (s) => ({
  goal: s.goal || "",
  agent_name: s.agent_name || "",
  mode: s.one_time_at ? "once" : s.interval_seconds ? "interval" : "cron",
  cron: s.cron || "", interval_seconds: s.interval_seconds != null ? String(s.interval_seconds) : "",
  one_time_at: s.one_time_at ? String(s.one_time_at).slice(0, 16) : "",
  timezone: s.timezone || "UTC",
  ends_type: s.ends_type || "never",
  ends_on_date: s.ends_on_date ? String(s.ends_on_date).slice(0, 10) : "",
  ends_after_count: s.ends_after_count != null ? String(s.ends_after_count) : "",
});

// The schedule payload handed to the endpoint: exactly one timing mode, ISO UTC one-time.
function payloadOf(f, forUpdate) {
  const p = {};
  if (f.goal.trim()) p.goal = f.goal.trim();
  if (f.agent_name) p.agent_name = f.agent_name;
  else if (forUpdate) p.agent_name = "";
  if (f.mode === "once") {
    if (f.one_time_at) p.one_time_at = new Date(f.one_time_at).toISOString();
    else if (forUpdate) p.one_time_at = null;
  } else if (f.mode === "interval") {
    if (f.interval_seconds) p.interval_seconds = Number(f.interval_seconds);
    else if (forUpdate) p.interval_seconds = null;
  } else {
    if (f.cron.trim()) p.cron = f.cron.trim();
    else if (forUpdate) p.cron = null;
  }
  p.timezone = f.timezone || "UTC";
  if (f.ends_type !== "never") {
    p.ends_type = f.ends_type;
    if (f.ends_type === "on") p.ends_on_date = f.ends_on_date ? new Date(`${f.ends_on_date}T00:00:00Z`).toISOString() : null;
    if (f.ends_type === "after") p.ends_after_count = f.ends_after_count ? Number(f.ends_after_count) : null;
  } else if (forUpdate) p.ends_type = "never";
  return p;
}

export default function ScheduledWorkflows({ projectId, agentFiles, onEmpty }) {
  const [schedules, setSchedules] = useState(null);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState({});
  const [open, setOpen] = useState(null);
  const [lastRuns, setLastRuns] = useState({});
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const res = await base44.functions.invoke("agentSchedules", { action: "list", project_id: projectId, limit: 50 });
      const list = res.data?.schedules || [];
      setSchedules(list);
      setError(null);
      if (onEmpty) onEmpty(list.length === 0);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  // Light refresh while anything is mid-fire or about to fire.
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (label, payload) => {
    setWorking(true);
    try {
      await base44.functions.invoke("agentSchedules", { project_id: projectId, ...payload });
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

  const create = async () => {
    if (!form.goal.trim() || creating) return;
    setCreating(true);
    const ok = await act("Schedule created", { action: "create", ...payloadOf(form, false) });
    if (ok) { setForm(emptyForm); setCreating(false); }
    else setCreating(false);
  };

  const saveEdit = async (s) => {
    if (working) return;
    const ok = await act(`${s.goal.slice(0, 40) || "Schedule"} updated`, { action: "update", schedule_id: s.schedule_id, ...payloadOf(editForm[s.schedule_id] || formOf(s), true) });
    if (ok) setEditForm((m) => { const n = { ...m }; delete n[s.schedule_id]; return n; });
  };

  // The AgentRun the schedule last fired — the same durable-run projection the run history uses.
  const openDetails = async (s) => {
    const next = open === s.schedule_id ? null : s.schedule_id;
    setOpen(next);
    if (next && s.last_agent_run_id && !lastRuns[s.schedule_id]) {
      const run = await base44.entities.AgentRun.get(s.last_agent_run_id).catch(() => null);
      const steps = run ? (await base44.entities.AgentStep.filter({ agent_run_id: run.id }, { sort: "-step_number", limit: 5 }).catch(() => ({ items: [] }))).items : [];
      setLastRuns((m) => ({ ...m, [s.schedule_id]: { run, steps: (steps || []).reverse() } }));
    }
  };

  const agents = (agentFiles || []).map((f) => f.path.split("/").pop().replace(/\.jsonc$/, ""));

  // Discovery: search by goal/agent name + status filter, over the already-loaded list only.
  const q = query.trim().toLowerCase();
  const visible = (schedules || []).filter((s) =>
    (statusFilter === "all" || statusKeyOf(s) === statusFilter) &&
    (!q || String(s.goal || "").toLowerCase().includes(q) || String(s.agent_name || "").toLowerCase().includes(q)));

  const renderForm = (f, onChange, onSubmit, submitLabel, busy) => (
    <div className="space-y-2">
      <textarea
        value={f.goal}
        onChange={(e) => onChange({ ...f, goal: e.target.value })}
        rows={2}
        placeholder="What should the agent do on every run…"
        className="w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60"
        aria-label="Schedule goal"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={f.mode} onChange={(e) => onChange({ ...f, mode: e.target.value })} aria-label="Timing mode" className="rounded-md border border-border bg-background px-2 py-1 text-[11.5px]">
          <option value="cron">Cron</option>
          <option value="interval">Every N sec</option>
          <option value="once">One-time</option>
        </select>
        {f.mode === "cron" && <input value={f.cron} onChange={(e) => onChange({ ...f, cron: e.target.value })} placeholder="*/15 * * * *" className="w-32 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11.5px] outline-none focus:ring-1 ring-ring" />}
        {f.mode === "interval" && <input value={f.interval_seconds} onChange={(e) => onChange({ ...f, interval_seconds: e.target.value })} placeholder="seconds" type="number" min="1" className="w-24 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11.5px] outline-none focus:ring-1 ring-ring" />}
        {f.mode === "once" && <input value={f.one_time_at} onChange={(e) => onChange({ ...f, one_time_at: e.target.value })} type="datetime-local" className="rounded-md border border-border bg-background px-2 py-1 text-[11.5px] outline-none focus:ring-1 ring-ring" />}
        <input value={f.timezone} onChange={(e) => onChange({ ...f, timezone: e.target.value })} placeholder="timezone (UTC)" className="w-36 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11.5px] outline-none focus:ring-1 ring-ring" title="IANA timezone, e.g. America/Chicago" />
        <select
          value={f.ends_type}
          onChange={(e) => onChange({ ...f, ends_type: e.target.value })}
          aria-label="Ends"
          className="rounded-md border border-border bg-background px-2 py-1 text-[11.5px]"
        >
          <option value="never">Never ends</option>
          <option value="on">Ends on date</option>
          <option value="after">Ends after N runs</option>
        </select>
        {f.ends_type === "on" && <input value={f.ends_on_date} onChange={(e) => onChange({ ...f, ends_on_date: e.target.value })} type="date" className="rounded-md border border-border bg-background px-2 py-1 text-[11.5px]" />}
        {f.ends_type === "after" && <input value={f.ends_after_count} onChange={(e) => onChange({ ...f, ends_after_count: e.target.value })} type="number" min="1" placeholder="N runs" className="w-20 rounded-md border border-border bg-background px-2 py-1 text-[11.5px]" />}
        <button onClick={onSubmit} disabled={busy} className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-2.5 py-1 text-[11.5px] font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" />}{submitLabel}
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <h3 className="mt-5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Scheduled</h3>
      <p className="mb-2 text-[12px] text-muted-foreground">Recurring agent runs. Each fire enqueues one agent run under your identity — the same agent, credits and audit as a manual run.</p>

      {/* Create */}
      <div className="rounded-xl border border-border bg-card p-3">
        {renderForm(form, (f) => setForm(f), create, "Create schedule", creating)}
      </div>

      {/* Discovery controls — shown once there is anything to filter */}
      {schedules && schedules.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search schedules…"
            aria-label="Search schedules"
            className="min-w-40 flex-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] outline-none focus:ring-1 ring-ring"
          />
          <div className="flex items-center gap-1">
            {SCHEDULE_FILTERS.map((f) => (
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

      {/* List */}
      {error ? (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="text-[12px]">{error}</div>
        </div>
      ) : !schedules ? (
        <div className="mt-2 rounded-md border border-border p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
      ) : schedules.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted-foreground/60">No scheduled workflows yet.</div>
      ) : visible.length === 0 ? (
        <div className="mt-2 rounded-md border border-dashed border-border p-4 text-center text-[12px] text-muted-foreground/60">No schedules match the current filters.</div>
      ) : (
        <div className="mt-2 rounded-md border border-border divide-y divide-border">
          {visible.map((s) => {
            const label = STATUS_LABEL(s);
            const openRow = open === s.schedule_id;
            const ef = editForm[s.schedule_id] || formOf(s);
            const lastRun = lastRuns[s.schedule_id];
            const dirty = JSON.stringify(ef) !== JSON.stringify(formOf(s));
            return (
              <div key={s.schedule_id} className="px-3 py-2.5 text-[12px]">
                <div className="flex items-start gap-2.5">
                  <button onClick={() => openDetails(s)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                    <ChevronRight className={`h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0 transition-transform ${openRow ? "rotate-90" : ""}`} />
                    <Clock className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{s.goal}</p>
                      <p className="mt-0.5 text-muted-foreground truncate">
                        {timingOf(s)}{s.timezone && s.timezone !== "UTC" ? ` · ${s.timezone}` : ""}
                        {s.agent_name ? ` · agent: ${s.agent_name}` : ""}
                      </p>
                    </div>
                  </button>
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_STYLE[label] || "bg-muted text-muted-foreground"}`}>{label}</span>
                  {s.consecutive_failures > 0 && <span className="shrink-0 text-[10.5px] text-destructive">{s.consecutive_failures} fail(s)</span>}
                  {s.enabled && s.paused_reason !== "archived" && s.paused_reason !== "completed" && s.paused_reason !== "schedule_ended" && (
                    <button onClick={() => act("Run now started", { action: "run_now", schedule_id: s.schedule_id })} disabled={working} className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors" title="Run now">
                      <Zap className="h-3 w-3" />
                    </button>
                  )}
                  {s.enabled && s.paused_reason !== "archived" && s.paused_reason !== "completed" && s.paused_reason !== "schedule_ended" && (
                    <button onClick={() => act("Schedule paused", { action: "pause", schedule_id: s.schedule_id })} disabled={working} className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors" title="Pause">
                      <Pause className="h-3 w-3" />
                    </button>
                  )}
                  {!s.enabled && s.paused_reason !== "archived" && s.paused_reason !== "completed" && s.paused_reason !== "schedule_ended" && (
                    <button onClick={() => act("Schedule resumed", { action: "resume", schedule_id: s.schedule_id })} disabled={working} className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors" title="Resume">
                      <Play className="h-3 w-3" />
                    </button>
                  )}
                  {s.paused_reason !== "archived" && (
                    <button onClick={() => act("Schedule archived", { action: "archive", schedule_id: s.schedule_id })} disabled={working} className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors" title="Archive">
                      <Archive className="h-3 w-3" />
                    </button>
                  )}
                  {s.paused_reason === "archived" && (
                    <button onClick={() => act("Schedule restored", { action: "restore", schedule_id: s.schedule_id })} disabled={working} className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors" title="Restore">
                      <ArchiveRestore className="h-3 w-3" />
                    </button>
                  )}
                </div>

                <div className="mt-1 ml-6 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground/70">
                  <span>next: {fmt(s.next_run_at)}</span>
                  <span>last: {fmt(s.last_run_at)}</span>
                  <span className={LAST_STYLE[s.last_status] || "text-muted-foreground"}>{s.last_status}{s.run_count ? ` · ${s.run_count} run(s)` : ""}</span>
                </div>
                {s.last_error && <p className="mt-1 ml-6 text-[11px] text-destructive truncate">{s.last_error}</p>}

                {openRow && (
                  <div className="mt-2 ml-6 space-y-2">
                    {/* Edit — the authorized update action re-derives the whole schedule state */}
                    <div className="rounded-md border border-border bg-card p-3">
                      {renderForm(ef, (f) => setEditForm((m) => ({ ...m, [s.schedule_id]: f })), () => saveEdit(s), "Save changes", working)}
                      {dirty && <p className="mt-1 text-[10.5px] text-muted-foreground/60">unsaved changes</p>}
                    </div>
                    {/* Last fired agent run — the existing AgentRun/AgentStep projection */}
                    {s.last_agent_run_id && (
                      <div className="rounded-md border border-border p-3 text-[11.5px]">
                        <p className="font-medium">Last fired run</p>
                        {!lastRun ? (
                          <div className="mt-1 text-muted-foreground/60"><Loader2 className="h-3 w-3 animate-spin" /></div>
                        ) : !lastRun.run ? (
                          <p className="mt-1 text-muted-foreground/60">Run record not found.</p>
                        ) : (
                          <>
                            <p className="mt-1 text-muted-foreground">
                              <span className="font-mono text-[10px] uppercase">{lastRun.run.status}</span>
                              {" · "}{lastRun.run.current_phase || lastRun.run.goal?.slice(0, 60)}
                            </p>
                            {lastRun.run.result_summary && <p className="mt-1 text-muted-foreground">{lastRun.run.result_summary}</p>}
                            <ul className="mt-1.5 space-y-1 border-t border-border pt-1.5">
                              {lastRun.steps.map((st) => (
                                <li key={st.id} className="truncate text-muted-foreground">
                                  <span className="font-medium text-foreground">{st.step_number}. {st.action_type}</span>
                                  {st.summary || st.result_summary ? ` — ${st.summary || st.result_summary}` : ""}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                    {/* Full Activity projection — derived from existing audit + AgentRun data (UI-only) */}
                    <ScheduleActivity schedule={s} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}