import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, ConfigureButton, Verbatim, UNAVAILABLE, fmtInt, fmtWhen } from "./dashBits";

// My Business dashboard — the three infrastructure surfaces under the module, each through its
// certified read: the GBP claim boundary (fail-closed 501 surfaced as status data), the custom
// SENDING domain (emailDomain list), the project's website domains (projectDomains list) and the
// separate public-mention company monitoring (company_get). Nothing here claims or configures.
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function BusinessDash({ projectId, onConfigure, reloadKey }) {
  const [gbp, setGbp] = useState(null);
  const [emailDomains, setEmailDomains] = useState(null);
  const [domains, setDomains] = useState(null);
  const [company, setCompany] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    setErrors({});
    const [g, ed, d, co] = await Promise.allSettled([
      base44.functions.invoke("myBusiness", { action: "status", project_id: pid }),
      base44.functions.invoke("emailDomain", { action: "list", project_id: pid }),
      base44.functions.invoke("projectDomains", { action: "list", project_id: pid }),
      base44.functions.invoke("myBusiness", { action: "company_get", project_id: pid }),
    ]);
    setGbp(g.status === "fulfilled" ? g.value.data : null);
    setEmailDomains(ed.status === "fulfilled" ? (ed.value.data.email_domains || ed.value.data.domains || []) : null);
    setDomains(d.status === "fulfilled" ? (d.value.data.domains || []) : null);
    setCompany(co.status === "fulfilled" ? co.value.data : null);
    setErrors({
      gbp: g.status === "rejected" ? errOf(g.reason) : null,
      email: ed.status === "rejected" ? errOf(ed.reason) : null,
      domains: d.status === "rejected" ? errOf(d.reason) : null,
      company: co.status === "rejected" ? errOf(co.reason) : null,
    });
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  return (
    <div className="min-w-0">
      <div className="mb-5 flex flex-wrap gap-1.5">
        <ConfigureButton onClick={() => onConfigure("set_website")} />
        <ConfigureButton onClick={() => onConfigure("set_email")} />
        <ConfigureButton onClick={() => onConfigure("phone_numbers")} />
      </div>

      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <Section title="Google Business Profile">
            {errors.gbp ? <StateNote tone="error" title="Status unavailable" detail={errors.gbp} />
              : gbp ? (
                <StateNote tone="blocked" title="Claim & setup unavailable in this runtime — the certified refusal, verbatim"
                  detail={<><Verbatim value={gbp.code} /> · {gbp.blocker}</>} />
              ) : null}
          </Section>

          <Section title="Custom sending domain (emailDomain)">
            {errors.email ? <StateNote tone="error" title="Sending domain unavailable" detail={errors.email} />
              : !emailDomains ? null
              : emailDomains.length === 0 ? <StateNote tone="empty" title="No managed sending domain" detail="Zero is a real count. Set one up through Configure / launch — fails closed until management credentials exist." />
              : (
                <div className="space-y-1.5">
                  {emailDomains.map((d, i) => (
                    <div key={d.id || i} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{d.hostname || d.domain || d.name || UNAVAILABLE}</span>
                      <span className="text-muted-foreground">{d.status || UNAVAILABLE}</span>
                    </div>
                  ))}
                </div>
              )}
          </Section>

          <Section title="Website domains (projectDomains)">
            {errors.domains ? <StateNote tone="error" title="Domains unavailable" detail={errors.domains} />
              : !domains ? null
              : domains.length === 0 ? <StateNote tone="empty" title="No custom domains attached" detail="Zero is a real count — the built-in URL stays the fallback." />
              : (
                <div className="space-y-1.5">
                  {domains.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{d.hostname}</span>
                      {d.is_primary && <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-300">primary</span>}
                      <span className="text-muted-foreground">{d.status}</span>
                    </div>
                  ))}
                </div>
              )}
          </Section>

          <Section title="Company monitoring (public mentions — separate from GBP)">
            {errors.company ? <StateNote tone="error" title="Company monitoring unavailable" detail={errors.company} />
              : !company ? null
              : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Stat label="Company name" value={company.company_name || UNAVAILABLE} />
                  <Stat label="Terms tracked" value={fmtInt((company.terms || []).length)} />
                  <Stat label="Observations" value={fmtInt((company.observations || []).length)} hint={(company.observations || [])[0] ? `latest ${fmtWhen(company.observations[0].observed_at || company.observations[0].created_date)}` : null} />
                </div>
              )}
          </Section>
        </>
      )}
    </div>
  );
}