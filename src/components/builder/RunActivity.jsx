import React, { useState } from "react";
import { Check, X, Loader2, Circle, Plug, Ban } from "lucide-react";
import { base44 } from "@/api/base44Client";

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];

export default function RunActivity({ run }) {
  const [cancelling, setCancelling] = useState(false);
  if (!run) return null;
  const steps = run.steps || [];
  const active = !TERMINAL.includes(run.status);
  const requested = cancelling || run.cancel_requested;

  // Cancellation is a server-side request: the run stops itself at its next gate, so the browser
  // only asks and then keeps observing the run's state as it already does.
  const cancel = async () => {
    if (!run.id) return;
    setCancelling(true);
    await base44.functions.invoke("cancelRun", { run_id: run.id }).catch(() => setCancelling(false));
  };
  const mcpCalls = (run.tool_log || []).filter((t) => t.tool === "mcp_call");
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 text-[12px]">
      <div className="flex items-center gap-2 mb-2">
        {active ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : run.status === "COMPLETED" ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <X className="h-3.5 w-3.5 text-destructive" />}
        <span className="font-medium text-foreground">AI run</span>
        <span className="font-mono text-[10px] text-muted-foreground/60 uppercase">{run.status}</span>
        {run.model && <span className="font-mono text-[10px] text-muted-foreground/60">{run.model}</span>}
        {active && run.id && (
          <button
            onClick={cancel}
            disabled={requested}
            className="ml-auto flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-destructive hover:border-destructive/40 disabled:opacity-50 transition-colors"
          >
            <Ban className="h-3 w-3" />{requested ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {steps.length === 0 && <li className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Starting…</li>}
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5">
              {s.status === "done" ? <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> : s.status === "failed" ? <X className="h-3 w-3 text-destructive" /> : s.status === "running" ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> : <Circle className="h-3 w-3 text-muted-foreground/40" />}
            </span>
            <span className={s.status === "running" ? "text-foreground" : "text-muted-foreground"}>{s.label}</span>
            {s.detail && <span className="ml-auto text-right text-muted-foreground/60 truncate max-w-[45%]">{s.detail}</span>}
          </li>
        ))}
      </ul>
      {mcpCalls.length > 0 && (
        <ul className="mt-2 border-t border-border pt-2 space-y-1">
          {mcpCalls.map((c, i) => (
            <li key={i} className="flex items-center gap-2">
              <Plug className={`h-3 w-3 ${c.ok ? "text-indigo-500 dark:text-indigo-400" : "text-destructive"}`} />
              <span className="text-muted-foreground font-mono text-[11px] truncate">{c.summary.replace(/^MCP: /, "")}</span>
            </li>
          ))}
        </ul>
      )}
      {!active && (run.input_tokens > 0 || run.output_tokens > 0 || run.credits_charged > 0 || run.duration_ms > 0) && (
        <div className="mt-2 border-t border-border pt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60 font-mono">
          {run.input_tokens > 0 && <span>↓ {run.input_tokens.toLocaleString()} in</span>}
          {run.output_tokens > 0 && <span>↑ {run.output_tokens.toLocaleString()} out</span>}
          {run.tool_calls > 0 && <span>⚡ {run.tool_calls} tools</span>}
          {run.credits_charged > 0 && <span className="text-foreground/80 font-semibold">◆ {run.credits_charged.toLocaleString()} credits</span>}
          {run.duration_ms > 0 && <span>⏱ {run.duration_ms >= 1000 ? `${(run.duration_ms / 1000).toFixed(1)}s` : `${run.duration_ms}ms`}</span>}
        </div>
      )}
      {active && run.input_tokens > 0 && (
        <div className="mt-2 border-t border-border pt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60 font-mono">
          {run.input_tokens > 0 && <span>↓ {run.input_tokens.toLocaleString()} in</span>}
          {run.output_tokens > 0 && <span>↑ {run.output_tokens.toLocaleString()} out</span>}
          {run.tool_calls > 0 && <span>⚡ {run.tool_calls} tools</span>}
        </div>
      )}
    </div>
  );
}