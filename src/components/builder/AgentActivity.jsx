import React from "react";
import { Bot, Check, X, Loader2, CircleDot, Square } from "lucide-react";
import { AGENT_TERMINAL } from "@/hooks/useAgentRun";
import ScheduleStepCard from "./ScheduleStepCard";

const ICON = { done: Check, failed: X, cancelled: Square, running: Loader2 };

// Scheduled Superagent Workflow actions render as compact schedule cards (the documented chat
// surface); every other action keeps the existing plain step line.
const SCHEDULE_ACTIONS = new Set([
  "create_schedule", "update_schedule", "pause_schedule", "resume_schedule", "archive_schedule", "restore_schedule",
]);

export default function AgentActivity({ run, steps, onCancel }) {
  if (!run) return null;
  const active = !AGENT_TERMINAL.includes(run.status);

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <Bot className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">Agent · {run.status.toLowerCase()}</span>
        {active && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/60" />}
        <span className="ml-auto text-muted-foreground/60">{run.current_step}/{run.max_steps} steps</span>
        {active && (
          <button onClick={onCancel} className="ml-2 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted transition-colors">Cancel</button>
        )}
      </div>
      <p className="mt-1 text-muted-foreground">{run.goal}</p>

      <ul className="mt-2 space-y-1">
        {steps.map((s) => {
          const Icon = ICON[s.status] || CircleDot;
          if (SCHEDULE_ACTIONS.has(s.action_type)) return <ScheduleStepCard key={s.id} step={s} />;
          return (
            <li key={s.id} className="flex items-start gap-2">
              <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${s.status === "failed" ? "text-destructive" : s.status === "running" ? "animate-spin text-muted-foreground/60" : "text-emerald-600 dark:text-emerald-400"}`} />
              <span className="text-muted-foreground">
                {s.summary || s.action_type}
                {s.error_code && <span className="ml-1 text-destructive">({s.error_code})</span>}
              </span>
            </li>
          );
        })}
        {active && run.current_phase && <li className="pl-5 text-muted-foreground/60">{run.current_phase}…</li>}
      </ul>

      {!active && (
        <div className="mt-2 border-t border-border pt-2 text-muted-foreground">
          {/* Usage footer — only the fields already stored on AgentRun; nothing invented. */}
          {(run.model || run.input_tokens > 0 || run.output_tokens > 0 || run.duration_ms > 0) && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground/60">
              {run.model && <span>{run.model}</span>}
              {run.input_tokens > 0 && <span>↓ {run.input_tokens.toLocaleString()} in</span>}
              {run.output_tokens > 0 && <span>↑ {run.output_tokens.toLocaleString()} out</span>}
              {run.duration_ms > 0 && <span>⏱ {run.duration_ms >= 1000 ? `${(run.duration_ms / 1000).toFixed(1)}s` : `${run.duration_ms}ms`}</span>}
            </div>
          )}
          {run.result_summary && <p className="whitespace-pre-wrap">{run.result_summary}</p>}
          <p className="mt-1 text-muted-foreground/60">
            {run.version_number ? `Version ${run.version_number} · ` : ""}
            build {run.build_status || "unknown"}
            {run.failure_code ? ` · ${run.failure_code}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}