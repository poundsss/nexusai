// Server-authoritative project creation.
//
// Creating a project writes four canonical records — Project, its scaffold ProjectFiles, the
// initial ProjectVersion and the audit entry. That set used to be written by the browser, which
// meant the acting identity, the owning workspace and the audit trail were all whatever the
// client sent. Here every one of them is derived server-side:
//   • the user comes from the authenticated session, never from the payload;
//   • the workspace id in the payload is a HINT — it is resolved to a real Workspace row and then
//     authorized through workspace membership (Workspace.owner_id or an active WorkspaceMember),
//     so a forged id belonging to somebody else's account resolves to "not a member";
//   • the capability check is the same rbac matrix every other control-plane surface uses;
//   • the records are written with the SERVER's resolved workspace/user, so no field of the
//     stored project or its audit entry can be dictated by the caller.
import { resolveRole, requireCapability, requireActiveWorkspace } from "./rbac.ts";
import { scaffoldFiles } from "./scaffold.ts";
import { audit } from "./authz.ts";
import { createProjectWithinLimit } from "./planLimits.ts";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

export async function createProjectForUser(base44, user, { workspace_id, name, description } = {}) {
  // Anonymous callers never reach the write path.
  if (!user || !user.id) fail(401, "AUTH_REQUIRED", "Sign in to create a project");

  const svc = base44.asServiceRole || base44;
  const projectName = String(name || "").trim().slice(0, 120);
  if (!projectName) fail(400, "INVALID_INPUT", "A project name is required");

  const workspace = workspace_id ? await svc.entities.Workspace.get(String(workspace_id)).catch(() => null) : null;
  // An unknown or unreadable workspace id is reported the same way a foreign one is, so
  // probing ids reveals nothing about which accounts exist.
  if (!workspace) fail(403, "NOT_A_MEMBER", "You do not have access to that workspace");
  // G-2 lifecycle: the shared guard (reads pass, mutations fail closed with WORKSPACE_INACTIVE).
  requireActiveWorkspace(workspace);

  const role = await resolveRole(base44, workspace, user);
  if (!role) fail(403, "NOT_A_MEMBER", "You do not have access to that workspace");
  requireCapability(role, "project.create");

  // The plan's project limit is claimed against the SERVER-resolved workspace, concurrency-safe,
  // and before any scaffold file, version or audit row exists — a refused creation leaves nothing.
  const project = await createProjectWithinLimit(svc, workspace, {
    name: projectName,
    description: String(description || "").slice(0, 2000),
    framework: "preact-htm",
    status: "draft",
    version_count: 1,
    last_build_status: "success",
  });

  // The scaffold carries the project's own base44/config.jsonc manifest, so a new project is in
  // the canonical layout from version 1.
  const files = scaffoldFiles(projectName, project.description || "");
  await svc.entities.ProjectFile.bulkCreate(files.map((f) => ({ project_id: project.id, ...f, frozen: false })));
  const version = await svc.entities.ProjectVersion.create({
    project_id: project.id,
    number: 1,
    message: "Initial scaffold",
    changed_files: files.map((f) => ({ path: f.path, change: "added" })),
    snapshot: { files, entities: [] },
  });

  // Non-forgeable audit entry: written with the service role, stamped with the authenticated
  // user and the resolved workspace.
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "project.created", resource: "Project", resource_id: project.id,
    metadata: { name: projectName, role },
  });

  return { project, version, files_created: files.length, role };
}