// Shared certification fixtures.
//
// One place that builds the "control episode" every certification suite needs: a real sealed
// Trajectory (#18) with a real Judge evaluation (#19) and a real Reward (#20), created through those
// modules' own APIs. A suite snapshots it before its work and re-reads it afterwards to prove the
// layer under test wrote nothing behind those records' backs.
import { startTrajectory, recordBuildResult, recordRuntimeResult, finalizeTrajectory } from "./trajectory.ts";
import { evaluateTrajectory, EVALUATOR_VERSION } from "./evaluation.ts";
import { calculateReward, REWARD_POLICY_VERSION } from "./reward.ts";

export const nowIso = () => new Date().toISOString();

/**
 * Creates one COMPLETED control episode in `project`: a real run, a real sealed trajectory with
 * build and runtime evidence, a real evaluation and a real reward. Returns every record plus a
 * stable snapshot string for later byte-comparison.
 */
export async function createControlEpisode(svc, { user, project, workspace, prompt = "control episode", duration_ms = 1000 }) {
  const run = await svc.entities.AIRun.create({
    project_id: project.id, status: "COMPLETED", mode: "default", prompt,
    trace_id: `tr_control_${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    started_at: nowIso(), completed_at: nowIso(), duration_ms,
  });
  const { trajectory } = await startTrajectory(svc, {
    run, project, workspace, trace_id: run.trace_id, actor_user_id: user.id,
    tools: ["read_file"], context: { file_count: 1 },
  });
  await recordBuildResult(svc, trajectory, { status: "success", errors: 0, file_count: 1 });
  await recordRuntimeResult(svc, trajectory, { ok: true, checks: ["boot"] });
  await finalizeTrajectory(svc, { run_id: run.id, status: "COMPLETED", duration_ms });
  const sealed = await svc.entities.Trajectory.get(trajectory.id);
  const evaluation = (await evaluateTrajectory(svc, { trajectory: sealed, evaluator_version: EVALUATOR_VERSION })).evaluation;
  const reward = (await calculateReward(svc, { trajectory: sealed, reward_policy_version: REWARD_POLICY_VERSION })).reward;
  return { run, trajectory: sealed, evaluation, reward, snapshot: controlSnapshot({ run, trajectory: sealed, evaluation, reward }) };
}

/** Stable projection of a control episode — identical strings mean nothing was rewritten. */
export const controlSnapshot = ({ run, trajectory, evaluation, reward }) => JSON.stringify({
  traj: { status: trajectory.status, revision: trajectory.revision, sealed: trajectory.sealed, event_count: trajectory.event_count, outcomes: trajectory.outcomes },
  evaluation: { id: evaluation.id, revision: evaluation.revision, inputs_hash: evaluation.inputs_hash, scores: evaluation.scores },
  reward: { id: reward.id, revision: reward.revision, status: reward.status, final_reward: reward.final_reward },
  run: { status: run.status, preferred_model_id: run.preferred_model_id ?? null },
});