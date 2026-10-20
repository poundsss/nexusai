import { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";

// One server-side read per section, all through the certified Grow surfaces. Every value on
// the overview derives from these records — nothing is invented, missing data stays absent.
export const AD_CHANNELS = [
  { id: "google", label: "Google Ads" },
  { id: "zernio:openai", label: "ChatGPT Ads" },
  { id: "zernio:meta", label: "Meta Ads" },
  { id: "zernio:linkedin", label: "LinkedIn Ads" },
  { id: "zernio:tiktok", label: "TikTok Ads" },
];

const errOf = (e) => (e?.response?.data?.code ? String(e.response.data.code) : String(e?.message || e));
const page = (r, pick) => (r.status === "fulfilled" ? pick(r.value.data ?? r.value) : null);
const jobType = "grow.outreach_email";

const daysAgoISO = (days) => new Date(Date.now() - days * 86400000).toISOString();

export default function useOverviewData(projectId, reloadKey) {
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState({});
  const [accounts, setAccounts] = useState({});
  const [reports, setReports] = useState([]);
  const [recs, setRecs] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [emailJobs, setEmailJobs] = useState([]);
  const [emailStats, setEmailStats] = useState(null);
  const [calls, setCalls] = useState([]);
  const [callCount, setCallCount] = useState(null);
  const [prospects, setProspects] = useState([]);
  const [terms, setTerms] = useState([]);
  const [scans, setScans] = useState([]);
  const [probes, setProbes] = useState([]);
  const [posts, setPosts] = useState([]);
  const [postCount, setPostCount] = useState(null);
  const [gbp, setGbp] = useState(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async (pid) => {
    if (!pid) { setLoading(false); return; }
    setLoading(true);
    const set = await Promise.allSettled([
      ...AD_CHANNELS.map((ch) => base44.functions.invoke("googleAds", { action: "account_get", project_id: pid, channel: ch.id })),
      base44.entities.AdsPerformanceReport.filter({ project_id: pid }, { sort: "-period_start", limit: 200, fields: ["channel", "period_start", "period_end", "status", "campaigns", "provider_sync", "error", "generated_at"] }),
      base44.entities.AdsCampaign.filter({ project_id: pid }, { sort: "-created_date", limit: 10 }),
      base44.entities.BackgroundJob.filter({ project_id: pid, job_type: jobType }, { sort: "-created_date", limit: 8 }),
      base44.entities.BackgroundJob.aggregate({ query: { project_id: pid, job_type: jobType }, groupBy: "status" }),
      base44.entities.ColdCall.filter({ project_id: pid }, { sort: "-created_date", limit: 8, fields: ["status", "blocker_code", "created_at", "dialed_at", "completed_at"] }),
      base44.entities.ColdCall.count({ project_id: pid }),
      base44.functions.invoke("leadGen", { action: "list", project_id: pid }),
      base44.functions.invoke("listen", { action: "term_list", project_id: pid }),
      base44.entities.SeoScan.filter({ project_id: pid }, { sort: "-created_date", limit: 5, fields: ["status", "created_date", "score", "error"] }),
      base44.functions.invoke("aeo", { action: "probe_list", project_id: pid }),
      base44.entities.ViralityScheduledPost.filter({ project_id: pid }, { sort: "-scheduled_at", limit: 8, fields: ["platform", "title", "body", "status", "scheduled_at", "publish_error"] }),
      base44.entities.ViralityScheduledPost.count({ project_id: pid }),
      base44.functions.invoke("myBusiness", { action: "status", project_id: pid }),
      ...AD_CHANNELS.filter((ch) => ch.id !== "google").map((ch) =>
        base44.functions.invoke("managedAds", { action: "recommend_list", project_id: pid, channel: ch.id })),
    ]);
    const errs = {};
    const acc = {}; const recRows = [];
    AD_CHANNELS.forEach((ch, i) => {
      const r = set[i];
      if (r.status === "fulfilled") acc[ch.id] = { label: ch.label, ...(r.value.data ?? r.value) };
      else errs[ch.label] = errOf(r.reason);
      const rec = set[set.length - 4 + i];
      if (rec && rec.status === "fulfilled") (rec.value.data?.recommendations || []).forEach((x) => recRows.push({ ...x, channel: ch.label }));
    });
    const [reportsR, campsR, jobsR, jobStatsR, callsR, callCountR, prospectsR, termsR, scansR, probesR, postsR, postCountR, gbpR] = set.slice(AD_CHANNELS.length, set.length - 4);
    setAccounts(acc);
    setRecs(recRows);
    setReports(page(reportsR, (d) => d?.items) || []);
    if (reportsR.status === "rejected") errs.reports = errOf(reportsR.reason);
    setCampaigns(page(campsR, (d) => d?.items) || []);
    setEmailJobs(page(jobsR, (d) => d?.items) || []);
    setEmailStats(page(jobStatsR, (d) => d?.rows) || null);
    setCalls(page(callsR, (d) => d?.items) || []);
    setCallCount(callCountR.status === "fulfilled" ? callCountR.value : null);
    setProspects(page(prospectsR, (d) => d?.prospects) || []);
    setTerms(page(termsR, (d) => d?.terms) || []);
    setScans(page(scansR, (d) => d?.items) || []);
    setProbes(page(probesR, (d) => d?.probes) || []);
    setPosts(page(postsR, (d) => d?.items) || []);
    setPostCount(postCountR.status === "fulfilled" ? postCountR.value : null);
    setGbp(page(gbpR, (d) => d) || null);
    // Stale = the newest ad report was generated more than 3 days ago (or none synced).
    const newest = (page(reportsR, (d) => d?.items) || [])[0]?.generated_at;
    setStale(newest ? Date.now() - Date.parse(newest) > 3 * 86400000 : true);
    setErrors(errs);
    setLoading(false);
  }, []);

  useEffect(() => { load(projectId); }, [projectId, reloadKey, load]);

  // Range-bounded KPI/series derivation — spend, impressions, clicks, conversions per period.
  const seriesFor = useCallback((days) => {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const byPeriod = new Map();
    reports.filter((r) => r.period_start >= cutoff).forEach((r) => {
      const row = byPeriod.get(r.period_start) || { period: r.period_start, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      (r.campaigns || []).forEach((c) => {
        const m = c.metrics || {};
        row.spend += Number(m.cost_micros || 0) / 1e6;
        row.impressions += Number(m.impressions || 0);
        row.clicks += Number(m.clicks || 0);
        row.conversions += Number(m.conversions || 0);
      });
      byPeriod.set(r.period_start, row);
    });
    return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
  }, [reports]);

  const kpisFor = useCallback((days) => {
    const pts = seriesFor(days);
    const sum = (k) => pts.reduce((a, p) => a + (p[k] || 0), 0);
    const cutoff = daysAgoISO(days);
    const inRange = (items, at) => items.filter((i) => (i.created_date || i.created_at || "") >= cutoff).length;
    return {
      pts,
      adsReports: pts.length > 0,
      spend: pts.length ? sum("spend") : null,
      impressions: pts.length ? sum("impressions") : null,
      clicks: pts.length ? sum("clicks") : null,
      conversions: pts.length ? sum("conversions") : null,
      leads: prospects.length || null,
      emailSteps: emailStats ? emailStats.reduce((a, r) => a + Number(r.count || 0), 0) : null,
      emailRecent: emailStats ? inRange(emailJobs.map(() => ({}))) : null,
      calls: callCount ?? null,
      posts: postCount ?? null,
      revenue: null, // no revenue field exists on any certified surface — stays unavailable
    };
  }, [seriesFor, prospects.length, emailStats, emailJobs, callCount, postCount]);

  return { loading, errors, accounts, campaigns, emailJobs, emailStats, calls, callCount, prospects, terms, scans, probes, posts, postCount, gbp, recs, stale, seriesFor, kpisFor };
}