// Roles, permissions and team (tenant) isolation for generated-app end-users (#29).
//
// Evaluated SERVER-side only. A role is a project-defined AppRole row; a user holds role keys on
// its AppUser row; permissions are `resource.action` strings with `*` wildcards. Nothing a client
// sends (a role claim, a team id it does not belong to) participates in a decision — every check
// re-reads the authoritative rows for THIS project. Teams are the app's tenant boundary: a user
// only ever sees teams it is an active member of, and a team never spans projects.
import { scrubText } from "./tracing.ts";
import { fail, nowIso, getAppUser, recordAuthEvent } from "./appAuth.ts";

export const ACCESS_CONTRACT_VERSION = "nexusai-app-access-1";
export const SYSTEM_ROLES = Object.freeze({
  user: { name: "User", permissions: ["profile.*", "team.read"] },
  admin: { name: "Administrator", permissions: ["*"] },
});
export const TEAM_ROLES = ["owner", "admin", "member"];

export function permissionMatches(granted, wanted) {
  const g = String(granted || ""), w = String(wanted || "");
  if (g === "*" || g === w) return true;
  if (g.endsWith(".*")) return w.startsWith(g.slice(0, -1));
  return false;
}

/** Ensures the two system roles exist for a project. Idempotent. */
export async function ensureSystemRoles(svc, project) {
  const rows = await svc.entities.AppRole.filter({ project_id: project.id }, "key", 100).catch(() => []);
  for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
    if (rows.some((r) => r.key === key)) continue;
    rows.push(await svc.entities.AppRole.create({ project_id: project.id, workspace_id: project.workspace_id || null, key, name: def.name, permissions: [...def.permissions], system: true, created_at: nowIso(), updated_at: nowIso() }));
  }
  return rows;
}

export const listRoles = async (svc, project) => (await ensureSystemRoles(svc, project))
  .map((r) => ({ key: r.key, name: r.name || r.key, description: r.description || "", permissions: r.permissions || [], system: !!r.system }));

/** Resolves the effective permission set of a user from its project roles. */
export async function resolvePermissions(svc, project, user) {
  const roles = await ensureSystemRoles(svc, project);
  const held = Array.isArray(user?.roles) && user.roles.length ? user.roles : ["user"];
  const perms = new Set();
  for (const r of roles) if (held.includes(r.key)) for (const p of r.permissions || []) perms.add(String(p));
  return { roles: held, permissions: [...perms] };
}

export const can = (permissions, wanted) => (permissions || []).some((g) => permissionMatches(g, wanted));

// --- role administration (requires roles.manage) ---------------------------------------------
const requirePerm = (ctxPerms, wanted) => { if (!can(ctxPerms, wanted)) fail(403, "FORBIDDEN", `Missing permission ${wanted}`); };
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export async function defineRole(svc, project, actor, { key, name, description, permissions } = {}, meta = {}) {
  requirePerm(actor.permissions, "roles.manage");
  const k = String(key || "");
  if (!ROLE_KEY_RE.test(k)) fail(400, "ROLE_KEY_INVALID", "Role key must be lowercase letters, digits or underscores");
  const perms = (Array.isArray(permissions) ? permissions : []).map((p) => scrubText(String(p), 80)).filter((p) => /^[a-z0-9_.*]+$/.test(p)).slice(0, 100);
  const rows = await ensureSystemRoles(svc, project);
  const existing = rows.find((r) => r.key === k);
  if (existing?.system) fail(409, "ROLE_SYSTEM", "System roles cannot be redefined");
  const doc = { name: scrubText(name || k, 80), description: scrubText(description || "", 300), permissions: perms, updated_at: nowIso() };
  const saved = existing ? await svc.entities.AppRole.update(existing.id, doc) : await svc.entities.AppRole.create({ project_id: project.id, workspace_id: project.workspace_id || null, key: k, system: false, created_at: nowIso(), ...doc });
  await recordAuthEvent(svc, project, { action: existing ? "role_updated" : "role_defined", resource: "AppRole", resource_id: saved.id, metadata: { app_user_id: actor.user.id, key: k, permission_count: perms.length }, meta });
  return { key: saved.key, name: saved.name, description: saved.description || "", permissions: saved.permissions || [], system: false };
}

export async function assignRoles(svc, project, actor, { app_user_id, roles } = {}, meta = {}) {
  requirePerm(actor.permissions, "roles.manage");
  const target = await getAppUser(svc, project, app_user_id);
  if (!target) fail(404, "USER_NOT_FOUND", "User not found");
  const known = new Set((await ensureSystemRoles(svc, project)).map((r) => r.key));
  const next = [...new Set((Array.isArray(roles) ? roles : []).map(String))];
  const unknown = next.filter((r) => !known.has(r));
  if (unknown.length) fail(400, "ROLE_UNKNOWN", `Unknown role(s): ${unknown.join(", ")}`);
  const saved = await svc.entities.AppUser.update(target.id, { roles: next.length ? next : ["user"], updated_at: nowIso() });
  await recordAuthEvent(svc, project, { action: "roles_assigned", resource_id: target.id, metadata: { app_user_id: target.id, by: actor.user.id, roles: saved.roles }, meta });
  return { app_user_id: target.id, roles: saved.roles };
}

export async function setUserStatus(svc, project, actor, { app_user_id, status } = {}, meta = {}) {
  requirePerm(actor.permissions, "users.manage");
  if (!["active", "disabled", "revoked"].includes(String(status))) fail(400, "STATUS_INVALID", "Status must be active, disabled or revoked");
  const target = await getAppUser(svc, project, app_user_id);
  if (!target) fail(404, "USER_NOT_FOUND", "User not found");
  await svc.entities.AppUser.update(target.id, { status: String(status), updated_at: nowIso() });
  let revoked = 0;
  if (status !== "active") {
    const { revokeUserSessions } = await import("./appAuth.ts");
    revoked = await revokeUserSessions(svc, project, target.id, { reason: `account_${status}` });
  }
  await recordAuthEvent(svc, project, { action: "user_status_changed", resource_id: target.id, metadata: { app_user_id: target.id, by: actor.user.id, status, sessions_revoked: revoked }, meta });
  return { app_user_id: target.id, status: String(status), sessions_revoked: revoked };
}

// --- teams / tenants -------------------------------------------------------------------------------
const publicTeam = (t, membership = null) => ({ id: t.id, name: t.name, slug: t.slug || null, status: t.status, created_at: t.created_at || t.created_date, ...(membership ? { role: membership.role } : {}) });

async function ownedTeam(svc, project, teamId) {
  const team = await svc.entities.AppTeam.get(String(teamId || "")).catch(() => null);
  if (!team || team.project_id !== project.id || team.status !== "active") fail(404, "TEAM_NOT_FOUND", "Team not found");
  return team;
}
export async function membershipOf(svc, project, teamId, userId) {
  const [row] = await svc.entities.AppTeamMember.filter({ project_id: project.id, team_id: String(teamId), app_user_id: String(userId), status: "active" }, "-created_date", 1).catch(() => []);
  return row || null;
}
/** The team, but ONLY if the user is an active member. A foreign team is "not found". */
export async function requireTeamMember(svc, project, user, teamId, { roles = null } = {}) {
  const team = await ownedTeam(svc, project, teamId);
  const membership = await membershipOf(svc, project, team.id, user.id);
  if (!membership) fail(404, "TEAM_NOT_FOUND", "Team not found");
  if (roles && !roles.includes(membership.role)) fail(403, "TEAM_FORBIDDEN", `Requires team role ${roles.join(" or ")}`);
  return { team, membership };
}

export async function createTeam(svc, project, user, { name, slug } = {}, meta = {}) {
  const n = scrubText(name || "", 100).trim();
  if (!n) fail(400, "TEAM_NAME_REQUIRED", "A team name is required");
  const team = await svc.entities.AppTeam.create({ project_id: project.id, workspace_id: project.workspace_id || null, name: n, slug: slug ? String(slug).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60) : null, status: "active", created_by: user.id, created_at: nowIso() });
  const membership = await svc.entities.AppTeamMember.create({ project_id: project.id, team_id: team.id, app_user_id: user.id, role: "owner", status: "active", created_at: nowIso(), updated_at: nowIso() });
  await recordAuthEvent(svc, project, { action: "team_created", resource: "AppTeam", resource_id: team.id, metadata: { app_user_id: user.id }, meta });
  return publicTeam(team, membership);
}

export async function listTeams(svc, project, user) {
  const memberships = await svc.entities.AppTeamMember.filter({ project_id: project.id, app_user_id: user.id, status: "active" }, "-created_date", 100).catch(() => []);
  const out = [];
  for (const m of memberships) {
    const team = await svc.entities.AppTeam.get(m.team_id).catch(() => null);
    if (team && team.project_id === project.id && team.status === "active") out.push(publicTeam(team, m));
  }
  return out;
}

export async function addTeamMember(svc, project, actor, { team_id, app_user_id, role = "member" } = {}, meta = {}) {
  const { team } = await requireTeamMember(svc, project, actor, team_id, { roles: ["owner", "admin"] });
  if (!TEAM_ROLES.includes(String(role))) fail(400, "TEAM_ROLE_INVALID", `Team role must be ${TEAM_ROLES.join(", ")}`);
  const target = await getAppUser(svc, project, app_user_id);
  if (!target) fail(404, "USER_NOT_FOUND", "User not found");
  const existing = await membershipOf(svc, project, team.id, target.id);
  const saved = existing
    ? await svc.entities.AppTeamMember.update(existing.id, { role: String(role), updated_at: nowIso() })
    : await svc.entities.AppTeamMember.create({ project_id: project.id, team_id: team.id, app_user_id: target.id, role: String(role), status: "active", created_at: nowIso(), updated_at: nowIso() });
  await recordAuthEvent(svc, project, { action: "team_member_added", resource: "AppTeamMember", resource_id: saved.id, metadata: { app_user_id: target.id, by: actor.id, team_id: team.id, role: saved.role }, meta });
  return { team_id: team.id, app_user_id: target.id, role: saved.role };
}

export async function removeTeamMember(svc, project, actor, { team_id, app_user_id } = {}, meta = {}) {
  const { team } = await requireTeamMember(svc, project, actor, team_id, { roles: ["owner", "admin"] });
  const existing = await membershipOf(svc, project, team.id, app_user_id);
  if (!existing) fail(404, "USER_NOT_FOUND", "Not a member of this team");
  if (existing.role === "owner") fail(409, "TEAM_OWNER_REQUIRED", "The team owner cannot be removed");
  await svc.entities.AppTeamMember.update(existing.id, { status: "removed", updated_at: nowIso() });
  await recordAuthEvent(svc, project, { action: "team_member_removed", resource: "AppTeamMember", resource_id: existing.id, metadata: { app_user_id: String(app_user_id), by: actor.id, team_id: team.id }, meta });
  return { ok: true };
}

export async function listTeamMembers(svc, project, user, teamId) {
  const { team } = await requireTeamMember(svc, project, user, teamId);
  const rows = await svc.entities.AppTeamMember.filter({ project_id: project.id, team_id: team.id, status: "active" }, "created_date", 200).catch(() => []);
  const out = [];
  for (const m of rows) {
    const u = await getAppUser(svc, project, m.app_user_id);
    out.push({ app_user_id: m.app_user_id, role: m.role, display_name: u?.display_name || "", email: u?.email || "" });
  }
  return out;
}