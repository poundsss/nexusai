import React, { useCallback, useEffect, useState } from "react";
import { ArrowRight, Loader2, Megaphone, Radar, Send, Share2, Sprout, Store } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { UNAVAILABLE, fmtInt } from "./dashBits";

// The project-wide overview: one card per existing Grow module, its status derived ONLY from
// the certified reads each module's dashboard uses — connected / not connected / provider not
// configured / unavailable. Nothing is invented and nothing mutates.
const AD_CHANNELS = [
  { id: "google", label: "Google" },
  { id: "zernio:openai", label: "ChatGPT" },
  { id: "zernio:meta", label: "Meta" },
  { id: "zernio:linkedin", label: "LinkedIn" },
  { id: "zernio:tiktok", label: "TikTok" },
];

const errOf = (e) => (e?.response?.data?.code ? String(e.response.data.code) : String(e?.message || e));
const ok = (r, pick) => (r.status === "fulfilled" ? pick(r.value.data ?? r.value) : null);
const bad = (r) => (r.status === "rejected" ? errOf(r.reason) : null);

const MODULES = [
  { id: "running_ads", label: "Running Ads", icon: Megaphone },
  { id: "cold_outreach", label: "Cold Outreach", icon: Send },
  { id: "social_listening", label: "Social Listening", icon: Radar },
  { id: "social_media", label: "Social Media", icon: Share2 },
  { id: "organic_growth", label: "Organic Growth", icon: Sprout },
  { id: "my_business", label: "My Business", icon: Store },
];

const TONE = {
  connected: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  not_connected: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  not_configured: "border-border bg-muted/40 text-muted-foreground",
  unavailable: "border-destructive/40 bg-destructive/10 text-destructive",
};
const TONE_LABEL = {
  connected: "Connected", not_connected: "Not connected",
  not_configured: "Provider not configured", unavailable: "Unavailable",
};

export default function GrowOverviewGrid({ projectId, onOpen, reloadKey }) {
  const [cards, setCards] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (pid) => {
    if (!pid) { setLoading(false); return; }
    setLoading(true);
    const settled = await Promise.allSettled([
      ...AD_CHANNELS.map((ch) => base44.functions.invoke("googleAds", { action: "account_get", project_id: pid, channel: ch.id })),
      base44.entities.BackgroundJob.aggregate({ query: { project_id: pid, job_type: "grow.outreach_email" }, groupBy: "status" }),
      base44.entities.ColdCall.count({ project_id: pid }),
      base44.functions.invoke("coldCalling", { action: "status" }),
      base44.functions.invoke("listen", { action: "term_list", project_id: pid }),
      base44.functions.invoke("leadGen", { action: "list", project_id: pid }),
      base44.functions.invoke("aeo", { action: "probe_list", project_id: pid }),
      base44.entities.SeoScan.count({ project_id: pid }),
      base44.functions.invoke("emailDomain", { action: "list", project_id: pid }),
      base44.functions.invoke("myBusiness", { action: "status", project_id: pid }),
      base44.entities.ViralityScheduledPost.count({ project_id: pid }),
    ]);
    const [ ...rest ] = settled;
    const acc = settled.slice(0, AD_CHANNELS.length);
    const [jobs, callCount, telephony, terms, prospects, probes, scans, emailDomains, gbp, posts] = settled.slice(AD_CHANNELS.length);

    const adsActive = acc.filter((r) => ok(r, (d) => d?.account?.status === "active")).length;
    const adsConfigured = acc.filter((r) => ok(r, (d) => d?.account?.provider_configured !== false)).length;
    const adsErr = acc.some((r) => r.status === "rejected");
    const jobTotal = (ok(jobs, (d) => d?.rows) || []).reduce((a, r) => a + Number(r.count || 0), 0);
    const out = {
      running_ads: adsErr ? { status: "unavailable" } : {
        status: adsActive > 0 ? "connected" : adsConfigured < AD_CHANNELS.length ? "not_configured" : "not_connected",
        metric: `${adsActive}/${AD_CHANNELS.length} channels connected`,
        hint: `accounts on: ${AD_CHANNELS.filter((_, i) => acc[i].status === "fulfilled" && acc[i].value.data?.account?.status === "active").map((c) => c.label).join(", ") || "none"}`,
      },
      cold_outreach: jobs.status === "rejected" ? { status: "unavailable" } : {
        status: (jobTotal > 0 || Number(callCount.value ?? 0) > 0) ? "connected" : "not_connected",
        metric: `${fmtInt(jobTotal || null)} email steps · ${fmtInt(callCount.status === "fulfilled" ? callCount.value : null)} calls`,
        hint: (ok(telephony, (d) => d?.available) === false) ? `telephony refused · ${ok(telephony, (d) => d?.code)}` : null,
      },
      social_listening: terms.status === "rejected" ? { status: "unavailable" } : {
        status: (ok(terms, (d) => (d?.terms || []).length) || 0) > 0 ? "connected" : "not_connected",
        metric: `${fmtInt((ok(terms, (d) => (d?.terms || []).length) || 0) || null)} terms · ${fmtInt((ok(prospects, (d) => (d?.prospects || []).length) || 0) || null)} prospects`,
      },
      social_media: posts.status === "rejected" ? { status: "unavailable" } : {
        status: Number(posts.value ?? 0) > 0 ? "connected" : "not_connected",
        metric: `${fmtInt(posts.value)} calendar posts`,
      },
      organic_growth: probes.status === "rejected" ? { status: "unavailable" } : {
        status: (ok(probes, (d) => (d?.probes || []).length) || 0) > 0 || Number(scans.value ?? 0) > 0 ? "connected" : "not_connected",
        metric: `${fmtInt(scans.status === "fulfilled" ? scans.value : null)} SEO audits · ${fmtInt((ok(probes, (d) => (d?.probes || []).length) || 0) || null)} AEO probes`,
      },
      my_business: gbp.status === "fulfilled" ? {
        status: "unavailable",
        metric: `GBP unavailable · ${ok(gbp, (d) => d?.code)}`,
        hint: `${fmtInt((ok(emailDomains, (d) => (d?.domains || d?.items || []).length) || 0) || null)} email domains`,
      } : { status: "unavailable" },
    };
    setCards(out);
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  if (loading) return <div className="py-16 grid place-items-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!projectId) return null;

  return (
    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {MODULES.map((m) => {
        const c = cards?.[m.id] || { status: "unavailable" };
        const Icon = m.icon;
        return (
          <button key={m.id} type="button" onClick={() => onOpen(m.id)}
            className="group flex flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/25">
            <div className="flex items-center gap-2.5">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-foreground">{m.label}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <span className={`mt-2.5 inline-flex w-fit rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${TONE[c.status] || TONE.unavailable}`}>
              {TONE_LABEL[c.status] || TONE_LABEL.unavailable}
            </span>
            {c.metric ? <p className="mt-2 truncate text-[12px] text-muted-foreground">{c.metric}</p> : null}
            {c.hint ? <p className="mt-1 truncate text-[11px] text-muted-foreground">{c.hint}</p> : null}
          </button>
        );
      })}
    </div>
  );
}