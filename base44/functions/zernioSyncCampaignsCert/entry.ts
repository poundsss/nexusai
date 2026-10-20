// Targeted certification for the FIRST implemented Zernio Ads runtime operation:
// syncCampaigns (shared/zernioAdsProvider.ts). Read-only everywhere — the cert makes ZERO
// real network calls (the fetch seam is injected), creates no spend, and mutates nothing on
// any provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls; the unconfigured surface behavior is unchanged;
//   2. auth + request shape: GET https://zernio.com/api/v1/ads/campaigns, Bearer header,
//      platform filter per channel (none for zernio:meta), accountId from the account's
//      provider_account_ref — the existing (project, channel) scoping;
//   3. mapping: the documented Zernio campaign response maps into the syncCampaigns return
//      shape, with unknown statuses passed through verbatim and id-less rows dropped;
//   4. other operations stay fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   5. through the REAL surface: a configured-injection sync persists status/metrics and
//      clears metrics_pending for the channel-scoped campaign — and does not touch Google.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated and no real key is provisioned or required.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider, mapZernioCampaign, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { resolveAdsProvider, zernioProviderConfigured } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

const DOCUMENTED_CAMPAIGN = {
  platformCampaignId: "123456789",
  platform: "tiktok",
  campaignName: "Spring promotion",
  status: "active",
  reviewStatus: "in_review",
  servingStatuses: ["SERVING"],
  metrics: { spend: 12.5, impressions: 1000, clicks: 40, conversions: 3, ctr: 0.04 },
};

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization || null });
  return new Response(JSON.stringify({ campaigns: [DOCUMENTED_CAMPAIGN] }), { status: 200 });
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
    const noKeyAdapter = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher(noKeyCalls) });
    const noKey = await captureCall(() => noKeyAdapter.syncCampaigns({ account: { provider_account_ref: "zacc-1" } }));
    h.check("without the key, syncCampaigns refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);
    const unconfSurface = await surface(ghostProject(), { id: "u1" }, { action: "campaign_list", channel: "zernio:tiktok" });
    h.check("unconfigured surface: campaign_list skips the sync and reports it honestly",
      unconfSurface.provider_sync === "skipped_not_configured", unconfSurface.provider_sync);

    // ---- 2. auth + request shape through the injected fetch seam -------------------------
    const calls = [];
    const tiktok = createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(calls), apiKey: "test-zernio-key" });
    await tiktok.syncCampaigns({ account: { provider_account_ref: "zacc-1" } });
    const call = calls[0] || {};
    h.check("the request is GET on the documented endpoint with the Bearer auth header",
      calls.length === 1 && call.method === "GET" &&
      call.url === `${ZERNIO_API_BASE_URL}/ads/campaigns?limit=100&platform=tiktok&accountId=zacc-1` &&
      typeof call.auth === "string" && call.auth.startsWith("Bearer ") && !call.auth.includes("undefined"),
      call.url || "no-call");
    h.check("the key is sent only in the header (starts with Bearer, never logged in the URL)",
      !!call.auth?.startsWith("Bearer ") && !String(call.url).includes("test-zernio-key"), "header-only");

    const metaCalls = [];
    const meta = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher(metaCalls), apiKey: "test-zernio-key" });
    await meta.syncCampaigns({ account: { provider_account_ref: "zacc-1" } });
    h.check("zernio:meta sends NO platform filter (facebook+instagram are both Meta) and keeps accountId",
      metaCalls.length === 1 && metaCalls[0].url === `${ZERNIO_API_BASE_URL}/ads/campaigns?limit=100&accountId=zacc-1`,
      metaCalls[0]?.url || "no-call");

    // ---- 3. mapping of the documented response -------------------------------------------
    const mapped = mapZernioCampaign(DOCUMENTED_CAMPAIGN);
    h.check("the documented campaign maps into the syncCampaigns return shape",
      mapped.provider_campaign_id === "123456789" && mapped.status === "ENABLED" &&
      mapped.review_status === "in_review" && mapped.serving_status === "SERVING" &&
      mapped.metrics.impressions === 1000 && mapped.metrics.clicks === 40 &&
      mapped.metrics.spend === 12.5 && mapped.metrics.conversions === 3 &&
      mapped.metrics.ctr === 0.04 && mapped.metrics.cost_micros === 12500000,
      JSON.stringify(mapped));
    const passthrough = mapZernioCampaign({ platformCampaignId: "42", status: "error", metrics: {} });
    h.check("an unknown status passes through verbatim and empty metrics stay zeros",
      passthrough.status === "error" && passthrough.metrics.impressions === 0 &&
      passthrough.metrics.cost_micros === 0, JSON.stringify(passthrough));
    const idLess = createZernioAdsProvider("zernio:openai", {
      fetcher: async () => new Response(JSON.stringify({ campaigns: [{ platform: "openai", status: "active", metrics: {} }, DOCUMENTED_CAMPAIGN] }), { status: 200 }),
      apiKey: "test-zernio-key",
    });
    const idLessRes = await idLess.syncCampaigns({});
    h.check("an id-less campaign is dropped, never matched against a stored row",
      idLessRes.campaigns.length === 1 && idLessRes.campaigns[0].provider_campaign_id === "123456789",
      JSON.stringify(idLessRes.campaigns.length));
    const refused = await captureCall(() => createZernioAdsProvider("zernio:openai", {
      fetcher: async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }),
      apiKey: "test-zernio-key",
    }).syncCampaigns({}));
    h.check("a Zernio 401 is refused as PROVIDER_AUTH_FAILED, never mapped into state",
      refused.threw && refused.code === "PROVIDER_AUTH_FAILED", refused.code || "no-throw");

    // ---- 4. every other operation stays fail-closed/unimplemented ------------------------
    const guarded = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]) });
    const opResults = [];
    for (const op of ["launch"]) {
      const r = await captureCall(() => guarded[op]({}));
      opResults.push({ op, code: r.code, threw: r.threw });
    }
    h.check("all other operations refuse with PROVIDER_UNIMPLEMENTED, no fetch, no state change",
      opResults.every((r) => r.threw && r.code === "PROVIDER_UNIMPLEMENTED"), JSON.stringify(opResults.map((r) => r.code)));
    // The registry resolution check asserts the unconfigured production state (no key exists
    // for this app; the adapters carry their scratch key via deps.apiKey, never process.env).
    const unconfResolution = resolveAdsProvider("zernio:meta");
    const unconfOp = await captureCall(() => unconfResolution.provider.launch({ payload: {} }));
    h.check("the unconfigured registry resolution is unchanged: fail-closed factory, PROVIDER_NOT_CONFIGURED",
      unconfResolution.providerLive === false && unconfResolution.configured === false &&
      unconfOp.threw && unconfOp.code === "PROVIDER_NOT_CONFIGURED", unconfOp.code || "no-throw");

    // ---- 5. through the REAL surface: channel-scoped sync persists, Google untouched -----
    const ws = await svc.entities.Workspace.create({ name: `zsync-${stamp}`, owner_id: `ownerZ_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zsync-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zsync" });
    projects.push(projZ.id);
    const user = { id: `ownerZ_${stamp}`, email: "z@example.com" };
    const acc = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:tiktok", status: "active",
      provider_account_ref: "zacc-1", payment_on_file: true,
    });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: acc.id, channel: "zernio:tiktok",
      campaign_name: "Zernio sync fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "123456789", metrics_pending: true,
    });
    const zernioProvider = createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" });
    const listed = await surface(projZ, user, { action: "campaign_list", channel: "zernio:tiktok" }, { provider: zernioProvider });
    h.check("through the surface, the Zernio sync runs and reports synced",
      listed.provider_sync === "synced" && listed.campaigns.length === 1, listed.provider_sync);
    const syncedRow = (await svc.entities.AdsCampaign.filter({ project_id: projZ.id }, "-created_date", 10))[0];
    h.check("the sync PERSISTED the mapped state: status ENABLED, metrics applied, metrics_pending cleared",
      syncedRow.id === camp.id && syncedRow.status === "ENABLED" &&
      syncedRow.metrics?.impressions === 1000 && syncedRow.metrics?.cost_micros === 12500000 &&
      syncedRow.metrics_pending === false && !!syncedRow.last_synced_at,
      JSON.stringify({ status: syncedRow.status, imp: syncedRow.metrics?.impressions, pending: syncedRow.metrics_pending }));
    const readBack = await surface(projZ, user, { action: "campaign_get", channel: "zernio:tiktok", campaign_id: camp.id }, { provider: zernioProvider });
    h.check("campaign_get through the channel projection serves the synced metrics (read-only path)",
      readBack.campaign.impressions === 1000 && readBack.campaign.clicks === 40 && readBack.campaign.metrics_pending === false,
      JSON.stringify({ imp: readBack.campaign.impressions }));
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
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}

// A nonexistent project reference for the unconfigured-surface check in section 1 — that check
// never persists (campaign_list with no account and no provider sync touches nothing).
const ghostProject = () => ({ id: `no-such-project-${Date.now()}`, workspace_id: "no-such-workspace" });