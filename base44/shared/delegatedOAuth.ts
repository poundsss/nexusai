// User-delegated OAuth 2.0 authorization_code flow for generated-app users (#31G).
//
// This is the provider-neutral delegated credential layer: an app user authorizes the app to call
// an external service ON THEIR BEHALF. The access and refresh tokens are persisted ENCRYPTED
// (AES-256-GCM, bound to project + credential_id) and selected explicitly by credential_id at
// connector call time — never silently substituted, never for another user.
//
// It reuses the EXISTING infrastructure and introduces no second system:
//   • State — a single-use AppAuthToken (kind "delegated_oauth_state"), consumed once, expiring,
//     bound to project + app_user + provider. Cross-project, cross-user and replay are rejected.
//   • PKCE — S256 code_challenge/verifier when the provider supports it.
//   • Tokens at rest — encryptWithAad / decryptWithAad from secretCrypto, AAD =
//     `delegated-credential:<project_id>:<credential_id>`, so a ciphertext moved to another
//     project or credential fails authentication and cannot be decrypted.
//   • Identity — the existing AppIdentity (#29), so a delegated credential is linked to the same
//     provider identity record sign-in OAuth uses. Duplicate and wrong-user linking are refused.
//   • Audit / trace — the EXISTING AuditLog and TraceEvent, through recordAuthEvent. No token,
//     verifier, auth code or client secret ever enters either.
//   • Connector execution — resolveDelegatedCredential decrypts the access token, refreshes it if
//     expired (rotating the refresh token), and hands it to the adapter's redactor. It validates
//     the credential belongs to the executing user before anything is decrypted.
import { encryptWithAad, decryptWithAad } from "./secretCrypto.ts";
import { recordAuthEvent } from "./appAuth.ts";
import { findIdentity } from "./appOAuth.ts";
import { sha256, randomHex, nowIso, fail, normalizeEmail } from "./appAuth.ts";
import { scrub, scrubText } from "./tracing.ts";
import { isTikTokOAuth, tikTokGrantedScopes, validateTikTokRedirect } from "./tiktokOAuth.ts";

export const DELEGATED_OAUTH_STATE_KIND = "delegated_oauth_state";
export const DELEGATED_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_SAFETY_MS = 30_000;
const MAX_PROFILE_KEYS = 20;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The PKCE (S256) helpers now live in shared/pkce.ts so the deployed-app sign-in flow (P-9.8)
// reuses the SAME implementation without a circular import. Imported AND re-exported here, so
// every existing importer keeps working and this module's behavior is unchanged.
import { generatePkceVerifier, pkceChallengeFromVerifier } from "./pkce.ts";
export { generatePkceVerifier, pkceChallengeFromVerifier };

export const newCredentialId = () => `dc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const aadFor = (projectId, credentialId) => `delegated-credential:${projectId}:${credentialId}`;

const providerConfig = (providers, provider_id) => {
  const cfg = providers && providers[String(provider_id || "")];
  if (!cfg || !cfg.token_endpoint || !cfg.authorization_endpoint) {
    fail(404, "OAUTH_PROVIDER_NOT_CONFIGURED", `Delegated OAuth provider "${provider_id}" is not configured for this application`);
  }
  return cfg;
};

const safeProfile = (profile) => {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const out = {};
  for (const [k, v] of Object.entries(profile).slice(0, MAX_PROFILE_KEYS)) {
    const key = String(k).slice(0, 60);
    out[key] = typeof v === "string" ? scrubText(v, 300) : (typeof v === "number" || typeof v === "boolean" || v === null) ? v : scrub(v);
  }
  return out;
};

const preview = (body) => { const t = typeof body === "string" ? body : JSON.stringify(body ?? null); return String(t).slice(0, 200); };

/**
 * Begin the authorization_code flow. Issues a single-use state bound to project + user + provider,
 * generates a PKCE verifier (S256) when the provider supports it, and returns the authorization URL
 * for the user's browser. The client_id is resolved server-side from its project secret.
 */
// The app's registered OAuth callback routes (src/App.jsx): the platform route, the deployed-app
// route under its slug, and the custom-domain route. A client-supplied redirect must be one of these.
const callbackPathsFor = (project) => ["/oauth/callback", "/~app/oauth/callback", ...(project?.slug ? [`/app/${project.slug}/oauth/callback`] : [])];

/**
 * Validate a CLIENT-SUPPLIED redirect_uri against the registered callback contract: https, no
 * userinfo/fragment, an origin the request itself came from (trusted_origins, derived server-side
 * from the browser's Origin/Referer), and one of the app's callback paths. Fails closed.
 */
export function assertTrustedRedirect(project, redirect_uri, trusted_origins = []) {
  if (!redirect_uri) return null;
  let url;
  try { url = new URL(String(redirect_uri)); } catch { fail(400, "OAUTH_REDIRECT_INVALID", "The redirect URI is not a valid URL"); }
  const ok = url.protocol === "https:" && !url.username && !url.password && !url.hash && url.href.length <= 500
    && trusted_origins.includes(url.origin) && callbackPathsFor(project).includes(url.pathname);
  if (!ok) fail(400, "OAUTH_REDIRECT_INVALID", "The redirect URI is not this application's registered OAuth callback");
  return url.toString();
}

export async function beginDelegatedOAuth(svc, project, user, { provider_id, redirect_uri, providers, trusted_origins } = {}, { resolveSecret } = {}, meta = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to connect an account");
  const cfg = providerConfig(providers, provider_id);
  // Client-supplied redirects (trusted_origins given) are validated BEFORE any state is minted.
  if (trusted_origins) redirect_uri = assertTrustedRedirect(project, redirect_uri, trusted_origins);
  if (isTikTokOAuth(cfg)) validateTikTokRedirect(redirect_uri);
  const verifier = generatePkceVerifier();
  const challenge = cfg.pkce ? await pkceChallengeFromVerifier(verifier) : null;
  const stateSecret = randomHex(32);
  await svc.entities.AppAuthToken.create({
    project_id: project.id, app_user_id: user.id, kind: DELEGATED_OAUTH_STATE_KIND,
    token_hash: await sha256(stateSecret), status: "pending",
    expires_at: new Date(Date.now() + DELEGATED_OAUTH_STATE_TTL_MS).toISOString(),
    // The verifier is a per-flow secret stored here server-side; it is never logged or returned.
    data: { provider_id: String(provider_id), redirect_uri: String(redirect_uri || "").slice(0, 500), pkce_verifier: verifier, pkce_challenge: challenge },
    created_at: nowIso(),
  });
  const clientId = await resolveSecret(cfg.client_id_secret);
  if (!clientId) fail(503, "OAUTH_CLIENT_NOT_CONFIGURED", `The OAuth client_id secret "${cfg.client_id_secret}" is not set for provider "${provider_id}"`);
  const url = new URL(String(cfg.authorization_endpoint));
  url.searchParams.set("response_type", "code");
  url.searchParams.set(isTikTokOAuth(cfg) ? "client_key" : "client_id", String(clientId));
  if (redirect_uri) url.searchParams.set("redirect_uri", String(redirect_uri));
  if (Array.isArray(cfg.scopes) && cfg.scopes.length) url.searchParams.set("scope", cfg.scopes.join(isTikTokOAuth(cfg) ? "," : " "));
  url.searchParams.set("state", stateSecret);
  if (challenge) { url.searchParams.set("code_challenge", challenge); url.searchParams.set("code_challenge_method", "S256"); }
  await recordAuthEvent(svc, project, { action: "delegated_oauth_begin", resource: "AppAuthToken", metadata: { app_user_id: user.id, provider_id: String(provider_id), pkce: !!challenge }, meta });
  return { provider_id: String(provider_id), state: stateSecret, authorization_url: url.toString(), expires_in_ms: DELEGATED_OAUTH_STATE_TTL_MS, pkce: !!challenge };
}

/**
 * Consume the state exactly once, validate it is bound to THIS project + THIS user + THIS provider,
 * exchange the authorization code server-side, and persist the encrypted tokens. The credential is
 * linked to the app user through the existing AppIdentity, refusing duplicate and wrong-user links.
 */
export async function completeDelegatedOAuth(svc, project, user, { state, code, providers, redirect_uri } = {}, { resolveSecret, http } = {}, meta = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to connect an account");
  // Single-use, expiring, cross-project-safe consumption through the existing token system.
  const stateRow = await consumeDelegatedState(svc, project, state);
  // Cross-user rejection: the state was issued to THIS user.
  if (stateRow.app_user_id !== user.id) {
    // G-6.4: consuming a state issued to someone else is a probe of another user's flow — auditable.
    await recordAuthEvent(svc, project, { action: "deleg_oauth_state_mismatch", resource: "AppAuthToken", resource_id: stateRow.id, metadata: { app_user_id: user.id, provider_id: String(stateRow.data?.provider_id || "") }, meta, status: "error", error_code: "OAUTH_STATE_MISMATCH" });
    fail(403, "OAUTH_STATE_MISMATCH", "This authorization request belongs to another user");
  }
  const provider_id = String(stateRow.data?.provider_id || "");
  if (!provider_id) fail(400, "OAUTH_STATE_MISMATCH", "This authorization request is not valid");
  const cfg = providerConfig(providers, provider_id);
  const verifier = stateRow.data?.pkce_verifier || null;
  // The exchange always uses the redirect bound to the state at begin; a differing client value is refused.
  const redirect = String(stateRow.data?.redirect_uri || "");
  if (redirect_uri && String(redirect_uri) !== redirect) fail(400, "OAUTH_STATE_MISMATCH", "The callback URI differs from the authorized request");

  // Exchange the code server-side. The code, verifier and client secret never leave this closure.
  const exchanged = await exchangeAuthorizationCode(cfg, code, redirect, verifier, resolveSecret, http);
  const subject = String(exchanged.subject || "");
  if (!subject) fail(502, "OAUTH_IDENTITY_INVALID", "The provider returned no subject for this authorization");
  const email = normalizeEmail(exchanged.email || "");

  // Identity linking through the existing AppIdentity (#29). A provider subject linked to another
  // user is a wrong-user link and is refused — never silently re-linked.
  const existing = await findIdentity(svc, project, provider_id, subject);
  if (existing && existing.app_user_id !== user.id) {
    await recordAuthEvent(svc, project, { action: "deleg_oauth_identity_taken", resource: "AppIdentity", resource_id: existing.id, metadata: { app_user_id: user.id, provider_id, external_subject: subject }, meta, status: "error", error_code: "OAUTH_IDENTITY_TAKEN" });
    fail(409, "OAUTH_IDENTITY_TAKEN", "This external account is already linked to another user");
  }
  // One credential per project + provider + subject. Re-authorizing the same account updates it.
  const priorCred = (await svc.entities.DelegatedCredential.filter({ project_id: project.id, provider_id, external_subject: subject }, "-created_date", 1).catch(() => []))[0] || null;
  if (priorCred && priorCred.app_user_id !== user.id) {
    await recordAuthEvent(svc, project, { action: "deleg_oauth_identity_taken", resource: "DelegatedCredential", resource_id: priorCred.id, metadata: { app_user_id: user.id, provider_id, external_subject: subject }, meta, status: "error", error_code: "OAUTH_IDENTITY_TAKEN" });
    fail(409, "OAUTH_IDENTITY_TAKEN", "This external account is already linked to another user");
  }

  const credential_id = priorCred?.credential_id || newCredentialId();
  const aad = aadFor(project.id, credential_id);
  const encAccess = await encryptWithAad(aad, exchanged.access_token);
  const encRefresh = exchanged.refresh_token ? await encryptWithAad(aad, exchanged.refresh_token) : null;
  const expiresAt = exchanged.expires_in ? new Date(Date.now() + Math.max(30, Number(exchanged.expires_in)) * 1000).toISOString() : null;
  const profile = safeProfile(exchanged.profile);

  const payload = {
    app_user_id: user.id, provider_id, external_subject: subject,
    external_email: email || null, external_profile: profile,
    encrypted_access_token: encAccess, encrypted_refresh_token: encRefresh,
    scopes: Array.isArray(exchanged.scopes) ? exchanged.scopes : (Array.isArray(cfg.scopes) ? cfg.scopes : []),
    expires_at: expiresAt, token_endpoint: cfg.token_endpoint,
    client_id_secret: cfg.client_id_secret, client_secret_secret: cfg.client_secret_secret || null,
    pkce: !!cfg.pkce, status: "active", revoked_at: null, last_refreshed_at: null,
    refresh_rotation_count: 0, trace_id: meta.trace_id || null, updated_at: nowIso(),
  };

  let credential;
  if (priorCred) {
    credential = await svc.entities.DelegatedCredential.update(priorCred.id, payload);
  } else {
    credential = await svc.entities.DelegatedCredential.create({ credential_id, project_id: project.id, workspace_id: project.workspace_id || null, created_at: nowIso(), ...payload });
  }

  // Link the AppIdentity if this is the first time this subject is connected.
  if (!existing) {
    await svc.entities.AppIdentity.create({
      project_id: project.id, app_user_id: user.id, provider: provider_id, provider_subject: subject,
      email: email || null, profile, status: "linked", linked_at: nowIso(), last_login_at: nowIso(),
    }).catch(() => {});
  } else {
    await svc.entities.AppIdentity.update(existing.id, { last_login_at: nowIso(), email: email || existing.email || null, profile }).catch(() => {});
  }

  await recordAuthEvent(svc, project, { action: "deleg_oauth_completed", resource: "DelegatedCredential", resource_id: credential.id, metadata: { app_user_id: user.id, provider_id, external_subject: subject, credential_id, linked: !existing }, meta });
  return {
    credential_id, provider_id, external_subject: subject, external_email: email || null,
    status: "active", scopes: payload.scopes, expires_at: expiresAt, linked: !existing,
  };
}

async function consumeDelegatedState(svc, project, state) {
  if (typeof state !== "string" || !/^[a-f0-9]{64}$/.test(state)) fail(400, "OAUTH_STATE_INVALID", "The authorization state is not valid");
  const [row] = await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: DELEGATED_OAUTH_STATE_KIND, token_hash: await sha256(state) }, "-created_date", 1).catch(() => []);
  if (!row || row.project_id !== project.id) fail(400, "OAUTH_STATE_INVALID", "The authorization state is not valid");
  if (row.status === "used") fail(410, "OAUTH_STATE_USED", "This authorization request has already been used");
  if (row.status !== "pending") fail(410, "OAUTH_STATE_EXPIRED", "This authorization request has expired");
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    await svc.entities.AppAuthToken.update(row.id, { status: "expired" }).catch(() => {});
    fail(410, "OAUTH_STATE_EXPIRED", "This authorization request has expired");
  }
  // Single-use consumption is an ATOMIC conditional transition (id + still pending): two
  // concurrent callbacks on the same state can never both consume it. A loser of the race is
  // refused with the same 410 replay contract a sequential replay already gets.
  const consumed = await svc.entities.AppAuthToken.updateMany(
    { id: row.id, status: "pending" },
    { $set: { status: "used", used_at: nowIso() } },
  );
  if ((Number(consumed?.updated) || 0) < 1) {
    fail(410, "OAUTH_STATE_USED", "This authorization request has already been used");
  }
  return row;
}

async function exchangeAuthorizationCode(cfg, code, redirect_uri, verifier, resolveSecret, http) {
  const clientId = await resolveSecret(cfg.client_id_secret);
  const clientSecret = cfg.client_secret_secret ? await resolveSecret(cfg.client_secret_secret) : null;
  if (!clientId) fail(503, "OAUTH_CLIENT_NOT_CONFIGURED", `The OAuth client_id secret "${cfg.client_id_secret}" is not set`);
  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("code", String(code || ""));
  if (redirect_uri) form.set("redirect_uri", redirect_uri);
  form.set(isTikTokOAuth(cfg) ? "client_key" : "client_id", clientId);
  if (isTikTokOAuth(cfg) && !clientSecret) fail(503, "OAUTH_CLIENT_NOT_CONFIGURED", "The TikTok OAuth client secret is not configured");
  if (clientSecret) form.set("client_secret", clientSecret);
  if (verifier && (!isTikTokOAuth(cfg) || cfg.pkce)) form.set("code_verifier", verifier);
  let res;
  try {
    res = await http(cfg.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() });
  } catch (e) {
    fail(502, "OAUTH_EXCHANGE_FAILED", `Could not reach the token endpoint: ${e.message}`);
  }
  const payload = res.body && typeof res.body === "object" ? res.body : {};
  if (!res.ok) {
    fail(502, "OAUTH_EXCHANGE_FAILED", `The token endpoint rejected the authorization code (HTTP ${res.status}${payload.error ? `, ${payload.error}` : ""})`);
  }
  const access_token = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!access_token) fail(502, "OAUTH_EXCHANGE_FAILED", "The token endpoint returned no access_token");
  return {
    access_token,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    expires_in: Number(payload.expires_in) || 0,
    scopes: isTikTokOAuth(cfg) ? tikTokGrantedScopes(payload.scope) : typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : null,
    subject: isTikTokOAuth(cfg) ? String(payload.open_id || "") : typeof payload.sub === "string" ? payload.sub : (typeof payload.user_id === "string" ? payload.user_id : ""),
    email: typeof payload.email === "string" ? payload.email : null,
    profile: payload.profile && typeof payload.profile === "object" ? payload.profile : null,
  };
}

/**
 * Refresh an expired access token. The refresh token is decrypted, exchanged for a new access token
 * (and a rotated refresh token when the provider issues one), and both are re-encrypted. Rotation
 * is counted; a refresh failure marks the credential refresh_failed so the user must re-authorize.
 */
// G-6.4: a credential that can no longer be refreshed leaves an audit row, not just a status —
// silent expiry vs provider refusal vs network failure stay distinguishable afterwards.
async function refreshFailed(svc, project, cred, meta, message) {
  await svc.entities.DelegatedCredential.update(cred.id, { status: "refresh_failed", updated_at: nowIso() }).catch(() => {});
  await recordAuthEvent(svc, project, {
    action: "deleg_oauth_refresh_failed", resource: "DelegatedCredential", resource_id: cred.id,
    metadata: { app_user_id: cred.app_user_id, provider_id: cred.provider_id, credential_id: cred.credential_id },
    meta, status: "error", error_code: "OAUTH_REFRESH_FAILED",
  });
  fail(502, "OAUTH_REFRESH_FAILED", message);
}

export async function refreshDelegatedCredential(svc, project, user, credential_id, { resolveSecret, http } = {}, meta = {}) {
  const cred = await loadCredential(svc, project, credential_id);
  if (!cred) fail(404, "OAUTH_CREDENTIAL_NOT_FOUND", "This delegated credential does not exist");
  // Ownership is enforced on the refresh path exactly as status/revoke enforce it: only the
  // app user a delegated credential belongs to may refresh it. No session → fail closed.
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to refresh a delegated credential");
  if (cred.app_user_id !== user.id) fail(403, "OAUTH_CREDENTIAL_MISMATCH", "This delegated credential belongs to another user");
  if (cred.status === "revoked") fail(403, "OAUTH_CREDENTIAL_REVOKED", "This delegated credential has been revoked");
  if (!cred.encrypted_refresh_token) fail(403, "OAUTH_NO_REFRESH_TOKEN", "This credential has no refresh token and cannot be refreshed");
  const aad = aadFor(project.id, credential_id);
  const refreshToken = await decryptWithAad(aad, cred.encrypted_refresh_token);
  const clientId = await resolveSecret(cred.client_id_secret);
  const clientSecret = cred.client_secret_secret ? await resolveSecret(cred.client_secret_secret) : null;
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", refreshToken);
  form.set(isTikTokOAuth(cred) ? "client_key" : "client_id", clientId);
  if (isTikTokOAuth(cred) && (!clientId || !clientSecret)) await refreshFailed(svc, project, cred, meta, "TikTok OAuth client credentials are not configured");
  if (clientSecret) form.set("client_secret", clientSecret);
  if (!isTikTokOAuth(cred) && Array.isArray(cred.scopes) && cred.scopes.length) form.set("scope", cred.scopes.join(" "));
  let res;
  try {
    res = await http(cred.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() });
  } catch (e) {
    await refreshFailed(svc, project, cred, meta, `Could not reach the token endpoint: ${e.message}`);
  }
  const payload = res.body && typeof res.body === "object" ? res.body : {};
  if (!res.ok) {
    await refreshFailed(svc, project, cred, meta, `The token endpoint rejected the refresh (HTTP ${res.status})`);
  }
  const access_token = typeof payload.access_token === "string" ? payload.access_token : null;
  if (!access_token) {
    await refreshFailed(svc, project, cred, meta, "The token endpoint returned no access_token");
  }
  if (isTikTokOAuth(cred) && payload.open_id !== cred.external_subject) await refreshFailed(svc, project, cred, meta, "TikTok refresh returned a different account identity");
  const newRefresh = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  const encAccess = await encryptWithAad(aad, access_token);
  const encRefresh = newRefresh ? await encryptWithAad(aad, newRefresh) : cred.encrypted_refresh_token;
  const expiresAt = payload.expires_in ? new Date(Date.now() + Math.max(30, Number(payload.expires_in)) * 1000).toISOString() : cred.expires_at;
  const updated = await svc.entities.DelegatedCredential.update(cred.id, {
    encrypted_access_token: encAccess, encrypted_refresh_token: encRefresh, expires_at: expiresAt,
    status: "active", last_refreshed_at: nowIso(), refresh_rotation_count: (cred.refresh_rotation_count || 0) + (newRefresh ? 1 : 0),
    ...(isTikTokOAuth(cred) ? { scopes: tikTokGrantedScopes(payload.scope) } : {}),
    updated_at: nowIso(),
  });
  await recordAuthEvent(svc, project, { action: "deleg_oauth_refreshed", resource: "DelegatedCredential", resource_id: cred.id, metadata: { app_user_id: cred.app_user_id, provider_id: cred.provider_id, credential_id, rotated: !!newRefresh }, meta });
  return { credential_id, status: "active", expires_at: expiresAt, rotated: !!newRefresh };
}

/**
 * Explicit revoke. The provider's revoke endpoint is called best-effort, then the credential is
 * marked revoked locally regardless — a failed provider revoke never leaves a credential usable.
 */
export async function revokeDelegatedCredential(svc, project, user, credential_id, { providers, resolveSecret, http } = {}, meta = {}) {
  const cred = await loadCredential(svc, project, credential_id);
  if (!cred) fail(404, "OAUTH_CREDENTIAL_NOT_FOUND", "This delegated credential does not exist");
  if (cred.app_user_id !== user.id) fail(403, "OAUTH_CREDENTIAL_MISMATCH", "This delegated credential belongs to another user");
  if (cred.status === "revoked") return { credential_id, status: "revoked" };
  // Best-effort provider revoke. The token is decrypted only to send it to the provider; it is never
  // logged or returned. A provider that does not support revoke is still revoked locally.
  const cfg = providers?.[cred.provider_id];
  if (cfg?.revoke_endpoint) {
    try {
      const aad = aadFor(project.id, credential_id);
      const accessToken = await decryptWithAad(aad, cred.encrypted_access_token);
      const form = new URLSearchParams();
      form.set("token", accessToken);
      if (!isTikTokOAuth(cfg)) form.set("token_type_hint", "access_token");
      const clientId = await resolveSecret(cred.client_id_secret);
      if (clientId) form.set(isTikTokOAuth(cfg) ? "client_key" : "client_id", clientId);
      const clientSecret = cred.client_secret_secret ? await resolveSecret(cred.client_secret_secret) : null;
      if (clientSecret) form.set("client_secret", clientSecret);
      await http(cfg.revoke_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    } catch { /* provider revoke is best-effort; local revocation is authoritative */ }
  }
  await svc.entities.DelegatedCredential.update(cred.id, { status: "revoked", revoked_at: nowIso(), updated_at: nowIso() });
  await recordAuthEvent(svc, project, { action: "deleg_oauth_revoked", resource: "DelegatedCredential", resource_id: cred.id, metadata: { app_user_id: user.id, provider_id: cred.provider_id, credential_id }, meta });
  return { credential_id, status: "revoked" };
}

/**
 * Status projection — metadata only, never a token value.
 */
export async function statusDelegatedCredential(svc, project, user, credential_id) {
  const cred = await loadCredential(svc, project, credential_id);
  if (!cred) fail(404, "OAUTH_CREDENTIAL_NOT_FOUND", "This delegated credential does not exist");
  if (cred.app_user_id !== user.id) fail(403, "OAUTH_CREDENTIAL_MISMATCH", "This delegated credential belongs to another user");
  return {
    credential_id: cred.credential_id, provider_id: cred.provider_id,
    external_subject: cred.external_subject, external_email: cred.external_email || null,
    scopes: cred.scopes || [], status: cred.status, expires_at: cred.expires_at || null,
    last_refreshed_at: cred.last_refreshed_at || null, refresh_rotation_count: cred.refresh_rotation_count || 0,
    revoked_at: cred.revoked_at || null, created_at: cred.created_at || null,
  };
}

/** List the calling user's delegated credentials for a project. Never another user's. */
export async function listDelegatedCredentials(svc, project, user, { provider_id = null } = {}) {
  const query = { project_id: project.id, app_user_id: user.id };
  if (provider_id) query.provider_id = String(provider_id);
  const rows = await svc.entities.DelegatedCredential.filter(query, "-created_date", 50).catch(() => []);
  return rows.map((r) => ({
    credential_id: r.credential_id, provider_id: r.provider_id, external_subject: r.external_subject,
    external_email: r.external_email || null, scopes: r.scopes || [], status: r.status,
    expires_at: r.expires_at || null, created_at: r.created_at || null,
  }));
}

async function loadCredential(svc, project, credential_id) {
  const [row] = await svc.entities.DelegatedCredential.filter({ project_id: project.id, credential_id: String(credential_id || "") }, "-created_date", 1).catch(() => []);
  return row && row.project_id === project.id ? row : null;
}

/**
 * Resolve a delegated credential for a connector call. Validates it belongs to the executing user,
 * decrypts the access token, refreshes it if expired (rotating the refresh token), and returns the
 * bearer token. The token is handed to `protect` for redaction before it can reach a header, log or
 * error. Never substitutes another user's credential — a mismatch is a hard refusal.
 */
export function createDelegatedCredentialResolver(client, { project, user, resolveSecret, http, protect = () => {}, trace_id = null } = {}) {
  const svc = client.asServiceRole || client;
  return async function resolve(selector) {
    if (!user?.id) throw Object.assign(new Error("A delegated credential requires a signed-in app user"), { code: "AUTH_FAILURE", details: { kind: "auth_required" } });
    if (!selector || selector.kind !== "delegated" || !selector.credential_id) {
      throw Object.assign(new Error("A delegated credential selection ({ kind: 'delegated', credential_id }) is required"), { code: "AUTH_FAILURE", details: { kind: "delegated_required" } });
    }
    const cred = await loadCredential(svc, project, selector.credential_id);
    if (!cred) throw Object.assign(new Error(`Delegated credential "${selector.credential_id}" was not found`), { code: "AUTH_FAILURE", details: { kind: "credential_not_found" } });
    if (cred.app_user_id !== user.id) throw Object.assign(new Error("The selected delegated credential belongs to another user"), { code: "AUTH_FAILURE", details: { kind: "credential_user_mismatch" } });
    if (cred.status === "revoked") throw Object.assign(new Error("The delegated credential has been revoked"), { code: "AUTH_FAILURE", details: { kind: "credential_revoked" } });

    const aad = aadFor(project.id, cred.credential_id);
    // Refresh if expired or about to expire. A refresh failure surfaces as AUTH_FAILURE so the
    // caller knows to re-authorize; the credential is marked refresh_failed.
    const expired = !cred.expires_at || Date.parse(cred.expires_at) <= Date.now() + TOKEN_SAFETY_MS;
    if (expired && cred.encrypted_refresh_token) {
      try {
        await refreshDelegatedCredential(svc, project, user, cred.credential_id, { resolveSecret, http }, { trace_id });
      } catch (e) {
        throw Object.assign(new Error(`The delegated credential expired and could not be refreshed: ${e.message}`), { code: "AUTH_FAILURE", details: { kind: "refresh_failed" } });
      }
      const fresh = await loadCredential(svc, project, cred.credential_id);
      if (!fresh || fresh.status !== "active") throw Object.assign(new Error("The delegated credential is no longer active"), { code: "AUTH_FAILURE", details: { kind: "credential_inactive" } });
      const token = await decryptWithAad(aadFor(project.id, fresh.credential_id), fresh.encrypted_access_token);
      protect(token);
      return token;
    }
    if (!cred.encrypted_access_token) throw Object.assign(new Error("The delegated credential has no access token"), { code: "AUTH_FAILURE", details: { kind: "no_access_token" } });
    const token = await decryptWithAad(aad, cred.encrypted_access_token);
    protect(token);
    return token;
  };
}