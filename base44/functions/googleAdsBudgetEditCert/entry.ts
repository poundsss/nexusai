// Targeted certification for the confirmed per-campaign budget-edit gap (DOCUMENTED Base44:
// PATCH /google-ads/campaigns/{campaign_id} with field "budget" — the daily budget is editable
// after launch; the response carries the campaign with the changed budget).
//
// Drives the REAL surface, the REAL persistence and the REAL authorization choke point with the
// SAME deterministic stub provider googleAdsCert injects. NO real Google Ads call, no spend,
// no new entities, no schema change — the certified campaign_update contract is exercised as-is.
//
// Certified: viewer/stranger authorization; invalid and non-positive budgets refused with
// INVALID_BUDGET and no row touched; the fail-closed provider gate (PROVIDER_NOT_CONFIGURED)
// touches nothing; a valid update persists the new micros, stamps last_synced_at and attributes
// the change log; a repeated update succeeds and persists again.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { makeAdsStubProvider, makeAdsSurface } from "../../shared/adsCertStubs.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  const surface = makeAdsSurface(svc);
  const stub = makeAdsStubProvider();

  const mkCampaign = (project, wsId, name, micros) => svc.entities.AdsCampaign.create({
    project_id: project.id, workspace_id: wsId, channel: "google", campaign_name: name,
    campaign_type: "PERFORMANCE_MAX", status: "ENABLED", daily_budget_micros: micros, metrics_pending: true,
  });

  try {
    const wsA = await svc.entities.Workspace.create({ name: `budgetedit-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    workspaces.push(wsA.id);
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `budgetedit-a-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-budgetedit" });
    projects.push(projA.id);
    const userA = { id: `ownerA_${stamp}`, email: "a@example.com" };
    const stranger = { id: "budgetedit_stranger", email: "stranger@example.com" };
    const viewer = { id: "budgetedit_viewer", email: "viewer@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });
    const row = await mkCampaign(projA, wsA.id, "Alpha", 15000000);

    // ---- 1. authorization ----------------------------------------------------------------
    const strangerWrite = await captureCall(() => loadAuthorizedProject(base44, stranger, projA.id, "project.write"));
    const viewerWrite = await captureCall(() => loadAuthorizedProject(base44, viewer, projA.id, "project.write"));
    const viewerRead = await loadAuthorizedProject(base44, viewer, projA.id, "project.read").catch(() => null);
    h.check("authorization: a non-member and a viewer cannot edit a budget; a viewer can read",
      strangerWrite.threw && Number(strangerWrite.status) === 403 && viewerWrite.threw && Number(viewerWrite.status) === 403 && !!viewerRead,
      JSON.stringify({ stranger: strangerWrite.status, viewerWrite: viewerWrite.status, viewerRead: !!viewerRead }));

    // ---- 2. invalid / non-positive budgets --------------------------------------------------
    const invalid = [];
    for (const bad of [0, -10000000, 15.5]) {
      const attempt = await captureCall(() => surface(projA, userA, { action: "campaign_update", campaign_id: row.id, daily_budget_micros: bad }, { provider: stub }));
      const fresh = await svc.entities.AdsCampaign.get(row.id);
      invalid.push(attempt.threw && attempt.code === "INVALID_BUDGET" && Number(fresh.daily_budget_micros) === 15000000);
    }
    h.check("invalid budgets (0, negative, non-integer) are refused with INVALID_BUDGET and the row is untouched",
      invalid.every(Boolean), JSON.stringify(invalid));

    // ---- 3. the fail-closed gate -------------------------------------------------------------
    const closed = await captureCall(() => surface(projA, userA, { action: "campaign_update", campaign_id: row.id, daily_budget_micros: 20000000 }));
    const afterClosed = await svc.entities.AdsCampaign.get(row.id);
    h.check("budget edit FAILS CLOSED without a provider (PROVIDER_NOT_CONFIGURED) and no row is touched",
      closed.threw && closed.code === "PROVIDER_NOT_CONFIGURED" && Number(afterClosed.daily_budget_micros) === 15000000,
      JSON.stringify({ code: closed.code }));

    // ---- 4. valid update: persistence + projection ------------------------------------------
    const res = await surface(projA, userA, { action: "campaign_update", campaign_id: row.id, daily_budget_micros: 20000000 }, { provider: stub });
    const afterValid = await svc.entities.AdsCampaign.get(row.id);
    h.check("a valid update returns the campaign with the new budget, persists 20000000 micros and stamps last_synced_at",
      res.campaign && res.campaign.id === row.id && Number(res.campaign.daily_budget_micros) === 20000000 &&
      Number(afterValid.daily_budget_micros) === 20000000 && !!afterValid.last_synced_at,
      JSON.stringify({ projection: res.campaign ? res.campaign.daily_budget_micros : null, persisted: afterValid.daily_budget_micros, synced: !!afterValid.last_synced_at }));

    // ---- 5. repeated update -------------------------------------------------------------------
    const res2 = await surface(projA, userA, { action: "campaign_update", campaign_id: row.id, daily_budget_micros: 25000000 }, { provider: stub });
    const afterRepeat = await svc.entities.AdsCampaign.get(row.id);
    h.check("a repeated update succeeds and persists the new budget again (25000000 micros)",
      res2.campaign && Number(res2.campaign.daily_budget_micros) === 25000000 && Number(afterRepeat.daily_budget_micros) === 25000000,
      JSON.stringify({ projection: res2.campaign ? res2.campaign.daily_budget_micros : null, persisted: afterRepeat.daily_budget_micros }));

    // ---- 6. change-log attribution -------------------------------------------------------------
    const log = await surface(projA, userA, { action: "change_log_list" });
    const entries = log.changes.filter((c) => c.action === "campaign.updated" && (c.detail || {}).changed && c.detail.changed.includes("daily_budget_micros"));
    h.check("each budget edit is attributed in the change log with member scope and the changed field",
      entries.length === 2 && entries.every((c) => c.actor === "member" && c.scope === "campaign"),
      JSON.stringify(entries.length));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}