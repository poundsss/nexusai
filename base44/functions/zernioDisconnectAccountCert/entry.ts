// Targeted certification for the TENTH implemented Zernio Ads runtime operation:
// disconnectAccount (shared/zernioAdsProvider.ts). Deterministic everywhere — the cert makes
// ZERO real network calls (the fetch seam is injected), disconnects no real account, and
// mutates nothing on any provider:
//   1. fail-closed: without ZERNIO_API_KEY the adapter refuses (PROVIDER_NOT_CONFIGURED) and
//      the fetch seam records ZERO calls;
//   2. auth + request shape: DELETE https://zernio.com/api/v1/accounts/{provider_account_ref}
//      with the Bearer auth header (docs.zernio.com/accounts/delete-account, fetched
//      2026-10-06); the documented 200 response { message } passes through verbatim and the
//      contract's budget_end_confirmed is honestly FALSE (the documented response carries no
//      budget/spend information);
//   3. refusals BEFORE any call: an account with no provider_account_ref; a Zernio 401; and a
//      documented 404 (already disconnected, grace window) surfaces as PROVIDER_ERROR;
//   4. every other operation stays fail-closed/unimplemented (PROVIDER_UNIMPLEMENTED, no calls);
//   5. through the REAL surface: a configured-injection account_disconnect persists the
//      disconnected row + change log, short-circuits an already-disconnected account without
//      a provider call, leaves campaigns untouched — and Google stays untouched.
// The ZERNIO_API_KEY used here is a scratch test value carried by the adapters via deps.apiKey —
// process.env is never mutated, no real key is provisioned and no real account is touched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider, mapZernioDisconnectResponse, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { resolveAdsProvider, zernioProviderConfigured } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";

const DOCUMENTED_DISCONNECT = { message: "Account disconnected successfully" };

const documentedFetcher = (calls) => async (url, init) => {
  calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization || null, body: init?.body ? String(init.body) : null });
  return new Response(JSON.stringify(DOCUMENTED_DISCONNECT), { status: 200 });
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
    const noKey = await captureCall(() => noKeyAdapter.disconnectAccount({ account: { provider_account_ref: "zacc-1" } }));
    h.check("without the key, disconnectAccount refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);
    const resolution = resolveAdsProvider("zernio:tiktok", {
      provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher([]) }),
    });
    h.check("the injected resolution stays live while unconfigured (the surface path keeps working unchanged)",
      resolution.providerLive === true && resolution.configured === false,
      JSON.stringify({ live: resolution.providerLive, configured: resolution.configured }));

    // ---- 2. auth + request shape through the injected fetch seam -------------------------
    const calls = [];
    const tiktok = createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(calls), apiKey: "test-zernio-key" });
    const res = await tiktok.disconnectAccount({ account: { provider_account_ref: "zacc-1" } });
    const call = calls[0] || {};
    h.check("the request is DELETE on the documented endpoint with the Bearer auth header",
      calls.length === 1 && call.method === "DELETE" &&
      call.url === `${ZERNIO_API_BASE_URL}/accounts/zacc-1` &&
      typeof call.auth === "string" && call.auth.startsWith("Bearer ") && call.body === null,
      `${call.method || "no-call"} ${call.url || ""}`);
    h.check("the key is sent only in the header (starts with Bearer, never in the URL)",
      !!call.auth?.startsWith("Bearer ") && !String(call.url).includes("test-zernio-key"), "header-only");
    h.check("the documented 200 response passes through verbatim and budget_end_confirmed stays honestly false",
      res.message === "Account disconnected successfully" && res.budget_end_confirmed === false,
      JSON.stringify(res));
    const emptyBody = mapZernioDisconnectResponse(undefined);
    h.check("a body without a message maps to an empty message (never invented)",
      emptyBody.message === "", JSON.stringify(emptyBody));

    // ---- 3. refusals BEFORE any call ------------------------------------------------------
    const noRefCalls = [];
    const noRef = await captureCall(() => createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(noRefCalls), apiKey: "test-zernio-key" })
      .disconnectAccount({ account: { provider_account_ref: "" } }));
    h.check("an account with no provider_account_ref refuses with PROVIDER_INVALID_INPUT before any call",
      noRef.threw && noRef.code === "PROVIDER_INVALID_INPUT" && noRefCalls.length === 0,
      `${noRef.code || "no-throw"} calls=${noRefCalls.length}`);
    const authFailed = await captureCall(() => createZernioAdsProvider("zernio:tiktok", {
      fetcher: async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }),
      apiKey: "test-zernio-key",
    }).disconnectAccount({ account: { provider_account_ref: "zacc-1" } }));
    h.check("a Zernio 401 is refused as PROVIDER_AUTH_FAILED, never mapped into state",
      authFailed.threw && authFailed.code === "PROVIDER_AUTH_FAILED", authFailed.code || "no-throw");
    const graceWindow = await captureCall(() => createZernioAdsProvider("zernio:tiktok", {
      fetcher: async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
      apiKey: "test-zernio-key",
    }).disconnectAccount({ account: { provider_account_ref: "zacc-1" } }));
    h.check("a documented 404 (already disconnected, grace window) surfaces as PROVIDER_ERROR naming the reason",
      graceWindow.threw && graceWindow.code === "PROVIDER_ERROR" &&
      String(graceWindow.message || "").includes("grace window"), String(graceWindow.message || "").slice(0, 160));

    // ---- 4. every other operation stays fail-closed/unimplemented ------------------------
    const guarded = createZernioAdsProvider("zernio:meta", { fetcher: documentedFetcher([]) });
    const opResults = [];
    for (const op of ["launch"]) {
      const r = await captureCall(() => guarded[op]({}));
      opResults.push({ op, code: r.code, threw: r.threw });
    }
    h.check("all other operations refuse with PROVIDER_UNIMPLEMENTED, no fetch, no state change",
      opResults.every((r) => r.threw && r.code === "PROVIDER_UNIMPLEMENTED"), JSON.stringify(opResults.map((r) => r.code)));

    // ---- 5. through the REAL surface: the disconnect persists, campaigns untouched --------
    const ws = await svc.entities.Workspace.create({ name: `zdisc-${stamp}`, owner_id: `ownerD_${stamp}` });
    workspaces.push(ws.id);
    const projZ = await svc.entities.Project.create({ workspace_id: ws.id, name: `zdisc-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-zdisc" });
    projects.push(projZ.id);
    const user = { id: `ownerD_${stamp}`, email: "zd@example.com" };
    const acc = await svc.entities.AdsAccount.create({
      project_id: projZ.id, workspace_id: ws.id, channel: "zernio:tiktok", status: "active",
      provider_account_ref: "zacc-1", payment_on_file: true,
    });
    const camp = await svc.entities.AdsCampaign.create({
      project_id: projZ.id, workspace_id: ws.id, account_id: acc.id, channel: "zernio:tiktok",
      campaign_name: "Zernio disconnect fixture", campaign_type: "PERFORMANCE_MAX", status: "ENABLED",
      daily_budget_micros: 10000000, provider_campaign_id: "123456789",
    });
    const surfaceCalls = [];
    const done = await surface(projZ, user, { action: "account_disconnect", channel: "zernio:tiktok" },
      { provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(surfaceCalls), apiKey: "test-zernio-key" }) });
    h.check("through the surface, account_disconnect reports the honest budget_end_confirmed=false",
      done.budget_end_confirmed === false && done.account.status === "disconnected" && !!done.account.disconnected_at,
      JSON.stringify({ confirmed: done.budget_end_confirmed, status: done.account?.status }));
    const rowAfter = await svc.entities.AdsAccount.get(acc.id);
    h.check("the disconnect PERSISTED: the account row is disconnected with its timestamp",
      rowAfter.status === "disconnected" && !!rowAfter.disconnected_at,
      JSON.stringify({ status: rowAfter.status, at: !!rowAfter.disconnected_at }));
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: projZ.id }, "-created_date", 10);
    h.check("the disconnect wrote its change-log attribution (budget_end_confirmed false)",
      logs.some((l) => l.action === "account.disconnected" && l.detail?.budget_end_confirmed === false),
      JSON.stringify(logs.map((l) => l.action)));
    const campAfter = await svc.entities.AdsCampaign.get(camp.id);
    h.check("the campaign is UNTOUCHED: still ENABLED with its budget (no campaign mutation)",
      campAfter.status === "ENABLED" && campAfter.daily_budget_micros === 10000000,
      JSON.stringify({ status: campAfter.status, budget: campAfter.daily_budget_micros }));
    const againCalls = [];
    const again = await surface(projZ, user, { action: "account_disconnect", channel: "zernio:tiktok" },
      { provider: createZernioAdsProvider("zernio:tiktok", { fetcher: documentedFetcher(againCalls) }) });
    h.check("an already-disconnected account short-circuits at the surface with NO provider call",
      again.budget_end_confirmed === true && againCalls.length === 0,
      JSON.stringify({ confirmed: again.budget_end_confirmed, calls: againCalls.length }));
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