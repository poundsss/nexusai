import React from "react";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import useGrowDashboardData from "./simple/useGrowDashboardData";
import DashKpis from "./simple/DashKpis";
import DashPerformance from "./simple/DashPerformance";
import DashConnections from "./simple/DashConnections";
import DashActivity from "./simple/DashActivity";
import DashBriefs from "./briefs/DashBriefs";

// Minimal Grow Overview: metrics, performance, connections (+ compact activity). Real data only.
export default function GrowProjectDashboard({ workspace, projectId, onProjectChange, onBack, onConfigure }) {
  const { data, loading, reload } = useGrowDashboardData(projectId);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-4xl space-y-3 px-4 pt-4 pb-10 sm:px-6">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] text-foreground hover:bg-accent">
            <ArrowLeft className="h-3.5 w-3.5" /> Chat
          </button>
          <h1 className="text-[16px] font-semibold text-foreground">Grow Overview</h1>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={reload} title="Refresh" className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground hover:bg-accent">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {!projectId ? (
          <p className="rounded-lg border border-border bg-card px-3 py-6 text-center text-[13px] text-muted-foreground">Select a project to see its data.</p>
        ) : loading || !data ? (
          <div className="grid place-items-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <DashKpis channels={data.channels} />
            <DashPerformance channels={data.channels} />
            <DashBriefs key={projectId} projectId={projectId} />
            <div className="grid gap-3 md:grid-cols-2">
              <DashConnections channels={data.channels} onConfigure={onConfigure} projectId={projectId} onChanged={reload} />
              <DashActivity leads={data.leads} calls={data.calls} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}