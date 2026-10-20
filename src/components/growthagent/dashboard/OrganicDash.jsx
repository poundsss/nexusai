import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, ConfigureButton, Verbatim, UNAVAILABLE, fmtInt, fmtShare, fmtWhen, isStale } from "./dashBits";

// Organic Growth dashboard — the three DIFFERENT organic contracts, each its own section:
//  • SEO audits (SeoScan rows — published-version audits, score/grade as stored);
//  • AEO probes + the deterministic visibility report;
//  • outbound support message history (support surface).
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function OrganicDash({ projectId, onConfigure, reloadKey }) {
  const [scans, setScans] = useState(null);
  const [probes, setProbes] = useState(null);
  const [aeoReport, setAeoReport] = useState(null);
  const [supportMsgs, setSupportMsgs] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setErrors({});
    const [s, pr, rep, sup] = await Promise.allSettled([
      base44.functions.invoke("seoScan", { action: "list", project_id: pid, limit: 20 }),
      base44.functions.invoke("aeo", { action: "probe_list", project_id: pid }),
      base44.functions.invoke("aeo", { action: "report", project_id: pid, since_days: 7 }),
      base44.functions.invoke("support", { action: "history", project_id: pid }),
    ]);
    setScans(s.status === "fulfilled" ? (s.value.data.scans || []) : null);
    setProbes(pr.status === "fulfilled" ? (pr.value.data.probes || []) : null);
    setAeoReport(rep.status === "fulfilled" ? rep.value.data : null);
    setSupportMsgs(sup.status === "fulfilled" ? (sup.value.data.messages || []) : null);
    setErrors({
      scans: s.status === "rejected" ? errOf(s.reason) : null,
      probes: pr.status === "rejected" ? errOf(pr.reason) : null,
      aeoReport: rep.status === "rejected" ? errOf(rep.reason) : null,
      support: sup.status === "rejected" ? errOf(sup.reason) : null,
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  const latest = (scans || [])[0];

  return (
    <div className="min-w-0">
      <div className="mb-5 flex flex-wrap gap-1.5">
        <ConfigureButton onClick={() => onConfigure("seo_audit")} />
        <ConfigureButton onClick={() => onConfigure("aeo")} />
        <ConfigureButton onClick={() => onConfigure("support_mail")} />
      </div>

      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Section title="SEO audits (published production version)">
            {errors.scans ? <StateNote tone="error" title="Audit history unavailable" detail={errors.scans} />
              : !scans ? null
              : scans.length === 0 ? <StateNote tone="empty" title="No audits yet" detail="Zero is a real count. A scan refuses with NOT_PUBLISHED until a production deployment exists — run it through Configure / launch." />
              : (
                <>
                  <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Latest score" value={latest.score ?? UNAVAILABLE} hint={latest.grade ? `grade ${latest.grade}` : null} />
                    <Stat label="Latest status" value={latest.status || UNAVAILABLE} hint={isStale(latest.completed_at) ? "stale" : `completed ${fmtWhen(latest.completed_at)}`} />
                    <Stat label="Audits on file" value={fmtInt(scans.length)} />
                    <Stat label="Files scanned (latest)" value={fmtInt(latest.scanned_files)} />
                  </div>
                  {latest.error ? <StateNote tone="error" title="Latest audit error" detail={<Verbatim value={latest.error} />} /> : null}
                  <div className="space-y-1.5">
                    {scans.slice(0, 8).map((s) => (
                      <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
                        <span className="font-medium text-foreground">{s.score ?? UNAVAILABLE}{s.grade ? ` · ${s.grade}` : ""}</span>
                        <span className="text-muted-foreground">v{s.version_number ?? UNAVAILABLE}</span>
                        <span className="text-muted-foreground">{s.status}</span>
                        <span className="ml-auto text-muted-foreground">{fmtWhen(s.completed_at)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
          </Section>

          <Section title="AEO probes & AI visibility (7-day report)">
            {errors.probes ? <StateNote tone="error" title="Probes unavailable" detail={errors.probes} /> : null}
            {errors.aeoReport ? <StateNote tone="error" title="Visibility report unavailable" detail={errors.aeoReport} />
              : probes && probes.length === 0 ? <StateNote tone="empty" title="No probes yet" detail="Zero is a real count. Add a probe through Configure / launch." />
              : aeoReport ? (
                <>
                  <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Stat label="Overall visibility" value={fmtShare(aeoReport.overall_visibility)} hint={`${fmtInt(aeoReport.total_measurements)} measurements`} />
                    <Stat label="Probes tracked" value={fmtInt((probes || []).length)} />
                    <Stat label="Report generated" value={fmtWhen(aeoReport.generated_at)} hint={isStale(aeoReport.generated_at, 2) ? "stale" : "fresh"} />
                  </div>
                  <div className="space-y-1.5">
                    {(aeoReport.probes || []).map((g) => (
                      <div key={g.probe_id} className="rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
                        <div className="flex items-center gap-2">
                          <p className="min-w-0 flex-1 truncate font-medium text-foreground">{g.question}</p>
                          <span className="text-muted-foreground">visibility {fmtShare(g.visibility)} · best rank {g.best_rank ?? UNAVAILABLE}</span>
                        </div>
                        {g.latest_excerpt ? <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{g.latest_excerpt}</p> : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
          </Section>

          <Section title="Outbound support messages (history)">
            {errors.support ? <StateNote tone="error" title="Support history unavailable" detail={errors.support} />
              : !supportMsgs ? null
              : supportMsgs.length === 0 ? <StateNote tone="empty" title="No outbound messages" detail="Zero is a real count." />
              : (
                <div className="space-y-1.5">
                  {supportMsgs.map((m) => (
                    <div key={m.job_id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{m.subject || "(no subject)"}</span>
                      <span className="text-muted-foreground">{m.status}</span>
                      <span className="text-muted-foreground">attempts {fmtInt(m.attempts)}</span>
                      <span className="text-muted-foreground">{fmtWhen(m.created_at)}</span>
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