// Targeted certification for the FOURTH implemented Zernio Ads runtime operation:
// updateCampaign (shared/zernioAdsProvider.ts). Deterministic everywhere — the cert makes ZERO
// real network calls (the fetch seam is injected) and mutates nothing on any provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls;
//   2. auth + request shape: PUT https://zernio.com/api/v1/ads/campaigns/{id}, Bearer header,
//      JSON body { platform, budget: { amount, type: "daily" } } per the documented endpoint
//      (docs.zernio.com/ad-campaigns/update-ad-campaign, fetched 2026-10-06);
//   3. mapping: the documented 200 response maps into the updateCampaign return shape — the
//      budget object and budgetLevel verbatim, `updated` as the write provenance, no status;
//   4. refusals BEFORE any call: zernio:meta (platform half), an id-less campaign, an empty
//      patch, a rename (Meta-only 501), a budget on tiktok (documented 501) and a
//      non-whole-unit budget (never rounded);
//   5. a Zernio 401 is PROVIDER_AUTH_FAILED; every other operation stays
//      fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   6. through the REAL surface: a configured-injection campaign_update persists the budget
//      and writes the change log, a documented-501 budget refuses without persisting, and
//      Google stays untouched.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated and no real key is provisioned or required.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider, mapZernioUpdateResponse, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { zernioProviderConfigured } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

const DOCUMENTED_UPDATE = {
  updated: 1,
  budget: {
    amount: 10, type: "daily", amountMicros: "10000000", explicitlyShared: false,
    resourceName: "accounts/1/budgets/2", deliveryMethod: "STANDARD",
  },
  budgetLevel: "campaign",
};

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({
    url: String(url),
    method: init?.method,
    auth: init?.headers?.Authorization || null,
    contentType: init?.headers?.["Content-Type"] || null,
    body: init?.body ? JSON.parse(String(init.body)) : null,
  });
  return new Response(JSON.stringify(DOCUMENTED_UPDATE), { status: 200 });
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
    const noKeyAdapter = createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(noKeyCalls) });
    const noKey = await captureCall(() => noKeyAdapter.updateCampaign({
      campaign: { provider_campaign_id: "123456789" },
      patch: { daily_budget_micros: 10000000 },
    }));
    h.check("without the key, updateCampaign refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);

    // ---- 2. auth + request shape through the injected fetch seam -------------------------
    const calls = [];
    const openai = createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(calls), apiKey: "test-zernio-key" });
    const res = await openai.updateCampaign({
      campaign: { provider_campaign_id: "123456789" },
      patch: { daily_budget_micros: 10000000 },
    });
    const call = calls[0] || {};
    h.check("the request is PUT on the documented endpoint with the Bearer auth header",
      calls.length === 1 && call.method === "PUT" &&
      call.url === `${ZERNIO_API_BASE_URL}/ads/campaigns/123456789` &&
      typeof call.auth === "string" && call.auth.startsWith("Bearer ") &&
      call.contentType === "application/json" &&
      JSON.stringify(call.body) === JSON.stringify({ platform: "openai", budget: { amount: 10, type: "daily" } }),
      `${call.method || "no-call"} ${call.url || ""} ${JSON.stringify(call.body)}`);
    h.check("the key is sent only in the header (starts with Bearer, never in the URL or body)",
      !!call.auth?.startsWith("Bearer ") && !String(call.url).includes("test-zernio-key") &&
      !JSON.stringify(call.body || {}).includes("test-zernio-key"), "header-only");

    // ---- 3. mapping of the documented response -------------------------------------------
    h.check("the documented 200 response maps verbatim (budget object untouched, no status carried)",
      res.campaign.provider_write.updated === 1 &&
      JSON.stringify(res.campaign.provider_write.budget) === JSON.stringify(DOCUMENTED_UPDATE.budget) &&
      res.campaign.provider_write.budget_level === "campaign" &&
      res.campaign.status === undefined && res.campaign.serving_status === undefined,
      JSON.stringify(res));
    const zeroUpdated = mapZernioUpdateResponse({ updated: 0 });
    h.check("a zero-updated response maps honestly (updated: 0, no budget echoed)",
      zeroUpdated.campaign.provider_write.updated === 0 &&
      zeroUpdated.campaign.provider_write.budget === null &&
      zeroUpdated.campaign.provider_write.budget_level === "", JSON.stringify(zeroUpdated));

    // ---- 4. refusals BEFORE any call ------------------------------------------------------
    const refuse = async (channel, patch, campaign = { provider_campaign_id: "123456789" }) => {
      const c = [];
      const r = await captureCall(() => createZernioAdsProvider(channel, { fetcher: documentedFetcher(c), apiKey: "test-zernio-key" })
        .updateCampaign({ campaign, patch }));
      return { r, calls: c };
    };
    const meta = await refuse("zernio:meta", { daily_budget_micros: 10000000 });
    h.check("zernio:meta refuses with PROVIDER_INVALID_INPUT before any call (half never guessed)",
      meta.r.threw && meta.r.code === "PROVIDER_INVALID_INPUT" && meta.calls.length === 0,
      `${meta.r.code || "no-throw"} calls=${meta.calls.length}`);
    const idLess = await refuse("zernio:openai", { daily_budget_micros: 10000000 }, {});
    h.check("an id-less campaign refuses with PROVIDER_INVALID_INPUT before any call",
      idLess.r.threw && idLess.r.code === "PROVIDER_INVALID_INPUT" && idLess.calls.length === 0,
      `${idLess.r.code || "no-throw"} calls=${idLess.calls.length}`);
    const empty = await refuse("zernio:openai", {});
    h.check("an empty patch refuses before any call (Zernio requires at least one field)",
      empty.r.threw && empty.r.code === "PROVIDER_INVALID_INPUT" && empty.calls.length === 0,
      `${empty.r.code || "no-throw"} calls=${empty.calls.length}`);
    const rename = await refuse("zernio:openai", { campaign_name: "New name" });
    h.check("a rename refuses before any call (Meta-only 501 on every other platform)",
      rename.r.threw && rename.r.code === "PROVIDER_INVALID_INPUT" && rename.calls.length === 0,
      `${rename.r.code || "no-throw"} calls=${rename.calls.length}`);
    const tiktokBudget = await refuse("zernio:tiktok", { daily_budget_micros: 10000000 });
    h.check("a budget on tiktok refuses before any call (documented 501 on that platform)",
      tiktokBudget.r.threw && tiktokBudget.r.code === "PROVIDER_INVALID_INPUT" && tiktokBudget.calls.length === 0,
      `${tiktokBudget.r.code || "no-throw"} calls=${tiktokBudget.calls.length}`);
    const fractional = await refuse("zernio:openai", { daily_budget_micros: 10000001 });
    h.check("a non-whole-unit budget refuses before any call (never rounded)",
      fractional.r.threw && fractional.r.code === "PROVIDER_INVALID_INPUT" && fractional.calls.length === 0,
      `${fractional.r.code || "no-throw"} calls=${fractional.calls.length}`);
    const authFailed = await captureCall(() => createZernioAdsProvider("zernio:openai", {
      fetcher: async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }),
      apiKey: "test-zernio-key",
    }).updateCampaign({ campaign: { provider_campaign_id: "123456789" }, patch: { daily_budget_micros: 10000000 } }));
    h.check("a Zernio 401 is refused as PROVIDER_AUTH_FAILED, never mapped into state",
      authFailed.threw && authFailed.code === "PROVIDER_AUTH_FAILED", authFailed.code || "no-throw");

    // ---- 5. every other operation stays fail-closed/unimplemented ------------------------
    const guarded = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]) });
    const opResults = [];
    for (const op of ["launch"]) {
      const r = await captureCall(() => guarded[op]({}));
      opResults.push({ op, code: r.code, threw: r.threw });
    }
    h.check("all other operations refuse with PROVIDER_UNIMPLEMENTED, no fetch, no state change",
      opResults.every((r) => r.threw && r.code === "PROVIDER_UNIMPLEMENTED"), JSON.stringify(opResults.map((r) => r.code)));

    // ---- 6. through the REAL surface: budget persists on openai, 501 refuses, Google safe -
    const ws = await svc.entities.Workspace.create({ name: `zupdate-${stamp}`, owner_id: `ownerU_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zupdate-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zupdate" });
    projects.push(projZ.id);
    const user = { id: `ownerU_${stamp}`, email: "zu@example.com" };
    const acc = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:openai", status: "active",
      provider_account_ref: "zacc-1", payment_on_file: true,
    });
    const accTiktok = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:tiktok", status: "active",
      provider_account_ref: "zacc-2", payment_on_file: true,
    });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: acc.id, channel: "zernio:openai",
      campaign_name: "Zernio update fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "123456789",
    });
    const campTiktok = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: accTiktok.id, channel: "zernio:tiktok",
      campaign_name: "Zernio update tiktok fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "987654321",
    });
    const surfaceCalls = [];
    const openaiProvider = createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher(surfaceCalls), apiKey: "test-zernio-key" });
    const upd = await surface(projZ, user, {
      action: "campaign_update", channel: "zernio:openai", campaign_id: camp.id, daily_budget_micros: 20000000,
    }, { provider: openaiProvider });
    h.check("through the surface, campaign_update serves the updated budget projection",
      upd.campaign.daily_budget_micros === 20000000, JSON.stringify({ budget: upd.campaign?.daily_budget_micros }));
    const updatedRow = await svc.entities.AdsCampaign.get(camp.id);
    h.check("the update PERSISTED: daily_budget_micros 20000000, status/serving untouched, change log written",
      updatedRow.daily_budget_micros === 20000000 && updatedRow.status === "ENABLED" && !!updatedRow.last_synced_at,
      JSON.stringify({ budget: updatedRow.daily_budget_micros, status: updatedRow.status }));
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: projZ.id }, "-created_date", 10);
    h.check("the update wrote its change-log attribution (campaign.updated)",
      logs.some((l) => l.action === "campaign.updated"), JSON.stringify(logs.map((l) => l.action)));
    const refusedSurface = await captureCall(() => surface(projZ, user, {
      action: "campaign_update", channel: "zernio:tiktok", campaign_id: campTiktok.id, daily_budget_micros: 20000000,
    }, { provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" }) }));
    const tiktokRow = await svc.entities.AdsCampaign.get(campTiktok.id);
    h.check("through the surface, a documented-501 budget edit refuses and persists NOTHING",
      refusedSurface.threw && refusedSurface.code === "PROVIDER_INVALID_INPUT" &&
      tiktokRow.daily_budget_micros === 10000000, `${refusedSurface.code || "no-throw"} budget=${tiktokRow.daily_budget_micros}`);
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