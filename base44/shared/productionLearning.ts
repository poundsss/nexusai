// Production Learning Flywheel (#43).
//
//   request → NexusAI → architecture → execution → result → Judge → Reward → Trajectory
//     → Dataset → Training (candidate measurement) → Better NexusAI (routing policy)
//
// This module is the LOOP, not a new layer. Every stage is an EXISTING system, invoked through its
// own public path with its own authorization:
//   capture ........ shared/trajectory.ts (the platform's one episode record) + shared/safetyEngine
//                    decisions appended as trajectory events (adapter: captureSafetyDecision)
//   quality ........ shared/evaluation.ts (Judge) + shared/reward.ts (Reward) — called, never reimplemented
//   dataset ........ shared/dataset.ts (the ONE Dataset Builder): create → build → validate → finalize
//   training ....... shared/candidateEvaluation.ts (#39, the ONE training/measurement pipeline)
//   model/router ... shared/routingPolicy.ts propose → activate / rollback (the ONE version system)
//   audit .......... shared/authz.ts audit rows (no second log)
// The only records this module owns: LearningCycle (the lineage of one turn of the loop) and the
// `learning_eligibility` annotation on a trajectory (the deterministic promotion verdict).
//
// Invariants:
//   * a FAILED cycle never activates a policy; the known-good policy and the known-good cycle are
//     untouched by construction (promotion is the LAST step and runs only on a PASS verdict);
//   * an ineligible episode (incomplete, failed, unsafe, corrupted, secret-bearing, test-origin) is
//     refused by the Dataset Builder through its own eligibility path, so no training example can
//     be built from it, not even by a caller that bypasses this module;
//   * everything is project-scoped through the existing project authorization; a cycle reads only
//     its own project's trajectories and evaluations and proposes only its own project's policy.
import { scrub, scrubText } from "./tracing.ts";
import { loadAuthorizedProject, audit } from "./authz.ts";
import { trajectoryForRun, appendEvent } from "./trajectory.ts";
import { evaluateTrajectory } from "./evaluation.ts";
import { calculateReward } from "./reward.ts";
import { classifyDataOrigin } from "./trainingData.ts";
import { createDataset, buildDataset, validateDataset, finalizeDataset, hash, readFinalizedItems } from "./dataset.ts";
import { createCandidateEvaluation, scoreCandidateEvaluation, finalizeCandidateEvaluation, detectRegression, resolveCandidate } from "./candidateEvaluation.ts";
import { proposePolicyFromEvidence, activatePolicy, rollbackPolicy, getActivePolicy } from "./routingPolicy.ts";
import { NEXUS_MODEL_ID } from "./nexusProvider.ts";
import { simulateLearningCycle } from "./productionLearningDryRun.ts";

export const FLYWHEEL_VERSION = "1.0.0";
export const PROMOTION_POLICY_VERSION = "1.0.0";
export const PROMOTION_RULES = {
  version: PROMOTION_POLICY_VERSION,
  // Episode eligibility (deterministic, applied to every sealed production trajectory)
  require_sealed: true,
  require_success: true,
  require_judge: true,
  require_reward: true,
  exclude_unsafe: true,
  exclude_test_origin: true,
  exclude_corrupted: true,
  exclude_secret_content: true,
  // Promotion of a measured candidate
  min_items_scored: 1,
  min_task_success_rate: 0.5,
  require_regression_pass: true,
  regression_tolerance: 0.05,
};
export const INELIGIBILITY_REASONS = ["incomplete_execution", "failed_execution", "unsafe_operation", "no_judge_signal", "no_reward_signal", "corrupted_trace", "secret_content", "test_only_source", "missing_lineage"];
const LIMITS = { trajectories: 400, events: 300, exclusions: 200 };
const DATASET_NAME = "production-learning";

// Credential shapes that must never enter a training example. Checked on the RECORDED episode
// (post-scrub), so a scrubber gap fails closed here rather than shipping.
const CREDENTIAL_RE = /(sk_live_[\w-]{6,}|sk_test_[\w-]{6,}|whsec_[\w-]{6,}|ghp_[\w-]{6,}|github_pat_[\w-]{6,}|xox[abposr]-[\w-]{6,}|AKIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.[\w-]{5,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[\w.\-]{12,})/i;
const BLOCKING_SAFETY_ACTIONS = ["safety.denied", "safety.approval_refused", "safety.execution_refused", "safety.approval_expired"];
// Events appended by ANNOTATION layers after the episode was sealed (this module's own eligibility
// stamp, the safety engine's decisions, the human outcome, an explicit correction). They are
// corrections by construction and are NOT execution history — so their presence can never be read
// as evidence that the recorded execution itself is incomplete or corrupt.
const ANNOTATION_EVENTS = ["learning_eligibility", "safety_decision", "user_outcome", "correction"];

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

// --- 1. CAPTURE: safety decisions join the episode ------------------------------

/**
 * Adapter called by the Safety Engine (#42) for every decision made on a run's behalf. Appends the
 * decision to the run's EXISTING trajectory as an event and, while the episode is still active,
 * flags the outcome summary. A denied / refused operation marks the episode unsafe for learning.
 * Best-effort: learning capture must never fail the operation it observes.
 */
export async function captureSafetyDecision(base44, { run_id, action, tool = null, risk_level = null, decision = null, decision_code = null, approval_id = null }) {
  if (!run_id) return null;
  const svc = svcOf(base44);
  const trajectory = await trajectoryForRun(svc, run_id);
  if (!trajectory) return null;
  const blocked = BLOCKING_SAFETY_ACTIONS.includes(action) || decision === "deny";
  const approved = action === "safety.approval_granted";
  if (!trajectory.sealed) {
    const s = trajectory.outcomes?.safety || { decisions: 0, approvals: 0, blocked: 0 };
    const safety = { decisions: s.decisions + 1, approvals: s.approvals + (approved ? 1 : 0), blocked: s.blocked + (blocked ? 1 : 0) };
    await svc.entities.Trajectory.update(trajectory.id, {
      outcomes: scrub({ ...(trajectory.outcomes || {}), safety, safety_blocked: !!(trajectory.outcomes?.safety_blocked || blocked) }),
    }).catch(() => {});
  }
  return appendEvent(svc, trajectory, {
    event_type: "safety_decision", status: blocked ? "error" : "ok",
    idempotency_key: `safety:${run_id}:${action}:${approval_id || decision_code || "none"}:${trajectory.event_count || 0}`,
    payload: { action, tool, risk_level, decision, decision_code, approval_id, blocked, approved },
  });
}

// --- 4. PROMOTION POLICY: pure, deterministic ----------------------------------

/**
 * The deterministic eligibility verdict for ONE recorded episode. Pure: reads only the records it is
 * given, never the clock, never a model. Every refusal names its reason, and reasons are ordered by
 * severity so two runs over the same records produce byte-identical output.
 */
export function promotionDecision({ trajectory: t, events = [], evaluation = null, reward = null, data_origin = null }) {
  const reasons = [];
  if (!t || !t.run_id || !t.project_id || !t.workspace_id) reasons.push("missing_lineage");
  if (t && PROMOTION_RULES.require_sealed && (!t.sealed || t.status === "ACTIVE")) reasons.push("incomplete_execution");
  if (t && PROMOTION_RULES.require_success && t.sealed && t.status !== "COMPLETED") reasons.push("failed_execution");
  const safetyBlocked = !!t?.outcomes?.safety_blocked || events.some((e) => e.event_type === "safety_decision" && e.payload?.blocked === true);
  if (t && PROMOTION_RULES.exclude_unsafe && safetyBlocked) reasons.push("unsafe_operation");
  // Corruption is judged on EXECUTION history only: the episode's own counter must agree with the
  // events it stores, and a sealed episode that recorded execution must have reached `finalized`.
  const history = events.filter((e) => !ANNOTATION_EVENTS.includes(e.event_type));
  if (t && PROMOTION_RULES.exclude_corrupted && events.length && (t.event_count || 0) !== events.length) reasons.push("corrupted_trace");
  if (t && PROMOTION_RULES.exclude_corrupted && t.sealed && history.length && !history.some((e) => e.event_type === "finalized")) reasons.push("corrupted_trace");
  if (t && PROMOTION_RULES.exclude_secret_content && CREDENTIAL_RE.test(JSON.stringify({ p: t.prompt, c: t.context, pl: t.plan_summary, tc: t.tool_calls, m: t.mutations, o: t.outcomes }))) reasons.push("secret_content");
  if (t && PROMOTION_RULES.exclude_test_origin && data_origin?.test_only) reasons.push("test_only_source");
  if (t && PROMOTION_RULES.require_judge && !evaluation) reasons.push("no_judge_signal");
  if (t && PROMOTION_RULES.require_reward && (!reward || reward.final_reward == null)) reasons.push("no_reward_signal");
  const unique = [...new Set(reasons)];
  return { eligible: unique.length === 0, reasons: unique, policy_version: PROMOTION_POLICY_VERSION };
}

/**
 * The deterministic promotion verdict for ONE measured candidate. A candidate with no evidence, a
 * quality below the floor, or a regression against the reference is refused; nothing is promoted on
 * an INSUFFICIENT_EVIDENCE verdict either, because "unknown" is not "safe".
 */
export function promotionVerdict({ candidate_evaluation, regression = null, has_reference = false }) {
  const m = candidate_evaluation?.metrics || {};
  const cov = candidate_evaluation?.coverage || {};
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  add("measurement_finalized", candidate_evaluation?.status === "FINALIZED", candidate_evaluation?.status || "missing");
  add("evidence_present", (cov.items_scored || 0) >= PROMOTION_RULES.min_items_scored, `${cov.items_scored || 0} item(s) scored`);
  add("quality_floor", m.task_success_rate != null && m.task_success_rate >= PROMOTION_RULES.min_task_success_rate, `task_success_rate ${m.task_success_rate ?? "null"} >= ${PROMOTION_RULES.min_task_success_rate}`);
  if (has_reference && PROMOTION_RULES.require_regression_pass) add("regression_pass", regression?.verdict === "PASS", regression?.verdict || "no verdict");
  const failed = checks.filter((c) => !c.ok);
  // Deterministic precedence: absent evidence is the ROOT cause of every downstream failure, so a
  // candidate with nothing scored is always NO_EVIDENCE — never a regression inferred from nothing.
  const code = !failed.length ? "PROMOTE"
    : failed.some((c) => c.name === "evidence_present") ? "NO_EVIDENCE"
    : failed.some((c) => c.name === "quality_floor") ? "BELOW_QUALITY_FLOOR"
    : failed.some((c) => c.name === "regression_pass") ? "REGRESSION" : "TRAINING_ERROR";
  return { eligible: !failed.length, code, checks, reasons: failed.map((c) => `${c.name}: ${c.detail}`), rules: { ...PROMOTION_RULES } };
}

// --- cycle record ----------------------------------------------------------------

const publicCycle = (c) => ({
  cycle_id: c.id, project_id: c.project_id, workspace_id: c.workspace_id, version: c.version, status: c.status,
  flywheel_version: c.flywheel_version, promotion_policy_version: c.promotion_policy_version,
  candidate: c.candidate || {}, candidate_id: c.candidate_id || null, reference_cycle_id: c.reference_cycle_id || null,
  capture: c.capture || {}, source_trajectory_ids: c.source_trajectory_ids || [],
  training_dataset_id: c.training_dataset_id || null, evaluation_dataset_id: c.evaluation_dataset_id || null,
  evaluation_dataset_checksum: c.evaluation_dataset_checksum || null, dataset_provenance: c.dataset_provenance || {},
  candidate_evaluation_id: c.candidate_evaluation_id || null, reference_evaluation_id: c.reference_evaluation_id || null,
  metrics: c.metrics || {}, regression: c.regression || null, promotion: c.promotion || null,
  previous_policy_version: c.previous_policy_version || null, policy_version: c.policy_version || null,
  promoted_model: c.promoted_model || null, failure_code: c.failure_code || null, error: c.error || null,
  rolled_back_at: c.rolled_back_at || null, rolled_back_to_policy_version: c.rolled_back_to_policy_version || null,
  trace_id: c.trace_id || null, created_by: c.created_by || null, created_at: c.created_at || c.created_date, completed_at: c.completed_at || null,
});

/** The project's known-good cycle: the most recent PROMOTED one. A FAILED or ROLLED_BACK cycle is never it. */
export async function knownGoodCycle(svc, project_id) {
  const rows = await svcOf(svc).entities.LearningCycle.filter({ project_id, status: "PROMOTED" }, "-version", 1).catch(() => []);
  return rows[0] || null;
}

async function recordCycle(svc, { workspace, project, user, cycle, action, extra = {} }) {
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action, resource: "LearningCycle", resource_id: cycle.id,
    metadata: scrub({ cycle_version: cycle.version, status: cycle.status, flywheel_version: FLYWHEEL_VERSION, ...extra }),
  }).catch(() => {});
}

// --- 1-2. capture + quality signal ----------------------------------------------

/**
 * Judges and rewards every sealed episode of the project through the EXISTING Judge and Reward,
 * then records the deterministic eligibility verdict on each episode. Returns the eligible ids and
 * the exclusions with their reasons. Nothing here reads another project's records.
 */
export async function captureProductionOutcomes(svc, { project, cycle_id = null }) {
  const trajectories = await svc.entities.Trajectory.filter({ project_id: project.id }, "created_date", LIMITS.trajectories);
  const eligible = [];
  const excluded = [];
  const originCache = new Map();
  let judged = 0, rewarded = 0;
  for (const t of trajectories) {
    if (t.project_id !== project.id) continue; // defense in depth: never annotate a foreign episode
    let evaluation = null, reward = null;
    if (t.sealed) {
      const ev = await evaluateTrajectory(svc, { trajectory: t }).catch(() => null);
      evaluation = ev?.evaluation || null;
      if (evaluation) judged++;
      const rw = evaluation ? await calculateReward(svc, { trajectory: t }).catch(() => null) : null;
      reward = rw?.reward || null;
      if (reward?.final_reward != null) rewarded++;
    }
    const events = await svc.entities.TrajectoryEvent.filter({ trajectory_id: t.id, project_id: project.id }, "sequence", LIMITS.events).catch(() => []);
    const data_origin = await classifyDataOrigin(svc, t, originCache);
    const decision = promotionDecision({ trajectory: t, events, evaluation, reward, data_origin });
    if (decision.eligible) eligible.push(t.id);
    else excluded.push({ trajectory_id: t.id, reasons: decision.reasons });
    // Annotation + event, like user_outcome: history is extended, never rewritten. Unsealed episodes
    // are not annotated — they are still being written by their run.
    if (t.sealed) {
      const stamp = { ...decision, cycle_id, decided_at: nowIso() };
      const same = t.learning_eligibility && t.learning_eligibility.eligible === decision.eligible && JSON.stringify(t.learning_eligibility.reasons || []) === JSON.stringify(decision.reasons);
      if (!same) {
        await svc.entities.Trajectory.update(t.id, { learning_eligibility: stamp }).catch(() => {});
        await appendEvent(svc, t, {
          event_type: "learning_eligibility", status: decision.eligible ? "ok" : "error",
          idempotency_key: `learning:${t.run_id}:${PROMOTION_POLICY_VERSION}:${hash(decision, "le")}`,
          payload: { ...decision, cycle_id },
        });
      }
    }
  }
  return {
    considered: trajectories.length, judged, rewarded, eligible: eligible.length, excluded: excluded.length,
    eligible_ids: eligible, exclusions: excluded.slice(0, LIMITS.exclusions),
    exclusion_reasons: excluded.reduce((acc, e) => { for (const r of e.reasons) acc[r] = (acc[r] || 0) + 1; return acc; }, {}),
  };
}

/**
 * Authorized capture on its own, without running a full cycle: judge, reward and annotate this
 * project's episodes through the SAME code path a cycle uses.
 */
export async function captureOutcomes(base44, user, { project_id } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to capture production outcomes");
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const capture = await captureProductionOutcomes(svcOf(base44), { project, cycle_id: null });
  return { project_id: project.id, ...capture };
}

// --- 3. dataset through the existing builder ------------------------------------

async function buildFinalizedDataset(base44, user, { project, dataset_type, cycle_version }) {
  const created = await createDataset(base44, user, {
    name: `${DATASET_NAME}-${dataset_type}`, dataset_type, scope: "project", project_id: project.id,
    description: `Production learning cycle ${cycle_version}: ${dataset_type} examples from eligible production episodes`,
  });
  const dataset_id = created.dataset.dataset_id;
  const built = await buildDataset(base44, user, { dataset_id });
  if (!built.item_count) return { dataset: built.dataset, ok: false, code: "NO_ELIGIBLE_EXAMPLES", exclusions: built.exclusions };
  const validated = await validateDataset(base44, user, { dataset_id });
  if (!validated.validation.ok) return { dataset: validated.dataset, ok: false, code: "DATASET_FAILED", failed: (validated.validation.checks || []).filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`) };
  const finalized = await finalizeDataset(base44, user, { dataset_id });
  // An identical source set under identical policies IS the earlier dataset: reuse it.
  const dataset = finalized.finalized ? finalized.dataset : finalized.duplicate_of;
  return { dataset, ok: true, duplicate: !finalized.finalized, exclusions: built.exclusions };
}

// --- 5-7. training, promotion, versioning ---------------------------------------

async function measure(base44, user, { dataset_id, candidate, name }) {
  const created = await createCandidateEvaluation(base44, user, { dataset_id, name, candidate });
  const id = created.candidate_evaluation.candidate_evaluation_id;
  if (created.candidate_evaluation.status !== "FINALIZED") {
    await scoreCandidateEvaluation(base44, user, { candidate_evaluation_id: id });
    await finalizeCandidateEvaluation(base44, user, { candidate_evaluation_id: id });
  }
  return svcOf(base44).entities.CandidateEvaluation.get(id);
}

/**
 * Runs ONE turn of the flywheel for a project. Returns the cycle record whatever happens: a FAILED
 * cycle carries its failure code and has changed nothing about the project's routing.
 */
/** Every run result says whether it was a read-only simulation or a persisted training cycle. */
export async function runLearningCycle(base44, user, args = {}) {
  const out = await runCycle(base44, user, args);
  return args?.dry_run === true ? { ...out, mode: "simulation", persisted: false } : { ...out, mode: "persisted", persisted: true };
}

async function runCycle(base44, user, { project_id, candidate = null, trace_id = null, dry_run = false } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to run a learning cycle");
  // Read-only simulation: nothing is persisted and no routing policy is proposed or activated.
  if (dry_run === true) return simulateLearningCycle(base44, user, { project_id, candidate });
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const svc = svcOf(base44);
  const frozen = resolveCandidate({ model_id: NEXUS_MODEL_ID, ...(candidate || {}) });
  const siblings = await svc.entities.LearningCycle.filter({ project_id: project.id }, "-version", 1).catch(() => []);
  const reference = await knownGoodCycle(svc, project.id);
  let cycle = await svc.entities.LearningCycle.create({
    project_id: project.id, workspace_id: workspace.id, version: (siblings[0]?.version || 0) + 1, status: "DRAFT",
    flywheel_version: FLYWHEEL_VERSION, promotion_policy_version: PROMOTION_POLICY_VERSION,
    candidate: frozen.candidate, candidate_id: frozen.candidate_id, reference_cycle_id: reference?.id || undefined,
    trace_id: trace_id || undefined, created_by: user.id, created_at: nowIso(),
  });
  const ctx = { workspace, project, user };
  const update = async (patch) => { cycle = await svc.entities.LearningCycle.update(cycle.id, patch); return cycle; };
  const failCycle = async (failure_code, error, extra = {}) => {
    await update({ status: "FAILED", failure_code, error: scrubText(error, 400), completed_at: nowIso(), ...extra });
    await recordCycle(svc, { ...ctx, cycle, action: "learning.cycle.failed", extra: { failure_code, error: scrubText(error, 200), known_good_cycle_id: reference?.id || null } });
    return { cycle: publicCycle(cycle), promoted: false };
  };
  await recordCycle(svc, { ...ctx, cycle, action: "learning.cycle.started", extra: { candidate: frozen.candidate, reference_cycle_id: reference?.id || null } });

  try {
    // 1-2. capture + Judge + Reward + eligibility
    const capture = await captureProductionOutcomes(svc, { project, cycle_id: cycle.id });
    await update({ status: "CAPTURED", capture: scrub({ ...capture, eligible_ids: undefined }), source_trajectory_ids: capture.eligible_ids.slice(0, LIMITS.trajectories) });
    await recordCycle(svc, { ...ctx, cycle, action: "learning.capture.completed", extra: { considered: capture.considered, judged: capture.judged, rewarded: capture.rewarded, eligible: capture.eligible, exclusion_reasons: capture.exclusion_reasons } });
    if (!capture.eligible) return await failCycle("NO_ELIGIBLE_EXAMPLES", "no production episode passed the promotion policy");

    // 3. datasets through the existing builder — training (sft) and measurement (evaluation)
    const training = await buildFinalizedDataset(base44, user, { project, dataset_type: "sft", cycle_version: cycle.version });
    const excl = (training.exclusions || []).map((e) => `${e.trajectory_id}:${e.reason}`).join(", ");
    if (!training.ok) return await failCycle(training.code, `training dataset: ${training.failed?.join(", ") || training.code}${excl ? ` | excluded ${excl}` : ""}`);
    const evaluation = await buildFinalizedDataset(base44, user, { project, dataset_type: "evaluation", cycle_version: cycle.version });
    if (!evaluation.ok) return await failCycle(evaluation.code, `evaluation dataset: ${evaluation.failed?.join(", ") || evaluation.code}`);
    // Defense in depth: every admitted item must trace to an episode this cycle judged eligible.
    const items = await readFinalizedItems(svc, { id: evaluation.dataset.dataset_id, item_count: evaluation.dataset.item_count });
    const eligibleSet = new Set(capture.eligible_ids);
    const foreign = items.filter((i) => !eligibleSet.has(i.trajectory_id) || i.project_id !== project.id);
    if (foreign.length) return await failCycle("PROMOTION_POLICY_VIOLATION", `${foreign.length} dataset item(s) trace to an episode the promotion policy did not admit`);
    const provenance = (d) => ({ dataset_id: d.dataset_id, name: d.name, version: d.version, checksum: d.checksum, item_count: d.item_count, eligibility_policy_version: d.eligibility_policy_version, transformation_version: d.transformation_version, source_fingerprint: d.source_fingerprint });
    await update({
      status: "DATASET_READY", training_dataset_id: training.dataset.dataset_id, evaluation_dataset_id: evaluation.dataset.dataset_id,
      evaluation_dataset_checksum: evaluation.dataset.checksum,
      dataset_provenance: { training: provenance(training.dataset), evaluation: provenance(evaluation.dataset), reused_existing: { training: !!training.duplicate, evaluation: !!evaluation.duplicate } },
    });
    await recordCycle(svc, { ...ctx, cycle, action: "learning.dataset.finalized", extra: { training_dataset_id: training.dataset.dataset_id, evaluation_dataset_id: evaluation.dataset.dataset_id, evaluation_checksum: evaluation.dataset.checksum, items: items.length } });

    // 5. training = the existing candidate measurement, plus the reference on the SAME dataset
    const candidateRow = await measure(base44, user, { dataset_id: evaluation.dataset.dataset_id, candidate: frozen.candidate, name: `cycle ${cycle.version} candidate` });
    let referenceRow = null, regression = null;
    const refCandidate = reference?.candidate || null;
    if (refCandidate && reference.candidate_id !== frozen.candidate_id) {
      referenceRow = await measure(base44, user, { dataset_id: evaluation.dataset.dataset_id, candidate: refCandidate, name: `cycle ${cycle.version} reference` });
      regression = (await detectRegression(base44, user, { candidate_evaluation_id: candidateRow.id, reference_evaluation_id: referenceRow.id, tolerance: PROMOTION_RULES.regression_tolerance })).regression;
    } else if (refCandidate) {
      regression = { verdict: "PASS", comparable_metrics: 0, note: "candidate configuration is identical to the known-good reference; no separate reference measurement" };
    }
    const verdict = promotionVerdict({ candidate_evaluation: candidateRow, regression, has_reference: !!refCandidate });
    await update({ status: "MEASURED", candidate_evaluation_id: candidateRow.id, reference_evaluation_id: referenceRow?.id || undefined, metrics: scrub(candidateRow.metrics || {}), regression: regression ? scrub(regression) : undefined, promotion: scrub(verdict) });
    await recordCycle(svc, { ...ctx, cycle, action: "learning.training.measured", extra: { candidate_evaluation_id: candidateRow.id, reference_evaluation_id: referenceRow?.id || null, verdict: verdict.code, regression: regression?.verdict || null } });
    if (!verdict.eligible) return await failCycle(verdict.code, verdict.reasons.join("; "));

    // 6-7. promotion: a NEW immutable routing policy version from persisted evidence, activated;
    // the previous ACTIVE version is recorded as the rollback target.
    const previous = await getActivePolicy(svc, { scope: "project", project_id: project.id });
    const proposed = await proposePolicyFromEvidence(base44, user, { scope: "project", project_id: project.id, notes: `production learning cycle ${cycle.version}` });
    const activated = await activatePolicy(base44, user, { policy_version: proposed.policy.policy_version });
    const prior = (activated.policy.model_priors || {})[frozen.candidate.model_id] || null;
    await update({
      status: "PROMOTED", previous_policy_version: previous?.policy_version || undefined, policy_version: activated.policy.policy_version,
      promoted_model: { model_id: frozen.candidate.model_id, model_version: frozen.candidate.model_version, candidate_evaluation_id: candidateRow.id, in_active_policy: !!prior && prior.quality?.value != null, quality: prior?.quality?.value ?? null },
      completed_at: nowIso(),
    });
    await recordCycle(svc, { ...ctx, cycle, action: "learning.cycle.promoted", extra: {
      policy_version: activated.policy.policy_version, previous_policy_version: previous?.policy_version || null,
      model_id: frozen.candidate.model_id, model_version: frozen.candidate.model_version, candidate_evaluation_id: candidateRow.id,
      training_dataset_id: training.dataset.dataset_id, evaluation_dataset_id: evaluation.dataset.dataset_id, source_trajectories: capture.eligible,
    } });
    return { cycle: publicCycle(cycle), promoted: true };
  } catch (e) {
    return await failCycle("TRAINING_ERROR", `${e.code || "ERROR"}: ${e.message}`);
  }
}

// --- 8. rollback through the existing routing rollback -------------------------

export async function rollbackLearningCycle(base44, user, { cycle_id } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to roll back a learning cycle");
  const svc = svcOf(base44);
  const cycle = cycle_id ? await svc.entities.LearningCycle.get(String(cycle_id)).catch(() => null) : null;
  if (!cycle) fail(404, "CYCLE_NOT_FOUND", "Learning cycle not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, cycle.project_id, "project.write");
  if (cycle.status !== "PROMOTED") fail(409, "CYCLE_NOT_PROMOTED", `Only a PROMOTED cycle can be rolled back (status ${cycle.status})`);
  const active = await getActivePolicy(svc, { scope: "project", project_id: project.id });
  if (!active || active.policy_version !== cycle.policy_version) fail(409, "CYCLE_NOT_ACTIVE", "This cycle's policy is no longer the active one; roll back the current cycle instead");
  let restoredPolicy = null;
  let restored_to = "previous_project_policy";
  if (cycle.previous_policy_version) {
    // The routing layer's OWN rollback re-activates the immutable previous version.
    const restored = await rollbackPolicy(base44, user, { scope: "project", project_id: project.id, to_policy_version: cycle.previous_policy_version });
    restoredPolicy = restored.policy;
  } else {
    // FIRST promoted cycle: the project had no project-scoped policy before it, so its known-good
    // baseline is the platform/default policy the project routed on beforehand. Rolling back means
    // retiring this cycle's version through the routing layer's own lifecycle stamps — the version
    // itself is never rewritten, so it stays inspectable and re-activatable.
    restored_to = "platform_or_default";
    await svc.entities.RoutingPolicy.update(active.id, { status: "ROLLED_BACK", superseded_at: nowIso() });
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: "routing.policy.rolled_back", resource: "RoutingPolicy", resource_id: active.id,
      metadata: { policy_version: active.policy_version, version: active.version, previous: null, rollback_of: active.policy_version, restored: "platform_or_default" },
    }).catch(() => {});
  }
  const updated = await svc.entities.LearningCycle.update(cycle.id, {
    status: "ROLLED_BACK", rolled_back_at: nowIso(),
    rolled_back_to_policy_version: restoredPolicy?.policy_version || undefined,
  });
  await recordCycle(svc, { workspace, project, user, cycle: updated, action: "learning.cycle.rolled_back", extra: { from_policy_version: cycle.policy_version, to_policy_version: restoredPolicy?.policy_version || null, restored_to, known_good_cycle_id: (await knownGoodCycle(svc, project.id))?.id || null } });
  return { cycle: publicCycle(updated), policy: restoredPolicy, restored_to };
}

// --- reads -----------------------------------------------------------------------

export async function getLearningCycle(base44, user, { cycle_id } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to read learning cycles");
  const svc = svcOf(base44);
  const cycle = cycle_id ? await svc.entities.LearningCycle.get(String(cycle_id)).catch(() => null) : null;
  if (!cycle) fail(404, "CYCLE_NOT_FOUND", "Learning cycle not found");
  await loadAuthorizedProject(base44, user, cycle.project_id, "project.read");
  return { cycle: publicCycle(cycle) };
}

export async function listLearningCycles(base44, user, { project_id, limit = 20 } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to read learning cycles");
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.LearningCycle.filter({ project_id: project.id }, "-version", Math.min(Number(limit) || 20, 100));
  const known_good = await knownGoodCycle(svc, project.id);
  const active = await getActivePolicy(svc, { scope: "project", project_id: project.id });
  return { project_id: project.id, count: rows.length, cycles: rows.map(publicCycle), known_good_cycle_id: known_good?.id || null, active_policy_version: active?.policy_version || null };
}

/** Full lineage of one cycle: policy → measurement → datasets → source episodes → their evaluations/rewards. */
export async function getLearningLineage(base44, user, { cycle_id } = {}) {
  const { cycle } = await getLearningCycle(base44, user, { cycle_id });
  const svc = svcOf(base44);
  const ids = (cycle.source_trajectory_ids || []).slice(0, 50);
  const sources = [];
  for (const id of ids) {
    const t = await svc.entities.Trajectory.get(id).catch(() => null);
    if (!t || t.project_id !== cycle.project_id) continue;
    const [ev] = await svc.entities.Evaluation.filter({ trajectory_id: id }, "-revision", 1).catch(() => []);
    const [rw] = await svc.entities.Reward.filter({ trajectory_id: id, status: "active" }, "-revision", 1).catch(() => []);
    sources.push({ trajectory_id: id, run_id: t.run_id, trace_id: t.trace_id || null, status: t.status, model_id: t.model_id || null, evaluation_id: ev?.id || null, reward_id: rw?.id || null, final_reward: rw?.final_reward ?? null, learning_eligibility: t.learning_eligibility || null });
  }
  return { cycle, lineage: { policy_version: cycle.policy_version, previous_policy_version: cycle.previous_policy_version, candidate_evaluation_id: cycle.candidate_evaluation_id, reference_evaluation_id: cycle.reference_evaluation_id, training_dataset_id: cycle.training_dataset_id, evaluation_dataset_id: cycle.evaluation_dataset_id, dataset_provenance: cycle.dataset_provenance, sources } };
}

export const productionLearningContract = () => ({
  flywheel_version: FLYWHEEL_VERSION, promotion_policy_version: PROMOTION_POLICY_VERSION,
  promotion_rules: PROMOTION_RULES, ineligibility_reasons: INELIGIBILITY_REASONS,
  loop: ["capture", "judge", "reward", "eligibility", "dataset", "measure", "regression", "promote", "audit"],
  systems: { trajectory: "shared/trajectory.ts", judge: "shared/evaluation.ts", reward: "shared/reward.ts", dataset: "shared/dataset.ts", training: "shared/candidateEvaluation.ts", router: "shared/routingPolicy.ts" },
});