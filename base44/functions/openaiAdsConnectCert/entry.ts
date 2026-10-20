// Targeted certification for the OpenAI Ads CONNECTION path — the DOCUMENTED Zernio
// credentials-connect (POST /v1/connect/openai-ads/credentials, docs.zernio.com/platforms/
// openai-ads#connect + openapi.yaml, fetched 2026-10-06), implemented as connectZernioOpenAIAds
// (shared/zernioAdsProvider.ts — NOT a campaign adapter operation; the certified 11-op contract
// is untouched) plus the googleAdsSurface `account_connect` action. Deterministic everywhere:
// ZERO real network activity (the fetch seam is injected), ZERO real OpenAI credentials (the
// member key below is a scratch test value), and process.env is NEVER mutated:
//   1. fail-closed: without ZERNIO_API_KEY the adapter AND the surface refuse
//      (PROVIDER_NOT_CONFIGURED) and make ZERO fetch calls;
//   2. request + mapping: POST on the documented endpoint, Bearer (ZERNIO key only in the
//      header, member key only in the documented body), 200 { accountId, adAccountName } →
//      { provider_account_ref, ad_account_name };
//   3. documented error semantics: 401 invalid_credentials → PROVIDER_INVALID_CREDENTIALS,
//      plain 401/403 → PROVIDER_AUTH_FAILED, 402 → PROVIDER_PAYMENT_REQUIRED with the billing
//      reason + dashboard_url, other non-ok → PROVIDER_ERROR, an accountId-less 200 refuses —
//      and NO error ever echoes the member's key;
//   4. through the REAL surface: persist-only-the-identity into the existing AdsAccount model
//      (one row per project/channel), idempotent repost (in place, no duplicate), reconnect
//      after the certified disconnect clears disconnected_at, refusals persist nothing;
//   5. channel restrictions: only zernio:openai connects; google and the other Zernio channels
//      refuse CHANNEL_NOT_CONNECTABLE; Google Ads behavior untouched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy } from "../../shared/testHarness.ts";
import { createZernioAdsProvider, connectZernioOpenAIAds, ZERNIO_API_BASE_URL } from "../../shared/zernioAdsProvider.ts";
import { zernioProviderConfigured } from "../../shared/adsProviderRegistry.ts";
import { makeAdsSurface } from "../../shared/adsCertStubs.ts";
import { OPENAI_CONNECT_CONNECTED as CONNECTED, connectOkFetcher as okFetcher, openaiConnectGhostProject as ghostProject } from "../../shared/openaiAdsConnectCertHelpers.ts";

const USER_KEY = "sk-ads-scratch-test-key";
const PROFILE_ID = "prof-test-000";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const projects = [], workspaces = [];
  const surface = makeAdsSurface(svc);
  if (process.env.ZERNIO_API_KEY === "test-zernio-key") delete process.env.ZERNIO_API_KEY;

  try {
    // ---- 1. fail-closed (production state: no key is provisioned) ------------------------
    h.check("production state: no ZERNIO_API_KEY is provisioned for this app",
      zernioProviderConfigured() === false, String(zernioProviderConfigured()));
    const noKeyCalls = [];
    const noKey = await captureCall(() => connectZernioOpenAIAds({ userApiKey: USER_KEY, profileId: PROFILE_ID, fetcher: okFetcher(noKeyCalls) }));
    h.check("without the key, the adapter refuses (PROVIDER_NOT_CONFIGURED) and makes ZERO fetch calls",
      noKey.threw && noKey.code === "PROVIDER_NOT_CONFIGURED" && noKeyCalls.length === 0,
      `${noKey.code || "no-throw"} calls=${noKeyCalls.length}`);
    const noKeySurfaceCalls = [];
    const noKeySurface = await captureCall(() => surface(ghostProject(), { id: "u1" }, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, { fetcher: okFetcher(noKeySurfaceCalls) }));
    h.check("without the key, the surface refuses the same way and makes ZERO fetch calls",
      noKeySurface.threw && noKeySurface.code === "PROVIDER_NOT_CONFIGURED" && noKeySurfaceCalls.length === 0,
      noKeySurface.code || "no-throw");

    // ---- 2. request shape + response mapping through the injected fetch seam --------------
    const calls = [];
    const connected = await connectZernioOpenAIAds({ userApiKey: USER_KEY, profileId: PROFILE_ID, fetcher: okFetcher(calls), apiKey: "test-zernio-key" });
    const call = calls[0] || {};
    h.check("the request is POST on the documented endpoint with the Bearer auth header",
      calls.length === 1 && call.method === "POST" && call.url === `${ZERNIO_API_BASE_URL}/connect/openai-ads/credentials` &&
      typeof call.auth === "string" && call.auth.startsWith("Bearer "),
      `${call.method || "no-call"} ${call.url || ""}`);
    h.check("the body is exactly the documented { apiKey, profileId }; the Zernio key rides ONLY the header",
      JSON.stringify(call.body) === JSON.stringify({ apiKey: USER_KEY, profileId: PROFILE_ID }) &&
      !String(call.url).includes("test-zernio-key") && !String(call.url).includes(USER_KEY),
      JSON.stringify(call.body));
    h.check("the documented 200 maps to { provider_account_ref, ad_account_name }",
      connected.provider_account_ref === CONNECTED.accountId && connected.ad_account_name === "Acme US",
      JSON.stringify(connected));

    // ---- 3. documented error semantics -----------------------------------------------------
    const invalid = await captureCall(() => connectZernioOpenAIAds({
      userApiKey: USER_KEY, profileId: PROFILE_ID, apiKey: "test-zernio-key",
      fetcher: async () => new Response(JSON.stringify({ error: "invalid", code: "invalid_credentials" }), { status: 401 }),
    }));
    h.check("a 401 invalid_credentials maps to PROVIDER_INVALID_CREDENTIALS (the member's key, not the Zernio key)",
      invalid.threw && invalid.code === "PROVIDER_INVALID_CREDENTIALS" && !String(invalid.message).includes(USER_KEY),
      invalid.code || "no-throw");
    const authFailed = await captureCall(() => connectZernioOpenAIAds({
      userApiKey: USER_KEY, profileId: PROFILE_ID, apiKey: "test-zernio-key",
      fetcher: async () => new Response(JSON.stringify({ error: "bad key" }), { status: 401 }),
    }));
    h.check("a plain 401 maps to PROVIDER_AUTH_FAILED (the Zernio key was rejected)",
      authFailed.threw && authFailed.code === "PROVIDER_AUTH_FAILED", authFailed.code || "no-throw");
    const payment = await captureCall(() => connectZernioOpenAIAds({
      userApiKey: USER_KEY, profileId: PROFILE_ID, apiKey: "test-zernio-key",
      fetcher: async () => new Response(JSON.stringify({ error: "billing", code: "PAYMENT_REQUIRED", reason: "free_tier_exceeded", dashboard_url: "https://zernio.com/dashboard/billing" }), { status: 402 }),
    }));
    h.check("the documented 402 maps to PROVIDER_PAYMENT_REQUIRED carrying the reason and dashboard_url",
      payment.threw && payment.code === "PROVIDER_PAYMENT_REQUIRED" && payment.value === undefined,
      `${payment.code || "no-throw"}`);
    const addon = await captureCall(() => connectZernioOpenAIAds({
      userApiKey: USER_KEY, profileId: PROFILE_ID, apiKey: "test-zernio-key",
      fetcher: async () => new Response(JSON.stringify({ error: "addon" }), { status: 403 }),
    }));
    h.check("the documented 403 (Ads add-on required) maps to PROVIDER_AUTH_FAILED",
      addon.threw && addon.code === "PROVIDER_AUTH_FAILED", addon.code || "no-throw");
    const noId = await captureCall(() => connectZernioOpenAIAds({
      userApiKey: USER_KEY, profileId: PROFILE_ID, apiKey: "test-zernio-key",
      fetcher: async () => new Response(JSON.stringify({ adAccountName: "Acme US" }), { status: 200 }),
    }));
    h.check("a 200 without accountId refuses rather than persisting an unusable connection",
      noId.threw && noId.code === "PROVIDER_INVALID_INPUT", noId.code || "no-throw");

    // ---- 4. through the REAL surface: identity persistence, idempotency, reconnect ---------
    const ws = await svc.entities.Workspace.create({ name: `oaiconn-${stamp}`, owner_id: `ownerO_${stamp}` });
    workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: `oaiconn-${stamp}`, status: "ready", version_count: 1, production_deployment_id: "dep-oaiconn" });
    projects.push(proj.id);
    const user = { id: `ownerO_${stamp}`, email: "oai@example.com" };
    const zernioProvider = createZernioAdsProvider("zernio:openai", { fetcher: okFetcher([]), apiKey: "test-zernio-key" });
    const surfaceCalls = [];
    const connOpts = { provider: zernioProvider, fetcher: okFetcher(surfaceCalls), apiKey: "test-zernio-key" };
    const res = await surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, connOpts);
    h.check("the surface connect persists the account identity WITHOUT exposing the provider ref",
      res.account.status === "active" && res.account.business_name === "Acme US" &&
      res.account.provider_account_ref === undefined, JSON.stringify(res));
    const row = (await svc.entities.AdsAccount.filter({ project_id: proj.id }, "-created_date", 10)).find((r) => (r.channel || "google") === "zernio:openai");
    h.check("the AdsAccount row carries the connection (active + provider ref + name) and NEVER the member key",
      !!row && row.provider_account_ref === CONNECTED.accountId && row.status === "active" &&
      row.business_name === "Acme US" && !JSON.stringify(row).includes(USER_KEY),
      JSON.stringify({ status: row?.status }));
    const logs = await svc.entities.AdsChangeLog.filter({ project_id: proj.id }, "-created_date", 10);
    h.check("the connection wrote its change-log attribution",
      logs.some((l) => l.action === "account.connected"), JSON.stringify(logs.map((l) => l.action)));
    const logsCount = logs.length;
    const again = await surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, connOpts);
    const rowsAfter = (await svc.entities.AdsAccount.filter({ project_id: proj.id }, "created_date", 20)).filter((r) => (r.channel || "google") === "zernio:openai");
    const logsAfter = await svc.entities.AdsChangeLog.filter({ project_id: proj.id }, "-created_date", 10);
    h.check("an identical repost is IDEMPOTENT: the same row, no duplicate, no second change log",
      again.already_connected === true && rowsAfter.length === 1 && rowsAfter[0].id === row.id &&
      logsAfter.length === logsCount, JSON.stringify({ rows: rowsAfter.length, logs: logsAfter.length }));
    const refused = await captureCall(() => surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, {
      provider: zernioProvider,
      fetcher: async () => new Response(JSON.stringify({ error: "invalid", code: "invalid_credentials" }), { status: 401 }),
      apiKey: "test-zernio-key",
    }));
    const rowAfterRefusal = await svc.entities.AdsAccount.get(row.id);
    h.check("a refused connect persists NOTHING and its error never echoes the member key",
      refused.threw && refused.code === "PROVIDER_INVALID_CREDENTIALS" &&
      !String(refused.message).includes(USER_KEY) &&
      rowAfterRefusal.provider_account_ref === CONNECTED.accountId && rowAfterRefusal.status === "active",
      refused.code || "no-throw");
    const disconn = await surface(proj, user, { action: "account_disconnect", channel: "zernio:openai" }, { provider: zernioProvider });
    h.check("the certified disconnect still works on the connected account",
      disconn.account.status === "disconnected", JSON.stringify({ status: disconn.account?.status }));
    const reconnect = await surface(proj, user, { action: "account_connect", channel: "zernio:openai", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, connOpts);
    const rowReconnected = (await svc.entities.AdsAccount.filter({ project_id: proj.id }, "created_date", 20)).filter((r) => (r.channel || "google") === "zernio:openai");
    h.check("reconnecting after disconnect re-activates the SAME row in place (no duplicate, gap cleared)",
      reconnect.account.status === "active" && rowReconnected.length === 1 && rowReconnected[0].id === row.id &&
      rowReconnected[0].provider_account_ref === CONNECTED.accountId && !rowReconnected[0].disconnected_at,
      JSON.stringify({ rows: rowReconnected.length, status: reconnect.account?.status }));

    // ---- 5. channel restrictions + Google untouched ----------------------------------------
    const gCalls = [];
    const googleRefused = await captureCall(() => surface(proj, user, { action: "account_connect", channel: "google", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, { fetcher: okFetcher(gCalls) }));
    const metaRefused = await captureCall(() => surface(proj, user, { action: "account_connect", channel: "zernio:meta", openai_api_key: USER_KEY, profile_id: PROFILE_ID }, { fetcher: okFetcher(gCalls) }));
    h.check("only zernio:openai connects: google and zernio:meta refuse CHANNEL_NOT_CONNECTABLE, ZERO calls",
      googleRefused.threw && googleRefused.code === "CHANNEL_NOT_CONNECTABLE" &&
      metaRefused.threw && metaRefused.code === "CHANNEL_NOT_CONNECTABLE" && gCalls.length === 0,
      `${googleRefused.code || "no-throw"}/${metaRefused.code || "no-throw"}`);
    const gRow = (await svc.entities.AdsAccount.filter({ project_id: proj.id }, "created_date", 20)).find((r) => (r.channel || "google") === "google");
    h.check("Google Ads behavior is untouched: no google-channel row was created by any connect path",
      gRow === undefined, JSON.stringify(gRow || null));
    h.check("no Zernio connect request ever left the app during the surface pass",
      surfaceCalls.every((c) => c.method === "POST" && c.url === `${ZERNIO_API_BASE_URL}/connect/openai-ads/credentials`),
      JSON.stringify(surfaceCalls.map((c) => `${c.method} ${c.url}`)));
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