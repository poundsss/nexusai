// Collaboration (#36): the member-facing project surface.
//
// Everything here composes systems that already exist — no second authorization model, no
// second version store, no second conflict rule:
//   • WHO you are            ... resolveRole (Workspace.owner_id | ACTIVE WorkspaceMember row)
//   • WHAT you may do        ... the rbac capability matrix
//   • WHICH project          ... loadAuthorizedProject, which re-resolves the project's workspace
//   • CONCURRENT EDITING     ... the journalled commit path (#prepareCommit/finalizeCommit), whose
//                                optimistic base-version check is the platform's single conflict rule
//   • WHAT HAPPENED          ... AuditLog
//
// Two invariants govern the module:
//   1. NO PRIVILEGE ESCALATION. A role is never read from the request; a viewer's write is
//      refused by the capability matrix before any project state is touched.
//   2. A CONCURRENT EDIT NEVER SILENTLY OVERWRITES ANOTHER. Every edit states the version it
//      was composed against; a commit whose base has moved is refused with VERSION_CONFLICT
//      and changes nothing.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { resolveRole, capabilitiesFor, requireCapability, requireActiveWorkspace, normalizeEmail, ASSIGNABLE_ROLES } from "./rbac.ts";
import { createMemberWithinSeats } from "./planLimits.ts";
import { readCanonicalSnapshot, prepareCommit, finalizeCommit, rollbackCommit } from "./commitJournal.ts";
import { createFs, writeFile, activeFiles } from "./projectFs.ts";
import { runBuild } from "./buildEngine.ts";
import { recordBuild } from "./persistence.ts";
import { assertNoActiveAgentPolicyWrite } from "./agentPolicyGuard.ts";
import { reconcileArchitectureAfterMutation } from "./architectureReconcile.ts";

const svcOf = (b) => b.asServiceRole || b;
const fail = (status, code, message, details = {}) => { throw Object.assign(new Error(message), { status, code, details }); };
export const MAX_EDIT_FILES = 40;

// Membership as a collaborator sees it: who else is here, what they may do, and what the
// CALLER may do. Emails of fellow members are workspace-internal and stay inside the workspace.
const memberView = (m, ownerId) => ({
  member_id: m.id, email: m.email, user_id: m.user_id || null,
  role: m.user_id && m.user_id === ownerId ? "owner" : m.role,
  status: m.status, invited_by: m.invited_by || null, accepted_at: m.accepted_at || null,
  // A pending invitation is visible as a pending claim — never with its token.
  pending: m.status === "invited",
});

/**
 * The collaborators of ONE project, resolved through the project's own workspace. A caller that
 * cannot read the project cannot read its collaborators, so this is not a route to enumerate
 * another workspace's people.
 */
export async function projectCollaborators(base44, user, projectId) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, projectId, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.WorkspaceMember.filter({ workspace_id: workspace.id }, "-created_date", 200);
  const members = rows.filter((m) => m.status !== "removed").map((m) => memberView(m, workspace.owner_id));
  const ownerRow = members.find((m) => m.role === "owner");
  return {
    project_id: project.id, workspace_id: workspace.id,
    my_role: role, my_capabilities: capabilitiesFor(role),
    owner_user_id: workspace.owner_id,
    members: ownerRow ? members : [{ member_id: "owner", email: null, user_id: workspace.owner_id, role: "owner", status: "active", invited_by: null, accepted_at: null, pending: false }, ...members],
    pending_invitations: members.filter((m) => m.pending).length,
  };
}

// Journals that still hold a claim on their version number. A rolled-back or failed journal
// has released its claim; a committed one holds it permanently.
const CLAIMING = ["prepared", "applying", "applied", "committed"];

/**
 * Elects ONE winner among edits racing for the same next version number.
 *
 * The version check inside finalizeCommit compares the project's counter, which two editors
 * who prepared simultaneously both pass — so the counter alone cannot decide the race. The
 * journal row is the claim: it is written first, then every racer re-reads every journal
 * claiming this same target version and applies one deterministic rule — the earliest claim
 * wins. Both racers therefore reach the SAME verdict, and the loser refuses before it applies
 * anything, leaving the winner's work untouched.
 */
async function claimVersionSlot(base44, journal, currentVersion) {
  const svc = svcOf(base44);
  const rows = await svc.entities.CommitJournal.filter(
    { project_id: journal.project_id, target_version_number: journal.target_version_number }, "-created_date", 50,
  );
  const contenders = rows.filter((r) => CLAIMING.includes(r.status));
  const winner = [...contenders].sort((a, b) =>
    String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)))[0];
  if (!winner || winner.id === journal.id) return;
  // Lost the race. Nothing canonical was touched yet, so releasing the claim is the whole undo —
  // the winner's version and the project pointer are left exactly as they are.
  await svc.entities.CommitJournal.update(journal.id, { status: "rolled_back", error: "lost the race for this version" }).catch(() => {});
  fail(409, "VERSION_CONFLICT", `Another collaborator committed v${journal.target_version_number} first. Reload the project and reapply your change.`, {
    expected_version: currentVersion, current_version: journal.target_version_number,
  });
}

/**
 * A member's direct edit of project files, committed through the journalled path.
 *
 * `expected_version` is the version the editor composed against. It is checked twice — once
 * before any work, and again inside finalizeCommit at the instant of application — so two
 * editors who started from the same version cannot both land: the second is refused with
 * VERSION_CONFLICT and the project keeps exactly the first one's work.
 *
 * `edit_id` makes the commit idempotent: a retried request resumes the same journal and
 * therefore yields the SAME version rather than a second one.
 */
export async function commitMemberEdit(base44, user, { project_id, edits = [], message = "Edited by a collaborator", expected_version = null, edit_id = null } = {}) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  // The write capability is checked explicitly: a viewer is refused here, before the project's
  // canonical state is even read.
  requireCapability(role, "project.write");
  // G-2 lifecycle: this path loads the project as a read and checks the write capability
  // itself, so the lifecycle guard is applied here with the same capability.
  requireActiveWorkspace(workspace, "project.write");

  const list = Array.isArray(edits) ? edits.filter((e) => e && e.path) : [];
  if (!list.length) fail(400, "INVALID_INPUT", "At least one file edit is required");
  if (list.length > MAX_EDIT_FILES) fail(422, "TOO_MANY_FILES", `An edit may touch at most ${MAX_EDIT_FILES} files (got ${list.length})`);

  const current = project.version_count || 0;
  if (expected_version !== null && expected_version !== undefined && Number(expected_version) !== current) {
    fail(409, "VERSION_CONFLICT", `This edit was composed against v${expected_version}, but the project is now at v${current}. Reload the project and reapply your change.`, { expected_version: Number(expected_version), current_version: current });
  }

  const previous = await readCanonicalSnapshot(base44, project.id);
  const frozen = new Set(previous.files.filter((f) => f.frozen).map((f) => f.path));

  // Target state = previous state + this edit. Paths are validated by the virtual filesystem,
  // so an unacceptable path is refused rather than persisted.
  const byPath = new Map(previous.files.map((f) => [f.path, { ...f }]));
  const changed = [];
  for (const e of list) {
    const path = String(e.path);
    if (frozen.has(path)) fail(409, "FILE_FROZEN", `${path} is frozen and cannot be edited`);
    if (e.delete === true) {
      if (!byPath.has(path)) fail(404, "FILE_NOT_FOUND", `${path} does not exist in this project`);
      byPath.delete(path);
      changed.push({ path, change: "deleted" });
      continue;
    }
    const probe = createFs([]);
    writeFile(probe, path, String(e.content ?? ""));   // path validation
    const existed = byPath.has(path);
    if (existed && byPath.get(path).content === String(e.content ?? "")) continue;   // no-op
    byPath.set(path, { path, content: String(e.content ?? ""), frozen: false });
    changed.push({ path, change: existed ? "modified" : "added" });
  }
  if (!changed.length) {
    return { project_id: project.id, version: null, unchanged: true, current_version: current, changed_files: [] };
  }

  // Agent policy immutability: a policy file of an agent with a LIVE run cannot be committed
  // through this member/MCP path either (AGENT_POLICY_IMMUTABLE, 409). Non-agent files and
  // agents without a live run are untouched.
  await assertNoActiveAgentPolicyWrite(base44, project.id, changed.map((c) => c.path));

  const target = { files: [...byPath.values()], entities: previous.entities, secrets: previous.secrets };

  // The edit must build. A collaborator can never leave the project in a state the platform
  // would refuse from an AI run.
  const fs = createFs(target.files.map((f) => ({ path: f.path, content: f.content, frozen: f.frozen })));
  const build = runBuild(fs, target.entities, target.secrets);
  await recordBuild(svcOf(base44), project.id, null, build).catch(() => {});
  if (build.status !== "success") {
    fail(422, "BUILD_FAILED", `This edit does not build (${build.errors} error(s)) — the project was left unchanged.`, { errors: build.logs.filter((l) => l.startsWith("error")).slice(0, 10) });
  }

  const run = { id: String(edit_id || `edit_${crypto.randomUUID()}`), base_version_number: current };
  const journal = await prepareCommit(base44, { project, workspace, run, target, message: String(message).slice(0, 200), changedFiles: changed });
  await claimVersionSlot(base44, journal, current);
  let committed;
  try {
    committed = await finalizeCommit(base44, journal, { runId: run.id });
  } catch (e) {
    // A refused commit leaves nothing behind: the journal restores the state it captured.
    if (journal.status !== "committed") await rollbackCommit(base44, journal, e.message).catch(() => {});
    throw e;
  }

  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "project.edited", resource: "ProjectVersion", resource_id: committed.version.id,
    metadata: { role, edit_id: run.id, version: committed.version.number, base_version: current, files: changed.length, changed: changed.map((c) => `${c.change}:${c.path}`).slice(0, 20) },
  }).catch(() => {});

  // Architecture reconciliation — AFTER the committed collaborator edit, best-effort via the
  // shared wrapper. `user` is the authenticated collaborator who just authorized project.write
  // for this commit; reconcileArchitecture re-checks it. A failure never undoes the edit.
  await reconcileArchitectureAfterMutation(base44, user, { project_id: project.id });

  return {
    project_id: project.id, version: { version_id: committed.version.id, number: committed.version.number },
    unchanged: false, replayed: !!committed.already_committed, changed_files: changed, build_status: build.status,
  };
}

// --- membership lifecycle ---------------------------------------------------------------
// THE implementation of invite / accept / role change / removal. The HTTP surface
// (functions/workspaceMembers) is a thin adapter over these functions, so certification
// exercises exactly the code a real request runs.

export const membershipView = (m) => ({
  id: m.id, email: m.email, user_id: m.user_id || null, role: m.role, status: m.status,
  invited_by: m.invited_by || null, accepted_at: m.accepted_at || null, created_date: m.created_date,
});

async function authorizedWorkspace(base44, user, workspaceId, capability = null) {
  const svc = svcOf(base44);
  const workspace = await svc.entities.Workspace.get(String(workspaceId || "")).catch(() => null);
  if (!workspace) fail(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  const role = await resolveRole(base44, workspace, user);
  if (!role) fail(403, "NOT_A_MEMBER", "Forbidden");
  if (capability) requireCapability(role, capability);
  // G-2 lifecycle: membership CHANGES (invite, role change, removal) require an active
  // workspace; listing members (no capability declared) stays readable.
  if (capability) requireActiveWorkspace(workspace, capability);
  const members = await svc.entities.WorkspaceMember.filter({ workspace_id: workspace.id }, "-created_date", 200);
  return { workspace, role, members };
}

// Role hierarchy: only the owner may touch an admin's membership, so an admin cannot demote
// or remove a peer admin, and cannot grant admin to anyone.
function assertMayManage(role, target) {
  if (target && target.role === "admin" && role !== "owner") {
    fail(403, "OWNER_REQUIRED", "Only the workspace owner can change an admin's membership");
  }
}

export async function listMembers(base44, user, workspaceId) {
  const { workspace, role, members } = await authorizedWorkspace(base44, user, workspaceId);
  return {
    role, capabilities: capabilitiesFor(role), owner: { user_id: workspace.owner_id },
    members: members.filter((m) => m.status !== "removed").map(membershipView),
  };
}

export async function inviteMember(base44, user, { workspace_id, email, role: requestedRole } = {}) {
  const { workspace, role, members } = await authorizedWorkspace(base44, user, workspace_id, "member.manage");
  const address = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) fail(400, "INVALID_INPUT", "A valid email address is required");
  const newRole = ASSIGNABLE_ROLES.includes(requestedRole) ? requestedRole : "viewer";
  if (newRole === "admin" && role !== "owner") fail(403, "OWNER_REQUIRED", "Only the workspace owner can invite an admin");
  if (address === normalizeEmail(user.email) && role === "owner") fail(400, "ALREADY_OWNER", "You already own this workspace");
  const existing = members.find((m) => normalizeEmail(m.email) === address && m.status !== "removed");
  if (existing) fail(409, "ALREADY_INVITED", `${address} is already ${existing.status === "active" ? "a member" : "invited"}`);
  const invite_token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  // The plan's seat limit is claimed against the authorized workspace, concurrency-safe.
  const created = await createMemberWithinSeats(svcOf(base44), workspace, {
    email: address, role: newRole, status: "invited", invite_token, invited_by: user.id,
  });
  await audit(svcOf(base44), { workspace_id: workspace.id, user_id: user.id, action: "member.invited", resource: "WorkspaceMember", resource_id: created.id, metadata: { email: address, role: newRole } });
  // The token is returned ONLY here, to the inviter that just created it.
  return { member: membershipView(created), invite_token };
}

/**
 * Accepting is the one action that does not require existing membership — it is how membership
 * begins. It is authorized by the single-use token PLUS an email match, so a leaked token cannot
 * be redeemed by a different account, and the token is cleared the moment it is used.
 */
export async function acceptInvitation(base44, user, { invite_token } = {}) {
  const token = String(invite_token || "");
  if (!token) fail(400, "INVALID_INPUT", "invite_token is required");
  const svc = svcOf(base44);
  const rows = await svc.entities.WorkspaceMember.filter({ invite_token: token }, "-created_date", 2);
  const row = rows[0];
  if (!row || row.status !== "invited") fail(404, "INVITE_INVALID", "This invitation is no longer valid");
  if (normalizeEmail(row.email) !== normalizeEmail(user.email)) fail(403, "INVITE_EMAIL_MISMATCH", "This invitation was issued to a different email address");
  const saved = await svc.entities.WorkspaceMember.update(row.id, {
    user_id: user.id, status: "active", accepted_at: new Date().toISOString(), invite_token: null,
  });
  await audit(svc, { workspace_id: row.workspace_id, user_id: user.id, action: "member.accepted", resource: "WorkspaceMember", resource_id: row.id, metadata: { role: row.role } });
  return { member: membershipView(saved || row), workspace_id: row.workspace_id };
}

export async function updateMemberRole(base44, user, { workspace_id, member_id, role: requestedRole } = {}) {
  const { workspace, role, members } = await authorizedWorkspace(base44, user, workspace_id, "member.manage");
  const target = members.find((m) => m.id === String(member_id || ""));
  assertMayManage(role, target);
  if (!target || target.status === "removed") fail(404, "MEMBER_NOT_FOUND", "Member not found");
  const newRole = ASSIGNABLE_ROLES.includes(requestedRole) ? requestedRole : null;
  if (!newRole) fail(400, "INVALID_INPUT", `role must be one of ${ASSIGNABLE_ROLES.join(", ")}`);
  if (newRole === "admin" && role !== "owner") fail(403, "OWNER_REQUIRED", "Only the workspace owner can grant admin");
  if (target.user_id === workspace.owner_id) fail(403, "OWNER_IMMUTABLE", "The workspace owner's access cannot be changed");
  const saved = await svcOf(base44).entities.WorkspaceMember.update(target.id, { role: newRole });
  await audit(svcOf(base44), { workspace_id: workspace.id, user_id: user.id, action: "member.role_changed", resource: "WorkspaceMember", resource_id: target.id, metadata: { email: target.email, from: target.role, to: newRole } });
  return { member: membershipView(saved || { ...target, role: newRole }) };
}

export async function removeMember(base44, user, { workspace_id, member_id } = {}) {
  const { workspace, role, members } = await authorizedWorkspace(base44, user, workspace_id, "member.manage");
  const target = members.find((m) => m.id === String(member_id || ""));
  assertMayManage(role, target);
  if (!target || target.status === "removed") fail(404, "MEMBER_NOT_FOUND", "Member not found");
  if (target.user_id === workspace.owner_id) fail(403, "OWNER_IMMUTABLE", "The workspace owner cannot be removed");
  // Access ends immediately: the row is tombstoned (kept for audit) and its token cleared, so a
  // pending invitation can never be redeemed after revocation.
  await svcOf(base44).entities.WorkspaceMember.update(target.id, { status: "removed", removed_at: new Date().toISOString(), invite_token: null });
  await audit(svcOf(base44), { workspace_id: workspace.id, user_id: user.id, action: "member.removed", resource: "WorkspaceMember", resource_id: target.id, metadata: { email: target.email, role: target.role } });
  return { removed: true, member_id: target.id };
}

/**
 * Archiving (the project.delete capability, owner/admin only): a tombstone, not a wipe. The
 * project row keeps its identity, lineage and audit trail, but stops being served — the
 * public runtime's lifecycle gate refuses any request resolving to an archived project,
 * exactly as it refuses a suspended workspace. Restoring is a record update in the UI.
 */
export async function archiveProject(base44, user, projectId) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, projectId, "project.delete");
  await svcOf(base44).entities.Project.update(project.id, { status: "archived" });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "project.archived", resource: "Project", resource_id: project.id,
    metadata: { role, slug: project.slug || null, previous_status: project.status, versions: project.version_count || 0 },
  }).catch(() => {});
  return { archived: true, project_id: project.id, slug: project.slug || null };
}

/**
 * Rename (project.write): changes ONLY the project's app name. Reuses the existing name
 * validation contract from createProjectForUser (trim, non-empty, ≤120 chars) and the
 * existing authorization choke point (loadAuthorizedProject → project.write → active
 * workspace). No slug, deployment, lifecycle, visibility or other field is touched — the
 * project keeps its identity, permissions, versions and serving state exactly as they were.
 */
export async function renameProject(base44, user, projectId, name) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, projectId, "project.write");
  const projectName = String(name || "").trim().slice(0, 120);
  if (!projectName) fail(400, "INVALID_INPUT", "A project name is required");
  if (projectName === project.name) return { renamed: true, project_id: project.id, name: project.name };
  const saved = await svcOf(base44).entities.Project.update(project.id, { name: projectName });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "project.renamed", resource: "Project", resource_id: project.id,
    metadata: { role, from: project.name, to: projectName },
  }).catch(() => {});
  return { renamed: true, project_id: project.id, name: (saved && saved.name) || projectName };
}

// --- Danger Zone (App Settings) -------------------------------------------------------
// Unpublish / Republish / Delete / Restore, the four documented App Settings danger-zone
// actions. Each reuses the EXISTING authorization choke point (loadAuthorizedProject →
// requireCapability → requireActiveWorkspace) and the EXISTING audit + Project update paths —
// no new entity, no new permission, no new status enum value. The serving effect is enforced at
// the single public-serving gate (assertPublicServing in deploy.ts): 'unpublished' → 503 offline
// notice; 'archived' (set by Delete) → the existing 404 archived gate. The production deployment
// pointer is intentionally NOT touched, so republish/restore resume serving the same LIVE
// deployment without redeploying — matching "data, settings and custom domains remain".
//
// Capability reuse: Unpublish/Republish are serving toggles (deploy.manage, owner/admin);
// Delete/Restore are destructive (project.delete, owner/admin). Both are owner/admin, matching
// the Base44 danger-zone access level. The 30-day window is the restore cutoff only — no purge
// sweep is implemented (the documented boundary is the restore limit, not an auto-delete).

const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export async function unpublishProject(base44, user, projectId) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, projectId, "deploy.manage");
  if (project.status === "archived") fail(409, "PROJECT_ARCHIVED", "An archived project is already offline — restore it first");
  if (project.unpublished) return { unpublished: true, project_id: project.id };
  await svcOf(base44).entities.Project.update(project.id, { unpublished: true });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "project.unpublished", resource: "Project", resource_id: project.id,
    metadata: { role, slug: project.slug || null },
  }).catch(() => {});
  return { unpublished: true, project_id: project.id };
}

export async function republishProject(base44, user, projectId) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, projectId, "deploy.manage");
  if (project.status === "archived") fail(409, "PROJECT_ARCHIVED", "Restore the project from trash before republishing");
  if (!project.unpublished) return { published: true, project_id: project.id };
  await svcOf(base44).entities.Project.update(project.id, { unpublished: false });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "project.republished", resource: "Project", resource_id: project.id,
    metadata: { role, slug: project.slug || null },
  }).catch(() => {});
  return { published: true, project_id: project.id };
}

// Delete moves the app to the restorable trash: status='archived' (the existing offline gate
// refuses to serve it) plus the restore metadata. The legacy archiveProject path is unchanged —
// it sets archived WITHOUT this metadata, so it remains a permanent (non-restorable) tombstone.
export async function deleteProject(base44, user, projectId) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, projectId, "project.delete");
  if (project.status === "archived" && !project.restorable_until) {
    fail(409, "ALREADY_ARCHIVED", "This project is already permanently archived");
  }
  const now = new Date();
  const restorableUntil = new Date(now.getTime() + RESTORE_WINDOW_MS).toISOString();
  const previousStatus = project.status && project.status !== "archived" ? project.status : "ready";
  await svcOf(base44).entities.Project.update(project.id, {
    status: "archived",
    unpublished: false,
    deleted_at: now.toISOString(),
    restorable_until: restorableUntil,
    previous_status: previousStatus,
  });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "project.deleted", resource: "Project", resource_id: project.id,
    metadata: { role, slug: project.slug || null, previous_status: previousStatus, restorable_until: restorableUntil },
  }).catch(() => {});
  return { deleted: true, project_id: project.id, restorable_until: restorableUntil };
}

// Restore returns the project to its pre-deletion state, but only within the 30-day window. After
// the window, restore is fail-closed (the project stays a permanent archived tombstone — no
// purge sweep is implemented; the documented 30-day boundary is the restore cutoff).
export async function restoreProject(base44, user, projectId) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, projectId, "project.delete");
  if (project.status !== "archived" || !project.restorable_until) {
    fail(409, "NOT_RESTORABLE", "This project is not in the restorable trash");
  }
  if (new Date(project.restorable_until).getTime() < Date.now()) {
    fail(409, "RESTORE_WINDOW_EXPIRED", "The 30-day restore window has expired");
  }
  const previousStatus = project.previous_status && project.previous_status !== "archived" ? project.previous_status : "ready";
  await svcOf(base44).entities.Project.update(project.id, {
    status: previousStatus,
    unpublished: false,
    deleted_at: null,
    restorable_until: null,
    previous_status: null,
  });
  await audit(svcOf(base44), {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "project.restored", resource: "Project", resource_id: project.id,
    metadata: { role, slug: project.slug || null, restored_to: previousStatus },
  }).catch(() => {});
  return { restored: true, project_id: project.id, status: previousStatus };
}

export { normalizeEmail };