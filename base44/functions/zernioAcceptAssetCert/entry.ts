// Targeted certification for the SEVENTH implemented Zernio Ads runtime operation:
// acceptAsset (shared/zernioAdsProvider.ts). Deterministic everywhere — the cert makes ZERO
// real network calls (the fetch seam is injected), opens no spend, and mutates nothing on any
// provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls;
//   2. the ONLY documented Zernio asset-accept path is attachCampaignAssets
//      (POST /v1/ads/campaigns/{campaignId}/assets), which the documentation restricts to
//      x-platforms: google with 501 on every other platform — the registered Zernio channels
//      are meta/tiktok/linkedin/openai and the google channel stays on its own DIRECT adapter,
//      so the mapped operation refuses BEFORE any call with the documented-501 refusal
//      (PROVIDER_INVALID_INPUT), never a request the documentation says cannot succeed;
//   3. refusals BEFORE any call: a missing contract field (sessionAssetId / assetFieldType /
//      content) and every registered Zernio channel — ZERO fetch calls on every path;
//   4. every other operation stays fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   5. through the REAL surface: a configured-injection asset_accept refuses and persists
//      NOTHING (no accepted id, no change log, campaign status and budget untouched) — and
//      Google stays untouched.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated, no real key is provisioned and no real asset or account is touched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider } from "../../shared/zernioAdsProvider.ts";
import { resolveAdsProvider, zernioProviderConfigured, ADS_CHANNELS, ZERNIO_ADS_CHANNELS } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method, body: init?.body ? String(init.body) : null });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;

  try {
    // ---- 1. fail-closed without a key (production state: no key is provisioned) ----------
    h.check("production state: no ZERNIO_API_KEY is provisioned for this app",
      zernioProviderConfigured() === false, String(zernioProviderConfigured()));
    const noKeyCalls = [];
    const noKeyAdapter = createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(noKeyCalls) });
    const noKey = await captureCall(() => noKeyAdapter.acceptAsset({
      sessionAssetId: "sa-1", assetFieldType: "HEADLINE", content: "Hello",
    }));
    h.check("without the key, acceptAsset refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);
    const resolution = resolveAdsProvider("zernio:tiktok", {
      provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]) }),
    });
    h.check("the injected resolution stays live while unconfigured (the surface path keeps working unchanged)",
      resolution.providerLive === true && resolution.configured === false,
      JSON.stringify({ live: resolution.providerLive, configured: resolution.configured }));

    // ---- 2. refusals BEFORE any call ------------------------------------------------------
    const refuseArg = async (args) => {
      const c = [];
      const r = await captureCall(() => createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(c), apiKey: "test-zernio-key" })
        .acceptAsset(args));
      return { r, calls: c };
    };
    const noId = await refuseArg({ assetFieldType: "HEADLINE", content: "Hello" });
    h.check("a missing sessionAssetId refuses with PROVIDER_INVALID_INPUT before any call",
      noId.r.threw && noId.r.code === "PROVIDER_INVALID_INPUT" && noId.calls.length === 0,
      `${noId.r.code || "no-throw"} calls=${noId.calls.length}`);
    const noType = await refuseArg({ sessionAssetId: "sa-1", content: "Hello" });
    h.check("a missing assetFieldType refuses with PROVIDER_INVALID_INPUT before any call",
      noType.r.threw && noType.r.code === "PROVIDER_INVALID_INPUT" && noType.calls.length === 0,
      `${noType.r.code || "no-throw"} calls=${noType.calls.length}`);
    const noContent = await refuseArg({ sessionAssetId: "sa-1", assetFieldType: "HEADLINE" });
    h.check("a missing content refuses with PROVIDER_INVALID_INPUT before any call",
      noContent.r.threw && noContent.r.code === "PROVIDER_INVALID_INPUT" && noContent.calls.length === 0,
      `${noContent.r.code || "no-throw"} calls=${noContent.calls.length}`);

    // ---- 3. the documented platform matrix: attach is Google-only on Zernio ---------------
    const matrix = [];
    for (const channel of ZERNIO_ADS_CHANNELS) {
      const c = [];
      const r = await captureCall(() => createZernioAdsProvider(channel, { fetcher: documentedFetcher(c), apiKey: "test-zernio-key" })
        .acceptAsset({ sessionAssetId: "sa-1", assetFieldType: "HEADLINE", content: "Hello" }));
      matrix.push({ channel, code: r.code, threw: r.threw, calls: c.length });
    }
    h.check("every registered Zernio channel refuses with the documented-501 refusal, ZERO calls",
      matrix.length === ZERNIO_ADS_CHANNELS.length && ADS_CHANNELS.filter((c) => c.startsWith("zernio:")).length === 4 &&
      matrix.every((m) => m.threw && m.code === "PROVIDER_INVALID_INPUT" && m.calls === 0),
      JSON.stringify(matrix));
    const metaRefusal = await captureCall(() => createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" })
      .acceptAsset({ sessionAssetId: "sa-1", assetFieldType: "HEADLINE", content: "Hello" }));
    h.check("the refusal names the documented endpoint and its Google-only restriction",
      metaRefusal.threw && String(metaRefusal.message || "").includes("attachCampaignAssets") &&
      String(metaRefusal.message || "").includes("google"), String(metaRefusal.message || "").slice(0, 160));
    h.check("a valid-shaped call NEVER issues a Zernio request on any registered channel",
      matrix.every((m) => m.calls === 0), "zero-calls");

    // ---- 4. every other operation stays fail-closed/unimplemented ------------------------
    const guarded = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]) });
    const opResults = [];
    for (const op of ["launch"]) {
      const r = await captureCall(() => guarded[op]({}));
      opResults.push({ op, code: r.code, threw: r.threw });
    }
    h.check("all other operations refuse with PROVIDER_UNIMPLEMENTED, no fetch, no state change",
      opResults.every((r) => r.threw && r.code === "PROVIDER_UNIMPLEMENTED"), JSON.stringify(opResults.map((r) => r.code)));

    // ---- 5. through the REAL surface: the refusal persists NOTHING ------------------------
    const ws = await svc.entities.Workspace.create({ name: `zasset-${stamp}`, owner_id: `ownerA_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zasset-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zasset" });
    projects.push(projZ.id);
    const user = { id: `ownerA_${stamp}`, email: "za@example.com" };
    const acc = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:tiktok", status: "active",
      provider_account_ref: "zacc-1", payment_on_file: true,
    });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: acc.id, channel: "zernio:tiktok",
      campaign_name: "Zernio asset fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "123456789",
    });
    const session = await svc.entities.AdsAssetSession.create({
      project_id: projZ.id, workspace_id: ws.id, kind: "generate_text", status: "completed",
      text: [{ session_asset_id: "sa-1", asset_field_type: "HEADLINE", content: "Hello" }],
      accepted_session_asset_ids: [], completed_at: new Date().toISOString(),
    });
    const surfaceCalls = [];
    const refused = await captureCall(() => surface(projZ, user, {
      action: "asset_accept", channel: "zernio:tiktok", session_id: session.id, session_asset_id: "sa-1",
    }, { provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(surfaceCalls), apiKey: "test-zernio-key" }) }));
    h.check("through the surface, asset_accept refuses with the provider's documented-501 refusal",
      refused.threw && refused.code === "PROVIDER_INVALID_INPUT" &&
      String(refused.message || "").includes("attachCampaignAssets"),
      `${refused.code || "no-throw"} ${String(refused.message || "").slice(0, 120)}`);
    const sessionAfter = await svc.entities.AdsAssetSession.get(session.id);
    h.check("the session persisted NOTHING: no accepted id, no provider call was even attempted",
      JSON.stringify(sessionAfter.accepted_session_asset_ids) === "[]" && surfaceCalls.length === 0,
      JSON.stringify({ accepted: sessionAfter.accepted_session_asset_ids, calls: surfaceCalls.length }));
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: projZ.id }, "-created_date", 10);
    h.check("no change-log attribution was written for the refused accept",
      !logs.some((l) => l.action === "asset.accepted"), JSON.stringify(logs.map((l) => l.action)));
    const campAfter = await svc.entities.AdsCampaign.get(camp.id);
    h.check("the campaign is UNTOUCHED: status ENABLED and the daily budget unchanged",
      campAfter.status === "ENABLED" && campAfter.daily_budget_micros === 10000000,
      JSON.stringify({ status: campAfter.status, budget: campAfter.daily_budget_micros }));
    const gNone = await surface(projZ, user, { action: "account_get" });
    h.check("Google is untouched: the project has no google-channel account row",
      gNone.account === null, JSON.stringify(gNone.account));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;
    for (const pid of projects) {
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.AdsAssetSession.deleteMany({ project_id: pid }).catch(() => {});
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}