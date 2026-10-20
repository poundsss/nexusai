// P-9.9 certification — App User Connectors for deployed applications.
//
// Runs against the REAL shipping modules (appConnectors / delegatedOAuth / connectorResource /
// integrations / secretCrypto) and the REAL delegatedOAuth ENDPOINT HANDLER
// (shared/delegatedOAuthApi, invoked with a synthetic Request carrying this request's own
// identity), in throwaway workspaces with two projects and both plan tiers. The OAuth
// provider's token endpoint and the ATTACKER's endpoints are scripted; every other byte is
// the real server-side contract.
//
// The suite proves, in order:
//   • the registry is server-side (project's own connector document) and fail-closed
//   • the Builder+ entitlement gate (Free denied, Builder+ allowed) — Base44 parity
//   • the closed P-9.9 SECURITY GAP: a client-supplied provider config (endpoints, secret
//     NAMES) can no longer influence the flow or exfiltrate ProjectSecret values
//   • connect → authorization URL → callback → encrypted DelegatedCredential
//   • user isolation, project isolation, replay protection, refresh rotation, disconnect
//   • redaction: no token, ciphertext, client secret or victim secret in any row or response
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createPasswordlessUser, createSession, limit } from "../../shared/appAuth.ts";
import {
  buildDelegatedProviders, delegatedProviderFromConnector, handleAppConnectors,
  completeAppConnectorCallback, loadProjectConnectors, oauthExchangeHttp, planAllowsAppConnectors,
} from "../../shared/appConnectors.ts";
import { refreshDelegatedCredential, statusDelegatedCredential } from "../../shared/delegatedOAuth.ts";
import { handleDelegatedOAuth, builderBaseUrl } from "../../shared/delegatedOAuthApi.ts";
import { encryptSecretValue } from "../../shared/secretCrypto.ts";
import { connectorFilePath } from "../../shared/connectorResource.ts";
import { packFileContent } from "../../shared/blobStore.ts";
import { effectivePlan } from "../../shared/planLimits.ts";
import { DEFAULT_PLANS } from "../../shared/billing.ts";

const TOKEN_HOST = "oauth.example.test";
const ATTACK_HOST = "evil.example.test";
const APP_ORIGIN = "https://runtime.example.com";
const CLIENT_ID = "p99_client_id";
const CLIENT_SECRET = "p99_client_secret_never_leak";
const VICTIM_NAME = "VICTIM_SECRET";
const VICTIM_VALUE = "p99_victim_secret_value_never_leak";
const ACCESS_TOKEN = "at_p99_abc123neverleak";
const REFRESH_TOKEN = "rt_p99_xyz789neverleak";
const ROTATED_ACCESS = "at_p99_rotated_bb22";

const oauthStubJson = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const h = createHarness();
  const realFetch = globalThis.fetch;
  let wsA = null, wsB = null;
  let projectA = null, projectB = null, projectA2 = null;
  let planCode = null;
  let testDomain = null;
  let attackerHits = 0;
  const tokenForms = [];

  // Script the OAuth provider's token endpoint and count every contact with the ATTACKER's
  // hosts — an exfiltration attempt is proven from the actual outbound traffic, not assumed.
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname === ATTACK_HOST) { attackerHits++; return oauthStubJson({ ok: true }); }
    if (u.hostname === TOKEN_HOST && u.pathname === "/token") {
      tokenForms.push(String(options.body || ""));
      const form = new URLSearchParams(String(options.body || ""));
      if (form.get("grant_type") === "refresh_token") {
        return oauthStubJson({ access_token: ROTATED_ACCESS, refresh_token: "rt_p99_rotated_qq11", expires_in: 3600, scope: "read write" });
      }
      return oauthStubJson({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, scope: "read write", sub: form.get("code") === "p99-b" ? "p99-builder-sub" : "p99-ext-sub", email: "ext@p99.test", profile: { name: "Ext User" } });
    }
    return realFetch(url, options);
  };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    // --- fixtures: Builder+ workspace (wsA) and Free workspace (wsB) ---
    wsA = await svc.entities.Workspace.create({ name: `P99 Builder ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    wsB = await svc.entities.Workspace.create({ name: `P99 Free ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    planCode = `bldr_p99_${crypto.randomUUID().slice(0, 8)}`;
    await svc.entities.BillingPlan.create({ code: planCode, name: "P-9.9 Builder cert", tier_rank: 7, active: true, price_cents: 5000, interval: "monthly" });
    await svc.entities.Subscription.create({ workspace_id: wsA.id, plan_code: planCode, status: "active" });
    projectA = await svc.entities.Project.create({ workspace_id: wsA.id, name: "P99 App A", slug: `pa-${Date.now()}` });
    projectB = await svc.entities.Project.create({ workspace_id: wsB.id, name: "P99 App B", slug: `pb-${Date.now()}` });

    const userA1 = await createPasswordlessUser(svc, projectA, { email: "a1@p99.test", display_name: "User A1", email_verified: true });
    const userA2 = await createPasswordlessUser(svc, projectA, { email: "a2@p99.test", display_name: "User A2", email_verified: true });
    const userB1 = await createPasswordlessUser(svc, projectB, { email: "b1@p99.test", display_name: "User B1", email_verified: true });
    // A second project in the SAME Builder+ workspace: same entitlement, different project id —
    // isolates the cross-project state check from the plan gate.
    projectA2 = await svc.entities.Project.create({ workspace_id: wsA.id, name: "P99 App A2", slug: `pa2-${Date.now()}` });
    // Server-verifiable trusted origin: an ACTIVE (DNS-verified) custom domain of project A.
    testDomain = await svc.entities.CustomDomain.create({ project_id: projectA.id, workspace_id: wsA.id, hostname: new URL(APP_ORIGIN).hostname, environment: "production", status: "active" });

    // The project's own connector declaration (server-side registry source) + its secrets.
    const connectorDoc = JSON.stringify({
      name: "extconn",
      type: "http",
      description: "P-9.9 delegated connector",
      base_url: "https://api.example.test/v1",
      auth: { type: "none" },
      operations: [{ name: "ping", method: "GET", path: "/me" }],
      delegated_oauth: {
        authorization_endpoint: `https://${TOKEN_HOST}/authorize`,
        token_endpoint: `https://${TOKEN_HOST}/token`,
        revoke_endpoint: `https://${TOKEN_HOST}/revoke`,
        client_id_secret: "EXTCONN_CLIENT_ID",
        client_secret_secret: "EXTCONN_CLIENT_SECRET",
        scopes: ["read", "write"],
        pkce: true,
      },
    }, null, 2);
    const stored = await packFileContent(svc, connectorFilePath("extconn"), connectorDoc);
    await svc.entities.ProjectFile.create({ project_id: projectA.id, path: connectorFilePath("extconn"), ...stored, frozen: false });

    const setSecret = async (project, name, value) => {
      const sealed = await encryptSecretValue(project.id, name, value);
      const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name }, "name", 1).catch(() => []);
      if (rows[0]) await svc.entities.ProjectSecret.update(rows[0].id, { value: sealed });
      else await svc.entities.ProjectSecret.create({ project_id: project.id, name, value: sealed, description: "p99", required: true, access: "backend_only" });
    };
    await setSecret(projectA, "EXTCONN_CLIENT_ID", CLIENT_ID);
    await setSecret(projectA, "EXTCONN_CLIENT_SECRET", CLIENT_SECRET);
    await setSecret(projectA, VICTIM_NAME, VICTIM_VALUE);
    const resolverFor = (project) => async (name) => {
      const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
      const row = rows[0];
      if (!row || !row.value) return undefined;
      const { decryptSecretValue } = await import("../../shared/secretCrypto.ts");
      try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
    };
    const resolveA = resolverFor(projectA);

    // The deployed-app sessions for the endpoint-level security checks.
    const { token: sessionA1 } = await createSession(svc, projectA, userA1, { ip: "203.0.113.7" });
    const { token: sessionB1 } = await createSession(svc, projectB, userB1, { ip: "203.0.113.8" });
    const meta = { ip: "203.0.113.7", user_agent: "p99/1.0" };
    const callback_url = "https://runtime.example.com/app/pa/oauth/callback";

    // Invoke the REAL delegatedOAuth endpoint handler in-process, carrying this request's own
    // identity — exactly what an HTTP caller would present, no parallel copy of the contract.
    const callEndpoint = async (payload, extraHeaders = {}) => {
      const headers = { "content-type": "application/json" };
      for (const [k, v] of (req.headers || new Headers())) {
        if (!["content-type", "content-length", "host", "origin", "referer"].includes(k.toLowerCase())) headers[k] = v;
      }
      Object.assign(headers, extraHeaders);
      const res = await handleDelegatedOAuth(new Request("https://runtime.internal/functions/delegatedOAuth", { method: "POST", headers, body: JSON.stringify(payload) }));
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    // A fully attacker-controlled provider config, the way the old client-controlled surface
    // accepted it: attacker endpoints + a victim secret NAME for both client fields.
    const evilConfig = {
      authorization_endpoint: `https://${ATTACK_HOST}/authorize`,
      token_endpoint: `https://${ATTACK_HOST}/token`,
      revoke_endpoint: `https://${ATTACK_HOST}/revoke`,
      client_id_secret: VICTIM_NAME,
      client_secret_secret: VICTIM_NAME,
      scopes: ["read"],
      pkce: false,
    };

    // --- 1. Server-side registry, fail-closed ---
    const loaded = await loadProjectConnectors(svc, projectA.id);
    h.check("1a. connector document loaded server-side", loaded.length === 1 && loaded[0].name === "extconn" && !!loaded[0].delegated_oauth, loaded.map((c) => c.name).join(","));
    const cfg = delegatedProviderFromConnector(loaded[0]);
    h.check("1b. provider config comes only from the declaration", cfg.authorization_endpoint === `https://${TOKEN_HOST}/authorize` && cfg.token_endpoint === `https://${TOKEN_HOST}/token` && cfg.client_id_secret === "EXTCONN_CLIENT_ID" && cfg.client_secret_secret === "EXTCONN_CLIENT_SECRET" && cfg.pkce === true, JSON.stringify(cfg));
    const registry = buildDelegatedProviders(loaded);
    h.check("1c. a connector without delegated_oauth is not a provider", Object.keys(registry).length === 1 && Object.keys(buildDelegatedProviders([{ name: "plain", type: "http", delegated_oauth: null }])).length === 0, Object.keys(registry).join(","));

    // --- 2. Builder+ entitlement (Base44: "Builder plan or higher") ---
    h.check("2a. entitlement matrix on the plan ladder", planAllowsAppConnectors(DEFAULT_PLANS.find((p) => p.code === "free")) === false && planAllowsAppConnectors(DEFAULT_PLANS.find((p) => p.code === "starter_monthly")) === false && planAllowsAppConnectors(DEFAULT_PLANS.find((p) => p.code === "builder_monthly")) === true, "free/starter denied, builder+ allowed");
    const freePlan = (await effectivePlan(svc, wsB.id)).plan;
    const builderPlan = (await effectivePlan(svc, wsA.id)).plan;
    h.check("2b. free workspace resolves to a non-entitled plan", planAllowsAppConnectors(freePlan) === false, freePlan?.code || "?");
    h.check("2c. builder workspace resolves to an entitled plan", planAllowsAppConnectors(builderPlan) === true, builderPlan?.code || "?");
    await h.expectThrow("2d. free plan connect is DENIED", () => handleAppConnectors(svc, { project: projectB, connectors: loaded, user: userA1, op: "connect", args: { connector: "extconn" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url }), "PLAN_NOT_ENTITLED");

    // --- 3. Unknown connector, anonymous, unconfigured: fail-closed ---
    await h.expectThrow("3a. unknown connector is DENIED", () => handleAppConnectors(svc, { project: projectA, connectors: loaded, user: userA1, op: "connect", args: { connector: "ghost" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url }), "CONNECTOR_NOT_FOUND");
    await h.expectThrow("3b. anonymous connect is DENIED", () => handleAppConnectors(svc, { project: projectA, connectors: loaded, user: null, op: "connect", args: { connector: "extconn" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url }), "AUTH_REQUIRED");
    await h.expectThrow("3c. a connector without delegated_oauth fails closed", () => handleAppConnectors(svc, { project: projectA, connectors: [{ name: "plain", type: "http", operations: [] }], user: userA1, op: "connect", args: { connector: "plain" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url }), "OAUTH_PROVIDER_NOT_CONFIGURED");

    // --- 4. connect → authorization URL (server registry, PKCE, own callback route) ---
    const connected = await handleAppConnectors(svc, { project: projectA, connectors: loaded, user: userA1, op: "connect", args: { connector: "extconn" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url });
    const connectUrl = new URL(connected.authorization_url);
    h.check("4a. connect returns the provider authorization URL", connected.connector === "extconn" && connectUrl.hostname === TOKEN_HOST && !!connectUrl.searchParams.get("state"), (connected.authorization_url || "").slice(0, 80));
    h.check("4b. PKCE S256 with the server-declared client id", connectUrl.searchParams.get("code_challenge_method") === "S256" && !!connectUrl.searchParams.get("code_challenge") && connectUrl.searchParams.get("client_id") === CLIENT_ID, connectUrl.search.slice(0, 120));
    h.check("4c. the redirect target is the app's own callback route", (connectUrl.searchParams.get("redirect_uri") || "").includes("/oauth/callback") && decodeURIComponent(connectUrl.searchParams.get("redirect_uri") || "").includes("connector=extconn"), connectUrl.searchParams.get("redirect_uri"));

    // --- 5. THE CLOSED SECURITY GAP: client provider-config injection → DENIED ---
    attackerHits = 0;
    const injected = await callEndpoint({ action: "begin", project_id: projectA.id, session_token: sessionA1, provider_id: "extconn", providers: { extconn: evilConfig } });
    const injectedUrl = injected.body?.authorization_url ? new URL(injected.body.authorization_url) : null;
    h.check("5a. injected provider config is IGNORED (server registry wins)", injected.status === 200 && injectedUrl?.hostname === TOKEN_HOST && !(injected.body?.authorization_url || "").includes(ATTACK_HOST), JSON.stringify(injected.body).slice(0, 140));
    const statesBefore = await svc.entities.AppAuthToken.count({ project_id: projectA.id, kind: "delegated_oauth_state" });
    const evilRedirect = await callEndpoint({ action: "begin", project_id: projectA.id, session_token: sessionA1, provider_id: "extconn", providers: { extconn: evilConfig }, redirect_uri: `https://${ATTACK_HOST}/cb` }, { origin: APP_ORIGIN });
    const evilSamePath = await callEndpoint({ action: "begin", project_id: projectA.id, session_token: sessionA1, provider_id: "extconn", redirect_uri: `https://${ATTACK_HOST}/oauth/callback` }, { origin: APP_ORIGIN });
    const evilOrigin = await callEndpoint({ action: "begin", project_id: projectA.id, session_token: sessionA1, provider_id: "extconn", redirect_uri: `https://${ATTACK_HOST}/oauth/callback` }, { origin: `https://${ATTACK_HOST}` });
    const evilPath = await callEndpoint({ action: "begin", project_id: projectA.id, session_token: sessionA1, provider_id: "extconn", redirect_uri: `${APP_ORIGIN}/elsewhere` }, { origin: APP_ORIGIN });
    const statesAfter = await svc.entities.AppAuthToken.count({ project_id: projectA.id, kind: "delegated_oauth_state" });
    // Builder-shell style: an origin with no verified domain on the project (projectA2 has none) — even its own app callback path.
    const refused = [evilRedirect, evilSamePath, evilOrigin, evilPath];
    // 5a5: the builder-shell branch (no app session; the caller's own platform identity). The
    // positive control proves session + authorization PASS on the same branch, so the refusal
    // below is the redirect contract alone — even with forged Origin/Referer/X-Forwarded-Host
    // naming the project's verified domain and a well-formed callback in the body.
    const forged = { origin: APP_ORIGIN, referer: `${APP_ORIGIN}/meetings`, "x-forwarded-host": new URL(APP_ORIGIN).hostname };
    const builderAuthOk = await callEndpoint({ action: "list", project_id: projectA.id });
    const builderStatesBefore = await svc.entities.AppAuthToken.count({ project_id: projectA.id, kind: "delegated_oauth_state" });
    const builderBase = builderBaseUrl(process.env.BUILDER_PUBLIC_BASE_URL);
    const expectedBuilderCb = `${builderBase}/oauth/callback?connector=extconn&project_id=${encodeURIComponent(projectA.id)}`;
    // Forged headers + a foreign body redirect: both must be ignored in favour of the configured callback.
    const builderBegin = await callEndpoint({ action: "begin", project_id: projectA.id, provider_id: "extconn", redirect_uri: `https://${ATTACK_HOST}/oauth/callback` }, { ...forged, origin: `https://${ATTACK_HOST}`, "x-forwarded-host": ATTACK_HOST });
    const builderStatesAfter = await svc.entities.AppAuthToken.count({ project_id: projectA.id, kind: "delegated_oauth_state" });
    const builderCb = builderBegin.body?.authorization_url ? new URL(builderBegin.body.authorization_url).searchParams.get("redirect_uri") : null;
    h.check("5a5. builder-shell begin uses ONLY the configured callback (forged headers + foreign body redirect ignored), state minted", !!builderBase && builderAuthOk.status === 200 && builderBegin.status === 200 && builderCb === expectedBuilderCb && !String(builderBegin.body?.authorization_url || "").includes(encodeURIComponent(ATTACK_HOST)) && builderStatesAfter === builderStatesBefore + 1, `base=${builderBase} begin=${builderBegin.status} cb=${builderCb} states=${builderStatesBefore}->${builderStatesAfter}`);
    const builderForeign = await callEndpoint({ action: "callback", project_id: projectA.id, state: builderBegin.body?.state, code: "p99-b", redirect_uri: `https://${ATTACK_HOST}/oauth/callback` });
    h.check("5a6. builder-shell callback ignores a client redirect and exchanges with the state-bound one", builderForeign.status === 200 && !!builderForeign.body?.credential_id && attackerHits === 0, `${builderForeign.status}:${builderForeign.body?.code || ""}`);
    const bad = ["http://x.test", "https://x.test/path", "https://u:p@x.test", "https://x.test/#f", "https://x.test/?q=1", "", "not a url"];
    h.check("5a7. invalid BUILDER_PUBLIC_BASE_URL values fail closed", bad.every((v) => builderBaseUrl(v) === null) && builderBaseUrl("https://x.test") === "https://x.test" && builderBaseUrl("https://x.test/") === "https://x.test", bad.map((v) => String(builderBaseUrl(v))).join(","));
    h.check("5a2. untrusted redirect_uri REJECTED before any state or URL (attacker host, foreign path, spoofed origin)", refused.every((r) => r.status === 400 && r.body?.code === "OAUTH_REDIRECT_INVALID" && !r.body?.authorization_url) && statesAfter === statesBefore, refused.map((r) => `${r.status}:${r.body?.code}`).join(","));
    const legitRedirect = `${APP_ORIGIN}/app/${projectA.slug}/oauth/callback?connector=extconn`;
    const legit = await callEndpoint({ action: "begin", project_id: projectA.id, session_token: sessionA1, provider_id: "extconn", redirect_uri: legitRedirect }, { origin: APP_ORIGIN });
    const legitUrl = legit.body?.authorization_url ? new URL(legit.body.authorization_url) : null;
    h.check("5a3. the registered callback on a verified project domain is accepted", legit.status === 200 && legitUrl?.searchParams.get("redirect_uri") === legitRedirect, `${legit.status}`);
    const mismatch = await callEndpoint({ action: "callback", project_id: projectA.id, session_token: sessionA1, state: legit.body?.state, code: "p99-code", redirect_uri: `https://${ATTACK_HOST}/oauth/callback` });
    h.check("5a4. a callback redirect differing from the state-bound one is REFUSED", mismatch.status === 400 && mismatch.body?.code === "OAUTH_STATE_MISMATCH", `${mismatch.status}:${mismatch.body?.code}`);
    h.check("5b. no outbound contact with the attacker", attackerHits === 0, `attacker hits: ${attackerHits}`);
    const ghost = await callEndpoint({ action: "begin", project_id: projectA.id, session_token: sessionA1, provider_id: "ghost", providers: { ghost: evilConfig } });
    h.check("5c. an unknown provider cannot be minted by injected config", ghost.status === 404 && ghost.body?.code === "OAUTH_PROVIDER_NOT_CONFIGURED" && attackerHits === 0, JSON.stringify(ghost.body));
    const freeEntry = await callEndpoint({ action: "begin", project_id: projectB.id, session_token: sessionB1, provider_id: "extconn", providers: { extconn: evilConfig } });
    h.check("5d. the endpoint enforces Builder+ too (Free project DENIED)", freeEntry.status === 403 && freeEntry.body?.code === "PLAN_NOT_ENTITLED", JSON.stringify(freeEntry.body).slice(0, 120));

    // --- 6. ProjectSecret exfiltration attempt → DENIED ---
    attackerHits = 0;
    tokenForms.length = 0;
    const begun = await callEndpoint({ action: "begin", project_id: projectA.id, session_token: sessionA1, provider_id: "extconn" });
    const exfil = await callEndpoint({
      action: "callback", project_id: projectA.id, session_token: sessionA1,
      state: begun.body?.state, code: "p99-code",
      providers: { extconn: { ...evilConfig, client_secret_secret: VICTIM_NAME, client_id_secret: VICTIM_NAME } },
    });
    const lastTokenForm = tokenForms[tokenForms.length - 1] || "";
    h.check("6a. the exchange went to the SERVER-declared token endpoint", exfil.status === 200 && !!exfil.body?.credential_id && attackerHits === 0, JSON.stringify(exfil.body).slice(0, 140));
    h.check("6b. the client secret used was the connector's own — never the victim secret", lastTokenForm.includes(CLIENT_SECRET) && !lastTokenForm.includes(VICTIM_VALUE), lastTokenForm.slice(0, 120));
    h.check("6c. no secret value in any response", !JSON.stringify([injected.body, ghost.body, exfil.body]).includes(CLIENT_SECRET) && !JSON.stringify([injected.body, ghost.body, exfil.body]).includes(VICTIM_VALUE), "values redacted");

    // --- 7. Callback → encrypted DelegatedCredential, ownership ---
    const savedCred = (await svc.entities.DelegatedCredential.filter({ project_id: projectA.id, credential_id: exfil.body.credential_id }, "-created_date", 1))[0];
    h.check("7a. the credential is stored encrypted", !!savedCred?.encrypted_access_token && !savedCred.encrypted_access_token.includes(ACCESS_TOKEN) && !!savedCred.encrypted_refresh_token && !savedCred.encrypted_refresh_token.includes(REFRESH_TOKEN), savedCred?.encrypted_access_token?.slice(0, 16));
    h.check("7b. ownership is stamped server-side (project + app user)", savedCred?.app_user_id === userA1.id && savedCred?.project_id === projectA.id, `${savedCred?.app_user_id} / ${savedCred?.project_id}`);

    // --- 8. Replay / state protection ---
    await h.expectThrow("8a. replaying a consumed connector state is DENIED", () => completeAppConnectorCallback(svc, { project: projectA, connectors: loaded, user: userA1, state: begun.body.state, code: "p99-code-2", meta, resolveSecret: resolveA, http: oauthExchangeHttp }), "OAUTH_STATE_USED");
    const crossConnect = await handleAppConnectors(svc, { project: projectA, connectors: loaded, user: userA1, op: "connect", args: { connector: "extconn" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url });
    const crossState = new URL(crossConnect.authorization_url).searchParams.get("state");
    await h.expectThrow("8b. a state from project A cannot complete in another project", () => completeAppConnectorCallback(svc, { project: projectA2, connectors: loaded, user: userA1, state: crossState, code: "x", meta, resolveSecret: resolveA, http: oauthExchangeHttp }), "OAUTH_STATE_INVALID");

    // --- 9. User isolation ---
    const mine = await handleAppConnectors(svc, { project: projectA, connectors: loaded, user: userA1, op: "connections", args: {}, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url });
    const theirs = await handleAppConnectors(svc, { project: projectA, connectors: loaded, user: userA2, op: "connections", args: {}, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url });
    h.check("9a. connections are scoped to the CURRENT app user", mine.connections?.length === 1 && mine.connections[0].credential_id === exfil.body.credential_id && theirs.connections?.length === 0, `mine=${mine.connections?.length} theirs=${theirs.connections?.length}`);
    h.check("9b. the connection projection carries metadata only", !JSON.stringify(mine.connections).includes("token") && !JSON.stringify(mine.connections).includes("encrypted_"), "no token fields");
    await h.expectThrow("9c. user A2 cannot read user A1's credential", () => statusDelegatedCredential(svc, projectA, userA2, exfil.body.credential_id), "OAUTH_CREDENTIAL_MISMATCH");

    // --- 10. Refresh + rotation ---
    await svc.entities.DelegatedCredential.update(savedCred.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const refreshed = await refreshDelegatedCredential(svc, projectA, userA1, exfil.body.credential_id, { resolveSecret: resolveA, http: oauthExchangeHttp }, meta);
    const savedRefreshed = (await svc.entities.DelegatedCredential.filter({ project_id: projectA.id, credential_id: exfil.body.credential_id }, "-created_date", 1))[0];
    h.check("10a. an expired credential refreshes and rotates", refreshed.status === "active" && refreshed.rotated === true && (savedRefreshed.refresh_rotation_count || 0) >= 1, JSON.stringify(refreshed));
    h.check("10b. the rotated token is stored encrypted", !!savedRefreshed.encrypted_access_token && !savedRefreshed.encrypted_access_token.includes(ROTATED_ACCESS), savedRefreshed.encrypted_access_token?.slice(0, 16));

    // --- 11. Disconnect / revoke ---
    const disconnected = await handleAppConnectors(svc, { project: projectA, connectors: loaded, user: userA1, op: "disconnect", args: { connector: "extconn" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url });
    const afterRow = (await svc.entities.DelegatedCredential.filter({ project_id: projectA.id, credential_id: exfil.body.credential_id }, "-created_date", 1))[0];
    h.check("11a. disconnect revokes the current user's credential", disconnected.revoked === 1 && afterRow?.status === "revoked", JSON.stringify(disconnected));
    const afterList = await handleAppConnectors(svc, { project: projectA, connectors: loaded, user: userA1, op: "connections", args: { connector: "extconn" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url });
    h.check("11b. a revoked credential is no longer offered", (afterList.connections || []).every((c) => c.status === "revoked"), JSON.stringify(afterList.connections?.map((c) => c.status)));
    await h.expectThrow("11c. disconnect on an unknown connector is DENIED", () => handleAppConnectors(svc, { project: projectA, connectors: loaded, user: userA1, op: "disconnect", args: { connector: "ghost" }, meta, resolveSecret: resolveA, http: oauthExchangeHttp, callback_url }), "CONNECTOR_NOT_FOUND");

    // --- 12. Redaction: nothing sensitive in any row ---
    const audits = await svc.entities.AuditLog.filter({ project_id: projectA.id }, "-created_date", 100).catch(() => []);
    const auditJson = JSON.stringify(audits);
    h.check("12a. no token or secret value in any audit row", !auditJson.includes(ACCESS_TOKEN) && !auditJson.includes(REFRESH_TOKEN) && !auditJson.includes(CLIENT_SECRET) && !auditJson.includes(VICTIM_VALUE), `found: ${auditJson.includes(CLIENT_SECRET) || auditJson.includes(VICTIM_VALUE)}`);

    // --- 13. Durable rate limit on the connect flow ---
    let blocked = null;
    for (let i = 0; i < 25; i++) {
      try { await limit(svc, projectA, "delegated_oauth", "user:p99-rl"); }
      catch (e) { blocked = e; break; }
    }
    h.check("13a. the connect flow is durably rate limited", blocked?.code === "RATE_LIMITED", blocked?.code || "no block within 25 attempts");
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    globalThis.fetch = realFetch;
    for (const p of [projectA, projectB, projectA2]) {
      if (!p) continue;
      for (const entity of ["ProjectFile", "ProjectSecret", "AuditLog", "AppAuthToken", "AppIdentity", "AppSession", "DelegatedCredential", "AppUser"]) {
        await purgeBy(svc, entity, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    if (planCode) {
      for (const r of await svc.entities.BillingPlan.filter({ code: planCode }, "code", 10).catch(() => [])) await svc.entities.BillingPlan.delete(r.id).catch(() => {});
    }
    for (const ws of [wsA, wsB]) {
      if (!ws) continue;
      for (const r of await svc.entities.Subscription.filter({ workspace_id: ws.id }, "-created_date", 10).catch(() => [])) await svc.entities.Subscription.delete(r.id).catch(() => {});
      for (const r of await svc.entities.RateLimitBucket.filter({ workspace_id: ws.id }, "-created_date", 500).catch(() => [])) await svc.entities.RateLimitBucket.delete(r.id).catch(() => {});
    }
    await cleanupWorkspace(svc, wsA ? wsA.id : null, []);
    await cleanupWorkspace(svc, wsB ? wsB.id : null, []);
    // Verify: every fixture this run created is gone.
    const projIds = [projectA, projectB, projectA2].filter(Boolean).map((p) => p.id);
    // Test-only: per-id lookups (no $in/count), and a failed lookup reports its error instead of -1.
    // Test-only: bounded retry (4 tries, 3s/6s/9s pauses) on rate-limit errors; any other or final error is thrown.
    const retry = async (fn) => {
      for (let i = 0; ; i++) {
        try { return await fn(); } catch (e) {
          if (i >= 3 || !/rate limit/i.test(String(e?.message || e))) throw e;
          await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
        }
      }
    };
    const deleteErrors = [];
    const del = (entity, id) => retry(() => svc.entities[entity].delete(id)).catch((e) => { deleteErrors.push(`${entity}:${id}:${String(e?.message || e).slice(0, 120)}`); });
    const rowsFor = async (entity, query) => {
      try { return await retry(() => svc.entities[entity].filter(query, "-created_date", 50)); } catch (e) { return { error: String(e?.message || e).slice(0, 80) }; }
    };
    const leftIn = async (entity, key, values) => {
      let n = 0;
      for (const v of values) { const r = await rowsFor(entity, { [key]: v }); if (!Array.isArray(r)) return r; n += r.length; }
      return n;
    };
    const domainLookups = [];
    for (const id of projIds) {
      const r = await rowsFor("CustomDomain", { project_id: id });
      domainLookups.push(Array.isArray(r) ? `${id}:rows=${r.length}${r.length ? `[${r.map((d) => d.id).join("|")}]` : ""}` : `${id}:error=${r.error}`);
      if (Array.isArray(r)) for (const d of r) await del("CustomDomain", d.id);
      else if (testDomain?.id && testDomain.project_id === id) {
        // Test-only fallback: lookup failed, delete the fixture by the id captured at creation.
        domainLookups.push(`${id}:fallback_delete=${testDomain.id}`);
        await del("CustomDomain", testDomain.id);
      }
    }
    if (planCode) {
      const r = await rowsFor("BillingPlan", { code: planCode });
      if (Array.isArray(r)) for (const p of r) await del("BillingPlan", p.id);
    }
    for (const ws of [wsA, wsB].filter(Boolean)) {
      const r = await rowsFor("Subscription", { workspace_id: ws.id });
      if (Array.isArray(r)) for (const s of r) await del("Subscription", s.id);
    }
    for (const id of projIds) {
      for (const entity of ["DelegatedCredential", "AppAuthToken"]) {
        const r = await rowsFor(entity, { project_id: id });
        if (Array.isArray(r)) for (const x of r) await del(entity, x.id);
      }
    }
    const wsIds = [wsA, wsB].filter(Boolean).map((w) => w.id);
    const left = {
      projects: (await Promise.all(projIds.map((id) => svc.entities.Project.get(id).catch(() => null)))).filter(Boolean).length,
      workspaces: (await Promise.all(wsIds.map((id) => svc.entities.Workspace.get(id).catch(() => null)))).filter(Boolean).length,
      credentials: await leftIn("DelegatedCredential", "project_id", projIds),
      domains: await leftIn("CustomDomain", "project_id", projIds),
      tokens: await leftIn("AppAuthToken", "project_id", projIds),
      plans: planCode ? await leftIn("BillingPlan", "code", [planCode]) : 0,
      subscriptions: await leftIn("Subscription", "workspace_id", wsIds),
    };
    h.check("cleanup verified (0 fixtures left)", Object.values(left).every((n) => n === 0) && deleteErrors.length === 0, JSON.stringify({ ...left, deleteErrors, domainLookups }));
  }

  return harnessResponse(h);
}