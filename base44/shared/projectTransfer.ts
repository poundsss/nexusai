// App transfer (danger zone): the documented Base44 "Transfer Ownership" flow, plus the existing
// same-owner "Move app" operation — two distinct surfaces that share ONE re-parent primitive.
//
// Transfer Ownership (DOCUMENTED Base44):
//   • the SOURCE OWNER initiates a transfer to an OUTSIDE RECIPIENT by email;
//   • the transfer stays PENDING for 7 days (transfer_expires_at);
//   • the RECIPIENT chooses the destination workspace they own and accepts or declines;
//   • an expired transfer cannot be accepted; accept is single-use;
//   • on accept: the Project moves to the recipient's workspace, project-scoped content follows
//     the existing re-scope mechanism, Conversation/Message/AIRun (AI chat history) for the
//     project are cleared, AuditLog is preserved, WorkspaceMember rows are NOT deleted, and
//     AppTeam workspace denormalization follows the moved project;
//   • decline/expiry leaves the project and data unchanged;
//   • archived/trashed projects cannot enter or complete a transfer.
//
// Move app (the EXISTING same-owner operation, preserved verbatim): the owner re-parents a
// project into a workspace they also own, immediately. No recipient, no pending state, no chat
// history clearing. The two operations never share destructive semantics.
//
// Authorization is the platform's EXISTING path throughout: `loadAuthorizedProject` for source
// ownership (workspace.manage = owner-only), `resolveRole`/`requireCapability`/`requireActiveWorkspace`
// for the target. The recipient is verified by EMAIL MATCH against transfer_recipient_email — they
// are NOT a member of the source workspace, so they are never authorized through loadAuthorizedProject.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { resolveRole, requireCapability, requireActiveWorkspace, normalizeEmail } from "./rbac.ts";

// Project-owned content/state entities that carry a denormalized workspace_id and must follow the
// project. AppTeam carries workspace_id (group-access denormalization) and now follows; AppTeamMember
// has NO workspace_id (it resolves through project_id/team_id) so it inherently follows and needs no
// re-scope. Every entry is filtered by project_id during re-scope, so only THIS project's rows move.
const RE_SCOPE_ENTITIES = [
  "CommitJournal",
  "DesignSystem",
  "Architecture",
  "ArchitectureNode",
  "ArchitectureEdge",
  "ImplementationPlan",
  "ProjectDependency",
  "ProjectIndexEntry",
  "ProjectMemory",
  "WorkflowDefinition",
  "AppTeam",
];

// AI chat history that Base44 documents as cleared on a cross-workspace transfer. Deleted ONLY on a
// successful accept; never on decline/expiry; AuditLog is deliberately NOT in this list.
const CHAT_HISTORY_ENTITIES = ["Conversation", "Message", "AIRun"];

export const TRANSFER_WINDOW_DAYS = 7;

export class TransferError extends Error {
  constructor(message, code = "TRANSFER_ERROR", status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

const nowIso = () => new Date().toISOString();
const svcOf = (base44) => base44.asServiceRole || base44;

// The shared re-parent primitive. Moves the Project and its denormalized content rows to the target
// workspace; optionally clears AI chat history on a Transfer Ownership accept. A failure on one
// content entity never fails the whole operation — the project has already moved, and a missing or
// not-currently-writable entity is recorded as null rather than blocking. AuditLog is never touched.
async function reparentProject(svc, projectId, toWorkspaceId, { clearChatHistory = false } = {}) {
  const updated = await svc.entities.Project.update(projectId, { workspace_id: toWorkspaceId });
  const reScope = {};
  for (const name of RE_SCOPE_ENTITIES) {
    try {
      const res = await svc.entities[name].updateMany({ project_id: projectId }, { $set: { workspace_id: toWorkspaceId } });
      reScope[name] = Number(res?.updated || 0);
    } catch { reScope[name] = null; }
  }
  if (clearChatHistory) {
    reScope.__chat_history__ = {};
    for (const name of CHAT_HISTORY_ENTITIES) {
      try {
        const res = await svc.entities[name].deleteMany({ project_id: projectId });
        reScope.__chat_history__[name] = Number(res?.deleted || 0);
      } catch { reScope.__chat_history__[name] = null; }
    }
  }
  return { updated, reScope };
}

// A project is "trashed/archived" if it carries the danger-zone tombstone (status archived OR a
// restorable_until/deleted_at pair). Such a project cannot enter or complete a transfer.
function isTrashedOrArchived(project) {
  return project?.status === "archived" || !!project?.deleted_at;
}

function clearPendingFields() {
  return {
    transfer_pending: false,
    transfer_recipient_email: "",
    transfer_initiated_at: "",
    transfer_expires_at: "",
    transfer_initiated_by: "",
  };
}

/**
 * Move app (EXISTING same-owner operation, preserved). Re-parents a project into a target workspace
 * the caller already owns. Requires ownership (workspace.manage) on both source and target; fail-closed
 * on unauthorized or invalid target. Returns the updated project and a per-entity re-scope count.
 */
export async function transferProject(base44, user, { project_id, target_workspace_id } = {}) {
  if (!project_id) throw new TransferError("project_id is required", "PROJECT_REQUIRED", 400);
  if (!target_workspace_id) throw new TransferError("target_workspace_id is required", "TARGET_REQUIRED", 400);

  const { project } = await loadAuthorizedProject(base44, user, project_id, "workspace.manage");
  if (project.workspace_id === target_workspace_id) {
    throw new TransferError("Project is already in the target workspace", "ALREADY_IN_TARGET", 409);
  }
  if (project.transfer_pending) {
    throw new TransferError("A transfer is pending — cancel it before moving the app", "TRANSFER_PENDING", 409);
  }

  const svc = svcOf(base44);
  const target = await svc.entities.Workspace.get(target_workspace_id).catch(() => null);
  if (!target) throw new TransferError("Target workspace not found", "TARGET_NOT_FOUND", 404);
  const targetRole = await resolveRole(base44, target, user);
  if (!targetRole) throw new TransferError("You are not a member of the target workspace", "NOT_TARGET_MEMBER", 403);
  requireCapability(targetRole, "workspace.manage");
  requireActiveWorkspace(target, "workspace.manage");

  const fromWorkspaceId = project.workspace_id;
  const toWorkspaceId = target.id;
  const { updated, reScope } = await reparentProject(svc, project_id, toWorkspaceId);

  await audit(svc, { workspace_id: toWorkspaceId, project_id, user_id: user.id, action: "project.transferred", resource: "Project", resource_id: project_id, metadata: { kind: "move", from_workspace_id: fromWorkspaceId, to_workspace_id: toWorkspaceId, re_scope: reScope } });
  await audit(svc, { workspace_id: fromWorkspaceId, project_id, user_id: user.id, action: "project.transferred_out", resource: "Project", resource_id: project_id, metadata: { kind: "move", to_workspace_id: toWorkspaceId } }).catch(() => {});

  return { kind: "move", project: updated, from_workspace_id: fromWorkspaceId, to_workspace_id: toWorkspaceId, re_scope: reScope };
}

/**
 * Transfer Ownership — initiate. The SOURCE OWNER records a pending transfer to an outside recipient
 * by email. The project stays in place and editable; nothing is deleted and no email is sent (the
 * recipient discovers the pending transfer through the recipient Transfers surface). 7-day window.
 */
export async function initiateTransfer(base44, user, { project_id, recipient_email } = {}) {
  if (!project_id) throw new TransferError("project_id is required", "PROJECT_REQUIRED", 400);
  const email = normalizeEmail(recipient_email);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new TransferError("A valid recipient email is required", "RECIPIENT_EMAIL_REQUIRED", 400);

  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "workspace.manage");
  if (isTrashedOrArchived(project)) throw new TransferError("Archived or trashed projects cannot be transferred", "TRANSFER_ARCHIVED", 409);
  if (project.transfer_pending) throw new TransferError("A transfer is already pending for this project", "TRANSFER_ALREADY_PENDING", 409);
  if (email === normalizeEmail(user.email)) throw new TransferError("You cannot transfer ownership to yourself", "TRANSFER_TO_SELF", 400);

  const svc = svcOf(base44);
  const initiatedAt = nowIso();
  const expiresAt = new Date(Date.parse(initiatedAt) + TRANSFER_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const updated = await svc.entities.Project.update(project_id, {
    transfer_pending: true,
    transfer_recipient_email: email,
    transfer_initiated_at: initiatedAt,
    transfer_expires_at: expiresAt,
    transfer_initiated_by: user.id,
  });

  await audit(svc, { workspace_id: workspace.id, project_id, user_id: user.id, action: "project.transfer_initiated", resource: "Project", resource_id: project_id, metadata: { recipient_email: email, expires_at: expiresAt } });

  return { kind: "initiate", project: updated, recipient_email: email, initiated_at: initiatedAt, expires_at: expiresAt };
}

/**
 * Transfer Ownership — accept. The RECIPIENT (email match) chooses a destination workspace they own
 * and completes the transfer. Single-use, expiry-checked, archived-checked. On success: re-parent +
 * re-scope, clear AI chat history, preserve AuditLog, do NOT delete WorkspaceMember rows.
 */
export async function acceptTransfer(base44, user, { project_id, target_workspace_id } = {}) {
  if (!project_id) throw new TransferError("project_id is required", "PROJECT_REQUIRED", 400);
  if (!target_workspace_id) throw new TransferError("target_workspace_id is required", "TARGET_REQUIRED", 400);
  const svc = svcOf(base44);

  // The recipient is NOT a member of the source workspace, so authorization is the transfer record
  // itself: an authenticated user whose email matches transfer_recipient_email. Everyone else fails.
  const project = await svc.entities.Project.get(project_id).catch(() => null);
  if (!project || !project.transfer_pending) throw new TransferError("No pending transfer for this project", "NO_PENDING_TRANSFER", 404);
  if (normalizeEmail(user.email) !== normalizeEmail(project.transfer_recipient_email)) {
    throw new TransferError("You are not the recipient of this transfer", "NOT_RECIPIENT", 403);
  }
  if (isTrashedOrArchived(project)) throw new TransferError("This project can no longer be transferred", "TRANSFER_ARCHIVED", 409);

  const expiresAt = project.transfer_expires_at ? Date.parse(project.transfer_expires_at) : NaN;
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    // Expired: clear the pending record (decline-by-default) and leave the project unchanged.
    await svc.entities.Project.update(project_id, clearPendingFields());
    await audit(svc, { workspace_id: project.workspace_id, project_id, user_id: user.id, action: "project.transfer_expired", resource: "Project", resource_id: project_id, metadata: {} }).catch(() => {});
    throw new TransferError("The transfer window has expired", "TRANSFER_EXPIRED", 409);
  }

  // Target workspace: the recipient must OWN an active workspace.
  const target = await svc.entities.Workspace.get(target_workspace_id).catch(() => null);
  if (!target) throw new TransferError("Target workspace not found", "TARGET_NOT_FOUND", 404);
  const targetRole = await resolveRole(base44, target, user);
  if (!targetRole) throw new TransferError("You are not a member of the target workspace", "NOT_TARGET_MEMBER", 403);
  requireCapability(targetRole, "workspace.manage");
  requireActiveWorkspace(target, "workspace.manage");

  // Single-use claim: clear the pending record BEFORE the destructive move so a concurrent accept
  // (re-read sees transfer_pending=false) cannot double-run. The project row is the single source
  // of truth; there is no second token to replay.
  await svc.entities.Project.update(project_id, {
    ...clearPendingFields(),
    transfer_accepted_by: user.id,
    transfer_accepted_at: nowIso(),
  });

  const fromWorkspaceId = project.workspace_id;
  const toWorkspaceId = target.id;
  const { updated, reScope } = await reparentProject(svc, project_id, toWorkspaceId, { clearChatHistory: true });

  await audit(svc, { workspace_id: toWorkspaceId, project_id, user_id: user.id, action: "project.transferred", resource: "Project", resource_id: project_id, metadata: { kind: "transfer_ownership", from_workspace_id: fromWorkspaceId, to_workspace_id: toWorkspaceId, re_scope: reScope } });
  await audit(svc, { workspace_id: fromWorkspaceId, project_id, user_id: user.id, action: "project.transferred_out", resource: "Project", resource_id: project_id, metadata: { kind: "transfer_ownership", to_workspace_id: toWorkspaceId } }).catch(() => {});

  return { kind: "accept", project: updated, from_workspace_id: fromWorkspaceId, to_workspace_id: toWorkspaceId, re_scope: reScope };
}

/**
 * Transfer Ownership — decline. The recipient (email match) or the source owner may decline a
 * pending transfer. Clears the pending record only; the project and all data are unchanged.
 */
export async function declineTransfer(base44, user, { project_id } = {}) {
  if (!project_id) throw new TransferError("project_id is required", "PROJECT_REQUIRED", 400);
  const svc = svcOf(base44);
  const project = await svc.entities.Project.get(project_id).catch(() => null);
  if (!project || !project.transfer_pending) throw new TransferError("No pending transfer for this project", "NO_PENDING_TRANSFER", 404);

  const isRecipient = normalizeEmail(user.email) === normalizeEmail(project.transfer_recipient_email);
  let isOwner = false;
  if (!isRecipient) {
    try { await loadAuthorizedProject(base44, user, project_id, "workspace.manage"); isOwner = true; } catch { isOwner = false; }
  }
  if (!isRecipient && !isOwner) throw new TransferError("Only the recipient or the project owner can decline a transfer", "NOT_AUTHORIZED_TO_DECLINE", 403);

  await svc.entities.Project.update(project_id, clearPendingFields());
  await audit(svc, { workspace_id: project.workspace_id, project_id, user_id: user.id, action: "project.transfer_declined", resource: "Project", resource_id: project_id, metadata: { by: isRecipient ? "recipient" : "owner" } });

  return { kind: "decline", project_id, declined_by: isRecipient ? "recipient" : "owner" };
}

/** Pending transfers addressed to the authenticated user (the recipient surface). */
export async function listPendingTransfers(base44, user) {
  const svc = svcOf(base44);
  const email = normalizeEmail(user.email);
  const rows = await svc.entities.Project.filter({ transfer_pending: true, transfer_recipient_email: email }, "-transfer_initiated_at", 100).catch(() => []);
  return { kind: "list_pending", transfers: rows.map((p) => ({ project_id: p.id, name: p.name, workspace_id: p.workspace_id, initiated_at: p.transfer_initiated_at, expires_at: p.transfer_expires_at })) };
}

/** Workspaces the authenticated user may select as a transfer destination (owner only). */
export async function listMyWorkspaces(base44, user) {
  const svc = svcOf(base44);
  const memberRows = await svc.entities.WorkspaceMember.filter({ user_id: user.id, status: "active" }, "workspace_id", 200).catch(() => []);
  const ownedRows = await svc.entities.Workspace.filter({ owner_id: user.id }, "name", 200).catch(() => []);
  const ids = new Set([...memberRows.map((r) => r.workspace_id), ...ownedRows.map((w) => w.id)]);
  const out = [];
  for (const id of ids) {
    const ws = await svc.entities.Workspace.get(id).catch(() => null);
    if (!ws) continue;
    const role = await resolveRole(base44, ws, user).catch(() => null);
    if (role && (role === "owner")) out.push({ id: ws.id, name: ws.name });
  }
  return { kind: "my_workspaces", workspaces: out };
}

/** Transfer status for a project (owner-facing). */
export async function transferStatus(base44, user, { project_id } = {}) {
  if (!project_id) throw new TransferError("project_id is required", "PROJECT_REQUIRED", 400);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  return {
    kind: "status",
    transfer_pending: !!project.transfer_pending,
    recipient_email: project.transfer_recipient_email || null,
    initiated_at: project.transfer_initiated_at || null,
    expires_at: project.transfer_expires_at || null,
    expired: !!(project.transfer_expires_at && Date.now() >= Date.parse(project.transfer_expires_at)),
  };
}