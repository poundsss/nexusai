// #37 — the remaining NexusAI MCP server operations (files write, entities, build, version
// inspection, integrations, workflows).
//
// Like platformApi.ts this layer is deliberately THIN. Every operation delegates to the system
// that already owns the rule, so the MCP server adds a protocol surface and NOT a second
// implementation of anything:
//   • authorization / project + workspace scope ... authz.loadAuthorizedProject (+ the rbac matrix)
//   • file writes, version conflicts, build gate  ... collaboration.commitMemberEdit (#36 journalled commit)
//   • generated-app records                       ... appData.createServerDb (project-scoped db)
//   • build                                       ... buildEngine.runBuild + persistence.recordBuild
//   • version snapshots                           ... blobStore.unpackSnapshot
//   • integrations (metadata + test call)         ... integrationApiHelpers (#31 authorized path)
//   • workflows                                   ... workflowApi read operations only
//
// Two rules hold across the module:
//   1. READ vs WRITE is separated by capability: every read asks for project.read, every mutation
//      asks for project.write (a restore asks for version.restore), so a viewer's mutation is
//      refused before any state is touched.
//   2. NO CREDENTIAL LEAVES. Secrets appear as names plus is_set; integration documents are
//      projected to secret_refs; a version snapshot's secrets are references by construction.
import { apiError } from "./platformApi.ts";
import { loadAuthorizedProject, loadProjectState, secretMetadata } from "./authz.ts";
import { commitMemberEdit } from "./collaboration.ts";
import { createServerDb } from "./appData.ts";
import { createFs } from "./projectFs.ts";
import { runBuild } from "./buildEngine.ts";
import { recordBuild } from "./persistence.ts";
import { unpackSnapshot } from "./blobStore.ts";
import { makeInlineIntegrationApi } from "./integrationApiHelpers.ts";
import { listWorkflows as listWorkflowDefinitions, getWorkflow, listWorkflowRuns, getWorkflowRun } from "./workflowApi.ts";
import { getOrSet, scopedKey } from "./cache.ts";

const svcOf = (b) => b.asServiceRole || b;
export const MAX_RECORDS = 100;
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

/**
 * Replay protection for mutating tools. An AI client that retries a network-failed call must not
 * perform the mutation twice, so the FIRST result is recorded under the caller's key (scoped to
 * project + tool, server-side) and every later call with that key returns it verbatim.
 */
export async function once(base44, { project_id, tool, key }, fn) {
  if (!key) return fn();
  const cacheKey = scopedKey("mcp_idem", [project_id, tool, String(key).slice(0, 120)]);
  const { value, cached } = await getOrSet(base44, { key: cacheKey, namespace: "mcp_idem", ttl_ms: IDEMPOTENCY_TTL_MS, stale_ms: IDEMPOTENCY_TTL_MS, loader: () => fn().then((result) => ({ result })) });
  return { ...(value?.result || {}), replayed: !!cached };
}

// --- files (write) -----------------------------------------------------------------

/**
 * Writes or deletes ONE file, through the #36 journalled commit path — so an external client is
 * held to exactly the rules a collaborator in the UI is held to: project.write, the build gate,
 * the optimistic version check (a stale expected_version is refused with VERSION_CONFLICT and
 * changes nothing) and the same audit row.
 */
export async function writeProjectFile(base44, user, { project_id, path, content, delete: remove = false, expected_version = null, edit_id = null } = {}) {
  if (!path) throw apiError("INVALID_INPUT", "path is required");
  if (!remove && typeof content !== "string") throw apiError("INVALID_INPUT", "content is required (a string) unless delete is true");
  const edit = remove ? { path: String(path), delete: true } : { path: String(path), content };
  const out = await commitMemberEdit(base44, user, {
    project_id, edits: [edit], expected_version,
    message: `${remove ? "Deleted" : "Wrote"} ${path} via MCP`,
    edit_id: edit_id || null,
  });
  return {
    project_id: out.project_id, path: String(path), deleted: !!remove,
    unchanged: !!out.unchanged, replayed: !!out.replayed,
    version: out.version ? out.version.number : out.current_version ?? null,
    version_id: out.version ? out.version.version_id : null,
    changed_files: (out.changed_files || []).map((c) => `${c.change}:${c.path}`),
    build_status: out.build_status || "unchanged",
  };
}

// --- entities ----------------------------------------------------------------------

const schemaView = (e) => ({ entity: e.name, fields: e.fields || {}, field_count: Object.keys(e.fields || {}).length });

export async function listEntitySchemas(base44, user, { project_id } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.AppEntity.filter({ project_id: project.id }, "name", 200);
  return { project_id: project.id, count: rows.length, entities: rows.map(schemaView) };
}

async function entityDefs(base44, projectId) {
  const rows = await svcOf(base44).entities.AppEntity.filter({ project_id: projectId }, "name", 200);
  return rows.map((e) => ({ name: e.name, fields: e.fields || {} }));
}

export async function getEntitySchema(base44, user, { project_id, entity } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const defs = await entityDefs(base44, project.id);
  const def = defs.find((d) => d.name === String(entity || ""));
  if (!def) throw apiError("ENTITY_NOT_FOUND", `This project has no entity "${entity}" (declared: ${defs.map((d) => d.name).join(", ") || "none"})`, 404);
  return { project_id: project.id, ...schemaView(def) };
}

/**
 * Reads the generated application's records. The db accessor is bound to the AUTHORIZED project
 * id, never to anything the client passes, so a filter can never reach another project's records
 * and there is no route to the platform's own tables.
 */
export async function queryEntityRecords(base44, user, { project_id, entity, filter = null, sort = null, limit = 25, skip = 0 } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const defs = await entityDefs(base44, project.id);
  if (!defs.some((d) => d.name === String(entity || ""))) throw apiError("ENTITY_NOT_FOUND", `This project has no entity "${entity}"`, 404);
  const db = createServerDb(svcOf(base44), project.id, defs);
  const want = Math.min(Math.max(Number(limit) || 25, 1), MAX_RECORDS);
  const records = await db[entity].filter(filter && typeof filter === "object" ? filter : {}, sort || "-created_date", want, Number(skip) || 0);
  return { project_id: project.id, entity, count: records.length, limit: want, skip: Number(skip) || 0, records };
}

/**
 * Creates, updates or deletes ONE record. project.write is required, the same entity-schema
 * validation and relation enforcement the generated app runs applies (createServerDb owns it),
 * and an idempotency_key makes a retry a replay rather than a second mutation.
 */
export async function mutateEntityRecord(base44, user, { project_id, entity, operation, data = null, record_id = null, idempotency_key = null } = {}) {
  const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const op = String(operation || "");
  if (!["create", "update", "delete"].includes(op)) throw apiError("INVALID_INPUT", "operation must be create, update or delete");
  const defs = await entityDefs(base44, project.id);
  if (!defs.some((d) => d.name === String(entity || ""))) throw apiError("ENTITY_NOT_FOUND", `This project has no entity "${entity}"`, 404);
  if (op !== "create" && !record_id) throw apiError("INVALID_INPUT", "record_id is required for update and delete");

  const svc = svcOf(base44);
  const db = createServerDb(svc, project.id, defs);
  return once(base44, { project_id: project.id, tool: `mutate_entity_record:${entity}:${op}`, key: idempotency_key }, async () => {
    let record = null;
    if (op === "create") record = await db[entity].create(data && typeof data === "object" ? data : {});
    else if (op === "update") record = await db[entity].update(String(record_id), data && typeof data === "object" ? data : {});
    else await db[entity].delete(String(record_id));
    const { audit } = await import("./authz.ts");
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `mcp.record.${op}`, resource: "AppRecord", resource_id: record?.id || String(record_id || ""),
      metadata: { entity, operation: op, role, via: "mcp_server", fields: Object.keys(data || {}).slice(0, 20) },
    }).catch(() => {});
    return { project_id: project.id, entity, operation: op, record_id: record?.id || String(record_id || ""), record, deleted: op === "delete" };
  });
}

// --- build --------------------------------------------------------------------------

const buildView = (b) => ({
  build_id: b.id, project_id: b.project_id, status: b.status, error_count: b.error_count || 0,
  file_count: b.file_count || 0, duration_ms: b.duration_ms || 0, run_id: b.run_id || null,
  created_date: b.created_date, errors: (b.logs || []).filter((l) => l.startsWith("error")).slice(0, 20),
});

/**
 * Validates the project's CURRENT state and records a Build, exactly as the builder's own manual
 * build does. Project-scoped and non-destructive: it never changes files, entities or versions.
 */
export async function startProjectBuild(base44, user, { project_id } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const state = await loadProjectState(base44, project.id);
  const build = runBuild(createFs(state.files), state.entities, state.secrets);
  const rec = await recordBuild(svcOf(base44), project.id, null, build);
  await svcOf(base44).entities.Project.update(project.id, { last_build_status: build.status, status: build.status === "success" ? "ready" : "error" });
  return { project_id: project.id, ...buildView({ ...rec, logs: build.logs }) };
}

/** One build's structured result, authorized through the project the build belongs to. */
export async function getBuildResult(base44, user, { build_id } = {}) {
  if (!build_id) throw apiError("INVALID_INPUT", "build_id is required");
  const build = await svcOf(base44).entities.Build.get(String(build_id)).catch(() => null);
  if (!build) throw apiError("BUILD_NOT_FOUND", "Build not found", 404);
  // Authorization comes from the build's OWN project: another project's build is refused.
  const { project } = await loadAuthorizedProject(base44, user, build.project_id, "project.read");
  return { project_id: project.id, build: buildView(build), logs: (build.logs || []).slice(0, 200) };
}

// --- versions (inspection) ------------------------------------------------------------

/**
 * Inspects ONE immutable version: what it contains, without dumping it. File contents are
 * deliberately omitted (read_project_file serves those) and the snapshot's secrets are
 * references by construction, so no value can appear here.
 */
export async function inspectProjectVersion(base44, user, { project_id, version_id } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  if (!version_id) throw apiError("INVALID_INPUT", "version_id is required");
  const version = await svcOf(base44).entities.ProjectVersion.get(String(version_id)).catch(() => null);
  // Cross-project version access is refused rather than reported, so existence never leaks.
  if (!version || version.project_id !== project.id) throw apiError("VERSION_NOT_FOUND", "Version not found in this project", 404);
  const snapshot = await unpackSnapshot(version);
  return {
    project_id: project.id, current_version: project.version_count || 0,
    version: {
      version_id: version.id, number: version.number, message: version.message,
      run_id: version.run_id || null, parent_version_id: version.parent_version_id || null,
      restored_from_version_id: version.restored_from_version_id || null, created_date: version.created_date,
      changed_files: (version.changed_files || []).map((c) => `${c.change}:${c.path}`),
    },
    files: (snapshot.files || []).map((f) => ({ path: f.path, size: (f.content || "").length, frozen: !!f.frozen })),
    entities: (snapshot.entities || []).map((e) => ({ entity: e.name, fields: e.fields || {} })),
    secrets: secretMetadata(snapshot.secrets || []).map((s) => ({ name: s.name, required: s.required })),
  };
}

// --- integrations ---------------------------------------------------------------------

// One dispatcher, shared with the certified #31 Integration API: quota, rate limiting, the
// circuit breaker, tracing and audit all stay on that path.
const integrationApi = (base44) => makeInlineIntegrationApi(base44, svcOf(base44));

async function viaIntegrationApi(base44, user, payload) {
  const out = await integrationApi(base44)(user, payload);
  if (out.status >= 400) throw apiError(out.body?.code || (out.status === 403 ? "FORBIDDEN" : out.status === 404 ? "NOT_FOUND" : "INTEGRATION_ERROR"), out.body?.error || "Integration request failed", out.status);
  return out.body;
}

export async function listIntegrations(base44, user, { project_id } = {}) {
  const body = await viaIntegrationApi(base44, user, { action: "list", project_id });
  return { project_id, count: (body.integrations || []).length, integrations: body.integrations || [] };
}

export async function getIntegration(base44, user, { project_id, name } = {}) {
  const body = await viaIntegrationApi(base44, user, { action: "get", project_id, name });
  return { project_id, integration: body.integration };
}

/**
 * Executes one declared operation of one integration through the project's real runtime — the
 * same authorized execution path the Builder's Test button uses. The credential is resolved
 * server-side inside that runtime and never crosses this boundary.
 */
export async function testIntegrationCall(base44, user, { project_id, name, operation, args = null, idempotency_key = null } = {}) {
  return once(base44, { project_id, tool: `test_integration_call:${name}:${operation}`, key: idempotency_key }, async () => {
    const body = await viaIntegrationApi(base44, user, { action: "test_call", project_id, name, operation, args: args || {} });
    return { project_id, integration: name, operation, result: body.result, invocation_id: body.invocation_id || null, trace_id: body.trace_id || null };
  });
}

// --- workflows (safe, read-only) --------------------------------------------------------
// Only inspection is exposed. Creating, finalizing, triggering, retrying, cancelling and
// advancing a workflow are NOT reachable from the MCP server: an external client can read what
// a project's workflows are and how their runs went, and nothing else.

export async function mcpListWorkflows(base44, user, { project_id, include_runs = false, limit = 50 } = {}) {
  const defs = await listWorkflowDefinitions(base44, user, { project_id, limit });
  const out = {
    project_id: defs.project_id, contract_version: defs.contract_version, count: defs.count,
    workflows: defs.workflows.map((w) => ({
      workflow_definition_id: w.workflow_definition_id, workflow_key: w.workflow_key, name: w.name,
      version: w.version, status: w.status, finalized: w.finalized, trigger_type: w.trigger_type,
      trigger_event: w.trigger_event, steps: (w.steps || []).map((s) => s.name || s.id || s.type).slice(0, 40),
      step_count: (w.steps || []).length, created_at: w.created_at,
    })),
  };
  if (!include_runs) return out;
  const runs = await listWorkflowRuns(base44, user, { project_id, limit });
  return { ...out, runs: runs.runs };
}

export async function mcpGetWorkflow(base44, user, { workflow_definition_id } = {}) {
  const def = await getWorkflow(base44, user, { workflow_definition_id });
  return { workflow_definition_id: def.workflow_definition_id, project_id: def.project_id, workflow_key: def.workflow_key, name: def.name, version: def.version, status: def.status, finalized: def.finalized, trigger_type: def.trigger_type, trigger_event: def.trigger_event, steps: def.steps || [], validation: def.validation || null, runs: def.runs || [] };
}

export async function mcpGetWorkflowRun(base44, user, { workflow_run_id } = {}) {
  return getWorkflowRun(base44, user, { workflow_run_id });
}