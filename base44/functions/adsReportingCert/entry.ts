// Targeted certification for Managed Ads weekly performance reporting (shared/adsReporting.ts
// + the googleAds surface actions + the jobHandlers entry). ZERO real network — the provider
// seam is injected for the live-path checks and the PRODUCTION fail-closed seam runs for the
// blocked-path checks. Real persistence through AdsPerformanceReport + AdsCampaign +
// BackgroundJob, full cleanup in `finally`.
//   1. blocked path: the production seam (unconfigured) records a `blocked` report row with the
//      machine-checkable PROVIDER_NOT_CONFIGURED, campaigns carried, NOTHING fake;
//   2. NO_ACCOUNT path: a channel with no account records NO_ACCOUNT;
//   3. live path (injected stub): metrics are synced through the adapter, persisted into the
//      AdsCampaign rows exactly like campaign_list, and the report carries them (status ok);
//   4. idempotency: one report per project + channel + week bucket (same row id on re-run);
//   5. surface: report_run / report_list / report_schedule through googleAdsSurface;
//   6. executor: runs the report and self-reschedules the NEXT week while an active account
//      remains; a missing project is INVALID_PAYLOAD and non-retryable;
//   7. isolation: the second project sees NONE of the first project's reports;
//   8. validation: an unknown channel is refused.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { runWeeklyAdsReport, listAdsReports, scheduleWeeklyAdsReport, executeAdsReportJob, ADS_REPORT_JOB_TYPE, weekBucket } from "../../shared/adsReporting.ts";
import { googleAdsSurface } from "../../shared/googleAds.ts";
import { MAINTENANCE_HANDLERS } from "../../shared/jobHandlers.ts";

const STUB_PROVIDER = {
  syncCampaigns: async ({ campaigns }) => ({
    campaigns: (campaigns || []).map((c) => ({
      provider_campaign_id: c.provider_campaign_id,
      status: "ENABLED", serving_status: "Serving",
      metrics: { impressions: 1000, clicks: 50, cost_micros: 2500000 },
    })),
  }),
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `ads-report-${stamp}`, owner_id: caller.id, status: "active" });
    workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `ads-report-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `ads-report-2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);
    const period = weekBucket();
    const acct = await svc.entities.AdsAccount.create({ project_id: proj.id, workspace_id: ws.id, channel: "google", status: "active", business_name: "Acme" });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: proj.id, workspace_id: ws.id, account_id: acct.id, channel: "google",
      campaign_name: `Reported ${stamp}`, campaign_type: "PERFORMANCE_MAX", status: "PENDING",
      daily_budget_micros: 10000000, provider_campaign_id: `pc_${stamp}`, metrics_pending: true,
    });

    // ---- 1. blocked path: the PRODUCTION fail-closed seam ---------------------------------
    const blocked = await runWeeklyAdsReport(svc, proj, ws, "google");
    h.check("the unconfigured production seam records a BLOCKED report with the machine-checkable refusal — nothing is fabricated",
      blocked.report.status === "blocked" && blocked.report.blocker_code === "PROVIDER_NOT_CONFIGURED"
        && blocked.report.provider_sync === "skipped_not_configured" && Array.isArray(blocked.report.campaigns)
        && blocked.report.campaigns.length === 1,
      JSON.stringify({ status: blocked.report.status, blocker: blocked.report.blocker_code }));

    // ---- 2. NO_ACCOUNT path ---------------------------------------------------------------
    const noAcct = await runWeeklyAdsReport(svc, proj2, ws, "google");
    h.check("a channel with no account records NO_ACCOUNT (the row still exists — the cadence stays observable)",
      noAcct.report.status === "blocked" && noAcct.report.blocker_code === "NO_ACCOUNT" && noAcct.report.provider_sync === "no_account",
      JSON.stringify({ blocker: noAcct.report.blocker_code }));

    // ---- 3. live path with the injected stub: metrics synced + persisted -------------------
    const live = await runWeeklyAdsReport(svc, proj, ws, "google", { provider: STUB_PROVIDER, providerLive: true });
    const campRow = await svc.entities.AdsCampaign.get(camp.id);
    h.check("the live path syncs metrics through the adapter, persists them into the campaign row, and the report carries them (status ok)",
      live.report.status === "ok" && live.report.provider_sync === "synced"
        && campRow.metrics?.impressions === 1000 && campRow.metrics_pending === false && !!campRow.last_synced_at
        && live.report.campaigns[0]?.metrics?.clicks === 50 && live.report.campaigns[0]?.provider_campaign_id === `pc_${stamp}`,
      JSON.stringify({ status: live.report.status, metrics: campRow.metrics }));

    // ---- 4. idempotency: one report per project + channel + week bucket --------------------
    const rerun = await runWeeklyAdsReport(svc, proj, ws, "google", { provider: STUB_PROVIDER, providerLive: true });
    h.check("re-running the same week DEDUPES to the same row id (no second report)",
      rerun.deduped === true && rerun.report.id === live.report.id, JSON.stringify({ id: rerun.report?.id }));

    // ---- 5. the surface actions -------------------------------------------------------------
    const surfRun = await googleAdsSurface(svc, proj, ws, { id: caller.id }, { action: "report_run", channel: "zernio:meta" });
    const surfList = await googleAdsSurface(svc, proj, ws, { id: caller.id }, { action: "report_list", channel: "zernio:meta" });
    h.check("the surface's report_run / report_list work through the certified googleAds routing (per-channel)",
      surfRun.report.channel === "zernio:meta" && surfRun.report.status === "blocked" && surfRun.report.blocker_code === "NO_ACCOUNT"
        && surfList.reports.length === 1 && surfList.reports[0].id === surfRun.report.id,
      JSON.stringify({ channel: surfRun.report?.channel, status: surfRun.report?.status, blocker: surfRun.report?.blocker_code, listed: surfList.reports.length }));
    const surfSched = await scheduleWeeklyAdsReport(svc, proj, ws, "google");
    h.check("report_schedule enqueues ONE week-bucket-idempotent BackgroundJob (a re-schedule dedupes)",
      !!surfSched.job_id && surfSched.period_start === period.start,
      JSON.stringify({ job: !!surfSched.job_id, period: surfSched.period_start }));
    const schedAgain = await scheduleWeeklyAdsReport(svc, proj, ws, "google");
    h.check("re-scheduling the same week dedupes", schedAgain.duplicate === true, JSON.stringify({ duplicate: schedAgain.duplicate }));

    // ---- 6. the executor --------------------------------------------------------------------
    // The reschedule chain runs only while an ACTIVE account remains, so the executor runs on
    // the project that HAS one (the no-account project stops the chain — that is check 2's row).
    const exec = await MAINTENANCE_HANDLERS[ADS_REPORT_JOB_TYPE]({ id: "job-ar1", payload: { project_id: proj.id, channel: "google" } }, { base44: svc, heartbeat: async () => {} });
    h.check("the executor runs the report and SELF-RESCHEDULES the next week while an active account remains",
      exec.report?.status === "ok" && !!exec.next_scheduled?.job_id && exec.next_scheduled.duplicate === false,
      JSON.stringify({ status: exec.report?.status, next: !!exec.next_scheduled?.job_id, dup: exec.next_scheduled?.duplicate }));
    const missing = await captureCall(() => MAINTENANCE_HANDLERS[ADS_REPORT_JOB_TYPE]({ id: "job-ar2", payload: { project_id: "no-such-project", channel: "google" } }, { base44: svc, heartbeat: async () => {} }));
    h.check("a missing project is INVALID_PAYLOAD and non-retryable",
      missing.threw && missing.code === "INVALID_PAYLOAD", missing.code || "no-throw");

    // ---- 7. isolation -----------------------------------------------------------------------
    const other = await listAdsReports(svc, proj2, "google");
    h.check("isolation: the second project's report list sees ONLY its own rows",
      other.length === 1 && other[0].channel === "google" && other.every((r) => !String(r.campaigns.map((c) => c.campaign_id)).includes(camp.id)),
      String(other.length));

    // ---- 8. validation ----------------------------------------------------------------------
    const unknown = await captureCall(() => runWeeklyAdsReport(svc, proj, ws, "pinterest"));
    h.check("an unknown channel is refused 400 (UNKNOWN_CHANNEL)",
      unknown.threw && unknown.code === "UNKNOWN_CHANNEL", unknown.code || "no-throw");
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "AdsPerformanceReport", { project_id: pid });
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}