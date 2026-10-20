import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { AGENT_TERMINAL } from "@/hooks/useAgentRun";

const TONE = {
  COMPLETED: "text-emerald-600 dark:text-emerald-400",
  FAILED: "text-destructive",
  CANCELLED: "text-muted-foreground",
  STALE: "text-amber-600 dark:text-amber-400",
};

// Sub-agent task panel for ONE parent goal run (the documented sub-agents surface): the parent's
// delegated background tasks, each with its status badge and result, read straight from the
// persisted child AgentRun rows. Rendered inside the parent's expanded row.
export default function ChildRunsList({ parentRunId }) {
  const [children, setChildren] = useState(null);

  useEffect(() => {
    let alive = true;
    base44.entities.AgentRun.filter({ parent_agent_run_id: parentRunId }, { sort: "-created_date", limit: 10 })
      .then((p) => { if (alive) setChildren(p.items || []); })
      .catch(() => { if (alive) setChildren([]); });
    return () => { alive = false; };
  }, [parentRunId]);

  if (!children) {
    return (
      <div className="flex items-center gap-1.5 py-1 text-[11.5px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />Loading sub-agent tasks…
      </div>
    );
  }
  if (!children.length) return null;
  return (
    <div className="rounded-md border border-border bg-background/60 p-2">
      <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        Sub-agent tasks ({children.length})
      </p>
      <div className="space-y-1">
        {children.map((c) => (
          <div key={c.id} className="flex items-start gap-2 text-[11.5px]">
            {AGENT_TERMINAL.includes(c.status)
              ? <span className={`shrink-0 text-[10px] font-semibold uppercase ${TONE[c.status] || "text-muted-foreground"}`}>{c.status.toLowerCase()}</span>
              : <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{c.goal}</span>
              {c.result_summary && <span className="block truncate text-muted-foreground">{c.result_summary}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}