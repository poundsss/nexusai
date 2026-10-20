// Workspace-scoped, server-authoritative read/write surface for the entities whose direct
// browser access is locked by RLS: Workspace, WorkspaceMember, Project, Deployment and
// AppRecord. Every action resolves the caller's role SERVER-side from Workspace.owner_id or
// an active WorkspaceMember row (rbac), reads rows with the service role, and returns only
// rows scoped to the authorized workspace/project. Member listing reuses
// collaboration.listMembers, whose projection never emits invite_token.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { listMembers } from "./collaboration.ts";
import { resolveRole, requireCapability, requireActiveWorkspace } from "./rbac.ts";

const svcOf = (b) => b.asServiceRole || b;
const MAX_LIMIT = 200;

const badInput = (msg) => Object.assign(new Error(msg), { status: 400, code: "INVALID_INPUT" });
const cleanLimit = (v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
};
const cleanSort = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" || v.length > 80 || !/^-?[a-zA-Z_]+$/.test(v)) throw badInput("Invalid sort");
  return v;
};
const cleanFields = (v) => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.length > 20 || v.some((f) => typeof f !== "string" || f.length > 40)) throw badInput("Invalid fields");
  return v;
};

// The workspace gate for workspace-scoped reads: any member role may read; lifecycle reads
// (project.read) stay available on a suspended workspace, per the G-2 contract.
async function requireWorkspaceRead(base44, user, workspaceId) {
  if (!workspaceId || typeof workspaceId !== "string") throw badInput("workspace_id is required");
  const svc = svcOf(base44);
  const workspace = await svc.entities.Workspace.get(workspaceId).catch(() => null);
  if (!workspace) throw Object.assign(new Error("Workspace not found"), { status: 404, code: "WORKSPACE_NOT_FOUND" });
  const role = await resolveRole(base44, workspace, user);
  if (!role) throw Object.assign(new Error("Forbidden"), { status: 403, code: "NOT_A_MEMBER" });
  requireCapability(role, "project.read");
  requireActiveWorkspace(workspace, "project.read");
  return { workspace, role };
}

// The project list of a workspace the caller belongs to.
export async function workspaceProjectsRead(base44, user, { workspace_id, sort, limit, fields, exclude_status } = {}) {
  const { workspace } = await requireWorkspaceRead(base44, user, workspace_id);
  const query = exclude_status
    ? { workspace_id: workspace.id, status: { $ne: String(exclude_status).slice(0, 40) } }
    : { workspace_id: workspace.id };
  const page = await svcOf(base44).entities.Project.filter(query, {
    sort: cleanSort(sort, "-updated_date"),
    limit: cleanLimit(limit, 50),
    ...(fields ? { fields: cleanFields(fields) } : {}),
  });
  return { projects: page.items || [] };
}

// One project the caller is authorized against.
export async function workspaceProjectRead(base44, user, project_id) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  return { project };
}

// Members of a workspace, through the authorized membership surface (no invite_token).
export async function workspaceMembersRead(base44, user, workspace_id) {
  return listMembers(base44, user, workspace_id);
}

// Deployments of an authorized project.
export async function workspaceDeploymentsRead(base44, user, { project_id, limit } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const page = await svcOf(base44).entities.Deployment.filter({ project_id: project.id }, {
    sort: "-created_date",
    limit: cleanLimit(limit, 30),
  });
  return { deployments: page.items || [] };
}

// App data records of an authorized project, one entity at a time.
export async function workspaceRecordsRead(base44, user, { project_id, entity_name, limit } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  if (!entity_name || typeof entity_name !== "string" || entity_name.length > 80) throw badInput("entity_name is required");
  const page = await svcOf(base44).entities.AppRecord.filter({ project_id: project.id, entity_name }, {
    sort: "-created_date",
    limit: cleanLimit(limit, 200),
  });
  return { records: page.items || [] };
}

// Bulk clear of one entity's records (Data pane "Clear"). Never touches trash rows:
// they carry a TRASH:<entity> entity_name and do not match.
export async function workspaceRecordsClear(base44, user, { project_id, entity_name } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  if (!entity_name || typeof entity_name !== "string" || entity_name.length > 80) throw badInput("entity_name is required");
  const res = await svcOf(base44).entities.AppRecord.deleteMany({ project_id: project.id, entity_name });
  return { deleted: res?.deleted ?? res?.count ?? null };
}

// Workspace rename: a display-name-only action, admin-delegable (rbac) — the workspace's
// identity, plan and credits stay under workspace.manage (owner-only).
export async function workspaceRename(base44, user, { workspace_id, name } = {}) {
  if (!workspace_id || typeof workspace_id !== "string") throw badInput("workspace_id is required");
  const svc = svcOf(base44);
  const workspace = await svc.entities.Workspace.get(workspace_id).catch(() => null);
  if (!workspace) throw Object.assign(new Error("Workspace not found"), { status: 404, code: "WORKSPACE_NOT_FOUND" });
  const role = await resolveRole(base44, workspace, user);
  if (!role) throw Object.assign(new Error("Forbidden"), { status: 403, code: "NOT_A_MEMBER" });
  requireCapability(role, "workspace.rename");
  requireActiveWorkspace(workspace, "workspace.rename");
  const clean = String(name || "").trim();
  if (!clean || clean.length > 120) throw badInput("A workspace name of 1-120 characters is required");
  const saved = await svc.entities.Workspace.update(workspace.id, { name: clean });
  await audit(svc, {
    workspace_id: workspace.id, user_id: user.id, action: "workspace.renamed",
    resource: "Workspace", resource_id: workspace.id, metadata: { name: clean },
  }).catch(() => {});
  return { workspace: saved || { ...workspace, name: clean } };
}

// The caller's OWN workspaces (owner), for surfaces with no workspace context yet.
export async function ownWorkspacesRead(base44, user) {
  const page = await svcOf(base44).entities.Workspace.filter({ owner_id: user.id }, { sort: "created_date", limit: 100 });
  return { workspaces: page.items || [] };
}