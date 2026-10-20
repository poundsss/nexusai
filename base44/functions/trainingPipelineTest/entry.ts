// Focused certification for the #39 training / evaluation pipeline additions.
//
// Runs against the REAL dataset builder, the REAL provenance classifier and the REAL candidate
// evaluation module, over REAL Trajectory / Evaluation / BenchmarkResult / SyntheticTask records.
// Nothing is stubbed. The suite proves that test and synthetic evidence cannot enter a learning
// dataset, that provenance and checksums survive, that candidate scoring is deterministic and
// evidence-bound, and that a regression against a fixed reference is detected.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { createDataset, buildDataset, exportDataset } from "../../shared/dataset.ts";
import { createDatasetEpisode, buildDatasetToFinal } from "../../shared/datasetTestFixtures.ts";
import { classifyDataOrigin } from "../../shared/trainingData.ts";
import {
  createCandidateEvaluation, scoreCandidateEvaluation, finalizeCandidateEvaluation,
  getCandidateEvaluation, compareCandidates, detectRegression, resolveCandidate, CANDIDATE_EVAL_VERSION,
} from "../../shared/candidateEvaluation.ts";
import { MODEL_REGISTRY } from "../../shared/modelGateway.ts";

const SECRET = "sk_live_pipeline_must_never_leak_9f4a";
const TOKEN = "ghp_pipelinecertdummytoken00000000000";
const nowIso = () => new Date().toISOString();

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  const stranger = { id: "tp_stranger_user", email: "stranger@example.com" };
  const created = { workspaces: [], projects: [], datasets: [], benchmarkResults: [], syntheticTasks: [] };
  let caller = null;

  // One authentic episode, built by the shared certification fixture module.
  const episode = ({ project, prompt, model_id, status = "COMPLETED", buildStatus = "success", runtimeOk = true, duration_ms = 40000, toolOk = true, scores = { task_completion: 0.9, build: 1, runtime: 1 }, context = {} }) =>
    createDatasetEpisode(svc, {
      project, prompt, model_id, status, buildStatus, runtimeOk, duration_ms, toolOk, scores, context,
      pollution: { api_key: SECRET }, toolSummary: `wrote with token ${TOKEN}`,
    });

  const buildToFinal = (payload) => buildDatasetToFinal(base44, caller, payload, created.datasets);

  try {
    caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated platform admin" }, { status: 401 });

    const models = MODEL_REGISTRY.filter((m) => m.enabled);
    const modelA = models[0];
    const modelB = models.find((m) => m.model_id !== modelA.model_id) || modelA;

    const ws = await svc.entities.Workspace.create({ name: `tp-cert-${Date.now()}`, owner_id: caller.id, credits_balance: 50 });
    created.workspaces.push(ws.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `tp-foreign-${Date.now()}`, owner_id: "tp_other_owner", credits_balance: 0 });
    created.workspaces.push(foreignWs.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: "pipeline-project", status: "ready", version_count: 3 });
    const benchProj = await svc.entities.Project.create({ workspace_id: ws.id, name: "pipeline-benchmark-scratch", status: "ready", version_count: 1 });
    const synthProj = await svc.entities.Project.create({ workspace_id: ws.id, name: "pipeline-synthetic", status: "ready", version_count: 1 });
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "pipeline-foreign", status: "ready", version_count: 1 });
    created.projects.push(proj.id, benchProj.id, synthProj.id, foreignProj.id);

    // Authoritative test-provenance records: a benchmark scratch project and a synthetic fixture project.
    const bRes = await svc.entities.BenchmarkResult.create({
      benchmark_id: `bm_tp_${Date.now()}`, workspace_id: ws.id, benchmark_version: 1,
      task_id: `bt_tp_${Date.now()}`, task_key: "tp-task", task_version: 1,
      candidate_id: "cand_tp", candidate_name: "tp", model_id: modelA.model_id, provider: modelA.upstream_provider,
      execution_path: "run", run_key: `brun_tp_${Date.now()}`, status: "COMPLETED", benchmark_project_id: benchProj.id,
    });
    created.benchmarkResults.push(bRes.id);
    const sTask = await svc.entities.SyntheticTask.create({
      task_key: "tp-synth", task_version: 1, template_id: "tpl_tp", template_key: "tp", template_version: 1,
      generator_version: "1.0.0", seed: "seed_tp", fingerprint: `fp_tp_${Date.now()}`, status: "FINALIZED",
      project_id: synthProj.id, workspace_id: ws.id, created_at: nowIso(),
    });
    created.syntheticTasks.push(sTask.id);

    // Production evidence: strong episodes on model A, weaker episodes on model B.
    const a1 = await episode({ project: proj, prompt: `Add a notes page keyed with ${SECRET}`, model_id: modelA.model_id });
    const a2 = await episode({ project: proj, prompt: "Add a weather widget", model_id: modelA.model_id, duration_ms: 38000 });
    const b1 = await episode({ project: proj, prompt: "Add a tasks page", model_id: modelB.model_id, runtimeOk: false, duration_ms: 96000, toolOk: false, scores: { task_completion: 0.7, build: 1, runtime: 0.6 } });
    const b2 = await episode({ project: proj, prompt: "Add a reports page", model_id: modelB.model_id, runtimeOk: false, duration_ms: 92000, toolOk: false, scores: { task_completion: 0.7, build: 1, runtime: 0.6 } });
    // Test-marked production-project episode + episodes inside the harness projects.
    const marked = await episode({ project: proj, prompt: "TEST_ONLY fixture episode", model_id: modelA.model_id, context: { test_only: true } });
    const benchEpisode = await episode({ project: benchProj, prompt: "Benchmark scratch episode", model_id: modelA.model_id });
    const synthEpisode = await episode({ project: synthProj, prompt: "Synthetic fixture episode", model_id: modelA.model_id });

    // ---------- 1-3 · test/synthetic data cannot enter a learning dataset ----------
    const origins = {
      production: await classifyDataOrigin(svc, a1.traj),
      marked: await classifyDataOrigin(svc, marked.traj),
      benchmark: await classifyDataOrigin(svc, benchEpisode.traj),
      synthetic: await classifyDataOrigin(svc, synthEpisode.traj),
    };
    h.check("1 provenance is classified from authoritative records",
      origins.production.origin === "production" && origins.production.test_only === false &&
      origins.marked.origin === "certification_fixture" && origins.marked.test_only === true &&
      origins.benchmark.origin === "benchmark_harness" && origins.benchmark.test_only === true &&
      origins.synthetic.origin === "synthetic" && origins.synthetic.test_only === true,
      `production / certification_fixture / benchmark_harness / synthetic all distinguished`);

    const evalDs = await buildToFinal({ name: "Pipeline Eval Set", dataset_type: "evaluation", scope: "project", project_id: proj.id });
    const evalItems = (await exportDataset(base44, caller, { dataset_id: evalDs.dataset_id })).items;
    const exclusionReasons = evalDs.built.exclusions.map((x) => x.reason);
    h.check("2 TEST_ONLY episodes are excluded from a learning dataset",
      evalItems.length === 4 && !evalItems.some((i) => i.trajectory_id === marked.traj.id) &&
      exclusionReasons.includes("test_only_source"),
      `${evalItems.length} production item(s); test-marked episode excluded as ${exclusionReasons.filter((r) => r === "test_only_source").length} test_only_source`);

    const benchDs = await createDataset(base44, caller, { name: "Pipeline Benchmark Source", dataset_type: "evaluation", scope: "project", project_id: benchProj.id });
    created.datasets.push(benchDs.dataset.dataset_id);
    const benchBuild = await buildDataset(base44, caller, { dataset_id: benchDs.dataset.dataset_id });
    const synthDs = await createDataset(base44, caller, { name: "Pipeline Synthetic Source", dataset_type: "evaluation", scope: "project", project_id: synthProj.id });
    created.datasets.push(synthDs.dataset.dataset_id);
    const synthBuild = await buildDataset(base44, caller, { dataset_id: synthDs.dataset.dataset_id });
    h.check("3 benchmark and synthetic projects yield no learning items",
      benchBuild.item_count === 0 && synthBuild.item_count === 0 &&
      benchBuild.exclusions.every((x) => x.reason === "test_only_source") &&
      synthBuild.exclusions.every((x) => x.reason === "test_only_source"),
      `benchmark → ${benchBuild.item_count} items, synthetic → ${synthBuild.item_count} items`);

    // ---------- 4 · provenance preserved ----------
    const item1 = evalItems.find((i) => i.trajectory_id === a1.traj.id);
    h.check("4 provenance is preserved on every item",
      !!item1 && item1.source_run_id === a1.run.id && item1.source_trace_id === a1.traj.trace_id &&
      item1.evaluation_id === a1.evaluation.id && item1.evaluator_version === "1.0.0" &&
      item1.source_version_id === `v_${a1.run.id}` && item1.source_version_number === 3 &&
      item1.project_id === proj.id && item1.workspace_id === ws.id &&
      item1.lineage.data_origin === "production" && !!item1.lineage.data_origin_policy_version &&
      evalItems.every((i) => i.lineage.data_origin === "production"),
      `run ${item1?.source_run_id} → version ${item1?.source_version_number}, origin ${item1?.lineage.data_origin}`);

    // ---------- 5 · candidate creation and catalog-resolved identity ----------
    const resolved = resolveCandidate({ model_id: modelA.model_id });
    await h.expectThrow("5 unknown candidate model refused", () => createCandidateEvaluation(base44, caller, { dataset_id: evalDs.dataset_id, candidate: { model_id: "no_such_model_zzz" } }), "UNKNOWN_MODEL");
    const candA = (await createCandidateEvaluation(base44, caller, { dataset_id: evalDs.dataset_id, name: "reference", candidate: { model_id: modelA.model_id, model_version: "1", routing_policy_version: "1.0.0" } })).candidate_evaluation;
    const candB = (await createCandidateEvaluation(base44, caller, { dataset_id: evalDs.dataset_id, name: "challenger", candidate: { model_id: modelB.model_id, model_version: "1", routing_policy_version: "1.0.0" } })).candidate_evaluation;
    h.check("5b candidate identity is catalog-resolved and dataset-bound",
      candA.candidate.provider === modelA.upstream_provider && candA.candidate.model_id === modelA.model_id &&
      resolved.candidate_id === resolveCandidate({ model_id: modelA.model_id }).candidate_id &&
      candA.dataset_checksum === evalDs.final.dataset.checksum && candA.dataset_version === evalDs.final.dataset.version &&
      candA.harness_version === CANDIDATE_EVAL_VERSION && candA.candidate_id !== candB.candidate_id && candA.status === "DRAFT",
      `dataset checksum ${candA.dataset_checksum} pinned on both candidates`);

    // ---------- 6 · deterministic scoring, no fabricated metrics ----------
    const scoreA1 = await scoreCandidateEvaluation(base44, caller, { candidate_evaluation_id: candA.candidate_evaluation_id });
    const scoreA2 = await scoreCandidateEvaluation(base44, caller, { candidate_evaluation_id: candA.candidate_evaluation_id });
    const scoreB = await scoreCandidateEvaluation(base44, caller, { candidate_evaluation_id: candB.candidate_evaluation_id });
    h.check("6 candidate scoring is deterministic",
      JSON.stringify(scoreA1.metrics) === JSON.stringify(scoreA2.metrics) &&
      scoreA1.candidate_evaluation.checksum === scoreA2.candidate_evaluation.checksum &&
      JSON.stringify(scoreA1.coverage) === JSON.stringify(scoreA2.coverage),
      `re-scoring reproduced checksum ${scoreA1.candidate_evaluation.checksum}`);
    h.check("6b metrics are measured from authoritative records only",
      scoreA1.metrics.task_success_rate === 1 && scoreA1.metrics.runtime_success_rate === 1 && scoreA1.metrics.tool_call_success_rate === 1 &&
      scoreA1.metrics.avg_latency_ms === 39000 &&
      scoreB.metrics.task_success_rate === 0 && scoreB.metrics.runtime_success_rate === 0 && scoreB.metrics.tool_call_success_rate === 0.5 &&
      scoreB.metrics.avg_latency_ms === 94000,
      `A: success ${scoreA1.metrics.task_success_rate}, latency ${scoreA1.metrics.avg_latency_ms}ms · B: success ${scoreB.metrics.task_success_rate}, latency ${scoreB.metrics.avg_latency_ms}ms`);
    h.check("6c unmeasurable dimensions stay null, never zero",
      scoreA1.metrics.provider_cost === null && scoreA1.metrics.provider_cost_per_success === null &&
      scoreA1.metrics.cost_coverage === 0 && scoreA1.metrics.structured_output_valid_rate === null &&
      scoreA1.metrics.repair_success_rate === null,
      "cost, structured-output and repair evidence absent → reported absent");
    h.check("6d items without candidate evidence are excluded, not scored",
      scoreA1.coverage.items_considered === 4 && scoreA1.coverage.items_scored === 2 && scoreA1.coverage.items_without_evidence === 2 &&
      scoreA1.coverage.coverage_rate === 0.5 &&
      scoreA1.item_results.filter((r) => r.status === "no_evidence").every((r) => r.task_success === undefined),
      `${scoreA1.coverage.items_scored}/${scoreA1.coverage.items_considered} items had evidence for this candidate`);

    // ---------- 7 · candidate comparison ----------
    const comparison = await compareCandidates(base44, caller, { dataset_id: evalDs.dataset_id });
    h.check("7 candidates are comparable on the same dataset",
      comparison.count === 2 && comparison.dataset_checksum === candA.dataset_checksum &&
      comparison.ranking.task_success_rate.best.candidate_id === candA.candidate_id &&
      comparison.ranking.avg_latency_ms.best.candidate_id === candA.candidate_id &&
      comparison.ranking.avg_latency_ms.lower_is_better === true &&
      comparison.ranking.provider_cost_per_success.comparable === false,
      `best on success and latency: ${comparison.ranking.task_success_rate.best.candidate_id}`);

    // ---------- 8 · regression detection ----------
    const reg = await detectRegression(base44, caller, { candidate_evaluation_id: candB.candidate_evaluation_id, reference_evaluation_id: candA.candidate_evaluation_id });
    const noReg = await detectRegression(base44, caller, { candidate_evaluation_id: candA.candidate_evaluation_id, reference_evaluation_id: candA.candidate_evaluation_id });
    h.check("8 regression against a fixed reference is detected",
      reg.regression.verdict === "REGRESSION" && reg.regression.regressed_metrics.includes("task_success_rate") &&
      reg.regression.regressed_metrics.includes("avg_latency_ms") && reg.regression.deltas.task_success_rate.delta === -1 &&
      reg.regression.reference_evaluation_id === candA.candidate_evaluation_id,
      `verdict ${reg.regression.verdict}: ${reg.regression.regressed_metrics.join(", ")}`);
    h.check("8b an unchanged candidate does not report a regression",
      noReg.regression.verdict === "PASS" && noReg.regression.regressed_metrics.length === 0 && noReg.regression.comparable_metrics >= 4,
      `verdict ${noReg.regression.verdict} over ${noReg.regression.comparable_metrics} comparable metric(s)`);
    const freshCand = (await createCandidateEvaluation(base44, caller, { dataset_id: evalDs.dataset_id, name: "unscored", candidate: { model_id: modelA.model_id, model_version: "2" } })).candidate_evaluation;
    await h.expectThrow("8c an unscored measurement cannot be compared",
      () => detectRegression(base44, caller, { candidate_evaluation_id: freshCand.candidate_evaluation_id, reference_evaluation_id: candA.candidate_evaluation_id }), "MEASUREMENT_NOT_SCORED");

    // ---------- 9 · dataset checksum binding and immutability ----------
    const finalA = await finalizeCandidateEvaluation(base44, caller, { candidate_evaluation_id: candA.candidate_evaluation_id });
    await h.expectThrow("9 a finalized measurement is immutable",
      () => scoreCandidateEvaluation(base44, caller, { candidate_evaluation_id: candA.candidate_evaluation_id }), "CANDIDATE_EVALUATION_FINALIZED");
    await svc.entities.Dataset.update(evalDs.dataset_id, { checksum: "chk_tampered" });
    await h.expectThrow("9b a changed dataset checksum invalidates a measurement",
      () => scoreCandidateEvaluation(base44, caller, { candidate_evaluation_id: candB.candidate_evaluation_id }), "DATASET_CHECKSUM_MISMATCH");
    await svc.entities.Dataset.update(evalDs.dataset_id, { checksum: candA.dataset_checksum });
    h.check("9c finalized metrics and dataset lineage are preserved",
      finalA.candidate_evaluation.status === "FINALIZED" && finalA.candidate_evaluation.finalized === true &&
      finalA.candidate_evaluation.checksum === scoreA1.candidate_evaluation.checksum &&
      (await getCandidateEvaluation(base44, caller, { candidate_evaluation_id: candA.candidate_evaluation_id })).candidate_evaluation.dataset_checksum === candA.dataset_checksum,
      `FINALIZED with checksum ${finalA.candidate_evaluation.checksum}`);

    // ---------- 10 · secret redaction ----------
    const serialized = JSON.stringify([evalItems, scoreA1, scoreB, comparison, reg]);
    h.check("10 secrets and tokens are redacted throughout the pipeline",
      !serialized.includes(SECRET) && !serialized.includes(TOKEN) && serialized.includes("[REDACTED]"),
      "no credential value present in dataset items, measurements, comparisons or regression reports");

    // ---------- 11 · authorization ----------
    await h.expectThrow("11 unauthorized candidate creation rejected",
      () => createCandidateEvaluation(base44, stranger, { dataset_id: evalDs.dataset_id, candidate: { model_id: modelA.model_id } }), "NOT_A_MEMBER");
    await h.expectThrow("11b unauthorized measurement read rejected",
      () => getCandidateEvaluation(base44, stranger, { candidate_evaluation_id: candA.candidate_evaluation_id }), "NOT_A_MEMBER");
    await h.expectThrow("11c anonymous access rejected",
      () => compareCandidates(base44, null, { dataset_id: evalDs.dataset_id }), "AUTH_REQUIRED");
    await h.expectThrow("11d cross-project dataset rejected",
      () => createDataset(base44, caller, { name: "Pipeline Foreign", dataset_type: "evaluation", scope: "project", project_id: foreignProj.id }), "NOT_A_MEMBER");
    await h.expectThrow("11e an unfinalized dataset cannot be measured",
      () => createCandidateEvaluation(base44, caller, { dataset_id: benchDs.dataset.dataset_id, candidate: { model_id: modelA.model_id } }), "DATASET_NOT_FINALIZED");

    // ---------- 12 · source layers untouched ----------
    const trajAfter = await svc.entities.Trajectory.get(a1.traj.id);
    const evalAfter = await svc.entities.Evaluation.get(a1.evaluation.id);
    h.check("12 authoritative source records are never written back",
      trajAfter.revision === 1 && trajAfter.sealed === true && trajAfter.user_outcome === "accepted" &&
      evalAfter.revision === 1 && evalAfter.inputs_hash === a1.evaluation.inputs_hash &&
      (await svc.entities.Evaluation.filter({ trajectory_id: a1.traj.id }, "revision", 10)).length === 1,
      "trajectory and evaluation unchanged by dataset construction or candidate measurement");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const id of created.datasets) {
      await purgeBy(svc, "CandidateEvaluation", { dataset_id: id });
      await purgeBy(svc, "DatasetItem", { dataset_id: id });
      await svc.entities.Dataset.delete(id).catch(() => {});
    }
    for (const id of created.benchmarkResults) await svc.entities.BenchmarkResult.delete(id).catch(() => {});
    for (const id of created.syntheticTasks) await svc.entities.SyntheticTask.delete(id).catch(() => {});
    for (const pid of created.projects) {
      for (const name of ["Evaluation", "TrajectoryEvent", "Trajectory", "AIRun", "TraceEvent", "AuditLog"]) await purgeBy(svc, name, { project_id: pid });
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) await cleanupWorkspace(svc, wid, ["AuditLog"]);
  }
}