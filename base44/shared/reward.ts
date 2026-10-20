// NexusAI reward / outcome engine.
//
// Converts TWO authoritative inputs — the Judge's evaluation of a sealed episode, and the
// authoritative user/product outcome recorded on that episode — into one normalized training
// reward. It deliberately does NOT decide whether the code worked: that verdict belongs to the
// Judge and to the execution records the Judge cites. This layer only weighs signals that already
// exist.
//
// Boundaries this module keeps:
//   READ-ONLY — Trajectory, TrajectoryEvent, Evaluation, ProjectVersion, Build/runtime and
//     Deployment records are read and never written. A reward is a separate record pointing at them.
//   COMPONENTS BEFORE VALUE — every dimension and the outcome are scored separately, each with its
//     own weight, signed contribution, polarity and provenance; the final value is derived last.
//   DETERMINISTIC — the formula is a fixed constant of the policy version. It is never tuned at
//     runtime and never produced by an LLM.
//   VERSIONED — policies live in a registry keyed by version, so a historical reward stays
//     reproducible and a new formula is a new policy version, not a rewrite.
//   IDEMPOTENT — at most one ACTIVE reward per (trajectory, policy version); identical inputs
//     resolve the existing record instead of inserting another.
//   UNKNOWN ≠ REJECTED — a missing user outcome removes the outcome term from the formula. It is
//     never scored as rejection, and acceptance is never fabricated.
//   ISOLATED + SCRUBBED — reads go through the platform's existing project authorization and are
//     filtered by project id; every stored string passes through the existing secret scrubber.
import { scrub, scrubText } from "./tracing.ts";
import { loadAuthorizedProject } from "./authz.ts";
import { DIMENSIONS } from "./evaluation.ts";

export const REWARD_POLICY_VERSION = "1.0.0";
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED"];
const LIMITS = { history: 50, explanations: 24 };

// Outcomes the platform already records on a trajectory. `known` outcomes are unambiguous product
// facts; `partial` ones tell us the human engaged but not that they were satisfied.
const OUTCOME_SCORES = {
  accepted: { score: 1, certainty: "known", explanation: "User accepted the generated result." },
  deployed: { score: 1, certainty: "known", explanation: "Result was deployed, the strongest authoritative acceptance signal." },
  edited_after_generation: { score: 0.5, certainty: "partial", explanation: "User kept the result but edited it afterwards, so acceptance is partial." },
  abandoned: { score: 0.25, certainty: "partial", explanation: "User abandoned the result without an explicit verdict; treated as weak, not as rejection." },
  rejected: { score: 0, certainty: "known", explanation: "User explicitly rejected the generated result." },
  reverted: { score: 0, certainty: "known", explanation: "Result was reverted after landing." },
};

const svcOf = (base44) => base44.asServiceRole || base44;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const round = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);

export function rewardInputsHash(parts) {
  const text = JSON.stringify(parts ?? {});
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `rw_${(h >>> 0).toString(36)}_${text.length.toString(36)}`;
}

// --- policies -----------------------------------------------------------------

/**
 * Policy 1.0.0.
 *
 *   objective_reward = Σ(wᵢ · sᵢ) / Σ(wᵢ)   over MEASURED evaluation dimensions only
 *   outcome_reward   = OUTCOME_SCORES[user_outcome]        (null when no outcome exists)
 *   final_reward     = objective_reward                                    when outcome unknown
 *                    = 0.70 · objective_reward + 0.30 · outcome_reward     when outcome known
 *                    = 0.85 · objective_reward + 0.15 · outcome_reward     when outcome partial
 *
 * Weights are renormalized over the dimensions the Judge could actually measure, so an unavailable
 * signal is EXCLUDED rather than counted as zero. All values are in 0..1.
 */
const POLICY_1_0_0 = {
  version: "1.0.0",
  weights: { task_completion: 0.30, build: 0.20, runtime: 0.20, regression: 0.15, repair_efficiency: 0.08, change_efficiency: 0.07 },
  outcome_weight: { known: 0.30, partial: 0.15, unknown: 0 },
  formula: "objective = Σ(wᵢ·sᵢ)/Σ(wᵢ) over measured evaluation dimensions; final = (1−ω)·objective + ω·outcome, ω = 0.30 known / 0.15 partial / 0 unknown; all values normalized to 0..1",
};

/**
 * Policy 1.1.0 — same structure, revised weighting: runtime evidence and regression are weighted
 * higher, and a known outcome carries more of the final value. 1.0.0 is left untouched, which is
 * the point of the registry.
 */
const POLICY_1_1_0 = {
  version: "1.1.0",
  weights: { task_completion: 0.25, build: 0.15, runtime: 0.25, regression: 0.20, repair_efficiency: 0.08, change_efficiency: 0.07 },
  outcome_weight: { known: 0.40, partial: 0.20, unknown: 0 },
  formula: "objective = Σ(wᵢ·sᵢ)/Σ(wᵢ) over measured evaluation dimensions (runtime/regression weighted higher); final = (1−ω)·objective + ω·outcome, ω = 0.40 known / 0.20 partial / 0 unknown",
};

const POLICIES = { "1.0.0": POLICY_1_0_0, "1.1.0": POLICY_1_1_0 };
export const rewardPolicyVersions = () => Object.keys(POLICIES);

// --- computation --------------------------------------------------------------

/**
 * Applies one policy to one evaluation + outcome pair. Pure and deterministic: identical inputs
 * always produce an identical result, and nothing here reads the clock, randomness or a model.
 */
export function computeReward({ policy, evaluation, trajectory }) {
  const dims = evaluation.dimensions || {};
  const scores = evaluation.scores || {};
  const components = [];
  const unavailable = [];
  const explanations = [];

  // 1. Objective components — one per evaluation dimension, each carrying its own provenance back
  // to the dimension and the record the Judge cited for it.
  let weighted = 0, weightSum = 0;
  for (const name of DIMENSIONS) {
    const d = dims[name] || {};
    const score = d.score ?? scores[`${name}_score`] ?? null;
    const weight = policy.weights[name] ?? 0;
    if (score == null) {
      unavailable.push(name);
      components.push({
        name, kind: "evaluation_dimension", score: null, weight, contribution: 0, polarity: "neutral",
        status: d.status || "unavailable",
        explanation: `${name} was not measurable from the available evidence, so it is excluded from the reward rather than scored as zero.`,
        provenance: { evaluation_id: evaluation.id, evaluation_dimension: name, evaluator_version: evaluation.evaluator_version, measured: false },
      });
      continue;
    }
    weighted += weight * score;
    weightSum += weight;
    const evidence = (evaluation.evidence || []).filter((e) => e.dimension === name);
    components.push({
      name, kind: "evaluation_dimension", score: round(score), weight, contribution: round(weight * score),
      polarity: score >= 0.5 ? "positive" : "negative", status: d.status || "measured",
      explanation: `${name} scored ${round(score)} (${d.status || "measured"}) from authoritative execution evidence.`,
      provenance: {
        evaluation_id: evaluation.id, evaluation_dimension: name, evaluator_version: evaluation.evaluator_version,
        run_id: evaluation.run_id || null, trajectory_id: evaluation.trajectory_id,
        version_id: evaluation.version_id || null, build_id: evaluation.build_id || null,
        sources: evidence.map((e) => ({ source: e.source, reference_id: e.reference_id })),
        measured: true,
      },
    });
  }

  // No measurable dimension at all: the evidence is insufficient, so no reward value is produced.
  if (weightSum === 0) {
    return {
      status: "insufficient_evidence", final_reward: null, objective_reward: null, outcome_reward: null,
      outcome_status: trajectory.user_outcome ? (OUTCOME_SCORES[trajectory.user_outcome]?.certainty || "unknown") : "unknown",
      user_outcome: trajectory.user_outcome || null, components, unavailable_components: unavailable,
      positive_components: [], negative_components: [], formula: policy.formula,
      explanations: ["No evaluation dimension was measurable, so no reward value was produced. The reward is reported as insufficient evidence rather than as a low score."],
    };
  }
  const objective = weighted / weightSum;
  explanations.push(`Objective reward ${round(objective)} from ${DIMENSIONS.length - unavailable.length} measured dimension(s)${unavailable.length ? `; ${unavailable.join(", ")} unavailable and excluded` : ""}.`);

  // 2. Outcome component — the authoritative human/product outcome, when one exists. Absence is
  // recorded as unknown and removes the term; it never becomes a negative signal.
  const outcomeKey = trajectory.user_outcome || null;
  const mapped = outcomeKey ? OUTCOME_SCORES[outcomeKey] : null;
  const outcome_status = mapped ? mapped.certainty : "unknown";
  const omega = policy.outcome_weight[outcome_status] ?? 0;
  const outcome_reward = mapped ? mapped.score : null;
  if (mapped) {
    components.push({
      name: `user_outcome:${outcomeKey}`, kind: "user_outcome", score: round(mapped.score), weight: omega,
      contribution: round(omega * mapped.score), polarity: mapped.score >= 0.5 ? "positive" : "negative",
      status: mapped.certainty, explanation: mapped.explanation,
      provenance: {
        trajectory_id: trajectory.id, run_id: trajectory.run_id, user_outcome: outcomeKey,
        user_outcome_at: trajectory.user_outcome_at || null,
        version_id: (trajectory.mutations || {}).version_id || null,
        source: "trajectory.user_outcome", measured: true,
      },
    });
    explanations.push(`Outcome "${outcomeKey}" is ${mapped.certainty}, weighted ${omega} in the final value.`);
  } else {
    components.push({
      name: "user_outcome", kind: "user_outcome", score: null, weight: 0, contribution: 0, polarity: "neutral",
      status: "unknown",
      explanation: "No user outcome has been recorded yet. The outcome term is omitted; a missing outcome is not treated as rejection and acceptance is not assumed.",
      provenance: { trajectory_id: trajectory.id, run_id: trajectory.run_id, source: "trajectory.user_outcome", measured: false },
    });
    unavailable.push("user_outcome");
    explanations.push("No user outcome available; the reward was computed from objective evidence alone (outcome status unknown).");
  }

  const final = mapped ? (1 - omega) * objective + omega * mapped.score : objective;
  explanations.push(`Final reward ${round(final)} = (1−${omega})·${round(objective)}${mapped ? ` + ${omega}·${round(mapped.score)}` : ""}, normalized to 0..1.`);

  return {
    status: "active",
    final_reward: round(Math.max(0, Math.min(1, final))),
    objective_reward: round(objective), outcome_reward: round(outcome_reward),
    outcome_status, user_outcome: outcomeKey, components,
    unavailable_components: unavailable,
    positive_components: components.filter((c) => c.polarity === "positive").map((c) => c.name),
    negative_components: components.filter((c) => c.polarity === "negative").map((c) => c.name),
    formula: policy.formula,
    explanations: explanations.slice(0, LIMITS.explanations),
  };
}

// --- persistence --------------------------------------------------------------

const publicReward = (r) => ({
  id: r.id, reward_policy_version: r.reward_policy_version, revision: r.revision || 1, status: r.status || "active",
  trajectory_id: r.trajectory_id, evaluation_id: r.evaluation_id, run_id: r.run_id, trace_id: r.trace_id,
  workspace_id: r.workspace_id, project_id: r.project_id,
  version_id: r.version_id || null, version_number: r.version_number ?? null,
  evaluator_version: r.evaluator_version || null, evaluation_inputs_hash: r.evaluation_inputs_hash || null,
  inputs_hash: r.inputs_hash,
  final_reward: r.final_reward ?? null, objective_reward: r.objective_reward ?? null, outcome_reward: r.outcome_reward ?? null,
  outcome_status: r.outcome_status || "unknown", user_outcome: r.user_outcome || null,
  components: r.components || [], positive_components: r.positive_components || [], negative_components: r.negative_components || [],
  unavailable_components: r.unavailable_components || [],
  formula: r.formula || null, explanations: r.explanations || [],
  supersedes_reward_id: r.supersedes_reward_id || null,
  calculated_at: r.calculated_at || r.created_date, created_date: r.created_date,
});

/** Latest evaluation for an episode under a given (or any) evaluator version. */
async function latestEvaluation(base44, trajectory, evaluator_version = null) {
  const svc = svcOf(base44);
  const rows = await svc.entities.Evaluation.filter(
    { trajectory_id: trajectory.id, project_id: trajectory.project_id, ...(evaluator_version ? { evaluator_version } : {}) },
    "revision", LIMITS.history,
  ).catch(() => []);
  return rows[rows.length - 1] || null;
}

/**
 * Calculates the reward for ONE sealed episode with a completed evaluation.
 *
 * Idempotent on (trajectory, policy version): when the authoritative inputs still hash the same,
 * the existing ACTIVE record is returned untouched — so a retried worker or a repeated call cannot
 * create a second active reward. A genuine input change, or a different policy version, creates a
 * NEW revision that supersedes the previous record for that policy; earlier rewards are preserved.
 */
export async function calculateReward(base44, { trajectory, reward_policy_version = REWARD_POLICY_VERSION, evaluator_version = null } = {}) {
  const svc = svcOf(base44);
  const policy = POLICIES[reward_policy_version];
  if (!policy) fail(400, "UNKNOWN_REWARD_POLICY", `Unknown reward policy version: ${reward_policy_version}`);
  if (!trajectory.sealed || !TERMINAL.includes(trajectory.status)) {
    fail(409, "TRAJECTORY_NOT_SEALED", "Only a sealed episode can be rewarded");
  }
  const evaluation = await latestEvaluation(base44, trajectory, evaluator_version);
  if (!evaluation) fail(409, "EVALUATION_REQUIRED", "This episode has no evaluation yet; the Judge must evaluate it before a reward can be calculated");

  const { result, inputs_hash } = rewardFor({ trajectory, evaluation, reward_policy_version });

  const existingAll = await svc.entities.Reward.filter({ trajectory_id: trajectory.id }, "revision", LIMITS.history).catch(() => []);
  const samePolicy = existingAll.filter((r) => r.reward_policy_version === reward_policy_version);
  const identical = samePolicy.find((r) => r.inputs_hash === inputs_hash && r.status !== "superseded");
  if (identical) return { reward: publicReward(identical), created: false, reason: "identical_inputs" };

  const previous = existingAll[existingAll.length - 1] || null;
  const record = await svc.entities.Reward.create(rewardRecordFields(trajectory, evaluation, { result, inputs_hash, reward_policy_version, previous }));

  // At most ONE active reward per policy version: the record this one replaces for the SAME policy
  // is marked superseded, and it keeps its values so history stays reproducible.
  for (const stale of samePolicy) {
    if (stale.id !== record.id && stale.status === "active") {
      await svc.entities.Reward.update(stale.id, { status: "superseded" }).catch(() => {});
    }
  }
  return { reward: publicReward(record), created: true };
}

export { publicReward };

/** Pure: the reward verdict and its inputs hash for one episode + evaluation. No reads, no writes. */
export function rewardFor({ trajectory, evaluation, reward_policy_version = REWARD_POLICY_VERSION }) {
  const policy = POLICIES[reward_policy_version];
  if (!policy) fail(400, "UNKNOWN_REWARD_POLICY", `Unknown reward policy version: ${reward_policy_version}`);
  const result = computeReward({ policy, evaluation, trajectory });
  const inputs_hash = rewardInputsHash({
    reward_policy_version, trajectory_id: trajectory.id, evaluation_id: evaluation.id,
    evaluator_version: evaluation.evaluator_version, evaluation_inputs_hash: evaluation.inputs_hash,
    scores: evaluation.scores || {}, dimension_status: Object.fromEntries(DIMENSIONS.map((d) => [d, (evaluation.dimensions || {})[d]?.status || null])),
    user_outcome: trajectory.user_outcome || null, trajectory_status: trajectory.status,
    trajectory_revision: trajectory.revision || 1,
  });
  return { result, inputs_hash };
}

/** The persisted shape of one reward, as calculateReward stores it. Pure. */
export function rewardRecordFields(trajectory, evaluation, { result, inputs_hash, reward_policy_version, previous = null }) {
  return {
    reward_policy_version, trajectory_id: trajectory.id, evaluation_id: evaluation.id,
    run_id: trajectory.run_id, trace_id: trajectory.trace_id || null,
    workspace_id: trajectory.workspace_id, project_id: trajectory.project_id,
    version_id: (trajectory.mutations || {}).version_id || evaluation.version_id || null,
    version_number: (trajectory.mutations || {}).version_number ?? evaluation.version_number ?? null,
    revision: (previous?.revision || 0) + 1, supersedes_reward_id: previous?.id || null,
    evaluator_version: evaluation.evaluator_version, evaluation_inputs_hash: evaluation.inputs_hash,
    inputs_hash, status: result.status,
    final_reward: result.final_reward, objective_reward: result.objective_reward, outcome_reward: result.outcome_reward,
    outcome_status: result.outcome_status, user_outcome: result.user_outcome || undefined,
    components: scrub(result.components), positive_components: result.positive_components,
    negative_components: result.negative_components, unavailable_components: result.unavailable_components,
    formula: result.formula, explanations: result.explanations.map((e) => scrubText(e, 300)),
    calculated_at: nowIso(),
  };
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

/** Calculating is a project WRITE, so a viewer cannot attach reward records to an episode. */
export async function runRewardCalculation(base44, user, { project_id, trajectory_id = null, run_id = null, reward_policy_version = REWARD_POLICY_VERSION, evaluator_version = null } = {}) {
  const { trajectory } = await authorizedTrajectory(base44, user, { project_id, trajectory_id, run_id }, "project.write");
  return calculateReward(base44, { trajectory, reward_policy_version, evaluator_version });
}

/** The active reward for an episode, optionally pinned to one policy version. */
export async function getReward(base44, user, { project_id, trajectory_id = null, run_id = null, reward_policy_version = null } = {}) {
  const { project, trajectory } = await authorizedTrajectory(base44, user, { project_id, trajectory_id, run_id }, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.Reward.filter({ trajectory_id: trajectory.id, project_id: project.id, ...(reward_policy_version ? { reward_policy_version } : {}) }, "revision", LIMITS.history);
  if (!rows.length) fail(404, "REWARD_NOT_FOUND", "No reward exists for this trajectory");
  const active = rows.filter((r) => r.status !== "superseded");
  return { trajectory_id: trajectory.id, reward: publicReward((active[active.length - 1] || rows[rows.length - 1])), revisions: rows.length };
}

/** Full reward history of an episode across policy versions, oldest revision first. */
export async function listRewardHistory(base44, user, { project_id, trajectory_id = null, run_id = null } = {}) {
  const { project, trajectory } = await authorizedTrajectory(base44, user, { project_id, trajectory_id, run_id }, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.Reward.filter({ trajectory_id: trajectory.id, project_id: project.id }, "revision", LIMITS.history);
  return {
    trajectory_id: trajectory.id, count: rows.length,
    policy_versions: [...new Set(rows.map((r) => r.reward_policy_version))],
    rewards: rows.map(publicReward),
  };
}

export async function listProjectRewards(base44, user, { project_id, limit = 20 } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.Reward.filter({ project_id: project.id }, "-created_date", Math.min(limit, 100));
  return { project_id: project.id, count: rows.length, rewards: rows.map(publicReward) };
}