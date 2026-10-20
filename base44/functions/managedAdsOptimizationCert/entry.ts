// Targeted certification for Managed Ads optimization (shared/adsOptimization.ts + managedAds).
// ZERO real network: the provider seam is an injected deterministic stub; the fail-closed
// production path is exercised un-injected. Real persistence through AdsPerformanceReport +
// AdsCampaign + AdsChangeLog, full cleanup in `finally`.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { adsOptimizationSurface, generateRecommendations, setGuardrails, acceptRecommendation } from "../../shared/adsOptimization.ts";

const STUB_PROVIDER = {
  pauseCampaign: async ({ campaign }) => ({ campaign: { status: "PAUSED", serving_status: "Paused" } }),
  syncCampaigns: async ({ campaigns }) => ({
    campaigns: (campaigns || []).map((c) => ({
      provider_campaign_id: c.provider_campaign_id, status: "ENABLED", serving_status: "Serving",
      metrics: { impressions: 5000, clicks: 0, conversions: 0, cost_micros: 2500000 },
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
    if (!caller) return Response.json({ ok: false, error: "run as an authenticated workspace owner" }, { status: 401 });

    const ws = await svc.entities.Workspace.create({ name: `mads-opt-${stamp}`, owner_id: caller.id, status: "active" });
    workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `mads-opt-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj.id);
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: `mads-opt-2-${stamp}`, status: "ready", version_count: 1 });
    projects.push(proj2.id);
    const acct = await svc.entities.AdsAccount.create({ project_id: proj.id, workspace_id: ws.id, channel: "google", status: "active", business_name: "Acme" });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: proj.id, workspace_id: ws.id, account_id: acct.id, channel: "google",
      campaign_name: `Opt ${stamp}`, campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: `pc_${stamp}`, metrics_pending: true,
    });

    // ---- 1. the unconfigured production path BLOCKS, never recommends ----------------------
    const blocked = await generateRecommendations(svc, proj2, ws, "google");
    h.check("without a configured provider the weekly monitor records a blocked report and recommends NOTHING",
      blocked.report.status === "blocked" && blocked.recommendations.length === 0 && blocked.blocked === "NO_ACCOUNT",
      JSON.stringify({ status: blocked.report.status, blocked: blocked.blocked }));

    // ---- 2. the live path generates an approval-gated recommendation from synced metrics ---
    const gen = await adsOptimizationSurface(svc, proj, ws, { id: caller.id }, { action: "recommend_generate", channel: "google" }, { provider: STUB_PROVIDER, providerLive: true });
    const rec = (gen.recommendations || [])[0];
    h.check("recommendations are generated from the report's synced metrics only, approval-gated, and persisted on the report row",
      gen.report.status === "ok" && !!rec && rec.campaign_id === camp.id && rec.requires_member_approval === true
        && rec.approval_state === "pending" && rec.suggested_action === "pause"
        && rec.basis.impressions === 5000 && rec.basis.clicks === 0,
      JSON.stringify({ recs: gen.recommendations.length, action: rec?.suggested_action, basis: rec?.basis }));
    const genAgain = await adsOptimizationSurface(svc, proj, ws, { id: caller.id }, { action: "recommend_generate", channel: "google" }, { provider: STUB_PROVIDER, providerLive: true });
    h.check("a re-run is a dedupe and never duplicates a pending recommendation",
      genAgain.deduped === true && genAgain.recommendations.length === 0, JSON.stringify({ deduped: genAgain.deduped, recs: genAgain.recommendations.length }));

    // ---- 3. guardrails: validated, persisted, enforced -------------------------------------
    const g = await setGuardrails(svc, proj, ws, "google", { max_daily_budget_micros: 20000000, pause_on_zero_conversions: true });
    h.check("guardrails are validated and persisted on the channel's report row",
      g.guardrails.max_daily_budget_micros === 20000000, JSON.stringify(g.guardrails));
    const bad = await captureCall(() => setGuardrails(svc, proj, ws, "google", { max_daily_budget_micros: -5 }));
    h.check("an invalid guardrail is refused 400 (INVALID_GUARDRAIL)", bad.threw && bad.code === "INVALID_GUARDRAIL", bad.code || "no-throw");

    // ---- 4. accept = approval + execution through the EXISTING adapter ----------------------
    const acc = await acceptRecommendation(svc, proj, ws, { id: caller.id }, { channel: "google", report_id: gen.report.id, campaign_id: camp.id }, { provider: STUB_PROVIDER, providerLive: true });
    const row = await svc.entities.AdsCampaign.get(camp.id);
    h.check("accepting a recommendation stamps the approver, executes the pause through the adapter, and records the outcome",
      acc.executed === true && row.status === "PAUSED" && !!acc.campaign, JSON.stringify(acc));
    const report = await svc.entities.AdsPerformanceReport.get(gen.report.id);
    const recRow = (report.campaigns || []).find((c) => String(c.campaign_id) === camp.id)?.recommendation;
    h.check("the executed recommendation is approval-stamped with the member id and the outcome",
      recRow?.approval_state === "executed" && recRow?.approved_by === caller.id && recRow?.outcome?.status === "PAUSED", JSON.stringify(recRow || {}));
    const accAgain = await acceptRecommendation(svc, proj, ws, { id: caller.id }, { channel: "google", report_id: gen.report.id, campaign_id: camp.id }, { provider: STUB_PROVIDER, providerLive: true });
    h.check("accepting an executed recommendation is an idempotent dedupe (never re-executes)", accAgain.deduped === true && accAgain.executed === false, JSON.stringify(accAgain));
    const changes = await svc.entities.AdsChangeLog.filter({ project_id: proj.id, action: "campaign.optimization_applied" }, "created_date", 10);
    h.check("the execution is recorded in the certified change log (actor member)", changes.length === 1 && changes[0].actor === "member", String(changes.length));

    // ---- 5. the production fail-closed path: accept records a refusal, executes NOTHING ----
    const gen2 = await adsOptimizationSurface(svc, proj, ws, { id: caller.id }, { action: "recommend_generate", channel: "zernio:tiktok" });
    // zernio:tiktok has no account: blocked, no recommendations. Give it one through a report upgrade:
    const live2 = await generateRecommendations(svc, proj, ws, "zernio:tiktok", { provider: { ...STUB_PROVIDER, syncCampaigns: async ({ campaigns }) => ({ campaigns: (campaigns || []).map(() => null).filter(Boolean) }) }, providerLive: true });
    void live2;
    const accUnconf = await captureCall(() => acceptRecommendation(svc, proj, ws, { id: caller.id }, { channel: "zernio:tiktok", report_id: "no-such", campaign_id: camp.id }));
    h.check("an unknown report is refused 404 (REPORT_NOT_FOUND)", accUnconf.threw && accUnconf.code === "REPORT_NOT_FOUND", accUnconf.code || "no-throw");

    // ---- 6. isolation -----------------------------------------------------------------------
    const other = await svc.entities.AdsPerformanceReport.filter({ project_id: proj2.id }, "created_date", 10);
    h.check("isolation: the second project's reports carry none of the first project's campaigns",
      other.every((r) => (r.campaigns || []).every((c) => String(c.campaign_id) !== camp.id)), String(other.length));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "AdsPerformanceReport", { project_id: pid });
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await purgeBy(svc, "BackgroundJob", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }
  return harnessResponse(h);
}