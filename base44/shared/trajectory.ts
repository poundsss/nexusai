// NexusAI trajectory / learning data layer.
//
// ONE canonical, versioned representation of an AI building episode — the shape a future training
// pipeline can consume. It is deliberately a PROJECTION, not a second logging system:
//   • the platform's existing records (AIRun and its steps/tool_log, Build, ProjectVersion,
//     Deployment, FunctionInvocation, RuntimeError, TraceEvent, AuditLog) stay authoritative;
//   • a trajectory stores references, hashes, counts and concise structured metadata that point AT
//     those records, so project contents are never duplicated when an immutable version reference
//     already exists;
//   • correlation reuses the run's own trace_id verbatim — no new trace ids are minted here.
//
// Guarantees:
//   IDEMPOTENCY — at most one trajectory per run (resolved by run_id) and at most one event per
//     logical step (resolved by idempotency_key), so a retried phase or a recovered worker cannot
//     duplicate an episode or its history.
//   IMMUTABILITY — a terminal episode is sealed. Later information is appended as a correction
//     event and bumps `revision`; nothing already recorded is rewritten.
//   ISOLATION — reads go through the platform's existing project authorization and are then
//     filtered by project_id, so one workspace/project can never read another's trajectories.
//   CLASSIFICATION — every string and structure is passed through the platform's existing
//     secret scrubber, so no credential value can enter a trajectory record.
// Emission is best-effort by construction: learning data must never fail the run it observes.
import { scrub, scrubText } from "./tracing.ts";
import { loadAuthorizedProject } from "./authz.ts";
import { log } from "./observability.ts";

export const TRAJECTORY_SCHEMA_VERSION = 1;
export const TRAJECTORY_TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];
export const USER_OUTCOMES = ["accepted", "rejected", "abandoned", "edited_after_generation", "deployed", "reverted"];

const LIMITS = { prompt: 4000, tool_calls: 200, phases: 60, events_page: 200 };

const svcOf = (base44) => base44.asServiceRole || base44;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

/** Stable, cheap fingerprint of the context an episode executed against. */
export function contextHash(parts) {
  const text = JSON.stringify(parts ?? {});
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `ctx_${(h >>> 0).toString(36)}_${text.length.toString(36)}`;
}

export async function trajectoryForRun(base44, run_id) {
  if (!run_id) return null;
  const rows = await svcOf(base44).entities.Trajectory.filter({ run_id: String(run_id) }, "created_date", 2).catch(() => []);
  return rows[0] || null;
}

/**
 * Opens the episode for a run. Idempotent: an existing trajectory for the run is returned as-is,
 * so a re-driven plan phase re-attaches to the SAME episode rather than starting a second one.
 */
export async function startTrajectory(base44, { run, project, workspace, trace_id = null, actor_user_id = null, tools = [], context = {} }) {
  const svc = svcOf(base44);
  const existing = await trajectoryForRun(svc, run.id);
  if (existing) return { trajectory: existing, created: false };

  const ctx = scrub({ ...context, tool_availability: (tools || []).map((t) => (typeof t === "string" ? t : t.name)).filter(Boolean).slice(0, 100) });
  const hash = contextHash(ctx);
  const trajectory = await svc.entities.Trajectory.create({
    schema_version: TRAJECTORY_SCHEMA_VERSION,
    run_id: run.id, project_id: project.id, workspace_id: workspace?.id || project.workspace_id,
    trace_id: trace_id || run.trace_id || null, actor_user_id: actor_user_id || run.created_by_id || null,
    status: "ACTIVE", sealed: false, revision: 1,
    prompt: scrubText(run.prompt || "", LIMITS.prompt), mode: run.mode || "default",
    requested_at: run.started_at || run.created_date || nowIso(),
    context: ctx, context_hash: hash,
    phases: [], tool_calls: [], retries: 0, fallbacks: [],
    mutations: {}, outcomes: {}, event_count: 0,
  });
  await appendEvent(svc, trajectory, {
    event_type: "task_started", idempotency_key: `task:${run.id}`,
    payload: { mode: run.mode, base_version_number: run.base_version_number ?? null, context_hash: hash, tool_availability: ctx.tool_availability?.length || 0 },
  });
  return { trajectory: await svc.entities.Trajectory.get(trajectory.id), created: true };
}

/**
 * Appends one event. `idempotency_key` makes the append safe under worker retries: an event
 * already recorded for the same logical step is returned instead of written again. An event that
 * arrives after the episode was sealed is recorded as a CORRECTION and bumps the revision — it
 * never edits earlier history.
 */
export async function appendEvent(base44, trajectory, { event_type, status = "ok", phase = null, attempt = 1, payload = {}, idempotency_key = null, at = null }) {
  const svc = svcOf(base44);
  if (!trajectory?.id || !event_type) return null;
  if (idempotency_key) {
    const dup = await svc.entities.TrajectoryEvent.filter({ trajectory_id: trajectory.id, idempotency_key }, "created_date", 1).catch(() => []);
    if (dup.length) return dup[0];
  }
  const fresh = await svc.entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  const isCorrection = !!fresh.sealed;
  const event = await svc.entities.TrajectoryEvent.create({
    trajectory_id: fresh.id, run_id: fresh.run_id, project_id: fresh.project_id, workspace_id: fresh.workspace_id,
    trace_id: fresh.trace_id || null, sequence: (fresh.event_count || 0) + 1,
    event_type, status, phase, attempt: attempt || 1,
    payload: scrub(payload || {}), idempotency_key, is_correction: isCorrection, at: at || nowIso(),
  });
  await svc.entities.Trajectory.update(fresh.id, {
    event_count: (fresh.event_count || 0) + 1, last_event_at: event.at,
    ...(isCorrection ? { revision: (fresh.revision || 1) + 1 } : {}),
  }).catch(() => {});
  return event;
}

/**
 * Merges scrubbed summary fields into an ACTIVE episode. A sealed episode is never patched: the
 * event that carried the information is the record, which is what keeps training provenance
 * append-only.
 */
async function mergeSummary(base44, trajectory, patch) {
  const svc = svcOf(base44);
  const fresh = await svc.entities.Trajectory.get(trajectory.id).catch(() => null);
  if (!fresh || fresh.sealed) return fresh;
  return svc.entities.Trajectory.update(fresh.id, patch);
}

// --- emission helpers used by the run pipeline --------------------------------

export async function recordContext(base44, trajectory, context) {
  const ctx = scrub(context || {});
  const hash = contextHash(ctx);
  await mergeSummary(base44, trajectory, { context: { ...(trajectory.context || {}), ...ctx }, context_hash: hash });
  return appendEvent(base44, trajectory, { event_type: "context_loaded", phase: "plan", idempotency_key: `context:${trajectory.run_id}`, payload: { ...ctx, context_hash: hash } });
}

export async function recordModelSelection(base44, trajectory, { model_id, provider, reason = null, routing_decision = null }) {
  await mergeSummary(base44, trajectory, { model_id: model_id || null, model_provider: provider || null, routing_decision: scrub(routing_decision || {}) });
  return appendEvent(base44, trajectory, {
    event_type: "model_selected", phase: "plan", idempotency_key: `model:${trajectory.run_id}:${model_id || "none"}`,
    payload: { model_id, provider, reason, strategy: routing_decision?.strategy || null, budget_credits: routing_decision?.budget_credits ?? null, candidates: (routing_decision?.candidates || []).length },
  });
}

/** Concise structured plan metadata only — never hidden chain-of-thought. */
export async function recordPlan(base44, trajectory, plan) {
  const summary = {
    steps: (plan?.plan || []).length,
    file_actions: (plan?.files || []).map((f) => ({ path: f.path, action: f.action })).slice(0, 100),
    entities: (plan?.entities || []).map((e) => e.name),
    integrations: (plan?.integrations || []).map((i) => i.name),
    secrets_declared: (plan?.secrets || []).map((s) => s.name),
    assumptions: (plan?.assumptions || []).length,
  };
  await mergeSummary(base44, trajectory, { plan_summary: scrub(summary) });
  return appendEvent(base44, trajectory, { event_type: "plan_recorded", phase: "plan", idempotency_key: `plan:${trajectory.run_id}`, payload: summary });
}

export async function recordPhase(base44, trajectory, { phase, status = "ok", attempt = 1, duration_ms = null, error_code = null, next_phase = null }) {
  const entry = { phase, status, attempt, duration_ms, at: nowIso() };
  const fresh = await svcOf(base44).entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  if (!fresh.sealed) {
    await mergeSummary(base44, fresh, { phases: [...(fresh.phases || []), entry].slice(-LIMITS.phases) });
  }
  return appendEvent(base44, fresh, {
    event_type: "phase_completed", phase, status, attempt,
    idempotency_key: `phase:${trajectory.run_id}:${phase}:${attempt}:${status}`,
    payload: { duration_ms, error_code, next_phase },
  });
}

export async function recordPhaseStart(base44, trajectory, { phase, attempt = 1 }) {
  return appendEvent(base44, trajectory, { event_type: "phase_started", phase, attempt, idempotency_key: `phase_start:${trajectory.run_id}:${phase}:${attempt}`, payload: {} });
}

/** Tool result METADATA (name, outcome, redacted summary). The run's tool_log stays authoritative. */
export async function recordToolCalls(base44, trajectory, { phase, calls = [] }) {
  if (!calls.length) return null;
  const fresh = await svcOf(base44).entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  const mapped = calls.map((c) => ({ tool: c.tool, ok: c.ok !== false, summary: scrubText(c.summary || "", 200), phase }));
  if (!fresh.sealed) await mergeSummary(base44, fresh, { tool_calls: [...(fresh.tool_calls || []), ...mapped].slice(-LIMITS.tool_calls) });
  return appendEvent(base44, fresh, {
    event_type: "tool_call", phase, idempotency_key: `tools:${trajectory.run_id}:${phase}:${(fresh.tool_calls || []).length}:${calls.length}`,
    payload: { count: mapped.length, failed: mapped.filter((c) => !c.ok).length, calls: mapped.slice(0, 50) },
  });
}

export async function recordRetry(base44, trajectory, { phase, attempt, error_code = null }) {
  const fresh = await svcOf(base44).entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  if (!fresh.sealed) await mergeSummary(base44, fresh, { retries: (fresh.retries || 0) + 1 });
  return appendEvent(base44, fresh, { event_type: "retry", phase, attempt, status: "error", idempotency_key: `retry:${trajectory.run_id}:${phase}:${attempt}`, payload: { error_code } });
}

export async function recordFallbacks(base44, trajectory, fallbacks = []) {
  if (!fallbacks.length) return null;
  const fresh = await svcOf(base44).entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  if (!fresh.sealed) await mergeSummary(base44, fresh, { fallbacks: [...(fresh.fallbacks || []), ...fallbacks].slice(-20) });
  return appendEvent(base44, fresh, { event_type: "fallback", idempotency_key: `fallback:${trajectory.run_id}:${(fresh.fallbacks || []).length}`, payload: { fallbacks } });
}

export async function recordBuildResult(base44, trajectory, { build_id = null, status, errors = 0, file_count = null, duration_ms = null, design = null, attempt = 1 }) {
  const fresh = await svcOf(base44).entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  const outcomes = { ...(fresh.outcomes || {}), build_id, build_status: status, build_errors: errors };
  if (!fresh.sealed) await mergeSummary(base44, fresh, { outcomes: scrub(outcomes) });
  return appendEvent(base44, fresh, {
    event_type: "build_result", phase: "build", status: status === "success" ? "ok" : "error", attempt,
    idempotency_key: `build:${trajectory.run_id}:${attempt}:${status}`,
    payload: { build_id, status, errors, file_count, duration_ms, design },
  });
}

export async function recordRuntimeResult(base44, trajectory, { ok, category = null, checks = [], diagnostics = 0, attempt = 1 }) {
  const fresh = await svcOf(base44).entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  const outcomes = { ...(fresh.outcomes || {}), runtime_ok: !!ok, runtime_category: category, runtime_checks: (checks || []).length };
  if (!fresh.sealed) await mergeSummary(base44, fresh, { outcomes: scrub(outcomes) });
  return appendEvent(base44, fresh, {
    event_type: "runtime_result", phase: "build", status: ok ? "ok" : "error", attempt,
    idempotency_key: `runtime:${trajectory.run_id}:${attempt}:${ok ? "ok" : "error"}`,
    payload: { ok: !!ok, category, checks: (checks || []).slice(0, 40), diagnostics },
  });
}

export async function recordRepairAttempt(base44, trajectory, { attempt, resolved, error_codes = [] }) {
  const fresh = await svcOf(base44).entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  if (!fresh.sealed) await mergeSummary(base44, fresh, { outcomes: scrub({ ...(fresh.outcomes || {}), repair_attempts: attempt }) });
  return appendEvent(base44, fresh, {
    event_type: "repair_attempt", phase: "build", status: resolved ? "ok" : "error", attempt,
    idempotency_key: `repair:${trajectory.run_id}:${attempt}`, payload: { resolved: !!resolved, error_codes: (error_codes || []).slice(0, 10) },
  });
}

/** REFERENCES and summaries only: the immutable version is what a consumer resolves for contents. */
export async function recordMutations(base44, trajectory, { changed_files = [], entities_changed = [], version_id = null, version_number = null, deployment_id = null }) {
  const fresh = await svcOf(base44).entities.Trajectory.get(trajectory.id).catch(() => trajectory);
  const mutations = scrub({
    ...(fresh.mutations || {}),
    changed_files: changed_files.map((c) => ({ path: c.path, change: c.change })).slice(0, 300),
    files_changed_count: changed_files.length,
    entities_changed: entities_changed.slice(0, 100),
    version_id, version_number, deployment_id,
  });
  if (!fresh.sealed) await mergeSummary(base44, fresh, { mutations });
  return appendEvent(base44, fresh, {
    event_type: "mutation_recorded", phase: "commit", idempotency_key: `mutations:${trajectory.run_id}:${version_id || "none"}`,
    payload: { files: changed_files.length, entities: entities_changed.length, version_id, version_number, deployment_id },
  });
}

/**
 * Seals the episode. Idempotent: an already-sealed trajectory is returned unchanged, so a
 * duplicated terminal path cannot rewrite the record or double-append its finalization.
 */
export async function finalizeTrajectory(base44, { run_id, trajectory = null, status, error = null, duration_ms = null, version_id = null, version_number = null, build_id = null, credits_charged = null, repair_attempts = null }) {
  const svc = svcOf(base44);
  const record = trajectory || (await trajectoryForRun(svc, run_id));
  if (!record) return null;
  if (record.sealed) return record;
  const final = TRAJECTORY_TERMINAL.includes(status) ? status : "FAILED";
  const outcomes = scrub({
    ...(record.outcomes || {}),
    final_run_status: status, cancelled: final === "CANCELLED",
    error: error ? scrubText(error, 400) : null,
    ...(build_id ? { build_id } : {}), ...(repair_attempts != null ? { repair_attempts } : {}),
    ...(credits_charged != null ? { credits_charged } : {}),
  });
  const mutations = version_id ? scrub({ ...(record.mutations || {}), version_id, version_number }) : record.mutations || {};
  await svc.entities.Trajectory.update(record.id, {
    status: final, sealed: true, finalized_at: nowIso(), duration_ms: duration_ms ?? record.duration_ms ?? null,
    outcomes, mutations,
  });
  await appendEvent(svc, { ...record, sealed: false }, {
    event_type: "finalized", status: final === "COMPLETED" ? "ok" : final === "CANCELLED" ? "cancelled" : "error",
    idempotency_key: `final:${record.run_id}`,
    payload: { final_run_status: status, version_id, version_number, build_id, duration_ms, error: error ? scrubText(error, 300) : null },
  });
  return svc.entities.Trajectory.get(record.id);
}

/**
 * Records what the human did with the result. Permitted after sealing precisely because the
 * outcome is only knowable later — it is appended as a correction and bumps the revision.
 */
export async function setUserOutcome(base44, { trajectory, outcome, actor_user_id = null, detail = null }) {
  if (!USER_OUTCOMES.includes(outcome)) fail(400, "INVALID_OUTCOME", `outcome must be one of: ${USER_OUTCOMES.join(", ")}`);
  const svc = svcOf(base44);
  const at = nowIso();
  await svc.entities.Trajectory.update(trajectory.id, { user_outcome: outcome, user_outcome_at: at });
  await appendEvent(svc, trajectory, {
    event_type: "user_outcome", idempotency_key: `outcome:${trajectory.run_id}:${outcome}:${at}`,
    payload: { outcome, actor_user_id, detail: detail ? scrubText(detail, 300) : null }, at,
  });
  return svc.entities.Trajectory.get(trajectory.id);
}

/** Records a correction WITHOUT rewriting history: a new event plus a bumped revision. */
export async function recordCorrection(base44, { trajectory, reason, metadata = {} }) {
  return appendEvent(base44, trajectory, { event_type: "correction", payload: { reason: scrubText(reason || "", 300), ...scrub(metadata) } });
}

// --- authorized read paths ----------------------------------------------------

// The only fields a read path returns. An allowlist rather than a deny-list, so a future field
// cannot leak by default.
const publicTrajectory = (t) => ({
  id: t.id, schema_version: t.schema_version, run_id: t.run_id, project_id: t.project_id, workspace_id: t.workspace_id,
  trace_id: t.trace_id, actor_user_id: t.actor_user_id, status: t.status, sealed: !!t.sealed, revision: t.revision || 1,
  prompt: t.prompt, mode: t.mode, requested_at: t.requested_at, context: t.context || {}, context_hash: t.context_hash,
  model_id: t.model_id, model_provider: t.model_provider, routing_decision: t.routing_decision || {},
  plan_summary: t.plan_summary || {}, phases: t.phases || [], tool_calls: t.tool_calls || [],
  retries: t.retries || 0, fallbacks: t.fallbacks || [], mutations: t.mutations || {}, outcomes: t.outcomes || {},
  user_outcome: t.user_outcome || null, user_outcome_at: t.user_outcome_at || null,
  event_count: t.event_count || 0, last_event_at: t.last_event_at || null, finalized_at: t.finalized_at || null,
  duration_ms: t.duration_ms ?? null, created_date: t.created_date,
});

const publicEvent = (e) => ({
  id: e.id, sequence: e.sequence, event_type: e.event_type, status: e.status, phase: e.phase || null,
  attempt: e.attempt || 1, payload: e.payload || {}, is_correction: !!e.is_correction,
  idempotency_key: e.idempotency_key || null, trace_id: e.trace_id || null, run_id: e.run_id, at: e.at || e.created_date,
});

/**
 * Resolves ONE trajectory for an authorized caller. The project is authorized through the
 * platform's existing path and the lookup is then filtered by that project id, so a trajectory id
 * belonging to another project resolves to nothing rather than another account's episode.
 */
export async function getTrajectory(base44, user, { project_id, trajectory_id = null, run_id = null, include_events = true, limit = LIMITS.events_page } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = trajectory_id
    ? await svc.entities.Trajectory.filter({ id: String(trajectory_id), project_id: project.id }, "created_date", 1)
    : await svc.entities.Trajectory.filter({ run_id: String(run_id || ""), project_id: project.id }, "created_date", 1);
  const record = rows[0];
  if (!record) fail(404, "TRAJECTORY_NOT_FOUND", "Trajectory not found for this project");
  const events = include_events
    ? (await svc.entities.TrajectoryEvent.filter({ trajectory_id: record.id, project_id: project.id }, "sequence", Math.min(limit, LIMITS.events_page))).map(publicEvent)
    : [];
  return { trajectory: publicTrajectory(record), events, event_total: record.event_count || 0 };
}

export async function listTrajectories(base44, user, { project_id, limit = 20, status = null } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.Trajectory.filter({ project_id: project.id, ...(status ? { status } : {}) }, "-created_date", Math.min(limit, 100));
  return { project_id: project.id, count: rows.length, trajectories: rows.map(publicTrajectory) };
}

export async function listTrajectoryEvents(base44, user, { project_id, trajectory_id, limit = LIMITS.events_page, offset = 0 } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const owned = await svc.entities.Trajectory.filter({ id: String(trajectory_id || ""), project_id: project.id }, "created_date", 1);
  if (!owned.length) fail(404, "TRAJECTORY_NOT_FOUND", "Trajectory not found for this project");
  const rows = await svc.entities.TrajectoryEvent.filter({ trajectory_id: owned[0].id, project_id: project.id }, "sequence", Math.min(limit, LIMITS.events_page), offset);
  return { trajectory_id: owned[0].id, count: rows.length, offset, total: owned[0].event_count || 0, events: rows.map(publicEvent) };
}

/** Writing a user outcome is a project WRITE, so a viewer cannot label another member's episode. */
export async function recordUserOutcome(base44, user, { project_id, trajectory_id = null, run_id = null, outcome, detail = null } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const svc = svcOf(base44);
  const rows = trajectory_id
    ? await svc.entities.Trajectory.filter({ id: String(trajectory_id), project_id: project.id }, "created_date", 1)
    : await svc.entities.Trajectory.filter({ run_id: String(run_id || ""), project_id: project.id }, "created_date", 1);
  if (!rows.length) fail(404, "TRAJECTORY_NOT_FOUND", "Trajectory not found for this project");
  const updated = await setUserOutcome(svc, { trajectory: rows[0], outcome, actor_user_id: user.id, detail });
  return { trajectory: publicTrajectory(updated) };
}

/**
 * The pipeline's emission wrapper: a trajectory write must never fail or slow the run it observes,
 * so every emission goes through here and a failure is logged and dropped.
 */
export async function emit(fn, label) {
  try { return await fn(); } catch (e) { log("warn", "trajectory.emit_failed", { label, error: e.message }); return null; }
}