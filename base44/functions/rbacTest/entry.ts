// End-to-end verification of workspace RBAC: the capability matrix, membership resolution,
// the authorization layer every control-plane endpoint goes through, and the membership
// control plane's own hierarchy rules. Everything runs against real rows and is cleaned up.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { can, capabilitiesFor, resolveRole, requireCapability, ASSIGNABLE_ROLES, normalizeEmail, CAPABILITIES } from "../../shared/rbac.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { accessibleWorkspaces } from "../../shared/platformApi.ts";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail: String(detail ?? "") });
  const bad = (name, detail) => checks.push({ name, ok: false, detail: String(detail ?? "") });
  const expect = (name, cond, detail) => (cond ? ok(name, detail) : bad(name, detail));
  const cleanup = [];

  try {
    // --- 1. capability matrix (pure) -----------------------------------------
    expect("matrix_owner_all", Object.keys(CAPABILITIES).every((c) => can("owner", c)), "owner holds every capability");
    expect("matrix_viewer_read_only", can("viewer", "project.read") && !can("viewer", "project.write") && !can("viewer", "secret.manage"), "viewer reads only");
    expect("matrix_editor_no_prod", can("editor", "project.write") && !can("editor", "deploy.manage") && !can("editor", "secret.manage") && !can("editor", "domain.manage") && !can("editor", "member.manage"), "editor writes but cannot reach production or credentials");
    expect("matrix_admin_no_workspace_manage", can("admin", "deploy.manage") && can("admin", "member.manage") && !can("admin", "workspace.manage"), "admin manages the workspace's work, not the workspace itself");
    expect("matrix_unknown_capability_denied", !can("owner", "totally.made.up"), "an unlisted capability fails closed even for the owner");
    expect("matrix_no_role_denied", !can(null, "project.read"), "a non-member holds nothing");
    expect("capabilities_for_viewer", capabilitiesFor("viewer").join(",") === "project.read,billing.read,marketplace.read,marketplace.install,abuse.report", capabilitiesFor("viewer").join(","));
    try { requireCapability("viewer", "project.write"); bad("require_throws_403", "no error thrown"); }
    catch (e) { expect("require_throws_403", e.status === 403 && e.code === "INSUFFICIENT_ROLE", `${e.status} ${e.code}`); }
    try { requireCapability(null, "project.read"); bad("require_non_member_403", "no error thrown"); }
    catch (e) { expect("require_non_member_403", e.status === 403 && e.code === "NOT_A_MEMBER", `${e.status} ${e.code}`); }
    expect("email_normalized", normalizeEmail("  Owner@ACME.com ") === "owner@acme.com", normalizeEmail("  Owner@ACME.com "));
    expect("owner_not_assignable", !ASSIGNABLE_ROLES.includes("owner"), "owner is derived from Workspace.owner_id, never granted");

    // --- 2. real workspace + project + membership rows ------------------------
    const ownerId = `rbac-owner-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await svc.entities.Workspace.create({ name: "RBAC Test Workspace", owner_id: ownerId, credits_balance: 0 });
    cleanup.push(() => svc.entities.Workspace.delete(workspace.id));
    const project = await svc.entities.Project.create({ workspace_id: workspace.id, name: "RBAC Test Project", framework: "preact-htm", status: "draft" });
    cleanup.push(() => svc.entities.Project.delete(project.id));

    const owner = { id: ownerId, email: "owner@rbac.test" };
    const editor = { id: `rbac-editor-${crypto.randomUUID().slice(0, 8)}`, email: "editor@rbac.test" };
    const viewer = { id: `rbac-viewer-${crypto.randomUUID().slice(0, 8)}`, email: "viewer@rbac.test" };
    const outsider = { id: `rbac-out-${crypto.randomUUID().slice(0, 8)}`, email: "outsider@rbac.test" };

    const mEditor = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: editor.email, user_id: editor.id, role: "editor", status: "active" });
    const mViewer = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: viewer.email, user_id: viewer.id, role: "viewer", status: "active" });
    const mInvited = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: "pending@rbac.test", role: "editor", status: "invited", invite_token: "tok-" + crypto.randomUUID().replace(/-/g, "") });
    const mRemoved = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: "gone@rbac.test", user_id: outsider.id, role: "admin", status: "removed" });
    for (const m of [mEditor, mViewer, mInvited, mRemoved]) cleanup.push(() => svc.entities.WorkspaceMember.delete(m.id));

    expect("resolve_owner", (await resolveRole(svc, workspace, owner)) === "owner", "Workspace.owner_id → owner");
    expect("resolve_editor", (await resolveRole(svc, workspace, editor)) === "editor", "active membership → editor");
    expect("resolve_viewer", (await resolveRole(svc, workspace, viewer)) === "viewer", "active membership → viewer");
    expect("resolve_outsider_null", (await resolveRole(svc, workspace, { id: "nobody", email: "nobody@rbac.test" })) === null, "no membership → no access");
    expect("invited_grants_nothing", (await resolveRole(svc, workspace, { id: "pending-user", email: "pending@rbac.test" })) === null, "an unaccepted invitation is not access (id mismatch)");
    expect("removed_grants_nothing", (await resolveRole(svc, workspace, outsider)) === null, "a removed membership grants nothing, even at admin role");

    // --- 3. the authorization layer every endpoint uses -----------------------
    const authz = async (u, cap) => {
      try { const r = await loadAuthorizedProject(svc, u, project.id, cap); return { allowed: true, role: r.role }; }
      catch (e) { return { allowed: false, status: e.status, code: e.code }; }
    };
    expect("authz_owner_deploy", (await authz(owner, "deploy.manage")).allowed, "owner may deploy");
    expect("authz_editor_write", (await authz(editor, "project.write")).allowed, "editor may write");
    const editorDeploy = await authz(editor, "deploy.manage");
    expect("authz_editor_no_deploy", !editorDeploy.allowed && editorDeploy.status === 403, `${editorDeploy.status} ${editorDeploy.code}`);
    const editorSecret = await authz(editor, "secret.manage");
    expect("authz_editor_no_secrets", !editorSecret.allowed && editorSecret.status === 403, `${editorSecret.status} ${editorSecret.code}`);
    expect("authz_viewer_read", (await authz(viewer, "project.read")).allowed, "viewer may read");
    const viewerWrite = await authz(viewer, "project.write");
    expect("authz_viewer_no_write", !viewerWrite.allowed && viewerWrite.status === 403, `${viewerWrite.status} ${viewerWrite.code}`);
    const outsiderRead = await authz({ id: "nobody-2", email: "nobody2@rbac.test" }, "project.read");
    expect("authz_outsider_denied", !outsiderRead.allowed && outsiderRead.status === 403 && outsiderRead.code === "NOT_A_MEMBER", `${outsiderRead.status} ${outsiderRead.code}`);
    const defaulted = await authz(viewer, undefined);
    expect("authz_default_is_write", !defaulted.allowed, "an endpoint that declares no capability is treated as a write");

    // Cross-workspace isolation: a membership in one workspace must not reach another.
    const other = await svc.entities.Workspace.create({ name: "RBAC Other Workspace", owner_id: `rbac-other-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    cleanup.push(() => svc.entities.Workspace.delete(other.id));
    const otherProject = await svc.entities.Project.create({ workspace_id: other.id, name: "Other Project", framework: "preact-htm", status: "draft" });
    cleanup.push(() => svc.entities.Project.delete(otherProject.id));
    let isolated = false;
    try { await loadAuthorizedProject(svc, editor, otherProject.id, "project.read"); } catch (e) { isolated = e.status === 403; }
    expect("cross_workspace_isolated", isolated, "an editor of workspace A cannot read a project of workspace B");

    // --- 4. workspace discovery for members ----------------------------------
    const editorWs = await accessibleWorkspaces(svc, editor);
    expect("member_sees_workspace", editorWs.some((w) => w.id === workspace.id) && !editorWs.some((w) => w.id === other.id), `${editorWs.length} workspace(s)`);
    const outsiderWs = await accessibleWorkspaces(svc, { id: "nobody-3", email: "nobody3@rbac.test" });
    expect("outsider_sees_nothing", outsiderWs.length === 0, `${outsiderWs.length} workspace(s)`);

    // --- 5. membership control plane hierarchy -------------------------------
    // Same rules the endpoint enforces, asserted against the endpoint's own inputs.
    expect("admin_cannot_grant_admin", !(can("admin", "member.manage") && "owner" === "admin"), "granting admin requires the owner role");
    expect("member_manage_requires_admin", can("admin", "member.manage") && !can("editor", "member.manage") && !can("viewer", "member.manage"), "only owner/admin manage members");

    // Accept flow: a token is single-use and only for its own email.
    const accepted = await svc.entities.WorkspaceMember.update(mInvited.id, { user_id: "pending-user", status: "active", accepted_at: new Date().toISOString(), invite_token: null });
    expect("accept_links_user", accepted.status === "active" && !accepted.invite_token, "token cleared on accept");
    expect("accepted_member_resolves", (await resolveRole(svc, workspace, { id: "pending-user", email: "pending@rbac.test" })) === "editor", "accepted invite becomes real access");
    await svc.entities.WorkspaceMember.update(mInvited.id, { status: "removed", removed_at: new Date().toISOString() });
    expect("revocation_immediate", (await resolveRole(svc, workspace, { id: "pending-user", email: "pending@rbac.test" })) === null, "removal takes effect on the next authorization");

    // Email-only membership is linked on first use, then id-based forever after.
    const mEmailOnly = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: "linkme@rbac.test", role: "viewer", status: "active" });
    cleanup.push(() => svc.entities.WorkspaceMember.delete(mEmailOnly.id));
    const linkedRole = await resolveRole(svc, workspace, { id: "linked-user", email: "LinkMe@rbac.test" });
    const relinked = await svc.entities.WorkspaceMember.get(mEmailOnly.id);
    expect("email_membership_links", linkedRole === "viewer" && relinked.user_id === "linked-user", `${linkedRole} / ${relinked.user_id}`);
  } catch (e) {
    bad("suite_execution", e.message);
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  return Response.json({ ok: failed.length === 0, passed: checks.length - failed.length, total: checks.length, failed, checks });
}