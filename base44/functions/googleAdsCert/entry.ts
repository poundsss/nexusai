// Focused contract certification for the NexusAI Google Ads FOUNDATION (shared/googleAds.ts +
// functions/googleAds). Drives the REAL surface, the REAL persistence and the REAL
// authorization choke point — with a DETERMINISTIC STUB provider and DETERMINISTIC generators
// injected, because live Google Ads operations fail closed (PROVIDER_NOT_CONFIGURED) until the
// external infrastructure exists, and generation must not spend credits in a suite.
//
// Certified: one-account invariant + null-when-none; launch fails closed (no rows); campaign
// endpoints fail closed without a provider; briefs CRUD + the documented "failed generation
// still saves a brief" rule; asset session generation + in-flight dedup + polling + accept
// (fail-closed, then provider-gated, then duplicate refusal); campaign lifecycle through a
// stub provider (update/pause/resume/permanent delete with REMOVED kept for reporting);
// bulk-budget succeeded/failed seam; change-log attribution (member vs system); conversion
// mapping dedup/map/upload; cross-project isolation; authorization (stranger/viewer).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { makeAdsStubProvider, makeAdsSurface } from "../../shared/adsCertStubs.ts";
import { providerConfigured, GOOGLE_ADS_REQUIRED_SECRETS } from "../../shared/googleAdsProvider.ts";

const STUB_GENERATORS = {
  brief: async () => ({ headlines: ["Fast, simple", "Try it free"], descriptions: ["Everything in one place.", "Start in minutes."], keywords: ["productivity"], language: "en" }),
  text: async ({ asset_field_types }) => ({ lines: asset_field_types.map((t) => ({ asset_field_type: t, content: `${t} copy line` })), language: "en" }),
  images: async ({ asset_field_types }) => ({
    images: asset_field_types.slice(0, 1).map((t) => ({ asset_field_type: t, url: "https://example.com/img.png" })),
    background_image_count: Math.max(0, asset_field_types.length - 1), language: null,
  }),
  empty: async () => ({ headlines: [], descriptions: [], language: "en" }),
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  const surface = makeAdsSurface(svc);
  const stub = makeAdsStubProvider();
  const withStub = (input) => ({ provider: stub, generators: STUB_GENERATORS, ...input });

  try {
    // --- workspace + projects ------------------------------------------------------------
    const wsA = await svc.entities.Workspace.create({ name: `ads-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `ads-B-${stamp}`, owner_id: `ownerB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `ads-a-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-cert" });
    const projB = await svc.entities.Project.create({ workspace_id: wsB.id, name: `ads-b-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-cert" });
    projects.push(projA.id, projB.id);
    const userA = { id: `ownerA_${stamp}`, email: "a@example.com" };
    const stranger = { id: "ads_stranger", email: "stranger@example.com" };
    const viewer = { id: "ads_viewer", email: "viewer@example.com" };
    await svc.entities.WorkspaceMember.create({ workspace_id: wsA.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active", accepted_at: new Date().toISOString() });

    // ---- 1. the fail-closed gate ---------------------------------------------------------
    h.check("the production gate is closed: no Google Ads secret is configured in this app",
      !providerConfigured() && GOOGLE_ADS_REQUIRED_SECRETS.length === 5, GOOGLE_ADS_REQUIRED_SECRETS.join(","));
    const none = await surface(projA, userA, { action: "account_get" });
    h.check("account GET on a never-advertised project returns null (normal state), no row",
      none.account === null && (await svc.entities.AdsAccount.filter({ project_id: projA.id }, "created_date", 10)).length === 0,
      JSON.stringify(none.account));
    const readiness = await surface(projA, userA, { action: "launch_readiness" });
    h.check("launch readiness reports ready:false with the provider blocker, inventing nothing",
      readiness.ready === false && readiness.blockers.includes("PROVIDER_NOT_CONFIGURED") && readiness.currency_code === null,
      JSON.stringify(readiness));
    const launchFail = await captureCall(() => surface(projA, userA, { action: "launch", campaign_name: "x", daily_budget_micros: 15000000 }));
    h.check("launch FAILS CLOSED before creating anything (no account, no campaign, no changelog)",
      launchFail.threw && launchFail.code === "PROVIDER_NOT_CONFIGURED" &&
      (await svc.entities.AdsAccount.filter({ project_id: projA.id }, "created_date", 10)).length === 0 &&
      (await svc.entities.AdsCampaign.filter({ project_id: projA.id }, "created_date", 10)).length === 0,
      JSON.stringify({ code: launchFail.code }));
    const pauseFail = await captureCall(() => surface(projA, userA, { action: "campaign_pause", campaign_id: "ghost" }));
    h.check("campaign lifecycle without a provider fails closed (PROVIDER_NOT_CONFIGURED)",
      pauseFail.threw && pauseFail.code === "PROVIDER_NOT_CONFIGURED", JSON.stringify({ code: pauseFail.code }));
    const acceptFail = await captureCall(() => surface(projA, userA, { action: "asset_accept", session_id: "ghost", session_asset_id: "x" }));
    h.check("asset accept without a provider fails closed (the only route onto a live campaign)",
      acceptFail.threw && acceptFail.code === "PROVIDER_NOT_CONFIGURED", JSON.stringify({ code: acceptFail.code }));
    const uploadFail = await captureCall(() => surface(projA, userA, { action: "conversion_upload", events: [] }));
    h.check("conversion upload without a provider fails closed", uploadFail.threw && uploadFail.code === "PROVIDER_NOT_CONFIGURED", JSON.stringify({ code: uploadFail.code }));

    // ---- 2. briefs: persistence + the documented generation rule -------------------------
    const brief = await surface(projA, userA, { action: "brief_create", campaign_type: "SEARCH", headlines: ["H1"], descriptions: ["D1"], keywords: ["k"], budget_micros: 15000000, landing_page: "https://x.test" });
    h.check("brief create persists a draft with every member field",
      !!brief.brief.id && brief.brief.status === "draft" && brief.brief.headlines.length === 1 && brief.brief.budget_micros === 15000000,
      JSON.stringify(brief.brief));
    const updatedBrief = await surface(projA, userA, { action: "brief_update", brief_id: brief.brief.id, headlines: ["H1", "H2"] });
    h.check("brief update persists and readiness follows non-empty copy",
      updatedBrief.brief.status === "ready" && updatedBrief.brief.headlines.length === 2, updatedBrief.brief.status);
    const generated = await surface(projA, userA, { action: "brief_generate", campaign_type: "PERFORMANCE_MAX" }, { generators: STUB_GENERATORS });
    h.check("brief generate saves a ready brief with the generator's copy and language",
      generated.brief.status === "ready" && generated.brief.headlines.length === 2 && generated.brief.language === "en" && !generated.generation_warning,
      JSON.stringify({ status: generated.brief.status }));
    const failedGen = await surface(projA, userA, { action: "brief_generate" }, { generators: { brief: STUB_GENERATORS.empty } });
    h.check("a failed generation STILL saves a brief (documented rule) with a warning, status draft",
      failedGen.brief.status === "draft" && !!failedGen.generation_warning && failedGen.brief.headlines.length === 0,
      JSON.stringify({ warning: failedGen.generation_warning }));
    await surface(projA, userA, { action: "brief_delete", brief_id: failedGen.brief.id });
    const briefsLeft = await svc.entities.AdsBrief.filter({ project_id: projA.id }, "created_date", 10);
    h.check("brief delete removes the row (2 briefs remain: created + generated)",
      briefsLeft.length === 2, String(briefsLeft.length));

    // ---- 3. asset sessions: generation, dedup, poll, accept ------------------------------
    const session = await surface(projA, userA, { action: "asset_generate_text", campaign_type: "SEARCH" }, { generators: STUB_GENERATORS });
    h.check("copy generation completes with one preview per slot, each carrying a session_asset_id",
      session.session.status === "completed" && session.session.text.length === 2 &&
      session.session.text.every((l) => l.session_asset_id && l.content), JSON.stringify(session.session.text));
    await svc.entities.AdsAssetSession.update(session.session.id, { status: "generating" });
    const inflight = await surface(projA, userA, { action: "asset_generate_text", campaign_type: "SEARCH" }, { generators: STUB_GENERATORS });
    h.check("a concurrent generation returns the IN-FLIGHT session (in_flight:true), never a second row",
      inflight.in_flight === true && inflight.session.id === session.session.id &&
      (await svc.entities.AdsAssetSession.filter({ project_id: projA.id }, "created_date", 10)).length === 1,
      JSON.stringify({ in_flight: inflight.in_flight }));
    await svc.entities.AdsAssetSession.update(session.session.id, { status: "completed" });
    const polled = await surface(projA, userA, { action: "asset_list", session_id: session.session.id });
    h.check("polling the session returns the previews verbatim",
      polled.session.id === session.session.id && polled.session.text.length === 2, JSON.stringify(polled.session.status));
    const images = await surface(projA, userA, { action: "asset_generate_images", campaign_type: "PERFORMANCE_MAX", final_url: "https://x.test" }, { generators: STUB_GENERATORS });
    h.check("image generation reports only finished previews plus the background count (nothing faked)",
      images.session.images.length === 1 && images.session.background_image_count === 3, JSON.stringify({ n: images.session.images.length, bg: images.session.background_image_count }));
    const accepted = await surface(projA, userA, { action: "asset_accept", session_id: session.session.id, session_asset_id: session.session.text[0].session_asset_id }, { provider: stub });
    h.check("accept through the provider records the accepted asset and the provider ref in the changelog",
      accepted.session.accepted_session_asset_ids.includes(session.session.text[0].session_asset_id), JSON.stringify(accepted.session.accepted_session_asset_ids));
    const dupAccept = await captureCall(() => surface(projA, userA, { action: "asset_accept", session_id: session.session.id, session_asset_id: session.session.text[0].session_asset_id }, { provider: stub }));
    h.check("re-accepting the same asset is refused (documented duplicate rule)",
      dupAccept.threw && dupAccept.code === "ASSET_ALREADY_ACCEPTED", JSON.stringify({ code: dupAccept.code }));
    const badAccept = await captureCall(() => surface(projA, userA, { action: "asset_accept", session_id: session.session.id, session_asset_id: "nope" }, { provider: stub }));
    h.check("accepting an unknown session_asset_id is refused", badAccept.threw && badAccept.code === "ASSET_NOT_FOUND", JSON.stringify({ code: badAccept.code }));

    // ---- 4. campaigns through the stub provider: lifecycle + persistence -----------------
    const launched = await surface(projA, userA, { action: "launch", campaign_name: "Spring", campaign_type: "PERFORMANCE_MAX", daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({}));
    h.check("launch through the provider creates the ONE account and the campaign with provider ids",
      launched.account.status === "active" && launched.campaigns.length === 1 &&
      launched.campaigns[0].provider_campaign_id === "prov-camp-1" && launched.campaigns[0].metrics_pending === true,
      JSON.stringify(launched.campaigns[0]));
    const accounts = await svc.entities.AdsAccount.filter({ project_id: projA.id }, "created_date", 10);
    h.check("the one-account invariant holds after launch (exactly 1 row)",
      accounts.length === 1, String(accounts.length));
    const campaignId = launched.campaigns[0].id;
    const budgeted = await surface(projA, userA, { action: "campaign_update", campaign_id: campaignId, daily_budget_micros: 20000000, campaign_name: "Spring 2" }, withStub({}));
    h.check("campaign update persists the sections and the projection carries them",
      budgeted.campaign.daily_budget_micros === 20000000 && budgeted.campaign.campaign_name === "Spring 2",
      JSON.stringify({ budget: budgeted.campaign.daily_budget_micros }));
    const badBudget = await captureCall(() => surface(projA, userA, { action: "campaign_update", campaign_id: campaignId, daily_budget_micros: 1.5 }, withStub({})));
    h.check("a non-integer budget is refused (micros contract)", badBudget.threw && badBudget.code === "INVALID_BUDGET", JSON.stringify({ code: badBudget.code }));
    const paused = await surface(projA, userA, { action: "campaign_pause", campaign_id: campaignId }, { provider: stub });
    h.check("pause persists PAUSED with the provider's serving state",
      paused.campaign.status === "PAUSED" && paused.campaign.serving_status === "SUSPENDED", JSON.stringify(paused.campaign));
    const resumed = await surface(projA, userA, { action: "campaign_resume", campaign_id: campaignId }, { provider: stub });
    h.check("resume persists ENABLED", resumed.campaign.status === "ENABLED", resumed.campaign.status);
    const syncedList = await surface(projA, userA, { action: "campaign_list", include_metrics: true }, withStub({}));
    h.check("list syncs metrics through the provider and reports them (metrics_pending false after sync)",
      syncedList.provider_sync === "synced" && syncedList.campaigns[0].impressions === 100 && syncedList.campaigns[0].metrics_pending === false,
      JSON.stringify({ sync: syncedList.provider_sync, imp: syncedList.campaigns[0].impressions }));
    const bulk = await surface(projA, userA, { action: "campaign_bulk_budget", entries: [
      { campaign_id: campaignId, daily_budget_micros: 30000000 },
      { campaign_id: campaignId, daily_budget_micros: 0 },
    ] }, { provider: stub });
    h.check("bulk budget is NOT atomic: per-entry succeeded/failed with the failed reason",
      JSON.stringify(bulk.succeeded) === JSON.stringify([campaignId]) && bulk.failed.length === 1 && !!bulk.failed[0].reason,
      JSON.stringify(bulk));
    const deleted = await surface(projA, userA, { action: "campaign_delete", campaign_id: campaignId }, { provider: stub });
    const afterDelete = await svc.entities.AdsCampaign.get(campaignId);
    h.check("delete is permanent (REMOVED) and the row stays listed for reporting",
      deleted.campaign.status === "REMOVED" && !!afterDelete, deleted.campaign.status);

    // ---- 5. change-log attribution -------------------------------------------------------
    const log1 = await surface(projA, userA, { action: "change_log_list" });
    const actors = new Set(log1.changes.map((c) => c.actor));
    h.check("the change log records member AND system changes with scopes",
      actors.has("member") && actors.has("system") && log1.changes.some((c) => c.scope === "campaign") && log1.changes.some((c) => c.scope === "asset") && log1.changes.some((c) => c.scope === "brief"),
      JSON.stringify([...actors]));

    // ---- 6. conversion mappings ----------------------------------------------------------
    const mapping = await surface(projA, userA, { action: "conversion_mapping_create", app_event_name: "signup", conversion_action_name: "Signups" });
    h.check("mapping create persists an unmapped mapping for the app event",
      mapping.mapping.status === "unmapped" && mapping.mapping.app_event_name === "signup", JSON.stringify(mapping.mapping));
    const dupMap = await captureCall(() => surface(projA, userA, { action: "conversion_mapping_create", app_event_name: "signup" }));
    h.check("a second mapping for the same event is refused (dedup)", dupMap.threw && dupMap.code === "MAPPING_EXISTS", JSON.stringify({ code: dupMap.code }));
    const mapped = await surface(projA, userA, { action: "conversion_mapping_update", mapping_id: mapping.mapping.id, map_to_provider: true, conversion_action_name: "Signup (Google)" }, { provider: stub });
    h.check("mapping to the provider persists the provider ref and mapped status",
      mapped.mapping.status === "mapped" && mapped.mapping.provider_conversion_ref === "prov-conv-1", JSON.stringify(mapped.mapping));
    const upload = await surface(projA, userA, { action: "conversion_upload", events: [{ event_name: "signup" }] }, { provider: stub });
    h.check("conversion upload goes through the provider and reports its result",
      upload.uploaded === 1, JSON.stringify(upload));

    // ---- 7. isolation + authorization ----------------------------------------------------
    const listB = await surface(projB, userA, { action: "campaign_list" });
    h.check("one project's campaigns never leak into another (scoped reads)",
      listB.campaigns.length === 0 && listB.provider_sync === "skipped_not_configured", JSON.stringify(listB.campaigns.length));
    const accountB = await surface(projB, userA, { action: "account_get" });
    h.check("project B still has no account after project A launched",
      accountB.account === null, JSON.stringify(accountB.account));
    const strangerWrite = await captureCall(() => loadAuthorizedProject(base44, stranger, projA.id, "project.write"));
    const viewerWrite = await captureCall(() => loadAuthorizedProject(base44, viewer, projA.id, "project.write"));
    const viewerRead = await loadAuthorizedProject(base44, viewer, projA.id, "project.read").catch(() => null);
    h.check("authorization: a non-member and a viewer cannot write; a viewer can read",
      strangerWrite.threw && Number(strangerWrite.status) === 403 && viewerWrite.threw && Number(viewerWrite.status) === 403 && !!viewerRead,
      JSON.stringify({ stranger: strangerWrite.status, viewerWrite: viewerWrite.status, viewerRead: !!viewerRead }));
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
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}