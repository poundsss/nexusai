// Personal Access Tokens (PAT) + the public app-data REST read API (Phase 13A).
//
// DOCUMENTED (Base44): personal access tokens are created under Workspace Settings → Secrets →
// Personal access tokens; a token reaches all apps or one app, with full access or read-only.
// API requests authenticate with `Authorization: Bearer <PAT>`; account API keys were replaced
// (sunset 2026-10-15) and a token sent under the old header is rejected. This surface has no
// legacy header at all, so the documented reject behavior is structural: ONLY Bearer
// authenticates, every other credential form fails closed.
//
// SECURITY MODEL:
//   • the raw token exists ONCE, in the issue response — only its SHA-256 hash and a short
//     display prefix are persisted; no log, audit row or later response carries the raw value;
//   • issuance/revocation are owner/admin (secret.manage), G-2 lifecycle-gated, audited;
//   • authentication fails closed: missing / wrong scheme / malformed / unknown / revoked /
//     expired / wrong-scope tokens never resolve to anything;
//   • app-data reads delegate to the CERTIFIED entity read path (queryEntityRecords →
//     loadAuthorizedProject + createServerDb) — no forked entity implementation; the authorized
//     project id, never a caller input, bounds every query, so cross-project isolation and the
//     existing RLS/filter behavior are exactly the certified ones.
import { sha256Hex } from "./secretCrypto.ts";
import { audit } from "./authz.ts";
import { requireCapability, requireActiveWorkspace } from "./rbac.ts";
import { queryEntityRecords } from "./mcpServerTools.ts";

export class PatError extends Error {
  constructor(message, code = "PAT_ERROR", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const nowIso = () => new Date().toISOString();
const TOKEN_RE = /^nxpat_[a-f0-9]{64}$/;

function randomHex(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const newPatToken = () => `nxpat_${randomHex(32)}`;

// Metadata projection — identification only, never a usable credential or its hash.
export function tokenView(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, token_prefix: row.token_prefix || null,
    app_scope: row.app_scope, project_id: row.project_id || null,
    full_access: !!row.full_access, status: row.status,
    expires_at: row.expires_at || null, created_date: row.created_date,
    last_used_at: row.last_used_at || null, revoked_at: row.revoked_at || null,
  };
}

// --- control plane (owner/admin, G-2 gated, audited) ----------------------------

export async function issuePersonalAccessToken(svc, { workspace_id, name, app_scope = "all", project_id = null, full_access = false, expires_at = null, created_by = null }) {
  if (!workspace_id) throw new PatError("workspace_id is required", "PAT_NO_WORKSPACE");
  const workspace = await svc.entities.Workspace.get(workspace_id).catch(() => null);
  if (!workspace) throw new PatError("workspace not found", "PAT_NO_WORKSPACE", 404);
  // G-2: issuance is a mutation — a suspended/terminated workspace cannot mint tokens.
  requireActiveWorkspace(workspace, "secret.manage");
  const label = String(name || "").trim();
  if (!label) throw new PatError("name is required", "PAT_NO_NAME");
  if (!["all", "project"].includes(String(app_scope))) throw new PatError("app_scope must be 'all' or 'project'", "PAT_BAD_SCOPE");
  if (app_scope === "project") {
    const project = await svc.entities.Project.get(String(project_id || "")).catch(() => null);
    if (!project || project.workspace_id !== workspace_id) throw new PatError("The scoped app must belong to this workspace", "PAT_BAD_PROJECT");
  }
  let expiry = null;
  if (expires_at) {
    const t = Date.parse(expires_at);
    if (Number.isNaN(t) || t <= Date.now()) throw new PatError("expires_at must be a future timestamp", "PAT_BAD_EXPIRY");
    expiry = new Date(t).toISOString();
  }
  const raw = newPatToken();
  const row = await svc.entities.PersonalAccessToken.create({
    workspace_id, name: label.slice(0, 120), token_hash: await sha256Hex(raw), token_prefix: raw.slice(0, 12),
    app_scope, project_id: app_scope === "project" ? String(project_id) : null,
    full_access: !!full_access, status: "active", expires_at: expiry,
    created_by: created_by || null, created_at: nowIso(),
  });
  await audit(svc, { workspace_id, user_id: created_by || null, action: "pat.issued", resource: "PersonalAccessToken", resource_id: row.id, metadata: { app_scope, full_access: !!full_access } });
  return { token: raw, record: tokenView(row) };
}

export async function revokePersonalAccessToken(svc, { workspace_id, token_id, revoked_by = null }) {
  const workspace = await svc.entities.Workspace.get(workspace_id).catch(() => null);
  if (!workspace) throw new PatError("workspace not found", "PAT_NO_WORKSPACE", 404);
  requireActiveWorkspace(workspace, "secret.manage");
  const row = await svc.entities.PersonalAccessToken.get(String(token_id || "")).catch(() => null);
  if (!row || row.workspace_id !== workspace_id) throw new PatError("token not found", "PAT_NOT_FOUND", 404);
  if (row.status === "revoked") return { record: tokenView(row), already_revoked: true };
  const updated = await svc.entities.PersonalAccessToken.update(row.id, { status: "revoked", revoked_at: nowIso(), revoked_by: revoked_by || null });
  await audit(svc, { workspace_id, user_id: revoked_by || null, action: "pat.revoked", resource: "PersonalAccessToken", resource_id: row.id, metadata: {} });
  return { record: tokenView(updated), already_revoked: false };
}

export async function listPersonalAccessTokens(svc, { workspace_id }) {
  const rows = await svc.entities.PersonalAccessToken.filter({ workspace_id }, "-created_date", 100);
  return rows.map(tokenView);
}

// --- authentication (fail closed) ------------------------------------------------

export async function authenticatePersonalAccessToken(svc, authorization) {
  const header = String(authorization || "");
  if (!header.trim()) throw new PatError("Authorization header is required", "PAT_MISSING", 401);
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) throw new PatError("Only Authorization: Bearer is accepted", "PAT_MISSING", 401);
  const raw = m[1].trim();
  if (!TOKEN_RE.test(raw)) throw new PatError("The token format is not valid", "PAT_MALFORMED", 401);
  const row = (await svc.entities.PersonalAccessToken.filter({ token_hash: await sha256Hex(raw) }, "-created_date", 1))[0];
  if (!row) throw new PatError("The token is not valid", "PAT_INVALID", 401);
  if (row.status !== "active") throw new PatError("The token has been revoked", "PAT_REVOKED", 401);
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) throw new PatError("The token has expired", "PAT_EXPIRED", 401);
  return row;
}

// --- public app-data REST read (GET only) -----------------------------------------

/**
 * The documented REST read surface: `Authorization: Bearer <PAT>` against
 * `/api/apps/{app_id}/entities/{entity_name}` (this app's host serves it at its function
 * path; the path/query parsing lives in the endpoint). GET only — write operations are not
 * part of Phase 13A and are refused regardless of the token's full_access flag.
 */
export async function handlePublicAppDataGet(base44, { method, authorization, app_id, entity_name, filter = null, sort = null, limit = null, skip = 0 }) {
  if (String(method || "GET").toUpperCase() !== "GET") {
    throw new PatError("Only GET is supported on this endpoint", "METHOD_NOT_ALLOWED", 405);
  }
  const token = await authenticatePersonalAccessToken(base44.asServiceRole || base44, authorization);
  const svc = base44.asServiceRole || base44;
  if (!app_id) throw new PatError("app_id is required", "PAT_NO_APP");
  const project = await svc.entities.Project.get(String(app_id)).catch(() => null);
  if (!project) throw new PatError("Application not found", "APP_NOT_FOUND", 404);
  // DOCUMENTED scope semantics: one-app tokens are pinned to their app; all-apps tokens rely
  // on the account's own access, re-resolved by the certified authorization path below.
  if (token.app_scope === "project" && token.project_id !== project.id) {
    await audit(svc, { workspace_id: token.workspace_id, user_id: token.created_by || null, action: "pat.access_denied", resource: "PersonalAccessToken", resource_id: token.id, metadata: { reason: "scope_mismatch", app_id: String(app_id) } }).catch(() => {});
    throw new PatError("This token is not scoped to this app", "PAT_SCOPE_MISMATCH", 403);
  }
  // Delegation to the CERTIFIED read path: loadAuthorizedProject enforces workspace access
  // (isolation, active lifecycle) and createServerDb enforces the existing filter/RLS behavior.
  const result = await queryEntityRecords(base44, { id: token.created_by || null }, {
    project_id: project.id, entity: String(entity_name || ""),
    filter: filter && typeof filter === "object" ? filter : null,
    sort: sort || "-created_date",
    limit: Number(limit) || 25, skip: Number(skip) || 0,
  });
  // Throttled last-used stamp: audit metadata only.
  if (!token.last_used_at || Date.now() - Date.parse(token.last_used_at) > 60_000) {
    await svc.entities.PersonalAccessToken.update(token.id, { last_used_at: nowIso() }).catch(() => {});
  }
  return result;
}