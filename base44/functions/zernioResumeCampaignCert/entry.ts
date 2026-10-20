// Targeted certification for the THIRD implemented Zernio Ads runtime operation:
// resumeCampaign (shared/zernioAdsProvider.ts). Deterministic everywhere — the cert makes ZERO
// real network calls (the fetch seam is injected), opens no spend, and mutates nothing on any
// provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls;
//   2. auth + request shape: PUT https://zernio.com/api/v1/ads/campaigns/{id}/status,
//      Bearer header, JSON body { status: "active", platform } per the documented endpoint
//      (docs.zernio.com/ad-campaigns/update-ad-campaign-status, fetched 2026-10-06);
//   3. mapping: the documented 200 response maps into the resumeCampaign return shape —
//      platformCampaignStatus verbatim as serving_status (never mapped), skip provenance carried;
//   4. refusals BEFORE any call: zernio:meta (the required platform is one of two halves),
//      an id-less campaign, and a Zernio 401;
//   5. every other operation stays fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   6. through the REAL surface: a configured-injection campaign_resume persists ENABLED +
//      serving_status and writes the change log — and Google stays untouched.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated and no real key is provisioned or required.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider, mapZernioStatusResponse, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { zernioProviderConfigured } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

const DOCUMENTED_RESUME = {
  status: "active",
  platformCampaignStatus: "ENABLE",
  statusReadAt: "2026-10-06T19:05:00Z",
  updated: 1,
  skipped: 0,
  skippedReasons: [],
};

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({
    url: String(url),
    method: init?.method,
    auth: init?.headers?.Authorization || null,
    contentType: init?.headers?.["Content-Type"] || null,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  return new Response(JSON.stringify(DOCUMENTED_RESUME), { status: 200 });
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
    const noKey = await captureCall(() => noKeyAdapter.resumeCampaign({
      campaign: { provider_campaign_id: "123456789" },
    }));
    h.check("without the key, resumeCampaign refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);

    // ---- 2. auth + request shape through the injected fetch seam -------------------------
    const calls = [];
    const tiktok = createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(calls), apiKey: "test-zernio-key" });
    const resumed = await tiktok.resumeCampaign({ campaign: { provider_campaign_id: "123456789" } });
    const call = calls[0] || {};
    h.check("the request is PUT on the documented endpoint with the Bearer auth header",
      calls.length === 1 && call.method === "PUT" &&
      call.url === `${ZERNIO_API_BASE_URL}/ads/campaigns/123456789/status` &&
      typeof call.auth === "string" && call.auth.startsWith("Bearer ") &&
      call.contentType === "application/json" &&
      JSON.stringify(call.body) === JSON.stringify({ status: "active", platform: "tiktok" }),
      `${call.method || "no-call"} ${call.url || ""} ${JSON.stringify(call.body)}`);
    h.check("the key is sent only in the header (starts with Bearer, never in the URL or body)",
      !!call.auth?.startsWith("Bearer ") && !String(call.url).includes("test-zernio-key") &&
      !JSON.stringify(call.body || {}).includes("test-zernio-key"), "header-only");
    h.check("the documented 200 response maps into the resumeCampaign return shape",
      resumed.campaign.status === "ENABLED" && resumed.campaign.serving_status === "ENABLE" &&
      resumed.campaign.provider_write.updated === 1 && resumed.campaign.provider_write.skipped === 0 &&
      Array.isArray(resumed.campaign.provider_write.skipped_reasons),
      JSON.stringify(resumed));
    const skippedMap = mapZernioStatusResponse({
      status: "active", platformCampaignStatus: null, updated: 0, skipped: 1,
      skippedReasons: ["Campaign already switched on"],
    });
    h.check("a skipped write (live read showed the requested state) still maps to ENABLED with provenance",
      skippedMap.campaign.status === "ENABLED" && skippedMap.campaign.serving_status === "" &&
      skippedMap.campaign.provider_write.updated === 0 && skippedMap.campaign.provider_write.skipped === 1 &&
      skippedMap.campaign.provider_write.skipped_reasons[0] === "Campaign already switched on",
      JSON.stringify(skippedMap));

    // ---- 3. refusals BEFORE any call ------------------------------------------------------
    const metaCalls = [];
    const meta = await captureCall(() => createZernioAdsProvider("zernio:meta", {
      fetcher: documentedFetcher(metaCalls),
      apiKey: "test-zernio-key",
    }).resumeCampaign({ campaign: { provider_campaign_id: "123456789" } }));
    h.check("zernio:meta refuses with PROVIDER_INVALID_INPUT before any call (half never guessed)",
      meta.threw && meta.code === "PROVIDER_INVALID_INPUT" && metaCalls.length === 0,
      `${meta.code || "no-throw"} calls=${metaCalls.length}`);
    const idLessCalls = [];
    const idLess = await captureCall(() => createZernioAdsProvider("zernio:tiktok", {
      fetcher: documentedFetcher(idLessCalls),
      apiKey: "test-zernio-key",
    }).resumeCampaign({ campaign: {} }));
    h.check("an id-less campaign refuses with PROVIDER_INVALID_INPUT before any call",
      idLess.threw && idLess.code === "PROVIDER_INVALID_INPUT" && idLessCalls.length === 0,
      `${idLess.code || "no-throw"} calls=${idLessCalls.length}`);
    const authFailed = await captureCall(() => createZernioAdsProvider("zernio:tiktok", {
      fetcher: async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }),
      apiKey: "test-zernio-key",
    }).resumeCampaign({ campaign: { provider_campaign_id: "123456789" } }));
    h.check("a Zernio 401 is refused as PROVIDER_AUTH_FAILED, never mapped into state",
      authFailed.threw && authFailed.code === "PROVIDER_AUTH_FAILED", authFailed.code || "no-throw");

    // ---- 4. every other operation stays fail-closed/unimplemented ------------------------
    const guarded = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]) });
    const opResults = [];
    for (const op of ["launch"]) {
      const r = await captureCall(() => guarded[op]({}));
      opResults.push({ op, code: r.code, threw: r.threw });
    }
    h.check("all other operations refuse with PROVIDER_UNIMPLEMENTED, no fetch, no state change",
      opResults.every((r) => r.threw && r.code === "PROVIDER_UNIMPLEMENTED"), JSON.stringify(opResults.map((r) => r.code)));

    // ---- 5. through the REAL surface: campaign_resume persists, Google untouched ----------
    const ws = await svc.entities.Workspace.create({ name: `zresume-${stamp}`, owner_id: `ownerR_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zresume-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zresume" });
    projects.push(projZ.id);
    const user = { id: `ownerR_${stamp}`, email: "zr@example.com" };
    const acc = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:tiktok", status: "active",
      provider_account_ref: "zacc-1", payment_on_file: true,
    });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: acc.id, channel: "zernio:tiktok",
      campaign_name: "Zernio resume fixture", campaign_type: "PERFORMANCE_MAX", status: "PAUSED",
      daily_budget_micros: 10000000, provider_campaign_id: "123456789", serving_status: "DISABLE",
    });
    const budgetBefore = (await svc.entities.AdsCampaign.get(camp.id)).daily_budget_micros;
    const surfaceCalls = [];
    const zernioProvider = createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(surfaceCalls), apiKey: "test-zernio-key" });
    const res = await surface(projZ, user, { action: "campaign_resume", channel: "zernio:tiktok", campaign_id: camp.id }, { provider: zernioProvider });
    h.check("through the surface, campaign_resume serves the ENABLED campaign projection",
      res.campaign.status === "ENABLED", JSON.stringify({ status: res.campaign?.status }));
    const resumedRow = await svc.entities.AdsCampaign.get(camp.id);
    h.check("the resume PERSISTED: status ENABLED, serving_status verbatim from the platform, budget UNTOUCHED",
      resumedRow.status === "ENABLED" && resumedRow.serving_status === "ENABLE" &&
      resumedRow.daily_budget_micros === budgetBefore && !!resumedRow.last_synced_at,
      JSON.stringify({ status: resumedRow.status, serving: resumedRow.serving_status, budget: resumedRow.daily_budget_micros }));
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: projZ.id }, "-created_date", 10);
    h.check("the resume wrote its change-log attribution",
      logs.some((l) => l.action === "campaign.enabled"), JSON.stringify(logs.map((l) => l.action)));
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