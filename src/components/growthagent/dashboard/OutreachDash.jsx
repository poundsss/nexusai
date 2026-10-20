import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, ConfigureButton, Verbatim, UNAVAILABLE, fmtInt, fmtWhen, isStale } from "./dashBits";

// Cold Outreach dashboard — the two DIFFERENT run families, each with its own contract:
//  • Cold emailing: the project's idempotent outreach steps (BackgroundJob, grow.outreach_email).
//  • Cold calling: the persisted ColdCall lifecycle + the fail-closed telephony boundary status.
// Nothing here schedules, dials or sends — every launch goes through the existing config dialog.
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function OutreachDash({ projectId, onConfigure, reloadKey }) {
  const [steps, setSteps] = useState(null);
  const [calls, setCalls] = useState(null);
  const [telephony, setTelephony] = useState(null);
  const [report, setReport] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setErrors({});
    const [jobs, callRows, status, rep] = await Promise.allSettled([
      base44.entities.BackgroundJob.filter({ project_id: pid, job_type: "grow.outreach_email" }, { sort: "-created_date", limit: 50 }),
      base44.entities.ColdCall.filter({ project_id: pid }, { sort: "-created_date", limit: 50 }),
      base44.functions.invoke("coldCalling", { action: "status" }),
      base44.functions.invoke("coldCalling", { action: "report", project_id: pid }),
    ]);
    setSteps(jobs.status === "fulfilled" ? (jobs.value.items || []) : null);
    setCalls(callRows.status === "fulfilled" ? (callRows.value.items || []) : null);
    setTelephony(status.status === "fulfilled" ? status.value.data : null);
    setReport(rep.status === "fulfilled" ? rep.value.data : null);
    setErrors({
      jobs: jobs.status === "rejected" ? errOf(jobs.reason) : null,
      calls: callRows.status === "rejected" ? errOf(callRows.reason) : null,
      report: rep.status === "rejected" ? errOf(rep.reason) : null,
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  return (
    <div className="min-w-0">
      <div className="mb-5 flex flex-wrap gap-1.5">
        <ConfigureButton onClick={() => onConfigure("cold_emailing")} />
        <ConfigureButton onClick={() => onConfigure("cold_calling")} />
      </div>

      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Section title="Cold email steps (persisted queue rows)">
            {errors.jobs ? <StateNote tone="error" title="Outreach steps unavailable" detail={errors.jobs} />
              : !steps ? null
              : steps.length === 0 ? <StateNote tone="empty" title="No email steps scheduled" detail="Zero is a real count." />
              : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <table className="w-full text-[12px]">
                    <thead><tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Subject</th><th className="px-3 py-2 font-medium">Step</th>
                      <th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 text-right font-medium">Attempts</th>
                      <th className="px-3 py-2 font-medium">Due</th><th className="px-3 py-2 font-medium">Last error</th>
                    </tr></thead>
                    <tbody>
                      {steps.map((j) => (
                        <tr key={j.id} className="border-b border-border/60 last:border-0">
                          <td className="max-w-[12rem] truncate px-3 py-2 text-foreground">{j.payload?.subject || UNAVAILABLE}</td>
                          <td className="px-3 py-2 text-muted-foreground">{j.payload?.step_index ?? UNAVAILABLE}</td>
                          <td className="px-3 py-2">{j.status}</td>
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

          <Section title="Cold calls (persisted lifecycle)" right={telephony ? <Verbatim value={telephony.code} /> : null}>
            {errors.calls ? <StateNote tone="error" title="Calls unavailable" detail={errors.calls} />
              : !calls ? null
              : calls.length === 0 ? <StateNote tone="empty" title="No calls scheduled" detail="Zero is a real count." />
              : (
                <div className="space-y-2">
                  {calls.map((c) => (
                    <div key={c.id} className="rounded-lg border border-border bg-card px-3 py-2.5 text-[12px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{c.status}</span>
                        <span className="text-muted-foreground">attempts: {fmtInt(c.attempts)}</span>
                        <span className="text-muted-foreground">log entries: {fmtInt((c.attempt_log || []).length)}</span>
                        <span className="text-muted-foreground">{c.script ? "script on file" : "no script"}</span>
                        <span className="ml-auto text-muted-foreground">{fmtWhen(c.scheduled_at || c.created_date)}{isStale(c.scheduled_at || c.created_date) && (c.status === "scheduled" || c.status === "dialing") ? " · stale" : ""}</span>
                      </div>
                      {c.blocker_code && <p className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-300">blocker · <Verbatim value={c.blocker_code} /></p>}
                    </div>
                  ))}
                </div>
              )}
            {errors.report ? <div className="mt-2"><StateNote tone="error" title="Call report unavailable" detail={errors.report} /></div>
              : report ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(report.rows || []).map((r, i) => (
                    <Stat key={i} label={`Calls · ${r.status || UNAVAILABLE}`} value={fmtInt(r.count)} hint={r.sum_attempts != null ? `${fmtInt(r.sum_attempts)} dial attempts` : null} />
                  ))}
                  {telephony && <Stat label="Telephony transport" value={telephony.available ? "available" : "refused"} hint={telephony.blocker || telephony.code || null} />}
                </div>
              ) : null}
          </Section>
        </>
      )}
    </div>
  );
}