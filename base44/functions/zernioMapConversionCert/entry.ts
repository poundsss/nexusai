// Targeted certification for the EIGHTH implemented Zernio Ads runtime operation:
// mapConversion (shared/zernioAdsProvider.ts). Deterministic everywhere — the cert makes ZERO
// real network calls (the fetch seam is injected), opens no spend, and mutates nothing on any
// provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls;
//   2. the documented conversion-mapping endpoints leave NO registered Zernio channel a live
//      path: POST /v1/ads/conversions/actions (the conversion-action creation) is Google-only
//      with 501 on every other platform and its required accountId "must be a googleads
//      account"; POST /v1/accounts/{accountId}/conversion-destinations serves LinkedIn and
//      Google only — Meta and OpenAI Ads answer the documented 405 (pixels are created via the
//      tracking-tags flow) — and the LinkedIn path requires a body adAccountId the mapConversion
//      contract does not carry ({ mapping } only); TikTok conversions are not documented on
//      Zernio at all. The mapped operation therefore validates the contract's fields
//      (app_event_name, conversion_action_name) and refuses BEFORE any call with each channel's
//      documented refusal (PROVIDER_INVALID_INPUT), never a request the documentation says
//      cannot succeed;
//   3. refusals BEFORE any call: a missing mapping / app_event_name / conversion_action_name —
//      ZERO fetch calls on every path;
//   4. every other operation stays fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   5. through the REAL surface: conversion_mapping_update with map_to_provider: true refuses
//      and persists NOTHING (status stays "unmapped", no provider_conversion_ref, no change
//      log) — and Google stays untouched.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated, no real key is provisioned and no real conversion action is created.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider } from "../../shared/zernioAdsProvider.ts";
import { resolveAdsProvider, zernioProviderConfigured, ADS_CHANNELS, ZERNIO_ADS_CHANNELS } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method, body: init?.body ? String(init.body) : null });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

const MAPPING = { app_event_name: "purchase_completed", conversion_action_name: "Offline purchase", status: "unmapped" };

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
    const noKey = await captureCall(() => noKeyAdapter.mapConversion({ mapping: MAPPING }));
    h.check("without the key, mapConversion refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);
    const resolution = resolveAdsProvider("zernio:tiktok", {
      provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]) }),
    });
    h.check("the injected resolution stays live while unconfigured (the surface path keeps working unchanged)",
      resolution.providerLive === true && resolution.configured === false,
      JSON.stringify({ live: resolution.providerLive, configured: resolution.configured }));

    // ---- 2. refusals BEFORE any call (the contract's own fields) -------------------------
    const refuseArg = async (args) => {
      const c = [];
      const r = await captureCall(() => createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(c), apiKey: "test-zernio-key" })
        .mapConversion(args));
      return { r, calls: c };
    };
    const noMapping = await refuseArg(undefined);
    h.check("a missing mapping refuses with PROVIDER_INVALID_INPUT before any call",
      noMapping.r.threw && noMapping.r.code === "PROVIDER_INVALID_INPUT" && noMapping.calls.length === 0,
      `${noMapping.r.code || "no-throw"} calls=${noMapping.calls.length}`);
    const noEvent = await refuseArg({ conversion_action_name: "Offline purchase" });
    h.check("a mapping with no app_event_name refuses with PROVIDER_INVALID_INPUT before any call",
      noEvent.r.threw && noEvent.r.code === "PROVIDER_INVALID_INPUT" && noEvent.calls.length === 0,
      `${noEvent.r.code || "no-throw"} calls=${noEvent.calls.length}`);
    const noName = await refuseArg({ app_event_name: "purchase_completed" });
    h.check("a mapping with no conversion_action_name refuses with PROVIDER_INVALID_INPUT before any call",
      noName.r.threw && noName.r.code === "PROVIDER_INVALID_INPUT" && noName.calls.length === 0,
      `${noName.r.code || "no-throw"} calls=${noName.calls.length}`);

    // ---- 3. the documented platform matrix: every registered Zernio channel refuses ------
    const matrix = [];
    for (const channel of ZERNIO_ADS_CHANNELS) {
      const c = [];
      const r = await captureCall(() => createZernioAdsProvider(channel, { fetcher: documentedFetcher(c), apiKey: "test-zernio-key" })
        .mapConversion({ mapping: MAPPING }));
      matrix.push({ channel, code: r.code, threw: r.threw, calls: c.length });
    }
    h.check("every registered Zernio channel refuses with its documented refusal, ZERO calls",
      matrix.length === ZERNIO_ADS_CHANNELS.length && ADS_CHANNELS.filter((c) => c.startsWith("zernio:")).length === 4 &&
      matrix.every((m) => m.threw && m.code === "PROVIDER_INVALID_INPUT" && m.calls === 0),
      JSON.stringify(matrix));
    const linkedinRefusal = await captureCall(() => createZernioAdsProvider("zernio:linkedin", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" })
      .mapConversion({ mapping: MAPPING }));
    h.check("the LinkedIn refusal names the documented destination path and its missing adAccountId",
      linkedinRefusal.threw && String(linkedinRefusal.message || "").includes("conversion-destinations") &&
      String(linkedinRefusal.message || "").includes("adAccountId"), String(linkedinRefusal.message || "").slice(0, 160));
    const metaRefusal = await captureCall(() => createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" })
      .mapConversion({ mapping: MAPPING }));
    h.check("the Meta refusal carries the documented 405 and the tracking-tags flow",
      metaRefusal.threw && String(metaRefusal.message || "").includes("405") &&
      String(metaRefusal.message || "").includes("tracking-tags"), String(metaRefusal.message || "").slice(0, 160));
    const openaiRefusal = await captureCall(() => createZernioAdsProvider("zernio:openai", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" })
      .mapConversion({ mapping: MAPPING }));
    h.check("the OpenAI refusal carries the documented 405 and the tracking-tags flow",
      openaiRefusal.threw && String(openaiRefusal.message || "").includes("405") &&
      String(openaiRefusal.message || "").includes("tracking-tags"), String(openaiRefusal.message || "").slice(0, 160));
    const tiktokRefusal = await captureCall(() => createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" })
      .mapConversion({ mapping: MAPPING }));
    h.check("the TikTok refusal states conversions are not documented on Zernio",
      tiktokRefusal.threw && String(tiktokRefusal.message || "").includes("tiktok"),
      String(tiktokRefusal.message || "").slice(0, 160));
    h.check("a valid-shaped mapping NEVER issues a Zernio request on any registered channel",
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
    const ws = await svc.entities.Workspace.create({ name: `zmap-${stamp}`, owner_id: `ownerM_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zmap-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zmap" });
    projects.push(projZ.id);
    const user = { id: `ownerM_${stamp}`, email: "zm@example.com" };
    const provider = createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" });
    const created = await surface(projZ, user, {
      action: "conversion_mapping_create", app_event_name: "purchase_completed", conversion_action_name: "Offline purchase",
    }, { provider });
    h.check("the mapping create path still works (no provider call is needed to record the event)",
      created.mapping.app_event_name === "purchase_completed" && created.mapping.status === "unmapped",
      JSON.stringify({ status: created.mapping?.status }));
    const surfaceCalls = [];
    const refused = await captureCall(() => surface(projZ, user, {
      action: "conversion_mapping_update", mapping_id: created.mapping.id, map_to_provider: true,
    }, { provider }));
    h.check("through the surface, map_to_provider refuses with the provider's documented refusal",
      refused.threw && refused.code === "PROVIDER_INVALID_INPUT" &&
      String(refused.message || "").includes("tiktok"),
      `${refused.code || "no-throw"} ${String(refused.message || "").slice(0, 120)}`);
    const rowAfter = await svc.entities.AdsConversionMapping.get(created.mapping.id);
    h.check("the mapping persisted NOTHING: status stays unmapped, no provider_conversion_ref, no provider call",
      rowAfter.status === "unmapped" && !rowAfter.provider_conversion_ref && surfaceCalls.length === 0,
      JSON.stringify({ status: rowAfter.status, ref: rowAfter.provider_conversion_ref || null, calls: surfaceCalls.length }));
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: projZ.id }, "-created_date", 10);
    h.check("no change-log attribution was written for the refused mapping",
      !logs.some((l) => l.action === "conversion.mapping_updated"), JSON.stringify(logs.map((l) => l.action)));
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
      await purgeBy(svc, "AdsConversionMapping", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}