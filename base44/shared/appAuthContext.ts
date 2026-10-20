// `ctx.auth` for generated backend functions, and the explicit execution identity recorded on
// every FunctionInvocation (#29).
//
// Identity kinds:
//   app_user  — an end-user resolved from a valid project session (frontend calls)
//   system    — the platform acting for the project (scheduled triggers, workflow steps)
//   service   — a verified webhook delivery
//   anonymous — a frontend call with no/invalid session, or a builder test call
// Recorded server-side from the resolved session and the trigger — never from the request body.
import { resolvePermissions, can, requireTeamMember, listTeams, membershipOf } from "./appAccess.ts";

export function executionIdentity({ user = null, session = null, trigger = "frontend" } = {}) {
  if (user?.id) return { kind: "app_user", app_user_id: user.id, session_id: session?.id || null, roles: Array.isArray(user.roles) ? user.roles : [], source: trigger };
  if (trigger === "scheduled" || trigger === "workflow") return { kind: "system", app_user_id: null, session_id: null, roles: [], source: trigger };
  // "function" (G-B): a service-role invoke — one backend function calling another with no
  // caller identity — records the SAME service identity an anonymous webhook delivery does.
  if (trigger === "webhook" || trigger === "webhook_retry" || trigger === "function") return { kind: "service", app_user_id: null, session_id: null, roles: [], source: trigger };
  return { kind: "anonymous", app_user_id: null, session_id: null, roles: [], source: trigger };
}

const deny = (code, message, status = 403) => Object.assign(new Error(message), { status, code });

/**
 * THE identity envelope handed to a generated app's FRONTEND.
 *
 * One shape, produced here, so the frontend and `ctx.auth` describe the same verified
 * generated-app user with the same semantics (authenticated · user · session · roles ·
 * permissions) — in the deployed runtime AND in the builder preview. It is a projection of an
 * already-resolved session: it decides nothing, carries no token and no credential, and an absent
 * session is stated as `authenticated: false` rather than as a platform identity.
 */
export function identityEnvelope({ user = null, session = null, permissions = [], roles = null } = {}) {
  if (!user?.id) return { authenticated: false, user: null, session: null, roles: [], permissions: [] };
  return {
    authenticated: true,
    user,
    session: session ? { id: session.id, expires_at: session.expires_at || null } : null,
    roles: Array.isArray(roles) ? roles : Array.isArray(user.roles) ? user.roles : [],
    permissions: Array.isArray(permissions) ? permissions : [],
  };
}

export function createAppAuthContext(client, { project, user = null, session = null, identity, trace_id = null }) {
  let permsPromise = null;
  const perms = () => {
    if (!user?.id) return Promise.resolve([]);
    if (!permsPromise) permsPromise = resolvePermissions(client, project, user).then((r) => r.permissions).catch(() => []);
    return permsPromise;
  };
  const requireUser = () => { if (!user?.id) throw deny("AUTH_REQUIRED", "Sign in required", 401); return user; };
  return {
    user, session: session ? { id: session.id, expires_at: session.expires_at || null } : null,
    identity: { ...identity }, trace_id,
    isAuthenticated: () => !!user?.id,
    requireUser,
    roles: () => (Array.isArray(user?.roles) ? [...user.roles] : []),
    hasRole: (role) => Array.isArray(user?.roles) && user.roles.includes(String(role)),
    requireRole: (role) => { requireUser(); if (!user.roles?.includes(String(role))) throw deny("FORBIDDEN", `Requires role ${role}`); return true; },
    permissions: () => perms(),
    can: async (permission) => can(await perms(), String(permission)),
    require: async (permission) => { requireUser(); if (!can(await perms(), String(permission))) throw deny("FORBIDDEN", `Missing permission ${permission}`); return true; },
    teams: {
      list: () => listTeams(client, project, requireUser()),
      membership: (team_id) => membershipOf(client, project, String(team_id), requireUser().id).then((m) => m ? { team_id: m.team_id, role: m.role } : null),
      require: (team_id, opts) => requireTeamMember(client, project, requireUser(), String(team_id), opts || {}).then(({ team, membership }) => ({ team_id: team.id, name: team.name, role: membership.role })),
    },
  };
}