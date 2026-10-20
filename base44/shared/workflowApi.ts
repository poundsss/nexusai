// The authorized workflow surface (#28): definitions, versions, validation, finalization,
// triggering, inspection, cancellation and retry.
//
// Every operation resolves the project SERVER-side and re-authorizes the caller against it with an
// existing capability, so ownership is never taken from a client. A generated application reaches
// the same functions through `ctx.workflows`, scoped to the project that is executing it.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { scrub, scrubText } from "./tracing.ts";
import { invokePrimitive } from "./primitives.ts";
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";
import {
  WORKFLOW_CONTRACT_VERSION, WORKFLOW_LIMITS, STEP_DEFAULTS, TERMINAL_RUN_STATUSES,
  validateWorkflow, workflowChecksum, describeWorkflowContract,
} from "./workflowContract.ts";
import {
  advanceWorkflowRun, startWorkflowRun, dispatchWorkflowEvent,
  cancelWorkflowRunRecord, retryWorkflowRunRecord, publicRun, publicStepRun,
} from "./workflowEngine.ts";

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message, details = {}) => { throw Object.assign(new Error(message), { status, code, details }); };
const requireUser = (user) => { if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to manage workflows"); };

export { describeWorkflowContract };

export const publicDefinition = (d) => ({
  workflow_definition_id: d.id, workflow_key: d.workflow_key, name: d.name, description: d.description || null,
  version: d.version, status: d.status, finalized: !!d.finalized,
  project_id: d.project_id, trigger: d.trigger || {}, trigger_type: d.trigger_type || "manual",
  trigger_event: d.trigger_event || null, scheduled_trigger_id: d.scheduled_trigger_id || null,
  steps: d.steps || [], entry_step: d.entry_step || null, on_failure: d.on_failure || null,
  timeout_ms: d.timeout_ms ?? null, step_defaults: d.step_defaults || STEP_DEFAULTS,
  contract_version: d.contract_version || WORKFLOW_CONTRACT_VERSION,
  definition_checksum: d.definition_checksum || null, validation: d.validation || null,
  created_at: d.created_at || d.created_date, updated_at: d.updated_at || d.updated_date, finalized_at: d.finalized_at || null,
});

const keyFor = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, WORKFLOW_LIMITS.name_chars) || "workflow";

/** The names of the backend functions this project actually has — used to verify function steps. */
async function projectFunctionNames(svc, project_id) {
  const files = await svc.entities.ProjectFile.filter({ project_id }, "path", 500).catch(() => []);
  return files.map((f) => f.path).filter(isFunctionPath).map(functionNameFromPath);
}

/** Loads a definition and re-authorizes the caller against ITS project — never a client-supplied one. */
async function loadOwnedDefinition(base44, user, workflow_definition_id, capability = "project.read") {
  requireUser(user);
  const svc = svcOf(base44);
  const def = await svc.entities.WorkflowDefinition.get(String(workflow_definition_id || "")).catch(() => null);
  if (!def) fail(404, "WORKFLOW_NOT_FOUND", "Workflow not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, def.project_id, capability);
  return { def, project, workspace };
}

const normalizeDraft = (input) => ({
  name: String(input.name || "").slice(0, WORKFLOW_LIMITS.name_chars),
  description: input.description ? scrubText(input.description, 500) : null,
  trigger: input.trigger && typeof input.trigger === "object" ? scrub(input.trigger) : { type: "manual" },
  steps: Array.isArray(input.steps) ? scrub(input.steps).slice(0, WORKFLOW_LIMITS.steps) : [],
  entry_step: input.entry_step ? String(input.entry_step) : null,
  on_failure: input.on_failure ? String(input.on_failure) : null,
  timeout_ms: input.timeout_ms === undefined || input.timeout_ms === null ? null : Number(input.timeout_ms),
  step_defaults: { ...STEP_DEFAULTS, ...(input.step_defaults && typeof input.step_defaults === "object" ? input.step_defaults : {}) },
});

// --- definitions -------------------------------------------------------------------------

/** Creates the next DRAFT version of a workflow lineage. A definition is never created finalized. */
export async function createWorkflow(base44, user, { project_id, ...input } = {}) {
  requireUser(user);
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const svc = svcOf(base44);
  const draft = normalizeDraft(input);
  if (!draft.name) fail(400, "INVALID_INPUT", "name is required");
  const workflow_key = input.workflow_key ? keyFor(input.workflow_key) : keyFor(draft.name);
  const siblings = await svc.entities.WorkflowDefinition.filter({ project_id: project.id, workflow_key }, "-version", 50).catch(() => []);
  const version = (siblings[0]?.version || 0) + 1;
  const created = await svc.entities.WorkflowDefinition.create({
    ...draft, workflow_key, version, status: "DRAFT", finalized: false,
    project_id: project.id, workspace_id: workspace.id,
    trigger_type: String(draft.trigger?.type || "manual"), trigger_event: draft.trigger?.event ? String(draft.trigger.event) : null,
    contract_version: WORKFLOW_CONTRACT_VERSION,
    definition_checksum: workflowChecksum(draft),
    created_by: user.id, created_at: nowIso(), updated_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "workflow.created", resource: "WorkflowDefinition", resource_id: created.id,
    metadata: scrub({ workflow_key, version, trigger_type: created.trigger_type, steps: draft.steps.length }),
  }).catch(() => {});
  return publicDefinition(created);
}

/**
 * Updates a workflow. A DRAFT is edited in place; a FINALIZED version is IMMUTABLE, so editing one
 * produces the next DRAFT version of the same lineage instead of changing what existing runs execute.
 */
export async function updateWorkflow(base44, user, { workflow_definition_id, ...patch } = {}) {
  const { def, project, workspace } = await loadOwnedDefinition(base44, user, workflow_definition_id, "project.write");
  const svc = svcOf(base44);
  const merged = normalizeDraft({ ...publicDefinition(def), ...patch, name: patch.name || def.name });

  if (def.status !== "DRAFT") {
    const siblings = await svc.entities.WorkflowDefinition.filter({ project_id: project.id, workflow_key: def.workflow_key }, "-version", 50).catch(() => []);
    const next = await svc.entities.WorkflowDefinition.create({
      ...merged, workflow_key: def.workflow_key, version: (siblings[0]?.version || def.version) + 1,
      status: "DRAFT", finalized: false, project_id: project.id, workspace_id: workspace.id,
      trigger_type: String(merged.trigger?.type || "manual"), trigger_event: merged.trigger?.event ? String(merged.trigger.event) : null,
      contract_version: WORKFLOW_CONTRACT_VERSION, definition_checksum: workflowChecksum(merged),
      created_by: user.id, created_at: nowIso(), updated_at: nowIso(),
    });
    await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "workflow.version_created", resource: "WorkflowDefinition", resource_id: next.id, metadata: scrub({ workflow_key: def.workflow_key, from_version: def.version, version: next.version }) }).catch(() => {});
    return { ...publicDefinition(next), new_version: true, previous_version: def.version };
  }
  const saved = await svc.entities.WorkflowDefinition.update(def.id, {
    ...merged, trigger_type: String(merged.trigger?.type || "manual"),
    trigger_event: merged.trigger?.event ? String(merged.trigger.event) : null,
    definition_checksum: workflowChecksum(merged), validation: null, updated_at: nowIso(),
  });
  return { ...publicDefinition(saved), new_version: false };
}

/** Validates a definition against the project's real primitives and functions. Mutates nothing. */
export async function validateWorkflowDefinition(base44, user, { workflow_definition_id } = {}) {
  const { def, project } = await loadOwnedDefinition(base44, user, workflow_definition_id, "project.read");
  const svc = svcOf(base44);
  const report = validateWorkflow(publicDefinition(def), { functionNames: await projectFunctionNames(svc, project.id) });
  return { workflow_definition_id: def.id, workflow_key: def.workflow_key, version: def.version, status: def.status, ...report };
}

/**
 * Finalizes a version. Validation runs HERE against authoritative project state, so an invalid
 * workflow can never become runnable. Finalization also supersedes the previous finalized version
 * and, for a scheduled trigger, registers the schedule through the EXISTING scheduling primitive.
 */
export async function finalizeWorkflow(base44, user, { workflow_definition_id } = {}) {
  const { def, project, workspace } = await loadOwnedDefinition(base44, user, workflow_definition_id, "project.write");
  const svc = svcOf(base44);
  if (def.status === "FINALIZED") return { ...publicDefinition(def), already_finalized: true };
  if (def.status !== "DRAFT") fail(409, "WORKFLOW_NOT_DRAFT", `Only a DRAFT can be finalized; this version is ${def.status}`);

  const report = validateWorkflow(publicDefinition(def), { functionNames: await projectFunctionNames(svc, project.id) });
  await svc.entities.WorkflowDefinition.update(def.id, { validation: report, updated_at: nowIso() });
  if (!report.ok) fail(422, "WORKFLOW_INVALID", `This workflow cannot finalize: ${report.errors.slice(0, 4).join(" | ")}`, { failed_checks: report.failed_checks, checks: report.checks });

  // A scheduled workflow uses the platform's EXISTING scheduled-trigger infrastructure, reached
  // through the #27 ScheduleTask primitive — the workflow engine registers no scheduler of its own.
  let scheduled_trigger_id = def.scheduled_trigger_id || null;
  if (String(def.trigger?.type) === "schedule") {
    const res = await invokePrimitive(base44, {
      primitive: "ScheduleTask", project, actor: "system",
      idempotency_key: `workflow:${def.workflow_key}:${def.version}:schedule`,
      input: {
        operation: "create", function_name: String(def.trigger.function_name),
        ...(def.trigger.cron ? { cron: String(def.trigger.cron) } : { interval_seconds: Number(def.trigger.interval_seconds) }),
        payload: { workflow_key: def.workflow_key, workflow_version: def.version },
      },
    });
    if (!res.ok) fail(422, "WORKFLOW_SCHEDULE_FAILED", `The workflow schedule could not be registered: ${res.error.message}`, { error: res.error });
    scheduled_trigger_id = res.output.trigger_id;
  }

  const finalized = await svc.entities.WorkflowDefinition.update(def.id, {
    status: "FINALIZED", finalized: true, finalized_at: nowIso(), updated_at: nowIso(),
    scheduled_trigger_id, definition_checksum: workflowChecksum(publicDefinition(def)),
  });
  // The previous finalized version becomes SUPERSEDED. Its in-flight runs keep executing it.
  for (const prior of await svc.entities.WorkflowDefinition.filter({ project_id: project.id, workflow_key: def.workflow_key, status: "FINALIZED" }, "-version", 50).catch(() => [])) {
    if (prior.id !== finalized.id) await svc.entities.WorkflowDefinition.update(prior.id, { status: "SUPERSEDED", updated_at: nowIso() }).catch(() => {});
  }
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "workflow.finalized", resource: "WorkflowDefinition", resource_id: finalized.id,
    metadata: scrub({ workflow_key: def.workflow_key, version: def.version, checksum: finalized.definition_checksum, scheduled_trigger_id }),
  }).catch(() => {});
  return publicDefinition(finalized);
}

export async function listWorkflows(base44, user, { project_id, limit = 50 } = {}) {
  requireUser(user);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.WorkflowDefinition.filter({ project_id: project.id }, "-created_date", Math.min(Number(limit) || 50, 200));
  return { project_id: project.id, contract_version: WORKFLOW_CONTRACT_VERSION, count: rows.length, workflows: rows.map(publicDefinition) };
}

export async function getWorkflow(base44, user, { workflow_definition_id } = {}) {
  const { def } = await loadOwnedDefinition(base44, user, workflow_definition_id, "project.read");
  const svc = svcOf(base44);
  const runs = await svc.entities.WorkflowRun.filter({ workflow_id: def.id }, "-created_date", 20).catch(() => []);
  return { ...publicDefinition(def), runs: runs.map(publicRun) };
}

// --- triggering ---------------------------------------------------------------------------

/** Resolves the finalized version to run: an explicit version id, or the latest finalized one. */
async function resolveRunnable(svc, { project, workflow_definition_id = null, workflow_key = null, name = null }) {
  if (workflow_definition_id) {
    const def = await svc.entities.WorkflowDefinition.get(String(workflow_definition_id)).catch(() => null);
    if (!def || def.project_id !== project.id) fail(404, "WORKFLOW_NOT_FOUND", "Workflow not found in this project");
    return def;
  }
  const key = workflow_key ? keyFor(workflow_key) : keyFor(name);
  const [def] = await svc.entities.WorkflowDefinition.filter({ project_id: project.id, workflow_key: key, status: "FINALIZED" }, "-version", 1).catch(() => []);
  if (!def) fail(404, "WORKFLOW_NOT_FOUND", `No finalized workflow named "${name || workflow_key}" in this project`);
  return def;
}

export async function triggerWorkflow(base44, user, {
  project_id = null, workflow_definition_id = null, workflow_key = null, name = null,
  payload = null, idempotency_key = null, trace_id = null, run_id = null, inline = false, options = {},
} = {}) {
  requireUser(user);
  const svc = svcOf(base44);
  let project, workspace;
  if (workflow_definition_id) {
    const owned = await loadOwnedDefinition(base44, user, workflow_definition_id, "project.write");
    project = owned.project; workspace = owned.workspace;
  } else {
    const auth = await loadAuthorizedProject(base44, user, project_id, "project.write");
    project = auth.project; workspace = auth.workspace;
  }
  const definition = await resolveRunnable(svc, { project, workflow_definition_id, workflow_key, name });
  return startWorkflowRun(base44, {
    project, workspace, definition, payload, source: definition.trigger_type === "schedule" ? "schedule" : "manual",
    event: definition.trigger_event || null, idempotency_key, actor: "user", triggered_by: user.id,
    trace_id, run_id, inline, options,
  });
}

/** Authorized event dispatch — the same entry point the app surface and webhook path use. */
export async function dispatchEvent(base44, user, { project_id, source = "app_event", event = null, entity = null, operation = null, payload = null, idempotency_key = null, trace_id = null, run_id = null, inline = false, options = {} } = {}) {
  requireUser(user);
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  return dispatchWorkflowEvent(base44, { project, workspace, source, event, entity, operation, payload, idempotency_key, actor: "user", triggered_by: user.id, trace_id, run_id, inline, options });
}

// --- runs ----------------------------------------------------------------------------------

async function loadOwnedRun(base44, user, workflow_run_id, capability = "project.read") {
  requireUser(user);
  const svc = svcOf(base44);
  const run = await svc.entities.WorkflowRun.get(String(workflow_run_id || "")).catch(() => null);
  if (!run) fail(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, run.project_id, capability);
  return { run, project, workspace };
}

export async function getWorkflowRun(base44, user, { workflow_run_id } = {}) {
  const { run } = await loadOwnedRun(base44, user, workflow_run_id, "project.read");
  const svc = svcOf(base44);
  const steps = await svc.entities.WorkflowStepRun.filter({ workflow_run_id: run.id }, "created_date", 100).catch(() => []);
  return { ...publicRun(run), steps: steps.map(publicStepRun) };
}

export async function listWorkflowRuns(base44, user, { project_id, workflow_definition_id = null, status = null, limit = 50 } = {}) {
  requireUser(user);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.WorkflowRun.filter(
    { project_id: project.id, ...(workflow_definition_id ? { workflow_id: String(workflow_definition_id) } : {}), ...(status ? { status: String(status) } : {}) },
    "-created_date", Math.min(Number(limit) || 50, 200),
  );
  return { project_id: project.id, count: rows.length, runs: rows.map(publicRun) };
}

export async function cancelWorkflowRun(base44, user, { workflow_run_id, reason = null } = {}) {
  const { run } = await loadOwnedRun(base44, user, workflow_run_id, "project.write");
  return cancelWorkflowRunRecord(base44, run, { reason, user_id: user.id });
}

export async function retryWorkflowRun(base44, user, { workflow_run_id, inline = false, options = {} } = {}) {
  const { run } = await loadOwnedRun(base44, user, workflow_run_id, "project.write");
  return retryWorkflowRunRecord(base44, run, { user_id: user.id, inline, options });
}

/** Manually advances a run (used by operators and by certification); the queue does this normally. */
export async function advanceRun(base44, user, { workflow_run_id, options = {} } = {}) {
  const { run } = await loadOwnedRun(base44, user, workflow_run_id, "project.write");
  return advanceWorkflowRun(base44, { workflow_run_id: run.id, options });
}

// --- generated-app surface -------------------------------------------------------------------

/**
 * `ctx.workflows` for a generated application's server-side code.
 *
 * The project is captured from the EXECUTING project record, so nothing the sandbox passes can
 * point a dispatch, trigger or status read at another project. Generated code sees only workflow
 * names, bounded payloads and run status — never a client, a credential or a service role.
 */
export function createAppWorkflows(base44, { project, workspace, trace_id = null, run_id = null, end_user = null, options = {} } = {}) {
  const svc = svcOf(base44);
  const ws = async () => workspace || await svc.entities.Workspace.get(project.workspace_id).catch(() => null);
  return {
    dispatch: async (event, payload = null, opts = {}) => dispatchWorkflowEvent(base44, {
      project, workspace: await ws(), source: String(opts.source || "app_event"), event: String(event),
      entity: opts.entity || null, operation: opts.operation || null, payload,
      idempotency_key: opts.idempotency_key || null, actor: "app", triggered_by: end_user?.id || null,
      trace_id, run_id, inline: !!opts.inline, options,
    }),
    trigger: async (name, payload = null, opts = {}) => {
      const definition = await resolveRunnable(svc, { project, name: String(name) });
      return startWorkflowRun(base44, {
        project, workspace: await ws(), definition, payload, source: "app_event",
        event: definition.trigger_event || null, idempotency_key: opts.idempotency_key || null,
        actor: "app", triggered_by: end_user?.id || null, trace_id, run_id, inline: !!opts.inline, options,
      });
    },
    status: async (workflow_run_id) => {
      const run = await svc.entities.WorkflowRun.get(String(workflow_run_id || "")).catch(() => null);
      // Another project's run is reported as not found, so existence never leaks across projects.
      if (!run || run.project_id !== project.id) fail(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run not found for this project");
      return publicRun(run);
    },
    list: async () => (await svc.entities.WorkflowDefinition.filter({ project_id: project.id, status: "FINALIZED" }, "-version", 50).catch(() => []))
      .map((d) => ({ name: d.name, workflow_key: d.workflow_key, version: d.version, trigger_type: d.trigger_type, trigger_event: d.trigger_event || null })),
  };
}

export { TERMINAL_RUN_STATUSES };