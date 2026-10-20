// Routing evidence (#41): per-model performance READ from persisted measurement records.
//
// The self-improving router may learn from exactly two layers, both of which are already sealed,
// versioned and checksummed by the platform:
//   • BenchmarkResult (#38) — reproducible, isolated-fixture measurements. Only SCORED results
//     participate, so an infrastructure, fixture or authorization failure never becomes a model's
//     quality signal.
//   • CandidateEvaluation (#39) — SCORED/FINALIZED measurements of one candidate configuration
//     against a finalized evaluation dataset.
//
// What is deliberately NOT admissible: raw production telemetry (AIRun outcomes, UsageEvent rows,
// Trajectory records that were never evaluated). Production work becomes routing evidence only by
// passing through #38/#39 first, which is what stops a bad hour of traffic from rewriting routing.
//
// A dimension with no evidence is null. Nothing here defaults, averages toward a prior, or invents
// a number, and nothing here mutates a single record it reads.
const round = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);
const rate = (hits, total) => (total ? round(hits / total) : null);
const avg = (values) => { const v = values.filter((x) => x != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };

/** The ONLY admissible evidence sources. Anything else is refused by `assertEvidenceSources`. */
export const EVIDENCE_SOURCES = ["benchmark_result", "candidate_evaluation"];
export const EVIDENCE_LIMITS = { benchmark_results: 400, candidate_evaluations: 200 };

export function assertEvidenceSources(sources) {
  const list = Array.isArray(sources) && sources.length ? sources : EVIDENCE_SOURCES;
  const bad = list.filter((s) => !EVIDENCE_SOURCES.includes(s));
  if (bad.length) {
    throw Object.assign(new Error(`Routing may only learn from persisted benchmark or evaluation evidence; refused: ${bad.join(", ")}`), { status: 400, code: "INADMISSIBLE_EVIDENCE_SOURCE" });
  }
  return list;
}

const emptyDimension = () => ({ value: null, basis: null, samples: 0 });

/** Per-model aggregation of SCORED benchmark results. */
function fromBenchmarkResults(rows) {
  const byModel = new Map();
  for (const r of rows) {
    if (!r.model_id) continue;
    const bucket = byModel.get(r.model_id) || { executions: [], scored: [] };
    bucket.executions.push(r);
    if (r.scored !== false && ["COMPLETED", "FAILED"].includes(r.status)) bucket.scored.push(r);
    byModel.set(r.model_id, bucket);
  }
  const out = {};
  for (const [model_id, { executions, scored }] of byModel) {
    const ext = (r) => (r.metrics || {}).extended || {};
    const success = scored.filter((r) => (r.metrics || {}).task_success != null);
    const providerFailures = executions.filter((r) => ["model_provider_failure", "timeout"].includes(r.failure_class || "none"));
    const withCost = scored.filter((r) => (r.usage || {}).provider_cost != null);
    const successes = scored.filter((r) => (r.metrics || {}).task_success === 1);
    const totalCost = withCost.reduce((a, r) => a + Number(r.usage.provider_cost || 0), 0);
    out[model_id] = {
      source: "benchmark_result",
      quality: success.length ? { value: rate(successes.length, success.length), basis: "benchmark_result", samples: success.length } : emptyDimension(),
      reliability: executions.length ? { value: round(1 - providerFailures.length / executions.length), basis: "benchmark_result", samples: executions.length } : emptyDimension(),
      tool_call_success: (() => { const v = scored.map((r) => ext(r).tool_call_success).filter((x) => x != null); return v.length ? { value: avg(v), basis: "benchmark_result", samples: v.length } : emptyDimension(); })(),
      latency_ms: (() => { const v = scored.map((r) => (r.metrics || {}).latency_ms ?? r.latency_ms).filter((x) => x != null); return v.length ? { value: avg(v), basis: "benchmark_result", samples: v.length } : emptyDimension(); })(),
      provider_cost_per_success: withCost.length && successes.length ? { value: round(totalCost / successes.length), basis: "benchmark_result", samples: withCost.length } : emptyDimension(),
      structured_output_valid: (() => { const v = scored.map((r) => ext(r).structured_output_valid).filter((x) => x != null); return v.length ? { value: rate(v.filter((x) => x === 1).length, v.length), basis: "benchmark_result", samples: v.length } : emptyDimension(); })(),
      record_ids: scored.map((r) => r.id).slice(0, 50),
    };
  }
  return out;
}

/** Per-model aggregation of SCORED/FINALIZED candidate evaluations. */
function fromCandidateEvaluations(rows) {
  const byModel = new Map();
  for (const r of rows) {
    const model_id = r.candidate?.model_id;
    if (!model_id) continue;
    byModel.set(model_id, [...(byModel.get(model_id) || []), r]);
  }
  const out = {};
  for (const [model_id, evals] of byModel) {
    const m = (field) => { const v = evals.map((e) => (e.metrics || {})[field]).filter((x) => x != null); return v.length ? { value: avg(v), basis: "candidate_evaluation", samples: v.length } : emptyDimension(); };
    const scoredItems = evals.reduce((a, e) => a + ((e.coverage || {}).items_scored || 0), 0);
    out[model_id] = {
      source: "candidate_evaluation",
      quality: m("task_success_rate"),
      reliability: m("runtime_success_rate"),
      tool_call_success: m("tool_call_success_rate"),
      latency_ms: m("avg_latency_ms"),
      provider_cost_per_success: m("provider_cost_per_success"),
      structured_output_valid: m("structured_output_valid_rate"),
      items_scored: scoredItems,
      record_ids: evals.map((e) => e.id).slice(0, 50),
    };
  }
  return out;
}

const DIMENSIONS = ["quality", "reliability", "tool_call_success", "latency_ms", "provider_cost_per_success", "structured_output_valid"];

/**
 * Merges the two layers per model and per DIMENSION. A candidate evaluation is preferred where it
 * measured the dimension (it is dataset-pinned and checksum-bound); the benchmark supplies whatever
 * it did not. Where neither measured it, the dimension stays null with basis null.
 */
function mergeEvidence(benchmark, evaluation) {
  const out = {};
  for (const model_id of new Set([...Object.keys(benchmark), ...Object.keys(evaluation)])) {
    const b = benchmark[model_id] || {};
    const e = evaluation[model_id] || {};
    const merged = { model_id, sources: [] };
    for (const dim of DIMENSIONS) {
      const pick = (e[dim]?.value != null ? e[dim] : b[dim]?.value != null ? b[dim] : emptyDimension());
      merged[dim] = { ...pick };
      if (pick.basis && !merged.sources.includes(pick.basis)) merged.sources.push(pick.basis);
    }
    merged.record_ids = [...(e.record_ids || []), ...(b.record_ids || [])].slice(0, 60);
    merged.measured_dimensions = DIMENSIONS.filter((d) => merged[d].value != null).length;
    out[model_id] = merged;
  }
  return out;
}

/**
 * Gathers routing evidence for ONE scope.
 *
 * ISOLATION: a project scope reads only that project's own evaluations and its workspace's own
 * benchmark results, so one project's measurements can never shape another project's routing. A
 * platform scope reads only platform-scoped evaluations and the benchmark results explicitly
 * available to it.
 */
export async function gatherRoutingEvidence(svc, { scope = "platform", project_id = null, workspace_id = null, sources = null } = {}) {
  const admissible = assertEvidenceSources(sources);
  const wantBenchmark = admissible.includes("benchmark_result");
  const wantEvaluation = admissible.includes("candidate_evaluation");

  const [benchmarkRows, evaluationRows] = await Promise.all([
    wantBenchmark
      ? (scope === "project" && workspace_id
          ? svc.entities.BenchmarkResult.filter({ workspace_id }, "-created_date", EVIDENCE_LIMITS.benchmark_results)
          : svc.entities.BenchmarkResult.list("-created_date", EVIDENCE_LIMITS.benchmark_results)).catch(() => [])
      : Promise.resolve([]),
    wantEvaluation
      ? (scope === "project" && project_id
          ? svc.entities.CandidateEvaluation.filter({ project_id }, "-created_date", EVIDENCE_LIMITS.candidate_evaluations)
          : svc.entities.CandidateEvaluation.filter({ scope: "platform" }, "-created_date", EVIDENCE_LIMITS.candidate_evaluations)).catch(() => [])
      : Promise.resolve([]),
  ]);

  const evaluations = evaluationRows.filter((e) => ["SCORED", "FINALIZED"].includes(e.status));
  const benchmark = fromBenchmarkResults(benchmarkRows);
  const evaluation = fromCandidateEvaluations(evaluations);
  const models = mergeEvidence(benchmark, evaluation);

  return {
    scope, project_id: project_id || null, workspace_id: workspace_id || null,
    sources: admissible, models,
    snapshot: {
      benchmark_results: benchmarkRows.length,
      scored_benchmark_results: benchmarkRows.filter((r) => r.scored !== false && ["COMPLETED", "FAILED"].includes(r.status)).length,
      candidate_evaluations: evaluations.length,
      models_covered: Object.keys(models).sort(),
      models_with_quality_evidence: Object.keys(models).filter((k) => models[k].quality.value != null).sort(),
      gathered_at: new Date().toISOString(),
    },
  };
}

export { DIMENSIONS as EVIDENCE_DIMENSIONS };