// Platform service layer shared by the MCP tool functions.
//
// This is deliberately THIN: every operation delegates to the services that already
// own the business logic (authz.loadAuthorizedProject, loadProjectState, the AI run
// enqueue path, the version restore function, the build engine's persisted records).
// Nothing here re-implements authorization, AI execution, building or versioning.
import { createFs, buildIndex, activeFiles } from "./projectFs.ts";
import { describeFunctions } from "./tools.ts";
import { describeIntegrations } from "./integrations.ts";
import { loadAuthorizedProject, loadProjectState, audit } from "./authz.ts";
import { unpackFileRecords } from "./blobStore.ts";

export const MAX_FILE_CHARS = 60000;
export const MAX_FILES_LISTED = 300;
// AI-run safety rails for externally driven callers.
export const MAX_ACTIVE_RUNS_PER_PROJECT = 2;
export const MAX_RUNS_PER_HOUR = 30;

export const NON_TERMINAL = ["QUEUED", "RUNNING", "CONTEXT_LOADING", "PLANNING", "EXECUTING", "VALIDATING", "REPAIRING"];

export function apiError(code, message, status) {
  return Object.assign(new Error(message), { code, status: status || 400 });
}

// The single identity resolution point: the account comes from the authenticated
// token, never from the request payload.
export async function callerWorkspace(base44, user) {
  const ws = await accessibleWorkspaces(base44, user);
  if (!ws[0]) throw apiError("NO_WORKSPACE", "This account has no workspace yet", 404);
  return ws[0];
}

// Every workspace this identity may act in: the one it owns, plus any workspace where it
// holds an ACTIVE membership. Membership rows are read with the service role because a
// member does not (and must not) hold read access to the membership table itself.
export async function accessibleWorkspaces(base44, user) {
  const svc = base44.asServiceRole || base44;
  // Page through every owned workspace, oldest first (so ws[0] stays the account's primary
  // workspace) — a hard limit would silently drop newer workspaces once the account owns more
  // than one page's worth, hiding them from every downstream surface.
  const owned = [];
  for (let skip = 0; ; skip += 100) {
    const page = await svc.entities.Workspace.filter({ owner_id: user.id }, "created_date", 100, skip);
    owned.push(...page);
    if (page.length < 100) break;
  }
  const memberships = await svc.entities.WorkspaceMember.filter({ user_id: user.id, status: "active" }, "-created_date", 50);
  const extra = [];
  for (const m of memberships) {
    if (owned.some((w) => w.id === m.workspace_id)) continue;
    const ws = await svc.entities.Workspace.get(m.workspace_id).catch(() => null);
    if (ws) extra.push(ws);
  }
  return [...owned, ...extra];
}

const projectView = (p) => ({
  project_id: p.id, name: p.name, description: p.description || "", framework: p.framework,
  status: p.status, current_version: p.version_count || 0, last_build_status: p.last_build_status || "none",
  created_date: p.created_date, updated_date: p.updated_date,
});

export async function listProjects(base44, user) {
  const workspaces = await accessibleWorkspaces(base44, user);
  if (!workspaces.length) throw apiError("NO_WORKSPACE", "This account has no workspace yet", 404);
  const svc = base44.asServiceRole || base44;
  const projects = [];
  for (const ws of workspaces) {
    const rows = await svc.entities.Project.filter({ workspace_id: ws.id }, "-updated_date", 100);
    projects.push(...rows.map(projectView));
  }
  return { projects };
}

export async function getProject(base44, user, projectId) {
  const { project } = await loadAuthorizedProject(base44, user, projectId, "project.read");
  const versions = await base44.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1);
  const builds = await base44.entities.Build.filter({ project_id: project.id }, "-created_date", 1);
  return {
    project: projectView(project),
    latest_version: versions[0] ? { version_id: versions[0].id, number: versions[0].number, message: versions[0].message, created_date: versions[0].created_date } : null,
    latest_build: builds[0] ? { build_id: builds[0].id, status: builds[0].status, error_count: builds[0].error_count || 0, file_count: builds[0].file_count || 0 } : null,
  };
}

// Structured project state for an external AI client. Secrets appear as metadata only —
// the projection in authz.secretMetadata already stripped every value.
export async function getProjectContext(base44, user, projectId) {
  const { project } = await loadAuthorizedProject(base44, user, projectId, "project.read");
  const state = await loadProjectState(base44, project.id);
  const fs = createFs(state.files);
  const index = buildIndex(fs);
  const versions = await base44.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 5);
  const builds = await base44.entities.Build.filter({ project_id: project.id }, "-created_date", 1);
  return {
    project: projectView(project),
    files: index.map((f) => ({ path: f.path, size: f.size, exports: f.exports })),
    pages: index.filter((f) => f.path.startsWith("src/pages/")).map((f) => f.path),
    entities: state.entities.map((e) => ({ name: e.name, fields: e.fields })),
    backend_functions: describeFunctions(fs).map((f) => ({ name: f.name, path: f.path, config: f.config, secrets: f.secrets, integrations: f.integrations, entities: f.entities })),
    integrations: describeIntegrations(fs).map((i) => ({ name: i.name, base_url: i.base_url, auth_type: i.auth?.type, secret_name: i.auth?.secret || null, operations: (i.operations || []).map((o) => ({ name: o.name, method: o.method, path: o.path })) })),
    // Names + whether a value exists. Values are never available on this path.
    secrets: state.secrets.map((s) => ({ name: s.name, required: s.required, is_set: s.is_set })),
    versions: versions.map((v) => ({ version_id: v.id, number: v.number, message: v.message, created_date: v.created_date })),
    latest_build: builds[0] ? { status: builds[0].status, error_count: builds[0].error_count || 0 } : null,
  };
}

export async function listProjectFiles(base44, user, projectId, { include_content, path_prefix } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, projectId, "project.read");
  const rows = await (base44.asServiceRole || base44).entities.ProjectFile.filter({ project_id: project.id }, "path", MAX_FILES_LISTED);
  const filtered = path_prefix ? rows.filter((f) => f.path.startsWith(path_prefix)) : rows;
  if (!include_content) {
    return { files: filtered.map((f) => ({ path: f.path, frozen: !!f.frozen, stored_externally: !!f.content_url, size: (f.content || "").length })), content_included: false };
  }
  // Bounded on purpose: a whole-project dump is never returned implicitly.
  const hydrated = await unpackFileRecords(filtered.slice(0, 25));
  return {
    content_included: true, truncated_file_list: filtered.length > 25,
    files: hydrated.map((f) => ({ path: f.path, frozen: !!f.frozen, content: (f.content || "").slice(0, MAX_FILE_CHARS), content_truncated: (f.content || "").length > MAX_FILE_CHARS })),
  };
}

export async function readProjectFile(base44, user, projectId, path) {
  const { project } = await loadAuthorizedProject(base44, user, projectId, "project.read");
  if (!path) throw apiError("INVALID_INPUT", "path is required");
  const rows = await (base44.asServiceRole || base44).entities.ProjectFile.filter({ project_id: project.id, path }, "path", 1);
  if (!rows[0]) throw apiError("FILE_NOT_FOUND", `File not found in this project: ${path}`, 404);
  const [file] = await unpackFileRecords(rows);
  const content = file.content || "";
  return { project_id: project.id, path, frozen: !!file.frozen, size: content.length, truncated: content.length > MAX_FILE_CHARS, content: content.slice(0, MAX_FILE_CHARS) };
}

export async function getProjectVersions(base44, user, projectId) {
  const { project } = await loadAuthorizedProject(base44, user, projectId, "project.read");
  const rows = await base44.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 50);
  return {
    project_id: project.id, current_version: project.version_count || 0,
    versions: rows.map((v) => ({ version_id: v.id, number: v.number, message: v.message, run_id: v.run_id || null, restored_from_version_id: v.restored_from_version_id || null, changed_files: (v.changed_files || []).length, created_date: v.created_date })),
  };
}

export async function getRunStatus(base44, user, runId) {
  if (!runId) throw apiError("INVALID_INPUT", "run_id is required");
  const run = await base44.entities.AIRun.get(runId).catch(() => null);
  if (!run) throw apiError("RUN_NOT_FOUND", "Run not found", 404);
  // Authorization is derived from the run's project, through the existing layer.
  await loadAuthorizedProject(base44, user, run.project_id, "project.read");
  return {
    run_id: run.id, project_id: run.project_id, status: run.status, phase: run.phase || null, mode: run.mode,
    created_at: run.created_date, updated_at: run.updated_date, completed_at: run.completed_at || null,
    version_id: run.version_id || null, version_number: run.version_number || null,
    changed_files: (run.changed_files || []).map((c) => c.path), steps: (run.steps || []).map((s) => ({ label: s.label, status: s.status })),
    error: run.error ? String(run.error).slice(0, 1000) : null,
  };
}

export async function getBuildStatus(base44, user, projectId) {
  const { project } = await loadAuthorizedProject(base44, user, projectId, "project.read");
  const builds = await base44.entities.Build.filter({ project_id: project.id }, "-created_date", 1);
  const b = builds[0];
  if (!b) return { project_id: project.id, build: null };
  return {
    project_id: project.id,
    build: { build_id: b.id, status: b.status, error_count: b.error_count || 0, file_count: b.file_count || 0, duration_ms: b.duration_ms || 0, run_id: b.run_id || null, created_date: b.created_date, errors: (b.logs || []).filter((l) => l.startsWith("error")).slice(0, 20) },
  };
}

// Concurrency + volume rails, and prompt-level idempotency so a retried MCP call
// re-uses the in-flight run instead of enqueuing a second one.
export async function guardRunEnqueue(base44, project, prompt) {
  const recent = await base44.entities.AIRun.filter({ project_id: project.id }, "-created_date", 25);
  const existing = recent.find((r) => NON_TERMINAL.includes(r.status) && r.prompt === prompt);
  if (existing) return { reused: existing };
  const active = recent.filter((r) => NON_TERMINAL.includes(r.status));
  if (active.length >= MAX_ACTIVE_RUNS_PER_PROJECT) {
    throw apiError("RUN_LIMIT_REACHED", `This project already has ${active.length} AI run(s) in progress. Wait for them to finish (get_run_status) before starting another.`, 429);
  }
  const hourAgo = Date.now() - 3600000;
  if (recent.filter((r) => Date.parse(r.created_date) > hourAgo).length >= MAX_RUNS_PER_HOUR) {
    throw apiError("RATE_LIMITED", "Too many AI runs for this project in the last hour", 429);
  }
  return { reused: null };
}

export async function auditMcpTool(base44, { workspace_id, project_id, user_id, tool, ok, run_id, code, duration_ms }) {
  // Audit rows are server-written only (the entity refuses app-user creates), so the audit of an
  // MCP call is recorded with the service role. The acting user is still the one attributed.
  await audit(base44.asServiceRole || base44, {
    workspace_id, project_id: project_id || null, user_id,
    action: `mcp.server.${tool}`, resource: "McpTool", resource_id: run_id || project_id || null,
    metadata: { tool, ok, code: code || null, run_id: run_id || null, duration_ms: duration_ms || 0, via: "mcp_server" },
  });
}

// One wrapper for every MCP tool function: authenticate → run → audit → safe error.
export async function mcpTool(req, toolName, handler) {
  const started = Date.now();
  const { createClientFromRequest } = await import("npm:@base44/sdk@0.8.53");
  const base44 = createClientFromRequest(req);
  let user = null;
  try {
    user = await base44.auth.me();
  } catch { /* unauthenticated */ }
  if (!user) return Response.json({ error: { code: "UNAUTHENTICATED", message: "Valid authenticated credentials are required" } }, { status: 401 });

  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  let workspace = null;
  try {
    workspace = await callerWorkspace(base44, user);
    const result = await handler({ base44, user, workspace, body });
    await auditMcpTool(base44, { workspace_id: workspace.id, project_id: result?.project_id || body.project_id || null, user_id: user.id, tool: toolName, ok: true, run_id: result?.run_id, duration_ms: Date.now() - started });
    return Response.json(result);
  } catch (e) {
    const code = e.code || (e.status === 403 ? "FORBIDDEN" : e.status === 404 ? "NOT_FOUND" : "TOOL_FAILURE");
    if (workspace) await auditMcpTool(base44, { workspace_id: workspace.id, project_id: body.project_id || null, user_id: user.id, tool: toolName, ok: false, code, duration_ms: Date.now() - started }).catch(() => {});
    return Response.json({ error: { code, message: String(e.message).slice(0, 500) } }, { status: e.status || 400 });
  }
}