import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, ConfigureButton, UNAVAILABLE, fmtInt, fmtShare, fmtWhen, isStale } from "./dashBits";

// Social Listening dashboard — tracked terms, the deterministic observation report and the
// leadGen prospect list, all through the certified reads. Shares/counts come ONLY from stored
// observations; the report's generated_at drives the staleness badge.
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function ListeningDash({ projectId, onConfigure, reloadKey }) {
  const [terms, setTerms] = useState(null);
  const [report, setReport] = useState(null);
  const [prospects, setProspects] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setErrors({});
    const [t, rep, p] = await Promise.allSettled([
      base44.functions.invoke("listen", { action: "term_list", project_id: pid }),
      base44.functions.invoke("listen", { action: "report", project_id: pid, since_days: 7 }),
      base44.functions.invoke("leadGen", { action: "list", project_id: pid }),
    ]);
    setTerms(t.status === "fulfilled" ? (t.value.data.terms || []) : null);
    setReport(rep.status === "fulfilled" ? rep.value.data : null);
    setProspects(p.status === "fulfilled" ? (p.value.data.prospects || []) : null);
    setErrors({
      terms: t.status === "rejected" ? errOf(t.reason) : null,
      report: rep.status === "rejected" ? errOf(rep.reason) : null,
      prospects: p.status === "rejected" ? errOf(p.reason) : null,
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  return (
    <div className="min-w-0">
      <div className="mb-5 flex flex-wrap gap-1.5">
        <ConfigureButton onClick={() => onConfigure("your_company")} />
        <ConfigureButton onClick={() => onConfigure("competitors")} />
        <ConfigureButton onClick={() => onConfigure("leads")} />
      </div>

      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Section title="Tracked terms">
            {errors.terms ? <StateNote tone="error" title="Terms unavailable" detail={errors.terms} />
              : !terms ? null
              : terms.length === 0 ? <StateNote tone="empty" title="No listening terms tracked" detail="Zero is a real count. Add a term through Configure / launch." />
              : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {terms.map((t) => (
                    <div key={t.id} className="rounded-lg border border-border bg-card px-3 py-2.5 text-[12px]">
                      <p className="font-medium text-foreground">{t.label}</p>
                      <p className="mt-0.5 text-muted-foreground">{t.kind || UNAVAILABLE} · {t.status || UNAVAILABLE} · {fmtInt((t.terms || []).length)} phrases</p>
                    </div>
                  ))}
                </div>
              )}
          </Section>

          <Section title="Observations report (7-day window)" right={report ? <span className="text-[11px] text-muted-foreground">generated {fmtWhen(report.generated_at)}{isStale(report.generated_at, 2) ? " · stale" : ""}</span> : null}>
            {errors.report ? <StateNote tone="error" title="Report unavailable" detail={errors.report} />
              : !report ? null
              : (report.total_observations || 0) === 0 ? <StateNote tone="empty" title="No observations in the window" detail="Zero is a real count — the monitors have recorded nothing in 7 days." />
              : (
                <>
                  <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Stat label="Total observations" value={fmtInt(report.total_observations)} />
                    <Stat label="Window" value={`${fmtInt(report.window_days)} days`} />
                    <Stat label="Terms with data" value={fmtInt((report.terms || []).length)} />
                  </div>
                  <div className="space-y-2">
                    {(report.terms || []).map((g) => (
                      <div key={g.label} className="rounded-lg border border-border bg-card px-3 py-2.5 text-[12px]">
                        <div className="flex items-center gap-2">
                          <p className="min-w-0 flex-1 truncate font-medium text-foreground">{g.label}</p>
                          <span className="text-muted-foreground">{fmtInt(g.count)} obs · share {fmtShare(g.share)}</span>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{(g.top_urls || [])[0] || "no top source"} · last {fmtWhen(g.last_seen)}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}
          </Section>

          <Section title="Lead prospects (leadGen)">
            {errors.prospects ? <StateNote tone="error" title="Prospects unavailable" detail={errors.prospects} />
              : !prospects ? null
              : prospects.length === 0 ? <StateNote tone="empty" title="No prospects yet" detail="Zero is a real count — no lead-generation run has stored contacts." />
              : (
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  <table className="w-full text-[12px]">
                    <thead><tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Company</th>
                      <th className="px-3 py-2 font-medium">Stage</th><th className="px-3 py-2 font-medium">Email</th>
                      <th className="px-3 py-2 text-right font-medium">Deal value</th>
                    </tr></thead>
                    <tbody>
                      {prospects.map((c) => (
                        <tr key={c.id} className="border-b border-border/60 last:border-0">
                          <td className="max-w-[10rem] truncate px-3 py-2 text-foreground">{c.name}</td>
                          <td className="px-3 py-2 text-muted-foreground">{c.company || UNAVAILABLE}</td>
                          <td className="px-3 py-2">{c.status || UNAVAILABLE}</td>
                          <td className="px-3 py-2 text-muted-foreground">{c.email || UNAVAILABLE}</td>
                          <td className="px-3 py-2 text-right">{c.deal_value != null ? fmtInt(c.deal_value) : UNAVAILABLE}</td>
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