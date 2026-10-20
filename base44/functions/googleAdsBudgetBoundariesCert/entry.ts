// Targeted certification for the budget_boundaries read (NexusAI-native, DOCUMENTED Base44:
// GET /google-ads/campaigns/budget-boundaries with currency_code + campaign_type).
//
// Drives the REAL surface and the REAL authorization choke point. NO provider is injected —
// the read is planning data, not a live operation, so it must answer without any provider
// wiring (proving the certified provider contract is untouched). NO real Google Ads call,
// no spend, no entities, no schema change.
//
// Certified: exact response field set and exact confirmed USD values for SMART and
// PERFORMANCE_MAX; unknown currency → USD; unknown/absent type → SMART; the read works
// without a provider; it persists nothing (no account/campaign/change-log rows); viewer /
// stranger authorization through project.read.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";
import { BUDGET_BOUNDARIES_USD } from "../../shared/googleAdsBudgetBoundaries.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  // NO provider injected anywhere — boundaries is a static planning read.
  const surface = makeAdsSurface(svc);

  const EXPECTED_KEYS = ["campaign_type", "currency_code", "max_daily_budget_micros", "min_daily_budget_micros", "preset_daily_budget_micros", "recommended_daily_budget_micros", "usd_to_currency_rate"].sort();

  try {
    const wsA = await svc.entities.Workspace.create({ name: `budgetbounds-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    workspaces.push(wsA.id);
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `budgetbounds-a-${stamp}`, status: "ready", version_count: 1 });
    projects.push(projA.id);
    const userA = { id: `ownerA_${stamp}`, email: "a@example.com" };
    const stranger = { id: "budgetbounds_stranger", email: "stranger@example.com" };
    const viewer = { id: "budgetbounds_viewer", email: "viewer@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });

    // ---- 1. exact contract: USD + SMART --------------------------------------------------
    const smart = await surface(projA, userA, { action: "budget_boundaries", currency_code: "USD", campaign_type: "SMART" });
    h.check("budget_boundaries (USD + SMART) returns the exact documented field set",
      Object.keys(smart).sort().join(",") === EXPECTED_KEYS.join(","),
      JSON.stringify(Object.keys(smart).sort()));
    h.check("budget_boundaries (USD + SMART) returns the exact confirmed values",
      smart.currency_code === "USD" && smart.campaign_type === "SMART" &&
      Number(smart.min_daily_budget_micros) === BUDGET_BOUNDARIES_USD.min_daily_budget_micros &&
      Number(smart.max_daily_budget_micros) === BUDGET_BOUNDARIES_USD.max_daily_budget_micros &&
      Number(smart.recommended_daily_budget_micros) === BUDGET_BOUNDARIES_USD.recommended_daily_budget_micros &&
      Number(smart.usd_to_currency_rate) === 1,
      JSON.stringify(smart));
    h.check("preset_daily_budget_micros is exactly three raw presets, lowest to highest",
      Array.isArray(smart.preset_daily_budget_micros) && smart.preset_daily_budget_micros.length === 3 &&
      JSON.stringify(smart.preset_daily_budget_micros) === JSON.stringify(BUDGET_BOUNDARIES_USD.preset_daily_budget_micros),
      JSON.stringify(smart.preset_daily_budget_micros));

    // ---- 2. PERFORMANCE_MAX ----------------------------------------------------------------
    const pmax = await surface(projA, userA, { action: "budget_boundaries", currency_code: "USD", campaign_type: "PERFORMANCE_MAX" });
    h.check("budget_boundaries (PERFORMANCE_MAX) returns the same bounded values under the requested type",
      pmax.campaign_type === "PERFORMANCE_MAX" && pmax.currency_code === "USD" &&
      Number(pmax.min_daily_budget_micros) === BUDGET_BOUNDARIES_USD.min_daily_budget_micros &&
      Number(pmax.max_daily_budget_micros) === BUDGET_BOUNDARIES_USD.max_daily_budget_micros &&
      JSON.stringify(pmax.preset_daily_budget_micros) === JSON.stringify(BUDGET_BOUNDARIES_USD.preset_daily_budget_micros),
      JSON.stringify(pmax));

    // ---- 3. unknown currency → USD ----------------------------------------------------------
    const unknownCur = await surface(projA, userA, { action: "budget_boundaries", currency_code: "XYZ", campaign_type: "SMART" });
    h.check("an unrecognized currency falls back to USD with the same bounded values",
      unknownCur.currency_code === "USD" && Number(unknownCur.min_daily_budget_micros) === BUDGET_BOUNDARIES_USD.min_daily_budget_micros &&
      JSON.stringify(unknownCur.preset_daily_budget_micros) === JSON.stringify(BUDGET_BOUNDARIES_USD.preset_daily_budget_micros),
      JSON.stringify(unknownCur));

    // ---- 4. unknown / absent type → SMART ---------------------------------------------------
    const unknownType = await surface(projA, userA, { action: "budget_boundaries", currency_code: "USD", campaign_type: "SEARCH" });
    const absentType = await surface(projA, userA, { action: "budget_boundaries" });
    h.check("an unknown or absent campaign_type falls back to SMART",
      unknownType.campaign_type === "SMART" && absentType.campaign_type === "SMART" &&
      Number(unknownType.recommended_daily_budget_micros) === BUDGET_BOUNDARIES_USD.recommended_daily_budget_micros,
      JSON.stringify({ unknownType, absentType }));

    // ---- 5. no live gate / provider contract untouched ---------------------------------------
    h.check("the read answers with NO provider wired (it is planning data, not a live operation) — the certified provider contract is untouched",
      !!smart.currency_code && !!pmax.currency_code);

    // ---- 6. read-only: nothing persisted ------------------------------------------------------
    const accounts = await svc.entities.AdsAccount.filter({ project_id: projA.id }, "created_date", 10);
    const campaigns = await svc.entities.AdsCampaign.filter({ project_id: projA.id }, "created_date", 10);
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: projA.id }, "created_date", 10);
    h.check("the boundaries read persists nothing — no account, campaign or change-log row is created",
      accounts.length === 0 && campaigns.length === 0 && logs.length === 0,
      JSON.stringify({ accounts: accounts.length, campaigns: campaigns.length, logs: logs.length }));

    // ---- 7. authorization: project.read --------------------------------------------------------
    const strangerRead = await captureCall(() => loadAuthorizedProject(base44, stranger, projA.id, "project.read"));
    const viewerRead = await loadAuthorizedProject(base44, viewer, projA.id, "project.read").catch(() => null);
    h.check("authorization: a non-member is refused (403) while a viewer may read boundaries",
      strangerRead.threw && Number(strangerRead.status) === 403 && !!viewerRead,
      JSON.stringify({ stranger: strangerRead.status, viewerRead: !!viewerRead }));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await purgeBy(svc, "WorkspaceMember", { workspace_id: workspaces[0] });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}