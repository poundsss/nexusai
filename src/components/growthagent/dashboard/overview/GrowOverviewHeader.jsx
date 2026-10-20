import React from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

// Header: title, the composer-selected project's name, the chosen date range, the freshness
// indicator (stale when the newest ad report is older than 3 days) and refresh.
export default function GrowOverviewHeader({ project, days, onDays, loading, stale, onRefresh, loadingLabel }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[16px] font-semibold text-foreground">Grow Dashboard</h2>
        <p className="truncate text-[12px] text-muted-foreground">{project ? project.name : "Select a project"}</p>
      </div>
      {stale && !loading && (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3 w-3" /> Stale data
        </span>
      )}
      <select value={days} onChange={(e) => onDays(Number(e.target.value))} aria-label="Date range"
        className="rounded-lg border border-border bg-card px-2 py-1.5 text-[12px] text-foreground outline-none">
        <option value={7}>Last 7 days</option>
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
      </select>
      <button type="button" onClick={onRefresh} title="Refresh"
        className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
      </button>
      {loadingLabel ? <span className="text-[11px] text-muted-foreground">{loadingLabel}</span> : null}
    </div>
  );
}