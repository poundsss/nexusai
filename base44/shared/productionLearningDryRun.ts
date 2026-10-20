// Read-only dry run of ONE production learning cycle (#43).
//
// Exercises the SAME eligibility, Judge, Reward, dataset construction + validation, candidate
// measurement, regression comparison and promotion verdict as runLearningCycle, but every result is
// held in memory. All database access goes through readOnlyDb(), which throws DRY_RUN_WRITE_BLOCKED
// on any mutation, so a missed write path fails loudly instead of persisting. It never proposes or
// activates a routing policy, creates no LearningCycle, writes no audit row and annotates no episode.
import { scrub } from "./tracing.ts";
import { loadAuthorizedProject } from "./authz.ts";
import { computeEvaluation, evaluationRecordFields, EVALUATOR_VERSION } from "./evaluation.ts";
import { rewardFor, rewardRecordFields, REWARD_POLICY_VERSION } from "./reward.ts";
import { classifyDataOrigin } from "./trainingData.ts";
import {
  loadCandidate, eligibilityReason, selectDatasetItems, itemRow, datasetChecksum, runValidation,
  resolveEligibility, sourcePolicyVersion, DEFAULT_ELIGIBILITY_VERSION, DEFAULT_TRANSFORM_VERSION,
} from "./dataset.ts";
import { scoreItems, compareMeasurements, resolveCandidate } from "./candidateEvaluation.ts";
import { promotionDecision, promotionVerdict, knownGoodCycle, PROMOTION_RULES, PROMOTION_POLICY_VERSION } from "./productionLearning.ts";
import { NEXUS_MODEL_ID } from "./nexusProvider.ts";

const WRITE_METHODS = ["create", "bulkCreate", "update", "bulkUpdate", "updateMany", "delete", "deleteMany", "upsert", "importEntities"];
const LIMITS = { trajectories: 400, events: 300, history: 50, exclusions: 200 };
const DATASET_NAME = "production-learning";

/** A database view that allows reads and throws DRY_RUN_WRITE_BLOCKED on every mutation. */
export function readOnlyDb(base44) {
  const src = (base44.asServiceRole || base44).entities;
  const entities = new Proxy({}, {
    get(_t, name) {
      const entity = src[name];
      if (!entity) return entity;
      return new Proxy(entity, {
        get(target, method) {
          if (WRITE_METHODS.includes(String(method))) {
            return () => { throw Object.assign(new Error(`Dry run refused ${String(name)}.${String(method)}`), { status: 409, code: "DRY_RUN_WRITE_BLOCKED" }); };
          }
          const v = target[method];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  });
  // Indirect side-effect surfaces (integrations, function invocation) are refused too, and the
  // service-role escape hatch resolves to this same read-only view.
  const blocked = (what) => () => { throw Object.assign(new Error(`Dry run refused ${what}`), { status: 409, code: "DRY_RUN_WRITE_BLOCKED" }); };
  const refuse = (root) => new Proxy({}, {
    get: (_t, k) => (typeof k === "symbol" ? undefined : new Proxy(blocked(`${root}.${String(k)}`), {
      get: (_f, m) => (typeof m === "symbol" ? undefined : blocked(`${root}.${String(k)}.${String(m)}`)),
    })),
  });
  const view = { entities, integrations: refuse("integrations"), functions: refuse("functions") };
  view.asServiceRole = view;
  return view;
}

// In-memory Judge: the stored identical evaluation when one exists (exactly what evaluateTrajectory
// would return), otherwise the record evaluateTrajectory WOULD create, under a deterministic id.
async function judge(ro, t) {
  const computed = await computeEvaluation(ro, { trajectory: t }).catch(() => null);
  if (!computed) return null;
  const all = await ro.entities.Evaluation.filter({ trajectory_id: t.id }, "revision", LIMITS.history).catch(() => []);
  const identical = all.find((e) => e.evaluator_version === EVALUATOR_VERSION && e.inputs_hash === computed.inputs_hash);
  if (identical) return identical;
  const fields = evaluationRecordFields(t, { ...computed, evaluator_version: EVALUATOR_VERSION, previous: all[all.length - 1] || null });
  return { id: `dryrun_eval_${computed.inputs_hash}`, ...fields };
}

async function rewardOf(ro, t, evaluation) {
  let computed;
  try { computed = rewardFor({ trajectory: t, evaluation }); } catch { return null; }
  const all = await ro.entities.Reward.filter({ trajectory_id: t.id }, "revision", LIMITS.history).catch(() => []);
  const identical = all.find((r) => r.reward_policy_version === REWARD_POLICY_VERSION && r.inputs_hash === computed.inputs_hash && r.status !== "superseded");
  if (identical) return identical;
  const fields = rewardRecordFields(t, evaluation, { ...computed, reward_policy_version: REWARD_POLICY_VERSION, previous: all[all.length - 1] || null });
  return { id: `dryrun_rew_${computed.inputs_hash}`, ...fields };
}

async function capture(ro, project) {
  const trajectories = await ro.entities.Trajectory.filter({ project_id: project.id }, "created_date", LIMITS.trajectories);
  const overrides = new Map(), evaluations = new Map(), rewards = new Map(), views = [];
  const eligible = [], excluded = [];
  const originCache = new Map();
  let judged = 0, rewarded = 0;
  for (const t of trajectories) {
    if (t.project_id !== project.id) continue;
    let evaluation = null, reward = null;
    if (t.sealed) {
      evaluation = await judge(ro, t);
      if (evaluation) { judged++; evaluations.set(evaluation.id, evaluation); }
      reward = evaluation ? await rewardOf(ro, t, evaluation) : null;
      if (reward) rewards.set(reward.id, reward);
      if (reward?.final_reward != null) rewarded++;
      overrides.set(t.id, { evaluation, reward });
    }
    const events = await ro.entities.TrajectoryEvent.filter({ trajectory_id: t.id, project_id: project.id }, "sequence", LIMITS.events).catch(() => []);
    const data_origin = await classifyDataOrigin(ro, t, originCache);
    const decision = promotionDecision({ trajectory: t, events, evaluation, reward, data_origin });
    if (decision.eligible) eligible.push(t.id); else excluded.push({ trajectory_id: t.id, reasons: decision.reasons });
    // The eligibility stamp the real capture would write, applied to an in-memory view only.
    views.push(t.sealed ? { ...t, learning_eligibility: { ...decision, cycle_id: null } } : t);
  }
  return {
    views, overrides, evaluations, rewards, eligible_ids: eligible,
    summary: {
      considered: trajectories.length, judged, rewarded, eligible: eligible.length, excluded: excluded.length,
      exclusions: excluded.slice(0, LIMITS.exclusions),
      exclusion_reasons: excluded.reduce((acc, e) => { for (const r of e.reasons) acc[r] = (acc[r] || 0) + 1; return acc; }, {}),
    },
  };
}

// The dataset createDataset + buildDataset WOULD produce, validated by the ONE validation path.
async function simulateDataset(ro, { project, workspace, dataset_type, cap }) {
  const resolved = resolveEligibility(DEFAULT_ELIGIBILITY_VERSION, {});
  const name = `${DATASET_NAME}-${dataset_type}`;
  const siblings = await ro.entities.Dataset.filter({ name, scope: "project", project_id: project.id }, "-version", 50).catch(() => []);
  const spec = {
    id: `dry_run_${dataset_type}`, name, version: (siblings[0]?.version || 0) + 1, dataset_type, scope: "project",
    project_id: project.id, workspace_id: workspace.id, eligibility_policy_version: resolved.policy_version,
    eligibility: resolved.rules, transformation_version: DEFAULT_TRANSFORM_VERSION,
    source_policy_version: sourcePolicyVersion(resolved, DEFAULT_TRANSFORM_VERSION, dataset_type),
  };
  const candidates = [], exclusions = [];
  const originCache = new Map();
  for (const t of cap.views) {
    const c = await loadCandidate(ro, t, originCache, cap.overrides);
    const bad = eligibilityReason(c, resolved.rules, { dataset_type, approved_project_ids: null });
    if (bad) { exclusions.push({ trajectory_id: t.id, reason: bad.reason }); continue; }
    candidates.push(c);
  }
  const selected = selectDatasetItems(spec, candidates, resolved.rules);
  exclusions.push(...selected.exclusions);
  const rows = selected.items.map((item) => itemRow(spec, item)).sort((a, b) => String(a.item_key).localeCompare(String(b.item_key)));
  spec.item_count = rows.length;
  spec.checksum = datasetChecksum(spec, rows);
  const out = { dataset_type, item_count: rows.length, checksum: spec.checksum, exclusions: exclusions.slice(0, LIMITS.exclusions), rows, spec };
  if (!rows.length) return { ...out, ok: false, code: "NO_ELIGIBLE_EXAMPLES" };
  const validation = await runValidation(ro, spec, {
    rows, resolve: { evaluation: (id) => cap.evaluations.get(id) || null, reward: (id) => cap.rewards.get(id) || null },
  });
  return { ...out, validation, ok: validation.ok, code: validation.ok ? null : "DATASET_FAILED" };
}

// Identifiers only — never prompt or content payloads.
export const lineageIds = (l) => l && { trajectory_id: l.trajectory_id || null, evaluation_id: l.evaluation_id || null, reward_id: l.reward_id || null, run_id: l.run_id || null, project_id: l.project_id || null, source_version_id: l.source_version_id || null, dataset_id: l.dataset_id || null };
const publicDataset = (d) => d && ({ dataset_type: d.dataset_type, item_count: d.item_count, checksum: d.checksum, item_keys: (d.rows || []).map((r) => r.item_key),
  items: (d.rows || []).map((r) => ({ item_key: r.item_key, item_checksum: r.item_checksum, evaluation_id: r.evaluation_id || null, transformation_version: r.transformation_version, lineage: lineageIds(r.lineage) })), ok: d.ok, code: d.code, validation: d.validation || null, exclusions: d.exclusions });

export async function simulateLearningCycle(base44, user, { project_id, candidate = null } = {}) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const ro = readOnlyDb(base44);
  const frozen = resolveCandidate({ model_id: NEXUS_MODEL_ID, ...(candidate || {}) });
  const reference = await knownGoodCycle(ro, project.id);
  const report = {
    dry_run: true, project_id: project.id, promotion_policy_version: PROMOTION_POLICY_VERSION,
    candidate: frozen.candidate, candidate_id: frozen.candidate_id, reference_cycle_id: reference?.id || null,
    capture: null, datasets: {}, metrics: null, coverage: null, regression: null, promotion: null,
    would_promote: false, failure_code: null, error: null,
  };
  const stop = (failure_code, error) => ({ ...report, failure_code, error });

  const cap = await capture(ro, project);
  report.capture = cap.summary;
  if (!cap.eligible_ids.length) return stop("NO_ELIGIBLE_EXAMPLES", "no production episode passed the promotion policy");

  const training = await simulateDataset(ro, { project, workspace, dataset_type: "sft", cap });
  report.datasets.training = publicDataset(training);
  if (!training.ok) return stop(training.code, `training dataset: ${training.validation?.failed?.join(", ") || training.code}`);
  const evaluation = await simulateDataset(ro, { project, workspace, dataset_type: "evaluation", cap });
  report.datasets.evaluation = publicDataset(evaluation);
  if (!evaluation.ok) return stop(evaluation.code, `evaluation dataset: ${evaluation.validation?.failed?.join(", ") || evaluation.code}`);
  const eligibleSet = new Set(cap.eligible_ids);
  const foreign = evaluation.rows.filter((i) => !eligibleSet.has(i.trajectory_id) || i.project_id !== project.id);
  if (foreign.length) return stop("PROMOTION_POLICY_VIOLATION", `${foreign.length} dataset item(s) trace to an episode the promotion policy did not admit`);

  const score = (c) => scoreItems(ro, { items: evaluation.rows, candidate: c, workspace_id: workspace.id, dataset_item_count: evaluation.item_count });
  const cand = await score(frozen.candidate);
  const candidateEvaluation = { status: "FINALIZED", metrics: scrub(cand.metrics), coverage: cand.coverage };
  report.metrics = candidateEvaluation.metrics;
  report.coverage = cand.coverage;
  const refCandidate = reference?.candidate || null;
  if (refCandidate && reference.candidate_id !== frozen.candidate_id) {
    const ref = await score(refCandidate);
    report.regression = compareMeasurements(candidateEvaluation.metrics, scrub(ref.metrics), PROMOTION_RULES.regression_tolerance);
  } else if (refCandidate) {
    report.regression = { verdict: "PASS", comparable_metrics: 0, note: "candidate configuration is identical to the known-good reference; no separate reference measurement" };
  }
  const verdict = promotionVerdict({ candidate_evaluation: candidateEvaluation, regression: report.regression, has_reference: !!refCandidate });
  report.promotion = verdict;
  report.would_promote = verdict.eligible;
  if (!verdict.eligible) return stop(verdict.code, verdict.reasons.join("; "));
  return report;
}