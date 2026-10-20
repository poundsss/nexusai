import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, Funnel, ConfigureButton, Verbatim, UNAVAILABLE, fmtInt, fmtWhen } from "./dashBits";

// Email module of the project Dashboard — cold-email outreach steps, read through the EXISTING
// certified surfaces: the `outreach` list + a server-side BackgroundJob aggregate. Metrics are
// ONLY the job outcomes that exist (scheduled / sent / failed). Opens and replies are NOT part
// of the certified contract and are never shown — no open metric may be assumed reliable.
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function GrowEmailModulePanel({ projectId, onConfigure, reloadKey }) {
  const [jobs, setJobs] = useState(null);
  const [counts, setCounts] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setErrors({});
    const [list, agg] = await Promise.allSettled([
      base44.functions.invoke("outreach", { action: "list", project_id: pid, limit: 100 }),
      base44.entities.BackgroundJob.aggregate({ query: { project_id: pid, job_type: "grow.outreach_email" }, groupBy: "status" }),
    ]);
    setJobs(list.status === "fulfilled" ? (list.value.data?.jobs || []) : null);
    setCounts(agg.status === "fulfilled" ? (agg.value.rows || []) : null);
    setErrors({
      list: list.status === "rejected" ? errOf(list.reason) : null,
      agg: agg.status === "rejected" ? errOf(agg.reason) : null,
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  const byStatus = {};
  (counts || []).forEach((r) => { byStatus[r.status || UNAVAILABLE] = r.count; });
  const scheduled = (counts || []).reduce((a, r) => a + Number(r.count || 0), 0);
  const sent = Number(byStatus.succeeded || 0);
  const failed = Number(byStatus.dead_letter || 0);
  const inflight = Number(byStatus.pending || 0) + Number(byStatus.leased || 0);
  const cancelled = Number(byStatus.cancelled || 0);

  return (
    <div className="min-w-0">
      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : !projectId ? null : (
        <>
          {errors.agg ? <StateNote tone="error" title="Email metrics unavailable" detail={errors.agg} />
            : scheduled === 0 ? (
              <StateNote tone="empty" title="No email steps scheduled" detail="Zero is a real count — nothing was sent. Schedule through Configure / launch." />
            ) : null}

          {scheduled > 0 && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Steps scheduled" value={fmtInt(scheduled)} />
                <Stat label="Sent" value={fmtInt(sent)} hint="job succeeded" />
                <Stat label="In flight" value={fmtInt(inflight)} hint="pending or leased" />
                <Stat label="Failed" value={fmtInt(failed)} hint={cancelled > 0 ? `${cancelled} cancelled` : "dead-lettered"} />
              </div>
              <Section title="Performance funnel">
                <Funnel stages={[
                  { label: "Scheduled", value: scheduled },
                  { label: "Sent", value: sent },
                ]} />
                <p className="mt-2 text-[11.5px] text-muted-foreground">
                  Opens and replies are not part of the certified outreach contract — no open metrics are shown.
                </p>
              </Section>
            </>
          )}

          <Section title="Available actions (read-only)">
            <div className="flex flex-wrap items-center gap-2">
              <ConfigureButton onClick={() => onConfigure("cold_emailing")} />
              <span className="text-[11.5px] text-muted-foreground">
                Nothing sends from the dashboard — scheduling stays in the certified outreach flow.
              </span>
            </div>
          </Section>

          <Section title="Outreach steps (persisted queue rows)">
            {errors.list ? <StateNote tone="error" title="Outreach steps unavailable" detail={errors.list} />
              : !jobs ? null
              : jobs.length === 0 ? <StateNote tone="empty" title="No email steps scheduled" detail="Zero is a real count." />
              : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <table className="w-full text-[12px]">
                    <thead><tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Step</th><th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 text-right font-medium">Attempts</th>
                      <th className="px-3 py-2 font-medium">Due</th><th className="px-3 py-2 font-medium">Last error</th>
                    </tr></thead>
                    <tbody>
                      {jobs.map((j) => (
                        <tr key={j.id} className="border-b border-border/60 last:border-0">
                          <td className="px-3 py-2 text-muted-foreground">{j.step_index ?? UNAVAILABLE}</td>
                          <td className="px-3 py-2 text-foreground">{j.status}</td>
                          <td className="px-3 py-2 text-right">{fmtInt(j.attempts)}</td>
                          <td className="px-3 py-2 text-muted-foreground">{fmtWhen(j.available_at)}</td>
                          <td className="px-3 py-2"><Verbatim value={j.last_error} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Section>
        </>
      )}
    </div>
  );
}