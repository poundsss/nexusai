import React, { useEffect, useState } from "react";
import { CalendarClock, Loader2, XCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { STATUS_LABEL, timingOf, fmt } from "./ScheduledWorkflows";

// Compact Scheduled Workflow card in Superagent chat. Rendered from the agent's existing
// AgentStep for a schedule action (create/update/pause/resume/archive/restore): the step's
// result_summary already carries the lifecycle outcome JSON ({ schedule_id, ... }), and the
// AgentSchedule row is fetched by that id only when goal/timing/status are needed. Presentation
// only — no actions, no persistence; the schedule itself stays with the certified lifecycle.
const parseOutcome = (text) => {
  try {
    const o = JSON.parse(text);
    return o && typeof o === "object" && !Array.isArray(o) && o.schedule_id ? o : null;
  } catch { return null; }
};

// Outcome-only fallback label for when the AgentSchedule row cannot be read.
const outcomeLabel = (o) => {
  if (!o) return null;
  if (o.archived) return "Archived";
  if (o.paused_reason) return o.paused_reason === "completed" ? "Completed" : o.paused_reason === "schedule_ended" ? "Ended" : "Paused";
  if (o.skipped) return "Skipped";
  if (o.enabled === false) return "Disabled";
  if (o.enabled === true) return "Active";
  if (o.changed) return "Updated";
  return null;
};

export default function ScheduleStepCard({ step }) {
  const outcome = parseOutcome(step.result_summary);
  const scheduleId = outcome?.schedule_id || null;
  const [schedule, setSchedule] = useState(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!scheduleId) return;
    let alive = true;
    base44.entities.AgentSchedule.get(scheduleId)
      .then((s) => { if (alive) setSchedule(s); })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [scheduleId]);

  const label = schedule ? STATUS_LABEL(schedule) : outcomeLabel(outcome);
  const timing = schedule ? timingOf(schedule) : null;
  const failed = step.status === "failed";
  const errorText = failed ? (outcome ? null : step.result_summary) : null;

  return (
    <li>
      <div className="rounded-xl border border-border bg-card p-3 text-[12px]">
        <div className="flex items-center gap-2 text-muted-foreground">
          <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium text-foreground">Scheduled workflow</span>
          <span className="truncate text-muted-foreground/80">{step.summary || step.action_type}</span>
          {label && (
            <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{label}</span>
          )}
        </div>
        {failed && (
          <p className="mt-1.5 flex items-start gap-1.5 text-destructive">
            <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{errorText || step.error_code || "Schedule action failed"}</span>
          </p>
        )}
        {!failed && schedule && (
          <>
            <p className="mt-1.5 truncate text-muted-foreground">{schedule.goal}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
              {timing || "—"}
              {schedule.next_run_at ? ` · next: ${fmt(schedule.next_run_at)}` : ""}
            </p>
            {schedule.last_status && schedule.last_status !== "pending" && (
              <p className="mt-0.5 text-[11px] text-muted-foreground/70">last fire: {schedule.last_status}</p>
            )}
          </>
        )}
        {!failed && !schedule && outcome && (
          <p className="mt-1.5 truncate text-[11px] text-muted-foreground/70">
            {outcome.changed?.length ? `changed: ${outcome.changed.join(", ")}` : ""}
            {outcome.next_run_at ? `next: ${fmt(outcome.next_run_at)}` : ""}
            {outcome.skipped ? `skipped: ${outcome.skipped}` : ""}
          </p>
        )}
        {!failed && !schedule && !outcome && !scheduleId && !missing && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span className="truncate">{step.summary || step.action_type}…</span>
          </p>
        )}
        {missing && !outcome && (
          <p className="mt-1.5 text-[11px] text-muted-foreground/70">Schedule details unavailable.</p>
        )}
      </div>
    </li>
  );
}