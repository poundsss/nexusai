// THE durable workflow executor (#28).
//
// One function advances a workflow run, and every advance is a persisted transition. That is what
// makes the guarantees below properties of the ENGINE rather than of a caller:
//
//   • DURABILITY — run status, current step, attempt count and context are written to the run row
//     after every meaningful transition. Nothing correctness-relevant lives in memory, so a worker
//     restart, a crashed process or a re-delivered queue job resumes exactly where the run was.
//   • NO SECOND INFRASTRUCTURE — continuations, delays, retry backoff and dead-lettering are the
//     EXISTING job queue's; primitive execution is the EXISTING #27 executor; function execution is
//     the EXISTING function runtime; schedules are the EXISTING scheduled triggers; correlation is
//     the EXISTING trace system; AI cost is the EXISTING credit path. This module opens none of them.
//   • IDEMPOTENCY — every step operation has a deterministic key. A step that already SUCCEEDED is
//     replayed from its stored output instead of executed again, so a resumed or re-delivered run
//     cannot repeat a side effect.
//   • BOUNDED RETRIES — only a failure that is a property of the moment retries, within the step's
//     persisted attempt budget. Authorization, validation and deterministic policy failures never do.
//   • VERSION PINNING — a run reads the definition row it captured at start, so a new version
//     landing mid-run cannot change what the run executes.
import { audit } from "./authz.ts";
import { recordSpan, scrub, scrubText, newTraceId } from "./tracing.ts";
import { invokePrimitive } from "./primitives.ts";
import { resolvePrimitive } from "./primitiveContract.ts";
import { enqueue, cancel as cancelJob, backoffMs } from "./jobQueue.ts";
import {
  WORKFLOW_CONTRACT_VERSION, WORKFLOW_JOB_TYPE, WORKFLOW_QUEUE, WORKFLOW_LIMITS, STEP_DEFAULTS,
  TERMINAL_RUN_STATUSES, RETRYABLE_STEP_CATEGORIES,
  resolveTemplate, evaluateCondition, boundValue, boundContext, triggerMatches,
} from "./workflowContract.ts";
import { evalJqCondition } from "./jqCondition.ts";

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const ADVANCE_BUDGET_MS = 20000;
const ADVANCE_MAX_STEPS = 25;

export const stepError = (code, category, message, retryable = null) => Object.assign(new Error(String(message || code)), {
  step_error: true, code, category,
  retryable: retryable === null ? RETRYABLE_STEP_CATEGORIES.includes(category) : !!retryable,
});

const fail = (status, code, message, details = {}) => { throw Object.assign(new Error(message), { status, code, details }); };

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(stepError("STEP_TIMEOUT", "timeout", `${label} exceeded its ${ms}ms budget`, true)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

export const publicRun = (r) => ({
  workflow_run_id: r.id, workflow_id: r.workflow_id, workflow_key: r.workflow_key || null,
  workflow_version: r.workflow_version ?? null, definition_checksum: r.definition_checksum || null,
  project_id: r.project_id, status: r.status, current_step: r.current_step || null,
  attempt: r.attempt || 0, steps_completed: r.steps_completed || 0,
  trigger: r.trigger || {}, trigger_source: r.trigger_source || "manual",
  trigger_idempotency_key: r.trigger_idempotency_key || null,
  context: r.context || {}, output: r.output || null, error: r.error || null,
  failed_step_id: r.failed_step_id || null, compensation: r.compensation || null,
  cancel_requested: !!r.cancel_requested, cancel_reason: r.cancel_reason || null,
  timeout_at: r.timeout_at || null, resume_at: r.resume_at || null,
  trace_id: r.trace_id || null, run_id: r.run_id || null, job_id: r.job_id || null,
  actor: r.actor || "user", started_at: r.started_at || null, completed_at: r.completed_at || null,
  duration_ms: r.duration_ms ?? null,
});

export const publicStepRun = (s) => ({
  step_run_id: s.id, step_id: s.step_id, step_type: s.step_type, status: s.status,
  attempt: s.attempt || 1, operation_key: s.operation_key, output: s.output || null,
  error_code: s.error_code || null, error_category: s.error_category || null,
  retryable: !!s.retryable, error_message: s.error_message || null,
  primitive_invocation_id: s.primitive_invocation_id || null,
  function_invocation_id: s.function_invocation_id || null, job_id: s.job_id || null,
  usage: s.usage || null, latency_ms: s.latency_ms || 0, resume_at: s.resume_at || null,
  started_at: s.started_at || null, completed_at: s.completed_at || null,
});

// --- queue integration ---------------------------------------------------------------

/**
 * Schedules the run's next advance on the EXISTING durable queue. The idempotency key makes a
 * duplicate enqueue (a retried caller, a re-delivered job) return the in-flight job instead of
 * queuing a second advance for the same run.
 */
async function enqueueAdvance(base44, run, { delay_ms = 0, suffix = "next" } = {}) {
  const { job, duplicate } = await enqueue(base44, {
    queue: WORKFLOW_QUEUE, job_type: WORKFLOW_JOB_TYPE,
    payload: { workflow_run_id: run.id, project_id: run.project_id },
    delay_ms: Math.max(0, delay_ms),
    idempotency_key: `wf:${run.id}:${suffix}`,
    workspace_id: run.workspace_id || null, project_id: run.project_id, trace_id: run.trace_id || null,
  });
  await svcOf(base44).entities.WorkflowRun.update(run.id, { job_id: job.id }).catch(() => {});
  return { job_id: job.id, duplicate: !!duplicate, delay_ms };
}

// --- step records (deterministic operation keys) ---------------------------------------

const operationKey = (run, step) => `wf:${run.id}:${step.id}`;

async function loadStepRun(svc, run, step) {
  const [row] = await svc.entities.WorkflowStepRun.filter({ workflow_run_id: run.id, step_id: String(step.id) }, "-created_date", 1).catch(() => []);
  return row || null;
}

async function upsertStepRun(svc, run, step, patch, existing) {
  const base = {
    workflow_run_id: run.id, workflow_id: run.workflow_id, project_id: run.project_id,
    workspace_id: run.workspace_id || null, step_id: String(step.id), step_type: String(step.type),
    operation_key: operationKey(run, step), trace_id: run.trace_id || null,
  };
  if (existing) return svc.entities.WorkflowStepRun.update(existing.id, patch);
  return svc.entities.WorkflowStepRun.create({ ...base, started_at: nowIso(), ...patch });
}

// --- step execution --------------------------------------------------------------------

/** A primitive step. Always through the EXISTING #27 executor — never a provider API directly. */
async function runPrimitiveStep(base44, { project, run, step, context, options, job_id, queue = false }) {
  const contract = resolvePrimitive(String(step.primitive || ""), step.primitive_version || null);
  if (!contract) throw stepError("PRIMITIVE_NOT_FOUND", "validation", `Unknown primitive "${step.primitive}"`, false);
  const input = resolveTemplate(step.input || {}, context);

  // A queued step hands the work to the BackgroundJob primitive, which is itself the platform's
  // existing queue — the workflow layer never enqueues provider work of its own.
  const target = queue
    ? { primitive: "BackgroundJob", version: null, input: { operation: "enqueue", primitive: contract.name, primitive_version: contract.version, input } }
    : { primitive: contract.name, version: contract.version, input };
  const targetContract = queue ? resolvePrimitive("BackgroundJob") : contract;
  // The step's own deterministic operation key is the primitive's idempotency key, so a replayed
  // step cannot produce the side effect twice even at the primitive layer.
  const key = targetContract.idempotency.supported ? operationKey(run, step) : null;

  const res = await invokePrimitive(base44, {
    ...target, project, actor: "system",
    idempotency_key: key, trace_id: run.trace_id || null, run_id: run.run_id || null, job_id: job_id || null,
    options: options || {},
  });
  if (!res.ok) throw stepError(res.error.code, res.error.category, res.error.message, res.error.retryable);
  return {
    output: res.output, usage: res.usage || null, primitive_invocation_id: res.invocation_id || null,
    job_id: queue ? res.output?.job_id || null : null,
  };
}

/**
 * A backend-function step. Executed by the EXISTING function runtime: the source comes from the
 * project's live deployment artifact when it has one, otherwise from the project's own function
 * file. Secrets are resolved and redacted inside that runtime and never reach the workflow.
 */
async function runFunctionStep(base44, { project, run, step, context }) {
  const svc = svcOf(base44);
  const name = String(step.function_name || "");
  const { executeProjectFunction, loadProjectFunction } = await import("./functionRuntime.ts");

  let source = null, source_of = null, entities = null;
  try {
    const { currentLiveDeployment, loadArtifactPayload } = await import("./deploy.ts");
    const live = await currentLiveDeployment(svc, project).catch(() => null);
    if (live) {
      const artifact = await svc.entities.DeploymentArtifact.get(live.artifact_id).catch(() => null);
      if (artifact && artifact.project_id === project.id) {
        const payload = await loadArtifactPayload(artifact).catch(() => null);
        const fn = (payload?.functions || []).find((f) => f.name === name);
        if (fn) { source = fn.source; source_of = "deployment_artifact"; entities = payload.entities || null; }
      }
    }
  } catch { /* no live deployment: fall back to the project's own function file */ }

  if (!source) {
    const loaded = await loadProjectFunction(svc, project.id, name).catch(() => null);
    if (!loaded) throw stepError("FUNCTION_NOT_FOUND", "validation", `Backend function "${name}" does not exist in this project`, false);
    source = loaded.source; source_of = "project_files";
  }
  if (!entities) {
    entities = (await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 200).catch(() => []))
      .map((e) => ({ name: e.name, fields: e.fields || {} }));
  }

  const res = await executeProjectFunction(svc, {
    project, entities, integrations: [], name, source,
    trigger: "scheduled", requestId: crypto.randomUUID(),
    request: { method: "POST", query: {}, headers: {}, body: resolveTemplate(step.input || {}, context) },
    user: null, trace_id: run.trace_id || null, run_id: run.run_id || null,
  });
  if (res.status >= 400) {
    // A 5xx is a property of the moment and may retry; a 4xx is deterministic and never does.
    throw Object.assign(
      stepError("FUNCTION_STEP_FAILED", res.status >= 500 ? "provider" : "validation",
        scrubText(typeof res.body === "string" ? res.body : JSON.stringify(res.body?.error || res.body), 240), res.status >= 500),
      { function_invocation_id: res.invocation_id || null },
    );
  }
  return {
    output: { status: res.status, body: res.body ?? null, source: source_of },
    function_invocation_id: res.invocation_id || null,
  };
}

// --- the advance loop -------------------------------------------------------------------

/**
 * Advances ONE run as far as it can inside a bounded slice, persisting every transition. Returns
 * without holding a worker when it hits a delay, a retry backoff, its slice budget or a terminal
 * state; in every one of those cases the continuation is already queued.
 */
export async function advanceWorkflowRun(base44, { workflow_run_id, job_id = null, budget_ms = ADVANCE_BUDGET_MS, max_steps = ADVANCE_MAX_STEPS, options = {} } = {}) {
  const svc = svcOf(base44);
  const sliceStarted = Date.now();
  let run = await svc.entities.WorkflowRun.get(String(workflow_run_id)).catch(() => null);
  if (!run) fail(404, "WORKFLOW_RUN_NOT_FOUND", "Workflow run not found");
  if (TERMINAL_RUN_STATUSES.includes(run.status)) return { ...publicRun(run), outcome: "already_terminal" };

  // The run reads the definition ROW IT CAPTURED — never "the latest version".
  const def = await svc.entities.WorkflowDefinition.get(run.workflow_id).catch(() => null);
  if (!def) fail(404, "WORKFLOW_NOT_FOUND", "The workflow definition for this run no longer exists");
  const project = await svc.entities.Project.get(run.project_id).catch(() => null);
  if (!project) fail(404, "PROJECT_NOT_FOUND", "Project not found");
  const stepsById = new Map((def.steps || []).map((s) => [String(s.id), s]));
  const defaults = { ...STEP_DEFAULTS, ...(def.step_defaults || {}) };

  let context = run.context || { trigger: null, steps: {} };
  let compensating = !!run.compensation?.running;
  let pendingFailure = compensating ? run.error || null : null;

  const persist = async (patch) => { run = await svc.entities.WorkflowRun.update(run.id, patch); return run; };

  const span = (name, status, extra = {}) => recordSpan(base44, {
    trace_id: run.trace_id || null, workspace_id: run.workspace_id || null, project_id: run.project_id,
    run_id: run.run_id || null, job_id: job_id || null, event_type: "background_job",
    name, status, reference_id: run.id, metadata: scrub({ workflow_id: run.workflow_id, workflow_version: run.workflow_version, workflow_run_id: run.id, ...extra }),
    ...(extra.duration_ms ? { duration_ms: extra.duration_ms } : {}),
    ...(extra.attempt ? { attempt: extra.attempt } : {}),
    ...(extra.error ? { error: extra.error, error_code: extra.error_code } : {}),
  }).catch(() => {});

  const finish = async (status, patch, extra = {}) => {
    const started = Date.parse(run.started_at || run.created_date);
    await persist({
      status, context: boundContext(context), completed_at: nowIso(),
      duration_ms: Number.isFinite(started) ? Date.now() - started : 0, resume_at: null, ...patch,
    });
    await span(`workflow.${status.toLowerCase()}`, status === "COMPLETED" ? "ok" : "error", extra);
    await audit(svc, {
      workspace_id: run.workspace_id || null, project_id: run.project_id, user_id: run.triggered_by || null,
      action: `workflow.run_${status.toLowerCase()}`, resource: "WorkflowRun", resource_id: run.id,
      metadata: scrub({ workflow_key: run.workflow_key, workflow_version: run.workflow_version, failed_step_id: patch.failed_step_id || null, error_code: patch.error?.code || null, trace_id: run.trace_id }),
    }).catch(() => {});
    return { ...publicRun(run), outcome: status.toLowerCase() };
  };

  // A terminal step failure. When the definition declares a failure hook, the run continues into
  // that compensating branch — and still ends FAILED: a hook never turns a failure into a success.
  const failTerminally = async (error, step_id) => {
    if (def.on_failure && stepsById.has(String(def.on_failure)) && !compensating && String(def.on_failure) !== String(step_id)) {
      compensating = true;
      pendingFailure = error;
      await persist({ status: "RUNNING", current_step: String(def.on_failure), attempt: 0, error, failed_step_id: step_id, compensation: { running: true, hook: String(def.on_failure), started_at: nowIso() } });
      return { continue_at: String(def.on_failure) };
    }
    return { done: await finish("FAILED", { error, failed_step_id: step_id, ...(compensating ? { compensation: { ...(run.compensation || {}), running: false, completed: true, completed_at: nowIso() } } : {}) }, { error_code: error.code, step_id }) };
  };

  if (run.status === "PENDING") await persist({ status: "RUNNING", started_at: run.started_at || nowIso() });
  let stepId = String(run.current_step || def.entry_step || "");
  let executed = 0;

  while (stepId) {
    // Cancellation and the workflow-level deadline are re-read from the row every iteration, so a
    // cancel or a timeout lands between steps and never interrupts a partial write.
    const fresh = await svc.entities.WorkflowRun.get(run.id);
    if (TERMINAL_RUN_STATUSES.includes(fresh.status)) return { ...publicRun(fresh), outcome: "already_terminal" };
    run = fresh;
    if (run.cancel_requested) {
      return await finish("CANCELLED", { current_step: stepId, cancel_reason: run.cancel_reason || "cancelled" }, { step_id: stepId });
    }
    if (run.timeout_at && Date.now() > Date.parse(run.timeout_at)) {
      const out = await failTerminally({ code: "WORKFLOW_TIMEOUT", category: "timeout", retryable: false, message: `The workflow exceeded its ${def.timeout_ms}ms budget`, step_id: stepId }, stepId);
      if (out.done) return out.done;
      stepId = out.continue_at; continue;
    }

    const step = stepsById.get(stepId);
    if (!step) {
      const out = await failTerminally({ code: "STEP_NOT_FOUND", category: "validation", retryable: false, message: `Step "${stepId}" is not part of this workflow version`, step_id: stepId }, stepId);
      if (out.done) return out.done;
      stepId = out.continue_at; continue;
    }

    // Slice budget: the run yields to the queue rather than holding a worker open.
    if (executed >= max_steps || Date.now() - sliceStarted > budget_ms) {
      await persist({ status: "RUNNING", current_step: stepId, context: boundContext(context) });
      const queued = await enqueueAdvance(base44, run, { suffix: `slice:${stepId}:${Date.now()}` });
      return { ...publicRun(run), outcome: "yielded", continuation_job_id: queued.job_id };
    }

    const existing = await loadStepRun(svc, run, step);
    // IDEMPOTENCY: a step that already succeeded is replayed from its stored output instead of
    // executed again. Deterministic, side-effect-free steps (a condition and the terminal steps)
    // are re-evaluated, so a resumed run re-establishes its outcome rather than running off the end.
    if (existing && existing.status === "succeeded" && !["condition", "complete", "fail"].includes(step.type)) {
      context = { ...context, steps: { ...(context.steps || {}), [step.id]: existing.output ?? null } };
      stepId = String(step.next || "");
      await persist({ current_step: stepId || null, context: boundContext(context), attempt: 0 });
      continue;
    }

    // ---------------- durable delay: WAITING, no worker held ----------------
    if (step.type === "delay") {
      const resumeAt = existing?.resume_at || new Date(Date.now() + Number(step.delay_ms || 0)).toISOString();
      const remaining = Date.parse(resumeAt) - Date.now();
      if (remaining > 0) {
        await upsertStepRun(svc, run, step, { status: "waiting", resume_at: resumeAt, attempt: existing?.attempt || 1 }, existing);
        await persist({ status: "WAITING", current_step: stepId, resume_at: resumeAt, context: boundContext(context) });
        const queued = await enqueueAdvance(base44, run, { delay_ms: remaining, suffix: `delay:${step.id}` });
        await span(`workflow.delay:${step.id}`, "ok", { resume_at: resumeAt, continuation_job_id: queued.job_id });
        return { ...publicRun(run), outcome: "waiting", resume_at: resumeAt, continuation_job_id: queued.job_id };
      }
      await upsertStepRun(svc, run, step, { status: "succeeded", output: { waited_ms: Number(step.delay_ms || 0) }, completed_at: nowIso() }, existing);
      context = { ...context, steps: { ...(context.steps || {}), [step.id]: { waited_ms: Number(step.delay_ms || 0) } } };
      stepId = String(step.next || "");
      await persist({ status: "RUNNING", current_step: stepId || null, resume_at: null, context: boundContext(context), steps_completed: (run.steps_completed || 0) + 1 });
      continue;
    }

    // ---------------- deterministic condition (no model, no side effect) ----------------
    if (step.type === "condition") {
      const result = evaluateCondition(step.condition, context);
      await upsertStepRun(svc, run, step, { status: "succeeded", output: { result }, completed_at: nowIso(), attempt: 1 }, existing);
      context = { ...context, steps: { ...(context.steps || {}), [step.id]: { result } } };
      stepId = String(result ? step.if_true : step.if_false);
      await persist({ current_step: stepId, context: boundContext(context), steps_completed: (run.steps_completed || 0) + 1 });
      await span(`workflow.condition:${step.id}`, "ok", { result, next: stepId });
      continue;
    }

    // ---------------- terminal steps ----------------
    if (step.type === "complete") {
      const output = boundValue(resolveTemplate(step.output || {}, context));
      await upsertStepRun(svc, run, step, { status: "succeeded", output, completed_at: nowIso(), attempt: 1 }, existing);
      if (compensating) {
        return await finish("FAILED", { current_step: null, error: pendingFailure, failed_step_id: run.failed_step_id || null, compensation: { ...(run.compensation || {}), running: false, completed: true, output, completed_at: nowIso() } }, { error_code: pendingFailure?.code || null, compensated: true });
      }
      return await finish("COMPLETED", { current_step: null, output, error: null, steps_completed: (run.steps_completed || 0) + 1 });
    }
    if (step.type === "fail") {
      const error = { code: String(step.error_code || "WORKFLOW_FAILED"), category: "validation", retryable: false, message: scrubText(step.message || "The workflow declared a failure", 240), step_id: step.id };
      await upsertStepRun(svc, run, step, { status: "failed", error_code: error.code, error_category: error.category, error_message: error.message, retryable: false, completed_at: nowIso(), attempt: 1 }, existing);
      if (compensating) {
        return await finish("FAILED", { current_step: null, error: pendingFailure || error, failed_step_id: run.failed_step_id || step.id, compensation: { ...(run.compensation || {}), running: false, completed: true, completed_at: nowIso() } }, { error_code: (pendingFailure || error).code, compensated: true });
      }
      const out = await failTerminally(error, step.id);
      if (out.done) return out.done;
      stepId = out.continue_at; continue;
    }

    // ---------------- work steps: primitive / function / queued job ----------------
    const maxAttempts = Math.min(Number(step.max_attempts || defaults.max_attempts), WORKFLOW_LIMITS.max_attempts);
    const timeoutMs = Math.min(Number(step.timeout_ms || defaults.timeout_ms), WORKFLOW_LIMITS.step_timeout_ms);
    const attempt = (existing?.attempt || 0) + 1;
    const record = await upsertStepRun(svc, run, step, { status: "running", attempt, started_at: existing?.started_at || nowIso(), error_code: null, error_message: null }, existing);
    await persist({ status: "RUNNING", current_step: stepId, attempt });
    const stepStarted = Date.now();
    executed++;

    try {
      const exec = step.type === "primitive"
        ? runPrimitiveStep(base44, { project, run, step, context, options, job_id })
        : step.type === "enqueue_job"
          ? runPrimitiveStep(base44, { project, run, step, context, options, job_id, queue: true })
          : runFunctionStep(base44, { project, run, step, context });
      const res = await withTimeout(exec, timeoutMs, `step ${step.id}`);
      const output = boundValue(scrub(res.output ?? null));
      const latency_ms = Date.now() - stepStarted;
      await svc.entities.WorkflowStepRun.update(record.id, {
        status: "succeeded", output, usage: res.usage ? scrub(res.usage) : null,
        primitive_invocation_id: res.primitive_invocation_id || null,
        function_invocation_id: res.function_invocation_id || null, job_id: res.job_id || null,
        latency_ms, completed_at: nowIso(),
      });
      context = { ...context, steps: { ...(context.steps || {}), [step.id]: output } };
      stepId = String(step.next || "");
      await persist({ current_step: stepId || null, attempt: 0, context: boundContext(context), steps_completed: (run.steps_completed || 0) + 1 });
      await span(`workflow.step:${step.id}`, "ok", { step_type: step.type, attempt, duration_ms: latency_ms, primitive: step.primitive || null, function_name: step.function_name || null });
      continue;
    } catch (e) {
      const code = e.step_error ? e.code : "STEP_EXECUTION_FAILED";
      const category = e.step_error ? e.category : "internal";
      const retryable = e.step_error ? !!e.retryable : false;
      const latency_ms = Date.now() - stepStarted;
      const message = scrubText(e.message, 240);
      await svc.entities.WorkflowStepRun.update(record.id, {
        status: "failed", error_code: code, error_category: category, retryable,
        error_message: message, latency_ms, completed_at: nowIso(),
        function_invocation_id: e.function_invocation_id || null,
      });
      await span(`workflow.step:${step.id}`, "error", { step_type: step.type, attempt, duration_ms: latency_ms, error: e, error_code: code, retryable });

      // Bounded retry — the attempt count lives on the persisted step row, so a worker restart
      // cannot hand the step a fresh budget. Backoff is the existing queue's.
      if (retryable && attempt < maxAttempts) {
        await persist({ status: "RUNNING", current_step: stepId, attempt, error: { code, category, retryable, message, step_id: step.id } });
        const queued = await enqueueAdvance(base44, run, { delay_ms: backoffMs(attempt), suffix: `retry:${step.id}:${attempt}` });
        return { ...publicRun(run), outcome: "retry_scheduled", attempt, next_attempt_job_id: queued.job_id, error: { code, category, retryable, message, step_id: step.id } };
      }
      // An explicit error branch keeps the run alive without pretending the step succeeded.
      if (step.on_error && stepsById.has(String(step.on_error))) {
        context = { ...context, steps: { ...(context.steps || {}), [step.id]: { error: code, message } } };
        stepId = String(step.on_error);
        await persist({ current_step: stepId, attempt: 0, context: boundContext(context) });
        continue;
      }
      const out = await failTerminally({ code, category, retryable, message, step_id: step.id, attempts: attempt }, step.id);
      if (out.done) return out.done;
      stepId = out.continue_at; continue;
    }
  }

  // No next step: a definition that finalized cannot reach here (validation requires terminals),
  // but an exhausted path is still reported as a deterministic failure rather than a silent stop.
  return await finish("FAILED", { error: { code: "WORKFLOW_INCOMPLETE", category: "validation", retryable: false, message: "The workflow reached no terminal step" } }, { error_code: "WORKFLOW_INCOMPLETE" });
}

// --- starting runs ----------------------------------------------------------------------

/**
 * Starts a run against ONE finalized definition version.
 *
 * Trigger idempotency: a repeated trigger carrying the same key resolves to the FIRST run for that
 * workflow, so a replayed webhook delivery or a redundant scheduler tick cannot create a second
 * logical run. `inline` executes the first slice immediately (the run is still fully durable);
 * otherwise the advance is handed straight to the existing queue.
 */
export async function startWorkflowRun(base44, {
  project, workspace, definition, payload = null,
  source = "manual", event = null, reference = null, idempotency_key = null,
  actor = "user", triggered_by = null, trace_id = null, run_id = null,
  inline = false, options = {},
} = {}) {
  const svc = svcOf(base44);
  if (definition.status !== "FINALIZED") fail(409, "WORKFLOW_NOT_FINALIZED", `Workflow "${definition.name}" v${definition.version} is ${definition.status}; only a finalized version can run`);
  if (definition.project_id !== project.id) fail(403, "WORKFLOW_FORBIDDEN", "This workflow belongs to another project");

  const key = idempotency_key ? String(idempotency_key).slice(0, 200) : null;
  if (key) {
    const [prior] = await svc.entities.WorkflowRun.filter({ project_id: project.id, workflow_key: definition.workflow_key, trigger_idempotency_key: key }, "-created_date", 1).catch(() => []);
    if (prior) return { ...publicRun(prior), duplicate: true, outcome: "duplicate_trigger" };
  }

  const trace = trace_id || newTraceId();
  const created = await svc.entities.WorkflowRun.create({
    workflow_id: definition.id, workflow_key: definition.workflow_key, workflow_version: definition.version,
    definition_checksum: definition.definition_checksum || null,
    project_id: project.id, workspace_id: workspace.id,
    trigger: scrub({ source, event: event || definition.trigger?.event || null, reference: reference || null, idempotency_key: key }),
    trigger_source: source, trigger_idempotency_key: key,
    status: "PENDING", current_step: definition.entry_step || null, attempt: 0, steps_completed: 0,
    context: boundContext({ trigger: boundValue(scrub(payload ?? null)), steps: {}, project: { project_id: project.id } }),
    timeout_at: definition.timeout_ms ? new Date(Date.now() + Number(definition.timeout_ms)).toISOString() : null,
    trace_id: trace, run_id: run_id || null, actor, triggered_by: triggered_by || null, started_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: triggered_by || null,
    action: "workflow.triggered", resource: "WorkflowRun", resource_id: created.id,
    metadata: scrub({ workflow_key: definition.workflow_key, workflow_version: definition.version, source, event, idempotency_key: key, trace_id: trace }),
  }).catch(() => {});
  await recordSpan(base44, {
    trace_id: trace, workspace_id: workspace.id, project_id: project.id, run_id: run_id || null,
    event_type: "background_job", name: "workflow.triggered", status: "ok", reference_id: created.id,
    metadata: scrub({ workflow_key: definition.workflow_key, workflow_version: definition.version, source, event }),
  }).catch(() => {});

  if (inline) {
    const advanced = await advanceWorkflowRun(base44, { workflow_run_id: created.id, options });
    return { ...advanced, duplicate: false };
  }
  const queued = await enqueueAdvance(base44, created, { suffix: "start" });
  return { ...publicRun(created), duplicate: false, outcome: "queued", continuation_job_id: queued.job_id };
}

/**
 * Dispatches an EVENT to every finalized workflow whose trigger matches. Used by the verified
 * webhook path, by a scheduled dispatcher function and by a generated app's own server-side code —
 * one dispatch entry point, so no trigger source bypasses authorization or idempotency.
 */
export async function dispatchWorkflowEvent(base44, {
  project, workspace, source, event = null, entity = null, operation = null,
  payload = null, idempotency_key = null, actor = "app", triggered_by = null,
  trace_id = null, run_id = null, inline = false, options = {},
} = {}) {
  const svc = svcOf(base44);
  const candidates = await svc.entities.WorkflowDefinition.filter(
    { project_id: project.id, status: "FINALIZED", trigger_type: String(source), ...(event ? { trigger_event: String(event) } : {}) },
    "-version", 50,
  ).catch(() => []);
  // Only the LATEST finalized version of each lineage is triggered by a new event.
  const latest = new Map();
  for (const d of candidates) {
    if (!triggerMatches(d, { source, event, entity, operation })) continue;
    // DOCUMENTED (Base44): a connector workflow may carry a top-level `condition` — a jq
    // expression over the trigger payload — that skips this dispatch unless it is truthy.
    // Scoped to the connector trigger only; other trigger types are unchanged. A present but
    // malformed/non-string condition fails closed (no dispatch) and never breaks processing;
    // an absent/empty condition leaves existing behavior intact.
    if (source === "connector") {
      const cond = d.trigger?.condition;
      if (cond != null && cond !== "") {
        if (typeof cond !== "string" || !evalJqCondition(cond, payload)) continue;
      }
    }
    const prev = latest.get(d.workflow_key);
    if (!prev || (d.version || 0) > (prev.version || 0)) latest.set(d.workflow_key, d);
  }
  const runs = [];
  for (const definition of latest.values()) {
    runs.push(await startWorkflowRun(base44, {
      project, workspace, definition, payload, source, event,
      reference: idempotency_key || null,
      idempotency_key: idempotency_key ? `${definition.workflow_key}:${idempotency_key}` : null,
      actor, triggered_by, trace_id, run_id, inline, options,
    }));
  }
  return { matched: runs.length, event: event || null, source, runs };
}

// --- cancellation / retry ----------------------------------------------------------------

/**
 * Cooperative cancellation, using the same durable-intent pattern as the platform's AI runs: the
 * flag is persisted, the queued continuation is cancelled through the EXISTING queue, and a run
 * that is not mid-step becomes terminal immediately. Completed steps are never touched.
 */
export async function cancelWorkflowRunRecord(base44, run, { reason = null, user_id = null } = {}) {
  const svc = svcOf(base44);
  if (TERMINAL_RUN_STATUSES.includes(run.status)) return { ...publicRun(run), cancelled: false, detail: `already ${run.status}` };
  const patch = { cancel_requested: true, cancel_reason: scrubText(reason || "cancelled", 200), cancelled_by: user_id || null };
  if (run.job_id) await cancelJob(base44, run.job_id, { reason: "workflow run cancelled" }).catch(() => {});
  if (run.status === "PENDING" || run.status === "WAITING") {
    const started = Date.parse(run.started_at || run.created_date);
    const done = await svc.entities.WorkflowRun.update(run.id, { ...patch, status: "CANCELLED", completed_at: nowIso(), resume_at: null, duration_ms: Number.isFinite(started) ? Date.now() - started : 0 });
    await audit(svc, { workspace_id: run.workspace_id, project_id: run.project_id, user_id, action: "workflow.run_cancelled", resource: "WorkflowRun", resource_id: run.id, metadata: scrub({ reason: patch.cancel_reason, status_before: run.status }) }).catch(() => {});
    return { ...publicRun(done), cancelled: true };
  }
  const flagged = await svc.entities.WorkflowRun.update(run.id, patch);
  await audit(svc, { workspace_id: run.workspace_id, project_id: run.project_id, user_id, action: "workflow.cancel_requested", resource: "WorkflowRun", resource_id: run.id, metadata: scrub({ reason: patch.cancel_reason }) }).catch(() => {});
  return { ...publicRun(flagged), cancelled: false, detail: "in flight; the run stops before its next step" };
}

/**
 * Retries a FAILED run from the step that failed, when policy permits it: only a retryable
 * failure is eligible, so a validation, authorization or policy failure cannot be replayed into
 * the same deterministic outcome. Already-succeeded steps keep their stored results.
 */
export async function retryWorkflowRunRecord(base44, run, { user_id = null, options = {}, inline = false } = {}) {
  const svc = svcOf(base44);
  if (run.status !== "FAILED") fail(409, "RETRY_NOT_PERMITTED", `Only a FAILED run can be retried; this run is ${run.status}`);
  if (!run.error?.retryable) fail(409, "RETRY_NOT_PERMITTED", `The failure (${run.error?.code || "unknown"}) is deterministic and would fail again`, { error: run.error || null });
  const stepId = String(run.failed_step_id || run.current_step || "");
  const [failedStep] = await svc.entities.WorkflowStepRun.filter({ workflow_run_id: run.id, step_id: stepId }, "-created_date", 1).catch(() => []);
  if (failedStep) await svc.entities.WorkflowStepRun.update(failedStep.id, { status: "failed", attempt: 0 });
  const resumed = await svc.entities.WorkflowRun.update(run.id, {
    status: "RUNNING", current_step: stepId, attempt: 0, error: null, completed_at: null,
    timeout_at: run.timeout_at, cancel_requested: false,
  });
  await audit(svc, { workspace_id: run.workspace_id, project_id: run.project_id, user_id, action: "workflow.run_retried", resource: "WorkflowRun", resource_id: run.id, metadata: scrub({ step_id: stepId, previous_error: run.error?.code || null }) }).catch(() => {});
  if (inline) return advanceWorkflowRun(base44, { workflow_run_id: run.id, options });
  const queued = await enqueueAdvance(base44, resumed, { suffix: `retry-run:${Date.now()}` });
  return { ...publicRun(resumed), outcome: "queued", continuation_job_id: queued.job_id };
}

export { WORKFLOW_JOB_TYPE, WORKFLOW_CONTRACT_VERSION };