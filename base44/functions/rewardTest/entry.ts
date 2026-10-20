// Executable certification for the Reward / Outcome Engine (#20).
//
// Every check runs against the REAL reward module, REAL trajectories produced by the existing
// learning layer, REAL Judge evaluations and the REAL project authorization path. Nothing is
// stubbed: the reward engine is certified against authentic sealed episodes and their evaluations.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  startTrajectory, recordToolCalls, recordBuildResult, recordRuntimeResult, recordRepairAttempt,
  recordMutations, recordUserOutcome, finalizeTrajectory,
} from "../../shared/trajectory.ts";
import { evaluateTrajectory } from "../../shared/evaluation.ts";
import {
  calculateReward, runRewardCalculation, getReward, listRewardHistory, listProjectRewards,
  REWARD_POLICY_VERSION, rewardPolicyVersions,
} from "../../shared/reward.ts";

const SECRET = "sk_live_reward_must_never_leak_71bd";
const TOKEN = "ghp_rewardcertdummytoken0000000000000000";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  let workspace = null, other = null, proj = null, otherProj = null;

  const fresh = async (id) => svc.entities.Trajectory.get(id);

  // Builds one authentic sealed episode with the trajectory layer's own emission functions, then
  // evaluates it with the real Judge. `ok` episodes carry successful build + runtime evidence.
  const makeEpisode = async ({ project, ws, key, ok = true, withVersion = true, repairs = 0, failedTool = false }) => {
    const run = await svc.entities.AIRun.create({
      project_id: project.id, status: ok ? "COMPLETED" : "FAILED", mode: "default", phase: "done",
      trace_id: `t_reward_${key}`, prompt: `episode ${key}, key ${SECRET}`, base_version_number: 1,
    });
    const build = await svc.entities.Build.create({ project_id: project.id, run_id: run.id, status: ok ? "success" : "failed", error_count: ok ? 0 : 4, file_count: 11, duration_ms: 210 });
    let version = null;
    if (withVersion) {
      version = await svc.entities.ProjectVersion.create({
        project_id: project.id, number: 2, message: `episode ${key}`,
        snapshot: { files: [{ path: `src/pages/${key}.js`, content: "export default () => null;\n" }], entities: [] },
        changed_files: [{ path: `src/pages/${key}.js`, change: "added" }],
      });
    }
    const t = (await startTrajectory(base44, { run, project, workspace: ws, trace_id: `t_reward_${key}`, tools: ["write_file"], context: { file_count: 11, api_key: SECRET } })).trajectory;
    await recordToolCalls(base44, t, { phase: "generate", calls: [{ tool: "write_file", ok: true, summary: `src/pages/${key}.js` }, { tool: "patch_file", ok: !failedTool, summary: `token ${TOKEN}` }] });
    await recordBuildResult(base44, t, { build_id: build.id, status: ok ? "success" : "failed", errors: ok ? 0 : 4, file_count: 11, duration_ms: 210, attempt: 1 });
    await recordRuntimeResult(base44, t, { ok, category: ok ? null : "RUNTIME_ERROR", checks: [{ name: "mount", ok }], diagnostics: ok ? 0 : 4, attempt: 1 });
    for (let i = 1; i <= repairs; i++) await recordRepairAttempt(base44, t, { attempt: i, resolved: ok && i === repairs, error_codes: ["error: boom"] });
    if (version) await recordMutations(base44, t, { changed_files: [{ path: `src/pages/${key}.js`, change: "added" }], entities_changed: [], version_id: version.id, version_number: 2 });
    await finalizeTrajectory(base44, {
      run_id: run.id, status: ok ? "COMPLETED" : "FAILED", error: ok ? null : `failed with key ${SECRET}`,
      duration_ms: 8000, version_id: version?.id || null, version_number: version ? 2 : null, build_id: build.id, repair_attempts: repairs,
    });
    const trajectory = await fresh(t.id);
    const evaluation = (await evaluateTrajectory(base44, { trajectory })).evaluation;
    return { run, build, version, trajectory, evaluation };
  };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated user" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: "Reward Cert", owner_id: caller.id, credits_balance: 200 });
    other = await svc.entities.Workspace.create({ name: "Reward Cert (other)", owner_id: "reward_other_owner", credits_balance: 5 });
    proj = await svc.entities.Project.create({ workspace_id: workspace.id, name: "reward-project", status: "ready", version_count: 2 });
    otherProj = await svc.entities.Project.create({ workspace_id: other.id, name: "foreign-project", status: "ready", version_count: 1 });

    // ---- episode A: successful, no user outcome yet (baseline for the objective path) ----
    const A = await makeEpisode({ project: proj, ws: workspace, key: "Alpha" });

    // Authoritative state captured immediately BEFORE any reward calculation.
    const trajBefore = JSON.stringify(A.trajectory);
    const eventsBefore = JSON.stringify(await svc.entities.TrajectoryEvent.filter({ trajectory_id: A.trajectory.id }, "sequence", 200));
    const evalBefore = JSON.stringify(await svc.entities.Evaluation.get(A.evaluation.id));
    const versionBefore = JSON.stringify(await svc.entities.ProjectVersion.get(A.version.id));
    const runBefore = JSON.stringify(await svc.entities.AIRun.get(A.run.id));
    const buildBefore = JSON.stringify(await svc.entities.Build.get(A.build.id));

    const aOut = await runRewardCalculation(base44, caller, { project_id: proj.id, run_id: A.run.id });
    const a = aOut.reward;
    h.check("1 successful evaluation produces reward",
      aOut.created && a.trajectory_id === A.trajectory.id && a.evaluation_id === A.evaluation.id && a.run_id === A.run.id &&
      a.trace_id === "t_reward_Alpha" && a.workspace_id === workspace.id && a.project_id === proj.id &&
      a.version_id === A.version.id && a.final_reward > 0.9 && !!a.calculated_at,
      `final=${a.final_reward} objective=${a.objective_reward}`);
    h.check("3 evaluation signals map deterministically",
      ["task_completion", "build", "runtime", "change_efficiency"].every((n) => {
        const c = a.components.find((x) => x.name === n);
        return c && c.kind === "evaluation_dimension" && c.score === A.evaluation.scores[`${n}_score`];
      }) && a.components.find((c) => c.name === "regression").score === null &&
      a.unavailable_components.includes("regression"),
      a.components.filter((c) => c.kind === "evaluation_dimension").map((c) => `${c.name}=${c.score}`).join(" "));
    h.check("10 missing user outcome does not become rejection",
      a.outcome_status === "unknown" && a.outcome_reward === null && a.user_outcome === null &&
      a.components.find((c) => c.name === "user_outcome").polarity === "neutral" &&
      a.final_reward === a.objective_reward && !a.negative_components.includes("user_outcome"),
      `outcome_status=${a.outcome_status} final=${a.final_reward} objective=${a.objective_reward}`);
    h.check("11 every reward component has provenance",
      a.components.length > 0 && a.components.every((c) => c.provenance && Object.keys(c.provenance).length > 0 &&
        (c.kind === "user_outcome" ? c.provenance.trajectory_id === A.trajectory.id : c.provenance.evaluation_id === A.evaluation.id && !!c.provenance.evaluation_dimension)),
      `${a.components.length} component(s), all provenance-linked`);
    h.check("12 final reward is normalized",
      a.final_reward >= 0 && a.final_reward <= 1 && a.objective_reward >= 0 && a.objective_reward <= 1 &&
      a.components.every((c) => c.score === null || (c.score >= 0 && c.score <= 1)) && !!a.formula,
      `final=${a.final_reward} formula="${a.formula.slice(0, 60)}"`);
    h.check("13 reward_policy_version is stored",
      a.reward_policy_version === REWARD_POLICY_VERSION && !!a.inputs_hash && a.evaluator_version === A.evaluation.evaluator_version,
      `${a.reward_policy_version} / ${a.inputs_hash}`);

    // ---- 15 / 16 — idempotency and worker-retry safety ----
    const repeat = await runRewardCalculation(base44, caller, { project_id: proj.id, run_id: A.run.id });
    const retries = [];
    for (const _ of [1, 2, 3]) retries.push(await calculateReward(base44, { trajectory: A.trajectory }));
    const aRows = await svc.entities.Reward.filter({ trajectory_id: A.trajectory.id }, "revision", 20);
    const aStored = (await getReward(base44, caller, { project_id: proj.id, trajectory_id: A.trajectory.id })).reward;
    h.check("15 same inputs + same policy are idempotent",
      repeat.created === false && repeat.reason === "identical_inputs" && repeat.reward.id === a.id &&
      JSON.stringify(repeat.reward) === JSON.stringify(aStored),
      "existing active reward returned unchanged");
    h.check("16 worker retry cannot duplicate reward",
      retries.every((r) => r.created === false && r.reward.id === a.id) && aRows.length === 1 &&
      aRows.filter((r) => r.status === "active").length === 1,
      `${aRows.length} reward row(s), ${aRows.filter((r) => r.status === "active").length} active`);

    // ---- 17-19 / 26 — read-only inputs ----
    h.check("17 trajectory remains unchanged",
      JSON.stringify(await fresh(A.trajectory.id)) === trajBefore &&
      JSON.stringify(await svc.entities.TrajectoryEvent.filter({ trajectory_id: A.trajectory.id }, "sequence", 200)) === eventsBefore,
      "trajectory row and event history byte-identical after reward calculation");
    h.check("18 evaluation remains unchanged", JSON.stringify(await svc.entities.Evaluation.get(A.evaluation.id)) === evalBefore, "evaluation record byte-identical");
    h.check("19 project versions remain unchanged", JSON.stringify(await svc.entities.ProjectVersion.get(A.version.id)) === versionBefore, "version snapshot byte-identical");
    const projNow = await svc.entities.Project.get(proj.id);
    h.check("26 existing AI Builder behavior remains unchanged",
      JSON.stringify(await svc.entities.AIRun.get(A.run.id)) === runBefore &&
      JSON.stringify(await svc.entities.Build.get(A.build.id)) === buildBefore &&
      projNow.version_count === 2 && projNow.status === "ready",
      "run, build and project pointer untouched by the reward engine");

    // ---- 14 / 25 — policy versioning and history ----
    const policyB = await calculateReward(base44, { trajectory: A.trajectory, reward_policy_version: "1.1.0" });
    const history = await listRewardHistory(base44, caller, { project_id: proj.id, trajectory_id: A.trajectory.id });
    const originalStill = history.rewards.find((r) => r.id === a.id);
    h.check("14 changing policy preserves historical rewards",
      policyB.created && policyB.reward.reward_policy_version === "1.1.0" && policyB.reward.revision === 2 &&
      policyB.reward.supersedes_reward_id === a.id && policyB.reward.formula !== a.formula &&
      JSON.stringify(originalStill) === JSON.stringify(aStored) && originalStill.status === "active" &&
      rewardPolicyVersions().length >= 2,
      `policies: ${history.policy_versions.join(", ")}, v1.0.0 reward still ${originalStill.final_reward}`);
    h.check("25 reward history is retrievable",
      history.count === 2 && history.rewards[0].revision === 1 && history.rewards[1].revision === 2 &&
      (await getReward(base44, caller, { project_id: proj.id, trajectory_id: A.trajectory.id, reward_policy_version: REWARD_POLICY_VERSION })).reward.id === a.id,
      `${history.count} reward(s) across ${history.policy_versions.length} policy version(s)`);

    // ---- 4 — user acceptance affects reward when available ----
    await recordUserOutcome(base44, caller, { project_id: proj.id, trajectory_id: A.trajectory.id, outcome: "accepted" });
    const accepted = (await calculateReward(base44, { trajectory: await fresh(A.trajectory.id) })).reward;
    const activeAfter = (await svc.entities.Reward.filter({ trajectory_id: A.trajectory.id, reward_policy_version: REWARD_POLICY_VERSION }, "revision", 20)).filter((r) => r.status === "active");
    h.check("4 user acceptance affects reward when available",
      accepted.outcome_status === "known" && accepted.user_outcome === "accepted" && accepted.outcome_reward === 1 &&
      accepted.final_reward >= a.final_reward && accepted.positive_components.includes("user_outcome:accepted") &&
      activeAfter.length === 1 && activeAfter[0].id === accepted.id,
      `final ${a.final_reward} → ${accepted.final_reward}, one active reward per policy`);

    // ---- 2 / 5 — failed episode + explicit rejection ----
    const B = await makeEpisode({ project: proj, ws: workspace, key: "Beta", ok: false, withVersion: false, repairs: 2, failedTool: true });
    const bReward = (await calculateReward(base44, { trajectory: B.trajectory })).reward;
    h.check("2 failed evaluation produces reward",
      bReward.final_reward != null && bReward.final_reward < 0.4 && bReward.objective_reward < 0.4 &&
      bReward.negative_components.includes("build") && bReward.negative_components.includes("runtime") &&
      bReward.negative_components.includes("task_completion"),
      `final=${bReward.final_reward} negatives=${bReward.negative_components.join(",")}`);
    await recordUserOutcome(base44, caller, { project_id: proj.id, trajectory_id: B.trajectory.id, outcome: "rejected" });
    const rejected = (await calculateReward(base44, { trajectory: await fresh(B.trajectory.id) })).reward;
    h.check("5 rejection affects reward when available",
      rejected.outcome_status === "known" && rejected.user_outcome === "rejected" && rejected.outcome_reward === 0 &&
      rejected.final_reward < bReward.final_reward && rejected.negative_components.includes("user_outcome:rejected"),
      `final ${bReward.final_reward} → ${rejected.final_reward}`);

    // ---- 6-9 — the remaining authoritative outcomes ----
    const outcomeCase = async (key, outcome) => {
      const ep = await makeEpisode({ project: proj, ws: workspace, key });
      const base = (await calculateReward(base44, { trajectory: ep.trajectory })).reward;
      await recordUserOutcome(base44, caller, { project_id: proj.id, trajectory_id: ep.trajectory.id, outcome });
      const after = (await calculateReward(base44, { trajectory: await fresh(ep.trajectory.id) })).reward;
      return { ep, base, after };
    };
    const abandoned = await outcomeCase("Gamma", "abandoned");
    h.check("6 abandonment is handled",
      abandoned.after.outcome_status === "partial" && abandoned.after.user_outcome === "abandoned" &&
      abandoned.after.outcome_reward === 0.25 && abandoned.after.final_reward < abandoned.base.final_reward &&
      abandoned.after.final_reward > 0 && abandoned.after.objective_reward === abandoned.base.objective_reward,
      `partial outcome, final ${abandoned.base.final_reward} → ${abandoned.after.final_reward}, objective unchanged`);
    const edited = await outcomeCase("Delta", "edited_after_generation");
    h.check("7 edited-after-generation is handled",
      edited.after.outcome_status === "partial" && edited.after.outcome_reward === 0.5 &&
      edited.after.components.some((c) => c.name === "user_outcome:edited_after_generation" && c.weight === 0.15),
      `outcome=${edited.after.outcome_reward} final=${edited.after.final_reward}`);
    const deployed = await outcomeCase("Epsilon", "deployed");
    h.check("8 deployment outcome is handled",
      deployed.after.outcome_status === "known" && deployed.after.outcome_reward === 1 &&
      deployed.after.final_reward >= deployed.base.final_reward && deployed.after.positive_components.includes("user_outcome:deployed"),
      `final ${deployed.base.final_reward} → ${deployed.after.final_reward}`);
    const reverted = await outcomeCase("Zeta", "reverted");
    h.check("9 revert outcome is handled",
      reverted.after.outcome_status === "known" && reverted.after.outcome_reward === 0 &&
      reverted.after.final_reward < reverted.base.final_reward && reverted.after.negative_components.includes("user_outcome:reverted"),
      `final ${reverted.base.final_reward} → ${reverted.after.final_reward}`);

    // ---- 23 — sealed trajectory required ----
    const liveRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "EXECUTING", mode: "default", phase: "generate", prompt: "in flight" });
    const live = (await startTrajectory(base44, { run: liveRun, project: proj, workspace, trace_id: "t_reward_live", context: {} })).trajectory;
    await h.expectThrow("23 sealed trajectory required",
      () => runRewardCalculation(base44, caller, { project_id: proj.id, trajectory_id: live.id }), "TRAJECTORY_NOT_SEALED");

    // ---- 24 — an episode with no evaluation, and an evaluation with no measurable dimension ----
    const noEvalRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "CANCELLED", mode: "default", phase: "done", prompt: "cancelled" });
    const noEval = (await startTrajectory(base44, { run: noEvalRun, project: proj, workspace, trace_id: "t_reward_noeval", context: {} })).trajectory;
    await finalizeTrajectory(base44, { run_id: noEvalRun.id, status: "CANCELLED", duration_ms: 500 });
    const noEvalSealed = await fresh(noEval.id);
    await h.expectThrow("24 incomplete evaluation is handled safely (no evaluation yet)",
      () => calculateReward(base44, { trajectory: noEvalSealed }), "EVALUATION_REQUIRED");

    // An evaluation whose every dimension is unavailable yields no reward value — reported as
    // insufficient evidence rather than as a low score.
    const blindRun = await svc.entities.AIRun.create({ project_id: proj.id, status: "FAILED", mode: "default", phase: "done", prompt: "blind" });
    const blindTraj = (await startTrajectory(base44, { run: blindRun, project: proj, workspace, trace_id: "t_reward_blind", context: {} })).trajectory;
    await finalizeTrajectory(base44, { run_id: blindRun.id, status: "FAILED", duration_ms: 100 });
    await svc.entities.Evaluation.create({
      evaluator_version: "1.0.0", trajectory_id: blindTraj.id, run_id: blindRun.id, project_id: proj.id, workspace_id: workspace.id,
      revision: 1, inputs_hash: "ev_blind", trajectory_status: "FAILED",
      dimensions: Object.fromEntries(["task_completion", "build", "runtime", "regression", "repair_efficiency", "change_efficiency"].map((d) => [d, { score: null, status: "unavailable", evidence: false }])),
      scores: {}, evidence: [], findings: [], metrics: {},
    });
    const blind = (await calculateReward(base44, { trajectory: await fresh(blindTraj.id) })).reward;
    h.check("24b unmeasurable evaluation yields no fabricated reward",
      blind.status === "insufficient_evidence" && blind.final_reward === null && blind.objective_reward === null &&
      blind.unavailable_components.length >= 6,
      `status=${blind.status} final=${blind.final_reward}`);

    // ---- 22 — secrets ----
    const allRewards = await svc.entities.Reward.filter({ project_id: proj.id }, "-created_date", 40);
    const serialized = JSON.stringify(allRewards);
    h.check("22 secrets are scrubbed",
      !serialized.includes(SECRET) && !serialized.includes(TOKEN) &&
      !/"(value|api_key|client_secret|access_token|refresh_token|password)"\s*:\s*"(?!\[REDACTED\])/.test(serialized),
      "no credential value present in any reward record");

    // ---- 20 / 21 — authorization and isolation ----
    await h.expectThrow("21 unauthorized access is rejected",
      () => getReward(base44, { id: "reward_stranger", email: "stranger@example.com" }, { project_id: proj.id, trajectory_id: A.trajectory.id }), "NOT_A_MEMBER");
    await h.expectThrow("21b unauthorized caller cannot calculate",
      () => runRewardCalculation(base44, { id: "reward_stranger", email: "stranger@example.com" }, { project_id: proj.id, trajectory_id: A.trajectory.id }), "NOT_A_MEMBER");
    await h.expectThrow("20 cross-project access is rejected",
      () => getReward(base44, caller, { project_id: otherProj.id, trajectory_id: A.trajectory.id }), "NOT_A_MEMBER");
    const F = await makeEpisode({ project: otherProj, ws: other, key: "Foreign" });
    await calculateReward(svc, { trajectory: F.trajectory });
    const ownList = await listProjectRewards(base44, caller, { project_id: proj.id });
    h.check("20b project isolation holds on list paths",
      ownList.rewards.every((r) => r.project_id === proj.id) && !ownList.rewards.some((r) => r.trajectory_id === F.trajectory.id),
      `${ownList.count} reward(s), all scoped to the authorized project`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const p of [proj, otherProj]) {
      if (!p) continue;
      for (const name of ["Reward", "Evaluation", "TrajectoryEvent", "Trajectory", "Build", "ProjectVersion", "AIRun", "AuditLog", "TraceEvent"]) {
        await purgeBy(svc, name, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const w of [workspace, other]) if (w) await cleanupWorkspace(svc, w.id, ["AuditLog"]);
  }
}