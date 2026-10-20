// Targeted certification for the Grow Campaign Readiness panel over the EXISTING googleAds
// launch_readiness / launch / account_get actions. Never launches: launch is only exercised on
// paths that must refuse BEFORE the provider is called. Scratch fixtures purged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const caller = await base44.auth.me().catch(() => null);
  if (!caller || caller.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  let providerCalls = 0;
  const spy = new Proxy({}, { get: () => async () => { providerCalls++; return {}; } });

  try {
    const wsA = await svc.entities.Workspace.create({ name: `rd-A-${stamp}`, owner_id: `oA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `rd-B-${stamp}`, owner_id: `oB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    const pA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `rd-a-${stamp}`, status: "ready" });
    const pB = await svc.entities.Project.create({ workspace_id: wsB.id, name: `rd-b-${stamp}`, status: "ready", production_deployment_id: `dep_${stamp}`, visibility: "public" });
    projects.push(pA.id, pB.id);
    const userA = { id: `oA_${stamp}` }, userB = { id: `oB_${stamp}` };

    const r0 = await surface(pA, userA, { action: "launch_readiness", channel: "google" });
    h.check("unconfigured + unpublished + no landing page: not ready with the exact blockers",
      !r0.ready && ["PROVIDER_NOT_CONFIGURED", "APP_NOT_PUBLISHED", "LANDING_PAGE_MISSING"].every((b) => r0.blockers.includes(b)), JSON.stringify(r0.blockers));

    // Selecting/saving creatives does not change server readiness.
    const brief = (await surface(pA, userA, { action: "brief_create", campaign_type: "SEARCH", headlines: ["H"], descriptions: ["D"] })).brief;
    await surface(pA, userA, { action: "brief_update", brief_id: brief.id, headlines: ["H", "H2"] }, { provider: spy });
    const r1 = await surface(pA, userA, { action: "launch_readiness", channel: "google" });
    h.check("saving selected creatives does not make the campaign launch-ready", !r1.ready && r1.blockers.join() === r0.blockers.join(), JSON.stringify(r1.blockers));

    const acc = await surface(pA, userA, { action: "account_get", channel: "google" });
    h.check("no account: account_get returns null (shown as not connected)", acc.account === null, JSON.stringify(acc));

    const rB = await surface(pB, userB, { action: "launch_readiness", channel: "google", landing_page: "https://b.test" }, { provider: spy });
    h.check("published public project with provider and landing page: server readiness passes", rB.ready && rB.blockers.length === 0, JSON.stringify(rB.blockers));

    await svc.entities.AdsCampaign.bulkCreate([1, 2].map((i) => ({ project_id: pA.id, workspace_id: wsA.id, campaign_name: `c${i}`, campaign_type: "PERFORMANCE_MAX", status: "ENABLED", channel: "google" })));
    const rA2 = await surface(pA, userA, { action: "launch_readiness", channel: "google" }, { provider: spy });
    const rB2 = await surface(pB, userB, { action: "launch_readiness", channel: "google", landing_page: "https://b.test" }, { provider: spy });
    h.check("project isolation: A's active campaigns block A only", rA2.blockers.includes("ACTIVE_CAMPAIGN_LIMIT") && rB2.ready, JSON.stringify({ a: rA2.blockers, b: rB2.blockers }));

    const noProv = await captureCall(() => surface(pA, userA, { action: "launch", channel: "google", campaign_name: "x", daily_budget_micros: 1e7 }));
    h.check("launch fails closed without the provider", noProv.threw && noProv.code === "PROVIDER_NOT_CONFIGURED", JSON.stringify({ code: noProv.code }));
    const blocked = await captureCall(() => surface(pA, userA, { action: "launch", channel: "google", campaign_name: "x", daily_budget_micros: 1e7 }, { provider: spy }));
    h.check("launch is refused server-side when readiness fails (LAUNCH_BLOCKED), provider never called",
      blocked.threw && blocked.code === "LAUNCH_BLOCKED" && providerCalls === 0, JSON.stringify({ code: blocked.code, providerCalls }));

    const strangerRead = await captureCall(() => loadAuthorizedProject(svc, { id: `x_${stamp}` }, pA.id, "project.read"));
    const crossWrite = await captureCall(() => loadAuthorizedProject(svc, userB, pA.id, "project.write"));
    const ownerWrite = await captureCall(() => loadAuthorizedProject(svc, userA, pA.id, "project.write"));
    h.check("authorization: non-member cannot read readiness", strangerRead.threw, JSON.stringify({ code: strangerRead.code }));
    h.check("authorization: another workspace's owner cannot launch on project A", crossWrite.threw, JSON.stringify({ code: crossWrite.code }));
    h.check("authorization: project A's owner may launch (project.write)", !ownerWrite.threw, JSON.stringify({ code: ownerWrite.code }));

    const accs = await svc.entities.AdsAccount.filter({ project_id: pA.id }, "created_date", 5);
    const camps = await svc.entities.AdsCampaign.filter({ project_id: pA.id }, "created_date", 10);
    const campsB = await svc.entities.AdsCampaign.filter({ project_id: pB.id }, "created_date", 5);
    h.check("no launch side effects: no accounts, no new campaigns in A or B",
      accs.length === 0 && camps.length === 2 && campsB.length === 0, JSON.stringify({ accs: accs.length, a: camps.length, b: campsB.length }));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      for (const ent of ["AdsBrief", "AdsChangeLog", "AdsAccount", "AdsCampaign"]) await purgeBy(svc, ent, { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }
  return harnessResponse(h);
}