// P-10.3 phase 3 — native-app runtime authentication (bearer tokens).
//
// The WEB runtime authenticates a deployed app's end-users through the existing project-scoped
// session contract (HttpOnly cookie, with the body token as the same-origin fallback) — that
// path is untouched. A NATIVE client cannot rely on that same-origin transport, so this module
// adds a parallel, deliberately narrow bearer-token path:
//   • a WORKSPACE MEMBER holding deploy.manage mints a MobileRuntimeSession for ONE project;
//   • only SHA-256 hashes are stored — the raw access/refresh pair exists exactly once, in the
//     mint (or refresh) response, and nowhere else;
//   • the access token is short-lived and paired with a rotating refresh token;
//   • resolution DERIVES the project from the token itself, so a bearer request can never
//     address another project or workspace;
//   • every state change is audited: mobile_runtime.token_created / token_revoked /
//     mobile_runtime.refresh_used.
// The entity is backend/service-role only (RLS denies every client path), so a client can
// never read, create or revoke sessions directly.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { resolveRole, requireCapability } from "./rbac.ts";
import { sha256, randomHex, nowIso, fail } from "./appAuth.ts";
import { parseAppSlug } from "./environments.ts";
import { resolveHostname } from "./domains.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

/**
 * Public-identifier resolution with the SAME semantics the web runtime uses: a slug (optionally
 * carrying the staging suffix) or a verified custom hostname → project + environment. Shared
 * here so the bearer path's mismatch check cannot drift from the web addressing.
 */
export async function resolvePublicTarget(svc, { slug, host } = {}) {
  if (host) {
    const resolved = await resolveHostname(svc, host);
    if (!resolved) fail(404, "APP_NOT_FOUND", "Application not found");
    const project = await svc.entities.Project.get(resolved.project_id).catch(() => null);
    if (!project) fail(404, "APP_NOT_FOUND", "Application not found");
    return { project, environment: resolved.environment };
  }
  const { slug: s, environment } = parseAppSlug(slug);
  if (!SLUG_RE.test(s)) fail(404, "APP_NOT_FOUND", "Application not found");
  const projects = await svc.entities.Project.filter({ slug: s }, "slug", 1);
  if (!projects[0]) fail(404, "APP_NOT_FOUND", "Application not found");
  return { project: projects[0], environment };
}

/**
 * THE mobile bearer-path target resolution the runtime executes: the project comes FROM THE
 * TOKEN (never from the request), and a slug/host the request carries may only name the SAME
 * project — anything else is refused. The environment is always production: a native package
 * serves exactly the production deployment it was built from.
 */
export async function resolveMobileRuntimeTarget(svc, token, addressed = null) {
  const mobile = await resolveMobileRuntimeSession(svc, token);
  if (addressed && (addressed.slug || addressed.host)) {
    const named = await resolvePublicTarget(svc, { slug: addressed.slug, host: addressed.host });
    if (named.project.id !== mobile.project.id) {
      fail(403, "MOBILE_SESSION_PROJECT_MISMATCH", "This token belongs to a different application");
    }
  }
  return { session: mobile.session, project: mobile.project, environment: "production" };
}

export const MOBILE_ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MOBILE_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_RE = /^[a-f0-9]{64}$/;

/**
 * Reads the bearer credential a native client presents, if any. The Authorization header is
 * the standard transport; `body.mobile_token` is the body transport for callers that cannot
 * set headers — exactly the same dual-transport contract the web session token uses
 * (body.session_token first, HttpOnly cookie fallback).
 */
export function readBearerToken(req, body = null) {
  const auth = req?.headers?.get?.("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const fromBody = body?.mobile_token;
  return typeof fromBody === "string" && fromBody ? fromBody.trim() : null;
}

/** Mints one workspace-scoped session for one project. Only the hashes are persisted. */
export async function createMobileRuntimeSession(base44, user, { project_id } = {}) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "deploy.manage");
  const svc = base44.asServiceRole || base44;
  const access_token = randomHex(32);
  const refresh_token = randomHex(32);
  const expires_at = new Date(Date.now() + MOBILE_ACCESS_TTL_MS).toISOString();
  const session = await svc.entities.MobileRuntimeSession.create({
    workspace_id: workspace.id, project_id: project.id,
    token_hash: await sha256(access_token), refresh_hash: await sha256(refresh_token),
    expires_at, refresh_expires_at: new Date(Date.now() + MOBILE_REFRESH_TTL_MS).toISOString(),
    revoked_at: null, created_by: user.id, last_used_at: nowIso(), rotation_count: 0,
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "mobile_runtime.token_created", resource: "MobileRuntimeSession", resource_id: session.id,
    metadata: { access_ttl_ms: MOBILE_ACCESS_TTL_MS, refresh_ttl_ms: MOBILE_REFRESH_TTL_MS },
  });
  return { access_token, refresh_token, expires_at, session_id: session.id, project_id: project.id, workspace_id: workspace.id };
}

/**
 * THE bearer-token resolution used by the mobile runtime path. Malformed, unknown, revoked and
 * expired tokens all refuse; the project is DERIVED from the row and cross-checked against the
 * workspace, so possession of a valid token never widens into access to anything else.
 */
export async function resolveMobileRuntimeSession(svc, token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) fail(401, "MOBILE_TOKEN_INVALID", "A valid mobile runtime token is required");
  const [row] = await svc.entities.MobileRuntimeSession.filter({ token_hash: await sha256(token) }, "-created_date", 1).catch(() => []);
  if (!row) fail(401, "MOBILE_TOKEN_INVALID", "A valid mobile runtime token is required");
  if (row.revoked_at) fail(401, "MOBILE_TOKEN_REVOKED", "This mobile session was revoked");
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
    fail(401, "MOBILE_TOKEN_EXPIRED", "This mobile session has expired; refresh it");
  }
  const project = await svc.entities.Project.get(row.project_id).catch(() => null);
  if (!project || project.workspace_id !== row.workspace_id) {
    fail(401, "MOBILE_TOKEN_INVALID", "This mobile session no longer resolves");
  }
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 60000) {
    await svc.entities.MobileRuntimeSession.update(row.id, { last_used_at: nowIso() }).catch(() => {});
  }
  return { session: row, project };
}

/**
 * Rotates the token pair. The refresh token is a credential in its own right, so no platform
 * login is required — but rotation is a compare-and-set on the CURRENT refresh hash, so a
 * replayed (or concurrently replayed) refresh token updates zero rows and is refused.
 */
export async function refreshMobileRuntimeSession(svc, refresh_token) {
  if (typeof refresh_token !== "string" || !TOKEN_RE.test(refresh_token)) fail(401, "MOBILE_REFRESH_INVALID", "A valid refresh token is required");
  const currentHash = await sha256(refresh_token);
  const [row] = await svc.entities.MobileRuntimeSession.filter({ refresh_hash: currentHash }, "-created_date", 1).catch(() => []);
  if (!row) fail(401, "MOBILE_REFRESH_INVALID", "A valid refresh token is required");
  if (row.revoked_at) fail(401, "MOBILE_TOKEN_REVOKED", "This mobile session was revoked");
  if (row.refresh_expires_at && Date.parse(row.refresh_expires_at) <= Date.now()) {
    fail(401, "MOBILE_REFRESH_EXPIRED", "This refresh token has expired; a new session must be minted");
  }
  const access_token = randomHex(32);
  const next_refresh = randomHex(32);
  const expires_at = new Date(Date.now() + MOBILE_ACCESS_TTL_MS).toISOString();
  const rotation_count = (Number(row.rotation_count) || 0) + 1;
  const claim = await svc.entities.MobileRuntimeSession.updateMany(
    { id: row.id, refresh_hash: currentHash },
    { $set: {
      token_hash: await sha256(access_token), refresh_hash: await sha256(next_refresh),
      expires_at, refresh_expires_at: new Date(Date.now() + MOBILE_REFRESH_TTL_MS).toISOString(),
      last_used_at: nowIso(), rotation_count,
    } },
  );
  if (!Number(claim?.updated || 0)) fail(409, "MOBILE_REFRESH_ALREADY_USED", "This refresh token was already used");
  await audit(svc, {
    workspace_id: row.workspace_id, project_id: row.project_id, user_id: row.created_by,
    action: "mobile_runtime.refresh_used", resource: "MobileRuntimeSession", resource_id: row.id,
    metadata: { rotation_count },
  });
  return { access_token, refresh_token: next_refresh, expires_at, session_id: row.id, project_id: row.project_id };
}

/**
 * Revokes a session (by id, or by refresh token — a device may retire its own credential).
 * A member may always revoke their OWN session; revoking someone else's requires deploy.manage.
 * Revocation is allowed on a suspended workspace too — taking access away is a safety action.
 */
export async function revokeMobileRuntimeSession(base44, user, { session_id = null, refresh_token = null } = {}) {
  const svc = base44.asServiceRole || base44;
  let row = null;
  if (session_id) row = await svc.entities.MobileRuntimeSession.get(String(session_id)).catch(() => null);
  if (!row && typeof refresh_token === "string" && TOKEN_RE.test(refresh_token)) {
    [row] = await svc.entities.MobileRuntimeSession.filter({ refresh_hash: await sha256(refresh_token) }, "-created_date", 1).catch(() => []);
    row = row || null;
  }
  if (!row) return { revoked: false, reason: "not_found" };
  if (row.revoked_at) return { revoked: false, reason: "already_revoked" };
  const workspace = await svc.entities.Workspace.get(row.workspace_id).catch(() => null);
  if (!workspace) return { revoked: false, reason: "not_found" };
  const role = await resolveRole(base44, workspace, user);
  if (!role) fail(403, "NOT_A_MEMBER", "Forbidden");
  if (row.created_by !== user.id) requireCapability(role, "deploy.manage");
  await svc.entities.MobileRuntimeSession.update(row.id, { revoked_at: nowIso(), revoke_reason: "revoked_by_member" }).catch(() => {});
  await audit(svc, {
    workspace_id: row.workspace_id, project_id: row.project_id, user_id: user.id,
    action: "mobile_runtime.token_revoked", resource: "MobileRuntimeSession", resource_id: row.id,
    metadata: { own_session: row.created_by === user.id },
  });
  return { revoked: true, session_id: row.id };
}