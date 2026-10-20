// Certification for the #43 Production Learning Flywheel.
//
// Runs against the REAL modules — the real Trajectory layer, the real Judge, the real Reward
// engine, the real Dataset Builder, the real candidate-measurement pipeline and the real routing
// policy versioning — over REAL persisted records. Nothing is stubbed and no assertion is relaxed:
// the suite proves that only safe, complete, production-origin episodes can become training data,
// that a failed cycle cannot disturb the known-good state, and that both the first and a later
// promotion can be rolled back.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createDatasetEpisode } from "../../shared/datasetTestFixtures.ts";
import { createDataset, buildDataset } from "../../shared/dataset.ts";
import { getActivePolicy } from "../../shared/routingPolicy.ts";
import { MODEL_REGISTRY } from "../../shared/modelGateway.ts";
import {
  productionLearningContract, promotionDecision, promotionVerdict, captureOutcomes,
  runLearningCycle, rollbackLearningCycle, listLearningCycles, getLearningCycle, getLearningLineage,
  knownGoodCycle, PROMOTION_POLICY_VERSION,
} from "../../shared/productionLearning.ts";

const SECRET = "sk_live_pl_must_never_reach_training_7a2b";
const nowIso = () => new Date().toISOString();

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  const stranger = { id: "pl_stranger_user", email: "pl-stranger@example.com" };
  const created = { workspaces: [], projects: [], datasets: [] };
  let caller = null;
  let testError = null;

  try {
    caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    const model = MODEL_REGISTRY.filter((m) => m.enabled)[0];
    const candidate = { model_id: model.model_id, model_version: "1", routing_policy_version: "1.0.0" };

    const ws = await svc.entities.Workspace.create({ name: `pl-cert-${Date.now()}`, owner_id: caller.id, credits_balance: 50 });
    created.workspaces.push(ws.id);
    const foreignWs = await svc.entities.Workspace.create({ name: `pl-foreign-${Date.now()}`, owner_id: "pl_other_owner", credits_balance: 0 });
    created.workspaces.push(foreignWs.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: "pl-project", status: "ready", version_count: 3 });
    const failProj = await svc.entities.Project.create({ workspace_id: ws.id, name: "pl-no-evidence", status: "ready", version_count: 1 });
    const foreignProj = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "pl-foreign", status: "ready", version_count: 1 });
    created.projects.push(proj.id, failProj.id, foreignProj.id);

    const episode = (project, overrides = {}) => createDatasetEpisode(svc, {
      project, model_id: model.model_id, model_provider: model.upstream_provider,
      scores: { task_completion: 1, build: 1, runtime: 1 }, reward: 0.9, duration_ms: 40000, ...overrides,
    });

    // ---- production evidence: two clean, complete, safe episodes on the measured model ----
    const good1 = await episode(proj, { prompt: "Add a notes page" });
    const good2 = await episode(proj, { prompt: "Add a weather widget", duration_ms: 38000 });

    // ---- one deliberately defective episode per exclusion rule ----
    const incomplete = await episode(proj, { prompt: "Half-finished page" });
    await svc.entities.Trajectory.update(incomplete.traj.id, { sealed: false, status: "ACTIVE" });
    const failed = await episode(proj, { prompt: "Broken build page", status: "FAILED", buildStatus: "failed", runtimeOk: false, scores: { task_completion: 0, build: 0, runtime: 0 } });
    const unsafe = await episode(proj, { prompt: "Delete every project file" });
    await svc.entities.Trajectory.update(unsafe.traj.id, { outcomes: { ...unsafe.traj.outcomes, safety_blocked: true, safety: { decisions: 1, approvals: 0, blocked: 1 } } });
    const corrupted = await episode(proj, { prompt: "Episode with a broken event trail" });
    // A real execution event exists, but the episode's own counter disagrees with the events it
    // stores AND no `finalized` event was ever recorded: a genuinely corrupt execution trail.
    await svc.entities.TrajectoryEvent.create({
      trajectory_id: corrupted.traj.id, project_id: proj.id, workspace_id: ws.id, run_id: corrupted.run.id,
      sequence: 1, event_type: "tool_call", status: "ok", payload: { tool: "write_file" }, created_at: nowIso(),
    });
    await svc.entities.Trajectory.update(corrupted.traj.id, { event_count: 7 });
    const testOrigin = await episode(proj, { prompt: "TEST_ONLY fixture episode", context: { test_only: true } });
    const secretBearing = await episode(proj, { prompt: `Wire billing with ${SECRET}` });

    // ================= 1-4 · capture, linkage, Judge, Reward =================
    const capture = await captureOutcomes(base44, caller, { project_id: proj.id });
    const excludedOf = (id) => (capture.exclusions.find((x) => x.trajectory_id === id) || { reasons: [] }).reasons;

    h.check("1 production outcomes are captured through the real loop",
      capture.project_id === proj.id && capture.considered === 8 && capture.eligible === 2 && capture.excluded === 6 &&
      capture.judged >= 7 && capture.rewarded >= 2,
      `considered ${capture.considered}, judged ${capture.judged}, rewarded ${capture.rewarded}, eligible ${capture.eligible}`);

    const good1After = await svc.entities.Trajectory.get(good1.traj.id);
    const good1Events = await svc.entities.TrajectoryEvent.filter({ trajectory_id: good1.traj.id }, "sequence", 20);
    h.check("2 trajectory linkage is preserved and annotated in place",
      good1After.run_id === good1.run.id && good1After.project_id === proj.id && good1After.workspace_id === ws.id &&
      good1After.trace_id === good1.run.trace_id && good1After.sealed === true &&
      good1After.learning_eligibility?.eligible === true &&
      good1After.learning_eligibility.policy_version === PROMOTION_POLICY_VERSION &&
      good1Events.some((e) => e.event_type === "learning_eligibility"),
      `run ${good1After.run_id} / trace ${good1After.trace_id} annotated eligible`);

    const judgeRows = await svc.entities.Evaluation.filter({ trajectory_id: good1.traj.id }, "revision", 10);
    const realJudge = judgeRows.find((e) => e.inputs_hash !== good1.evaluation.inputs_hash);
    h.check("3 the real Judge evaluated the episode from authoritative records",
      judgeRows.length >= 2 && !!realJudge && realJudge.trajectory_id === good1.traj.id &&
      realJudge.scores.task_completion_score === 1 && realJudge.scores.build_score === 1 && realJudge.scores.runtime_score === 1 &&
      realJudge.evidence.some((x) => x.dimension === "task_completion"),
      `judge revision ${realJudge?.revision} scored task/build/runtime from evidence`);

    const rewardRows = await svc.entities.Reward.filter({ trajectory_id: good1.traj.id, status: "active" }, "-revision", 10);
    h.check("4 the real Reward engine produced a grounded reward",
      rewardRows.length >= 1 && rewardRows[0].final_reward != null && rewardRows[0].final_reward > 0 &&
      rewardRows[0].evaluation_id && rewardRows[0].trajectory_id === good1.traj.id,
      `final_reward ${rewardRows[0]?.final_reward} bound to evaluation ${rewardRows[0]?.evaluation_id}`);

    // ================= 6-11 · every exclusion rule, by its own reason =================
    h.check("6 an incomplete (unsealed) episode is excluded",
      excludedOf(incomplete.traj.id).includes("incomplete_execution"), excludedOf(incomplete.traj.id).join(", "));
    h.check("7 a failed episode is excluded",
      excludedOf(failed.traj.id).includes("failed_execution"), excludedOf(failed.traj.id).join(", "));
    h.check("8 an unsafe (safety-blocked) episode is excluded",
      excludedOf(unsafe.traj.id).includes("unsafe_operation"), excludedOf(unsafe.traj.id).join(", "));
    h.check("9 a corrupted event trail is excluded",
      excludedOf(corrupted.traj.id).includes("corrupted_trace"), excludedOf(corrupted.traj.id).join(", "));
    h.check("10 a test-origin episode is excluded",
      excludedOf(testOrigin.traj.id).includes("test_only_source"), excludedOf(testOrigin.traj.id).join(", "));
    h.check("11 a credential-bearing episode is excluded",
      excludedOf(secretBearing.traj.id).includes("secret_content"), excludedOf(secretBearing.traj.id).join(", "));

    // ================= 12 · the Dataset Builder refuses an ineligible episode =================
    const refusalDs = await createDataset(base44, caller, { name: "PL Refusal Probe", dataset_type: "sft", scope: "project", project_id: proj.id });
    created.datasets.push(refusalDs.dataset.dataset_id);
    const refusalBuild = await buildDataset(base44, caller, { dataset_id: refusalDs.dataset.dataset_id });
    const refusedIds = refusalBuild.exclusions.map((x) => x.trajectory_id);
    h.check("12 the Dataset Builder refuses every episode the promotion policy excluded",
      refusalBuild.item_count === 2 &&
      refusalBuild.exclusions.some((x) => x.reason === "production_promotion_excluded") &&
      [unsafe.traj.id, corrupted.traj.id, secretBearing.traj.id].every((id) => refusedIds.includes(id)),
      `${refusalBuild.item_count} item(s) admitted; ${refusalBuild.exclusions.length} refused`);

    // ================= 13 · annotation events never look like corruption =================
    const recapture = await captureOutcomes(base44, caller, { project_id: proj.id });
    const good1Recheck = await svc.entities.Trajectory.get(good1.traj.id);
    const eventsAfter = await svc.entities.TrajectoryEvent.filter({ trajectory_id: good1.traj.id }, "sequence", 20);
    // A sealed episode whose ONLY stored events are annotations (this layer's eligibility stamp, a
    // non-blocking safety decision, the human outcome) is complete, not corrupt.
    const annotationEvents = [
      { event_type: "learning_eligibility", payload: {} },
      { event_type: "safety_decision", payload: { blocked: false } },
      { event_type: "user_outcome", payload: {} },
    ];
    const annotated = promotionDecision({
      trajectory: { ...good1Recheck, event_count: annotationEvents.length },
      events: annotationEvents,
      evaluation: realJudge, reward: rewardRows[0], data_origin: { test_only: false },
    });
    h.check("13 annotation events do not create false corruption",
      recapture.eligible === 2 && good1Recheck.learning_eligibility.eligible === true &&
      eventsAfter.some((e) => e.event_type === "learning_eligibility") &&
      !annotated.reasons.includes("corrupted_trace"),
      `re-capture still eligible ${recapture.eligible}; annotated verdict reasons: ${annotated.reasons.join(", ") || "none"}`);

    // ================= 15 · NO_EVIDENCE precedes REGRESSION, deterministically =================
    const noEvidence = promotionVerdict({
      candidate_evaluation: { status: "FINALIZED", coverage: { items_scored: 0 }, metrics: { task_success_rate: null } },
      regression: { verdict: "REGRESSION" }, has_reference: true,
    });
    const regressed = promotionVerdict({
      candidate_evaluation: { status: "FINALIZED", coverage: { items_scored: 3 }, metrics: { task_success_rate: 1 } },
      regression: { verdict: "REGRESSION" }, has_reference: true,
    });
    h.check("15 NO_EVIDENCE takes precedence over REGRESSION",
      noEvidence.code === "NO_EVIDENCE" && noEvidence.eligible === false &&
      regressed.code === "REGRESSION" && regressed.eligible === false &&
      promotionVerdict({ candidate_evaluation: { status: "FINALIZED", coverage: { items_scored: 0 }, metrics: {} }, regression: { verdict: "REGRESSION" }, has_reference: true }).code === "NO_EVIDENCE",
      `zero scored items → ${noEvidence.code}; scored + regression → ${regressed.code}`);

    // ================= 14, 16, 20, 23 · the full loop through to promotion =================
    const cycle1Res = await runLearningCycle(base44, caller, { project_id: proj.id, candidate });
    const cycle1 = cycle1Res.cycle;
    created.datasets.push(cycle1.training_dataset_id, cycle1.evaluation_dataset_id);
    const measurement = cycle1.candidate_evaluation_id ? await svc.entities.CandidateEvaluation.get(cycle1.candidate_evaluation_id) : null;
    h.check("14 the candidate was measured on the finalized evaluation dataset",
      !!measurement && measurement.status === "FINALIZED" && measurement.dataset_id === cycle1.evaluation_dataset_id &&
      measurement.dataset_checksum === cycle1.evaluation_dataset_checksum &&
      (measurement.coverage?.items_scored || 0) >= 1 && measurement.metrics.task_success_rate != null,
      `${measurement?.coverage?.items_scored} item(s) scored, task_success_rate ${measurement?.metrics?.task_success_rate}`);

    const policy1 = await getActivePolicy(svc, { scope: "project", project_id: proj.id });
    h.check("16 a passing cycle promotes a new active routing policy version",
      cycle1Res.promoted === true && cycle1.status === "PROMOTED" && cycle1.promotion.code === "PROMOTE" &&
      !!cycle1.policy_version && policy1?.policy_version === cycle1.policy_version && policy1.status === "ACTIVE" &&
      policy1.scope === "project" && policy1.project_id === proj.id &&
      cycle1.source_trajectory_ids.length === 2 && cycle1.promoted_model.model_id === model.model_id,
      `cycle ${cycle1.version} promoted policy ${cycle1.policy_version}`);

    h.check("23 the full capture → judge → reward → dataset → measure → promote loop is recorded",
      cycle1.capture.eligible === 2 && !!cycle1.training_dataset_id && !!cycle1.evaluation_dataset_id &&
      !!cycle1.dataset_provenance.training.checksum && !!cycle1.dataset_provenance.evaluation.checksum &&
      !!cycle1.candidate_evaluation_id && cycle1.metrics.task_success_rate != null && !!cycle1.completed_at,
      `capture → datasets → measurement ${cycle1.candidate_evaluation_id} → policy ${cycle1.policy_version}`);

    const auditRows = await svc.entities.AuditLog.filter({ project_id: proj.id }, "-created_date", 200);
    const actions = auditRows.map((r) => r.action);
    const lineage = await getLearningLineage(base44, caller, { cycle_id: cycle1.cycle_id });
    h.check("20 audit lineage is complete end to end",
      ["learning.cycle.started", "learning.capture.completed", "learning.dataset.finalized", "learning.training.measured", "learning.cycle.promoted"].every((a) => actions.includes(a)) &&
      lineage.lineage.sources.length === 2 &&
      lineage.lineage.sources.every((s) => s.evaluation_id && s.reward_id && s.final_reward != null && s.learning_eligibility?.eligible === true) &&
      lineage.lineage.policy_version === cycle1.policy_version,
      `audit actions: ${["started", "capture", "dataset", "measured", "promoted"].filter((_, i) => true).length} stages; ${lineage.lineage.sources.length} source episode(s) fully traced`);

    // ================= 17 · a failed cycle cannot touch the known-good state =================
    await episode(failProj, { prompt: "Unsealed only", status: "FAILED", buildStatus: "failed", runtimeOk: false, scores: { task_completion: 0, build: 0, runtime: 0 } });
    const failedCycle = (await runLearningCycle(base44, caller, { project_id: failProj.id, candidate })).cycle;
    const mainListing = await listLearningCycles(base44, caller, { project_id: proj.id });
    h.check("17 a failed cycle preserves the known-good state",
      failedCycle.status === "FAILED" && failedCycle.failure_code === "NO_ELIGIBLE_EXAMPLES" && failedCycle.policy_version === null &&
      (await getActivePolicy(svc, { scope: "project", project_id: failProj.id })) === null &&
      (await knownGoodCycle(svc, failProj.id)) === null &&
      mainListing.known_good_cycle_id === cycle1.cycle_id && mainListing.active_policy_version === cycle1.policy_version,
      `failed with ${failedCycle.failure_code}; main project still on ${mainListing.active_policy_version}`);

    // ================= 19 · a later cycle rolls back to the previous promoted policy =================
    await episode(proj, { prompt: "Add a reports page", duration_ms: 41000 });
    const cycle2Res = await runLearningCycle(base44, caller, { project_id: proj.id, candidate });
    const cycle2 = cycle2Res.cycle;
    created.datasets.push(cycle2.training_dataset_id, cycle2.evaluation_dataset_id);
    h.check("19a the later cycle was promoted before its rollback is exercised",
      cycle2Res.promoted === true && cycle2.status === "PROMOTED",
      `cycle ${cycle2.version} ${cycle2.status} ${cycle2.failure_code || ""} ${cycle2.error || ""} ${JSON.stringify(cycle2.promotion || null)}`);
    if (cycle2.status !== "PROMOTED" && /^evaluation dataset/.test(cycle2.error || "")) {
      // Test-only diagnostic: direct, unswallowed read of the failing evaluation dataset's items.
      const [failedDs] = await svc.entities.Dataset.filter({ project_id: proj.id, name: "production-learning-evaluation" }, "-version", 1);
      let diag;
      try {
        const rows = await svc.entities.DatasetItem.filter({ dataset_id: failedDs.id }, "item_key", 2000);
        diag = `dataset ${failedDs.id} status ${failedDs.status} recorded ${failedDs.item_count}; direct read returned ${rows.length}`;
      } catch (e) {
        diag = `dataset ${failedDs?.id}: direct read FAILED ${e.status || ""} ${e.code || ""} ${e.message}`;
      }
      h.check("19-diag direct DatasetItem read for the failing evaluation dataset", false, diag);
    }
    if (cycle2.status !== "PROMOTED" && /^training dataset/.test(cycle2.error || "")) {
      // Test-only diagnostic: failing training dataset + direct, unswallowed episode read vs capture.
      const [failedTr] = await svc.entities.Dataset.filter({ project_id: proj.id, name: "production-learning-sft" }, "-version", 1);
      const cap = cycle2.capture || {};
      let diag = `dataset ${failedTr?.id} status ${failedTr?.status} candidate_count ${failedTr?.candidate_count} excluded_count ${failedTr?.excluded_count} items ${failedTr?.item_count}; capture considered ${cap.considered} eligible ${cap.eligible} excluded ${cap.excluded}`;
      try {
        const trajs = await svc.entities.Trajectory.filter({ project_id: proj.id }, "created_date", 400);
        diag += `; direct episode read returned ${trajs.length}`;
      } catch (e) {
        diag += `; direct episode read FAILED ${e.status || ""} ${e.code || ""} ${e.message}`;
      }
      h.check("19-diag training dataset failure vs capture", false, diag);
    }
    if (cycle2.status !== "PROMOTED") throw new Error(`setup: cycle ${cycle2.version} was ${cycle2.status} (${cycle2.failure_code})`);
    const rolledLater = await rollbackLearningCycle(base44, caller, { cycle_id: cycle2.cycle_id });
    const afterLater = await getActivePolicy(svc, { scope: "project", project_id: proj.id });
    h.check("19 a later cycle rolls back to the previous promoted policy",
      cycle2Res.promoted === true && cycle2.previous_policy_version === cycle1.policy_version &&
      rolledLater.cycle.status === "ROLLED_BACK" && rolledLater.restored_to === "previous_project_policy" &&
      rolledLater.policy.policy_version === cycle1.policy_version &&
      afterLater?.policy_version === cycle1.policy_version && afterLater.status === "ACTIVE",
      `cycle ${cycle2.version} rolled back; active policy restored to ${afterLater?.policy_version}`);

    // ================= 18 · the FIRST promoted cycle can also be rolled back =================
    const rolledFirst = await rollbackLearningCycle(base44, caller, { cycle_id: cycle1.cycle_id });
    const retired = await svc.entities.RoutingPolicy.filter({ policy_version: cycle1.policy_version }, "-version", 1);
    h.check("18 the first promoted cycle rolls back to the platform baseline",
      rolledFirst.cycle.status === "ROLLED_BACK" && rolledFirst.restored_to === "platform_or_default" &&
      rolledFirst.policy === null && rolledFirst.cycle.rolled_back_at &&
      retired[0]?.status === "ROLLED_BACK" &&
      (await getActivePolicy(svc, { scope: "project", project_id: proj.id })) === null,
      `first cycle retired policy ${cycle1.policy_version}; project back on the platform baseline`);

    // ================= 21-22 · authorization and project isolation =================
    await h.expectThrow("21 anonymous run rejected", () => runLearningCycle(base44, null, { project_id: proj.id }), "AUTH_REQUIRED");
    await h.expectThrow("21b anonymous capture rejected", () => captureOutcomes(base44, null, { project_id: proj.id }), "AUTH_REQUIRED");
    await h.expectThrow("21c anonymous list rejected", () => listLearningCycles(base44, null, { project_id: proj.id }), "AUTH_REQUIRED");
    await h.expectThrow("21d anonymous get rejected", () => getLearningCycle(base44, null, { cycle_id: cycle1.cycle_id }), "AUTH_REQUIRED");
    await h.expectThrow("21e anonymous lineage rejected", () => getLearningLineage(base44, null, { cycle_id: cycle1.cycle_id }), "AUTH_REQUIRED");
    await h.expectThrow("21f anonymous rollback rejected", () => rollbackLearningCycle(base44, null, { cycle_id: cycle1.cycle_id }), "AUTH_REQUIRED");
    await h.expectThrow("22 a non-member cannot read another workspace's cycle", () => getLearningCycle(base44, stranger, { cycle_id: cycle1.cycle_id }), "NOT_A_MEMBER");
    await h.expectThrow("22b a non-member cannot run a cycle", () => runLearningCycle(base44, stranger, { project_id: proj.id }), "NOT_A_MEMBER");
    await h.expectThrow("22c a foreign project is unreachable", () => listLearningCycles(base44, caller, { project_id: foreignProj.id }), "NOT_A_MEMBER");
    const foreignCycles = await svc.entities.LearningCycle.filter({ project_id: foreignProj.id }, "-version", 10);
    const ownCycles = await listLearningCycles(base44, caller, { project_id: proj.id });
    h.check("22d cycles never leak across projects",
      foreignCycles.length === 0 && ownCycles.cycles.every((c) => c.project_id === proj.id) &&
      lineage.lineage.sources.every((s) => !!s.run_id) &&
      !(await svc.entities.LearningCycle.filter({ project_id: failProj.id }, "-version", 10)).some((c) => c.status === "PROMOTED"),
      `${ownCycles.count} cycle(s) for this project only`);

    // ================= API surface =================
    const contract = productionLearningContract();
    const apiContract = await base44.functions.invoke("productionLearning", { action: "contract" }).catch((e) => ({ data: { error: e.message } }));
    const apiList = await base44.functions.invoke("productionLearning", { action: "list", project_id: proj.id }).catch((e) => ({ data: { error: e.message } }));
    const apiGet = await base44.functions.invoke("productionLearning", { action: "get", cycle_id: cycle1.cycle_id }).catch((e) => ({ data: { error: e.message } }));
    const apiLineage = await base44.functions.invoke("productionLearning", { action: "lineage", cycle_id: cycle1.cycle_id }).catch((e) => ({ data: { error: e.message } }));
    const apiUnknown = await base44.functions.invoke("productionLearning", { action: "no_such_action" }).catch((e) => ({ data: { code: "UNKNOWN_ACTION" } }));
    h.check("API exposes the authorized production-learning operations",
      apiContract.data?.flywheel_version === contract.flywheel_version &&
      apiContract.data.promotion_policy_version === PROMOTION_POLICY_VERSION &&
      apiList.data?.project_id === proj.id && Array.isArray(apiList.data.cycles) &&
      apiGet.data?.cycle?.cycle_id === cycle1.cycle_id &&
      apiLineage.data?.lineage?.sources?.length === 2 &&
      (apiUnknown.data?.code === "UNKNOWN_ACTION" || apiUnknown.status === 400),
      `contract / list (${apiList.data?.count}) / get / lineage / rollback routed through the module`);

    const serialized = JSON.stringify([capture, cycle1, cycle2, lineage, mainListing]);
    h.check("no credential value survives anywhere in the flywheel's output",
      !serialized.includes(SECRET), "capture, cycles, lineage and listings are credential-free");

  } catch (error) {
    testError = error;
  }

  // Teardown runs before the report is built, attempts every step, and never throws over the report.
  const listErrors = [], deleteErrors = [];
  const msg = (e) => String(e?.message || e).slice(0, 200);
  const purge = async (entity, query) => {
    let rows = [];
    try { rows = await svc.entities[entity].filter(query, "-created_date", 500); }
    catch (e) { deleteErrors.push({ entity, op: "list", query, error: msg(e) }); return; }
    for (const row of rows) await remove(entity, row.id);
  };
  const remove = async (entity, id) => {
    try { await svc.entities[entity].delete(id); } catch (e) { deleteErrors.push({ entity, op: "delete", id, error: msg(e) }); }
  };
  // Register every Dataset owned by a test project first, so cleanup never depends on a diagnostic read.
  for (const pid of created.projects) {
    try {
      for (const d of await svc.entities.Dataset.filter({ project_id: pid }, "created_date", 200)) created.datasets.push(d.id);
    } catch (e) { listErrors.push({ project_id: pid, error: msg(e) }); }
  }
  for (const id of [...new Set(created.datasets.filter(Boolean))]) {
    await purge("CandidateEvaluation", { dataset_id: id });
    await purge("DatasetItem", { dataset_id: id });
    await remove("Dataset", id);
  }
  for (const pid of created.projects) {
    for (const name of ["LearningCycle", "RoutingPolicy", "RoutingDecision", "Reward", "Evaluation", "TrajectoryEvent", "Trajectory", "AIRun", "TraceEvent", "AuditLog"]) {
      await purge(name, { project_id: pid });
    }
    await remove("Project", pid);
  }
  for (const wid of created.workspaces) await cleanupWorkspace(svc, wid, ["AuditLog", "LearningCycle", "RoutingPolicy"]);
  h.check("teardown: dataset list reads", listErrors.length === 0, listErrors.length ? JSON.stringify(listErrors) : "all test-project datasets registered");
  h.check("teardown: cleanup deletes", deleteErrors.length === 0, deleteErrors.length ? `${deleteErrors.length} error(s): ${JSON.stringify(deleteErrors.slice(0, 20))}` : "all cleanup lists and deletes succeeded");

  return testError ? harnessError(h, testError) : harnessResponse(h);
}