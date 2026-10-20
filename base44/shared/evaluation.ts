// NexusAI evaluation / judge engine.
//
// Judges the OUTCOME of a sealed building episode, never the model's own account of it. Every
// signal is read from a record the platform already wrote — the run's terminal status, the Build
// row, runtime verification, the immutable ProjectVersion, the episode's own events — and each
// score names the record it came from. A dimension with no such record is reported as
// UNAVAILABLE rather than scored, so an evaluation can never invent a finding.
//
// Boundaries this module keeps:
//   READ-ONLY — Trajectory, TrajectoryEvent, Build, ProjectVersion and AIRun are read and never
//     written. An evaluation is a separate record that points at them.
//   SEPARATE DIMENSIONS — task completion, build, runtime, regression, repair efficiency and
//     change efficiency are scored independently. No single reward is produced here.
//   VERSIONED — scoring lives in a registry keyed by evaluator version, so a historical
//     evaluation stays reproducible and a revised evaluator adds a revision instead of rewriting.
//   IDEMPOTENT — one evaluation per (trajectory, evaluator version); identical authoritative
//     inputs yield an identical record.
//   ISOLATED — reads go through the platform's existing project authorization and are then
//     filtered by project id.
//   SCRUBBED — every string that lands in an evaluation goes through the platform's existing
//     secret scrubber.
import { scrub, scrubText } from "./tracing.ts";
import { loadAuthorizedProject } from "./authz.ts";

export const EVALUATOR_VERSION = "1.0.0";
export const DIMENSIONS = ["task_completion", "build", "runtime", "regression", "repair_efficiency", "change_efficiency"];
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];
const LIMITS = { evidence: 40, findings: 20, history: 50 };

const svcOf = (base44) => base44.asServiceRole || base44;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

/** Stable fingerprint of the authoritative inputs a score was derived from. */
export function inputsHash(parts) {
  const text = JSON.stringify(parts ?? {});
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `ev_${(h >>> 0).toString(36)}_${text.length.toString(36)}`;
}

// --- authoritative input collection (read-only) --------------------------------

/**
 * Gathers exactly the records the judge is allowed to reason about. Nothing here is written, and
 * a record that does not exist stays null so the scorer can report an unavailable signal.
 */
async function collectInputs(base44, trajectory) {
  const svc = svcOf(base44);
  const outcomes = trajectory.outcomes || {};
  const mutations = trajectory.mutations || {};

  const events = await svc.entities.TrajectoryEvent.filter({ trajectory_id: trajectory.id, project_id: trajectory.project_id }, "sequence", 300).catch(() => []);
  const buildEvents = events.filter((e) => e.event_type === "build_result");
  const runtimeEvents = events.filter((e) => e.event_type === "runtime_result");
  const repairEvents = events.filter((e) => e.event_type === "repair_attempt");

  // The Build row is authoritative for build outcome whenever the run produced one.
  const build_id = outcomes.build_id || null;
  const build = build_id ? await svc.entities.Build.get(build_id).catch(() => null) : null;
  const run = trajectory.run_id ? await svc.entities.AIRun.get(trajectory.run_id).catch(() => null) : null;
  const version = mutations.version_id ? await svc.entities.ProjectVersion.get(mutations.version_id).catch(() => null) : null;
  const deployment = mutations.deployment_id ? await svc.entities.Deployment.get(mutations.deployment_id).catch(() => null) : null;

  // Baseline for the regression signal: the most recent EARLIER sealed episode of the same project
  // that is verifiably known-good (successful build and passing runtime). Absent that, there is no
  // evidence of a prior good state and no regression may be claimed.
  const earlier = await svc.entities.Trajectory.filter({ project_id: trajectory.project_id, sealed: true }, "-created_date", 25).catch(() => []);
  const baseline = earlier.find((t) =>
    t.id !== trajectory.id &&
    String(t.created_date || "") < String(trajectory.created_date || "") &&
    t.status === "COMPLETED" &&
    (t.outcomes || {}).build_status === "success" &&
    (t.outcomes || {}).runtime_ok === true) || null;

  return { outcomes, mutations, events, buildEvents, runtimeEvents, repairEvents, build, build_id, run, version, deployment, baseline };
}

// --- evaluator v1 -------------------------------------------------------------

const dim = (score, status, evidence, detail = null) => ({ score, status, evidence, detail });

/**
 * Evaluator 1.0.0.
 *
 * Each dimension is derived from one authoritative source and carries its evidence. `score` is
 * null — not zero — whenever the signal cannot be established, which is what keeps "unknown"
 * distinguishable from "bad".
 */
function evaluateV1(trajectory, inputs) {
  const { outcomes, mutations, build, build_id, run, version, deployment, baseline, buildEvents, runtimeEvents, repairEvents } = inputs;
  const evidence = [];
  const findings = [];
  const add = (dimension, source, reference_id, detail) => {
    evidence.push({ dimension, source, reference_id: reference_id ? String(reference_id) : null, detail: scrubText(detail, 200) });
  };

  // A. TASK COMPLETION — from the episode's sealed terminal status and the run's own status,
  // never from the model's message.
  const finalStatus = outcomes.final_run_status || trajectory.status;
  const runStatus = run?.status || null;
  const completed = finalStatus === "COMPLETED" && (runStatus == null || runStatus === "COMPLETED");
  const cancelled = finalStatus === "CANCELLED";
  const task_completion = trajectory.sealed
    ? dim(completed ? 1 : 0, completed ? "passed" : cancelled ? "cancelled" : "failed", true)
    : dim(null, "unavailable", false);
  add("task_completion", "trajectory", trajectory.id, `sealed episode status ${finalStatus}`);
  if (runStatus) add("task_completion", "ai_run", run.id, `run status ${runStatus}`);
  if (version) add("task_completion", "project_version", version.id, `version ${version.number} produced`);
  if (deployment) add("task_completion", "deployment", deployment.id, `deployment ${deployment.status}`);
  if (cancelled) findings.push("Episode was cancelled before completion; no successful terminal state was reached.");

  // B. BUILD — the Build row when it exists, otherwise the recorded build outcome of the episode.
  let build_status = null;
  if (build) {
    build_status = build.status;
    add("build", "build_result", build.id, `build ${build.status}, ${build.error_count ?? 0} error(s)`);
  } else if (outcomes.build_status) {
    build_status = outcomes.build_status;
    const ev = buildEvents[buildEvents.length - 1];
    add("build", "build_result", build_id || ev?.id || null, `recorded build ${build_status}, ${outcomes.build_errors ?? 0} error(s)`);
  }
  const buildDim = build_status
    ? dim(build_status === "success" ? 1 : 0, build_status === "success" ? "passed" : "failed", true)
    : dim(null, "unavailable", false);
  if (!build_status) add("build", "trajectory", trajectory.id, "no build record for this episode");
  if (build_status && build_status !== "success") findings.push(`Build did not succeed (${build_status}).`);

  // C. RUNTIME — authoritative runtime verification; passed / failed / unavailable are distinct.
  const runtimeKnown = outcomes.runtime_ok != null;
  const lastRuntime = runtimeEvents[runtimeEvents.length - 1];
  const runtimeDim = runtimeKnown
    ? dim(outcomes.runtime_ok ? 1 : 0, outcomes.runtime_ok ? "passed" : "failed", true)
    : dim(null, "unavailable", false);
  if (runtimeKnown) {
    add("runtime", "runtime_result", lastRuntime?.id || null, `runtime ${outcomes.runtime_ok ? "verified" : "failed"}${outcomes.runtime_category ? ` (${outcomes.runtime_category})` : ""}, ${outcomes.runtime_checks ?? 0} check(s)`);
    if (!outcomes.runtime_ok) findings.push(`Runtime verification failed${outcomes.runtime_category ? `: ${outcomes.runtime_category}` : ""}.`);
  } else {
    add("runtime", "trajectory", trajectory.id, "runtime verification did not run for this episode");
  }

  // D. REGRESSION — only claimable against a verified prior known-good episode. Without one the
  // signal is insufficient_evidence, never a regression.
  let regression;
  if (!baseline) {
    regression = dim(null, "insufficient_evidence", false);
    add("regression", "trajectory", trajectory.id, "no earlier verified known-good episode to compare against");
  } else if (!build_status && !runtimeKnown) {
    regression = dim(null, "insufficient_evidence", false);
    add("regression", "trajectory", baseline.id, "baseline exists but this episode has no build/runtime evidence");
  } else {
    const regressed = (build_status && build_status !== "success") || (runtimeKnown && outcomes.runtime_ok === false);
    regression = dim(regressed ? 0 : 1, regressed ? "regressed" : "no_regression", true);
    add("regression", "trajectory", baseline.id, `baseline episode ${baseline.id} was build=success runtime=ok`);
    if (regressed) findings.push("Verified build/runtime failure after a previously verified good state.");
  }

  // E. REPAIR EFFICIENCY — count and eventual resolution. Recorded, not converted into a reward.
  const repair_attempts = outcomes.repair_attempts ?? (repairEvents.length || 0);
  const repairsResolved = repairEvents.length ? repairEvents[repairEvents.length - 1].status === "ok" : build_status === "success";
  const repairKnown = build_status != null || repairEvents.length > 0;
  const repairDim = repairKnown
    ? dim(repair_attempts === 0 ? 1 : repairsResolved ? Math.max(0, 1 - 0.25 * repair_attempts) : 0,
      repair_attempts === 0 ? "no_repairs_needed" : repairsResolved ? "repaired" : "unresolved", true)
    : dim(null, "unavailable", false);
  add("repair_efficiency", repairEvents.length ? "trajectory_event" : "trajectory", repairEvents[repairEvents.length - 1]?.id || trajectory.id, `${repair_attempts} repair attempt(s), ${repairsResolved ? "resolved" : "unresolved"}`);

  // F. CHANGE EFFICIENCY — measurable scope only. No stylistic judgement.
  const files_changed = mutations.files_changed_count ?? (mutations.changed_files || []).length;
  const entities_changed = (mutations.entities_changed || []).length;
  const tool_calls = (trajectory.tool_calls || []).length;
  const failed_tool_calls = (trajectory.tool_calls || []).filter((c) => c.ok === false).length;
  const scopeKnown = !!mutations.version_id || files_changed > 0 || tool_calls > 0;
  // Objective ratio only: how much of the tool activity landed as a change, bounded to 0..1.
  const changeScore = scopeKnown
    ? (tool_calls === 0 ? (files_changed > 0 ? 1 : null) : Math.max(0, Math.min(1, 1 - failed_tool_calls / tool_calls)))
    : null;
  const changeDim = changeScore == null ? dim(null, "unavailable", scopeKnown) : dim(changeScore, "measured", true);
  add("change_efficiency", mutations.version_id ? "project_version" : "trajectory", mutations.version_id || trajectory.id, `${files_changed} file(s), ${entities_changed} entity change(s), ${tool_calls} tool call(s), ${failed_tool_calls} failed`);

  const dimensions = {
    task_completion: task_completion, build: buildDim, runtime: runtimeDim,
    regression, repair_efficiency: repairDim, change_efficiency: changeDim,
  };
  // Evidence is mandatory: a dimension whose evidence is missing is downgraded to unavailable
  // rather than reported as a score without provenance.
  for (const name of DIMENSIONS) {
    if (!evidence.some((e) => e.dimension === name)) dimensions[name] = dim(null, "unavailable", false);
  }

  const metrics = {
    files_changed, entities_changed, tool_calls, failed_tool_calls,
    repair_attempts, retries: trajectory.retries || 0,
    phases: (trajectory.phases || []).length, fallbacks: (trajectory.fallbacks || []).length,
    runtime_checks: outcomes.runtime_checks ?? null, build_errors: outcomes.build_errors ?? null,
    duration_ms: trajectory.duration_ms ?? null,
  };

  return {
    dimensions,
    scores: Object.fromEntries(DIMENSIONS.map((d) => [`${d}_score`, dimensions[d].score])),
    evidence: evidence.slice(0, LIMITS.evidence),
    findings: findings.slice(0, LIMITS.findings),
    metrics,
    build_id: build?.id || build_id || null,
  };
}

/**
 * Evaluator 1.1.0 — 1.0.0's scoring, plus one additional objective finding: an episode that
 * completed without producing an immutable version changed nothing. The earlier version is left
 * exactly as it was, which is the whole point of the registry.
 */
function evaluateV1_1(trajectory, inputs) {
  const out = evaluateV1(trajectory, inputs);
  if (trajectory.status === "COMPLETED" && !(trajectory.mutations || {}).version_id) {
    out.findings = [...out.findings, "Episode completed without producing a project version; no canonical change landed."].slice(0, LIMITS.findings);
  }
  return out;
}

// Versioned registry. An earlier version keeps its own function forever, so a historical
// evaluation can be recomputed exactly as it was produced.
const EVALUATORS = { "1.0.0": evaluateV1, "1.1.0": evaluateV1_1 };

export const evaluatorVersions = () => Object.keys(EVALUATORS);

// --- evaluation write path ----------------------------------------------------

const publicEvaluation = (e) => ({
  id: e.id, evaluator_version: e.evaluator_version, revision: e.revision || 1,
  trajectory_id: e.trajectory_id, run_id: e.run_id, trace_id: e.trace_id,
  workspace_id: e.workspace_id, project_id: e.project_id,
  version_id: e.version_id || null, version_number: e.version_number ?? null, build_id: e.build_id || null,
  trajectory_status: e.trajectory_status || null, trajectory_revision: e.trajectory_revision ?? null,
  inputs_hash: e.inputs_hash, dimensions: e.dimensions || {}, scores: e.scores || {},
  evidence: e.evidence || [], findings: e.findings || [], metrics: e.metrics || {},
  supersedes_evaluation_id: e.supersedes_evaluation_id || null,
  evaluated_at: e.evaluated_at || e.created_date, created_date: e.created_date,
});

/**
 * Evaluates ONE sealed episode.
 *
 * Idempotent on (trajectory, evaluator_version): an existing evaluation is returned as-is when the
 * authoritative inputs still hash the same, so repeated evaluation cannot duplicate a record or
 * silently change a verdict. Inputs that genuinely changed, or a different evaluator version,
 * produce a NEW revision that references the one it follows — history is never rewritten.
 */
export async function evaluateTrajectory(base44, { trajectory, evaluator_version = EVALUATOR_VERSION }) {
  const svc = svcOf(base44);
  const { result, inputs_hash } = await computeEvaluation(base44, { trajectory, evaluator_version });

  const existingAll = await svc.entities.Evaluation.filter({ trajectory_id: trajectory.id }, "revision", LIMITS.history).catch(() => []);
  const sameVersion = existingAll.filter((e) => e.evaluator_version === evaluator_version);
  const identical = sameVersion.find((e) => e.inputs_hash === inputs_hash);
  if (identical) return { evaluation: publicEvaluation(identical), created: false, reason: "identical_inputs" };

  const previous = existingAll[existingAll.length - 1] || null;
  const record = await svc.entities.Evaluation.create(evaluationRecordFields(trajectory, { result, inputs_hash, evaluator_version, previous }));
  return { evaluation: publicEvaluation(record), created: true };
}

/** The persisted shape of one evaluation, as evaluateTrajectory stores it. Pure. */
export function evaluationRecordFields(trajectory, { result, inputs_hash, evaluator_version, previous = null }) {
  return {
    evaluator_version, trajectory_id: trajectory.id, run_id: trajectory.run_id,
    trace_id: trajectory.trace_id || null, workspace_id: trajectory.workspace_id, project_id: trajectory.project_id,
    version_id: (trajectory.mutations || {}).version_id || null,
    version_number: (trajectory.mutations || {}).version_number ?? null,
    build_id: result.build_id, revision: (previous?.revision || 0) + 1,
    supersedes_evaluation_id: previous?.id || null,
    trajectory_status: trajectory.status, trajectory_revision: trajectory.revision || 1,
    inputs_hash, dimensions: scrub(result.dimensions), scores: result.scores,
    evidence: scrub(result.evidence), findings: result.findings.map((f) => scrubText(f, 300)),
    metrics: scrub(result.metrics), evaluated_at: nowIso(),
  };
}

export { publicEvaluation };

/** Judges one sealed episode WITHOUT persisting: reads its inputs and returns the verdict + its inputs hash. */
export async function computeEvaluation(base44, { trajectory, evaluator_version = EVALUATOR_VERSION }) {
  const evaluate = EVALUATORS[evaluator_version];
  if (!evaluate) fail(400, "UNKNOWN_EVALUATOR", `Unknown evaluator version: ${evaluator_version}`);
  if (!trajectory.sealed || !TERMINAL.includes(trajectory.status)) {
    fail(409, "TRAJECTORY_NOT_SEALED", "Only a sealed episode can be evaluated");
  }

  const inputs = await collectInputs(base44, trajectory);
  const result = evaluate(trajectory, inputs);
  const inputs_hash = inputsHash({
    evaluator_version, trajectory_id: trajectory.id, status: trajectory.status,
    trajectory_revision: trajectory.revision || 1, outcomes: trajectory.outcomes || {},
    mutations: trajectory.mutations || {}, retries: trajectory.retries || 0,
    tool_calls: (trajectory.tool_calls || []).map((c) => [c.tool, c.ok]),
    build: inputs.build ? [inputs.build.status, inputs.build.error_count] : null,
    run_status: inputs.run?.status || null, baseline: inputs.baseline?.id || null,
  });
  return { result, inputs_hash };
}

// --- authorized API paths -----------------------------------------------------

async function authorizedTrajectory(base44, user, { project_id, trajectory_id = null, run_id = null }, capability) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, capability);
  const svc = svcOf(base44);
  const rows = trajectory_id
    ? await svc.entities.Trajectory.filter({ id: String(trajectory_id), project_id: project.id }, "created_date", 1)
    : await svc.entities.Trajectory.filter({ run_id: String(run_id || ""), project_id: project.id }, "created_date", 1);
  if (!rows.length) fail(404, "TRAJECTORY_NOT_FOUND", "Trajectory not found for this project");
  return { project, workspace, trajectory: rows[0] };
}

/** Evaluating is a project WRITE, so a viewer cannot attach verdicts to another member's episode. */
export async function runEvaluation(base44, user, { project_id, trajectory_id = null, run_id = null, evaluator_version = EVALUATOR_VERSION } = {}) {
  const { trajectory } = await authorizedTrajectory(base44, user, { project_id, trajectory_id, run_id }, "project.write");
  return evaluateTrajectory(base44, { trajectory, evaluator_version });
}

/** Latest evaluation for an episode, optionally pinned to one evaluator version. */
export async function getEvaluation(base44, user, { project_id, trajectory_id = null, run_id = null, evaluator_version = null } = {}) {
  const { project, trajectory } = await authorizedTrajectory(base44, user, { project_id, trajectory_id, run_id }, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.Evaluation.filter({ trajectory_id: trajectory.id, project_id: project.id, ...(evaluator_version ? { evaluator_version } : {}) }, "revision", LIMITS.history);
  if (!rows.length) fail(404, "EVALUATION_NOT_FOUND", "No evaluation exists for this trajectory");
  return { trajectory_id: trajectory.id, evaluation: publicEvaluation(rows[rows.length - 1]), revisions: rows.length };
}

/** Full evaluation history of an episode, oldest revision first. */
export async function listEvaluationHistory(base44, user, { project_id, trajectory_id = null, run_id = null } = {}) {
  const { project, trajectory } = await authorizedTrajectory(base44, user, { project_id, trajectory_id, run_id }, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.Evaluation.filter({ trajectory_id: trajectory.id, project_id: project.id }, "revision", LIMITS.history);
  return { trajectory_id: trajectory.id, count: rows.length, evaluations: rows.map(publicEvaluation) };
}

export async function listProjectEvaluations(base44, user, { project_id, limit = 20 } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.Evaluation.filter({ project_id: project.id }, "-created_date", Math.min(limit, 100));
  return { project_id: project.id, count: rows.length, evaluations: rows.map(publicEvaluation) };
}