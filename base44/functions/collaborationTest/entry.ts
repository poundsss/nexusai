// Certification for #36 — Collaboration.
//
// Runs the REAL production paths (shared/collaboration.ts → rbac → authz → planLimits →
// commitJournal → persistence → AuditLog) against throwaway workspaces. Nothing is mocked:
// the additional collaborators are ordinary WorkspaceMember rows and each one is exercised by
// calling the same functions an HTTP request calls, with THAT member's identity — so a viewer's
// refusal is the production capability matrix refusing, not a test assertion.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { discardWorkspaceProjects, caught } from "../../shared/testSupport.ts";
import {
  listMembers, inviteMember, acceptInvitation, updateMemberRole, removeMember,
  projectCollaborators, commitMemberEdit,
} from "../../shared/collaboration.ts";
import { resolveRole, capabilitiesFor, can } from "../../shared/rbac.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { createFs, writeFile } from "../../shared/projectFs.ts";
import { commitFiles, createVersion } from "../../shared/persistence.ts";
import { scaffoldFiles } from "../../shared/scaffold.ts";

const V2 = `import { html } from 'runtime';\n\nexport default function App() {\n  return html\`<div class="p-6">edited by a collaborator</div>\`;\n}\n`;
const V3 = `import { html } from 'runtime';\n\nexport default function App() {\n  return html\`<div class="p-8">a second edit</div>\`;\n}\n`;
const HOME = (label) => `import { html } from 'runtime';\n\nexport default function Home() {\n  return html\`<main>${label}</main>\`;\n}\n`;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();

  let workspace = null, otherWs = null, project = null, foreignProject = null;
  const cleanupMembers = [];

  // Collaborators other than the authenticated caller. Each is a real identity as far as the
  // production code is concerned: a user id + email that must resolve to a role from stored rows.
  const stamp = Date.now();
  const editor = { id: `u_editor_${stamp}`, email: `editor.${stamp}@example.com` };
  const viewer = { id: `u_viewer_${stamp}`, email: `viewer.${stamp}@example.com` };
  const admin = { id: `u_admin_${stamp}`, email: `admin.${stamp}@example.com` };
  const outsider = { id: `u_outsider_${stamp}`, email: `outsider.${stamp}@example.com` };

  const addMember = async (ws, user, role, status = "active") => {
    const row = await svc.entities.WorkspaceMember.create({
      workspace_id: ws.id, email: user.email, user_id: status === "invited" ? null : user.id,
      role, status, ...(status === "active" ? { accepted_at: new Date().toISOString() } : { invite_token: `t_${crypto.randomUUID().replace(/-/g, "")}` }),
    });
    cleanupMembers.push(row.id);
    return row;
  };
  const rowFor = async (ws, user) => (await svc.entities.WorkspaceMember.filter({ workspace_id: ws.id, email: user.email }, "-created_date", 1))[0];
  const versionCount = async () => (await svc.entities.Project.get(project.id)).version_count;
  const appContent = async () => (await svc.entities.ProjectFile.filter({ project_id: project.id, path: "src/App.js" }, "path", 1))[0]?.content;

  try {
    const owner = await base44.auth.me().catch(() => null);
    if (!owner) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `Collab ${stamp}`, owner_id: owner.id, credits_balance: 0, status: "active" });
    otherWs = await svc.entities.Workspace.create({ name: `Collab Foreign ${stamp}`, owner_id: `owner_other_${stamp}`, credits_balance: 0, status: "active" });

    // ================= 1. Seat limits (the free plan) =================
    // Catalog parity (appsMembersParityTest #0): seats were REMOVED from every plan's limits and
    // entitlements, so with no `seats` configured the enforcement is intentionally absent — the
    // free plan accepts a collaborator. The seats machinery itself stays certified by
    // planLimitsTest against plans that DO configure a limit.
    const invited = await inviteMember(base44, owner, { workspace_id: workspace.id, email: editor.email, role: "editor" });
    cleanupMembers.push(invited.member.id);
    h.check("1a. no plan-level seat ceiling: the free plan accepts a collaborator", invited.member.status === "invited" && invited.member.role === "editor", JSON.stringify(invited.member));

    // A paid subscription lifts the plan-gated resources the rest of the suite exercises.
    await svc.entities.Subscription.create({
      workspace_id: workspace.id, plan_code: "scale_monthly", status: "active", provider: "none",
      current_period_start: new Date(Date.now() - 86400000).toISOString(), current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
    });

    // ================= 2. Invite → accept → role change → revoke =================
    h.check("2a. an invitation is created as a pending claim", invited.member.status === "invited" && invited.member.role === "editor", JSON.stringify(invited.member));
    h.check("2b. the invite token is returned only to the inviter", typeof invited.invite_token === "string" && invited.invite_token.length >= 32, `${String(invited.invite_token).length} chars`);
    const listed = await listMembers(base44, owner, workspace.id);
    h.check("2c. a listing never carries the invite token", !JSON.stringify(listed).includes(invited.invite_token), "token absent");

    // A pending invitation grants nothing until it is accepted.
    h.check("2d. holding an unaccepted invitation grants NO access", (await resolveRole(base44, workspace, editor)) === null, "no role");

    const wrongEmail = await caught(() => acceptInvitation(base44, { id: "someone_else", email: "someone.else@example.com" }, { invite_token: invited.invite_token }));
    h.check("2e. a leaked token cannot be redeemed by a different email", wrongEmail?.code === "INVITE_EMAIL_MISMATCH" && wrongEmail?.status === 403, `${wrongEmail?.code}`);

    const accepted = await acceptInvitation(base44, editor, { invite_token: invited.invite_token });
    h.check("2f. the invited user can accept their own invitation", accepted.member.status === "active" && accepted.member.user_id === editor.id, JSON.stringify(accepted.member));
    const acceptedRow = await svc.entities.WorkspaceMember.get(invited.member.id);
    h.check("2g. accepting consumes the token and grants the role", (await resolveRole(base44, workspace, editor)) === "editor" && !acceptedRow.invite_token, "token cleared");
    const replay = await caught(() => acceptInvitation(base44, editor, { invite_token: invited.invite_token }));
    h.check("2h. the same token cannot be redeemed twice", replay?.code === "INVITE_INVALID", `${replay?.code}`);

    await addMember(workspace, viewer, "viewer");
    await addMember(workspace, admin, "admin");
    h.check("2i. roles resolve from stored membership, never from the request", (await resolveRole(base44, workspace, viewer)) === "viewer" && (await resolveRole(base44, workspace, admin)) === "admin", "viewer/admin resolved");
    h.check("2j. a non-member resolves to no role at all", (await resolveRole(base44, workspace, outsider)) === null, "no role");

    // ================= 3. Capability matrix (no privilege escalation) =================
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `Collab Project ${stamp}`, framework: "preact-htm" });
    const fs1 = createFs([]);
    for (const f of scaffoldFiles("Collab")) writeFile(fs1, f.path, f.content);
    const changed = await commitFiles(svc, project.id, fs1);
    await createVersion(svc, { project, fs: fs1, entities: [], secrets: [], message: "seed", changedFiles: changed });
    project = await svc.entities.Project.get(project.id);

    const readAs = (u) => caught(() => loadAuthorizedProject(base44, u, project.id, "project.read"));
    const writeAs = (u) => caught(() => loadAuthorizedProject(base44, u, project.id, "project.write"));
    h.check("3a. a viewer may read the project", (await readAs(viewer)) === null, "read allowed");
    const viewerWrite = await writeAs(viewer);
    h.check("3b. a viewer may NOT write the project", viewerWrite?.code === "INSUFFICIENT_ROLE", `${viewerWrite?.code}`);
    h.check("3c. an editor may write the project", (await writeAs(editor)) === null, "write allowed");
    h.check("3d. an editor may not manage secrets or deployments", !can("editor", "secret.manage") && !can("editor", "deploy.manage"), "refused");
    h.check("3e. an admin may deploy and manage secrets", can("admin", "deploy.manage") && can("admin", "secret.manage"), "allowed");
    h.check("3f. only the owner may manage the workspace or move money", can("owner", "workspace.manage") && !can("admin", "workspace.manage") && !can("admin", "billing.manage"), "owner-only");
    h.check("3g. an editor cannot manage members", !can("editor", "member.manage") && !can("viewer", "member.manage"), "refused");
    const escalate = await caught(() => updateMemberRole(base44, editor, { workspace_id: workspace.id, member_id: invited.member.id, role: "admin" }));
    h.check("3h. an editor cannot promote themselves", escalate?.code === "INSUFFICIENT_ROLE" && escalate?.status === 403, `${escalate?.code}`);
    const adminGrantsAdmin = await caught(() => updateMemberRole(base44, admin, { workspace_id: workspace.id, member_id: invited.member.id, role: "admin" }));
    h.check("3i. an admin cannot grant admin — only the owner can", adminGrantsAdmin?.code === "OWNER_REQUIRED", `${adminGrantsAdmin?.code}`);
    const adminRow = await rowFor(workspace, admin);
    const adminTouchesAdmin = await caught(() => removeMember(base44, admin, { workspace_id: workspace.id, member_id: adminRow.id }));
    h.check("3j. an admin cannot remove a peer admin", adminTouchesAdmin?.code === "OWNER_REQUIRED", `${adminTouchesAdmin?.code}`);
    h.check("3k. capabilities are reported for the UI, and differ by role", capabilitiesFor("viewer").length < capabilitiesFor("editor").length && capabilitiesFor("editor").length < capabilitiesFor("owner").length, `${capabilitiesFor("viewer").length}/${capabilitiesFor("editor").length}/${capabilitiesFor("owner").length}`);

    // ================= 4. Project-scoped membership + isolation =================
    foreignProject = await svc.entities.Project.create({ workspace_id: otherWs.id, name: `Foreign ${stamp}` });
    const crossRead = await caught(() => loadAuthorizedProject(base44, editor, foreignProject.id, "project.read"));
    h.check("4a. a member of one workspace cannot read another workspace's project", crossRead?.code === "NOT_A_MEMBER" && crossRead?.status === 403, `${crossRead?.code}`);
    const outsiderRead = await caught(() => loadAuthorizedProject(base44, outsider, project.id, "project.read"));
    h.check("4b. a non-member cannot read this project", outsiderRead?.code === "NOT_A_MEMBER", `${outsiderRead?.code}`);
    const collabs = await projectCollaborators(base44, editor, project.id);
    h.check("4c. a project reports its own collaborators to a member", collabs.my_role === "editor" && collabs.members.length >= 4, `${collabs.members.length} member(s) as ${collabs.my_role}`);
    h.check("4d. the owner appears as owner, derived from the workspace", collabs.members.some((m) => m.role === "owner" && m.user_id === owner.id), JSON.stringify(collabs.members.map((m) => m.role)));
    h.check("4e. collaborator listings never expose invitation tokens", !JSON.stringify(collabs).includes("invite_token"), `${collabs.pending_invitations} pending`);
    const outsiderCollabs = await caught(() => projectCollaborators(base44, outsider, project.id));
    h.check("4f. a non-member cannot enumerate collaborators", outsiderCollabs?.code === "NOT_A_MEMBER", `${outsiderCollabs?.code}`);

    // ================= 5. Conflict-safe concurrent editing =================
    const before = await versionCount();
    const edit1 = await commitMemberEdit(base44, editor, { project_id: project.id, edits: [{ path: "src/App.js", content: V2 }], message: "editor edit", expected_version: before });
    h.check("5a. an editor's edit commits as a new version", edit1.version?.number === before + 1, JSON.stringify(edit1.version));
    h.check("5b. the edit is really persisted", (await appContent()) === V2, "persisted");

    // The second editor composed against the OLD version — deterministically refused.
    const stale = await caught(() => commitMemberEdit(base44, admin, { project_id: project.id, edits: [{ path: "src/App.js", content: V3 }], message: "stale edit", expected_version: before }));
    h.check("5c. an edit composed against a superseded version is refused", stale?.code === "VERSION_CONFLICT" && stale?.status === 409, `${stale?.code}`);
    h.check("5d. the refused edit changed nothing", (await appContent()) === V2, "first editor's work intact");
    h.check("5e. the conflict names both versions so the client can reconcile", stale?.details?.expected_version === before && stale?.details?.current_version === before + 1, JSON.stringify(stale?.details));

    // Two truly simultaneous commits from the same base: exactly one may land.
    const base2 = await versionCount();
    const [a, b] = await Promise.all([
      commitMemberEdit(base44, editor, { project_id: project.id, edits: [{ path: "src/pages/Home.js", content: HOME("A") }], message: "race A", expected_version: base2 }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
      commitMemberEdit(base44, admin, { project_id: project.id, edits: [{ path: "src/pages/Home.js", content: HOME("B") }], message: "race B", expected_version: base2 }).then((r) => ({ ok: true, r })).catch((e) => ({ ok: false, e })),
    ]);
    const winners = [a, b].filter((x) => x.ok);
    const losers = [a, b].filter((x) => !x.ok);
    const afterRace = await versionCount();
    h.check("5f. two simultaneous edits from the same base produce exactly one winner", winners.length === 1 && losers.length === 1, JSON.stringify([a.ok ? a.r.version?.number : a.e.code, b.ok ? b.r.version?.number : b.e.code]));
    h.check("5g. the loser is told it was a version conflict", losers[0]?.e?.code === "VERSION_CONFLICT", `${losers[0]?.e?.code}`);
    h.check("5h. the race advanced the project by exactly one version", afterRace === base2 + 1, `${base2} → ${afterRace}`);
    const raceVersions = await svc.entities.ProjectVersion.filter({ project_id: project.id, number: base2 + 1 }, "-created_date", 5);
    h.check("5i. only one version exists at the contested number", raceVersions.length === 1, `${raceVersions.length} version(s) at v${base2 + 1}`);

    // Idempotency: a retried edit resumes its own commit rather than creating a second version.
    const editId = `edit_${crypto.randomUUID()}`;
    const base3 = await versionCount();
    const first = await commitMemberEdit(base44, editor, { project_id: project.id, edits: [{ path: "styles.css", content: ":root { --collab: 1; }\n" }], message: "idempotent", expected_version: base3, edit_id: editId });
    const retry = await commitMemberEdit(base44, editor, { project_id: project.id, edits: [{ path: "styles.css", content: ":root { --collab: 1; }\n" }], message: "idempotent", expected_version: first.version.number, edit_id: editId });
    h.check("5j. a retried edit yields no second version", retry.unchanged === true || retry.version?.number === first.version.number, JSON.stringify({ first: first.version?.number, retry: retry.version?.number, unchanged: retry.unchanged }));
    const noop = await commitMemberEdit(base44, editor, { project_id: project.id, edits: [{ path: "styles.css", content: ":root { --collab: 1; }\n" }] });
    h.check("5k. an edit that changes nothing commits nothing", noop.unchanged === true, JSON.stringify(noop));

    // A viewer's write is refused before any project state is touched.
    const viewerVersion = await versionCount();
    const viewerEdit = await caught(() => commitMemberEdit(base44, viewer, { project_id: project.id, edits: [{ path: "src/App.js", content: V3 }] }));
    h.check("5l. a viewer cannot commit an edit", viewerEdit?.code === "INSUFFICIENT_ROLE", `${viewerEdit?.code}`);
    h.check("5m. the refused viewer edit created no version", (await versionCount()) === viewerVersion, "unchanged");
    const outsiderEdit = await caught(() => commitMemberEdit(base44, outsider, { project_id: project.id, edits: [{ path: "src/App.js", content: V3 }] }));
    h.check("5n. a non-member cannot commit an edit", outsiderEdit?.code === "NOT_A_MEMBER", `${outsiderEdit?.code}`);
    const brokenEdit = await caught(() => commitMemberEdit(base44, editor, { project_id: project.id, edits: [{ path: "src/App.js", content: "export default function App( {\n" }] }));
    h.check("5o. an edit that does not build is refused and changes nothing", brokenEdit?.code === "BUILD_FAILED" && (await appContent()) === V2, `${brokenEdit?.code}`);

    // ================= 6. Revocation takes effect immediately =================
    const editorRow = await rowFor(workspace, editor);
    const demoted = await updateMemberRole(base44, owner, { workspace_id: workspace.id, member_id: editorRow.id, role: "viewer" });
    h.check("6a. the owner can change a member's role", demoted.member.role === "viewer", demoted.member.role);
    h.check("6b. the new role applies to the very next request", (await resolveRole(base44, workspace, editor)) === "viewer", "viewer now");
    const afterDemotion = await caught(() => commitMemberEdit(base44, editor, { project_id: project.id, edits: [{ path: "src/App.js", content: V3 }] }));
    h.check("6c. a demoted editor loses write access immediately", afterDemotion?.code === "INSUFFICIENT_ROLE", `${afterDemotion?.code}`);

    const removed = await removeMember(base44, owner, { workspace_id: workspace.id, member_id: editorRow.id });
    h.check("6d. the owner can revoke a member", removed.removed === true, JSON.stringify(removed));
    h.check("6e. a revoked member has no role at all, immediately", (await resolveRole(base44, workspace, editor)) === null, "no role");
    const afterRemoval = await caught(() => loadAuthorizedProject(base44, editor, project.id, "project.read"));
    h.check("6f. a revoked member loses READ access immediately", afterRemoval?.code === "NOT_A_MEMBER", `${afterRemoval?.code}`);
    const tombstone = await svc.entities.WorkspaceMember.get(editorRow.id);
    h.check("6g. a revoked membership is retained for audit, not deleted", tombstone?.status === "removed", "tombstoned");
    h.check("6h. a revoked row's invitation token is cleared", !tombstone?.invite_token, "cleared");
    const listAfter = await listMembers(base44, owner, workspace.id);
    h.check("6i. a revoked member is absent from the member list", !listAfter.members.some((m) => m.id === editorRow.id), "absent");

    // An invitation revoked before acceptance can never be redeemed.
    const toRevoke = await inviteMember(base44, owner, { workspace_id: workspace.id, email: `revoked.${stamp}@example.com`, role: "editor" });
    cleanupMembers.push(toRevoke.member.id);
    await removeMember(base44, owner, { workspace_id: workspace.id, member_id: toRevoke.member.id });
    const revokedAccept = await caught(() => acceptInvitation(base44, { id: `u_rev_${stamp}`, email: `revoked.${stamp}@example.com` }, { invite_token: toRevoke.invite_token }));
    h.check("6j. a revoked invitation cannot be accepted", revokedAccept?.code === "INVITE_INVALID", `${revokedAccept?.code}`);

    // The owner is structural and cannot be removed or demoted through membership.
    const ownerRow = await svc.entities.WorkspaceMember.create({ workspace_id: workspace.id, email: owner.email, user_id: owner.id, role: "admin", status: "active", accepted_at: new Date().toISOString() });
    cleanupMembers.push(ownerRow.id);
    const removeOwner = await caught(() => removeMember(base44, owner, { workspace_id: workspace.id, member_id: ownerRow.id }));
    h.check("6k. the workspace owner cannot be removed", removeOwner?.code === "OWNER_IMMUTABLE", `${removeOwner?.code}`);
    const demoteOwner = await caught(() => updateMemberRole(base44, owner, { workspace_id: workspace.id, member_id: ownerRow.id, role: "viewer" }));
    h.check("6l. the workspace owner cannot be demoted", demoteOwner?.code === "OWNER_IMMUTABLE", `${demoteOwner?.code}`);
    h.check("6m. the owner's role still resolves from the workspace itself", (await resolveRole(base44, workspace, owner)) === "owner", "owner");

    // ================= 7. Audit trail =================
    const audits = await svc.entities.AuditLog.filter({ workspace_id: workspace.id }, "-created_date", 100);
    const actions = audits.map((x) => x.action);
    h.check("7a. every membership action is audited", ["member.invited", "member.accepted", "member.role_changed", "member.removed"].every((x) => actions.includes(x)), [...new Set(actions)].join(", "));
    h.check("7b. collaborator edits are audited with the acting role and version", audits.some((x) => x.action === "project.edited" && x.metadata?.role === "editor" && x.metadata?.version >= 2), JSON.stringify(audits.find((x) => x.action === "project.edited")?.metadata));
    h.check("7c. each audit entry names the user who acted", audits.filter((x) => x.action.startsWith("member.")).every((x) => !!x.user_id), "attributed");
    h.check("7d. no audit entry carries an invite token", !JSON.stringify(audits).includes(invited.invite_token), "clean");
    h.check("7e. audit rows are workspace-scoped", audits.every((x) => x.workspace_id === workspace.id), `${audits.length} row(s)`);

  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}\n${String(e.stack || "").slice(0, 600)}`);
  } finally {
    for (const id of cleanupMembers) await svc.entities.WorkspaceMember.delete(id).catch(() => {});
    for (const ws of [workspace, otherWs]) {
      if (!ws) continue;
      for (const entity of ["WorkspaceMember", "Subscription", "AuditLog", "CommitJournal"]) {
        const rows = await svc.entities[entity].filter({ workspace_id: ws.id }, "-created_date", 500).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
      await discardWorkspaceProjects(svc, ws.id);
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }

  return harnessResponse(h);
}