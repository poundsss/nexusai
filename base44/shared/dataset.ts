// NexusAI Dataset Builder.
//
// A DATASET CONSTRUCTION layer and nothing else. It converts episodes the platform has already
// recorded into versioned, reproducible training/evaluation datasets. It does not train, fine-tune,
// benchmark, register or deploy anything, and it never writes to the layers it reads:
//   • Trajectory / TrajectoryEvent (#18), Evaluation (#19), Reward (#20) are READ-ONLY authoritative
//     sources. Their records are never created, updated or reinterpreted here.
//   • Memory (#21) is deliberately NOT a source: private runtime memory must not enter a dataset.
//
// Guarantees:
//   VERSIONING — a dataset name + scope is a lineage. Changing the eligibility policy, the
//     transform, or a required evaluator/reward policy version produces the NEXT version, chained
//     by parent_dataset_id; a finalized dataset is immutable and stays reproducible.
//   DETERMINISM — selection and transformation are pure functions of the source records and the
//     stored policy versions, so the same sources under the same versions yield the same items and
//     the same checksum.
//   IDEMPOTENCY — a build whose source fingerprint already has an active FINALIZED dataset is
//     marked DUPLICATE and points at it, so repeated generation cannot create two active versions.
//   LINEAGE — every item carries dataset → version → item → trajectory → evaluation → reward →
//     source project/version, plus the policy and transform versions that admitted it.
//   ISOLATION — construction and retrieval run through the platform's existing project
//     authorization; a platform-scope dataset admits ONLY explicitly approved projects.
//   DECONTAMINATION — payloads are built from field allowlists and passed through the platform's
//     existing secret scrubber; duplicates, credential-shaped content, incomplete lineage and
//     checksum mismatches all block finalization rather than shipping.
import { scrub, scrubText } from "./tracing.ts";
import { loadAuthorizedProject } from "./authz.ts";
import { requirePlatformAdmin } from "./platformAdmin.ts";
import { classifyDataOrigin } from "./trainingData.ts";

export const DATASET_TYPES = ["sft", "preference", "evaluation"];
export const DATASET_FORMAT_VERSION = "nexus.dataset.v1";
export const DATASET_LIMITS = { candidates: 400, items: 2000, exclusions: 200, export_page: 200, statement: 4000 };

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
// R-5: a failed read is a retryable 503, never an empty result. getOrNull maps ONLY a genuine
// 404 (record absent) to null. UNKNOWN: the store's read consistency; these make failures
// visible, they do not make multi-record operations atomic.
const readUnavailable = () => fail(503, "DATASET_READ_UNAVAILABLE", "Dataset records could not be read; retry later.");
async function mustRead(p) { try { return await p; } catch { readUnavailable(); } }
async function getOrNull(p) {
  try { return await p; } catch (e) {
    if ((e?.status ?? e?.response?.status) === 404) return null;
    readUnavailable();
  }
}

/** Deterministic, stable content hash. Same input text always yields the same digest. */
export function hash(value, prefix = "h") {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let a = 5381, b = 52711;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = ((a << 5) + a + c) | 0; b = ((b << 5) + b + (c ^ 0x5f)) | 0; }
  return `${prefix}_${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}_${text.length.toString(36)}`;
}

// --- versioned eligibility policies ------------------------------------------
//
// No threshold is a permanent constant: every rule lives in a version. Narrowing a policy at build
// time is recorded on the dataset, so the exact selection stays reproducible.
export const ELIGIBILITY_POLICIES = {
  "1.0.0": {
    version: "1.0.0",
    description: "Baseline: sealed episodes with an authoritative evaluation; reward required for preference pairs.",
    rules: {
      require_sealed: true,
      allowed_trajectory_status: ["COMPLETED", "FAILED"],
      require_evaluation: true,
      require_reward: false,
      min_quality: 0.6,
      min_reward: null,
      max_reward: null,
      outcome_class: "success",          // success | failure | any
      require_user_outcome: false,
      evaluator_version: null,
      reward_policy_version: null,
      date_from: null,
      date_to: null,
      min_preference_margin: 0.15,
      allow_duplicates: false,
      // Test/synthetic/certification episodes are excluded by DEFAULT: a learning dataset admits
      // production evidence only, and the exclusion is recorded rather than silent.
      exclude_test_data: true,
    },
  },
  "1.1.0": {
    version: "1.1.0",
    description: "Stricter quality floor and a required user outcome; produces a new dataset version rather than re-labelling 1.0.0 data.",
    rules: {
      require_sealed: true,
      allowed_trajectory_status: ["COMPLETED"],
      require_evaluation: true,
      require_reward: true,
      min_quality: 0.8,
      min_reward: 0.5,
      max_reward: null,
      outcome_class: "success",
      require_user_outcome: true,
      evaluator_version: null,
      reward_policy_version: null,
      date_from: null,
      date_to: null,
      min_preference_margin: 0.15,
      allow_duplicates: false,
      exclude_test_data: true,
    },
  },
};
export const DEFAULT_ELIGIBILITY_VERSION = "1.0.0";

// Only these keys may be narrowed by a caller; anything else is ignored rather than silently
// becoming an undocumented rule.
const RULE_KEYS = Object.keys(ELIGIBILITY_POLICIES["1.0.0"].rules);

export function resolveEligibility(policy_version, overrides = {}) {
  const policy = ELIGIBILITY_POLICIES[policy_version || DEFAULT_ELIGIBILITY_VERSION];
  if (!policy) fail(400, "UNKNOWN_ELIGIBILITY_POLICY", `Unknown eligibility policy version: ${policy_version}`);
  const rules = { ...policy.rules };
  for (const k of RULE_KEYS) if (overrides && overrides[k] !== undefined && overrides[k] !== null) rules[k] = overrides[k];
  return { policy_version: policy.version, rules };
}

// --- versioned transformations -------------------------------------------------

export const TRANSFORMS = { "1.0.0": { version: "1.0.0", description: "Provider-neutral structured examples: task, bounded context, structured plan/action metadata, authoritative outcome." } };
export const DEFAULT_TRANSFORM_VERSION = "1.0.0";

// Allowlists. A field that is not named here NEVER reaches a payload, which is what keeps hidden
// reasoning, credentials and unrelated project data out by construction rather than by filtering.
const CONTEXT_KEYS = ["context_hash", "base_version_number", "file_count", "entity_count", "retrieved", "included", "mcp_tools", "component_count"];
const PLAN_KEYS = ["steps", "file_actions", "entities", "integrations", "assumptions"];

const pick = (src, keys) => keys.reduce((o, k) => { if (src && src[k] !== undefined && src[k] !== null) o[k] = src[k]; return o; }, {});

const taskOf = (t) => ({ request: scrubText(t.prompt || "", DATASET_LIMITS.statement), mode: t.mode || "default", requested_at: t.requested_at || t.created_date || null });
const contextOf = (t) => pick(t.context || {}, CONTEXT_KEYS);
const planOf = (t) => {
  const p = pick(t.plan_summary || {}, PLAN_KEYS);
  return {
    step_count: Number(p.steps || 0),
    file_actions: (p.file_actions || []).slice(0, 100).map((f) => ({ path: f.path, action: f.action })),
    entities: (p.entities || []).slice(0, 50),
    integrations: (p.integrations || []).slice(0, 50),
    assumption_count: Number(p.assumptions || 0),
  };
};
const actionsOf = (t) => (t.tool_calls || []).slice(0, 200).map((c) => ({ tool: c.tool, ok: c.ok !== false, phase: c.phase || null }));
const outcomeOf = (t) => ({
  final_status: t.status,
  version_id: t.mutations?.version_id || null,
  version_number: t.mutations?.version_number ?? null,
  files_changed: t.mutations?.files_changed_count ?? (t.mutations?.changed_files || []).length,
  entities_changed: (t.mutations?.entities_changed || []).length,
  build_status: t.outcomes?.build_status || null,
  runtime_ok: t.outcomes?.runtime_ok ?? null,
  repair_attempts: t.outcomes?.repair_attempts ?? 0,
  retries: t.retries || 0,
  duration_ms: t.duration_ms ?? null,
  user_outcome: t.user_outcome || null,
});

/** Mean of the evaluation's MEASURED dimensions. Unmeasured signals are excluded, never scored 0. */
export function evaluationQuality(evaluation) {
  const scores = Object.values(evaluation?.scores || {}).filter((v) => typeof v === "number");
  if (!scores.length) return null;
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1e6) / 1e6;
}

const criteriaOf = (evaluation, rules) => ({
  evaluator_version: evaluation.evaluator_version,
  dimensions: Object.keys(evaluation.dimensions || {}).sort(),
  measured_dimensions: Object.entries(evaluation.scores || {}).filter(([, v]) => typeof v === "number").map(([k]) => k).sort(),
  thresholds: { min_quality: rules.min_quality },
});

// --- candidate assembly (READ-ONLY over the authoritative layers) --------------

// `overrides` (optional): trajectory_id → { evaluation, reward } held in memory (dry run). An entry
// replaces the database lookup for that episode; without it the behaviour is unchanged.
export async function loadCandidate(svc, trajectory, originCache = null, overrides = null) {
  const o = overrides?.get(trajectory.id);
  let evaluation, reward;
  if (o) {
    evaluation = o.evaluation || null;
    reward = evaluation && o.reward?.status === "active" ? o.reward : null;
  } else {
    const evaluations = await mustRead(svc.entities.Evaluation.filter({ trajectory_id: trajectory.id }, "-revision", 5));
    evaluation = evaluations[0] || null;
    const rewards = evaluation ? (await mustRead(svc.entities.Reward.filter({ trajectory_id: trajectory.id, status: "active" }, "-revision", 5))) : [];
    reward = rewards[0] || null;
  }
  // Provenance, read from the platform's own benchmark/synthetic records — never from a client.
  const data_origin = await classifyDataOrigin(svc, trajectory, originCache);
  return { trajectory, evaluation, reward, quality: evaluation ? evaluationQuality(evaluation) : null, data_origin };
}

/** Pure, deterministic admissibility decision. Returns null when admissible, else a reason. */
export function eligibilityReason(candidate, rules, { dataset_type, approved_project_ids = null }) {
  const { trajectory: t, evaluation, reward, quality } = candidate;
  if (approved_project_ids && !approved_project_ids.includes(t.project_id)) return { reason: "platform_scope_not_approved", detail: "project is not approved for platform-level aggregation" };
  // Test/synthetic/certification evidence never becomes learning data unless a policy explicitly
  // opts in, and even then the origin stays recorded on the item's lineage.
  if (rules.exclude_test_data !== false && candidate.data_origin?.test_only) {
    return { reason: "test_only_source", detail: `${candidate.data_origin.origin}: ${candidate.data_origin.evidence}` };
  }
  // Production-learning adapter (#43): an episode the deterministic promotion policy has refused
  // (unsafe, corrupted, secret-bearing, incomplete…) is never admitted, under ANY policy.
  if (t.learning_eligibility && t.learning_eligibility.eligible === false) {
    return { reason: "production_promotion_excluded", detail: (t.learning_eligibility.reasons || []).join(", ") };
  }
  if (rules.require_sealed && !t.sealed) return { reason: "not_sealed", detail: `status ${t.status}` };
  if ((rules.allowed_trajectory_status || []).length && !rules.allowed_trajectory_status.includes(t.status)) return { reason: "status_not_allowed", detail: t.status };
  if (rules.date_from && String(t.created_date) < rules.date_from) return { reason: "before_date_range", detail: rules.date_from };
  if (rules.date_to && String(t.created_date) > rules.date_to) return { reason: "after_date_range", detail: rules.date_to };
  if (rules.require_evaluation && !evaluation) return { reason: "no_evaluation", detail: "no Judge evaluation exists for this episode" };
  if (rules.evaluator_version && evaluation?.evaluator_version !== rules.evaluator_version) return { reason: "evaluator_version_mismatch", detail: `${evaluation?.evaluator_version} != ${rules.evaluator_version}` };
  if (rules.min_quality != null && (quality == null || quality < rules.min_quality)) return { reason: "below_min_quality", detail: `quality ${quality}` };
  const needsReward = rules.require_reward || dataset_type === "preference" || rules.min_reward != null || rules.max_reward != null;
  if (needsReward && !reward) return { reason: "no_reward", detail: "no active reward exists for this episode" };
  if (reward && rules.reward_policy_version && reward.reward_policy_version !== rules.reward_policy_version) return { reason: "reward_policy_mismatch", detail: reward.reward_policy_version };
  if (needsReward && reward && reward.final_reward == null) return { reason: "insufficient_reward_evidence", detail: reward.status };
  if (rules.min_reward != null && (reward?.final_reward ?? -1) < rules.min_reward) return { reason: "below_min_reward", detail: `reward ${reward?.final_reward}` };
  if (rules.max_reward != null && (reward?.final_reward ?? 2) > rules.max_reward) return { reason: "above_max_reward", detail: `reward ${reward?.final_reward}` };
  if (rules.outcome_class === "success" && t.status !== "COMPLETED") return { reason: "not_a_success_example", detail: t.status };
  if (rules.outcome_class === "failure" && t.status === "COMPLETED") return { reason: "not_a_failure_example", detail: t.status };
  if (rules.require_user_outcome && !t.user_outcome) return { reason: "no_user_outcome", detail: "human outcome unknown" };
  return null;
}

// --- deterministic item construction ------------------------------------------

const lineageOf = (dataset, candidate, extra = {}) => ({
  dataset_id: dataset.id, dataset_name: dataset.name, dataset_version: dataset.version, dataset_type: dataset.dataset_type,
  trajectory_id: candidate.trajectory.id, trajectory_revision: candidate.trajectory.revision || 1,
  run_id: candidate.trajectory.run_id, trace_id: candidate.trajectory.trace_id || null,
  evaluation_id: candidate.evaluation?.id || null, evaluator_version: candidate.evaluation?.evaluator_version || null,
  reward_id: candidate.reward?.id || null, reward_policy_version: candidate.reward?.reward_policy_version || null,
  project_id: candidate.trajectory.project_id, workspace_id: candidate.trajectory.workspace_id,
  source_version_id: candidate.trajectory.mutations?.version_id || null,
  source_version_number: candidate.trajectory.mutations?.version_number ?? null,
  eligibility_policy_version: dataset.eligibility_policy_version, transformation_version: dataset.transformation_version,
  // Provenance of the SOURCE data itself, classified from the platform's own benchmark/synthetic
  // records. Only 'production' can reach a learning dataset, and the classification travels with
  // the item so the decision stays inspectable after export.
  data_origin: candidate.data_origin?.origin || null,
  data_origin_policy_version: candidate.data_origin?.policy_version || null,
  ...extra,
});

function sftItem(dataset, candidate, rules) {
  const { trajectory: t, evaluation, reward, quality } = candidate;
  const payload = scrub({
    format_version: DATASET_FORMAT_VERSION, example_type: "sft",
    task: taskOf(t), context: contextOf(t), plan: planOf(t), actions: actionsOf(t), outcome: outcomeOf(t),
  });
  return {
    item_key: `sft:${t.id}`,
    inclusion_reason: `eligible under ${dataset.eligibility_policy_version}: sealed ${t.status} episode, evaluation quality ${quality} >= ${rules.min_quality}${reward ? `, reward ${reward.final_reward}` : ""}`,
    payload,
    labels: scrub({
      evaluation_id: evaluation.id, evaluator_version: evaluation.evaluator_version, quality,
      scores: evaluation.scores || {}, reward_id: reward?.id || null,
      reward_policy_version: reward?.reward_policy_version || null, final_reward: reward?.final_reward ?? null,
      user_outcome: t.user_outcome || null,
    }),
    lineage: lineageOf(dataset, candidate),
  };
}

// Evaluation items carry the task, its context, the VERIFIED outcome and the criteria — never a
// plan, an action trace, a reward or a quality score, so a benchmark example cannot double as a
// training target or hand the model the answer it is meant to be measured on.
function evaluationItem(dataset, candidate, rules) {
  const { trajectory: t, evaluation } = candidate;
  const payload = scrub({
    format_version: DATASET_FORMAT_VERSION, example_type: "evaluation",
    task: taskOf(t), context: contextOf(t),
    expected_outcome: {
      verified: t.status === "COMPLETED" && t.outcomes?.build_status === "success" && t.outcomes?.runtime_ok === true,
      build_status: t.outcomes?.build_status || null, runtime_verified: t.outcomes?.runtime_ok ?? null,
      version_id: t.mutations?.version_id || null, version_number: t.mutations?.version_number ?? null,
      files_changed: t.mutations?.files_changed_count ?? (t.mutations?.changed_files || []).length,
      entities_changed: (t.mutations?.entities_changed || []).length,
    },
    criteria: criteriaOf(evaluation, rules),
    references: { trajectory_id: t.id, evaluation_id: evaluation.id, run_id: t.run_id, trace_id: t.trace_id || null, build_id: evaluation.build_id || null },
  });
  return {
    item_key: `eval:${t.id}`,
    inclusion_reason: `benchmark example under ${dataset.eligibility_policy_version}: verified ${t.status} episode judged by evaluator ${evaluation.evaluator_version}`,
    payload, labels: null,
    // No reward reference at all: a benchmark example must not carry a training signal, not even
    // as lineage, so it can never be repurposed as a preference or SFT target.
    lineage: { ...lineageOf(dataset, candidate), reward_id: null, reward_policy_version: null },
  };
}

const sideOf = (c) => ({
  trajectory_id: c.trajectory.id, evaluation_id: c.evaluation.id, reward_id: c.reward.id,
  final_reward: c.reward.final_reward, quality: c.quality, outcome: outcomeOf(c.trajectory),
  plan: planOf(c.trajectory), actions: actionsOf(c.trajectory),
  version_id: c.trajectory.mutations?.version_id || null,
});

/**
 * Builds ONE grounded preference pair, or explains why the comparison is not admissible. A pair
 * requires the same project, the same task, comparable judges and policies, active rewards on both
 * sides and a margin above the policy floor — so a preference is never fabricated from a tie or
 * from records that were not measured the same way.
 */
export function preferencePair(dataset, a, b, rules) {
  if (a.trajectory.project_id !== b.trajectory.project_id) return { ok: false, reason: "cross_project_comparison" };
  if (a.trajectory.id === b.trajectory.id) return { ok: false, reason: "same_episode" };
  if (!a.reward || !b.reward || a.reward.final_reward == null || b.reward.final_reward == null) return { ok: false, reason: "insufficient_reward_evidence" };
  if (a.evaluation.evaluator_version !== b.evaluation.evaluator_version) return { ok: false, reason: "evaluator_version_mismatch" };
  if (a.reward.reward_policy_version !== b.reward.reward_policy_version) return { ok: false, reason: "reward_policy_mismatch" };
  const sameTask = String(a.trajectory.prompt || "").trim().toLowerCase() === String(b.trajectory.prompt || "").trim().toLowerCase();
  if (!sameTask) return { ok: false, reason: "tasks_not_comparable" };
  const margin = Math.abs(a.reward.final_reward - b.reward.final_reward);
  if (margin < rules.min_preference_margin) return { ok: false, reason: "margin_below_threshold", detail: `margin ${margin.toFixed(4)} < ${rules.min_preference_margin}` };

  const [win, lose] = a.reward.final_reward > b.reward.final_reward ? [a, b] : [b, a];
  const basis = [`reward ${win.reward.final_reward} vs ${lose.reward.final_reward} under policy ${win.reward.reward_policy_version}`];
  if (win.quality != null && lose.quality != null) basis.push(`evaluation quality ${win.quality} vs ${lose.quality} under evaluator ${win.evaluation.evaluator_version}`);
  if (win.trajectory.outcomes?.build_status !== lose.trajectory.outcomes?.build_status) basis.push(`build ${win.trajectory.outcomes?.build_status} vs ${lose.trajectory.outcomes?.build_status}`);
  if (win.trajectory.user_outcome || lose.trajectory.user_outcome) basis.push(`user outcome ${win.trajectory.user_outcome || "unknown"} vs ${lose.trajectory.user_outcome || "unknown"}`);

  const payload = scrub({
    format_version: DATASET_FORMAT_VERSION, example_type: "preference",
    task: taskOf(win.trajectory), context: contextOf(win.trajectory),
    preferred: sideOf(win), rejected: sideOf(lose),
    comparison: { margin: Math.round(margin * 1e6) / 1e6, basis, rationale: `Preferred episode scored a higher authoritative reward by ${margin.toFixed(4)} under the same evaluator and reward policy.` },
  });
  return {
    ok: true,
    item: {
      item_key: `pref:${win.trajectory.id}|${lose.trajectory.id}`,
      inclusion_reason: `grounded comparison under ${dataset.eligibility_policy_version}: margin ${margin.toFixed(4)} >= ${rules.min_preference_margin}, same task, same evaluator ${win.evaluation.evaluator_version} and reward policy ${win.reward.reward_policy_version}`,
      payload,
      labels: scrub({ preferred_reward: win.reward.final_reward, rejected_reward: lose.reward.final_reward, margin, evaluator_version: win.evaluation.evaluator_version, reward_policy_version: win.reward.reward_policy_version }),
      lineage: lineageOf(dataset, win, {
        rejected_trajectory_id: lose.trajectory.id, rejected_evaluation_id: lose.evaluation.id, rejected_reward_id: lose.reward.id,
      }),
      rejected: { trajectory_id: lose.trajectory.id, evaluation_id: lose.evaluation.id, reward_id: lose.reward.id },
      preferred_candidate: win,
    },
  };
}

// --- authorization -------------------------------------------------------------

async function authorizeSpec(base44, user, { scope, project_id, capability }) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use datasets");
  if (scope === "platform") {
    const admin = await requirePlatformAdmin(base44, user);
    return { project: null, workspace: null, admin_user_id: admin.user_id };
  }
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, capability);
  return { project, workspace, admin_user_id: null };
}

const authorizeDataset = (base44, user, dataset, capability = "dataset.read") =>
  authorizeSpec(base44, user, { scope: dataset.scope, project_id: dataset.project_id, capability: capability === "dataset.write" ? "project.write" : "project.read" });

async function loadDataset(base44, user, dataset_id, capability = "dataset.read") {
  const svc = svcOf(base44);
  const dataset = dataset_id ? await getOrNull(svc.entities.Dataset.get(String(dataset_id))) : null;
  if (!dataset) fail(404, "DATASET_NOT_FOUND", "Dataset not found");
  await authorizeDataset(base44, user, dataset, capability);
  return dataset;
}

// --- lifecycle: create ---------------------------------------------------------

export async function createDataset(base44, user, {
  name, description = "", dataset_type, scope = "project", project_id = null, approved_project_ids = [],
  eligibility_policy_version = DEFAULT_ELIGIBILITY_VERSION, eligibility = {}, transformation_version = DEFAULT_TRANSFORM_VERSION,
} = {}) {
  if (!name || String(name).trim().length < 3) fail(400, "INVALID_INPUT", "name is required");
  if (!DATASET_TYPES.includes(dataset_type)) fail(400, "INVALID_DATASET_TYPE", `dataset_type must be one of: ${DATASET_TYPES.join(", ")}`);
  if (!TRANSFORMS[transformation_version]) fail(400, "UNKNOWN_TRANSFORM", `Unknown transformation version: ${transformation_version}`);
  if (!["project", "platform"].includes(scope)) fail(400, "INVALID_SCOPE", "scope must be project or platform");
  const { project, workspace, admin_user_id } = await authorizeSpec(base44, user, { scope, project_id, capability: "project.write" });

  const svc = svcOf(base44);
  const resolved = resolveEligibility(eligibility_policy_version, eligibility);
  // A platform dataset aggregates only EXPLICITLY approved projects, and the approval itself is
  // authorized: the admin must be able to reach each project they are approving.
  const approved = scope === "platform" ? [...new Set((approved_project_ids || []).map(String))] : [];
  for (const pid of approved) await loadAuthorizedProject(base44, user, pid, "project.read");

  const source_policy_version = sourcePolicyVersion(resolved, transformation_version, dataset_type);

  const siblings = await mustRead(svc.entities.Dataset.filter({ name: String(name), scope, ...(project ? { project_id: project.id } : {}) }, "-version", 50));
  const parent = siblings.find((d) => d.status === "FINALIZED") || null;
  const version = (siblings[0]?.version || 0) + 1;

  const dataset = await svc.entities.Dataset.create({
    name: String(name).trim(), description: scrubText(description || "", 500), dataset_type, version, status: "DRAFT",
    scope, workspace_id: workspace?.id || undefined, project_id: project?.id || undefined,
    approved_project_ids: approved.length ? approved : undefined,
    created_by: user.id, eligibility_policy_version: resolved.policy_version, eligibility: resolved.rules,
    transformation_version, source_policy_version,
    item_count: 0, candidate_count: 0, excluded_count: 0, finalized: false, created_at: nowIso(),
    parent_dataset_id: parent?.id || undefined,
  });
  return { dataset: publicDataset(dataset), created: true, admin_user_id };
}

// --- lifecycle: build ---------------------------------------------------------

export async function buildDataset(base44, user, { dataset_id } = {}) {
  const dataset = await loadDataset(base44, user, dataset_id, "dataset.write");
  if (dataset.finalized || dataset.status === "FINALIZED") fail(409, "DATASET_FINALIZED", "A finalized dataset is immutable — create a new version instead");
  if (dataset.status === "BUILDING") fail(409, "DATASET_BUILDING", "This dataset is already building");
  const svc = svcOf(base44);
  await svc.entities.Dataset.update(dataset.id, { status: "BUILDING", error: null });

  try {
    const rules = dataset.eligibility || resolveEligibility(dataset.eligibility_policy_version).rules;
    if (!TRANSFORMS[dataset.transformation_version]) fail(400, "UNKNOWN_TRANSFORM", `Unknown transformation version: ${dataset.transformation_version}`);
    const projectIds = dataset.scope === "platform" ? (dataset.approved_project_ids || []) : [dataset.project_id];

    const trajectories = [];
    for (const pid of projectIds) {
      if (!pid) continue;
      trajectories.push(...(await mustRead(svc.entities.Trajectory.filter({ project_id: pid }, "created_date", DATASET_LIMITS.candidates))));
    }
    const candidates = [];
    const exclusions = [];
    const originCache = new Map();
    for (const t of trajectories) {
      const candidate = await loadCandidate(svc, t, originCache);
      const bad = eligibilityReason(candidate, rules, { dataset_type: dataset.dataset_type, approved_project_ids: dataset.scope === "platform" ? (dataset.approved_project_ids || []) : null });
      if (bad) { exclusions.push({ trajectory_id: t.id, project_id: t.project_id, reason: bad.reason, detail: scrubText(bad.detail || "", 200) }); continue; }
      candidates.push(candidate);
    }

    const selected = selectDatasetItems(dataset, candidates, rules);
    exclusions.push(...selected.exclusions);
    const items = selected.items;

    // A rebuild replaces the previous attempt's rows: the dataset is not finalized, so its items
    // are still a working set and must not accumulate across builds.
    // R-5: a failed read or delete aborts the build (FAILED below) — never continue on stale rows.
    // No rollback: rows already deleted stay deleted; the dataset is unfinalized and rebuildable.
    for (const old of await mustRead(svc.entities.DatasetItem.filter({ dataset_id: dataset.id }, "created_at", DATASET_LIMITS.items))) {
      try { await svc.entities.DatasetItem.delete(old.id); } catch (e) {
        if ((e?.status ?? e?.response?.status) !== 404) fail(503, "DATASET_CLEANUP_FAILED", "Previous dataset items could not be removed; retry later.");
      }
    }

    const rows = [];
    for (const item of items) rows.push(await svc.entities.DatasetItem.create(itemRow(dataset, item)));

    const checksum = datasetChecksum(dataset, rows);
    const source_fingerprint = hash({
      type: dataset.dataset_type, scope: dataset.scope, project_id: dataset.project_id || null,
      approved: (dataset.approved_project_ids || []).slice().sort(),
      policy: dataset.source_policy_version, keys: rows.map((r) => r.item_key).sort(),
      items: rows.map((r) => r.item_checksum).sort(),
    }, "src");

    const updated = await svc.entities.Dataset.update(dataset.id, {
      status: "BUILT", built_at: nowIso(), item_count: rows.length,
      candidate_count: trajectories.length, excluded_count: exclusions.length,
      exclusions: exclusions.slice(0, DATASET_LIMITS.exclusions), checksum, source_fingerprint, validation: {},
    });
    return { dataset: publicDataset(updated), item_count: rows.length, candidate_count: trajectories.length, excluded_count: exclusions.length, exclusions: exclusions.slice(0, DATASET_LIMITS.exclusions) };
  } catch (e) {
    // A failed build is explicitly FAILED and carries no checksum, so it can never be finalized.
    await svc.entities.Dataset.update(dataset.id, { status: "FAILED", error: scrubText(e.message, 400), finalized: false, checksum: null, source_fingerprint: null }).catch(() => {});
    throw e;
  }
}

/**
 * Pure: the deterministic item set for already-admitted candidates (ordering, transformation,
 * pairing, duplicate detection and the item cap). Returns the items and the exclusions it made.
 */
export function selectDatasetItems(dataset, candidates, rules) {
  const exclusions = [];
  // Deterministic ordering: the item set and its checksum must not depend on read order.
  const sorted = [...candidates].sort((a, b) => String(a.trajectory.created_date).localeCompare(String(b.trajectory.created_date)) || String(a.trajectory.id).localeCompare(String(b.trajectory.id)));
  const built = [];
  if (dataset.dataset_type === "sft") {
    for (const c of sorted) built.push(sftItem(dataset, c, rules));
  } else if (dataset.dataset_type === "evaluation") {
    for (const c of sorted) built.push(evaluationItem(dataset, c, rules));
  } else {
    const used = new Set();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const pair = preferencePair(dataset, sorted[i], sorted[j], rules);
        if (!pair.ok) { exclusions.push({ trajectory_id: sorted[i].trajectory.id, project_id: sorted[i].trajectory.project_id, reason: pair.reason, detail: scrubText(pair.detail || sorted[j].trajectory.id, 200) }); continue; }
        // One pairing per episode keeps the set grounded rather than combinatorially inflated.
        if (used.has(sorted[i].trajectory.id) || used.has(sorted[j].trajectory.id)) { exclusions.push({ trajectory_id: sorted[j].trajectory.id, project_id: sorted[j].trajectory.project_id, reason: "episode_already_paired" }); continue; }
        used.add(sorted[i].trajectory.id); used.add(sorted[j].trajectory.id);
        built.push(pair.item);
      }
    }
  }
  // Duplicate detection: at most one item per logical key unless the policy explicitly allows it.
  const seen = new Set();
  const items = [];
  for (const item of built) {
    if (!rules.allow_duplicates && seen.has(item.item_key)) { exclusions.push({ trajectory_id: item.lineage.trajectory_id, project_id: item.lineage.project_id, reason: "duplicate_item", detail: item.item_key }); continue; }
    seen.add(item.item_key);
    if (items.length >= DATASET_LIMITS.items) { exclusions.push({ trajectory_id: item.lineage.trajectory_id, reason: "dataset_item_cap_reached" }); continue; }
    items.push(item);
  }
  return { items, exclusions };
}

/** Pure: the persisted DatasetItem shape for one built item, as buildDataset stores it. */
export function itemRow(dataset, item) {
  const item_checksum = hash({ key: item.item_key, payload: item.payload, transform: dataset.transformation_version }, "itm");
  return {
    dataset_id: dataset.id, dataset_version: dataset.version, dataset_type: dataset.dataset_type,
    item_key: item.item_key, item_checksum,
    trajectory_id: item.lineage.trajectory_id, evaluation_id: item.lineage.evaluation_id || undefined,
    reward_id: item.lineage.reward_id || undefined,
    rejected_trajectory_id: item.rejected?.trajectory_id || undefined,
    rejected_evaluation_id: item.rejected?.evaluation_id || undefined,
    rejected_reward_id: item.rejected?.reward_id || undefined,
    project_id: item.lineage.project_id, workspace_id: item.lineage.workspace_id,
    source_version_id: item.lineage.source_version_id || undefined,
    source_version_number: item.lineage.source_version_number ?? undefined,
    source_run_id: item.lineage.run_id || undefined, source_trace_id: item.lineage.trace_id || undefined,
    evaluator_version: item.lineage.evaluator_version || undefined,
    reward_policy_version: item.lineage.reward_policy_version || undefined,
    eligibility_policy_version: dataset.eligibility_policy_version, transformation_version: dataset.transformation_version,
    inclusion_reason: scrubText(item.inclusion_reason, 400),
    payload: item.payload, labels: item.labels || undefined, lineage: scrub(item.lineage),
    created_at: nowIso(),
  };
}

/** Pure: the source policy identity createDataset stamps on a dataset. */
export function sourcePolicyVersion(resolved, transformation_version, dataset_type) {
  return hash({ eligibility: resolved.policy_version, rules: resolved.rules, transform: transformation_version, dataset_type }, "pol");
}

export function datasetChecksum(dataset, rows) {
  const ordered = rows.map((r) => `${r.item_key}:${r.item_checksum}`).sort();
  // CONTENT only — deliberately not the version number, so an identical source set under identical
  // policies reproduces the same checksum and the duplicate is detectable.
  return hash({ dataset: { type: dataset.dataset_type, policy: dataset.source_policy_version }, items: ordered }, "chk");
}

// --- lifecycle: validate ------------------------------------------------------

// Credential shapes that must never survive into a dataset, checked on the STORED payload rather
// than on the input, so scrubbing is verified after the fact and not merely assumed.
const CREDENTIAL_RE = /(sk_live_[\w-]{6,}|sk_test_[\w-]{6,}|whsec_[\w-]{6,}|ghp_[\w-]{6,}|github_pat_[\w-]{6,}|xox[abposr]-[\w-]{6,}|AKIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.[\w-]{5,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[\w.\-]{12,})/i;
const FORBIDDEN_KEY_RE = /(chain_of_thought|hidden_reasoning|reasoning_trace|scratchpad|thoughts?|secret|token|password|credential|api[_-]?key|private[_-]?key|memory_items?|private_memory)/i;

const REQUIRED_PAYLOAD_KEYS = {
  sft: ["format_version", "task", "context", "plan", "actions", "outcome"],
  preference: ["format_version", "task", "preferred", "rejected", "comparison"],
  evaluation: ["format_version", "task", "context", "expected_outcome", "criteria", "references"],
};
const FORBIDDEN_PAYLOAD_KEYS = { sft: [], preference: [], evaluation: ["plan", "actions", "labels", "reward", "target"] };

function deepKeys(value, out = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return out;
  for (const [k, v] of Object.entries(value)) { out.push(k); deepKeys(v, out, depth + 1); }
  return out;
}

export async function validateDataset(base44, user, { dataset_id } = {}) {
  const dataset = await loadDataset(base44, user, dataset_id, "dataset.write");
  if (dataset.finalized) fail(409, "DATASET_FINALIZED", "A finalized dataset is immutable");
  if (!["BUILT", "VALIDATED"].includes(dataset.status)) fail(409, "DATASET_NOT_BUILT", `A dataset must be built before validation (status ${dataset.status})`);
  const report = await runValidation(base44, dataset);
  const svc = svcOf(base44);
  const updated = await svc.entities.Dataset.update(dataset.id, {
    validation: report, ...(report.ok ? { status: "VALIDATED", validated_at: nowIso() } : { status: "BUILT" }),
  });
  return { dataset: publicDataset(updated), validation: report };
}

// Read-after-write: items just written may not all be visible yet. A short read is re-read a
// bounded number of times before the item_count check judges it; a genuine shortfall still fails.
// UNKNOWN: the store's read consistency — this narrows the window, it guarantees nothing.
export const ITEM_READ_ATTEMPTS = 3;
async function readItemsSettled(svc, dataset) {
  let rows = [];
  for (let i = 0; i < ITEM_READ_ATTEMPTS; i++) {
    if (i) await new Promise((r) => setTimeout(r, 250 * i));
    rows = await svc.entities.DatasetItem.filter({ dataset_id: dataset.id }, "item_key", DATASET_LIMITS.items);
    if (rows.length >= (dataset.item_count || 0)) break;
  }
  return rows;
}

// Consumers of a FINALIZED dataset (candidate scoring, learning-cycle provenance checks) must
// see every item: a failed read or a still-short read after settling is a retryable 503, never
// a silently smaller measurement. The stored item_count is the completeness contract.
export async function readFinalizedItems(svc, dataset) {
  const rows = await mustRead(readItemsSettled(svc, dataset));
  if (rows.length < (dataset.item_count || 0)) {
    fail(503, "DATASET_ITEMS_INCOMPLETE", `Only ${rows.length} of ${dataset.item_count} dataset items are readable right now; retry later.`);
  }
  return rows;
}

/** The one validation implementation. Re-run at finalization, so a stale pass cannot be reused. */
// Options (dry run): `rows` replaces the stored DatasetItem read; `resolve.evaluation(id)` /
// `resolve.reward(id)` return an in-memory record first (null → database). Absent → unchanged.
export async function runValidation(base44, dataset, { rows: givenRows = null, resolve = null } = {}) {
  const svc = svcOf(base44);
  const rows = givenRows || await readItemsSettled(svc, dataset);
  const getEvaluation = async (id) => resolve?.evaluation?.(id) || await getOrNull(svc.entities.Evaluation.get(id));
  const getReward = async (id) => resolve?.reward?.(id) || await getOrNull(svc.entities.Reward.get(id));
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: scrubText(detail || "", 300) });
  const allowedProjects = dataset.scope === "platform" ? (dataset.approved_project_ids || []) : [dataset.project_id];

  add("item_count", rows.length > 0 && rows.length === (dataset.item_count || 0), `${rows.length} stored vs ${dataset.item_count} recorded`);

  const missingProvenance = rows.filter((r) => !r.trajectory_id || !r.evaluation_id || !r.project_id || !r.workspace_id || !r.inclusion_reason || !r.transformation_version || !r.eligibility_policy_version || !r.lineage?.dataset_id);
  add("provenance_completeness", missingProvenance.length === 0, missingProvenance.length ? `${missingProvenance.length} item(s) missing provenance: ${missingProvenance.slice(0, 3).map((r) => r.item_key).join(", ")}` : "every item carries trajectory, evaluation, project, workspace, reason and versions");

  const rewardRequired = dataset.dataset_type === "preference" || dataset.eligibility?.require_reward || dataset.eligibility?.min_reward != null;
  const missingReward = rewardRequired ? rows.filter((r) => !r.reward_id) : [];
  add("reward_lineage", missingReward.length === 0, rewardRequired ? `${rows.length - missingReward.length}/${rows.length} item(s) carry a reward` : "reward not required by this policy");

  // Lineage integrity: every referenced authoritative record must still exist and still be the
  // kind of record that admitted the item.
  const broken = [];
  for (const r of rows.slice(0, 200)) {
    const t = await getOrNull(svc.entities.Trajectory.get(r.trajectory_id));
    if (!t || !t.sealed || t.project_id !== r.project_id) { broken.push(`${r.item_key}: trajectory`); continue; }
    if (!allowedProjects.includes(t.project_id)) { broken.push(`${r.item_key}: project not in dataset scope`); continue; }
    const e = r.evaluation_id ? await getEvaluation(r.evaluation_id) : null;
    if (!e || e.trajectory_id !== r.trajectory_id) { broken.push(`${r.item_key}: evaluation`); continue; }
    if (r.reward_id) {
      const rw = await getReward(r.reward_id);
      if (!rw || rw.trajectory_id !== r.trajectory_id) broken.push(`${r.item_key}: reward`);
    }
    if (r.rejected_trajectory_id) {
      const rt = await getOrNull(svc.entities.Trajectory.get(r.rejected_trajectory_id));
      if (!rt || rt.project_id !== r.project_id) broken.push(`${r.item_key}: rejected side`);
    }
  }
  add("lineage_integrity", broken.length === 0, broken.length ? `broken lineage: ${broken.slice(0, 3).join("; ")}` : "every referenced trajectory, evaluation and reward resolves");

  const foreign = rows.filter((r) => !allowedProjects.includes(r.project_id));
  add("authorization", foreign.length === 0, foreign.length ? `${foreign.length} item(s) from a project outside this dataset's scope` : `all items within ${allowedProjects.length} authorized project(s)`);

  const keys = rows.map((r) => r.item_key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  add("duplicate_detection", dataset.eligibility?.allow_duplicates ? true : dupes.length === 0, dupes.length ? `duplicate keys: ${[...new Set(dupes)].slice(0, 3).join(", ")}` : "all item keys unique");

  const schemaProblems = [];
  for (const r of rows) {
    const required = REQUIRED_PAYLOAD_KEYS[r.dataset_type] || [];
    for (const k of required) if (r.payload?.[k] === undefined) schemaProblems.push(`${r.item_key}: missing ${k}`);
    for (const k of FORBIDDEN_PAYLOAD_KEYS[r.dataset_type] || []) if (r.payload?.[k] !== undefined) schemaProblems.push(`${r.item_key}: forbidden ${k}`);
    if (r.payload?.format_version !== DATASET_FORMAT_VERSION) schemaProblems.push(`${r.item_key}: format`);
    if (r.dataset_type === "evaluation" && r.labels) schemaProblems.push(`${r.item_key}: evaluation item carries training labels`);
  }
  add("schema_correctness", schemaProblems.length === 0, schemaProblems.length ? schemaProblems.slice(0, 3).join("; ") : `${rows.length} item(s) match the ${DATASET_FORMAT_VERSION} contract`);

  const contaminated = [];
  for (const r of rows) {
    const serialized = JSON.stringify({ payload: r.payload, labels: r.labels || null, inclusion_reason: r.inclusion_reason });
    if (CREDENTIAL_RE.test(serialized)) contaminated.push(`${r.item_key}: credential value`);
    const badKey = deepKeys({ payload: r.payload, labels: r.labels || null }).find((k) => FORBIDDEN_KEY_RE.test(k));
    if (badKey) contaminated.push(`${r.item_key}: field ${badKey}`);
  }
  add("secret_scrubbing", contaminated.length === 0, contaminated.length ? contaminated.slice(0, 3).join("; ") : "no credential value, secret-shaped field, private memory or hidden reasoning present");

  const recomputed = datasetChecksum(dataset, rows);
  add("checksum", !!dataset.checksum && recomputed === dataset.checksum, `recorded ${dataset.checksum} vs recomputed ${recomputed}`);

  return {
    ok: checks.every((c) => c.ok), validated_at: nowIso(), item_count: rows.length,
    checksum: recomputed, checks, failed: checks.filter((c) => !c.ok).map((c) => c.name),
  };
}

// --- lifecycle: finalize ------------------------------------------------------

export async function finalizeDataset(base44, user, { dataset_id } = {}) {
  const dataset = await loadDataset(base44, user, dataset_id, "dataset.write");
  const svc = svcOf(base44);
  if (dataset.finalized || dataset.status === "FINALIZED") return { dataset: publicDataset(dataset), finalized: true, already: true };
  if (dataset.status !== "VALIDATED") fail(409, "DATASET_NOT_VALIDATED", `Only a VALIDATED dataset can be finalized (status ${dataset.status})`);

  // Validation is re-run here, so an item changed after the pass cannot slip into a finalized set.
  const report = await runValidation(base44, dataset);
  if (!report.ok) {
    const failed = await svc.entities.Dataset.update(dataset.id, { status: "BUILT", validation: report, finalized: false });
    fail(409, "VALIDATION_FAILED", `Validation failed at finalization: ${report.failed.join(", ")}`);
    return { dataset: publicDataset(failed) };
  }

  // Idempotency: an identical source set under identical policies is the SAME dataset.
  const twins = (await mustRead(svc.entities.Dataset.filter({ source_fingerprint: dataset.source_fingerprint, status: "FINALIZED" }, "version", 10)))
    .filter((d) => d.id !== dataset.id && d.dataset_type === dataset.dataset_type && d.scope === dataset.scope && (d.project_id || null) === (dataset.project_id || null));
  if (twins.length) {
    const dup = await svc.entities.Dataset.update(dataset.id, { status: "DUPLICATE", duplicate_of_dataset_id: twins[0].id, validation: report, finalized: false });
    return { dataset: publicDataset(dup), finalized: false, duplicate_of: publicDataset(twins[0]), reason: "identical_source_and_policy" };
  }

  const finalized = await svc.entities.Dataset.update(dataset.id, {
    status: "FINALIZED", finalized: true, finalized_at: nowIso(), validated_at: dataset.validated_at || nowIso(),
    validation: report, item_count: report.item_count, checksum: report.checksum,
  });
  return { dataset: publicDataset(finalized), finalized: true, validation: report };
}

// --- read paths ---------------------------------------------------------------

const publicDataset = (d) => ({
  dataset_id: d.id, name: d.name, description: d.description || "", dataset_type: d.dataset_type, version: d.version,
  status: d.status, scope: d.scope, workspace_id: d.workspace_id || null, project_id: d.project_id || null,
  approved_project_ids: d.approved_project_ids || [], created_by: d.created_by || null,
  eligibility_policy_version: d.eligibility_policy_version, eligibility: d.eligibility || {},
  transformation_version: d.transformation_version, source_policy_version: d.source_policy_version || null,
  source_fingerprint: d.source_fingerprint || null, checksum: d.checksum || null,
  item_count: d.item_count || 0, candidate_count: d.candidate_count || 0, excluded_count: d.excluded_count || 0,
  exclusions: d.exclusions || [], validation: d.validation || {}, parent_dataset_id: d.parent_dataset_id || null,
  duplicate_of_dataset_id: d.duplicate_of_dataset_id || null, finalized: !!d.finalized, error: d.error || null,
  created_at: d.created_at || d.created_date, built_at: d.built_at || null, validated_at: d.validated_at || null, finalized_at: d.finalized_at || null,
});

const publicItem = (r) => ({
  item_id: r.id, dataset_id: r.dataset_id, dataset_version: r.dataset_version, dataset_type: r.dataset_type,
  item_key: r.item_key, item_checksum: r.item_checksum,
  payload: r.payload || {}, labels: r.labels || null,
  inclusion_reason: r.inclusion_reason || null, lineage: r.lineage || {},
  trajectory_id: r.trajectory_id, evaluation_id: r.evaluation_id || null, reward_id: r.reward_id || null,
  rejected_trajectory_id: r.rejected_trajectory_id || null,
  project_id: r.project_id || null, workspace_id: r.workspace_id || null,
  source_version_id: r.source_version_id || null, source_version_number: r.source_version_number ?? null,
  source_run_id: r.source_run_id || null, source_trace_id: r.source_trace_id || null,
  evaluator_version: r.evaluator_version || null, reward_policy_version: r.reward_policy_version || null,
  eligibility_policy_version: r.eligibility_policy_version, transformation_version: r.transformation_version,
  created_at: r.created_at || r.created_date,
});

export async function getDataset(base44, user, { dataset_id } = {}) {
  const dataset = await loadDataset(base44, user, dataset_id);
  return { dataset: publicDataset(dataset) };
}

export async function listDatasets(base44, user, { project_id = null, scope = "project", dataset_type = null, limit = 50 } = {}) {
  await authorizeSpec(base44, user, { scope, project_id, capability: "project.read" });
  const svc = svcOf(base44);
  const rows = await svc.entities.Dataset.filter({ scope, ...(scope === "project" ? { project_id } : {}), ...(dataset_type ? { dataset_type } : {}) }, "-created_date", Math.min(limit, 100));
  return { count: rows.length, datasets: rows.map(publicDataset) };
}

/** Export: FINALIZED datasets only, paginated, provider-neutral, without secrets. */
export async function exportDataset(base44, user, { dataset_id, limit = DATASET_LIMITS.export_page, offset = 0 } = {}) {
  const dataset = await loadDataset(base44, user, dataset_id);
  if (dataset.status !== "FINALIZED" || !dataset.finalized) fail(409, "DATASET_NOT_FINALIZED", "Only a finalized dataset can be exported");
  const svc = svcOf(base44);
  const rows = await svc.entities.DatasetItem.filter({ dataset_id: dataset.id }, "item_key", Math.min(limit, DATASET_LIMITS.export_page), offset);
  return {
    dataset: publicDataset(dataset), format_version: DATASET_FORMAT_VERSION,
    count: rows.length, offset, total: dataset.item_count || 0, has_more: offset + rows.length < (dataset.item_count || 0),
    items: rows.map(publicItem),
  };
}

/** Full chain for one item: dataset → version → item → trajectory → evaluation → reward → source. */
export async function getLineage(base44, user, { dataset_id = null, item_id = null, item_key = null } = {}) {
  const svc = svcOf(base44);
  let item = null;
  if (item_id) item = await getOrNull(svc.entities.DatasetItem.get(String(item_id)));
  else if (dataset_id && item_key) item = (await mustRead(svc.entities.DatasetItem.filter({ dataset_id: String(dataset_id), item_key: String(item_key) }, "item_key", 1)))[0] || null;
  if (!item) fail(404, "DATASET_ITEM_NOT_FOUND", "Dataset item not found");
  const dataset = await loadDataset(base44, user, item.dataset_id);
  if (dataset_id && item.dataset_id !== String(dataset_id)) fail(404, "DATASET_ITEM_NOT_FOUND", "Dataset item not found in this dataset");

  const [trajectory, evaluation, reward] = await Promise.all([
    getOrNull(svc.entities.Trajectory.get(item.trajectory_id)),
    item.evaluation_id ? getOrNull(svc.entities.Evaluation.get(item.evaluation_id)) : null,
    item.reward_id ? getOrNull(svc.entities.Reward.get(item.reward_id)) : null,
  ]);
  return {
    complete: !!(trajectory && evaluation),
    chain: {
      dataset: { dataset_id: dataset.id, name: dataset.name, version: dataset.version, dataset_type: dataset.dataset_type, status: dataset.status, checksum: dataset.checksum || null, eligibility_policy_version: dataset.eligibility_policy_version, transformation_version: dataset.transformation_version, source_policy_version: dataset.source_policy_version || null },
      item: { item_id: item.id, item_key: item.item_key, item_checksum: item.item_checksum, inclusion_reason: item.inclusion_reason || null },
      trajectory: trajectory ? { trajectory_id: trajectory.id, run_id: trajectory.run_id, status: trajectory.status, sealed: !!trajectory.sealed, revision: trajectory.revision || 1, trace_id: trajectory.trace_id || null, user_outcome: trajectory.user_outcome || null } : null,
      evaluation: evaluation ? { evaluation_id: evaluation.id, evaluator_version: evaluation.evaluator_version, revision: evaluation.revision || 1, inputs_hash: evaluation.inputs_hash || null, scores: evaluation.scores || {} } : null,
      reward: reward ? { reward_id: reward.id, reward_policy_version: reward.reward_policy_version, revision: reward.revision || 1, final_reward: reward.final_reward ?? null, status: reward.status } : null,
      rejected: item.rejected_trajectory_id ? { trajectory_id: item.rejected_trajectory_id, evaluation_id: item.rejected_evaluation_id || null, reward_id: item.rejected_reward_id || null } : null,
      source: { project_id: item.project_id || null, workspace_id: item.workspace_id || null, version_id: item.source_version_id || null, version_number: item.source_version_number ?? null, run_id: item.source_run_id || null, trace_id: item.source_trace_id || null },
    },
  };
}

export const datasetPolicies = () => ({
  format_version: DATASET_FORMAT_VERSION,
  dataset_types: DATASET_TYPES,
  eligibility_policies: Object.values(ELIGIBILITY_POLICIES).map((p) => ({ version: p.version, description: p.description, rules: p.rules })),
  transformations: Object.values(TRANSFORMS),
  limits: DATASET_LIMITS,
});