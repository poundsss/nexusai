// Runable Grow — Managed Ads OPTIMIZATION over the certified reporting + provider seams.
// Monitoring = the weekly report chain (adsReporting.ts). Recommendations are computed ONLY
// from the report's synced metrics (deterministic rules), persisted into the report's campaign
// rows (recommendation objects — bounded, approval-gated). Guardrails are member-set bounds
// validated before any execution. Execution goes through the EXISTING 11-op provider adapter
// (updateCampaign budget write / pauseCampaign switch) — no new provider API, fail-closed
// (PROVIDER_NOT_CONFIGURED / PROVIDER_UNIMPLEMENTED) exactly like every other live path.
// Accepting a recommendation IS the member's approval: approval_state + actor are stamped, and
// the execution result is recorded. Never auto-executes; a member action is required.
import { err } from "./virality.ts";
import { runWeeklyAdsReport, listAdsReports, weekBucket } from "./adsReporting.ts";
import { normalizeAdsChannel, resolveAdsProvider } from "./adsProviderRegistry.ts";

// The certified change-log write (the same shape the googleAds surface records).
const changeLog = (svc, { project, actor, scope, resource_id, action, detail }) =>
  svc.entities.AdsChangeLog.create({ project_id: project.id, workspace_id: project.workspace_id, scope, resource_id, actor, action, detail: detail || {} });

const nowIso = () => new Date().toISOString();
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const MAX_RECOMMENDATIONS = 50;

const MIN_IMPRESSIONS_FOR_PAUSE = 1000; // below this there is no signal to recommend on

/** Deterministic recommendations from ONE campaign's synced metrics. Never invented numbers:
 *  every suggestion quotes the metrics it was computed from. */
function recommendFor(campaign) {
  const m = campaign.metrics || {};
  const impressions = Number(m.impressions || 0), clicks = Number(m.clicks || 0),
    conversions = Number(m.conversions || 0), cost = Number(m.cost_micros || 0);
  if (impressions >= MIN_IMPRESSIONS_FOR_PAUSE && clicks === 0) {
    return { suggested_action: "pause", reason: `${impressions} impressions with 0 clicks — no engagement signal`, suggested_budget_micros: null };
  }
  if (cost > 0 && conversions === 0 && clicks > 0) {
    return { suggested_action: "pause_review", reason: `${clicks} clicks and ${conversions} conversions for ${cost} micros spent — review before more spend`, suggested_budget_micros: null };
  }
  return null; // performing or without enough signal: no recommendation, never a guessed one
}

/** The weekly report is the monitoring pass; attach fresh recommendations to its campaign rows. */
export async function generateRecommendations(svc, project, workspace, channelInput, { provider = null, providerLive = null } = {}) {
  const channel = normalizeAdsChannel(channelInput);
  if (!channel) throw err(`Unknown ads channel "${channelInput}"`, 400, "UNKNOWN_CHANNEL");
  const run = await runWeeklyAdsReport(svc, project, workspace, channel, { provider, providerLive });
  if (run.report.status !== "ok") {
    return { deduped: run.deduped, report: run.report, recommendations: [], blocked: run.report.blocker_code };
  }
  const recs = [];
  const campaigns = (run.report.campaigns || []).slice(0, MAX_RECOMMENDATIONS).map((c) => {
    const r = recommendFor(c);
    if (!r || c.recommendation) return c; // a campaign's existing recommendation (any state) stands
    const rec = { ...r, basis: { impressions: c.metrics?.impressions ?? 0, clicks: c.metrics?.clicks ?? 0, conversions: c.metrics?.conversions ?? 0, cost_micros: c.metrics?.cost_micros ?? 0 }, requires_member_approval: true, approval_state: "pending", generated_at: nowIso() };
    recs.push({ campaign_id: c.campaign_id, ...rec });
    return { ...c, recommendation: rec };
  });
  if (recs.length) await svc.entities.AdsPerformanceReport.update(run.report.id, { campaigns });
  return { deduped: run.deduped, report: { ...run.report, campaigns }, recommendations: recs, blocked: null };
}

/** Validate and store the channel's budget guardrails (a member write — no provider call). */
export async function setGuardrails(svc, project, workspace, channelInput, input) {
  const channel = normalizeAdsChannel(channelInput);
  if (!channel) throw err(`Unknown ads channel "${channelInput}"`, 400, "UNKNOWN_CHANNEL");
  const maxDaily = Number(input.max_daily_budget_micros);
  if (!Number.isInteger(maxDaily) || maxDaily <= 0) throw err("max_daily_budget_micros must be a positive integer (micros)", 400, "INVALID_GUARDRAIL");
  const pauseOnZero = Boolean(input.pause_on_zero_conversions);
  const period = weekBucket();
  const existing = (await svc.entities.AdsPerformanceReport.filter({ project_id: project.id, channel, period_start: period.start }, "created_date", 5).catch(() => []))[0] || null;
  const guardrails = { max_daily_budget_micros: maxDaily, pause_on_zero_conversions: pauseOnZero, updated_at: nowIso() };
  const row = existing
    ? await svc.entities.AdsPerformanceReport.update(existing.id, { guardrails })
    : await svc.entities.AdsPerformanceReport.create({ project_id: project.id, workspace_id: workspace.id, channel, status: "blocked", period_start: period.start, period_end: period.end, provider_sync: "skipped_not_configured", blocker_code: "NO_REPORT_YET", campaigns: [], guardrails, generated_at: nowIso() });
  return { guardrails, report_id: row.id };
}

/** Accept (approve + execute) ONE recommendation through the EXISTING provider operations. */
export async function acceptRecommendation(svc, project, workspace, user, input, { provider = null, providerLive = null } = {}) {
  const channel = normalizeAdsChannel(input.channel);
  if (!channel) throw err("a valid channel is required", 400, "UNKNOWN_CHANNEL");
  const reportId = String(input.report_id || "");
  const campaignId = String(input.campaign_id || "");
  if (!reportId || !campaignId) throw err("report_id and campaign_id are required", 400, "INVALID_INPUT");
  const report = await svc.entities.AdsPerformanceReport.get(reportId).catch(() => null);
  if (!report || report.project_id !== project.id || (report.channel || "google") !== channel) throw err("Report not found", 404, "REPORT_NOT_FOUND");
  const idx = (report.campaigns || []).findIndex((c) => String(c.campaign_id) === campaignId);
  const target = idx >= 0 ? report.campaigns[idx] : null;
  if (!target?.recommendation) throw err("this campaign carries no recommendation", 404, "NO_RECOMMENDATION");
  if (target.recommendation.approval_state === "executed") return { deduped: true, executed: false, report_id: report.id };
  if (target.recommendation.approval_state === "refused") throw err("this recommendation was already refused", 409, "ALREADY_REFUSED");

  const row = await svc.entities.AdsCampaign.get(campaignId).catch(() => null);
  if (!row || row.project_id !== project.id) throw err("Campaign not found", 404, "CAMPAIGN_NOT_FOUND");
  if (row.status === "REMOVED") throw err("the campaign was permanently deleted", 409, "CAMPAIGN_REMOVED");
  const guardrails = report.guardrails || null;
  if (guardrails?.max_daily_budget_micros && target.recommendation.suggested_budget_micros != null
      && Number(target.recommendation.suggested_budget_micros) > Number(guardrails.max_daily_budget_micros)) {
    throw err("the suggested budget exceeds the channel's guardrail — raise the guardrail first", 409, "GUARDRAIL_EXCEEDED");
  }

  // The seam resolves the channel's adapter; an injected one is the certification's stub.
  const resolved = provider ? { provider, providerLive: true } : resolveAdsProvider(channel);
  if (!resolved.providerLive) {
    const campaigns = [...report.campaigns];
    campaigns[idx] = { ...target, recommendation: { ...target.recommendation, approval_state: "refused", refusal_code: "PROVIDER_NOT_CONFIGURED", refused_at: nowIso() } };
    await svc.entities.AdsPerformanceReport.update(report.id, { campaigns });
    throw Object.assign(new Error("the ads provider is not configured — nothing was executed; the recommendation was recorded as refused"), { code: "PROVIDER_NOT_CONFIGURED", status: 409, retryable: false });
  }
  let res;
  if (target.recommendation.suggested_action === "pause" || target.recommendation.suggested_action === "pause_review") {
    res = await resolved.provider.pauseCampaign({ campaign: row });
  } else {
    throw err(`unsupported suggested_action "${target.recommendation.suggested_action}"`, 400, "UNSUPPORTED_ACTION");
  }
  const merged = { ...row, ...(res.campaign || {}) };
  const updated = await svc.entities.AdsCampaign.update(row.id, {
    status: merged.status || "PAUSED", serving_status: merged.serving_status || row.serving_status || "", last_synced_at: nowIso(),
  });
  const campaigns = [...report.campaigns];
  campaigns[idx] = { ...target, recommendation: { ...target.recommendation, approval_state: "executed", approved_by: user.id, executed_at: nowIso(), outcome: { status: updated.status, serving_status: updated.serving_status } } };
  await svc.entities.AdsPerformanceReport.update(report.id, { campaigns });
  await changeLog(svc, { project, actor: "member", scope: "campaign", resource_id: row.id, action: "campaign.optimization_applied", detail: { report_id: report.id, suggestion: target.recommendation.suggested_action, reason: target.recommendation.reason } });
  return { deduped: false, executed: true, report_id: report.id, campaign: { id: updated.id, status: updated.status, serving_status: updated.serving_status || "" } };
}

/** The member-optimized surface (reads are project.read; everything else project.write). */
export async function adsOptimizationSurface(svc, project, workspace, user, input, opts = {}) {
  const action = String(input.action || "");
  if (action === "recommend_generate") return generateRecommendations(svc, project, workspace, input.channel, opts);
  if (action === "recommend_list") {
    const reports = await listAdsReports(svc, project, input.channel, { limit: input.limit });
    const recs = [];
    for (const r of reports) for (const c of r.campaigns || []) if (c.recommendation) recs.push({ report_id: r.id, period_start: r.period_start, campaign_id: c.campaign_id, campaign_name: c.campaign_name, recommendation: c.recommendation });
    return { recommendations: recs.slice(0, MAX_RECOMMENDATIONS) };
  }
  if (action === "guardrail_set") return setGuardrails(svc, project, workspace, input.channel, input);
  if (action === "recommendation_accept") return acceptRecommendation(svc, project, workspace, user, input, opts);
  throw err(`Unknown action "${action}"`, 400, "UNKNOWN_ACTION");
}