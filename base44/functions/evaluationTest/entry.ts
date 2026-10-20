// Executable certification for the Evaluation / Judge Engine (#19).
//
// Every check runs against the REAL evaluation module, the REAL trajectory records produced by the
// existing learning layer and the REAL project authorization path. Episodes are built here with the
// trajectory layer's own emission functions, so the judge is certified against authentic data and
// never against a hand-written stand-in.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  startTrajectory, recordModelSelection, recordPlan, recordToolCalls, recordPhase,
  recordBuildResult, recordRuntimeResult, recordRepairAttempt, recordMutations, finalizeTrajectory,
} from "../../shared/trajectory.ts";
import {
  runEvaluation, getEvaluation, listEvaluationHistory, listProjectEvaluations,
  evaluateTrajectory, EVALUATOR_VERSION, DIMENSIONS,
} from "../../shared/evaluation.ts";

const SECRET = "sk_live_judge_must_never_leak_5c8d";
const TOKEN = "ghp_judgecertdummytoken00000000000000000";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  let workspace = null, other = null, proj = null, otherProj = null;

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated user" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: "Judge Cert", owner_id: caller.id, credits_balance: 200 });
    other = await svc.entities.Workspace.create({ name: "Judge Cert (other)", owner_id: "judge_other_owner", credits_balance: 5 });
    proj = await svc.entities.Project.create({ workspace_id: workspace.id, name: "judge-project", status: "ready", version_count: 2 });
    otherProj = await svc.entities.Project.create({ workspace_id: other.id, name: "foreign-project", status: "ready", version_count: 1 });

    // ---- episode 1: a genuinely successful run (becomes the known-good baseline) ----
    const goodRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "COMPLETED", mode: "default", phase: "done", trace_id: "t_judge_good", prompt: `Add notes page, key ${SECRET}`, base_version_number: 1 });
    const goodVersion = await svc.entities.ProjectVersion.create({
      project_id: proj.id, number: 2, message: "add notes page",
      snapshot: { files: [{ path: "src/pages/Notes.js", content: "export default () => null;\n" }], entities: [{ name: "Note", fields: {} }] },
      changed_files: [{ path: "src/pages/Notes.js", change: "added" }],
    });
    const goodBuild = await svc.entities.Build.create({ project_id: proj.id, run_id: goodRun.id, status: "success", error_count: 0, file_count: 13, duration_ms: 280, logs: ["[runtime] 2 runtime check(s) passed"] });
    const good = (await startTrajectory(base44, { run: goodRun, project: proj, workspace, trace_id: "t_judge_good", tools: ["write_file"], context: { file_count: 12, api_key: SECRET } })).trajectory;
    await recordModelSelection(base44, good, { model_id: "gpt_5_mini", provider: "core", routing_decision: { strategy: "cost", client_secret: SECRET } });
    await recordPlan(base44, good, { plan: ["write page"], files: [{ path: "src/pages/Notes.js", action: "create" }], entities: [{ name: "Note" }], assumptions: [] });
    await recordToolCalls(base44, good, { phase: "generate", calls: [{ tool: "write_file", ok: true, summary: "src/pages/Notes.js" }, { tool: "patch_file", ok: true, summary: `token ${TOKEN}` }] });
    await recordPhase(base44, good, { phase: "generate", status: "ok", attempt: 1, duration_ms: 800, next_phase: "build" });
    await recordBuildResult(base44, good, { build_id: goodBuild.id, status: "success", errors: 0, file_count: 13, duration_ms: 280, attempt: 1 });
    await recordRuntimeResult(base44, good, { ok: true, checks: [{ name: "mount", ok: true }, { name: "route /notes", ok: true }], diagnostics: 0, attempt: 1 });
    await recordMutations(base44, good, { changed_files: [{ path: "src/pages/Notes.js", change: "added" }], entities_changed: ["Note"], version_id: goodVersion.id, version_number: 2 });
    const goodSealed = await finalizeTrajectory(base44, { run_id: goodRun.id, status: "COMPLETED", duration_ms: 12000, version_id: goodVersion.id, version_number: 2, build_id: goodBuild.id, credits_charged: 9, repair_attempts: 0 });

    // Evidence captured BEFORE the judge runs, to prove nothing authoritative is mutated.
    const trajBefore = JSON.stringify(goodSealed);
    const versionBefore = JSON.stringify(await svc.entities.ProjectVersion.get(goodVersion.id));
    const eventsBefore = JSON.stringify(await svc.entities.TrajectoryEvent.filter({ trajectory_id: good.id }, "sequence", 200));
    const runBefore = JSON.stringify(await svc.entities.AIRun.get(goodRun.id));
    const buildBefore = JSON.stringify(await svc.entities.Build.get(goodBuild.id));

    const goodEval = await runEvaluation(base44, caller, { project_id: proj.id, run_id: goodRun.id });
    const g = goodEval.evaluation;
    h.check("1 successful trajectory receives evaluation",
      goodEval.created && g.trajectory_id === good.id && g.run_id === goodRun.id && g.trace_id === "t_judge_good" &&
      g.workspace_id === workspace.id && g.project_id === proj.id && g.version_id === goodVersion.id && !!g.evaluated_at,
      `revision=${g.revision} version=${g.version_number}`);
    h.check("3 task completion score uses authoritative outcome",
      g.scores.task_completion_score === 1 && g.dimensions.task_completion.status === "passed" &&
      g.evidence.some((e) => e.dimension === "task_completion" && e.source === "ai_run" && e.reference_id === goodRun.id),
      JSON.stringify(g.dimensions.task_completion));
    h.check("4 build score uses authoritative build result",
      g.scores.build_score === 1 && g.build_id === goodBuild.id &&
      g.evidence.some((e) => e.dimension === "build" && e.source === "build_result" && e.reference_id === goodBuild.id),
      JSON.stringify(g.dimensions.build));
    h.check("5 runtime score uses authoritative runtime result",
      g.scores.runtime_score === 1 && g.dimensions.runtime.status === "passed" &&
      g.evidence.some((e) => e.dimension === "runtime" && e.source === "runtime_result") && g.metrics.runtime_checks === 2,
      JSON.stringify(g.dimensions.runtime));
    h.check("9 change scope metrics are captured",
      g.metrics.files_changed === 1 && g.metrics.entities_changed === 1 && g.metrics.tool_calls === 2 && g.metrics.failed_tool_calls === 0 &&
      g.scores.change_efficiency_score === 1,
      JSON.stringify(g.metrics));
    h.check("10 every evaluation dimension has evidence",
      DIMENSIONS.every((d) => !!g.dimensions[d] && g.evidence.some((e) => e.dimension === d && !!e.source)) &&
      g.evidence.every((e) => typeof e.source === "string" && e.source.length > 0),
      `${g.evidence.length} evidence item(s) across ${DIMENSIONS.length} dimensions`);
    h.check("11 evaluator_version is stored", g.evaluator_version === EVALUATOR_VERSION && !!g.inputs_hash, `${g.evaluator_version} / ${g.inputs_hash}`);
    h.check("22 evaluation API returns structured results",
      DIMENSIONS.every((d) => "score" in g.dimensions[d] && "status" in g.dimensions[d]) &&
      Object.keys(g.scores).length === DIMENSIONS.length && Array.isArray(g.findings) && !("evaluator_internals" in g),
      Object.keys(g.scores).join(", "));

    // 7 — insufficient evidence must not invent a regression. This is the FIRST episode of the
    // project, so there is no verified prior good state to regress from.
    h.check("7 insufficient evidence does not create a false regression",
      g.scores.regression_score === null && g.dimensions.regression.status === "insufficient_evidence" &&
      !g.findings.some((f) => f.toLowerCase().includes("regress")),
      g.dimensions.regression.status);

    // ---- idempotency + determinism ----
    // Compared against the STORED projection, so the check certifies determinism of the persisted
    // evaluation rather than an artifact of the create call's echo.
    const gStored = (await getEvaluation(base44, caller, { project_id: proj.id, trajectory_id: good.id, evaluator_version: EVALUATOR_VERSION })).evaluation;
    const repeat = await runEvaluation(base44, caller, { project_id: proj.id, run_id: goodRun.id });
    const allForGood = await svc.entities.Evaluation.filter({ trajectory_id: good.id }, "revision", 20);
    h.check("12 same trajectory + evaluator version is idempotent",
      repeat.created === false && repeat.reason === "identical_inputs" && repeat.evaluation.id === g.id && allForGood.length === 1,
      `${allForGood.length} evaluation row(s)`);
    h.check("13 repeated evaluation produces an identical result",
      JSON.stringify(repeat.evaluation) === JSON.stringify(gStored) && repeat.evaluation.inputs_hash === g.inputs_hash,
      "byte-identical evaluation for unchanged authoritative inputs");

    // ---- 14 — a revised evaluator adds a revision and preserves the earlier one ----
    const revised = await evaluateTrajectory(base44, { trajectory: await svc.entities.Trajectory.get(good.id), evaluator_version: "1.1.0" });
    const historyGood = await listEvaluationHistory(base44, caller, { project_id: proj.id, trajectory_id: good.id });
    const originalStill = historyGood.evaluations.find((e) => e.id === g.id);
    h.check("14 revised evaluator version preserves the historical evaluation",
      revised.created && revised.evaluation.evaluator_version === "1.1.0" && revised.evaluation.revision === 2 &&
      revised.evaluation.supersedes_evaluation_id === g.id && historyGood.count === 2 &&
      JSON.stringify(originalStill) === JSON.stringify(gStored),
      `revisions: ${historyGood.evaluations.map((e) => `${e.revision}@${e.evaluator_version}`).join(", ")}`);
    h.check("23 evaluation history is preserved",
      historyGood.evaluations[0].revision === 1 && historyGood.evaluations[1].revision === 2 &&
      (await getEvaluation(base44, caller, { project_id: proj.id, trajectory_id: good.id })).evaluation.revision === 2 &&
      (await getEvaluation(base44, caller, { project_id: proj.id, trajectory_id: good.id, evaluator_version: EVALUATOR_VERSION })).evaluation.id === g.id,
      `${historyGood.count} revision(s), earlier revision still readable`);

    // ---- 15 / 16 / 24 — nothing authoritative was touched ----
    h.check("15 trajectory remains unchanged",
      JSON.stringify(await svc.entities.Trajectory.get(good.id)) === trajBefore &&
      JSON.stringify(await svc.entities.TrajectoryEvent.filter({ trajectory_id: good.id }, "sequence", 200)) === eventsBefore,
      "trajectory row and event history byte-identical after evaluation");
    h.check("16 immutable version remains unchanged", JSON.stringify(await svc.entities.ProjectVersion.get(goodVersion.id)) === versionBefore, "version snapshot byte-identical");
    const projNow = await svc.entities.Project.get(proj.id);
    h.check("24 existing AI Builder behavior remains unchanged",
      JSON.stringify(await svc.entities.AIRun.get(goodRun.id)) === runBefore &&
      JSON.stringify(await svc.entities.Build.get(goodBuild.id)) === buildBefore &&
      projNow.version_count === 2 && projNow.status === "ready",
      "run, build and project pointer untouched by the judge");

    // ---- episode 2: a failed run AFTER a verified good state → real regression signal ----
    const badRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "FAILED", mode: "default", phase: "done", trace_id: "t_judge_bad", prompt: "Add charts", base_version_number: 2 });
    const badBuild = await svc.entities.Build.create({ project_id: proj.id, run_id: badRun.id, status: "failed", error_count: 3, file_count: 13, duration_ms: 190, logs: ["error: Charts is not defined"] });
    const bad = (await startTrajectory(base44, { run: badRun, project: proj, workspace, trace_id: "t_judge_bad", tools: ["write_file"], context: { file_count: 13 } })).trajectory;
    await recordToolCalls(base44, bad, { phase: "generate", calls: [{ tool: "write_file", ok: true, summary: "src/pages/Charts.js" }, { tool: "patch_file", ok: false, summary: "anchor not found" }] });
    await recordBuildResult(base44, bad, { build_id: badBuild.id, status: "failed", errors: 3, file_count: 13, duration_ms: 190, attempt: 1 });
    await recordRuntimeResult(base44, bad, { ok: false, category: "RUNTIME_ERROR", checks: [{ name: "mount", ok: false }], diagnostics: 3, attempt: 1 });
    await recordRepairAttempt(base44, bad, { attempt: 1, resolved: false, error_codes: ["error: Charts is not defined"] });
    await recordRepairAttempt(base44, bad, { attempt: 2, resolved: false, error_codes: ["error: Charts is not defined"] });
    await finalizeTrajectory(base44, { run_id: badRun.id, status: "FAILED", error: `build failed with key ${SECRET}`, duration_ms: 9000, build_id: badBuild.id, repair_attempts: 2 });

    const badEval = await runEvaluation(base44, caller, { project_id: proj.id, run_id: badRun.id });
    const b = badEval.evaluation;
    h.check("2 failed trajectory receives evaluation",
      badEval.created && b.trajectory_id === bad.id && b.trajectory_status === "FAILED" &&
      b.scores.task_completion_score === 0 && b.dimensions.task_completion.status === "failed" && b.scores.build_score === 0 && b.scores.runtime_score === 0,
      JSON.stringify(b.scores));
    h.check("6 regression signal is detected when evidence exists",
      b.scores.regression_score === 0 && b.dimensions.regression.status === "regressed" &&
      b.evidence.some((e) => e.dimension === "regression" && e.reference_id === good.id) &&
      b.findings.some((f) => f.toLowerCase().includes("verified build/runtime failure")),
      JSON.stringify(b.dimensions.regression));
    h.check("8 repair count is captured correctly",
      b.metrics.repair_attempts === 2 && b.dimensions.repair_efficiency.status === "unresolved" && b.scores.repair_efficiency_score === 0 &&
      b.evidence.some((e) => e.dimension === "repair_efficiency" && e.source === "trajectory_event"),
      JSON.stringify(b.dimensions.repair_efficiency));
    h.check("21 partially completed / failed trajectory is evaluable",
      b.scores.change_efficiency_score === 0.5 && b.metrics.failed_tool_calls === 1 && b.version_id === null && b.metrics.files_changed === 0,
      `change=${b.scores.change_efficiency_score} files=${b.metrics.files_changed}`);

    // ---- episode 3: cancelled run, no build and no runtime evidence ----
    const cancelledRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "CANCELLED", mode: "default", phase: "done", trace_id: "t_judge_cancel", prompt: "cancel me" });
    const cancelled = (await startTrajectory(base44, { run: cancelledRun, project: proj, workspace, trace_id: "t_judge_cancel", context: {} })).trajectory;
    await finalizeTrajectory(base44, { run_id: cancelledRun.id, status: "CANCELLED", error: "cancelled by user", duration_ms: 700 });
    const cEval = (await runEvaluation(base44, caller, { project_id: proj.id, run_id: cancelledRun.id })).evaluation;
    h.check("20 cancelled trajectory is evaluated without invented signals",
      cEval.trajectory_status === "CANCELLED" && cEval.scores.task_completion_score === 0 && cEval.dimensions.task_completion.status === "cancelled" &&
      cEval.scores.build_score === null && cEval.dimensions.build.status === "unavailable" &&
      cEval.scores.runtime_score === null && cEval.dimensions.runtime.status === "unavailable" &&
      cEval.scores.regression_score === null && cEval.scores.repair_efficiency_score === null,
      JSON.stringify(cEval.scores));

    // An unsealed episode cannot be judged at all — the judge only evaluates finished outcomes.
    const liveRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "EXECUTING", mode: "default", phase: "generate", prompt: "in flight" });
    await startTrajectory(base44, { run: liveRun, project: proj, workspace, trace_id: "t_judge_live", context: {} });
    await h.expectThrow("20b in-flight episode is refused",
      () => runEvaluation(base44, caller, { project_id: proj.id, run_id: liveRun.id }), "TRAJECTORY_NOT_SEALED");

    // ---- 19 — secrets ----
    const allEvals = await svc.entities.Evaluation.filter({ project_id: proj.id }, "-created_date", 20);
    const serialized = JSON.stringify(allEvals);
    h.check("19 secrets are fully scrubbed",
      !serialized.includes(SECRET) && !serialized.includes(TOKEN) &&
      !/"(value|api_key|client_secret|access_token|refresh_token|password)"\s*:\s*"(?!\[REDACTED\])/.test(serialized),
      "no credential value present in any evaluation record");

    // ---- 17 / 18 — authorization + isolation ----
    await h.expectThrow("17 unauthorized evaluation access is rejected",
      () => getEvaluation(base44, { id: "judge_stranger", email: "stranger@example.com" }, { project_id: proj.id, trajectory_id: good.id }), "NOT_A_MEMBER");
    await h.expectThrow("17b unauthorized caller cannot evaluate",
      () => runEvaluation(base44, { id: "judge_stranger", email: "stranger@example.com" }, { project_id: proj.id, trajectory_id: good.id }), "NOT_A_MEMBER");
    await h.expectThrow("18 cross-project evaluation access is rejected",
      () => getEvaluation(base44, caller, { project_id: otherProj.id, trajectory_id: good.id }), "NOT_A_MEMBER");
    const foreignRun = await svc.entities.AIRun.create({ project_id: otherProj.id, status: "COMPLETED", mode: "default", prompt: "foreign" });
    const foreignTraj = (await startTrajectory(svc, { run: foreignRun, project: otherProj, workspace: other, trace_id: "t_foreign", context: {} })).trajectory;
    await finalizeTrajectory(svc, { run_id: foreignRun.id, status: "COMPLETED", duration_ms: 100 });
    await evaluateTrajectory(svc, { trajectory: await svc.entities.Trajectory.get(foreignTraj.id) });
    const ownList = await listProjectEvaluations(base44, caller, { project_id: proj.id });
    h.check("18b project isolation holds on list paths",
      ownList.evaluations.every((e) => e.project_id === proj.id) && !ownList.evaluations.some((e) => e.trajectory_id === foreignTraj.id),
      `${ownList.count} evaluation(s), all scoped to the authorized project`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const p of [proj, otherProj]) {
      if (!p) continue;
      for (const name of ["Evaluation", "TrajectoryEvent", "Trajectory", "Build", "ProjectVersion", "AIRun", "AuditLog", "TraceEvent"]) {
        await purgeBy(svc, name, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const w of [workspace, other]) if (w) await cleanupWorkspace(svc, w.id, ["AuditLog"]);
  }
}