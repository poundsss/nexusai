import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, Funnel, ConfigureButton, Verbatim, UNAVAILABLE, fmtInt, fmtUsdFromMicros, fmtWhen, isStale } from "./dashBits";

// One ads channel of the project Dashboard — the SAME certified reads AdsDash uses
// (googleAds campaign_list / report_list / launch_readiness + managedAds recommend_list),
// pinned to the selected module's channel. Read-only: nothing launches or spends here.
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function GrowAdsModulePanel({ projectId, channel, label, configureSub, onConfigure, reloadKey }) {
  const [data, setData] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) return;
    setLoading(true);
    const out = {};
    const errs = {};
    const sections = {
      readiness: () => base44.functions.invoke("googleAds", { action: "launch_readiness", project_id: pid, channel }),
      campaigns: () => base44.functions.invoke("googleAds", { action: "campaign_list", project_id: pid, channel }),
      reports: () => base44.functions.invoke("googleAds", { action: "report_list", project_id: pid, channel }),
      recs: () => base44.functions.invoke("managedAds", { action: "recommend_list", project_id: pid, channel }),
    };
    await Promise.all(Object.entries(sections).map(async ([k, fn]) => {
      try { out[k] = (await fn()).data; } catch (e) { errs[k] = errOf(e); }
    }));
    setData(out);
    setErrors(errs);
    setLoading(false);
  }, [channel]);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  const providerConfigured = data?.campaigns?.provider_sync !== "skipped_not_configured";
  const readiness = data?.readiness || null;
  const campaigns = data?.campaigns?.campaigns || [];
  const providerSync = data?.campaigns?.provider_sync || null;
  const reports = data?.reports?.reports || [];
  const recs = data?.recs?.recommendations || [];

  // Totals cover ONLY synced rows; a pending row is declared, never folded into a fabricated sum.
  const synced = campaigns.filter((c) => !c.metrics_pending);
  const pendingCount = campaigns.length - synced.length;
  const sum = (k) => synced.reduce((a, c) => a + Number(c[k] || 0), 0);
  const impressions = sum("impressions"), clicks = sum("clicks"), conversions = sum("conversions");
  const cost = sum("cost_micros");
  const cpc = clicks > 0 ? cost / 1e6 / clicks : null;
  const cpa = conversions > 0 ? cost / 1e6 / conversions : null;

  return (
    <div className="min-w-0">
      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : !projectId ? null : (
        <>
          {errors.campaigns ? <StateNote tone="error" title="Campaign data unavailable" detail={errors.campaigns} />
            : providerSync === "skipped_not_configured" ? (
              <StateNote tone="disconnected" title={`${label} is not connected for this project`}
                detail="The channel's provider is not configured in this runtime — the certified surface refuses with PROVIDER_NOT_CONFIGURED." />
            ) : campaigns.length === 0 ? (
              <StateNote tone="empty" title={`No ${label} campaigns yet`} detail="Zero is a real count — nothing was launched." />
            ) : null}

          {campaigns.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Campaigns" value={fmtInt(campaigns.length)} hint={pendingCount > 0 ? `${synced.length} synced · ${pendingCount} pending sync` : "all synced"} />
                <Stat label="Spend (synced)" value={fmtUsdFromMicros(cost)} />
                <Stat label="Clicks (synced)" value={fmtInt(clicks)} />
                <Stat label="Conversions (synced)" value={fmtInt(conversions)} />
              </div>
              <Section title={`Performance funnel · ${label}`}>
                {pendingCount >= campaigns.length ? (
                  <StateNote tone="stale" title="Funnel unavailable — metrics pending provider sync" detail="Stages appear once the provider metric sync fills the rows." />
                ) : (
                  <Funnel stages={[
                    { label: "Impressions", value: impressions },
                    { label: "Clicks", value: clicks },
                    { label: "Conversions", value: conversions },
                  ]} />
                )}
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="CPC" value={cpc != null ? `$${cpc.toFixed(2)}` : UNAVAILABLE} hint={cpc == null ? "needs clicks > 0" : "cost ÷ clicks"} />
                  <Stat label="Cost per conversion" value={cpa != null ? `$${cpa.toFixed(2)}` : UNAVAILABLE} hint={cpa == null ? "needs conversions > 0" : "cost ÷ conversions"} />
                  <Stat label="ROAS / revenue" value={UNAVAILABLE} hint="provider metrics carry no revenue — never computed" />
                  <Stat label="Provider sync" value={providerSync || UNAVAILABLE} />
                </div>
              </Section>
            </>
          )}

          <Section title="Available actions (read-only)">
            <div className="flex flex-wrap items-center gap-2">
              <ConfigureButton onClick={() => onConfigure(configureSub)} />
              <span className="text-[11.5px] text-muted-foreground">
                Launch and budget changes stay in the agent chat — approval-gated, never from the dashboard.
              </span>
            </div>
            <div className="mt-2">
              {errors.readiness ? <StateNote tone="error" title="Readiness unavailable" detail={errors.readiness} />
                : readiness ? (readiness.ready
                  ? <StateNote tone="ok" title="Ready to launch" detail={readiness.landing_page ? `landing page: ${readiness.landing_page}` : null} />
                  : <StateNote tone="blocked" title="Not ready — blockers, verbatim" detail={(readiness.blockers || []).join(", ")} />)
                : null}
            </div>
          </Section>

          <Section title="Weekly reports">
            {errors.reports ? <StateNote tone="error" title="Reports unavailable" detail={errors.reports} />
              : reports.length === 0 ? <StateNote tone="empty" title="No weekly reports yet" detail="The scheduled weekly monitor writes one row per channel-week, blocked or not." />
              : (
                <div className="space-y-2">
                  {reports.map((r) => (
                    <div key={r.id} className="rounded-lg border border-border bg-card px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span className="font-medium text-foreground">{r.period_start} → {r.period_end}</span>
                        <span className="text-muted-foreground">sync: {r.provider_sync || UNAVAILABLE}</span>
                        {isStale(r.generated_at) && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-700 dark:text-amber-300">stale</span>}
                        <span className="ml-auto text-muted-foreground">{fmtWhen(r.generated_at)}</span>
                      </div>
                      {r.status === "blocked" && <p className="mt-1.5 text-[11.5px] text-amber-700 dark:text-amber-300">blocked · <Verbatim value={r.blocker_code} /></p>}
                      {r.error ? <p className="mt-1 truncate text-[11.5px] text-destructive">{r.error}</p> : null}
                    </div>
                  ))}
                </div>
              )}
          </Section>

          <Section title="Budget recommendations (read-only, approval-gated)">
            {errors.recs ? <StateNote tone="error" title="Recommendations unavailable" detail={errors.recs} />
              : recs.length === 0 ? <StateNote tone="empty" title="No recommendations yet" detail="Run the managed-ads weekly monitor from chat — every change stays approval-gated." />
              : (
                <div className="space-y-2">
                  {recs.map((r, i) => (
                    <div key={i} className="rounded-lg border border-border bg-card px-3 py-2.5 text-[12px]">
                      <p className="font-medium text-foreground">{r.campaign_name || r.campaign_id}</p>
                      <p className="mt-0.5 text-muted-foreground">{r.recommendation?.suggested_action} · {r.recommendation?.reason}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">approval: {r.recommendation?.approval_state} · week {r.period_start}</p>
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