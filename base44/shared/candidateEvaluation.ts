// Deterministic candidate evaluation over a FINALIZED evaluation dataset (#39).
//
// Measures ONE candidate configuration — model, model version, routing policy, prompt policy, tool
// policy — against the fixed examples of a finalized evaluation dataset, and compares it with a
// reference measurement to detect quality regressions.
//
// Nothing here executes a model and nothing here invents a number. Every metric is READ from a
// record the platform already wrote:
//   • the sealed Trajectory (#18) for status, build, runtime, repair and tool-call evidence;
//   • the pinned Evaluation (#19) for the judged dimensions;
//   • AIOperation, through #38's own measurement module, for real provider cost, token usage,
//     context handling and structured-output evidence.
// A dataset item the candidate has no execution evidence for is recorded as `no_evidence` and
// EXCLUDED from every rate — never scored zero — so a partial measurement can never masquerade as
// a complete one. This module writes only its own CandidateEvaluation record; the dataset, the
// trajectories, the evaluations and the operations it reads are never modified.
import { scrub, scrubText } from "./tracing.ts";
import { loadAuthorizedProject } from "./authz.ts";
import { requirePlatformAdmin } from "./platformAdmin.ts";
import { hash, readFinalizedItems } from "./dataset.ts";
import { MODEL_REGISTRY } from "./modelGateway.ts";
import { providerAccounting, toolCallMetrics, structuredOutputMetrics } from "./benchmarkMetrics.ts";

export const CANDIDATE_EVAL_VERSION = "1.0.0";
export const CANDIDATE_METRICS = [
  "task_success_rate", "build_success_rate", "runtime_success_rate", "repair_success_rate",
  "tool_call_success_rate", "structured_output_valid_rate", "avg_latency_ms", "provider_cost_per_success",
];
// Metrics where a LOWER value is better; a rise beyond tolerance is the regression.
export const LOWER_IS_BETTER = ["avg_latency_ms", "provider_cost_per_success"];
export const DEFAULT_TOLERANCE = 0.05;
export const CANDIDATE_LIMITS = { items: 200, evaluations: 50 };

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const round = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);
const rate = (hits, total) => (total ? round(hits / total) : null);
const avg = (values) => { const v = values.filter((x) => x != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };

// --- candidate identity --------------------------------------------------------

/**
 * Freezes one candidate configuration. The provider is resolved from the model catalog, never taken
 * from the caller, so a candidate can never claim a provider it does not run on.
 */
export function resolveCandidate({ model_id, model_version = null, routing_policy_version = null, prompt_policy_version = null, tool_policy_version = null } = {}) {
  const entry = MODEL_REGISTRY.find((m) => m.model_id === model_id || m.id === model_id);
  if (!entry) fail(400, "UNKNOWN_MODEL", `Unknown model: ${model_id}`);
  const candidate = {
    model_id: entry.model_id, provider: entry.upstream_provider || entry.provider || null,
    gateway_provider: entry.provider || null,
    model_version: model_version ? String(model_version) : (entry.version ? String(entry.version) : "catalog"),
    routing_policy_version: routing_policy_version ? String(routing_policy_version) : null,
    prompt_policy_version: prompt_policy_version ? String(prompt_policy_version) : null,
    tool_policy_version: tool_policy_version ? String(tool_policy_version) : null,
    context_window: entry.contextWindow ?? null,
  };
  const config_checksum = hash(candidate, "cand");
  return { candidate, config_checksum, candidate_id: config_checksum };
}

export const evaluationKey = ({ dataset, candidate_id, config_checksum }) => hash({
  dataset_id: dataset.dataset_id || dataset.id, dataset_version: dataset.version, dataset_checksum: dataset.checksum,
  candidate_id, config_checksum, harness_version: CANDIDATE_EVAL_VERSION,
}, "ceval");

export const candidateChecksum = (row) => hash({
  evaluation_key: row.evaluation_key, dataset_checksum: row.dataset_checksum,
  config_checksum: row.config_checksum, metrics: row.metrics || {}, coverage: row.coverage || {},
}, "cchk");

export const publicCandidateEvaluation = (r) => ({
  candidate_evaluation_id: r.id, harness_version: r.harness_version, name: r.name || null,
  dataset_id: r.dataset_id, dataset_version: r.dataset_version ?? null, dataset_checksum: r.dataset_checksum || null,
  scope: r.scope || "project", project_id: r.project_id || null, workspace_id: r.workspace_id || null,
  candidate_id: r.candidate_id, candidate: r.candidate || {}, config_checksum: r.config_checksum || null,
  evaluation_key: r.evaluation_key, status: r.status, metrics: r.metrics || {}, coverage: r.coverage || {},
  item_results: r.item_results || [], regression: r.regression || null,
  reference_evaluation_id: r.reference_evaluation_id || null, checksum: r.checksum || null,
  finalized: !!r.finalized, error: r.error || null, trace_id: r.trace_id || null,
  created_by: r.created_by || null, created_at: r.created_at || r.created_date,
  scored_at: r.scored_at || null, finalized_at: r.finalized_at || null,
});

// --- authorization -------------------------------------------------------------

async function authorizeDatasetScope(base44, user, dataset, capability) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to evaluate candidates");
  if (dataset.scope === "platform") {
    await requirePlatformAdmin(base44, user);
    return { project: null, workspace: null };
  }
  return loadAuthorizedProject(base44, user, dataset.project_id, capability);
}

async function loadDatasetFor(base44, user, dataset_id, capability) {
  const svc = svcOf(base44);
  const dataset = dataset_id ? await svc.entities.Dataset.get(String(dataset_id)).catch(() => null) : null;
  if (!dataset) fail(404, "DATASET_NOT_FOUND", "Dataset not found");
  const auth = await authorizeDatasetScope(base44, user, dataset, capability);
  return { dataset, ...auth };
}

async function loadEvaluationFor(base44, user, id, capability) {
  const svc = svcOf(base44);
  const row = id ? await svc.entities.CandidateEvaluation.get(String(id)).catch(() => null) : null;
  if (!row) fail(404, "CANDIDATE_EVALUATION_NOT_FOUND", "Candidate evaluation not found");
  const { dataset } = await loadDatasetFor(base44, user, row.dataset_id, capability);
  return { row, dataset };
}

// --- creation ------------------------------------------------------------------

export async function createCandidateEvaluation(base44, user, { dataset_id, name = null, candidate = {} } = {}) {
  const { dataset, project, workspace } = await loadDatasetFor(base44, user, dataset_id, "project.write");
  if (dataset.dataset_type !== "evaluation") fail(400, "NOT_AN_EVALUATION_DATASET", "A candidate can only be measured against an evaluation dataset");
  if (dataset.status !== "FINALIZED" || !dataset.finalized) fail(409, "DATASET_NOT_FINALIZED", "Only a finalized dataset provides a fixed reference set");
  const { candidate: frozen, config_checksum, candidate_id } = resolveCandidate(candidate);
  const key = evaluationKey({ dataset: { dataset_id: dataset.id, version: dataset.version, checksum: dataset.checksum }, candidate_id, config_checksum });
  const svc = svcOf(base44);

  // Idempotency: the same dataset + candidate configuration is ONE measurement.
  const [existing] = await svc.entities.CandidateEvaluation.filter({ evaluation_key: key }, "created_at", 1).catch(() => []);
  if (existing) return { candidate_evaluation: publicCandidateEvaluation(existing), created: false, reason: "existing_measurement" };

  const row = await svc.entities.CandidateEvaluation.create({
    harness_version: CANDIDATE_EVAL_VERSION, name: name ? scrubText(String(name), 120) : `${frozen.model_id}@${frozen.model_version}`,
    dataset_id: dataset.id, dataset_version: dataset.version, dataset_checksum: dataset.checksum,
    scope: dataset.scope, project_id: project?.id || dataset.project_id || undefined, workspace_id: workspace?.id || dataset.workspace_id || undefined,
    candidate_id, candidate: frozen, config_checksum, evaluation_key: key,
    status: "DRAFT", metrics: {}, coverage: {}, item_results: [], finalized: false,
    created_by: user.id, created_at: nowIso(),
  });
  return { candidate_evaluation: publicCandidateEvaluation(row), created: true };
}

// --- deterministic scoring -----------------------------------------------------

/** Does this episode carry evidence for the candidate's configuration? Policy versions are only compared when the episode recorded one. */
function matchesCandidate(trajectory, candidate) {
  if (!trajectory) return { ok: false, detail: "source episode no longer resolves" };
  if (trajectory.model_id !== candidate.model_id) return { ok: false, detail: `episode ran on ${trajectory.model_id || "an unrecorded model"}` };
  const recorded = trajectory.routing_decision || {};
  if (candidate.routing_policy_version && recorded.policy_version && recorded.policy_version !== candidate.routing_policy_version) {
    return { ok: false, detail: `episode routed under policy ${recorded.policy_version}` };
  }
  return { ok: true, detail: `episode executed on ${candidate.model_id}` };
}

/** One item's measurement, read from authoritative records only. Unknown stays null. */
export async function measureItem(svc, { item, trajectory, candidate, workspace_id }) {
  const outcomes = trajectory.outcomes || {};
  const build_success = outcomes.build_status ? (outcomes.build_status === "success" ? 1 : 0) : null;
  const runtime_success = outcomes.runtime_ok == null ? null : (outcomes.runtime_ok ? 1 : 0);
  const expected = item.payload?.expected_outcome || {};
  const gates = [trajectory.status === "COMPLETED" ? 1 : 0];
  if (expected.build_status) gates.push(build_success);
  if (expected.runtime_verified != null) gates.push(runtime_success);
  const task_success = gates.some((g) => g === 0) ? 0 : gates.every((g) => g === 1) ? 1 : null;
  const repair_attempts = outcomes.repair_attempts ?? 0;
  const repair_success = repair_attempts > 0 ? (build_success === 1 ? 1 : 0) : null;
  const tools = toolCallMetrics(trajectory);
  const structured = await structuredOutputMetrics(svc, { trajectory });
  const run = trajectory.run_id ? await svc.entities.AIRun.get(trajectory.run_id).catch(() => null) : null;
  const accounting = await providerAccounting(svc, { run_id: trajectory.run_id, workspace_id });
  return {
    item_key: item.item_key, trajectory_id: trajectory.id, run_id: trajectory.run_id || null,
    status: "scored", task_success, build_success, runtime_success, repair_success,
    tool_call_success: tools.tool_call_success, tool_calls: tools.tool_calls,
    structured_output_valid: structured.structured_output_valid,
    latency_ms: trajectory.duration_ms ?? run?.duration_ms ?? null,
    provider_cost: accounting?.provider_cost ?? null,
    input_tokens: accounting?.input_tokens ?? null, output_tokens: accounting?.output_tokens ?? null,
    usage_source: accounting?.usage_source || null,
    evaluation_id: item.evaluation_id || null,
    detail: `measured from trajectory ${trajectory.id}${accounting ? ` and ${accounting.operations} operation record(s)` : " (no operation accounting recorded)"}`,
  };
}

export function aggregate(results) {
  const scored = results.filter((r) => r.status === "scored");
  const val = (f) => scored.map((r) => r[f]).filter((v) => v != null);
  const ones = (f) => val(f).filter((v) => v === 1).length;
  const successes = scored.filter((r) => r.task_success === 1);
  const withCost = scored.filter((r) => r.provider_cost != null);
  const totalCost = round(withCost.reduce((a, r) => a + r.provider_cost, 0));
  return {
    task_success_rate: rate(ones("task_success"), val("task_success").length),
    build_success_rate: rate(ones("build_success"), val("build_success").length),
    runtime_success_rate: rate(ones("runtime_success"), val("runtime_success").length),
    repair_success_rate: rate(ones("repair_success"), val("repair_success").length),
    tool_call_success_rate: avg(val("tool_call_success")),
    structured_output_valid_rate: rate(ones("structured_output_valid"), val("structured_output_valid").length),
    avg_latency_ms: avg(val("latency_ms")),
    // Real upstream cost only, normalized per SUCCESS. Null rather than a divide-by-zero fiction.
    provider_cost: withCost.length ? totalCost : null,
    provider_cost_per_success: withCost.length && successes.length ? round(totalCost / successes.length) : null,
    cost_coverage: rate(withCost.length, scored.length),
    usage_sources: [...new Set(scored.map((r) => r.usage_source).filter(Boolean))],
    measured_dimensions: CANDIDATE_METRICS.filter((m) => m !== "provider_cost_per_success").length,
  };
}

/**
 * Scores a candidate over the dataset's fixed items. Deterministic: the same records under the same
 * dataset checksum reproduce the same metrics and the same checksum. Safe to re-run while DRAFT.
 */
/** Scores a candidate over the given items. Reads only (Trajectory, TrajectoryEvent, AIRun, AIOperation). */
export async function scoreItems(svc, { items, candidate, workspace_id = null, dataset_item_count = null }) {
  const results = [];
  for (const item of items) {
    const trajectory = await svc.entities.Trajectory.get(item.trajectory_id).catch(() => null);
    const match = matchesCandidate(trajectory, candidate);
    if (!match.ok) {
      results.push({ item_key: item.item_key, trajectory_id: item.trajectory_id, run_id: item.source_run_id || null, status: "no_evidence", detail: scrubText(match.detail, 200) });
      continue;
    }
    results.push(await measureItem(svc, { item, trajectory, candidate, workspace_id }));
  }
  const scored = results.filter((r) => r.status === "scored");
  const coverage = {
    items_considered: results.length, items_scored: scored.length,
    items_without_evidence: results.length - scored.length,
    coverage_rate: rate(scored.length, results.length),
    dataset_item_count: dataset_item_count || items.length,
  };
  return { results, scored, coverage, metrics: aggregate(results) };
}

export async function scoreCandidateEvaluation(base44, user, { candidate_evaluation_id } = {}) {
  const { row, dataset } = await loadEvaluationFor(base44, user, candidate_evaluation_id, "project.write");
  if (row.finalized || row.status === "FINALIZED") fail(409, "CANDIDATE_EVALUATION_FINALIZED", "A finalized candidate evaluation is immutable — create a new one instead");
  const svc = svcOf(base44);
  if (dataset.checksum !== row.dataset_checksum) {
    const failed = await svc.entities.CandidateEvaluation.update(row.id, { status: "FAILED", error: "dataset checksum changed after this measurement was created" });
    fail(409, "DATASET_CHECKSUM_MISMATCH", `The dataset changed after this evaluation was created (${publicCandidateEvaluation(failed).status})`);
  }

  const items = (await readFinalizedItems(svc, dataset)).slice(0, CANDIDATE_LIMITS.items);
  const { results, scored, coverage, metrics } = await scoreItems(svc, { items, candidate: row.candidate || {}, workspace_id: row.workspace_id || null, dataset_item_count: dataset.item_count });
  const patch = {
    status: "SCORED", metrics: scrub(metrics), coverage,
    item_results: scrub(results.map((r) => ({ ...r, detail: scrubText(r.detail || "", 200) }))),
    scored_at: nowIso(), error: null,
    trace_id: scored[0]?.run_id ? (await svc.entities.AIRun.get(scored[0].run_id).catch(() => null))?.trace_id || undefined : undefined,
  };
  const saved = await svc.entities.CandidateEvaluation.update(row.id, patch);
  const finalRow = await svc.entities.CandidateEvaluation.update(row.id, { checksum: candidateChecksum(saved) });
  return { candidate_evaluation: publicCandidateEvaluation(finalRow), coverage, metrics, item_results: patch.item_results };
}

export async function finalizeCandidateEvaluation(base44, user, { candidate_evaluation_id } = {}) {
  const { row } = await loadEvaluationFor(base44, user, candidate_evaluation_id, "project.write");
  if (row.finalized) return { candidate_evaluation: publicCandidateEvaluation(row), already: true };
  if (row.status !== "SCORED") fail(409, "CANDIDATE_EVALUATION_NOT_SCORED", `Only a SCORED evaluation can be finalized (status ${row.status})`);
  const recomputed = candidateChecksum(row);
  if (row.checksum && row.checksum !== recomputed) fail(409, "CHECKSUM_MISMATCH", "The recorded metrics changed after scoring; finalization refused");
  const svc = svcOf(base44);
  const finalized = await svc.entities.CandidateEvaluation.update(row.id, { status: "FINALIZED", finalized: true, finalized_at: nowIso(), checksum: recomputed });
  return { candidate_evaluation: publicCandidateEvaluation(finalized), finalized: true };
}

// --- comparison and regression -------------------------------------------------

/** Ranks every measurement of ONE dataset. Only metrics both sides measured are compared. */
export async function compareCandidates(base44, user, { dataset_id } = {}) {
  const { dataset } = await loadDatasetFor(base44, user, dataset_id, "project.read");
  const svc = svcOf(base44);
  const rows = (await svc.entities.CandidateEvaluation.filter({ dataset_id: dataset.id }, "created_at", CANDIDATE_LIMITS.evaluations))
    .filter((r) => ["SCORED", "FINALIZED"].includes(r.status));
  const candidates = rows.map((r) => ({
    candidate_evaluation_id: r.id, candidate_id: r.candidate_id, name: r.name || null,
    model_id: r.candidate?.model_id || null, provider: r.candidate?.provider || null,
    metrics: r.metrics || {}, coverage: r.coverage || {}, checksum: r.checksum || null,
  }));
  const ranking = {};
  for (const metric of CANDIDATE_METRICS) {
    const measured = candidates.filter((c) => c.metrics[metric] != null);
    if (!measured.length) { ranking[metric] = { comparable: false, reason: "no candidate measured this dimension" }; continue; }
    const lower = LOWER_IS_BETTER.includes(metric);
    const ordered = [...measured].sort((a, b) => (lower ? a.metrics[metric] - b.metrics[metric] : b.metrics[metric] - a.metrics[metric]));
    ranking[metric] = {
      comparable: measured.length > 1, lower_is_better: lower,
      best: { candidate_id: ordered[0].candidate_id, value: ordered[0].metrics[metric] },
      order: ordered.map((c) => ({ candidate_id: c.candidate_id, value: c.metrics[metric] })),
    };
  }
  return { dataset_id: dataset.id, dataset_checksum: dataset.checksum || null, count: candidates.length, candidates, ranking };
}

/**
 * Regression check against a FIXED reference measurement on the same dataset. A metric only
 * participates when BOTH sides measured it; a candidate with no comparable metric returns
 * INSUFFICIENT_EVIDENCE rather than a pass.
 */
/** Pure metric comparison behind detectRegression: absolute for rates, relative for cost/latency. */
export function compareMeasurements(candidateMetrics, referenceMetrics, tolerance = DEFAULT_TOLERANCE) {
  const tol = Math.abs(Number(tolerance) || 0);
  const deltas = {};
  const regressed = [];
  const improved = [];
  for (const metric of CANDIDATE_METRICS) {
    const a = candidateMetrics?.[metric];
    const b = referenceMetrics?.[metric];
    if (a == null || b == null) { deltas[metric] = { comparable: false, candidate: a ?? null, reference: b ?? null }; continue; }
    const lower = LOWER_IS_BETTER.includes(metric);
    const delta = round(a - b);
    const worse = lower ? (b > 0 ? (a - b) / b > tol : a - b > tol) : b - a > tol;
    const better = lower ? (b > 0 ? (b - a) / b > tol : b - a > tol) : a - b > tol;
    deltas[metric] = { comparable: true, candidate: a, reference: b, delta, lower_is_better: lower, regressed: worse };
    if (worse) regressed.push(metric);
    if (better) improved.push(metric);
  }
  const comparable = Object.values(deltas).filter((d) => d.comparable).length;
  const verdict = comparable === 0 ? "INSUFFICIENT_EVIDENCE" : regressed.length ? "REGRESSION" : "PASS";
  return { verdict, tolerance: tol, comparable_metrics: comparable, regressed_metrics: regressed, improved_metrics: improved, deltas };
}

export async function detectRegression(base44, user, { candidate_evaluation_id, reference_evaluation_id, tolerance = DEFAULT_TOLERANCE } = {}) {
  const { row: candidateRow, dataset } = await loadEvaluationFor(base44, user, candidate_evaluation_id, "project.write");
  const svc = svcOf(base44);
  const referenceRow = await svc.entities.CandidateEvaluation.get(String(reference_evaluation_id || "")).catch(() => null);
  if (!referenceRow) fail(404, "REFERENCE_NOT_FOUND", "Reference evaluation not found");
  if (referenceRow.dataset_id !== dataset.id) fail(409, "REFERENCE_DATASET_MISMATCH", "A regression check requires both measurements on the same dataset");
  if (referenceRow.dataset_checksum !== candidateRow.dataset_checksum) fail(409, "REFERENCE_CHECKSUM_MISMATCH", "The reference was measured against a different dataset checksum");
  if (!["SCORED", "FINALIZED"].includes(candidateRow.status) || !["SCORED", "FINALIZED"].includes(referenceRow.status)) {
    fail(409, "MEASUREMENT_NOT_SCORED", "Both measurements must be scored before a regression check");
  }

  const regression = {
    ...compareMeasurements(candidateRow.metrics, referenceRow.metrics, tolerance),
    reference_evaluation_id: referenceRow.id, reference_candidate_id: referenceRow.candidate_id,
    dataset_id: dataset.id, dataset_checksum: dataset.checksum || null, checked_at: nowIso(),
  };
  // A finalized measurement is immutable: the verdict is returned but never written back onto it.
  if (!candidateRow.finalized) {
    await svc.entities.CandidateEvaluation.update(candidateRow.id, { regression: scrub(regression), reference_evaluation_id: referenceRow.id });
  }
  return { regression, candidate_evaluation_id: candidateRow.id, written: !candidateRow.finalized };
}

// --- reads ---------------------------------------------------------------------

export async function getCandidateEvaluation(base44, user, { candidate_evaluation_id } = {}) {
  const { row } = await loadEvaluationFor(base44, user, candidate_evaluation_id, "project.read");
  return { candidate_evaluation: publicCandidateEvaluation(row) };
}

export async function listCandidateEvaluations(base44, user, { dataset_id, limit = CANDIDATE_LIMITS.evaluations } = {}) {
  const { dataset } = await loadDatasetFor(base44, user, dataset_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.CandidateEvaluation.filter({ dataset_id: dataset.id }, "created_at", Math.min(limit, CANDIDATE_LIMITS.evaluations));
  return { dataset_id: dataset.id, count: rows.length, candidate_evaluations: rows.map(publicCandidateEvaluation) };
}

export const candidateEvaluationContract = () => ({
  harness_version: CANDIDATE_EVAL_VERSION,
  metrics: CANDIDATE_METRICS, lower_is_better: LOWER_IS_BETTER,
  default_tolerance: DEFAULT_TOLERANCE, limits: CANDIDATE_LIMITS,
});