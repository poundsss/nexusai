// G1: the BUILDER's App Users management surface for a generated application (#29).
//
// App Users are the END-USERS of a deployed generated app — a project-scoped identity layer
// deliberately separate from NexusAI platform/workspace users. This endpoint is the builder's
// control plane over those app users: list, role assignment, and enable/disable. It reuses
// ONLY existing certified contracts:
//   • loadAuthorizedProject  — the EXISTING builder authorization path (project.read / project.write)
//   • appAccess.assignRoles  — reuses the EXISTING roles.manage check (it RUNS, not bypassed)
//   • appAccess.setUserStatus — reuses the EXISTING users.manage check (it RUNS, not bypassed)
//   • appAuth.publicUser     — the EXISTING credential-free projection
//
// Authorization model (NEXUSAI-DERIVED bounded choice, documented for audit):
//   The builder is the project authority — loadAuthorizedProject established project.write before
//   any mutation. assignRoles/setUserStatus take an app-user `actor` carrying permissions and run
//   requirePerm(actor.permissions, "roles.manage"/"users.manage"). To REUSE those existing checks
//   without inventing new permissions, the builder is projected as an admin-equivalent app-user
//   actor (permissions: ["*"], roles: ["admin"]); the checks then execute and pass. The runtime
//   app-user surface (previewAuth / appRuntime) keeps its OWN, independent roles.manage /
//   users.manage enforcement unchanged — this endpoint does not influence it.
//
// No new entities, schemas, permission strings, or auth flows are introduced.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { publicUser, inviteAppUser } from "../../shared/appAuth.ts";
import { listRoles, assignRoles, setUserStatus } from "../../shared/appAccess.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    const capability = action === "list" ? "project.read" : "project.write";
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, capability);
    const svc = base44.asServiceRole || base44;

    if (action === "list") {
      const [users, roles, memberships, teams] = await Promise.all([
        svc.entities.AppUser.filter({ project_id: project.id }, "-created_date", 200).catch(() => []),
        listRoles(svc, project),
        svc.entities.AppTeamMember.filter({ project_id: project.id, status: "active" }, "-created_date", 500).catch(() => []),
        svc.entities.AppTeam.filter({ project_id: project.id, status: "active" }, "-created_date", 100).catch(() => []),
      ]);
      const teamName = new Map(teams.map((t) => [t.id, t.name || "Team"]));
      const teamsByUser = new Map();
      for (const m of memberships) {
        if (!m.app_user_id) continue;
        if (!teamsByUser.has(m.app_user_id)) teamsByUser.set(m.app_user_id, []);
        teamsByUser.get(m.app_user_id).push({ id: m.team_id, name: teamName.get(m.team_id) || "Team", role: m.role });
      }
      return Response.json({
        users: users.map((u) => ({ ...publicUser(u), teams: teamsByUser.get(u.id) || [] })),
        roles: roles.map((r) => ({ key: r.key, name: r.name || r.key, system: !!r.system })),
        // G1 group-access: the project's AppTeam rows (the app's existing group concept) with their
        // assigned app_role (absent → null). The builder assigns one existing app role per group.
        groups: teams.map((t) => ({ id: t.id, name: t.name || "Team", app_role: t.app_role || null })),
      });
    }

    // The builder, already authorized at project.write, is projected as an admin-equivalent app-user
    // actor so the EXISTING roles.manage / users.manage checks inside assignRoles / setUserStatus
    // execute against a real permission set rather than being bypassed.
    const actor = { user: { id: user.id }, permissions: ["*"], roles: ["admin"] };
    const meta = { user_agent: "nexusai-builder-app-users" };

    if (action === "assign_role") {
      const roles = Array.isArray(body.roles) ? body.roles : body.role != null ? [body.role] : [];
      if (!body.app_user_id) return Response.json({ error: "app_user_id is required" }, { status: 400 });
      const res = await assignRoles(svc, project, actor, { app_user_id: body.app_user_id, roles }, meta);
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "app_user.role_assigned", resource: "AppUser", resource_id: res.app_user_id, metadata: { roles: res.roles } }).catch(() => {});
      return Response.json({ app_user_id: res.app_user_id, roles: res.roles });
    }

    if (action === "set_status") {
      if (!body.app_user_id) return Response.json({ error: "app_user_id is required" }, { status: 400 });
      const res = await setUserStatus(svc, project, actor, { app_user_id: body.app_user_id, status: String(body.status || "") }, meta);
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "app_user.status_changed", resource: "AppUser", resource_id: res.app_user_id, metadata: { status: res.status, sessions_revoked: res.sessions_revoked } }).catch(() => {});
      return Response.json(res);
    }

    if (action === "review_access") {
      // Pending access-request review. Base44's exact pending workflow is UNKNOWN, so this maps the
      // builder's approve/deny onto the EXISTING certified setUserStatus primitive (users.manage):
      //   • approve → status "active" (idempotent confirmation; the existing email-verified OTP login
      //     gate is NOT touched — approval does not flip email_verified);
      //   • deny → status "revoked" (the existing session-revocation path fires).
      // No new status enum, permission, or notification is introduced. The pending list itself is a
      // CLIENT projection over email_verified=false (signed up / invited, not yet verified).
      if (!body.app_user_id) return Response.json({ error: "app_user_id is required" }, { status: 400 });
      const decision = String(body.decision || "");
      if (decision !== "approve" && decision !== "deny") return Response.json({ error: "decision must be approve or deny" }, { status: 400 });
      const status = decision === "approve" ? "active" : "revoked";
      const res = await setUserStatus(svc, project, actor, { app_user_id: body.app_user_id, status }, meta);
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: decision === "approve" ? "app_user.access_approved" : "app_user.access_denied", resource: "AppUser", resource_id: res.app_user_id, metadata: { status: res.status } }).catch(() => {});
      return Response.json(res);
    }

    if (action === "set_group_role") {
      // Group access: assign one existing app role to an AppTeam (the app's group). Reuses the
      // project's existing role model (validated against listRoles) and the builder's project.write
      // authority already established by loadAuthorizedProject. No new permission, no multi-role
      // (one app_role per group), no runtime permission resolution (certified checks unchanged).
      if (!body.team_id) return Response.json({ error: "team_id is required" }, { status: 400 });
      const role = String(body.role || "");
      const known = new Set((await listRoles(svc, project)).map((r) => r.key));
      if (!known.has(role)) return Response.json({ error: `Unknown role '${role}'` }, { status: 400 });
      const team = await svc.entities.AppTeam.get(String(body.team_id)).catch(() => null);
      if (!team || team.project_id !== project.id) return Response.json({ error: "Team not found" }, { status: 404 });
      await svc.entities.AppTeam.update(team.id, { app_role: role });
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "app_user.group_role_set", resource: "AppTeam", resource_id: team.id, metadata: { app_role: role } }).catch(() => {});
      return Response.json({ team_id: team.id, app_role: role });
    }

    if (action === "invite") {
      // Builder App-Users invite (the documented "App Users → invite users" surface). Reuses ONLY
      // the existing certified inviteAppUser primitive (G-5 proven Base44 inviteUser contract):
      // creates a passwordless AppUser, stamps the role, issues the existing single-use email-
      // verification token, and records the existing user_invited audit event. No new entity,
      // invite contract, status enum, or auth flow is introduced. The builder, already authorized
      // at project.write, is projected as an admin-equivalent inviter so the primitive's existing
      // caller-role check (only admins may invite admins) executes against a real role set.
      const email = String(body.user_email || "").trim();
      if (!email) return Response.json({ error: "user_email is required" }, { status: 400 });
      const role = String(body.role || "");
      if (!role) return Response.json({ error: "role is required" }, { status: 400 });
      const known = new Set((await listRoles(svc, project)).map((r) => r.key));
      if (!known.has(role)) return Response.json({ error: `Unknown role '${role}'` }, { status: 400 });
      const inviter = { id: user.id, roles: ["admin"] };
      const res = await inviteAppUser(svc, project, inviter, { user_email: email, role }, meta);
      await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "app_user.invited", resource: "AppUser", resource_id: res.user.id, metadata: { role, invitation_sent: res.invitation_sent } }).catch(() => {});
      return Response.json({ ok: true, user: res.user, invitation_sent: res.invitation_sent });
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}