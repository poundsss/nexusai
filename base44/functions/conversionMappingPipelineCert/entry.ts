// Targeted certification for the NexusAI conversion-mapping PIPELINE — the end-to-end path the
// trace confirmed: googleAds (HTTP entry: project.read/write + audit) -> googleAdsSurface
// (shared/googleAds.ts conversion actions) -> the provider seam (adsProviderRegistry.ts) ->
// the adapters. It consumes the ALREADY CERTIFIED Zernio mapConversion adapter contract
// (zernioMapConversionCert) verbatim and certifies ONLY the pipeline wiring that the existing
// suites certified piecewise, never as one pass:
//   • the full Google-side lifecycle through the REAL surface with a deterministic stub
//     provider: create -> duplicate refusal -> not-found refusal -> the production fail-closed
//     gate on map_to_provider -> map (persist provider_conversion_ref + change log) -> list ->
//     upload (the mapped row + events reach the provider) -> delete (permanent);
//   • the NO_MAPPINGS branch on a fresh project;
//   • the Zernio side through the surface: create records the event with ZERO provider calls,
//     map_to_provider and upload refuse with the ADAPTER'S OWN certified documented refusals
//     (PROVIDER_INVALID_INPUT) and persist NOTHING — no schema/entity change, no invented
//     Zernio conversion API, and Google's conversion behavior untouched.
// ZERO real network activity: the Google provider is a stub, the Zernio adapter runs through
// the injected fetch seam, and its credential rides deps.apiKey — process.env is NEVER mutated.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { makeAdsSurface, makeAdsStubProvider } from "../../shared/adsCertStubs.ts";
import { createZernioAdsProvider, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { zernioProviderConfigured } from "../../shared/adsProviderRegistry.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;

  try {
    h.check("production state: no ZERNIO_API_KEY is provisioned for this app",
      zernioProviderConfigured() === false, String(zernioProviderConfigured()));

    // ---- A. the Google-side lifecycle through the REAL surface (deterministic stub) ------
    const wsA = await svc.entities.Workspace.create({ name: `convmap-${stamp}`, owner_id: `ownerC_${stamp}` });
    workspaces.push(wsA.id);
    const projA = await svc.entities.Project.create({ workspace_id: wsA.id, name: `convmap-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-convmap" });
    projects.push(projA.id);
    const user = { id: `ownerC_${stamp}`, email: "cm@example.com" };
    const googleStub = makeAdsStubProvider();
    const uploadCalls = [];
    googleStub.uploadConversions = async ({ mappings, events }) => {
      uploadCalls.push({ mappings: (mappings || []).map((m) => m.app_event_name), events: (events || []).map((e) => e?.event_name) });
      return { uploaded: (mappings || []).length, failed: [] };
    };
    const created = await surface(projA, user, { action: "conversion_mapping_create", app_event_name: "purchase_completed", conversion_action_name: "Purchases" }, { provider: googleStub });
    h.check("create records the event as unmapped with NO provider call (mapping needs no provider)",
      created.mapping.status === "unmapped" && !created.mapping.provider_conversion_ref &&
      googleStub.state.mapped.length === 0, JSON.stringify({ status: created.mapping?.status }));
    const dup = await captureCall(() => surface(projA, user, { action: "conversion_mapping_create", app_event_name: "purchase_completed" }, { provider: googleStub }));
    h.check("a duplicate event mapping is refused (one mapping per event per project)",
      dup.threw && dup.code === "MAPPING_EXISTS", dup.code || "no-throw");
    const missing = await captureCall(() => surface(projA, user, { action: "conversion_mapping_update", mapping_id: `no-such-${stamp}`, map_to_provider: true }, { provider: googleStub }));
    h.check("an unknown mapping id refuses with MAPPING_NOT_FOUND, before any provider call",
      missing.threw && missing.code === "MAPPING_NOT_FOUND" && googleStub.state.mapped.length === 0,
      missing.code || "no-throw");
    const unconfigured = await captureCall(() => surface(projA, user, { action: "conversion_mapping_update", mapping_id: created.mapping.id, map_to_provider: true }));
    h.check("the production gate: map_to_provider without the external provider refuses PROVIDER_NOT_CONFIGURED and persists nothing",
      unconfigured.threw && unconfigured.code === "PROVIDER_NOT_CONFIGURED" &&
      (await svc.entities.AdsConversionMapping.get(created.mapping.id)).status === "unmapped",
      unconfigured.code || "no-throw");
    const mapped = await surface(projA, user, { action: "conversion_mapping_update", mapping_id: created.mapping.id, map_to_provider: true }, { provider: googleStub });
    h.check("map_to_provider goes through the adapter contract and persists mapped + provider_conversion_ref",
      mapped.mapping.status === "mapped" && mapped.mapping.provider_conversion_ref === "prov-conv-1",
      JSON.stringify({ status: mapped.mapping?.status, ref: mapped.mapping?.provider_conversion_ref }));
    const mappedRow = await svc.entities.AdsConversionMapping.get(created.mapping.id);
    h.check("the mapped state is PERSISTED with its change-log attribution",
      mappedRow.status === "mapped" && mappedRow.provider_conversion_ref === "prov-conv-1",
      JSON.stringify({ status: mappedRow.status }));
    const logsA = await svc.entities.AdsChangeLog.filter({ project_id: projA.id }, "-created_date", 10);
    h.check("the mapping wrote change-log attribution (created + updated)",
      logsA.some((l) => l.action === "conversion.mapping_created") && logsA.some((l) => l.action === "conversion.mapping_updated"),
      JSON.stringify(logsA.map((l) => l.action)));
    const listed = await surface(projA, user, { action: "conversion_mapping_list" }, { provider: googleStub });
    h.check("list serves the persisted mapping (status + ref) through the surface",
      listed.mappings.length === 1 && listed.mappings[0].app_event_name === "purchase_completed" &&
      listed.mappings[0].status === "mapped", JSON.stringify(listed.mappings.length));
    const upload = await surface(projA, user, { action: "conversion_upload", events: [{ event_name: "purchase_completed", value: 25 }] }, { provider: googleStub });
    h.check("upload passes the MAPPED rows and the bounded events to the provider and reports its result",
      upload.uploaded === 1 && uploadCalls.length === 1 &&
      uploadCalls[0].mappings[0] === "purchase_completed" && uploadCalls[0].events[0] === "purchase_completed",
      JSON.stringify({ uploaded: upload.uploaded, calls: uploadCalls }));
    const removed = await surface(projA, user, { action: "conversion_mapping_delete", mapping_id: created.mapping.id }, { provider: googleStub });
    h.check("delete removes the mapping permanently",
      removed.deleted === true &&
      (await svc.entities.AdsConversionMapping.filter({ project_id: projA.id }, "created_date", 10)).length === 0,
      JSON.stringify(removed));
    const reDelete = await captureCall(() => surface(projA, user, { action: "conversion_mapping_delete", mapping_id: created.mapping.id }, { provider: googleStub }));
    h.check("deleting the deleted mapping refuses with MAPPING_NOT_FOUND",
      reDelete.threw && reDelete.code === "MAPPING_NOT_FOUND", reDelete.code || "no-throw");

    // ---- B. the NO_MAPPINGS branch on a project with nothing mapped ----------------------
    const fresh = await captureCall(() => surface(projA, user, { action: "conversion_upload", events: [{ event_name: "purchase_completed" }] }, { provider: googleStub }));
    h.check("upload against a project with NO mapped mappings refuses NO_MAPPINGS without a provider call",
      fresh.threw && fresh.code === "NO_MAPPINGS" && uploadCalls.length === 1, fresh.code || "no-throw");

    // ---- C. the Zernio side through the surface: the certified contract's own refusals ----
    const wsZ = await svc.entities.Workspace.create({ name: `zconv-${stamp}`, owner_id: `ownerZC_${stamp}` });
    workspaces.push(wsZ.id);
    const projZ = await svc.entities.Project.create({ workspace_id: wsZ.id, name: `zconv-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zconv" });
    projects.push(projZ.id);
    const zernioCalls = [];
    const zernioProvider = createZernioAdsProvider("zernio:tiktok", { fetcher: async (url, init) => { zernioCalls.push({ url: String(url), method: init?.method }); return new Response("{}", { status: 200 }); }, apiKey: "test-zernio-key" });
    const zCreated = await surface(projZ, user, { action: "conversion_mapping_create", channel: "zernio:tiktok", app_event_name: "signup", conversion_action_name: "Signups" }, { provider: zernioProvider });
    h.check("the Zernio-channel mapping create records the event with ZERO provider calls",
      zCreated.mapping.status === "unmapped" && zernioCalls.length === 0, JSON.stringify({ calls: zernioCalls.length }));
    const zRefused = await captureCall(() => surface(projZ, user, { action: "conversion_mapping_update", channel: "zernio:tiktok", mapping_id: zCreated.mapping.id, map_to_provider: true }, { provider: zernioProvider }));
    h.check("map_to_provider on Zernio refuses with the ADAPTER'S certified documented refusal, no fetch",
      zRefused.threw && zRefused.code === "PROVIDER_INVALID_INPUT" &&
      String(zRefused.message || "").includes("tiktok") && zernioCalls.length === 0,
      `${zRefused.code || "no-throw"} calls=${zernioCalls.length}`);
    const zRow = await svc.entities.AdsConversionMapping.get(zCreated.mapping.id);
    h.check("the refused Zernio mapping persisted NOTHING (unmapped, no provider ref)",
      zRow.status === "unmapped" && !zRow.provider_conversion_ref, JSON.stringify({ status: zRow.status }));
    const zUpload = await captureCall(() => surface(projZ, user, { action: "conversion_upload", channel: "zernio:tiktok", events: [{ event_name: "signup" }] }, { provider: zernioProvider }));
    h.check("conversion_upload on Zernio is gated by the surface's NO_MAPPINGS first (nothing mapped, no fetch)",
      zUpload.threw && zUpload.code === "NO_MAPPINGS" && zernioCalls.length === 0,
      `${zUpload.code || "no-throw"} calls=${zernioCalls.length}`);
    const logsZ = await svc.entities.AdsChangeLog.filter({ project_id: projZ.id }, "-created_date", 10);
    h.check("the Zernio refusals wrote NO mapping-updated attribution (created only)",
      logsZ.some((l) => l.action === "conversion.mapping_created") &&
      !logsZ.some((l) => l.action === "conversion.mapping_updated"), JSON.stringify(logsZ.map((l) => l.action)));
    const gNone = await surface(projZ, user, { action: "account_get" });
    h.check("Google is untouched: the Zernio-channel project has no google-channel account row",
      gNone.account === null, JSON.stringify(gNone.account));
    h.check("no Zernio request ever left the app for the whole pipeline pass",
      zernioCalls.length === 0, JSON.stringify(zernioCalls));
  } catch (e) {
    return harnessError(h, e);
  } finally {
    if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;
    for (const pid of projects) {
      await purgeBy(svc, "AdsAccount", { project_id: pid });
      await purgeBy(svc, "AdsCampaign", { project_id: pid });
      await purgeBy(svc, "AdsConversionMapping", { project_id: pid });
      await purgeBy(svc, "AdsChangeLog", { project_id: pid });
      await purgeBy(svc, "AuditLog", { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of workspaces) await svc.entities.Workspace.delete(wid).catch(() => {});
  }

  return harnessResponse(h);
}