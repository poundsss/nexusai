// G-2 — Workspace lifecycle enforcement.
//
// Verifies that a non-active workspace (suspended / terminated) is read-only across the
// control plane: reads of status, members and project state stay available to an
// already-authorized caller, while project mutations, AI runs, deployments, MCP/integration
// changes, secret changes, membership changes and billing writes all fail closed with
// WORKSPACE_INACTIVE. An active workspace — including rows created before the lifecycle field
// existed — behaves exactly as before. Everything runs against real rows and is cleaned up.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requireActiveWorkspace, LIFECYCLE_READ_CAPABILITIES } from "../../shared/rbac.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { createProjectForUser } from "../../shared/projectCreate.ts";
import { inviteMember, listMembers, archiveProject } from "../../shared/collaboration.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { assertPublicServing } from "../../shared/deploy.ts";
import { makeChecks } from "../../shared/testChecklist.ts";

// A deployed app leaves serving rows (deployment, artifact, version, files, audit). The
// workspace/project deletes below do not cascade to them, so purge them explicitly.
async function purgeProjectServingRows(svc, projectId) {
  for (const entity of ["Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "AuditLog", "Build"]) {
    await svc.entities[entity].deleteMany({ project_id: projectId }).catch(() => {});
  }
  await svc.entities.Project.delete(projectId).catch(() => {});
}

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const { checks, ok, bad, expect, denied, allowed } = makeChecks();
  const cleanup = [];

  try {
    // --- 1. the shared guard itself (pure) -----------------------------------
    await allowed("guard_active_unchanged", () => requireActiveWorkspace({ status: "active" }, "project.write"));
    await allowed("guard_legacy_row_active", () => requireActiveWorkspace({ name: "old" }, "project.write"));
    await allowed("guard_null_workspace_passthrough", () => requireActiveWorkspace(null, "project.write"));
    await denied("guard_suspended_mutation", () => requireActiveWorkspace({ status: "suspended" }, "project.write"));
    await denied("guard_terminated_mutation", () => requireActiveWorkspace({ status: "terminated" }, "project.write"));
    await denied("guard_null_capability_is_mutation", () => requireActiveWorkspace({ status: "suspended" }));
    await allowed("guard_suspended_read", () => requireActiveWorkspace({ status: "suspended" }, "project.read"));
    await allowed("guard_terminated_read", () => requireActiveWorkspace({ status: "terminated" }, "billing.read"));
    expect("guard_read_set", ["project.read", "billing.read", "marketplace.read", "compliance.read", "sso.read"].every((c) => LIFECYCLE_READ_CAPABILITIES.includes(c)), LIFECYCLE_READ_CAPABILITIES.join(","));

    // --- 2. real workspace + project + owner ----------------------------------
    const ownerId = `g2-owner-${crypto.randomUUID().slice(0, 8)}`;
    const owner = { id: ownerId, email: "owner@g2.test" };
    const workspace = await svc.entities.Workspace.create({ name: "G2 Lifecycle Workspace", owner_id: ownerId, credits_balance: 0, status: "active" });
    cleanup.push(() => svc.entities.Workspace.delete(workspace.id));
    const project = await svc.entities.Project.create({ workspace_id: workspace.id, name: "G2 Project", status: "draft" });
    cleanup.push(() => svc.entities.Project.delete(project.id));
    await svc.entities.ProjectFile.create({ project_id: project.id, path: "src/main.js", content: "export default () => 'ok';" });

    // The ONE choke point every project-scoped surface funnels through, exercised with the
    // exact capabilities those surfaces declare: project.write (AI runs, file/entity edits,
    // builds), deploy.manage (deployments), secret.manage (projectSecrets), integration.manage.
    const authz = async (capability) => {
      try { await loadAuthorizedProject(svc, owner, project.id, capability); return { allowed: true }; }
      catch (e) { return { allowed: false, status: e.status, code: e.code }; }
    };

    // --- 3. ACTIVE: existing behavior unchanged ------------------------------
    for (const cap of ["project.read", "project.write", "deploy.manage", "secret.manage", "integration.manage"]) {
      const r = await authz(cap);
      expect(`active_${cap}`, r.allowed, r.allowed ? "allowed" : `${r.status} ${r.code}`);
    }
    const members = await listMembers(svc, owner, workspace.id);
    expect("active_member_list_read", members.role === "owner", `role=${members.role}`);
    const created = await createProjectForUser(svc, owner, { workspace_id: workspace.id, name: "G2 Active Project" });
    cleanup.push(() => svc.entities.Project.delete(created.project.id));
    expect("active_project_create", !!created.project.id, `project ${created.project.id}`);

    // --- 4. SUSPENDED: mutations fail closed, reads stay ----------------------
    await svc.entities.Workspace.update(workspace.id, { status: "suspended" });
    for (const cap of ["project.write", "deploy.manage", "secret.manage", "integration.manage"]) {
      const r = await authz(cap);
      expect(`suspended_${cap}_denied`, !r.allowed && r.status === 403 && r.code === "WORKSPACE_INACTIVE", `${r.status} ${r.code}`);
    }
    const readSuspended = await authz("project.read");
    expect("suspended_project_read_stays", readSuspended.allowed, "read stays available");
    expect("suspended_member_list_stays", (await listMembers(svc, owner, workspace.id)).role === "owner", "membership read stays");
    await denied("suspended_project_create_denied", () => createProjectForUser(svc, owner, { workspace_id: workspace.id, name: "G2 Suspended Project" }));
    await denied("suspended_member_invite_denied", () => inviteMember(svc, owner, { workspace_id: workspace.id, email: "invitee@g2.test", role: "viewer" }));
    const noInvite = await svc.entities.WorkspaceMember.filter({ workspace_id: workspace.id, email: "invitee@g2.test" }, "-created_date", 5);
    expect("suspended_invite_no_row", noInvite.length === 0, "a denied invite creates nothing");

    // --- 5. TERMINATED: same deny behavior, fail closed ------------------------
    await svc.entities.Workspace.update(workspace.id, { status: "terminated" });
    for (const cap of ["project.write", "deploy.manage", "secret.manage", "integration.manage"]) {
      const r = await authz(cap);
      expect(`terminated_${cap}_denied`, !r.allowed && r.status === 403 && r.code === "WORKSPACE_INACTIVE", `${r.status} ${r.code}`);
    }
    expect("terminated_project_read_stays", (await authz("project.read")).allowed, "read stays available");
    await denied("terminated_project_create_denied", () => createProjectForUser(svc, owner, { workspace_id: workspace.id, name: "G2 Terminated Project" }));
    await denied("terminated_member_invite_denied", () => inviteMember(svc, owner, { workspace_id: workspace.id, email: "invitee2@g2.test", role: "viewer" }));

    // --- 6. recovery: returning to active restores previous behavior -----------
    await svc.entities.Workspace.update(workspace.id, { status: "active" });
    expect("recovered_write_again", (await authz("project.write")).allowed, "an unsuspended workspace mutates again");

    // --- 7. PUBLIC SERVING lifecycle gate (G-2 at the runtime choke point) ------
    // A REAL deployed app: slug → LIVE production deployment → immutable artifact, driven
    // through the actual appRuntime endpoint via the canonical caller.
    const deployed = await createDeployedApp(svc, {
      workspace_id: workspace.id, name: "G2 Serving App", slug: `g2serve-${crypto.randomUUID().slice(0, 8)}`,
      deployed_by: ownerId,
    });
    cleanup.push(() => purgeProjectServingRows(svc, deployed.project.id));
    expect("serving_deploy_live", deployed.run.status === "LIVE", deployed.run.status);
    const call = appRuntimeCaller(svc);
    const servedActive = await call({ action: "artifact", slug: deployed.project.slug });
    expect("serving_active_ok", servedActive.ok === true, JSON.stringify(servedActive).slice(0, 200));
    // The gate itself, exercised directly — the exact code the public runtime resolves
    // through (imported from the same shared module), against real rows.
    const gate = async (proj) => {
      try { await assertPublicServing(svc, proj); return { allowed: true }; }
      catch (e) { return { allowed: false, status: e.status, code: e.code }; }
    };
    await svc.entities.Workspace.update(workspace.id, { status: "suspended" });
    const gateSuspended = await gate(deployed.project);
    expect("serving_gate_suspended_refused", !gateSuspended.allowed && gateSuspended.status === 402, `${gateSuspended.status} ${gateSuspended.code}`);
    await svc.entities.Workspace.update(workspace.id, { status: "terminated" });
    const gateTerminated = await gate(deployed.project);
    expect("serving_gate_terminated_refused", !gateTerminated.allowed && gateTerminated.status === 402, `${gateTerminated.status} ${gateTerminated.code}`);
    await svc.entities.Workspace.update(workspace.id, { status: "active" });
    const gateRecovered = await gate(deployed.project);
    expect("serving_gate_recovered_ok", gateRecovered.allowed === true, "gate allows an active workspace again");
    const servedRecovered = await call({ action: "artifact", slug: deployed.project.slug });
    expect("serving_recovered_ok", servedRecovered.ok === true, JSON.stringify(servedRecovered).slice(0, 160));

    // --- 8. archive: the project.delete capability (owner/admin only) -----------
    const viewer = { id: `g2-viewer-${crypto.randomUUID().slice(0, 8)}`, email: "viewer@g2.test" };
    const viewerRow = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active" });
    cleanup.push(() => svc.entities.WorkspaceMember.delete(viewerRow.id));
    await denied("archive_viewer_denied", () => archiveProject(svc, viewer, deployed.project.id), "INSUFFICIENT_ROLE");
    const admin = { id: `g2-admin-${crypto.randomUUID().slice(0, 8)}`, email: "admin@g2.test" };
    const adminRow = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: admin.email, user_id: admin.id, role: "admin", status: "active" });
    cleanup.push(() => svc.entities.WorkspaceMember.delete(adminRow.id));
    const archivedAdmin = await archiveProject(svc, admin, deployed.project.id);
    expect("archive_admin_allowed", archivedAdmin.archived === true, archivedAdmin.slug || "");
    const afterArchive = await svc.entities.Project.get(deployed.project.id);
    expect("archive_tombstone_status", afterArchive.status === "archived", afterArchive.status);
    const gateArchived = await gate(afterArchive);
    expect("serving_gate_archived_refused", !gateArchived.allowed && gateArchived.status === 404, `${gateArchived.status} ${gateArchived.code}`);
    const archiveAudits = await svc.entities.AuditLog.filter({ project_id: deployed.project.id, action: "project.archived" }, "-created_date", 5);
    expect("archive_audited", archiveAudits.length === 1, `${archiveAudits.length} audit rows`);

    const failed = checks.filter((c) => !c.ok);
    return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, failed, results: checks });
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }
}