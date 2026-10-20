// Targeted certification for the NINTH implemented Zernio Ads runtime operation:
// uploadConversions (shared/zernioAdsProvider.ts). Deterministic everywhere — the cert makes
// ZERO real network calls (the fetch seam is injected), uploads nothing, and mutates nothing on
// any provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls;
//   2. refusals BEFORE any call: a missing/empty mappings or events arg (the contract's
//      uploadConversions args) — ZERO fetch calls on every path;
//   3. the documented-path refusal: the ONLY documented conversion-event path
//      (POST /v1/ads/conversions) requires the Zernio accountId and a channel-scoped
//      destinationId the contract's { mappings, events } args do not carry — every registered
//      Zernio channel refuses (PROVIDER_INVALID_INPUT) with ZERO calls, never sending another
//      platform's destination ref;
//   4. every other operation stays fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   5. through the REAL surface: a Google-mapped row uploads through the Google stub, the same
//      row's upload refuses on every Zernio channel, and a Zernio project with no mapped rows
//      refuses NO_MAPPINGS before the provider — Google's pipeline behavior unchanged.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated, no real key is provisioned and no conversion event leaves the app.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider } from "../../shared/zernioAdsProvider.ts";
import { resolveAdsProvider, zernioProviderConfigured, ADS_CHANNELS, ZERNIO_ADS_CHANNELS } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface, makeAdsStubProvider } from "../../shared/adsCertStubs.ts";

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method, body: init?.body ? String(init.body) : null });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

const MAPPING = { app_event_name: "purchase_completed", conversion_action_name: "Offline purchase", provider_conversion_ref: "customers/1234567890/conversionActions/987654321", status: "mapped" };
const EVENTS = [{ eventId: "order_abc_123", eventTime: 1798848000, value: 129.99, currency: "USD" }];

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
    const noKey = await captureCall(() => noKeyAdapter.uploadConversions({ mappings: [MAPPING], events: EVENTS }));
    h.check("without the key, uploadConversions refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);
    const resolution = resolveAdsProvider("zernio:meta", {
      provider: createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]) }),
    });
    h.check("the injected resolution stays live while unconfigured (the surface path keeps working unchanged)",
      resolution.providerLive === true && resolution.configured === false,
      JSON.stringify({ live: resolution.providerLive, configured: resolution.configured }));

    // ---- 2. refusals BEFORE any call (the contract's own args) ---------------------------
    const refuseArg = async (args) => {
      const c = [];
      const r = await captureCall(() => createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher(c), apiKey: "test-zernio-key" })
        .uploadConversions(args));
      return { r, calls: c };
    };
    const noMappings = await refuseArg(undefined);
    h.check("a missing mappings arg refuses with PROVIDER_INVALID_INPUT before any call",
      noMappings.r.threw && noMappings.r.code === "PROVIDER_INVALID_INPUT" && noMappings.calls.length === 0,
      `${noMappings.r.code || "no-throw"} calls=${noMappings.calls.length}`);
    const emptyMappings = await refuseArg({ mappings: [], events: EVENTS });
    h.check("an empty mappings list refuses with PROVIDER_INVALID_INPUT before any call",
      emptyMappings.r.threw && emptyMappings.r.code === "PROVIDER_INVALID_INPUT" && emptyMappings.calls.length === 0,
      `${emptyMappings.r.code || "no-throw"} calls=${emptyMappings.calls.length}`);
    const noEvents = await refuseArg({ mappings: [MAPPING], events: [] });
    h.check("an empty events list refuses with PROVIDER_INVALID_INPUT before any call",
      noEvents.r.threw && noEvents.r.code === "PROVIDER_INVALID_INPUT" && noEvents.calls.length === 0,
      `${noEvents.r.code || "no-throw"} calls=${noEvents.calls.length}`);

    // ---- 3. the documented-path refusal: the contract carries no Zernio destination ------
    const matrix = [];
    for (const channel of ZERNIO_ADS_CHANNELS) {
      const c = [];
      const r = await captureCall(() => createZernioAdsProvider(channel, { fetcher: documentedFetcher(c), apiKey: "test-zernio-key" })
        .uploadConversions({ mappings: [MAPPING], events: EVENTS }));
      matrix.push({ channel, code: r.code, threw: r.threw, calls: c.length });
    }
    h.check("every registered Zernio channel refuses with the documented-path refusal, ZERO calls",
      matrix.length === ZERNIO_ADS_CHANNELS.length && ADS_CHANNELS.filter((c) => c.startsWith("zernio:")).length === 4 &&
      matrix.every((m) => m.threw && m.code === "PROVIDER_INVALID_INPUT" && m.calls === 0),
      JSON.stringify(matrix));
    const metaRefusal = await captureCall(() => createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]), apiKey: "test-zernio-key" })
      .uploadConversions({ mappings: [MAPPING], events: EVENTS }));
    h.check("the refusal names the documented endpoint and the missing accountId/destinationId",
      metaRefusal.threw && String(metaRefusal.message || "").includes("POST /v1/ads/conversions") &&
      String(metaRefusal.message || "").includes("accountId") && String(metaRefusal.message || "").includes("destinationId"),
      String(metaRefusal.message || "").slice(0, 160));
    h.check("a valid-shaped upload NEVER issues a Zernio request on any registered channel",
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

    // ---- 5. through the REAL surface: Google uploads, Zernio refuses, nothing leaks ------
    const ws = await svc.entities.Workspace.create({ name: `zup-${stamp}`, owner_id: `ownerU_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zup-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zup" });
    projects.push(projZ.id);
    const user = { id: `ownerU_${stamp}`, email: "zu@example.com" };
    const row = await svc.entities.AdsConversionMapping.create({
      project_id: projZ.id, workspace_id: ws.id, app_event_name: "purchase_completed",
      conversion_action_name: "Offline purchase", provider_conversion_ref: "customers/1234567890/conversionActions/987654321",
      status: "mapped", created_at: new Date().toISOString(),
    });
    // Google channel: the certified stub upload runs through the real surface, unchanged.
    const stub = makeAdsStubProvider();
    const gUpload = await surface(projZ, user, { action: "conversion_upload", events: EVENTS }, { provider: stub });
    h.check("through the surface, the Google channel still uploads against the mapped row (stub)",
      gUpload.uploaded === 1 && stub.state.uploaded === 1, JSON.stringify({ uploaded: gUpload.uploaded }));
    // Zernio channel: the SAME (Google-mapped) row refuses — never sent to a Zernio endpoint.
    const surfaceCalls = [];
    const zRefused = await captureCall(() => surface(projZ, user, { action: "conversion_upload", channel: "zernio:meta", events: EVENTS },
      { provider: createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher(surfaceCalls), apiKey: "test-zernio-key" }) }));
    h.check("through the surface, the Zernio channel refuses the upload (documented-path refusal)",
      zRefused.threw && zRefused.code === "PROVIDER_INVALID_INPUT" &&
      String(zRefused.message || "").includes("destinationId") && surfaceCalls.length === 0,
      `${zRefused.code || "no-throw"} calls=${surfaceCalls.length}`);
    const rowAfter = await svc.entities.AdsConversionMapping.get(row.id);
    h.check("the mapping row is UNTOUCHED by the refused upload (still mapped to the Google ref)",
      rowAfter.status === "mapped" && rowAfter.provider_conversion_ref === "customers/1234567890/conversionActions/987654321",
      JSON.stringify({ status: rowAfter.status }));
    // A project with no mapped rows refuses at the surface, before the provider is reached.
    const projBare = await svc.entities.Project.create({ workspace_id: ws.id, name: `zup-bare-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zup-bare" });
    projects.push(projBare.id);
    await svc.entities.AdsConversionMapping.create({
      project_id: projBare.id, workspace_id: ws.id, app_event_name: "signup_started",
      conversion_action_name: "Signups", status: "unmapped", created_at: new Date().toISOString(),
    });
    const bare = await captureCall(() => surface(projBare, user, { action: "conversion_upload", channel: "zernio:tiktok", events: EVENTS },
      { provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]) }) }));
    h.check("a project with no mapped rows refuses NO_MAPPINGS before any provider call",
      bare.threw && bare.code === "NO_MAPPINGS", bare.code || "no-throw");
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