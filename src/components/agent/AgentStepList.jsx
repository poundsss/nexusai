import React from "react";
import { Check, X as XIcon, Loader2, Ban } from "lucide-react";

// Progress state of a goal run — the certified AgentStep rows, rendered as a compact task
// list. Read-only mirroring of durable state; nothing here drives the runtime.
const STATUS_ICON = { done: Check, failed: XIcon, cancelled: Ban, running: Loader2 };

export default function AgentStepList({ steps }) {
  if (!steps || steps.length === 0) {
    return <p className="text-[11.5px] text-muted-foreground/60">No steps yet.</p>;
  }
  return (
    <ol className="space-y-1">
      {steps.map((s) => {
        const Icon = STATUS_ICON[s.status] || Loader2;
        const failed = s.status === "failed" || s.status === "cancelled";
        return (
          <li key={s.id} className="flex items-start gap-2 text-[11.5px] leading-snug">
            <Icon
              className={`h-3 w-3 mt-[3px] shrink-0 ${s.status === "running" ? "animate-spin text-muted-foreground" : failed ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="font-mono text-muted-foreground/70">{s.step_number}</span>{" "}
              <span className="text-muted-foreground">{s.action_type || s.tool || "step"}</span>
              {s.summary && <span className="text-foreground/90"> — {s.summary}</span>}
              {!s.summary && s.error_code && <span className="text-destructive"> — {s.error_code}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}