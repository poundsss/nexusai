import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, Phone } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { formatDistanceToNow } from "date-fns";
import GrowProjectPicker from "@/components/growthagent/GrowProjectPicker";

// Grow Outreach — a read-only, project-scoped projection of the certified cold-email pipeline
// (shared/outreach.ts). The steps ARE the project's `grow.outreach_email` BackgroundJob rows;
// every field below is shown VERBATIM from the stored row: its queue status, the scheduled step
// index, the subject as written, completed attempts and, for failed steps, the safe last_error.
// This surface reads only — it never schedules a step and never sends anything.
const STATUS_TONE = {
  pending: "text-amber-600 dark:text-amber-300",
  leased: "text-[#2563eb] dark:text-[#60a5fa]",
  succeeded: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-300",
  dead_letter: "text-red-600 dark:text-red-300",
  cancelled: "text-muted-foreground",
};

export default function GrowOutreach({ workspace }) {
  const [projectId, setProjectId] = useState(null);
  const [steps, setSteps] = useState(null);
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // One page of the project's outreach jobs, newest first — read on the server, never filtered in JS.
  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    try {
      const page = await base44.entities.BackgroundJob.filter(
        { project_id: pid, job_type: "grow.outreach_email" },
        { sort: "-created_date", limit: 50 });
      setSteps(page.items || []);
      const callPage = await base44.entities.ColdCall.filter({ project_id: pid }, { sort: "-created_date", limit: 50 }).catch(() => ({ items: [] }));
      setCalls(callPage.items || []);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not load the outreach steps");
      setSteps([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (projectId) load(projectId); }, [projectId, load]);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-8 pb-8">
      <GrowProjectPicker workspace={workspace} projectId={projectId} onChange={(v) => { setProjectId(v); setSteps(null); setCalls([]); }} />

      {loading ? (
        <div className="py-24 grid place-items-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-[12.5px] text-destructive">{error}</div>
      ) : steps.length === 0 ? (
        <div className="py-20 text-center">
          <Mail className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 text-[15px] font-medium text-foreground">No outreach steps yet</p>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground max-w-sm mx-auto leading-relaxed">
            Scheduled cold-email steps will appear here — the panel only observes the existing queue.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {calls.length > 0 && (
            <div className="space-y-2.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Cold Calling</p>
              {calls.map((c) => (
                <div key={c.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start gap-3">
                    <Phone className="h-3.5 w-3.5 text-[#2563eb] dark:text-[#60a5fa] mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-foreground truncate">{c.summary || "Call for a project lead"}</p>
                      <p className="mt-1 text-[11.5px] text-muted-foreground truncate">{c.script || ""}</p>
                      {c.blocker_code && <p className="mt-1.5 text-[11.5px] text-red-600 dark:text-red-300 truncate">Refused at the transport: {c.blocker_code}</p>}
                    </div>
                    <span className={`shrink-0 text-[11px] font-semibold uppercase ${STATUS_TONE[c.status === "failed" ? "failed" : c.status === "canceled" ? "cancelled" : "pending"] || "text-muted-foreground"}`}>{c.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {steps.map((j) => (
            <div key={j.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start gap-3">
                <Mail className="h-3.5 w-3.5 text-[#2563eb] dark:text-[#60a5fa] mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-foreground truncate">{j.payload?.subject || "(no subject)"}</p>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    Step {j.payload?.step_index ?? 0} · {j.attempts ?? 0}/{j.max_attempts} attempts
                    {j.available_at ? ` · available ${formatDistanceToNow(new Date(j.available_at), { addSuffix: true })}` : ""}
                  </p>
                  {j.last_error && <p className="mt-1.5 text-[11.5px] text-red-600 dark:text-red-300 truncate">{j.last_error}</p>}
                </div>
                <span className={`shrink-0 text-[11px] font-semibold uppercase ${STATUS_TONE[j.status] || "text-muted-foreground"}`}>{j.status}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}