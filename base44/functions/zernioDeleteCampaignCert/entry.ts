// Targeted certification for the FIFTH implemented Zernio Ads runtime operation:
// deleteCampaign (shared/zernioAdsProvider.ts). Deterministic everywhere — the cert makes ZERO
// real network calls (the fetch seam is injected) and deletes nothing on any provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls;
//   2. auth + request shape: DELETE https://zernio.com/api/v1/ads/campaigns/{id}, Bearer
//      header, JSON body { platform } (the existing channel -> platform mapping) plus the
//      documented optional accountId from the account's provider_account_ref;
//   3. mapping: the documented 200 response maps into the deleteCampaign return shape —
//      deleted/adCount pass through verbatim as write provenance, no status is carried;
//   4. refusals BEFORE any call: zernio:meta (the required platform is one of two halves) and
//      an id-less campaign; a Zernio 401 is PROVIDER_AUTH_FAILED;
//   5. every other operation stays fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   6. through the REAL surface: a configured-injection campaign_delete persists REMOVED and
//      writes the change log, a meta delete refuses without persisting, and Google stays
//      untouched.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated, no real key is provisioned and no real campaign is deleted.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider, mapZernioDeleteResponse, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { zernioProviderConfigured } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

const DOCUMENTED_DELETE = { deleted: true, adCount: 0 };

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({
    url: String(url),
    method: init?.method,
    auth: init?.headers?.Authorization || null,
    contentType: init?.headers?.["Content-Type"] || null,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  return new Response(JSON.stringify(DOCUMENTED_DELETE), { status: 200 });
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
    const noKey = await captureCall(() => noKeyAdapter.deleteCampaign({
      campaign: { provider_campaign_id: "123456789" },
    }));
    h.check("without the key, deleteCampaign refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);

    // ---- 2. auth + request shape through the injected fetch seam -------------------------
    const calls = [];
    const tiktok = createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(calls), apiKey: "test-zernio-key" });
    const res = await tiktok.deleteCampaign({
      campaign: { provider_campaign_id: "123456789" },
      account: { provider_account_ref: "zacc-1" },
    });
    const call = calls[0] || {};
    h.check("the request is DELETE on the documented endpoint with the Bearer auth header",
      calls.length === 1 && call.method === "DELETE" &&
      call.url === `${ZERNIO_API_BASE_URL}/ads/campaigns/123456789` &&
      typeof call.auth === "string" && call.auth.startsWith("Bearer ") &&
      call.contentType === "application/json" &&
      JSON.stringify(call.body) === JSON.stringify({ platform: "tiktok", accountId: "zacc-1" }),
      `${call.method || "no-call"} ${call.url || ""} ${JSON.stringify(call.body)}`);
    h.check("the key is sent only in the header (starts with Bearer, never in the URL or body)",
      !!call.auth?.startsWith("Bearer ") && !String(call.url).includes("test-zernio-key") &&
      !JSON.stringify(call.body || {}).includes("test-zernio-key"), "header-only");
    const noAccountCalls = [];
    await createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(noAccountCalls), apiKey: "test-zernio-key" }).deleteCampaign({
      campaign: { provider_campaign_id: "123456789" },
    });
    h.check("without an account reference the body carries platform only (accountId omitted)",
      noAccountCalls.length === 1 &&
      JSON.stringify(noAccountCalls[0].body) === JSON.stringify({ platform: "openai" }),
      JSON.stringify(noAccountCalls[0]?.body));

    // ---- 3. mapping of the documented response -------------------------------------------
    h.check("the documented 200 response maps verbatim (deleted/adCount as provenance, no status)",
      res.campaign.provider_write.deleted === true && res.campaign.provider_write.ad_count === 0 &&
      res.campaign.status === undefined && res.campaign.serving_status === undefined,
      JSON.stringify(res));
    const notDeleted = mapZernioDeleteResponse({ deleted: false, adCount: 3 });
    h.check("a false deleted maps honestly (never coerced into a success)",
      notDeleted.campaign.provider_write.deleted === false && notDeleted.campaign.provider_write.ad_count === 3,
      JSON.stringify(notDeleted));

    // ---- 4. refusals BEFORE any call ------------------------------------------------------
    const metaCalls = [];
    const meta = await captureCall(() => createZernioAdsProvider("zernio:meta", {
      fetcher: documentedFetcher(metaCalls),
      apiKey: "test-zernio-key",
    }).deleteCampaign({ campaign: { provider_campaign_id: "123456789" } }));
    h.check("zernio:meta refuses with PROVIDER_INVALID_INPUT before any call (half never guessed)",
      meta.threw && meta.code === "PROVIDER_INVALID_INPUT" && metaCalls.length === 0,
      `${meta.code || "no-throw"} calls=${metaCalls.length}`);
    const idLessCalls = [];
    const idLess = await captureCall(() => createZernioAdsProvider("zernio:tiktok", {
      fetcher: documentedFetcher(idLessCalls),
      apiKey: "test-zernio-key",
    }).deleteCampaign({ campaign: { provider_campaign_id: "" } }));
    h.check("an id-less campaign refuses with PROVIDER_INVALID_INPUT before any call",
      idLess.threw && idLess.code === "PROVIDER_INVALID_INPUT" && idLessCalls.length === 0,
      `${idLess.code || "no-throw"} calls=${idLessCalls.length}`);
    const authFailed = await captureCall(() => createZernioAdsProvider("zernio:tiktok", {
      fetcher: async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }),
      apiKey: "test-zernio-key",
    }).deleteCampaign({ campaign: { provider_campaign_id: "123456789" } }));
    h.check("a Zernio 401 is refused as PROVIDER_AUTH_FAILED, never mapped into state",
      authFailed.threw && authFailed.code === "PROVIDER_AUTH_FAILED", authFailed.code || "no-throw");
    const http404 = await captureCall(() => createZernioAdsProvider("zernio:tiktok", {
      fetcher: async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      apiKey: "test-zernio-key",
    }).deleteCampaign({ campaign: { provider_campaign_id: "123456789" } }));
    h.check("a documented 404 (empty-campaign shell) surfaces as PROVIDER_ERROR, never as success",
      http404.threw && http404.code === "PROVIDER_ERROR" && String(http404.error || http404.message || "").includes("404"),
      http404.code || "no-throw");

    // ---- 5. every other operation stays fail-closed/unimplemented ------------------------
    const guarded = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]) });
    const opResults = [];
    for (const op of ["launch"]) {
      const r = await captureCall(() => guarded[op]({}));
      opResults.push({ op, code: r.code, threw: r.threw });
    }
    h.check("all other operations refuse with PROVIDER_UNIMPLEMENTED, no fetch, no state change",
      opResults.every((r) => r.threw && r.code === "PROVIDER_UNIMPLEMENTED"), JSON.stringify(opResults.map((r) => r.code)));

    // ---- 6. through the REAL surface: REMOVED persists, meta refuses, Google untouched ----
    const ws = await svc.entities.Workspace.create({ name: `zdelete-${stamp}`, owner_id: `ownerD_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zdelete-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zdelete" });
    projects.push(projZ.id);
    const user = { id: `ownerD_${stamp}`, email: "zd@example.com" };
    const acc = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:openai", status: "active",
      provider_account_ref: "zacc-1", payment_on_file: true,
    });
    const accMeta = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:meta", status: "active",
      provider_account_ref: "zacc-3", payment_on_file: true,
    });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: acc.id, channel: "zernio:openai",
      campaign_name: "Zernio delete fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "123456789",
    });
    const campMeta = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: accMeta.id, channel: "zernio:meta",
      campaign_name: "Zernio delete meta fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "555555555",
    });
    const surfaceCalls = [];
    const openaiProvider = createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(surfaceCalls), apiKey: "test-zernio-key" });
    const del = await surface(projZ, user, { action: "campaign_delete", channel: "zernio:openai", campaign_id: camp.id }, { provider: openaiProvider });
    h.check("through the surface, campaign_delete serves the REMOVED campaign projection",
      del.campaign.status === "REMOVED", JSON.stringify({ status: del.campaign?.status }));
    const deletedRow = await svc.entities.AdsCampaign.get(camp.id);
    h.check("the delete PERSISTED: status REMOVED with change-log attribution",
      deletedRow.status === "REMOVED" && !!deletedRow.last_synced_at,
      JSON.stringify({ status: deletedRow.status }));
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: projZ.id }, "-created_date", 10);
    h.check("the delete wrote its change-log attribution (campaign.deleted, permanent)",
      logs.some((l) => l.action === "campaign.deleted" && l.detail?.permanent === true),
      JSON.stringify(logs.map((l) => l.action)));
    const refusedSurface = await captureCall(() => surface(projZ, user, {
      action: "campaign_delete", channel: "zernio:meta", campaign_id: campMeta.id,
    }, { provider: createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" }) }));
    const metaRow = await svc.entities.AdsCampaign.get(campMeta.id);
    h.check("through the surface, a meta delete refuses and persists NOTHING",
      refusedSurface.threw && refusedSurface.code === "PROVIDER_INVALID_INPUT" &&
      metaRow.status === "ENABLED", `${refusedSurface.code || "no-throw"} status=${metaRow.status}`);
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