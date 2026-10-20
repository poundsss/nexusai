import React, { useCallback, useEffect, useState } from "react";
import { Loader2, CalendarDays } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import GrowProjectPicker from "@/components/growthagent/GrowProjectPicker";
import TikTokPublishing from "@/components/growthagent/TikTokPublishing";
import TikTokStatusButton from "@/components/growthagent/TikTokStatusButton";

// Grow Social Calendar — a read-only, project-scoped projection of the project's existing
// ViralityScheduledPost records (ONE calendar per project — the rows ARE the calendar). Every
// field below is shown VERBATIM from the stored row: its platform, title, scheduled instant,
// plan hook and lifecycle status as stored (proposal, scheduled, publishing, posted, failed,
// publish_outcome_unknown, needs_reconnect — statuses are never rewritten or renamed).
// This surface reads only — it never creates, edits, deletes, publishes or touches providers.
const STATUS_TONE = {
  proposal: "text-muted-foreground",
  scheduled: "text-[#2563eb] dark:text-[#60a5fa]",
  publishing: "text-amber-600 dark:text-amber-300",
  posted: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-300",
  publish_outcome_unknown: "text-amber-600 dark:text-amber-300",
  needs_reconnect: "text-amber-600 dark:text-amber-300",
  not_materialized_plan_limit: "text-muted-foreground",
};

export default function GrowCalendar({ workspace }) {
  const [projectId, setProjectId] = useState(null);
  const [posts, setPosts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // One page of the project's calendar, next scheduled first — read on the server, never filtered in JS.
  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      const page = await base44.entities.ViralityScheduledPost.filter(
        { project_id: pid },
        { sort: "scheduled_at", limit: 50 });
      setPosts(page.items || []);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not load the social calendar");
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (projectId) load(projectId); }, [projectId, load]);
  useEffect(() => {
    if (!projectId) return;
    return base44.entities.ViralityScheduledPost.subscribe((event) => {
      if (event.data?.platform === "tiktok" && event.data?.project_id === projectId) load(projectId);
    });
  }, [projectId, load]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-8">
      <GrowProjectPicker workspace={workspace} projectId={projectId} onChange={(v) => { setProjectId(v); setPosts(null); }} label="Project" />
      {projectId && <TikTokPublishing key={projectId} projectId={projectId} onQueued={() => load(projectId)} />}

      {loading ? (
        <div className="py-24 grid place-items-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">{error}</div>
      ) : posts.length === 0 ? (
        <div className="py-20 text-center">
          <CalendarDays className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 text-[15px] font-medium text-foreground">Calendar is empty</p>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground max-w-sm mx-auto leading-relaxed">
            Scheduled posts for this project will appear here — the panel only observes the existing calendar.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {posts.map((p) => (
            <div key={p.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <CalendarDays className="h-3.5 w-3.5 text-[#2563eb] dark:text-[#60a5fa] mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-foreground truncate">{p.title || p.body || "(untitled post)"}</p>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    {p.platform || "—"}
                    {p.hook ? ` · hook: ${p.hook}` : ""}
                    {p.scheduled_at ? ` · ${format(new Date(p.scheduled_at), "MMM d, yyyy HH:mm")}` : ""}
                  </p>
                </div>
                <span className={`shrink-0 text-[11px] font-semibold uppercase ${STATUS_TONE[p.status] || "text-muted-foreground"}`}>{p.status}</span>
              </div>
              {p.platform === "tiktok" && p.tiktok_publish_id && ["publishing", "publish_outcome_unknown", "needs_reconnect"].includes(p.status) && <TikTokStatusButton post={p} onChecked={() => load(projectId)} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}