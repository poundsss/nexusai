// P-9.9 — App User Connectors for DEPLOYED applications.
//
// Base44 semantics (verified docs): each signed-in app user connects their OWN third-party
// account; connectAppUser returns a redirect URL, disconnectAppUser removes the stored token
// for the current user, and backend code resolves the CURRENT user's token. The connector's
// OAuth application is registered once by the workspace (here: the project's own connector
// document + ProjectSecret) — the AUTHORIZATION is per app user.
//
// THE SECURITY GAP THIS MODULE CLOSES: the provider configuration is built ONLY from the
// project's server-side connector declarations (the artifact's payload.connectors, or
// ProjectFile rows through loadProjectConnectors) — never from a request. A client names a
// connector by its id; secret NAMES come from the connector document and secret VALUES stay
// in ProjectSecret, resolved server-side at exchange/refresh time only.
//
// Reuses the EXISTING machinery end-to-end, no second system:
//   • flow ......... shared/delegatedOAuth.ts (#31G): single-use state, PKCE S256,
//                    AAD-encrypted tokens, ownership checks, refresh rotation, revoke
//   • registry ..... the connector RESOURCE contract (connectorResource/integrations.ts),
//                    extended with the normalized `delegated_oauth` block
//   • entitlement .. Builder+ (Base44: "App user connectors require a Builder plan or
//                    higher"), enforced server-side on every entry into the flow
//   • limits ....... the EXISTING durable limiter (apiLimits action "delegated_oauth")
//   • audit ........ the EXISTING recordAuthEvent path used by the delegated OAuth core
import { fail, limit } from "./appAuth.ts";
import { effectivePlan } from "./planLimits.ts";
import { unpackFileContent } from "./blobStore.ts";
import {
  beginDelegatedOAuth, completeDelegatedOAuth, revokeDelegatedCredential, listDelegatedCredentials,
} from "./delegatedOAuth.ts";
import { isConnectorFilePath, parseConnectorDocument } from "./connectorResource.ts";

// Builder+ entitlement — the same tier boundary Base44 publishes for app user connectors.
export const APP_CONNECTORS_MIN_TIER_RANK = 6;
export const planAllowsAppConnectors = (plan) => (plan?.tier_rank || 0) >= APP_CONNECTORS_MIN_TIER_RANK;

export const APP_CONNECTOR_OPS = ["connect", "disconnect", "connections"];

/**
 * The delegated OAuth provider config for shared/delegatedOAuth.ts, derived ONLY from a
 * connector's own server-side declaration. A connector without a delegated_oauth block is
 * not a delegated provider at all — fail-closed.
 */
export function delegatedProviderFromConnector(connector) {
  const block = connector?.delegated_oauth;
  if (!block || typeof block !== "object") {
    fail(404, "OAUTH_PROVIDER_NOT_CONFIGURED", `Connector "${connector?.name || ""}" does not declare a delegated OAuth flow`);
  }
  return {
    authorization_endpoint: block.authorization_endpoint,
    token_endpoint: block.token_endpoint,
    ...(block.revoke_endpoint ? { revoke_endpoint: block.revoke_endpoint } : {}),
    client_id_secret: block.client_id_secret,
    ...(block.client_secret_secret ? { client_secret_secret: block.client_secret_secret } : {}),
    scopes: Array.isArray(block.scopes) ? block.scopes : [],
    pkce: block.pkce !== false,
  };
}

/** The server-side registry: one provider entry per connector that declares delegated OAuth. */
export function buildDelegatedProviders(connectors) {
  const providers = {};
  for (const c of connectors || []) {
    if (c && c.name && c.delegated_oauth && typeof c.delegated_oauth === "object") {
      providers[c.name] = delegatedProviderFromConnector(c);
    }
  }
  return providers;
}

/**
 * Every connector a project declares, parsed from its ProjectFile rows through the SAME
 * connector resource contract the build and the artifact use. Malformed documents are
 * skipped — the build reports them; the registry is fail-closed, never permissive.
 */
export async function loadProjectConnectors(client, projectId) {
  const rows = await client.entities.ProjectFile.filter({ project_id: projectId }, "path", 500).catch(() => []);
  const out = [];
  for (const r of rows) {
    if (!isConnectorFilePath(r.path)) continue;
    let parsed;
    try { parsed = parseConnectorDocument(r.path, await unpackFileContent(r)); } catch { continue; }
    if (parsed.ok) out.push(parsed.connector);
  }
  return out;
}

/**
 * Minimal HTTP client for OAuth token / revoke endpoints: { ok, status, headers, body } with
 * the body parsed as JSON when the content type allows — the shape delegatedOAuth.ts expects.
 * Shared by the deployed runtime and the delegatedOAuth endpoint so there is ONE transport.
 */
export async function oauthExchangeHttp(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    body = options.body;
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(String(url), { method, headers, body });
  const text = await res.text();
  let parsed = text;
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) { try { parsed = JSON.parse(text); } catch { /* keep text */ } }
  return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed };
}

/**
 * The deployed-app connector operations (appRuntime action "connectors"): connect / disconnect
 * / connections. `connectors` is the artifact's OWN connector list; `user` is the verified
 * session's AppUser row; `callback_url` is derived by the caller from the request origin —
 * none of the three is ever client-asserted.
 *
 * Entitlement: connect is Builder+ (Base44: "Builder plan or higher"), enforced HERE. disconnect
 * and connections are deliberately NOT gated — a user must always be able to see and remove
 * their own credential, whatever the plan.
 */
export async function handleAppConnectors(svc, { project, connectors, user, op, args = {}, meta = {}, resolveSecret, http, callback_url } = {}) {
  const operation = String(op || "");
  if (!APP_CONNECTOR_OPS.includes(operation)) {
    fail(400, "CONNECTORS_BAD_OPERATION", `Unsupported connectors operation '${operation}' (${APP_CONNECTOR_OPS.join(", ")})`);
  }
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in required");

  const name = String(args.connector || "");
  const connector = (connectors || []).find((c) => c && c.name === name) || null;
  if (operation !== "connections" && !connector) {
    fail(404, "CONNECTOR_NOT_FOUND", `Connector "${name}" is not part of this deployment`);
  }

  if (operation === "connections") {
    const list = await listDelegatedCredentials(svc, project, user, { provider_id: name || null });
    return { connections: list };
  }

  if (operation === "connect") {
    const { plan } = await effectivePlan(svc, project.workspace_id || null);
    if (!planAllowsAppConnectors(plan)) fail(403, "PLAN_NOT_ENTITLED", "App user connectors require the Builder plan or higher");
    await limit(svc, project, "delegated_oauth", `user:${user.id}`);
    const begun = await beginDelegatedOAuth(svc, project, user, {
      provider_id: connector.name,
      // The redirect target is the app's OWN callback route (the same one P-9.8 social
      // sign-in uses), derived server-side from the addressing the caller used.
      redirect_uri: callback_url ? `${callback_url}${callback_url.includes("?") ? "&" : "?"}connector=${encodeURIComponent(connector.name)}` : null,
      providers: buildDelegatedProviders(connectors),
    }, { resolveSecret }, meta);
    return { connector: connector.name, authorization_url: begun.authorization_url, expires_in_ms: begun.expires_in_ms, pkce: !!begun.pkce };
  }

  // disconnect: revoke every active credential the CURRENT user holds for this connector.
  const active = (await listDelegatedCredentials(svc, project, user, { provider_id: connector.name })).filter((c) => c.status !== "revoked");
  if (!active.length) return { connector: connector.name, revoked: 0 };
  const providers = buildDelegatedProviders(connectors);
  for (const c of active) {
    await revokeDelegatedCredential(svc, project, user, c.credential_id, { providers, resolveSecret, http }, meta);
  }
  return { connector: connector.name, revoked: active.length };
}

/**
 * Callback completion for the deployed-app connector flow (appRuntime auth op "oauth_callback"
 * with a connector state). The provider_id is taken from the SERVER-issued state row, never
 * from the request; the registry is the artifact's; ownership is re-validated by the core.
 * Returns metadata only — no token, ciphertext or secret ever reaches the browser.
 */
export async function completeAppConnectorCallback(svc, { project, connectors, user, state, code, meta = {}, resolveSecret, http } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const { plan } = await effectivePlan(svc, project.workspace_id || null);
  if (!planAllowsAppConnectors(plan)) fail(403, "PLAN_NOT_ENTITLED", "App user connectors require the Builder plan or higher");
  await limit(svc, project, "delegated_oauth", `user:${user.id}`);
  const completed = await completeDelegatedOAuth(svc, project, user, { state, code, providers: buildDelegatedProviders(connectors) }, { resolveSecret, http }, meta);
  return {
    connector: completed.provider_id, credential_id: completed.credential_id, status: completed.status,
    external_email: completed.external_email || null, scopes: completed.scopes,
  };
}