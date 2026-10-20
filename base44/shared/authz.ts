import { unpackFileRecords } from "./blobStore.ts";
import { resolveRole, requireCapability, requireActiveWorkspace } from "./rbac.ts";

// Server-side authorization: resolve project + workspace access from the authenticated user.
//
// Access is a ROLE, resolved from facts the caller cannot influence (Workspace.owner_id, or
// an active WorkspaceMember row), and every endpoint states the capability it needs. The
// default is the mutating capability, so an endpoint that forgets to declare one is treated
// as a write and stays closed to viewers.
export async function loadAuthorizedProject(base44, user, projectId, capability = "project.write") {
  if (!projectId) throw Object.assign(new Error("project_id is required"), { status: 400 });
  // C-3.1 step 2: authorization facts are read with the service role so they never depend on
  // the caller's own record access. Ownership, membership and capability are still enforced below.
  const svc = base44.asServiceRole || base44;
  // Only a genuine not-found becomes the 404 below; any other failure (platform, timeout,
  // rate limit, refused service role) propagates unchanged and still fails closed.
  const orNull = (e) => (Number(e?.status ?? e?.response?.status) === 404 ? null : Promise.reject(e));
  const project = await svc.entities.Project.get(projectId).catch(orNull);
  if (!project) throw Object.assign(new Error("Project not found"), { status: 404 });
  const workspace = await svc.entities.Workspace.get(project.workspace_id).catch(orNull);
  if (!workspace) throw Object.assign(new Error("Project not found"), { status: 404 });
  const role = await resolveRole(base44, workspace, user);
  if (!role) throw Object.assign(new Error("Forbidden"), { status: 403, code: "NOT_A_MEMBER" });
  requireCapability(role, capability);
  // G-2 lifecycle: enforced at the ONE choke point every project-scoped surface funnels
  // through. Reads stay available on a suspended/terminated workspace; every mutating
  // capability fails closed.
  requireActiveWorkspace(workspace, capability);
  return { project, workspace, role };
}

// THE secret projection. Every read path (AI context, project state, API responses, UI)
// goes through this function, so a secret VALUE has no route out of the database other
// than the server-side function executor. `value` is dropped here, not downstream.
export function secretMetadata(rows) {
  return (rows || []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description || "",
    required: s.required !== false,
    is_set: !!s.value,
    last_used_at: s.last_used_at || null,
  }));
}

export async function loadProjectState(base44, projectId) {
  // Callers are either an API request holding the root client, or a background worker that
  // already holds a service-role client. Secret metadata always reads with the service role,
  // so resolve it from whichever client was handed in.
  const svc = base44.asServiceRole || base44;
  const [files, entities, secrets] = await Promise.all([
    svc.entities.ProjectFile.filter({ project_id: projectId }, "path", 500),
    base44.entities.AppEntity.filter({ project_id: projectId }, "name", 200),
    svc.entities.ProjectSecret.filter({ project_id: projectId }, "name", 100),
  ]);
  // Oversized content lives in storage; hydrate it so the virtual FS always sees real text.
  return {
    files: await unpackFileRecords(files),
    // `rls` is read through verbatim when the row declares one, so an entity's row-level rules
    // survive a reload into the in-memory state (and therefore into snapshots and artifacts).
    // A row without rules keeps exactly its existing { id, name, fields, dirty } shape.
    entities: entities.map((e) => ({ id: e.id, name: e.name, fields: e.fields || {}, ...(e.rls ? { rls: e.rls } : {}), dirty: false })),
    secrets: secretMetadata(secrets),
  };
}

export async function audit(base44, { workspace_id, project_id, user_id, action, resource, resource_id, metadata }) {
  await base44.entities.AuditLog.create({ workspace_id, project_id, user_id, action, resource, resource_id, metadata: metadata || {} });
}