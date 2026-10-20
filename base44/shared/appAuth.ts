// Generated-app end-user identity + authentication (#29).
//
// Scope: the END-USERS of a deployed generated application. They are a project-scoped identity
// layer, deliberately separate from NexusAI platform users: they live in their own entities
// (AppUser / AppSession / AppAuthToken / AppIdentity), never in the platform User table, and a
// session issued here grants NOTHING on the builder, the workspace or the platform.
//
// Guarantees, all enforced HERE, server-side:
//   • ISOLATION — every lookup is filtered by the project the request is addressed to. A token
//     minted for project A resolves to nothing in project B; an email is unique per project.
//   • CREDENTIALS — PBKDF2-SHA256 (100k iterations, per-user salt) via Web Crypto. The hash is
//     never returned by any function in this module: `publicUser` is the ONLY projection.
//   • SESSIONS — 32 random bytes; only the SHA-256 lands in storage. Sessions expire, are revoked
//     on logout / account disable, and ROTATE on refresh (the previous token becomes a replay).
//   • SINGLE-USE SECRETS — password-reset and email-verification tokens are hashed at rest,
//     expire, and are consumed exactly once. The raw secret goes to the delivery hook only —
//     never to a response, a log line or an audit row.
//   • ABUSE — sign-in, sign-up, reset and verification are metered through the platform's
//     EXISTING durable limiter (apiLimits), keyed per project.
//   • AUDIT / TRACE — every sensitive mutation is written through the EXISTING audit log and
//     trace system. Payloads are scrubbed; a password or token has no route into either.
import { audit } from "./authz.ts";
import { recordSpan, scrub, scrubText } from "./tracing.ts";
import { consume } from "./apiLimits.ts";
import { emitAppUserAuth } from "./workflowTriggers.ts";

export const AUTH_CONTRACT_VERSION = "nexusai-app-auth-1";
// Legacy reserved-row name, kept for callers that still reference it. New identities live in AppUser.
export const USERS_ENTITY = "__users";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = "__app_session";
export const AUTH_LIMITS = Object.freeze({
  password_min_chars: 8, password_max_chars: 256, display_name_chars: 100, profile_keys: 20, profile_value_chars: 500,
  session_ttl_ms: SESSION_TTL_MS, reset_ttl_ms: 30 * 60 * 1000, verify_ttl_ms: 24 * 60 * 60 * 1000, oauth_state_ttl_ms: 10 * 60 * 1000,
});
const PBKDF2_ITERATIONS = 100000;
const PASSWORD_ALGORITHM = "pbkdf2-sha256-100k";
const TOKEN_RE = /^[a-f0-9]{64}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const nowIso = () => new Date().toISOString();
export const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256(text) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)))); }
export function randomHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
export const normalizeEmail = (v) => String(v || "").toLowerCase().trim();

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256));
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length < AUTH_LIMITS.password_min_chars) fail(400, "PASSWORD_TOO_SHORT", `Password must be at least ${AUTH_LIMITS.password_min_chars} characters`);
  if (password.length > AUTH_LIMITS.password_max_chars) fail(400, "PASSWORD_TOO_LONG", `Password must be at most ${AUTH_LIMITS.password_max_chars} characters`);
}
function validateEmail(email) { if (!EMAIL_RE.test(email)) fail(400, "EMAIL_INVALID", "A valid email is required"); }

// --- projections ----------------------------------------------------------------------------
// THE public shape of an app user. Credentials, salts and platform mappings are absent by
// construction; nothing else in this module returns a raw AppUser row to a caller.
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email || "", display_name: row.display_name || "", full_name: row.display_name || "",
    email_verified: !!row.email_verified, roles: Array.isArray(row.roles) ? row.roles : [], status: row.status || "active",
    profile: row.profile || {}, created_at: row.created_at || row.created_date, last_login_at: row.last_login_at || null,
  };
}
export const publicSession = (s) => s ? ({
  id: s.id, app_user_id: s.app_user_id, status: s.status, created_at: s.created_at || s.created_date, expires_at: s.expires_at || null,
  last_seen_at: s.last_seen_at || null, revoked_at: s.revoked_at || null, rotated_from: s.rotated_from || null, rotation_count: s.rotation_count || 0,
}) : null;

// --- shared plumbing ------------------------------------------------------------------------
export async function resolveProject(svc, ref) {
  if (ref && typeof ref === "object" && ref.id) return ref;
  const project = await svc.entities.Project.get(String(ref || "")).catch(() => null);
  if (!project) fail(404, "PROJECT_NOT_FOUND", "Application not found");
  return project;
}

// Exported since P-9.8: the social sign-in flow (appOAuth) meters its begin/callback through the
// SAME durable limiter as every other app-auth action. Same signature, same semantics.
export async function limit(svc, project, action, key) {
  const res = await consume(svc, { identity: `app:${project.id}:${key}`, action, workspace_id: project.workspace_id || null });
  if (!res.allowed) fail(429, "RATE_LIMITED", "Too many attempts. Please try again later.");
}

// One audit row + one trace span per sensitive auth event, both through the EXISTING systems.
// `metadata` is scrubbed; callers never pass a password, token or hash into it.
export async function recordAuthEvent(svc, project, { action, resource = "AppUser", resource_id = null, metadata = {}, meta = {}, status = "ok", error_code = null }) {
  const safe = scrub({ ...metadata, app_user_id: metadata.app_user_id || null });
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: null,
    action: `app_auth.${action}`, resource, resource_id: resource_id || null, metadata: safe,
  }).catch(() => {});
  if (meta.trace_id) {
    await recordSpan(svc, {
      trace_id: meta.trace_id, run_id: meta.run_id || null, workspace_id: project.workspace_id, project_id: project.id,
      event_type: "function_exec", name: `app_auth.${action}`, status, error_code, reference_id: resource_id || null, metadata: safe,
    }).catch(() => {});
  }
}

export async function findUserByEmail(svc, project, email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const [row] = await svc.entities.AppUser.filter({ project_id: project.id, email: e }, "-created_date", 1).catch(() => []);
  return row || null;
}

/** Loads an app user, enforcing project scope. Another project's user is "not found". */
export async function getAppUser(svc, project, id) {
  const row = await svc.entities.AppUser.get(String(id || "")).catch(() => null);
  return row && row.project_id === project.id ? row : null;
}

// --- sessions ---------------------------------------------------------------------------------
export async function createSession(svc, project, user, meta = {}) {
  const token = randomHex(32);
  const session = await svc.entities.AppSession.create({
    project_id: project.id, workspace_id: project.workspace_id || null, app_user_id: user.id,
    token_hash: await sha256(token), status: "active", created_at: nowIso(), last_seen_at: nowIso(),
    expires_at: new Date(Date.now() + (meta.session_ttl_ms || AUTH_LIMITS.session_ttl_ms)).toISOString(),
    ip_hash: meta.ip ? (await sha256(meta.ip)).slice(0, 32) : null, user_agent: meta.user_agent ? scrubText(meta.user_agent, 200) : null,
    trace_id: meta.trace_id || null, rotated_from: meta.rotated_from || null, rotation_count: meta.rotation_count || 0,
  });
  return { token, session };
}

/**
 * Resolves a session token FOR ONE PROJECT. Returns { session, user } or null. Malformed,
 * unknown, expired, revoked, rotated and cross-project tokens all resolve to null — and a
 * disabled account's live-looking session resolves to null too.
 */
export async function resolveSessionRecord(svc, projectRef, token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const project = await resolveProject(svc, projectRef);
  const [row] = await svc.entities.AppSession.filter({ project_id: project.id, token_hash: await sha256(token) }, "-created_date", 1).catch(() => []);
  if (!row || row.project_id !== project.id || row.status !== "active") return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    await svc.entities.AppSession.update(row.id, { status: "expired", revoked_at: nowIso(), revoke_reason: "expired" }).catch(() => {});
    return null;
  }
  const user = await getAppUser(svc, project, row.app_user_id);
  if (!user || user.status !== "active") return null;
  if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > 60000) {
    await svc.entities.AppSession.update(row.id, { last_seen_at: nowIso() }).catch(() => {});
  }
  return { session: row, user };
}

/** Compatibility projection: the public user for a valid token, else null. */
export async function resolveSession(svc, projectRef, token) {
  const resolved = await resolveSessionRecord(svc, projectRef, token);
  return resolved ? publicUser(resolved.user) : null;
}

export async function revokeUserSessions(svc, project, userId, { reason = "revoked", except = null } = {}) {
  const rows = await svc.entities.AppSession.filter({ project_id: project.id, app_user_id: userId, status: "active" }, "-created_date", 200).catch(() => []);
  let n = 0;
  for (const s of rows) {
    if (except && s.id === except) continue;
    await svc.entities.AppSession.update(s.id, { status: "revoked", revoked_at: nowIso(), revoke_reason: reason }).catch(() => {});
    n++;
  }
  return n;
}

/** Rotates a live session: the old token is retired (a replay), a fresh one is issued. */
export async function refreshSession(svc, projectRef, token, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const current = await resolveSessionRecord(svc, project, token);
  if (!current) fail(401, "SESSION_INVALID", "Your session is no longer valid. Please sign in again.");
  await limit(svc, project, "app_session", `user:${current.user.id}`);
  await svc.entities.AppSession.update(current.session.id, { status: "rotated", revoked_at: nowIso(), revoke_reason: "rotated" });
  const next = await createSession(svc, project, current.user, { ...meta, rotated_from: current.session.id, rotation_count: (current.session.rotation_count || 0) + 1 });
  await recordAuthEvent(svc, project, { action: "session_refreshed", resource: "AppSession", resource_id: next.session.id, metadata: { app_user_id: current.user.id, rotated_from: current.session.id }, meta });
  return { user: publicUser(current.user), token: next.token, session: publicSession(next.session) };
}

export async function logOut(svc, projectRef, token, meta = {}) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return true;
  const project = await resolveProject(svc, projectRef);
  const [row] = await svc.entities.AppSession.filter({ project_id: project.id, token_hash: await sha256(token) }, "-created_date", 1).catch(() => []);
  if (row && row.status === "active") {
    await svc.entities.AppSession.update(row.id, { status: "revoked", revoked_at: nowIso(), revoke_reason: "logout" });
    await recordAuthEvent(svc, project, { action: "session_revoked", resource: "AppSession", resource_id: row.id, metadata: { app_user_id: row.app_user_id, reason: "logout" }, meta });
  }
  return true;
}

// --- credentials --------------------------------------------------------------------------------
// G-2 (Base44 register contract, PROVEN — SDK 0.8.51 JSDoc/source, official Auth SDK docs,
// the platform-shipped Register.jsx boilerplate and the platform operating contract):
// registration does NOT mint an authenticated session. The user is created UNVERIFIED, the
// verification challenge rides the EXISTING single-use-token mechanism, and login is refused
// until verifyOtp() completes — which is the one transition that returns the session's access
// token ("Users cannot log in until they complete OTP verification").
export async function signUp(svc, projectRef, input = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const email = normalizeEmail(input.email);
  validateEmail(email); validatePassword(input.password);
  await limit(svc, project, "app_signup", `ip:${meta.ip ? (await sha256(meta.ip)).slice(0, 16) : "unknown"}`);
  if (await findUserByEmail(svc, project, email)) fail(409, "EMAIL_TAKEN", "An account with this email already exists");
  const salt = randomHex(16);
  const user = await svc.entities.AppUser.create({
    project_id: project.id, workspace_id: project.workspace_id || null, email,
    display_name: scrubText(input.display_name || input.full_name || "", AUTH_LIMITS.display_name_chars), profile: {},
    status: "active", email_verified: false, roles: ["user"],
    password_hash: await hashPassword(input.password, salt), password_salt: salt, password_algorithm: PASSWORD_ALGORITHM, password_updated_at: nowIso(),
    failed_login_count: 0, last_login_at: null, created_at: nowIso(), updated_at: nowIso(),
  });
  const verification = await issueEmailVerification(svc, project, user, meta);
  await recordAuthEvent(svc, project, { action: "signup", resource_id: user.id, metadata: { app_user_id: user.id, verification_sent: verification.delivered }, meta });
  // DOCUMENTED (Base44) app_user_auth workflow trigger: fires when an app user signs up. Emitted
  // AFTER the AppUser row is durable; fail-safe — a dispatch failure never breaks signup.
  await emitAppUserAuth(svc, { project, workspace_id: project.workspace_id || null, user_id: user.id, event_type: "signup", trace_id: meta?.trace_id || null });
  return { user: publicUser(user), verification_sent: verification.delivered };
}

/** Fixture/seeding convenience ONLY — never wired to any endpoint: a VERIFIED app user with
 *  a live session in one call, preserving the pre-G-2 seeding ergonomics of the suites. */
export async function signUpWithSession(svc, projectRef, input = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const { user } = await signUp(svc, project, input, meta);
  const row = await getAppUser(svc, project, user.id);
  await svc.entities.AppUser.update(row.id, { email_verified: true, email_verified_at: nowIso(), updated_at: nowIso() });
  const saved = await svc.entities.AppUser.get(row.id);
  const { token, session } = await createSession(svc, project, saved, meta);
  return { user: publicUser(saved), token, session: publicSession(session) };
}

export async function logIn(svc, projectRef, input = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const email = normalizeEmail(input.email);
  await limit(svc, project, "app_signin", `email:${(await sha256(email)).slice(0, 16)}`);
  const user = await findUserByEmail(svc, project, email);
  const candidate = await hashPassword(String(input.password || ""), user?.password_salt || "no-salt");
  const matches = !!user && !!user.password_hash && candidate === user.password_hash;
  if (!matches) {
    if (user) await svc.entities.AppUser.update(user.id, { failed_login_count: (user.failed_login_count || 0) + 1, updated_at: nowIso() }).catch(() => {});
    await recordAuthEvent(svc, project, { action: "signin_failed", resource_id: user?.id || null, metadata: { app_user_id: user?.id || null, reason: user ? "bad_password" : "unknown_email" }, meta, status: "error", error_code: "INVALID_CREDENTIALS" });
    fail(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }
  if (user.status !== "active") {
    await recordAuthEvent(svc, project, { action: "signin_failed", resource_id: user.id, metadata: { app_user_id: user.id, reason: `account_${user.status}` }, meta, status: "error", error_code: "ACCOUNT_DISABLED" });
    fail(403, "ACCOUNT_DISABLED", "This account is disabled");
  }
  // G-2: "Users cannot log in until they complete OTP verification" (Base44 Auth docs). The
  // error code/status are a NEXUSAI-derived bounded choice — upstream publishes none.
  if (!user.email_verified) {
    await recordAuthEvent(svc, project, { action: "signin_failed", resource_id: user.id, metadata: { app_user_id: user.id, reason: "email_not_verified" }, meta, status: "error", error_code: "EMAIL_NOT_VERIFIED" });
    fail(403, "EMAIL_NOT_VERIFIED", "Verify your email before signing in");
  }
  await svc.entities.AppUser.update(user.id, { last_login_at: nowIso(), failed_login_count: 0, updated_at: nowIso() });
  const { token, session } = await createSession(svc, project, user, meta);
  await recordAuthEvent(svc, project, { action: "signin", resource_id: user.id, metadata: { app_user_id: user.id, session_id: session.id }, meta });
  // DOCUMENTED (Base44) app_user_auth workflow trigger: fires when an app user logs in. Emitted
  // AFTER the session is durable; fail-safe — a dispatch failure never breaks login. Idempotency
  // is keyed by user_id + session_id, so each login (a distinct session) fires exactly once.
  await emitAppUserAuth(svc, { project, workspace_id: project.workspace_id || null, user_id: user.id, event_type: "login", session_id: session.id, trace_id: meta?.trace_id || null });
  return { user: publicUser({ ...user, last_login_at: nowIso() }), token, session: publicSession(session) };
}

export async function changePassword(svc, projectRef, { user, session }, input = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const row = await getAppUser(svc, project, user.id);
  if (!row) fail(401, "AUTH_REQUIRED", "Sign in required");
  validatePassword(input.new_password);
  const current = await hashPassword(String(input.current_password || ""), row.password_salt || "no-salt");
  if (!row.password_hash || current !== row.password_hash) fail(401, "INVALID_CREDENTIALS", "The current password is incorrect");
  const salt = randomHex(16);
  await svc.entities.AppUser.update(row.id, { password_hash: await hashPassword(input.new_password, salt), password_salt: salt, password_algorithm: PASSWORD_ALGORITHM, password_updated_at: nowIso(), updated_at: nowIso() });
  const revoked = await revokeUserSessions(svc, project, row.id, { reason: "password_changed", except: session?.id || null });
  await recordAuthEvent(svc, project, { action: "password_changed", resource_id: row.id, metadata: { app_user_id: row.id, other_sessions_revoked: revoked }, meta });
  return { ok: true, sessions_revoked: revoked };
}

export async function updateProfile(svc, projectRef, user, patch = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const row = await getAppUser(svc, project, user.id);
  if (!row) fail(401, "AUTH_REQUIRED", "Sign in required");
  // Explicit allowlist: roles, status, email and every credential field are unreachable here.
  const update = { updated_at: nowIso() };
  if (patch.display_name !== undefined || patch.full_name !== undefined) update.display_name = scrubText(patch.display_name ?? patch.full_name ?? "", AUTH_LIMITS.display_name_chars);
  if (patch.profile && typeof patch.profile === "object" && !Array.isArray(patch.profile)) {
    const profile = {};
    for (const [k, v] of Object.entries(patch.profile).slice(0, AUTH_LIMITS.profile_keys)) {
      profile[String(k).slice(0, 60)] = typeof v === "string" ? scrubText(v, AUTH_LIMITS.profile_value_chars) : (typeof v === "number" || typeof v === "boolean" || v === null) ? v : scrub(v);
    }
    update.profile = { ...(row.profile || {}), ...profile };
  }
  const saved = await svc.entities.AppUser.update(row.id, update);
  await recordAuthEvent(svc, project, { action: "profile_updated", resource_id: row.id, metadata: { app_user_id: row.id, fields: Object.keys(update).filter((k) => k !== "updated_at") }, meta });
  return publicUser(saved);
}

// --- single-use secrets (reset / verification / oauth state) ----------------------------------
async function issueToken(svc, project, { user = null, kind, ttl_ms, data = null }) {
  if (user) {
    for (const prior of await svc.entities.AppAuthToken.filter({ project_id: project.id, app_user_id: user.id, kind, status: "pending" }, "-created_date", 20).catch(() => [])) {
      await svc.entities.AppAuthToken.update(prior.id, { status: "revoked" }).catch(() => {});
    }
  }
  const token = randomHex(32);
  const row = await svc.entities.AppAuthToken.create({
    project_id: project.id, app_user_id: user?.id || null, kind, token_hash: await sha256(token), status: "pending",
    expires_at: new Date(Date.now() + ttl_ms).toISOString(), data: data ? scrub(data) : {}, created_at: nowIso(),
  });
  return { token, row };
}

/** Consumes a single-use secret exactly once. Expired and reused tokens are refused. */
export async function consumeToken(svc, project, { token, kind }) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) fail(400, "TOKEN_INVALID", "This link is not valid");
  const [row] = await svc.entities.AppAuthToken.filter({ project_id: project.id, kind, token_hash: await sha256(token) }, "-created_date", 1).catch(() => []);
  if (!row || row.project_id !== project.id) fail(400, "TOKEN_INVALID", "This link is not valid");
  if (row.status === "used") fail(410, "TOKEN_USED", "This link has already been used");
  if (row.status !== "pending") fail(410, "TOKEN_EXPIRED", "This link has expired");
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    await svc.entities.AppAuthToken.update(row.id, { status: "expired" }).catch(() => {});
    fail(410, "TOKEN_EXPIRED", "This link has expired");
  }
  return svc.entities.AppAuthToken.update(row.id, { status: "used", used_at: nowIso() });
}

// Delivery of a raw secret. `meta.onToken` is a SERVER-side capture hook (certification only —
// the public runtime never sets it); otherwise the platform's email primitive carries it. The
// secret is never returned to the caller of the auth operation.
async function deliverToken(project, { user, kind, token }, meta) {
  if (typeof meta.onToken === "function") { await meta.onToken({ kind, token, app_user_id: user.id }); return true; }
  if (typeof meta.sendEmail !== "function" || !user.email) return false;
  const subject = kind === "password_reset" ? "Reset your password" : "Verify your email";
  const text = kind === "password_reset"
    ? `Use this code to reset your password: ${token}\n\nIt expires in ${Math.round(AUTH_LIMITS.reset_ttl_ms / 60000)} minutes and can be used once. If you did not request this, ignore this email.`
    : `Use this code to verify your email address: ${token}\n\nIt expires in ${Math.round(AUTH_LIMITS.verify_ttl_ms / 3600000)} hours.`;
  try { await meta.sendEmail({ to: user.email, subject, text }); return true; } catch { return false; }
}

export async function issueEmailVerification(svc, project, user, meta = {}) {
  if (user.email_verified) return { delivered: false, already_verified: true };
  const { token, row } = await issueToken(svc, project, { user, kind: "email_verification", ttl_ms: meta.verify_ttl_ms || AUTH_LIMITS.verify_ttl_ms });
  const delivered = await deliverToken(project, { user, kind: "email_verification", token }, meta);
  await recordAuthEvent(svc, project, { action: "verification_requested", resource: "AppAuthToken", resource_id: row.id, metadata: { app_user_id: user.id, delivered }, meta });
  return { delivered, already_verified: false };
}

// G-2: the DOCUMENTED resendOtp contract — PRE-AUTH and keyed by EMAIL (the SDK example
// calls it from the registration OTP screen, where no session exists yet). NEXUSAI-derived
// bounded choices, mirroring requestPasswordReset: the answer is always { ok: true } so
// accounts cannot be enumerated, and the durable limit is keyed by email hash.
export async function resendOtp(svc, projectRef, { email } = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const normalized = normalizeEmail(email);
  validateEmail(normalized);
  await limit(svc, project, "app_verify", `email:${(await sha256(normalized)).slice(0, 16)}`);
  const user = await findUserByEmail(svc, project, normalized);
  if (user && user.status === "active" && !user.email_verified) {
    await issueEmailVerification(svc, project, user, meta);
  }
  return { ok: true };
}

// G-2: the DOCUMENTED verifyOtp contract — verification is the state transition that returns
// "an access token for the now-verified user" (SDK JSDoc), which IS the authenticated session.
// Email-keyed: the code and the email must belong to the same pending verification. The
// binding is pre-checked WITHOUT consuming, so a mistyped email cannot burn a valid code; a
// concurrent consume is still caught fail-closed by consumeToken. The pre-verification limit
// key and the strict email/token binding are NEXUSAI-derived (upstream publishes no detail).
export async function verifyOtp(svc, projectRef, { email, otpCode } = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const normalized = normalizeEmail(email);
  validateEmail(normalized);
  await limit(svc, project, "app_verify", `email:${(await sha256(normalized)).slice(0, 16)}`);
  const [pending] = await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "email_verification", token_hash: await sha256(String(otpCode || "")) }, "-created_date", 1).catch(() => []);
  const boundUser = pending ? await getAppUser(svc, project, pending.app_user_id) : null;
  if (!boundUser || boundUser.email !== normalized) fail(400, "TOKEN_INVALID", "This code is not valid");
  const used = await consumeToken(svc, project, { token: String(otpCode || ""), kind: "email_verification" });
  const saved = await svc.entities.AppUser.update(boundUser.id, { email_verified: true, email_verified_at: nowIso(), updated_at: nowIso() });
  const { token, session } = await createSession(svc, project, saved, meta);
  await recordAuthEvent(svc, project, { action: "email_verified", resource_id: boundUser.id, metadata: { app_user_id: boundUser.id, token_id: used.id, session_id: session.id }, meta });
  return { ok: true, user: publicUser(saved), access_token: token, session: publicSession(session) };
}

/** Always answers { ok: true } — whether or not the email exists — so accounts cannot be enumerated. */
export async function requestPasswordReset(svc, projectRef, { email } = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  const normalized = normalizeEmail(email);
  await limit(svc, project, "app_password_reset", `email:${(await sha256(normalized)).slice(0, 16)}`);
  const user = await findUserByEmail(svc, project, normalized);
  if (user && user.status === "active") {
    const { token, row } = await issueToken(svc, project, { user, kind: "password_reset", ttl_ms: meta.reset_ttl_ms || AUTH_LIMITS.reset_ttl_ms });
    const delivered = await deliverToken(project, { user, kind: "password_reset", token }, meta);
    await recordAuthEvent(svc, project, { action: "password_reset_requested", resource: "AppAuthToken", resource_id: row.id, metadata: { app_user_id: user.id, delivered }, meta });
  }
  return { ok: true };
}

export async function confirmPasswordReset(svc, projectRef, { token, new_password } = {}, meta = {}) {
  const project = await resolveProject(svc, projectRef);
  validatePassword(new_password);
  const used = await consumeToken(svc, project, { token, kind: "password_reset" });
  const user = await getAppUser(svc, project, used.app_user_id);
  if (!user || user.status !== "active") fail(400, "TOKEN_INVALID", "This link is not valid");
  const salt = randomHex(16);
  await svc.entities.AppUser.update(user.id, { password_hash: await hashPassword(new_password, salt), password_salt: salt, password_algorithm: PASSWORD_ALGORITHM, password_updated_at: nowIso(), failed_login_count: 0, updated_at: nowIso() });
  const revoked = await revokeUserSessions(svc, project, user.id, { reason: "password_reset" });
  await recordAuthEvent(svc, project, { action: "password_reset_completed", resource_id: user.id, metadata: { app_user_id: user.id, sessions_revoked: revoked, token_id: used.id }, meta });
  return { ok: true, sessions_revoked: revoked };
}

/** Creates a password-less account (used by OAuth linking). Roles default to the project's baseline. */
export async function createPasswordlessUser(svc, project, { email, display_name, email_verified = false }) {
  const normalized = normalizeEmail(email);
  if (normalized) validateEmail(normalized);
  return svc.entities.AppUser.create({
    project_id: project.id, workspace_id: project.workspace_id || null, email: normalized || null,
    display_name: scrubText(display_name || "", AUTH_LIMITS.display_name_chars), profile: {}, status: "active",
    email_verified: !!email_verified, email_verified_at: email_verified ? nowIso() : null, roles: ["user"],
    password_hash: null, password_salt: null, password_algorithm: null, failed_login_count: 0,
    last_login_at: nowIso(), created_at: nowIso(), updated_at: nowIso(),
  });
}

// G-5 (Base44 inviteUser contract, PROVEN — SDK 0.8.51 dist + docs): auth.inviteUser(userEmail, role)
// and users.inviteUser(user_email, role) invite a user to THE DEPLOYED APP with an app role and send
// an invitation email. Deployed-app scoped by construction — this is NOT the workspace-member
// invitation, which keeps its own control plane (workspaceMembers / collaboration.ts).
// Reuses ONLY existing primitives: AppUser (createPasswordlessUser), the single-use hashed
// AppAuthToken email-verification mechanism, the existing email delivery hook, the existing auth
// audit event and the existing durable limiter. No second invitation/token subsystem exists.
//
// NEXUSAI-DERIVED bounded choices (upstream UNKNOWN — never claimed as Base44 behavior):
//   • caller rule — a caller holding the system role "admin" may invite role "user" or "admin";
//     a caller without it may invite role "user" only (the documented public-app matrix; the
//     docs' private/public app distinction has no NexusAI equivalent, and a plain user can
//     never mint an admin);
//   • omitted role → 400 ROLE_REQUIRED (the SDK type makes role required; runtime behavior UNKNOWN);
//   • role limited to the proven SDK roles "user"/"admin" — no invented roles;
//   • duplicate email → 409 EMAIL_TAKEN (deduplication semantics UNKNOWN);
//   • the invitation rides the EXISTING email-verification single-use token (acceptance flow
//     details UNKNOWN — nothing beyond the existing verify path is claimed);
//   • response shape { ok, user, invitation_sent } — the INTERNAL projection only. The PUBLIC
//     users.inviteUser response is the PROVEN Base44 body (HTTP 200, EXACTLY { id: "<app_id>" },
//     no platform User row), mapped at the op dispatch (appRuntime / previewAuth).
export async function inviteAppUser(svc, project, caller, { user_email, role } = {}, meta = {}) {
  const email = normalizeEmail(user_email);
  validateEmail(email);
  const inviteRole = String(role || "");
  if (!inviteRole) fail(400, "ROLE_REQUIRED", "A role is required");
  if (inviteRole !== "user" && inviteRole !== "admin") fail(400, "ROLE_INVALID", "Role must be \"user\" or \"admin\"");
  if (inviteRole === "admin" && !(Array.isArray(caller?.roles) && caller.roles.includes("admin"))) fail(403, "FORBIDDEN", "Only admins can invite admins");
  await limit(svc, project, "app_invite", `email:${(await sha256(email)).slice(0, 16)}`);
  if (await findUserByEmail(svc, project, email)) fail(409, "EMAIL_TAKEN", "An account with this email already exists");
  const user = await createPasswordlessUser(svc, project, { email, email_verified: false });
  await svc.entities.AppUser.update(user.id, { roles: [inviteRole], updated_at: nowIso() });
  const verification = await issueEmailVerification(svc, project, user, meta);
  await recordAuthEvent(svc, project, { action: "user_invited", resource_id: user.id, metadata: { app_user_id: user.id, role: inviteRole, invited_by: caller?.id || null, delivered: verification.delivered }, meta });
  return { ok: true, user: publicUser({ ...user, roles: [inviteRole] }), invitation_sent: verification.delivered };
}

// --- anonymous identity (P-9.11C) -------------------------------------------------------------
// Base44 documents per-agent anonymous access (off by default); the anonymous visitor's
// persistence semantics are UNKNOWN and nothing is invented beyond this stable server-side
// identity: an AppUser row with NO email and NO credential, marked in its profile, carrying a
// normal project-scoped AppSession. Such a row can never sign in (no password hash exists),
// and its token is resolved ONLY through resolveAnonymousSession — never by an auth op, so an
// anonymous visitor is never mistaken for a signed-in user.
export const isAnonymousUser = (row) => !!row && row.email == null && (row.profile || {}).anonymous === true;

export async function createAnonymousUser(svc, project, meta = {}) {
  const user = await svc.entities.AppUser.create({
    project_id: project.id, workspace_id: project.workspace_id || null, email: null,
    display_name: "", profile: { anonymous: true }, status: "active",
    email_verified: false, email_verified_at: null, roles: [],
    password_hash: null, password_salt: null, password_algorithm: null, failed_login_count: 0,
    last_login_at: null, created_at: nowIso(), updated_at: nowIso(),
  });
  await recordAuthEvent(svc, project, { action: "anonymous_identity_created", resource_id: user.id, metadata: { app_user_id: user.id }, meta });
  return user;
}

/** Mints one anonymous visitor identity + session. Durably, fail-closed rate limited per
 *  project (the web conversation-start entry point; channels limit per chat instead). */
export async function createAnonymousSession(svc, project, meta = {}) {
  await limit(svc, project, "app_anonymous_session", "web");
  const user = await createAnonymousUser(svc, project, meta);
  const { token, session } = await createSession(svc, project, user, meta);
  return { user, token, session };
}

/** Resolves an anonymous session token for ONE project. A token of a real (non-anonymous) app
 *  user resolves to null here — the anonymous path can never be used to act as a signed-in
 *  user, and a project A token never resolves in project B. */
export async function resolveAnonymousSession(svc, projectRef, token) {
  const resolved = await resolveSessionRecord(svc, projectRef, token);
  return resolved && isAnonymousUser(resolved.user) ? resolved : null;
}

export { issueToken };

// --- session token transport (unchanged contract) -------------------------------------------
// The host page sends the token explicitly in the body for every call on behalf of the sandboxed
// iframe; the HttpOnly cookie is a fallback for same-origin host requests without a body.
export function readSessionToken(req, body) {
  if (body && body.session_token) return body.session_token;
  try {
    const c = req.headers?.get?.("cookie") || "";
    const m = c.match(new RegExp("(?:^|;\\s*)" + SESSION_COOKIE + "=([^;]+)"));
    if (m) return decodeURIComponent(m[1]);
  } catch { /* ignore */ }
  return null;
}
export const sessionCookieHeader = (token) => `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
export const clearSessionCookieHeader = () => `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;