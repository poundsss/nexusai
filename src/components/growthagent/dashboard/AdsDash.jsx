import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Stat, StateNote, Section, ConfigureButton, Verbatim, UNAVAILABLE, fmtInt, fmtUsdFromMicros, fmtWhen, isStale } from "./dashBits";
import GrowAdsAccountActions from "./GrowAdsAccountActions";
import GrowAdsCampaignActions from "./GrowAdsCampaignActions";

// Running Ads dashboard — ONE tab per ads channel, every read through the EXISTING certified
// surfaces (googleAds reads + managedAds recommend_list). Nothing here launches or spends.
// Metrics are the provider-synced values the campaign/report rows carry; metrics_pending rows
// render "pending sync", never a fabricated 0. Derived CPC/CPA appear only when their inputs
// exist; revenue is not part of the synced metrics, so ROAS is ALWAYS unavailable — stated.
const CHANNELS = [
  { id: "google", sub: "google_ads", label: "Google Ads" },
  { id: "zernio:openai", sub: "chatgpt_ads", label: "ChatGPT Ads" },
  { id: "zernio:meta", sub: "meta_ads", label: "Meta Ads" },
  { id: "zernio:linkedin", sub: "linkedin_ads", label: "LinkedIn Ads" },
  { id: "zernio:tiktok", sub: "tiktok_ads", label: "TikTok Ads" },
];

const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function AdsDash({ projectId, onConfigure, reloadKey }) {
  const [channel, setChannel] = useState("google");
  const [data, setData] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid, ch) => {
    if (!pid) return;
    setLoading(true);
    const out = {};
    const errs = {};
    const sections = {
      account: () => base44.functions.invoke("googleAds", { action: "account_get", project_id: pid, channel: ch }),
      readiness: () => base44.functions.invoke("googleAds", { action: "launch_readiness", project_id: pid, channel: ch }),
      campaigns: () => base44.functions.invoke("googleAds", { action: "campaign_list", project_id: pid, channel: ch }),
      reports: () => base44.functions.invoke("googleAds", { action: "report_list", project_id: pid, channel: ch }),
      recs: () => base44.functions.invoke("managedAds", { action: "recommend_list", project_id: pid, channel: ch }),
    };
    await Promise.all(Object.entries(sections).map(async ([k, fn]) => {
      try { out[k] = (await fn()).data; } catch (e) { errs[k] = errOf(e); }
    }));
    setData(out);
    setErrors(errs);
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId, channel); }, [projectId, channel, reloadKey, load]);

  const ch = CHANNELS.find((c) => c.id === channel);
  const account = data?.account?.account ?? null;
  // account_get without an account returns {account: null} only — the honest "is the provider
  // configured" signal is the campaign list's provider_sync ("skipped_not_configured" = refusal).
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
  const cost = sum("cost_micros"), clicks = sum("clicks"), conversions = sum("conversions");
  const cpc = clicks > 0 ? cost / 1e6 / clicks : null;
  const cpa = conversions > 0 ? cost / 1e6 / conversions : null;

  return (
    <div className="min-w-0">
      <div className="mb-5 flex flex-wrap gap-1.5">
        {CHANNELS.map((c) => (
          <button key={c.id} type="button" onClick={() => setChannel(c.id)}
            className={`rounded-lg border px-2.5 py-1 text-[12px] font-medium transition-colors ${c.id === channel ? "border-foreground/30 bg-accent text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}>
            {c.label}
          </button>
        ))}
        <div className="ml-auto"><ConfigureButton onClick={() => onConfigure(ch.sub)} /></div>
      </div>

      {loading ? (
        <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : !projectId ? null : (
        <>
          {errors.account ? <StateNote tone="error" title="Account status unavailable" detail={errors.account} /> :
            account ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Account status" value={account.status || UNAVAILABLE} />
                <Stat label="Currency" value={account.currency_code || UNAVAILABLE} />
                <Stat label="Payment on file" value={account.payment_on_file ? "yes" : "no"} />
                <Stat label="Spend cap" value={account.spend_cap_micros != null ? fmtUsdFromMicros(account.spend_cap_micros) : UNAVAILABLE} hint={account.launched_at ? `launched ${fmtWhen(account.launched_at)}` : (account.disconnected_at ? `disconnected ${fmtWhen(account.disconnected_at)}` : null)} />
              </div>
            ) : (
              <StateNote tone="disconnected" title={`No ads account connected on ${ch.label}`}
                detail={providerConfigured ? "Connect and launch through the Configure / launch flow — the dashboard only observes." : "The channel's provider is not configured in this runtime — the certified surface refuses with PROVIDER_NOT_CONFIGURED."} />
            )}
          <GrowAdsAccountActions projectId={projectId} channel={channel} account={account} onConfigure={onConfigure} />

          <Section title="Launch readiness" right={readiness ? <Verbatim value={readiness.ready ? "ready" : (readiness.blockers || []).join(" · ")} /> : null}>
            {errors.readiness ? <StateNote tone="error" title="Readiness unavailable" detail={errors.readiness} />
              : readiness ? (readiness.ready
                ? <StateNote tone="ok" title="Ready to launch" detail={readiness.landing_page ? `landing page: ${readiness.landing_page}` : null} />
                : <StateNote tone="blocked" title="Not ready — blockers, verbatim" detail={(readiness.blockers || []).join(", ")} />)
              : null}
          </Section>

          <Section title="Campaigns" right={providerSync ? <span className="text-[11px] text-muted-foreground">provider sync: {providerSync}</span> : null}>
            {errors.campaigns ? <StateNote tone="error" title="Campaign list unavailable" detail={errors.campaigns} />
              : campaigns.length === 0 ? <StateNote tone="empty" title="No campaigns on this channel yet" detail="Zero is a real count — nothing was launched. Launch through Configure / launch." />
              : (
                <>
                  {pendingCount > 0 && <StateNote tone="stale" title={`${pendingCount} of ${campaigns.length} campaigns pending a provider metric sync`} detail="Totals below cover synced rows only." />}
                  <div className="overflow-hidden rounded-xl border border-border bg-card">
                    <table className="w-full text-[12px]">
                      <thead><tr className="border-b border-border text-left text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Campaign</th><th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 text-right font-medium">Spend</th><th className="px-3 py-2 text-right font-medium">Impr.</th>
                        <th className="px-3 py-2 text-right font-medium">Clicks</th><th className="px-3 py-2 text-right font-medium">Conv.</th>
                        <th className="px-3 py-2 font-medium">Synced</th>
                        <th className="px-3 py-2 text-right font-medium">Actions</th>
                      </tr></thead>
                      <tbody>
                        {campaigns.map((c) => (
                          <tr key={c.id} className="border-b border-border/60 last:border-0">
                            <td className="max-w-[14rem] truncate px-3 py-2 text-foreground" title={c.campaign_name}>{c.campaign_name}</td>
                            <td className="px-3 py-2">{c.status}{c.serving_status ? ` · ${c.serving_status}` : ""}</td>
                            <td className="px-3 py-2 text-right">{c.metrics_pending ? <span className="text-muted-foreground">pending</span> : fmtUsdFromMicros(c.cost_micros)}</td>
                            <td className="px-3 py-2 text-right">{c.metrics_pending ? <span className="text-muted-foreground">pending</span> : fmtInt(c.impressions)}</td>
                            <td className="px-3 py-2 text-right">{c.metrics_pending ? <span className="text-muted-foreground">pending</span> : fmtInt(c.clicks)}</td>
                            <td className="px-3 py-2 text-right">{c.metrics_pending ? <span className="text-muted-foreground">pending</span> : fmtInt(c.conversions)}</td>
                            <td className="px-3 py-2 text-muted-foreground">{fmtWhen(c.last_synced_at)}</td>
                            <td className="px-3 py-2">
                              {c.metrics_pending ? <span className="block text-right text-[11px] text-muted-foreground">—</span>
                                : <GrowAdsCampaignActions projectId={projectId} channel={channel} campaign={c} onChanged={() => load(projectId, channel)} />}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="Spend (synced rows)" value={fmtUsdFromMicros(cost)} />
                    <Stat label="CPC" value={cpc != null ? `$${cpc.toFixed(2)}` : UNAVAILABLE} hint={cpc == null ? "needs clicks > 0" : "cost ÷ clicks"} />
                    <Stat label="Cost per conversion" value={cpa != null ? `$${cpa.toFixed(2)}` : UNAVAILABLE} hint={cpa == null ? "needs conversions > 0" : "cost ÷ conversions"} />
                    <Stat label="ROAS / revenue" value={UNAVAILABLE} hint="provider metrics carry no revenue — never computed" />
                  </div>
                </>
              )}
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