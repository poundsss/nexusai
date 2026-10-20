// Provider-neutral Ads SEAM certification — the minimal seam from the completed Zernio ↔
// NexusAI audit (shared/adsProviderRegistry.ts + the channel routing in shared/googleAds.ts).
// Runs through the REAL surface and REAL persistence, with the same deterministic stub
// provider googleAdsCert injects for Google and ZERO network activity for Zernio:
//   1. provider resolution: google default, zernio:* fail-closed, injected stub wins, unknown
//      channel refused;
//   2. Zernio fail-closed behavior through the surface (PROVIDER_NOT_CONFIGURED, no rows, no
//      calls) for every Zernio channel;
//   3. Google regression through the same seam (default-channel behavior unchanged);
//   4. channel + tenant isolation;
//   5. concurrency/idempotency of provider-scoped account resolution.
// NO real Zernio or provider call is ever made.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import {
  resolveAdsProvider, normalizeAdsChannel, ADS_CHANNELS, ZERNIO_ADS_CHANNELS,
  isChannelConfigured, ZERNIO_REQUIRED_SECRETS,
} from "../../shared/adsProviderRegistry.ts";
import { makeAdsStubProvider, makeAdsSurface } from "../../shared/adsCertStubs.ts";
import { providerConfigured, GOOGLE_ADS_REQUIRED_SECRETS } from "../../shared/googleAdsProvider.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];

  const surface = makeAdsSurface(svc);
  const stub = makeAdsStubProvider();
  const withStub = (input) => ({ provider: stub, ...input });
  const accountsOf = (projectId) => svc.entities.AdsAccount.filter({ project_id: projectId }, "created_date", 100);
  const campaignsOf = (projectId) => svc.entities.AdsCampaign.filter({ project_id: projectId }, "created_date", 100);

  try {
    const wsA = await svc.entities.Workspace.create({ name: `seam-A-${stamp}`, owner_id: `ownerA_${stamp}` });
    const wsB = await svc.entities.Workspace.create({ name: `seam-B-${stamp}`, owner_id: `ownerB_${stamp}` });
    workspaces.push(wsA.id, wsB.id);
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `seam-a-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-seam" });
    const projB = await svc.entities.Project.create({ workspace_id: wsB.id, name: `seam-b-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-seam" });
    projects.push(projA.id, projB.id);
    const userA = { id: `ownerA_${stamp}`, email: "a@example.com" };

    // ---- 1. provider resolution at the registry ------------------------------------------
    h.check("channel normalization: absent → google; every registered channel passes; unknown refuse",
      normalizeAdsChannel() === "google" && normalizeAdsChannel("google") === "google" &&
      ZERNIO_ADS_CHANNELS.every((c) => normalizeAdsChannel(c) === c) &&
      normalizeAdsChannel("openai") === null && normalizeAdsChannel("yahoo") === null,
      JSON.stringify(ADS_CHANNELS));
    h.check("the registry is exactly the confirmed set: google direct + 4 Zernio channels",
      ADS_CHANNELS.length === 5 && ZERNIO_ADS_CHANNELS.length === 4 &&
      ADS_CHANNELS[0] === "google" && ZERNIO_ADS_CHANNELS[0] === "zernio:meta",
      JSON.stringify(ADS_CHANNELS));
    h.check("the unconfigured production gate: no Google secret and no Zernio secret exists",
      !providerConfigured() && GOOGLE_ADS_REQUIRED_SECRETS.length === 5 &&
      !isChannelConfigured("zernio:meta") && ZERNIO_REQUIRED_SECRETS.length === 1,
      JSON.stringify(ZERNIO_REQUIRED_SECRETS));
    const g = resolveAdsProvider("google");
    const z = resolveAdsProvider("zernio:meta");
    const gOp = await captureCall(() => g.provider.launch({ payload: {} }));
    const zOp = await captureCall(() => z.provider.pauseCampaign({ campaign: {} }));
    h.check("google resolves to the existing fail-closed adapter; zernio to a Zernio fail-closed adapter; both refuse",
      g.providerLive === false && z.providerLive === false && gOp.threw && gOp.code === "PROVIDER_NOT_CONFIGURED" && zOp.threw && zOp.code === "PROVIDER_NOT_CONFIGURED",
      JSON.stringify({ google: gOp.code, zernio: zOp.code }));
    const injected = resolveAdsProvider("google", { provider: stub });
    h.check("an injected adapter (the certification stub) wins the seam and is live",
      injected.provider === stub && injected.providerLive === true, "stub wins");
    for (const ch of ZERNIO_ADS_CHANNELS) {
      const r = resolveAdsProvider(ch);
      const op = await captureCall(() => r.provider.launch({ payload: {} }));
      h.check(`channel ${ch} is fail-closed: every operation refuses, nothing is live`,
        op.threw && op.code === "PROVIDER_NOT_CONFIGURED" && r.providerLive === false && r.configured === false,
        op.code || "no-throw");
    }

    // ---- 2. seam routing through the real surface -----------------------------------------
    const badChannel = await captureCall(() => surface(projA, userA, { action: "account_get", channel: "yahoo" }));
    h.check("an unknown channel is refused at the seam (UNKNOWN_CHANNEL), before any read",
      badChannel.threw && badChannel.code === "UNKNOWN_CHANNEL", badChannel.code || "no-throw");

    // ---- 3. Zernio fail-closed through the real surface ------------------------------------
    const zGet = await surface(projA, userA, { action: "account_get", channel: "zernio:meta" });
    h.check("zernio:meta account GET returns null with a 200 — no row is ever invented",
      zGet.account === null, JSON.stringify(zGet));
    const zReady = await surface(projA, userA, { action: "launch_readiness", channel: "zernio:meta" });
    h.check("zernio:meta launch readiness reports the provider blocker and invents no readiness",
      zReady.ready === false && zReady.blockers.includes("PROVIDER_NOT_CONFIGURED"), JSON.stringify(zReady.blockers));
    const zLaunch = await captureCall(() => surface(projA, userA, { action: "launch", channel: "zernio:meta", campaign_name: "x", daily_budget_micros: 15000000 }));
    h.check("zernio:meta launch FAILS CLOSED before anything is created (no account, no campaign)",
      zLaunch.threw && zLaunch.code === "PROVIDER_NOT_CONFIGURED" &&
      (await accountsOf(projA.id)).length === 0 && (await campaignsOf(projA.id)).length === 0,
      zLaunch.code || "no-throw");
    const zPause = await captureCall(() => surface(projA, userA, { action: "campaign_pause", channel: "zernio:meta", campaign_id: "ghost" }));
    const zAccept = await captureCall(() => surface(projA, userA, { action: "asset_accept", channel: "zernio:meta", session_id: "ghost", session_asset_id: "x" }));
    const zUpload = await captureCall(() => surface(projA, userA, { action: "conversion_upload", channel: "zernio:meta", events: [] }));
    h.check("zernio:meta lifecycle, asset accept and conversion upload all fail closed",
      zPause.threw && zPause.code === "PROVIDER_NOT_CONFIGURED" &&
      zAccept.threw && zAccept.code === "PROVIDER_NOT_CONFIGURED" &&
      zUpload.threw && zUpload.code === "PROVIDER_NOT_CONFIGURED",
      JSON.stringify({ pause: zPause.code, accept: zAccept.code, upload: zUpload.code }));
    h.check("the refused Zernio launches left NO account row of any channel in project A",
      (await accountsOf(projA.id)).length === 0, String((await accountsOf(projA.id)).length));

    // ---- 4. Google regression through the same seam ----------------------------------------
    const gNone = await surface(projA, userA, { action: "account_get" });
    h.check("google (absent channel = google): account GET keeps the null-when-none contract",
      gNone.account === null, JSON.stringify(gNone));
    const gLaunch = await surface(projA, userA, { action: "launch", campaign_name: "Spring", campaign_type: "PERFORMANCE_MAX", daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({}));
    h.check("google launch through the seam behaves exactly as before: ONE active account, provider campaign, metrics pending",
      gLaunch.account.status === "active" && gLaunch.campaigns.length === 1 &&
      gLaunch.campaigns[0].provider_campaign_id === "prov-camp-1" && gLaunch.campaigns[0].metrics_pending === true,
      JSON.stringify(gLaunch.campaigns[0]));
    const gAcc = (await accountsOf(projA.id)).filter((r) => (r.channel || "google") === "google");
    h.check("the google account row carries channel google (provider-scoped storage)",
      gAcc.length === 1 && gAcc[0].channel === "google", JSON.stringify(gAcc.map((r) => r.channel)));
    const gGetAfter = await surface(projA, userA, { action: "account_get" });
    h.check("google account GET after launch keeps the existing projection and reports the channel",
      gGetAfter.account.channel === "google" && gGetAfter.account.status === "active" && gGetAfter.account.provider_configured === false,
      JSON.stringify(gGetAfter.account));
    const gList = await surface(projA, userA, { action: "campaign_list" }, withStub({}));
    h.check("google campaign list through the seam syncs metrics through the provider as before",
      gList.provider_sync === "synced" && gList.campaigns.length === 1 && gList.campaigns[0].impressions === 100,
      JSON.stringify({ sync: gList.provider_sync, imp: gList.campaigns[0]?.impressions }));
    const gCamps = await campaignsOf(projA.id);
    h.check("the google campaign row carries channel google",
      gCamps.length === 1 && gCamps[0].channel === "google", JSON.stringify(gCamps.map((c) => c.channel)));

    // ---- 5. channel + tenant isolation -----------------------------------------------------
    const zAccOnA = await surface(projA, userA, { action: "account_get", channel: "zernio:meta" });
    h.check("channel isolation within one project: the google account is invisible to zernio:meta",
      zAccOnA.account === null, JSON.stringify(zAccOnA));
    const mismatch = await captureCall(() => surface(projA, userA, { action: "campaign_get", channel: "zernio:meta", campaign_id: gLaunch.campaigns[0].id }));
    h.check("a campaign on another channel is refused (CHANNEL_MISMATCH), never routed across providers",
      mismatch.threw && mismatch.code === "CHANNEL_MISMATCH", mismatch.code || "no-throw");
    const bList = await surface(projB, userA, { action: "campaign_list" });
    const bAcc = await surface(projB, userA, { action: "account_get" });
    h.check("tenant isolation: project B sees none of project A's campaigns or account",
      bList.campaigns.length === 0 && bAcc.account === null, JSON.stringify({ campaigns: bList.campaigns.length }));

    // ---- 6. concurrency + idempotency of provider-scoped resolution ------------------------
    const launchB = (name) => surface(projB, userA, { action: "launch", campaign_name: name, daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({}));
    const [c1, c2] = await Promise.all([
      launchB("C1").catch((e) => ({ threw: e.code })),
      launchB("C2").catch((e) => ({ threw: e.code })),
    ]);
    const bAccRows = (await accountsOf(projB.id)).filter((r) => (r.channel || "google") === "google");
    const bCamps = await campaignsOf(projB.id);
    h.check("concurrent google launches: exactly ONE provider-scoped account row survives the race (deterministic winner)",
      bAccRows.length === 1, JSON.stringify({ rows: bAccRows.length, r1: c1.threw || null, r2: c2.threw || null }));
    h.check("concurrent google launches: both campaigns persist attached to the surviving account",
      bCamps.length === 2 && bCamps.every((c) => c.account_id === bAccRows[0]?.id),
      JSON.stringify({ camps: bCamps.length, attached: bCamps.every((c) => c.account_id === bAccRows[0]?.id) }));
    // The documented 2-active-campaign cap: pause one before the third launch.
    if (bCamps[0]) await svc.entities.AdsCampaign.update(bCamps[0].id, { status: "PAUSED" });
    const relaunch = await surface(projB, userA, { action: "launch", campaign_name: "C3", daily_budget_micros: 15000000, landing_page: "https://x.test" }, withStub({}));
    const rowsAfter = (await accountsOf(projB.id)).filter((r) => (r.channel || "google") === "google");
    h.check("a sequential re-launch REUSES the same provider-scoped account row (idempotent per channel)",
      relaunch.account.id === bAccRows[0]?.id && rowsAfter.length === 1, JSON.stringify({ rows: rowsAfter.length }));
    const [z1, z2] = await Promise.all([
      surface(projB, userA, { action: "launch", channel: "zernio:tiktok", campaign_name: "Z", daily_budget_micros: 15000000 }).catch((e) => ({ threw: true, code: e.code })),
      surface(projB, userA, { action: "launch", channel: "zernio:tiktok", campaign_name: "Z", daily_budget_micros: 15000000 }).catch((e) => ({ threw: true, code: e.code })),
    ]);
    const zRows = (await accountsOf(projB.id)).filter((r) => (r.channel || "google") !== "google");
    h.check("concurrent Zernio launches fail closed: both refuse, zero rows, nothing created",
      z1.code === "PROVIDER_NOT_CONFIGURED" && z2.code === "PROVIDER_NOT_CONFIGURED" && zRows.length === 0,
      JSON.stringify({ a: z1.code, b: z2.code, rows: zRows.length }));
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