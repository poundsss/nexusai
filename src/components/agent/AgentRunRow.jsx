import React from "react";
import { Link } from "react-router-dom";
import { Bot, Loader2, ExternalLink, X as XIcon } from "lucide-react";
import { AGENT_TERMINAL } from "@/hooks/useAgentRun";
import AgentStepList from "@/components/agent/AgentStepList";
import ChildRunsList from "@/components/agent/ChildRunsList";

const TONE = {
  COMPLETED: "text-emerald-600 dark:text-emerald-400",
  FAILED: "text-destructive",
  CANCELLED: "text-muted-foreground",
  STALE: "text-amber-600 dark:text-amber-400",
};

// One goal run. Collapsed: goal + live state (phase, step count). Expanded (selected): the
// run's durable results (result_summary / verification / version), its AgentStep task list,
// and the ONLY lifecycle operations the certified agentRun contract supports — cancel while
// active (no pause/resume exists), and "Open goal" (the run's app in the Builder).
export default function AgentRunRow({ run, projectName, selected, onSelect, steps, onCancel, cancelling = false }) {
  const active = !AGENT_TERMINAL.includes(run.status);
  return (
    <div
      className={`w-full rounded-lg border p-3 text-left transition-colors ${
        selected ? "border-foreground/30 bg-accent/50" : "border-border bg-card hover:border-foreground/20"
      }`}
    >
      <button type="button" onClick={() => onSelect(selected ? null : run.id)} className="w-full text-left" aria-expanded={selected}>
        <div className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{run.goal}</span>
          {active
            ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            : <span className={`shrink-0 text-[10.5px] font-semibold uppercase ${TONE[run.status] || "text-muted-foreground"}`}>{run.status.toLowerCase()}</span>}
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className="truncate">{projectName || run.project_id}</span>
          {active && run.current_phase && <span className="min-w-0 truncate">{run.current_phase}</span>}
          <span className="ml-auto shrink-0 tabular-nums">{run.current_step}/{run.max_steps} steps</span>
        </div>
      </button>

      {selected && (
        <div className="mt-2.5 space-y-2.5 border-t border-border pt-2.5">
          {run.result_summary && <p className="text-[12.5px] leading-snug">{run.result_summary}</p>}
          {run.verification && (
            <p className="text-[11.5px] text-muted-foreground">
              <span className="font-medium text-foreground/80">Verification:</span> {run.verification}
            </p>
          )}
          {run.failure_code && <p className="text-[11.5px] text-destructive">Failure: {run.failure_code}</p>}
          {run.version_number && (
            <Link to={`/projects/${run.project_id}`} className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors">
              Version {run.version_number} <ExternalLink className="h-3 w-3" />
            </Link>
          )}

          <ChildRunsList parentRunId={run.id} />
          <AgentStepList steps={steps} />

          <div className="flex items-center gap-2">
            <Link
              to={`/projects/${run.project_id}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] font-medium hover:bg-muted transition-colors"
              title="Open the goal's app in the Builder"
            >
              <ExternalLink className="h-3 w-3" />Open goal
            </Link>
            {active && onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={cancelling}
                title="The contract supports cancel only — the run stops at its next safe checkpoint"
                className="inline-flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-[11.5px] font-medium text-destructive hover:bg-destructive/5 transition-colors disabled:opacity-50"
              >
                {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <XIcon className="h-3 w-3" />}Cancel run
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}