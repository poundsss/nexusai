import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Users, Mail, Ear, Radar, PenLine, LifeBuoy } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import { formatDistanceToNow } from "date-fns";

// Grow Overview — the smallest read-only projection of the certified `grow` rollup
// (shared/growStatus.ts). Every number and label below is shown VERBATIM from the rollup:
//   lead_gen {prospects, by_stage} · outreach {jobs} · social_listening
//   {active_terms, observations, latest_observation_at} · aeo {active_probes,
//   measurements, mentions, mention_rate} · social_content {plans, plan_posts}
//   · support {messages, by_status}. No metrics, providers or actions are invented —
//   this surface reads, never mutates, and no live Ads/social action exists here.
const SECTIONS = [
  {
    key: "lead_gen", label: "Lead Gen", icon: Users,
    render: (s) => (
      <>
        <p className="text-[22px] font-semibold leading-none">{s.prospects}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">prospects in the pipeline</p>
        {Object.keys(s.by_stage || {}).length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {Object.entries(s.by_stage).map(([stage, n]) => (
              <span key={stage} className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-foreground/70">
                {stage}: {n}
              </span>
            ))}
          </div>
        )}
      </>
    ),
  },
  {
    key: "outreach", label: "Cold Email", icon: Mail,
    render: (s) => (
      <>
        <p className="text-[22px] font-semibold leading-none">{s.jobs}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">scheduled outreach jobs</p>
      </>
    ),
  },
  {
    key: "social_listening", label: "Social Listening", icon: Ear,
    render: (s) => (
      <>
        <p className="text-[22px] font-semibold leading-none">{s.active_terms}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">active terms · {s.observations} observations</p>
        <p className="mt-2.5 text-[11.5px] text-muted-foreground">
          latest observation: {s.latest_observation_at ? formatDistanceToNow(new Date(s.latest_observation_at), { addSuffix: true }) : "—"}
        </p>
      </>
    ),
  },
  {
    key: "aeo", label: "AEO", icon: Radar,
    render: (s) => (
      <>
        <p className="text-[22px] font-semibold leading-none">
          {s.mention_rate === null || s.mention_rate === undefined ? "—" : `${s.mention_rate}%`}
        </p>
        <p className="mt-1 text-[12px] text-muted-foreground">mention rate</p>
        <p className="mt-2.5 text-[11.5px] text-muted-foreground">{s.active_probes} active probes · {s.measurements} measurements · {s.mentions} mentions</p>
      </>
    ),
  },
  {
    key: "social_content", label: "Social Content", icon: PenLine,
    render: (s) => (
      <>
        <p className="text-[22px] font-semibold leading-none">{s.plans}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">plans · {s.plan_posts} planned posts</p>
      </>
    ),
  },
  {
    key: "support", label: "Support", icon: LifeBuoy,
    render: (s) => (
      <>
        <p className="text-[22px] font-semibold leading-none">{s.messages}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">outbound support messages</p>
        {Object.keys(s.by_status || {}).length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {Object.entries(s.by_status).map(([st, n]) => (
              <span key={st} className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-foreground/70">
                {st}: {n}
              </span>
            ))}
          </div>
        )}
      </>
    ),
  },
];

const isEmpty = (s) =>
  !s ||
  (s.lead_gen.prospects === 0 && s.outreach.jobs === 0 && s.social_listening.active_terms === 0
    && s.social_listening.observations === 0 && s.aeo.active_probes === 0 && s.aeo.measurements === 0
    && s.social_content.plans === 0 && s.social_content.plan_posts === 0 && s.support.messages === 0);

// Grow Overview — the same dark screen pattern as the chat surface. The rollup is
// project-scoped: standalone it picks the workspace's project (most recent first); when a
// projectId is passed (the project Dashboard), THAT project is authoritative and the internal
// picker is hidden — the composer's selection rules this view.
export default function GrowOverview({ workspace, projectId: externalProjectId }) {
  const [projects, setProjects] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unauthorized, setUnauthorized] = useState(false);

  // The exact call the surface makes: the certified member-authorized `grow` endpoint.
  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    setUnauthorized(false);
    try {
      const res = await base44.functions.invoke("grow", { project_id: pid });
      setStatus(res.data || null);
    } catch (e) {
      const code = e?.response?.data?.code;
      if (e?.response?.status === 403 || code === "NOT_A_MEMBER") setUnauthorized(true);
      else setError(e?.response?.data?.error || e?.message || "Could not load the growth overview");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // The workspace's projects, most recent first — the only projects the surface offers.
  useEffect(() => {
    if (!workspace) return;
    workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50, fields: ["id", "name"] })
      .then((d) => {
        const items = d.projects || [];
        setProjects(items);
        setProjectId((cur) => cur || items[0]?.id || null);
      })
      .catch(() => setProjects([]));
  }, [workspace]);

  useEffect(() => {
    const pid = externalProjectId || projectId;
    if (pid) load(pid);
  }, [externalProjectId, projectId, load]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-8">
      {/* Project scope — the rollup is project-scoped; no other scope exists. */}
      {!externalProjectId && Array.isArray(projects) && projects.length > 0 && (
        <div className="mb-5 flex items-center gap-2.5">
          <label htmlFor="grow-overview-project" className="text-[12.5px] text-muted-foreground shrink-0">Project</label>
          <select
            id="grow-overview-project"
            value={projectId || ""}
            onChange={(e) => { setProjectId(e.target.value); setStatus(null); }}
            className="max-w-[16rem] rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px] text-foreground outline-none focus:border-foreground/30"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id} className="bg-background text-foreground">{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="py-24 grid place-items-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : unauthorized ? (
        <div className="rounded-xl border border-border bg-muted/50 px-5 py-10 text-center">
          <p className="text-[15px] font-medium text-foreground">Not authorized</p>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">You don't have access to this project's growth overview.</p>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">{error}</div>
      ) : isEmpty(status) ? (
        <div className="py-20 text-center">
          <p className="text-[15px] font-medium text-foreground">Nothing in the loop yet</p>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground max-w-sm mx-auto leading-relaxed">
            An empty loop is a valid state — start with the Growth Agent chat to add leads, listening terms or probes.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SECTIONS.map(({ key, label, icon: Icon, render }) => (
            <div key={key} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <Icon className="h-3.5 w-3.5 text-[#2563eb] dark:text-[#60a5fa]" />
                <span className="text-[12.5px] font-medium text-foreground">{label}</span>
              </div>
              {render(status[key])}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}