import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { formatDistanceToNow } from "date-fns";
import GrowProjectPicker from "@/components/growthagent/GrowProjectPicker";

// Grow Report — the read-only reporting projection of the certified `grow` rollup
// (shared/growStatus.ts). Every line below is shown VERBATIM from the rollup — all six
// capabilities, every field, including the by_stage/by_status maps and the computed mention
// rate — so the report is exactly what the backend measured for the selected project, and
// nothing else. Aggregation only: this surface reads, never mutates.
export default function GrowReport({ workspace }) {
  const [projectId, setProjectId] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // The exact call the panel makes: the certified member-authorized `grow` endpoint.
  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("grow", { project_id: pid });
      setStatus(res.data || null);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not load the growth report");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (projectId) load(projectId); }, [projectId, load]);

  const ROWS = status ? [
    ["Lead Gen", "prospects in the pipeline", status.lead_gen.prospects,
      Object.keys(status.lead_gen.by_stage || {}).length
        ? Object.entries(status.lead_gen.by_stage).map(([s, n]) => `${s}: ${n}`).join(" · ")
        : null],
    ["Cold Email", "scheduled outreach jobs", status.outreach.jobs, null],
    ["Social Listening", "active terms", status.social_listening.active_terms,
      `${status.social_listening.observations} observations · latest observation ${status.social_listening.latest_observation_at ? formatDistanceToNow(new Date(status.social_listening.latest_observation_at), { addSuffix: true }) : "—"}`],
    ["AEO", "active probes", status.aeo.active_probes,
      `${status.aeo.measurements} measurements · ${status.aeo.mentions} mentions · mention rate ${status.aeo.mention_rate === null || status.aeo.mention_rate === undefined ? "—" : `${status.aeo.mention_rate}%`}`],
    ["Social Content", "content plans", status.social_content.plans,
      `${status.social_content.plan_posts} planned posts`],
    ["Support", "outbound support messages", status.support.messages,
      Object.keys(status.support.by_status || {}).length
        ? Object.entries(status.support.by_status).map(([s, n]) => `${s}: ${n}`).join(" · ")
        : null],
  ] : [];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-8">
      <GrowProjectPicker workspace={workspace} projectId={projectId} onChange={(v) => { setProjectId(v); setStatus(null); }} />

      {loading ? (
        <div className="py-24 grid place-items-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">{error}</div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-[14px] font-semibold text-foreground">Growth report</h2>
          <p className="mt-1 text-[11.5px] text-muted-foreground font-mono truncate">
            project {status?.project_id || "—"} · workspace {status?.workspace_id || "—"}
          </p>
          <div className="mt-4 divide-y divide-border">
            {ROWS.map(([name, subtitle, value, detail]) => (
              <div key={name} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-foreground">{name}</p>
                  <p className="text-[11.5px] text-muted-foreground">{subtitle}</p>
                  {detail && <p className="mt-0.5 text-[11.5px] text-muted-foreground">{detail}</p>}
                </div>
                <span className="shrink-0 text-[18px] font-semibold text-foreground">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}