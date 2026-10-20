// Targeted certification for the confirmed Pause-all parity gap (DOCUMENTED Base44:
// POST /google-ads/campaigns/pause-all — the account's spend kill switch; the response reports
// exactly { status: "paused" | "partial", paused_count, total_count, failed_count }).
//
// Drives the REAL surface, the REAL persistence and the REAL authorization choke point with the
// SAME deterministic stub provider googleAdsCert injects — a wrapper around it that refuses one
// campaign supplies the partial-failure case. NO real Google Ads call, no spend, no new entities.
//
// Certified: fail-closed without a provider (no row touched); zero campaigns; all success
// (REMOVED tombstones excluded from the attempt); repeated invocation idempotent; partial
// failure leaves the refused campaign ENABLED and reports the exact documented projection;
// viewer/stranger authorization; the change-log attribution.
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

  // A stub whose pause path succeeds for every campaign EXCEPT one id — the deterministic
  // partial-failure provider. Everything else is the certified base stub, untouched.
  const stubExcept = (failId) => ({
    ...stub,
    pauseCampaign: async ({ campaign }) => {
      if (String(campaign.id) === String(failId)) {
        throw Object.assign(new Error("the provider refused this campaign"), { code: "PROVIDER_ERROR" });
      }
      return stub.pauseCampaign({ campaign });
    },
  });

  const mkCampaign = (project, wsId, name, status) => svc.entities.AdsCampaign.create({
    project_id: project.id, workspace_id: wsId, channel: "google", campaign_name: name,
    campaign_type: "PERFORMANCE_MAX", status, daily_budget_micros: 15000000, metrics_pending: true,
  });

  try {
    const wsA = await svc.entities.Workspace.create({ name: `pauseall-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `pauseall-B-${stamp}`, owner_id: `ownerB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `pauseall-a-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-pauseall" });
    const projB = await svc.entities.Project.create({ workspace_id: wsB.id, name: `pauseall-b-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-pauseall" });
    projects.push(projA.id, projB.id);
    const userA = { id: `ownerA_${stamp}`, email: "a@example.com" };
    const stranger = { id: "pauseall_stranger", email: "stranger@example.com" };
    const viewer = { id: "pauseall_viewer", email: "viewer@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });

    // ---- 1. authorization ----------------------------------------------------------------
    const strangerWrite = await captureCall(() => loadAuthorizedProject(base44, stranger, projA.id, "project.write"));
    const viewerWrite = await captureCall(() => loadAuthorizedProject(base44, viewer, projA.id, "project.write"));
    const viewerRead = await loadAuthorizedProject(base44, viewer, projA.id, "project.read").catch(() => null);
    h.check("authorization: a non-member and a viewer cannot run the mutating action; a viewer can read",
      strangerWrite.threw && Number(strangerWrite.status) === 403 && viewerWrite.threw && Number(viewerWrite.status) === 403 && !!viewerRead,
      JSON.stringify({ stranger: strangerWrite.status, viewerWrite: viewerWrite.status, viewerRead: !!viewerRead }));

    // ---- 2. zero campaigns ----------------------------------------------------------------
    const zero = await surface(projB, userA, { action: "campaign_pause_all" }, { provider: stub });
    h.check("zero campaigns: the documented kill-switch projection with nothing attempted",
      JSON.stringify(Object.keys(zero)) === JSON.stringify(["status", "paused_count", "total_count", "failed_count"]) &&
      zero.status === "paused" && zero.paused_count === 0 && zero.total_count === 0 && zero.failed_count === 0,
      JSON.stringify(zero));

    // ---- 3. the fail-closed gate -----------------------------------------------------------
    const rows = [await mkCampaign(projA, wsA.id, "Alpha", "ENABLED"), await mkCampaign(projA, wsA.id, "Beta", "ENABLED"), await mkCampaign(projA, wsA.id, "Old", "REMOVED")];
    const closed = await captureCall(() => surface(projA, userA, { action: "campaign_pause_all" }));
    const afterClosed = await Promise.all(rows.map((r) => svc.entities.AdsCampaign.get(r.id)));
    h.check("pause-all FAILS CLOSED without a provider (PROVIDER_NOT_CONFIGURED) and no row is touched",
      closed.threw && closed.code === "PROVIDER_NOT_CONFIGURED" && afterClosed.every((r) => r.status === (r.campaign_name === "Old" ? "REMOVED" : "ENABLED")),
      JSON.stringify({ code: closed.code }));

    // ---- 4. all success --------------------------------------------------------------------
    const all = await surface(projA, userA, { action: "campaign_pause_all" }, { provider: stub });
    const afterAll = await Promise.all(rows.map((r) => svc.entities.AdsCampaign.get(r.id)));
    h.check("all success: exactly the documented projection { paused, 2, 2, 0 }; both live rows PAUSED; the REMOVED tombstone excluded and untouched",
      all.status === "paused" && all.paused_count === 2 && all.total_count === 2 && all.failed_count === 0 &&
      afterAll[0].status === "PAUSED" && afterAll[1].status === "PAUSED" && afterAll[2].status === "REMOVED" && !afterAll[2].last_synced_at,
      JSON.stringify(all));

    // ---- 5. repeated invocation (idempotent) ------------------------------------------------
    const again = await surface(projA, userA, { action: "campaign_pause_all" }, { provider: stub });
    h.check("repeated invocation is idempotent: already-paused campaigns pause again, same projection, no error",
      again.status === "paused" && again.paused_count === 2 && again.total_count === 2 && again.failed_count === 0,
      JSON.stringify(again));

    // ---- 6. partial failure -----------------------------------------------------------------
    const p1 = await mkCampaign(projB, wsB.id, "One", "ENABLED");
    const p2 = await mkCampaign(projB, wsB.id, "Two", "ENABLED");
    const partial = await surface(projB, userA, { action: "campaign_pause_all" }, { provider: stubExcept(p1.id) });
    const afterPartial = await Promise.all([p1, p2].map((r) => svc.entities.AdsCampaign.get(r.id)));
    h.check("partial failure: the documented projection { partial, 1, 2, 1 }; the refused campaign stays ENABLED, the other paused",
      partial.status === "partial" && partial.paused_count === 1 && partial.total_count === 2 && partial.failed_count === 1 &&
      afterPartial[0].status === "ENABLED" && afterPartial[1].status === "PAUSED",
      JSON.stringify(partial));

    // ---- 7. change-log attribution -----------------------------------------------------------
    const log = await surface(projA, userA, { action: "change_log_list" });
    const entry = log.changes.find((c) => c.action === "campaign.pause_all");
    h.check("the change log records the pause-all with member attribution and the counts",
      !!entry && entry.actor === "member" && entry.scope === "campaign" && entry.detail && entry.detail.status === "paused" && entry.detail.total_count === 2,
      JSON.stringify(entry || null));
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