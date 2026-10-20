// Targeted certification for the Google Ads UI/UX parity gates (the completed connection UX
// audit) through the REAL surface and REAL persistence, with the same deterministic stub
// provider — no real ads, no spend, no network:
//   • launch-readiness gates: APP_NOT_PUBLISHED (must be published), APP_NOT_PUBLIC (must be
//     publicly visible), ACTIVE_CAMPAIGN_LIMIT (the documented 2-active-campaign cap);
//   • launch through the stub honors the gates: a third launch is blocked until one campaign
//     is paused, and an unpublished or non-public project can never launch;
//   • the account projection the account card renders;
//   • Cancel all → account_disconnect with budget_end_confirmed;
//   • the campaign projection the list renders (review/serving status, the "Needs attention"
//     source), verbatim from the provider;
//   • authorization: viewer read-only, stranger refused.
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
  const withStub = (input) => ({ provider: stub, ...input });
  const campaignsOf = (projectId) => svc.entities.AdsCampaign.filter({ project_id: projectId }, "created_date", 100);

  try {
    const wsA = await svc.entities.Workspace.create({ name: `adsui-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    workspaces.push(wsA.id);
    const pub = await svc.entities.Project.create({
      workspace_id: wsA.id, name: `adsui-pub-${stamp}`, status: "ready", version_count: 1,
      production_deployment_id: "dep-ui", visibility: "public",
    });
    const unpub = await svc.entities.Project.create({ workspace_id: wsA.id, name: `adsui-unpub-${stamp}`, status: "ready", version_count: 1 });
    const priv = await svc.entities.Project.create({
      workspace_id: wsA.id, name: `adsui-priv-${stamp}`, status: "ready", version_count: 1,
      production_deployment_id: "dep-ui", visibility: "private",
    });
    projects.push(pub.id, unpub.id, priv.id);
    const userA = { id: `ownerA_${stamp}`, email: "a@example.com" };

    // ---- 1. the readiness gates ----------------------------------------------------------
    const unpubReady = await surface(unpub, userA, { action: "launch_readiness" });
    h.check("an unpublished project reports APP_NOT_PUBLISHED (and invents no readiness)",
      unpubReady.ready === false && unpubReady.blockers.includes("APP_NOT_PUBLISHED") && unpubReady.blockers.includes("PROVIDER_NOT_CONFIGURED"),
      JSON.stringify(unpubReady.blockers));
    const privReady = await surface(priv, userA, { action: "launch_readiness" });
    h.check("a private (non-public) app reports APP_NOT_PUBLIC",
      privReady.ready === false && privReady.blockers.includes("APP_NOT_PUBLIC") && !privReady.blockers.includes("APP_NOT_PUBLISHED"),
      JSON.stringify(privReady.blockers));
    const pubReady = await surface(pub, userA, { action: "launch_readiness", landing_page: "https://x.test" }, withStub({}));
    h.check("a published public project with no campaigns clears the new gates through a live provider",
      pubReady.ready === true && !pubReady.blockers.includes("APP_NOT_PUBLISHED") && !pubReady.blockers.includes("APP_NOT_PUBLIC") && !pubReady.blockers.includes("ACTIVE_CAMPAIGN_LIMIT"),
      JSON.stringify(pubReady.blockers));

    // ---- 2. unpublished / non-public can never launch --------------------------------------
    const unpubLaunch = await captureCall(() => surface(unpub, userA, { action: "launch", campaign_name: "x", daily_budget_micros: 15000000 }, withStub({})));
    h.check("launch on an unpublished project is refused before anything is created",
      unpubLaunch.threw && unpubLaunch.code === "LAUNCH_BLOCKED" &&
      (await svc.entities.AdsCampaign.filter({ project_id: unpub.id }, "created_date", 10)).length === 0,
      JSON.stringify({ code: unpubLaunch.code }));
    const privLaunch = await captureCall(() => surface(priv, userA, { action: "launch", campaign_name: "x", daily_budget_micros: 15000000 }, withStub({})));
    h.check("launch on a private app is refused before anything is created",
      privLaunch.threw && privLaunch.code === "LAUNCH_BLOCKED" &&
      (await svc.entities.AdsCampaign.filter({ project_id: priv.id }, "created_date", 10)).length === 0,
      JSON.stringify({ code: privLaunch.code }));

    // ---- 3. the 2-active-campaign cap ------------------------------------------------------
    const l1 = await surface(pub, userA, { action: "launch", campaign_name: "One", daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({}));
    const l2 = await surface(pub, userA, { action: "launch", campaign_name: "Two", daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({}));
    h.check("two launches succeed while under the documented cap",
      l1.campaigns.length === 1 && l2.campaigns.length === 1, JSON.stringify({ c1: l1.campaigns.length, c2: l2.campaigns.length }));
    let l3err = null;
    try { await surface(pub, userA, { action: "launch", campaign_name: "Three", daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({})); }
    catch (e) { l3err = e; }
    h.check("a third launch is blocked with ACTIVE_CAMPAIGN_LIMIT and creates nothing",
      !!l3err && l3err.code === "LAUNCH_BLOCKED" && (l3err.blockers || []).includes("ACTIVE_CAMPAIGN_LIMIT") &&
      (await campaignsOf(pub.id)).length === 2,
      JSON.stringify({ code: l3err?.code, blockers: l3err?.blockers }));
    const paused = await surface(pub, userA, { action: "campaign_pause", campaign_id: l1.campaigns[0].id }, { provider: stub });
    h.check("pausing one campaign returns PAUSED (the documented way to start a third)",
      paused.campaign.status === "PAUSED", paused.campaign.status);
    const l4 = await surface(pub, userA, { action: "launch", campaign_name: "Three", daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({}));
    h.check("after pausing one campaign the next launch succeeds (the cap is dynamic, not lifetime)",
      l4.campaigns.length === 1, JSON.stringify({ campaigns: (await campaignsOf(pub.id)).length }));

    // ---- 4. the account projection the account card renders --------------------------------
    const acc = await surface(pub, userA, { action: "account_get" });
    h.check("account_get carries every field the account card renders",
      !!acc.account && ["id", "channel", "status", "currency_code", "billing_cadence", "payment_on_file", "spend_cap_micros", "provider_configured"].every((k) => k in acc.account),
      JSON.stringify(acc.account));

    // ---- 5. Cancel all → account_disconnect with budget_end_confirmed ----------------------
    const disc = await surface(pub, userA, { action: "account_disconnect" }, { provider: stub });
    h.check("Cancel all maps to account_disconnect and confirms the budget end",
      disc.account.status === "disconnected" && disc.budget_end_confirmed === true, JSON.stringify(disc));
    let afterDisc = null;
    try { await surface(pub, userA, { action: "launch", campaign_name: "Four", daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({})); }
    catch (e) { afterDisc = e; }
    h.check("a disconnected account blocks the next launch (ACCOUNT_NOT_ACTIVE)",
      !!afterDisc && afterDisc.code === "LAUNCH_BLOCKED" && (afterDisc.blockers || []).includes("ACCOUNT_NOT_ACTIVE"),
      JSON.stringify({ code: afterDisc?.code, blockers: afterDisc?.blockers }));

    // ---- 6. the campaign projection the list renders (Needs attention source) --------------
    const row = l2.campaigns[0];
    await svc.entities.AdsCampaign.update(row.id, { review_status: "UNDER_REVIEW", serving_status: "CAMPAIGN_PENDING" });
    const got = await surface(pub, userA, { action: "campaign_get", campaign_id: row.id });
    h.check("the campaign projection carries the provider review/serving status verbatim",
      got.campaign.review_status === "UNDER_REVIEW" && got.campaign.serving_status === "CAMPAIGN_PENDING",
      JSON.stringify({ review: got.campaign.review_status, serving: got.campaign.serving_status }));
    const listed = await surface(pub, userA, { action: "campaign_list" });
    h.check("the list projection exposes review/serving status and metrics_pending for every row",
      listed.campaigns.length >= 3 && listed.campaigns.every((c) => "review_status" in c && "serving_status" in c && "metrics_pending" in c),
      JSON.stringify(listed.campaigns.map((c) => c.status)));

    // ---- 7. authorization: viewer read-only, stranger refused -------------------------------
    const viewer = { id: "ui_viewer", email: "v@example.com" };
    const stranger = { id: "ui_stranger", email: "s@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });
    const viewerWrite = await captureCall(() => loadAuthorizedProject(base44, viewer, pub.id, "project.write"));
    const strangerWrite = await captureCall(() => loadAuthorizedProject(base44, stranger, pub.id, "project.write"));
    const viewerRead = await loadAuthorizedProject(base44, viewer, pub.id, "project.read").catch(() => null);
    h.check("a viewer can read but cannot write; a non-member is refused (403)",
      viewerWrite.threw && Number(viewerWrite.status) === 403 && strangerWrite.threw && Number(strangerWrite.status) === 403 && !!viewerRead,
      JSON.stringify({ viewerWrite: viewerWrite.status, strangerWrite: strangerWrite.status, viewerRead: !!viewerRead }));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const pid of projects) {
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsBrief", { project_id: pid });
      await purgeBy(svc, "AdsAssetSession", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await purgeBy(svc, "AdsConversionMapping", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) {
      await purgeBy(svc, "WorkspaceMember", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }

  return harnessResponse(h);
}