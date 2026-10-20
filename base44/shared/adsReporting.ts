// Runable Grow — Managed Ads, the weekly performance report over the EXISTING ads seam.
//
// The CONFIRMED product behavior (runable.com/marketing-grow, "Google Ads"): "Set up, launch,
// and optimize Google Ads end to end - keywords, creatives, budgets, and WEEKLY PERFORMANCE
// REPORTS." The launch/budget/campaign CRUD part is the already-certified googleAds surface —
// untouched. What was missing is the REPORTING half: the weekly performance report.
//
// What this implements (end-to-end, locally complete):
//   • ONE report per project + channel + Monday-anchored week bucket (idempotent — a repeated
//     run returns the same row);
//   • data comes ONLY from the existing provider seam: resolveAdsProvider → syncCampaigns
//     (the contract's "provider-side serving state + metrics"), merged into the AdsCampaign
//     rows exactly like campaign_list does — never invented metrics;
//   • fail-open per report, mirroring the listening rule: an unconfigured provider or an absent
//     account records a `blocked` report row with the machine-checkable blocker (the weekly
//     cadence stays observable), and a provider error is recorded on the row — never a fake ok;
//   • SCHEDULING: the certified job queue, ONE idempotent weekly BackgroundJob per project +
//     channel; the executor self-reschedules the next week while an ACTIVE account remains
//     (removing/disconnecting the account stops the chain naturally) — the listen chain pattern.
//
// NOT implemented (UNKNOWN, never invented): optimization RECOMMENDATIONS and automatic
// optimization EXECUTION beyond the existing launch/budget/pause operations — Runable's copy
// does not document them in observable detail, and no provider contract for "managed
// optimization" exists. Campaign CRUD is not called managed optimization.
import { err } from "./virality.ts";
import { enqueue } from "./jobQueue.ts";
import { normalizeAdsChannel, resolveAdsProvider } from "./adsProviderRegistry.ts";
import { syncAndImportCampaigns } from "./adsCampaignImport.ts";

export const ADS_REPORT_JOB_TYPE = "ads.weekly_report";

const nowIso = () => new Date().toISOString();

/** The Monday-anchored UTC week bucket containing `now`. */
export function weekBucket(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const WEEK = 7 * 86400000;
  const isoDate = (x) => x.toISOString().slice(0, 10);
  return { start: isoDate(start), end: isoDate(new Date(start.getTime() + WEEK - 1)), key: isoDate(start), next_start_ms: start.getTime() + WEEK };
}

export const projectReport = (r) => ({
  id: r.id,
  channel: r.channel || "google",
  status: r.status,
  period_start: r.period_start,
  period_end: r.period_end,
  provider_sync: r.provider_sync || null,
  blocker_code: r.blocker_code || null,
  error: r.error || null,
  campaigns: r.campaigns || [],
  metrics_window: r.metrics_window || null,
  import_complete: r.import_complete ?? null,
  source_job_id: r.source_job_id || null,
  generated_at: r.generated_at || null,
});

/**
 * Produce (or dedupe) this week's report for one project + channel. `opts` may inject the
 * provider seam (certification only — production resolves the channel's fail-closed adapter).
 */
export async function runWeeklyAdsReport(svc, project, workspace, channelInput, { provider = null, providerLive = null, source_job_id = null, period: periodOverride = null } = {}) {
  const channel = normalizeAdsChannel(channelInput);
  if (!channel) throw err(`Unknown ads channel "${channelInput}"`, 400, "UNKNOWN_CHANNEL");
  const period = periodOverride || weekBucket();
  const today = nowIso().slice(0, 10);
  const periodComplete = today > period.end;

  // Resolve the provider seam FIRST so the dedupe knows whether this run is LIVE: a prior
  // blocked row never blocks a live re-run inside the same week (the corrected metrics must
  // land), while an ok row — or any prior row under a fail-closed run — dedupes to ONE row.
  if (providerLive == null || provider == null) {
    const resolved = resolveAdsProvider(channel);
    provider = resolved.provider; providerLive = resolved.providerLive;
  }
  const liveRequested = Boolean(providerLive && provider);
  const existing = await svc.entities.AdsPerformanceReport.filter({ project_id: project.id, channel, period_start: period.start }, "created_date", 5).catch(() => []);
  const prior = existing[0] || null;
  // ONE report per project + channel + week bucket: an ok row — or any prior row under a
  // fail-closed run — dedupes; a LIVE re-run UPGRADES the prior blocked row in place (created
  // rows inside one run can share a created_date second, so the row is updated, never duplicated).
  // An ok row for a week that was still running (or imported partially) may be refreshed.
  const refreshable = prior?.metrics_window?.period_complete === false || prior?.import_complete === false;
  if (prior && ((prior.status === "ok" && !(refreshable && liveRequested)) || !liveRequested)) {
    return { deduped: true, report: projectReport(prior) };
  }

  const account = (await svc.entities.AdsAccount.filter({ project_id: project.id }, "-created_date", 20).catch(() => []))
    .find((r) => (r.channel || "google") === channel) || null;
  const campaignRows = (await svc.entities.AdsCampaign.filter({ project_id: project.id }, "-created_date", 50).catch(() => []))
    .filter((r) => (r.channel || "google") === channel);

  let status = "blocked", provider_sync = "skipped_not_configured", blocker_code = "PROVIDER_NOT_CONFIGURED", error = null, campaigns = [];
  // Which period the report's metrics cover. Google's adapter has no date window, so its
  // numbers are the provider's cumulative totals — labeled as such, never presented as weekly.
  let metrics_window = { from: null, to: null, basis: "provider_cumulative", period_complete: periodComplete };
  let import_complete = null;
  if (channel.startsWith("zernio:") && account && account.status === "active" && providerLive) {
    // Zernio: the documented fromDate/toDate window scopes metrics to THIS week (to today while
    // the week is running). Externally created campaigns are imported first (read-only).
    const toDate = periodComplete ? period.end : today;
    try {
      const out = await syncAndImportCampaigns(svc, project, account, channel, provider, { window: { fromDate: period.start, toDate } });
      const rows = await svc.entities.AdsCampaign.filter({ project_id: project.id, channel }, "-created_date", 500).catch(() => []);
      const byRef = new Map(rows.map((r) => [r.provider_campaign_id, r]));
      campaigns = out.remote.map((c) => {
        const row = byRef.get(c.provider_campaign_id) || {};
        return {
          campaign_id: row.id || null, provider_campaign_id: c.provider_campaign_id,
          campaign_name: row.campaign_name || c.campaign_name || "", status: row.status || "", serving_status: c.serving_status || "",
          metrics: c.metrics || {},
        };
      });
      metrics_window = { from: period.start, to: toDate, basis: "period", period_complete: periodComplete };
      import_complete = out.complete;
      status = "ok"; blocker_code = null; provider_sync = out.complete ? "synced" : "partial";
    } catch (e) {
      error = String(e?.message || "provider sync failed").slice(0, 500);
      blocker_code = e?.code || "PROVIDER_ERROR";
    }
  } else if (account && account.status === "active" && providerLive) {
    try {
      const sync = await provider.syncCampaigns({ account, campaigns: campaignRows });
      for (const row of campaignRows) {
        const remote = (sync.campaigns || []).find((c) => c.provider_campaign_id === row.provider_campaign_id);
        if (remote) {
          await svc.entities.AdsCampaign.update(row.id, {
            status: remote.status || row.status, serving_status: remote.serving_status || row.serving_status || "",
            metrics: remote.metrics || row.metrics || {}, metrics_pending: false, last_synced_at: nowIso(),
          });
        }
      }
      const fresh = (await svc.entities.AdsCampaign.filter({ project_id: project.id }, "-created_date", 50).catch(() => []))
        .filter((r) => (r.channel || "google") === channel);
      status = "ok"; provider_sync = "synced"; blocker_code = null;
      campaigns = fresh.map((c) => ({
        campaign_id: c.id, provider_campaign_id: c.provider_campaign_id || null,
        campaign_name: c.campaign_name || "", status: c.status || "", serving_status: c.serving_status || "",
        metrics: c.metrics || {},
      }));
    } catch (e) {
      // Fail-open per report: the refusal is recorded, the row still exists, nothing is fake.
      error = String(e?.message || "provider sync failed").slice(0, 500);
      blocker_code = e?.code || "PROVIDER_ERROR";
      provider_sync = "skipped_not_configured";
      campaigns = campaignRows.map((c) => ({
        campaign_id: c.id, provider_campaign_id: c.provider_campaign_id || null,
        campaign_name: c.campaign_name || "", status: c.status || "", serving_status: c.serving_status || "",
        metrics: c.metrics || {},
      }));
    }
  } else if (!account) {
    blocker_code = "NO_ACCOUNT";
    provider_sync = "no_account";
  }
  // A blocked report still carries the campaign rows it was computed FROM (never metrics):
  // the unconfigured-provider-with-account path reaches here with `campaigns` still empty.
  if (status !== "ok" && !campaigns.length) {
    campaigns = campaignRows.map((c) => ({
      campaign_id: c.id, provider_campaign_id: c.provider_campaign_id || null,
      campaign_name: c.campaign_name || "", status: c.status || "", serving_status: c.serving_status || "",
      metrics: c.metrics || {},
    }));
  }

  if (prior) {
    const updated = await svc.entities.AdsPerformanceReport.update(prior.id, {
      status, period_end: period.end, provider_sync, blocker_code, error, campaigns, metrics_window, import_complete,
      source_job_id: source_job_id || prior.source_job_id || null, generated_at: nowIso(),
    });
    return { deduped: true, report: projectReport(updated) };
  }
  const row = await svc.entities.AdsPerformanceReport.create({
    project_id: project.id, workspace_id: workspace.id, channel,
    status, period_start: period.start, period_end: period.end,
    provider_sync, blocker_code, error, campaigns, metrics_window, import_complete,
    source_job_id: source_job_id || null, generated_at: nowIso(),
  });
  return { deduped: false, report: projectReport(row) };
}

/** The read path: the project's reports for one channel, newest first. */
export async function listAdsReports(svc, project, channelInput, { limit = 20 } = {}) {
  const channel = normalizeAdsChannel(channelInput);
  if (!channel) throw err(`Unknown ads channel "${channelInput}"`, 400, "UNKNOWN_CHANNEL");
  const rows = await svc.entities.AdsPerformanceReport.filter({ project_id: project.id, channel }, "-created_date", Math.max(1, Math.min(Number(limit) || 20, 100)));
  return rows.map(projectReport);
}

/** Enqueue the weekly report job for one project + channel (week-bucket idempotency). */
export async function scheduleWeeklyAdsReport(svc, project, workspace, channelInput, { source_job_id = null } = {}) {
  const channel = normalizeAdsChannel(channelInput);
  if (!channel) throw err(`Unknown ads channel "${channelInput}"`, 400, "UNKNOWN_CHANNEL");
  const period = weekBucket();
  const out = await enqueue(svc, {
    queue: "default", job_type: ADS_REPORT_JOB_TYPE,
    payload: { project_id: project.id, channel },
    max_attempts: 3, idempotency_key: `ads.report:${project.id}:${channel}:${period.key}`,
    workspace_id: workspace.id, project_id: project.id,
  });
  return { job_id: out.job?.id || null, duplicate: Boolean(out.duplicate), period_start: period.start, period_end: period.end };
}

/**
 * The scheduled executor: run this week's report, then keep the weekly chain alive ONLY while
 * an ACTIVE account remains on the channel (the listen chain pattern — disconnecting stops it).
 */
export async function executeAdsReportJob(svc, { project_id, channel: channelInput, source_job_id = null } = {}) {
  const project = await svc.entities.Project.get(String(project_id || "")).catch(() => null);
  if (!project) throw Object.assign(new Error("ads report requires an existing project_id"), { retryable: false, code: "INVALID_PAYLOAD" });
  const channel = normalizeAdsChannel(channelInput);
  if (!channel) throw Object.assign(new Error("ads report requires a valid channel"), { retryable: false, code: "INVALID_PAYLOAD" });
  // The job fires just after a week ends: it reports the week that just COMPLETED, so the
  // stored numbers cover a full week, never the first minutes of the new one.
  const run = await runWeeklyAdsReport(svc, project, { id: project.workspace_id }, channel, { source_job_id, period: weekBucket(Date.now() - 7 * 86400000) });
  const account = (await svc.entities.AdsAccount.filter({ project_id: project.id }, "-created_date", 20).catch(() => []))
    .find((r) => (r.channel || "google") === channel && r.status === "active") || null;
  let next = null;
  if (account) {
    const period = weekBucket(weekBucket().next_start_ms);
    const out = await enqueue(svc, {
      queue: "default", job_type: ADS_REPORT_JOB_TYPE,
      payload: { project_id: project.id, channel },
      delay_ms: Math.max(60000, period.next_start_ms - Date.now() + 300000), max_attempts: 3,
      idempotency_key: `ads.report:${project.id}:${channel}:${period.key}`,
      workspace_id: project.workspace_id, project_id: project.id,
    });
    next = { job_id: out.job?.id || null, duplicate: Boolean(out.duplicate), available_at: out.job?.available_at || null };
  }
  return { project_id: project.id, channel, report: run.report, next_scheduled: next };
}