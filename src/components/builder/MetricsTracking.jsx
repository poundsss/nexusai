import React, { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, Gauge, CircleOff, Clock3 } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Metrics tracking — MINIMAL READ-ONLY section over the marketingPlan endpoint's `metrics`
// action: current values derived on demand from the project's existing analytics events.
// Documented states only: Not tracked yet · Tracking added — waiting for the first event ·
// measured (current value, window). No history, no refresh jobs, no credits.
const STATUS_BADGES = {
  not_tracked: { label: "Not tracked yet", cls: "bg-muted text-muted-foreground" },
  waiting_first_event: { label: "Tracking added — waiting for the first event", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  measured: { label: "Measured", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
};

export default function MetricsTracking({ projectId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await base44.functions.invoke("marketingPlan", { action: "metrics", project_id: projectId });
      setData(res.data || null);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Gauge className="h-3.5 w-3.5" />Metrics tracking
        </h3>
        <span className="text-[10.5px] text-muted-foreground/60">read-only · from your app's analytics events</span>
      </div>

      {loading ? (
        <div className="p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>
      ) : error ? (
        <div className="flex items-start gap-2 p-3 text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="text-[12px]">{error}</div>
        </div>
      ) : !data || !data.metrics.length ? (
        <p className="p-3 text-[12px] text-muted-foreground/60">No marketing plan yet.</p>
      ) : (
        <div className="divide-y divide-border">
          {data.metrics.map((m, i) => {
            const badge = STATUS_BADGES[m.status] || STATUS_BADGES.not_tracked;
            const mapped = !!m.event_name;
            return (
              <div key={i} className="px-3 py-2.5 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{m.name}</span>
                  {m.status === "measured" && <span className="shrink-0 font-mono text-[12.5px] font-semibold">{m.current_value}</span>}
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span>
                </div>
                <p className="text-[11px] text-muted-foreground/70">Target: {m.target || "—"}</p>
                {m.progress_pct != null && (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, m.progress_pct))}%` }} />
                  </div>
                )}
                {m.status === "not_tracked" && (
                  <p className="flex items-start gap-1 text-[11px] text-muted-foreground/60">
                    <CircleOff className="mt-0.5 h-3 w-3 shrink-0" />
                    No analytics event in this app deterministically measures this metric — add tracking before it can collect data.
                  </p>
                )}
                {m.status === "waiting_first_event" && (
                  <p className="flex items-start gap-1 text-[11px] text-muted-foreground/60">
                    <Clock3 className="mt-0.5 h-3 w-3 shrink-0" />
                    The event this metric measures has not been recorded yet. Publish your app to start recording events — the first data can take more than an hour.
                  </p>
                )}
                {mapped && m.status === "measured" && (
                  <p className="text-[10.5px] text-muted-foreground/50">
                    Event “{m.event_name}” · {m.metric_type === "conversion" ? "conversions" : "count"} · last {m.window_days} days
                  </p>
                )}
              </div>
            );
          })}
          <p className="px-3 py-2 text-[10.5px] text-muted-foreground/50">
            Values are derived on demand from analytics events within your app's retention ({data.horizon_days} days) — no history is stored and no credits are charged.
          </p>
        </div>
      )}
    </div>
  );
}