import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, Funnel, ConfigureButton, Verbatim, UNAVAILABLE, fmtInt, fmtWhen, isStale } from "./dashBits";

// Cold Calling module of the project Dashboard — the persisted ColdCall lifecycle read through
// the EXISTING certified surfaces: coldCalling status + report (server-side aggregate) and the
// project's call rows. Nothing schedules, dials or retries here; the dial transport stays
// fail-closed and its refusal is shown verbatim, never smoothed into a success.
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function GrowCallsModulePanel({ projectId, onConfigure, reloadKey }) {
  const [calls, setCalls] = useState(null);
  const [report, setReport] = useState(null);
  const [telephony, setTelephony] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setErrors({});
    const [rows, rep, status] = await Promise.allSettled([
      base44.entities.ColdCall.filter({ project_id: pid }, { sort: "-created_date", limit: 50 }),
      base44.functions.invoke("coldCalling", { action: "report", project_id: pid }),
      base44.functions.invoke("coldCalling", { action: "status" }),
    ]);
    setCalls(rows.status === "fulfilled" ? (rows.value.items || []) : null);
    setReport(rep.status === "fulfilled" ? rep.value.data : null);
    setTelephony(status.status === "fulfilled" ? status.value.data : null);
    setErrors({
      calls: rows.status === "rejected" ? errOf(rows.reason) : null,
      report: rep.status === "rejected" ? errOf(rep.reason) : null,
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  const byStatus = {};
  (report?.rows || []).forEach((r) => { byStatus[r.status || UNAVAILABLE] = { count: Number(r.count || 0), attempts: Number(r.sum_attempts || 0) }; });
  const total = (report?.rows || []).reduce((a, r) => a + Number(r.count || 0), 0);
  const dialAttempts = (report?.rows || []).reduce((a, r) => a + Number(r.sum_attempts || 0), 0);
  const scheduled = byStatus.scheduled?.count || 0;
  const dialing = byStatus.dialing?.count || 0;
  const failed = byStatus.failed?.count || 0;
  const canceled = byStatus.canceled?.count || 0;
  const unknown = byStatus.outcome_unknown?.count || 0;
  const dialed = dialing + failed + unknown; // dialed = ever left `scheduled` through a dial attempt
  const resolved = failed + canceled + unknown;

  return (
    <div className="min-w-0">
      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : !projectId ? null : (
        <>
          {errors.report ? <StateNote tone="error" title="Call metrics unavailable" detail={errors.report} />
            : total === 0 ? (
              <StateNote tone="empty" title="No calls scheduled" detail="Zero is a real count — nothing was dialed." />
            ) : null}

          {total > 0 && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Calls" value={fmtInt(total)} />
                <Stat label="Dial attempts" value={fmtInt(dialAttempts)} />
                <Stat label="Failed / refused" value={fmtInt(failed)} hint={unknown > 0 ? `${unknown} outcome unknown` : null} />
                <Stat label="Cancelled" value={fmtInt(canceled)} hint={scheduled > 0 ? `${scheduled} still scheduled` : null} />
              </div>
              <Section title="Performance funnel">
                <Funnel stages={[
                  { label: "Scheduled", value: total },
                  { label: "Dialed", value: dialed },
                  { label: "Resolved", value: resolved },
                ]} />
                {telephony && !telephony.available && (
                  <p className="mt-2 text-[11.5px] text-amber-700 dark:text-amber-300">
                    Telephony transport refused · <Verbatim value={telephony.code} />{telephony.blocker ? ` — ${telephony.blocker}` : ""}
                  </p>
                )}
              </Section>
            </>
          )}

          <Section title="Available actions (read-only)">
            <div className="flex flex-wrap items-center gap-2">
              <ConfigureButton onClick={() => onConfigure("cold_calling")} />
              <span className="text-[11.5px] text-muted-foreground">
                Nothing dials from the dashboard — scheduling and scripts stay in the certified cold-calling flow.
              </span>
            </div>
          </Section>

          <Section title="Calls (persisted lifecycle)" right={telephony ? <Verbatim value={telephony.code} /> : null}>
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
                        <span className="text-muted-foreground">{c.script ? "script on file" : "no script"}</span>
                        <span className="ml-auto text-muted-foreground">{fmtWhen(c.scheduled_at || c.created_date)}{isStale(c.scheduled_at || c.created_date) && (c.status === "scheduled" || c.status === "dialing") ? " · stale" : ""}</span>
                      </div>
                      {c.blocker_code && <p className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-300">blocker · <Verbatim value={c.blocker_code} /></p>}
                    </div>
                  ))}
                </div>
              )}
          </Section>
        </>
      )}
    </div>
  );
}