// Provider-neutral OAuth foundation for generated-app end-users (#29).
//
// The contract is the architecture — authorization → callback → identity lookup → account linking —
// with NO provider hardcoded. A provider is a per-project configuration object supplied by the
// SERVER-side caller (never by the browser):
//   { authorize_url, client_id, scopes, exchange(code, redirect_uri) → { subject, email, display_name, email_verified, profile } }
// `exchange` is the adapter that talks to the provider with the client secret; it runs here and
// returns only the identity. No provider token, refresh token or client secret is ever stored or
// returned, and the state secret is a single-use AppAuthToken exactly like a reset token.
// The platform currently ships no end-user OAuth provider, so the default registry is empty and
// an unconfigured provider is refused with OAUTH_PROVIDER_NOT_CONFIGURED.
import { scrub, scrubText } from "./tracing.ts";
// The SAME S256 PKCE helpers the delegated OAuth flow uses — extracted to shared/pkce.ts so
// both flows share one implementation without a circular import.
import { generatePkceVerifier, pkceChallengeFromVerifier } from "./pkce.ts";
import {
  AUTH_LIMITS, fail, nowIso, publicUser, publicSession, normalizeEmail, resolveProject, sha256,
  createSession, consumeToken, issueToken, findUserByEmail, getAppUser, createPasswordlessUser, recordAuthEvent, limit,
} from "./appAuth.ts";

export const OAUTH_CONTRACT_VERSION = "nexusai-app-oauth-1";

export const describeOAuthContract = () => Object.freeze({
  contract_version: OAUTH_CONTRACT_VERSION,
  steps: ["begin (state issued, authorization_url returned)", "callback (state consumed once, code exchanged server-side)", "identity lookup (provider + subject)", "account linking (existing identity → sign in; matching email → link; else create)"],
  provider_config: ["authorize_url", "client_id", "scopes", "exchange(code, redirect_uri)"],
  never_returned: ["client_secret", "provider access/refresh tokens", "state secret after issue"],
  built_in_providers: [],
});

const providerOf = (providers, name) => {
  const cfg = providers && providers[String(name || "")];
  if (!cfg || typeof cfg.exchange !== "function") fail(404, "OAUTH_PROVIDER_NOT_CONFIGURED", `Sign-in provider "${name}" is not configured for this application`);
  return cfg;
};

export async function findIdentity(svc, project, provider, subject) {
  const [row] = await svc.entities.AppIdentity.filter({ project_id: project.id, provider: String(provider), provider_subject: String(subject), status: "linked" }, "-created_date", 1).catch(() => []);
  return row && row.project_id === project.id ? row : null;
}

// loginWithProvider(provider, fromUrl) parity (SDK 0.8.52): the OPTIONAL post-login return
// destination travels as `from_url` and is validated HERE — fail-closed: a relative path (never
// protocol-relative) or an absolute URL whose origin equals the app's serving origin. Anything
// else (cross-origin, unparseable, control characters, oversized) is refused; the value is then
// preserved in the existing single-use oauth_state token's data. When omitted, nothing is stored
// and the callback host keeps its current fixed destination.
export const OAUTH_FROM_URL_MAX = 500;

export function validatePostLoginUrl(fromUrl, origin) {
  const raw = String(fromUrl ?? "").trim();
  if (!raw) return null;
  if (raw.length > OAUTH_FROM_URL_MAX || /[\r\n\u0000]/.test(raw) || raw.startsWith("//")) {
    fail(400, "OAUTH_FROM_URL_INVALID", "The post-login destination must be a relative path or a same-origin URL");
  }
  if (raw.startsWith("/")) return raw.slice(0, OAUTH_FROM_URL_MAX);
  let u = null;
  try { u = new URL(raw); } catch { /* refused below */ }
  if (!origin || !u || (u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== origin) {
    fail(400, "OAUTH_FROM_URL_INVALID", "The post-login destination must be a relative path or a same-origin URL");
  }
  return raw.slice(0, OAUTH_FROM_URL_MAX);
}

export async function beginOAuth(svc, projectRef, { provider, redirect_uri, from_url } = {}, { providers = {}, meta = {}, origin = null } = {}) {
  const project = await resolveProject(svc, projectRef);
  const cfg = providerOf(providers, provider);
  // Durable rate limit (P-9.8), keyed per project + hashed ip through the existing limiter.
  await limit(svc, project, "app_oauth_begin", `ip:${meta.ip ? (await sha256(meta.ip)).slice(0, 16) : "unknown"}`);
  // PKCE (S256) when the provider supports it: the verifier is a per-flow secret stored ONLY in
  // the single-use state token's server-side data; only the challenge ever reaches the browser.
  const verifier = cfg.pkce ? generatePkceVerifier() : null;
  const challenge = verifier ? await pkceChallengeFromVerifier(verifier) : null;
  const post_login_url = validatePostLoginUrl(from_url, origin);
  const { token: state } = await issueToken(svc, project, { kind: "oauth_state", ttl_ms: AUTH_LIMITS.oauth_state_ttl_ms, data: { provider: String(provider), redirect_uri: redirect_uri ? String(redirect_uri).slice(0, 500) : null, ...(post_login_url ? { post_login_url } : {}), ...(verifier ? { pkce_verifier: verifier } : {}) } });
  const url = new URL(String(cfg.authorize_url || "https://invalid.local/authorize"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", String(cfg.client_id || ""));
  if (redirect_uri) url.searchParams.set("redirect_uri", String(redirect_uri));
  if (cfg.scopes) url.searchParams.set("scope", Array.isArray(cfg.scopes) ? cfg.scopes.join(" ") : String(cfg.scopes));
  if (challenge) {
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  url.searchParams.set("state", state);
  await recordAuthEvent(svc, project, { action: "oauth_begin", resource: "AppIdentity", metadata: { provider: String(provider) }, meta });
  return { provider: String(provider), state, authorization_url: url.toString(), expires_in_ms: AUTH_LIMITS.oauth_state_ttl_ms };
}

/**
 * The callback. The state is consumed ONCE, the code is exchanged by the provider adapter on the
 * server, and the returned identity is looked up / linked / created — then a normal app session is
 * issued. A signed-in `link_to` user turns the flow into account linking instead of sign-in.
 */
export async function completeOAuth(svc, projectRef, { provider, state, code, link_to = null } = {}, { providers = {}, meta = {} } = {}) {
  const project = await resolveProject(svc, projectRef);
  const cfg = providerOf(providers, provider);
  // Durable rate limit (P-9.8), keyed per project + hashed ip through the existing limiter.
  await limit(svc, project, "app_oauth_callback", `ip:${meta.ip ? (await sha256(meta.ip)).slice(0, 16) : "unknown"}`);
  const used = await consumeToken(svc, project, { token: state, kind: "oauth_state" });
  if (String(used.data?.provider || "") !== String(provider)) fail(400, "OAUTH_STATE_MISMATCH", "The sign-in request does not match this provider");

  // The PKCE verifier travels from the consumed state straight to the provider adapter — it is
  // server-side only and has no route into a response, a log or a stored identity.
  const identity = await cfg.exchange(String(code || ""), used.data?.redirect_uri || null, { pkce_verifier: used.data?.pkce_verifier || null });
  const subject = String(identity?.subject || "");
  if (!subject) fail(502, "OAUTH_IDENTITY_INVALID", "The sign-in provider returned no identity");
  const email = normalizeEmail(identity.email);
  const profile = scrub(identity.profile || {});

  let user = null, linked = false, created = false;
  const existing = await findIdentity(svc, project, provider, subject);
  if (existing) {
    user = await getAppUser(svc, project, existing.app_user_id);
    if (link_to && user && user.id !== link_to.id) fail(409, "OAUTH_IDENTITY_TAKEN", "This external account is already linked to another user");
    await svc.entities.AppIdentity.update(existing.id, { last_login_at: nowIso(), email: email || existing.email || null, profile }).catch(() => {});
  } else {
    user = link_to ? await getAppUser(svc, project, link_to.id) : (email ? await findUserByEmail(svc, project, email) : null);
    if (!user) { user = await createPasswordlessUser(svc, project, { email, display_name: identity.display_name, email_verified: !!identity.email_verified }); created = true; }
    await svc.entities.AppIdentity.create({ project_id: project.id, app_user_id: user.id, provider: String(provider), provider_subject: subject, email: email || null, profile, status: "linked", linked_at: nowIso(), last_login_at: nowIso() });
    linked = true;
    if (!user.email_verified && identity.email_verified && email && user.email === email) {
      user = await svc.entities.AppUser.update(user.id, { email_verified: true, email_verified_at: nowIso(), updated_at: nowIso() });
    }
  }
  if (!user || user.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");
  await svc.entities.AppUser.update(user.id, { last_login_at: nowIso(), updated_at: nowIso() }).catch(() => {});
  const { token, session } = await createSession(svc, project, user, meta);
  await recordAuthEvent(svc, project, { action: "oauth_signin", resource_id: user.id, metadata: { app_user_id: user.id, provider: String(provider), linked, created, session_id: session.id }, meta });
  // The validated post-login destination rides the callback answer so BOTH host surfaces
  // (deployed callback page / preview) can return the user there; null = use the fixed fallback.
  return { user: publicUser(user), token, session: publicSession(session), provider: String(provider), linked, created, post_login_url: used.data?.post_login_url || null };
}

export async function listIdentities(svc, project, user) {
  const rows = await svc.entities.AppIdentity.filter({ project_id: project.id, app_user_id: user.id, status: "linked" }, "-created_date", 20).catch(() => []);
  return rows.map((r) => ({ id: r.id, provider: r.provider, email: r.email || null, linked_at: r.linked_at || r.created_date, last_login_at: r.last_login_at || null, display: scrubText(r.profile?.name || r.profile?.display_name || "", 100) }));
}

/** Unlinks a provider, refusing the last credential so a user can never be locked out. */
export async function unlinkIdentity(svc, project, user, { provider } = {}, meta = {}) {
  const row = (await svc.entities.AppIdentity.filter({ project_id: project.id, app_user_id: user.id, provider: String(provider || ""), status: "linked" }, "-created_date", 1).catch(() => []))[0];
  if (!row) fail(404, "OAUTH_IDENTITY_NOT_FOUND", "No such linked account");
  const full = await getAppUser(svc, project, user.id);
  const others = (await listIdentities(svc, project, user)).length - 1;
  if (!full?.password_hash && others < 1) fail(409, "LAST_CREDENTIAL", "Set a password before unlinking your only sign-in method");
  await svc.entities.AppIdentity.update(row.id, { status: "unlinked" });
  await recordAuthEvent(svc, project, { action: "oauth_unlinked", resource: "AppIdentity", resource_id: row.id, metadata: { app_user_id: user.id, provider: String(provider) }, meta });
  return { ok: true };
}