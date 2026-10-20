// Shared certification fixtures for the dataset / training-evaluation suites (#22, #39).
//
// One place builds the "recorded episode" both suites need — a real AIRun, a real sealed Trajectory,
// a real Evaluation and (optionally) a real Reward — and one place drives a dataset through its
// full lifecycle. The suites differ only in the fixtures they ask for, so neither carries its own
// copy of this construction logic.
import { createDataset, buildDataset, validateDataset, finalizeDataset } from "./dataset.ts";

export const nowIso = () => new Date().toISOString();

/**
 * Creates ONE recorded episode in `project`. Every field is written directly through the service
 * role, because a certification suite must control the authoritative evidence it then measures.
 * `pollution` and `toolSummary` let a suite deliberately plant hidden reasoning or a credential to
 * prove the dataset transform strips them.
 */
export async function createDatasetEpisode(svc, {
  project, prompt, status = "COMPLETED", scores, reward = null, user_outcome = "accepted",
  buildStatus = "success", runtimeOk = true, model_id = "gpt_5_mini", model_provider = "openai",
  duration_ms = 42000, toolOk = true, toolSummary = "wrote src/pages/Notes.js",
  pollution = {}, context = {}, evaluator_version = "1.0.0", reward_policy_version = "1.0.0",
}) {
  const run = await svc.entities.AIRun.create({
    project_id: project.id, status, mode: "default", phase: "done", prompt,
    trace_id: `t_ds_${Math.random().toString(36).slice(2, 8)}`, duration_ms, model: model_id,
  });
  const traj = await svc.entities.Trajectory.create({
    run_id: run.id, project_id: project.id, workspace_id: project.workspace_id, trace_id: run.trace_id,
    status, sealed: true, revision: 1, prompt, mode: "default", requested_at: nowIso(),
    context: { base_version_number: 2, file_count: 12, entity_count: 3, retrieved: 5, included: 4, context_hash: "ctx_cert", ...context },
    context_hash: "ctx_cert", model_id, model_provider,
    plan_summary: { steps: 3, file_actions: [{ path: "src/pages/Notes.js", action: "create" }], entities: ["Note"], integrations: [], assumptions: 1, ...pollution },
    tool_calls: [{ tool: "write_file", ok: true, summary: toolSummary, phase: "generate" }, { tool: "create_entity", ok: toolOk, summary: "Note", phase: "generate" }],
    phases: [{ phase: "plan", status: "ok", attempt: 1 }], retries: 0, fallbacks: [],
    mutations: { changed_files: [{ path: "src/pages/Notes.js", change: "created" }], files_changed_count: 1, entities_changed: ["Note"], version_id: `v_${run.id}`, version_number: 3 },
    outcomes: { build_status: buildStatus, build_errors: 0, runtime_ok: runtimeOk, repair_attempts: 0, final_run_status: status },
    user_outcome: user_outcome || undefined, event_count: 0, duration_ms, finalized_at: nowIso(),
  });
  const evaluation = await svc.entities.Evaluation.create({
    evaluator_version, trajectory_id: traj.id, run_id: run.id, project_id: project.id, workspace_id: project.workspace_id,
    trace_id: run.trace_id, version_id: `v_${run.id}`, version_number: 3, revision: 1, trajectory_status: status,
    inputs_hash: `ih_${traj.id}`,
    dimensions: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { score: v, status: "measured", evidence: "cert" }])),
    scores, evidence: [{ dimension: "build", source: "build_result", reference_id: "b_cert", detail: buildStatus }],
    findings: ["cert finding"], metrics: { files_changed: 1 },
  });
  let rewardRow = null;
  if (reward != null) {
    rewardRow = await svc.entities.Reward.create({
      reward_policy_version, trajectory_id: traj.id, evaluation_id: evaluation.id, run_id: run.id,
      project_id: project.id, workspace_id: project.workspace_id, trace_id: run.trace_id, revision: 1, status: "active",
      evaluator_version, inputs_hash: `rh_${traj.id}`, final_reward: reward, objective_reward: reward,
      outcome_status: user_outcome ? "known" : "unknown", user_outcome: user_outcome || undefined,
      components: [{ name: "build", kind: "evaluation_dimension", score: 1, weight: 0.3, contribution: 0.3, polarity: "positive" }],
    });
  }
  return { run, traj, evaluation, reward: rewardRow };
}

/** Drives one dataset through create → build → validate → finalize with the real module. */
export async function buildDatasetToFinal(base44, user, payload, track = null) {
  const created = await createDataset(base44, user, payload);
  if (track) track.push(created.dataset.dataset_id);
  const built = await buildDataset(base44, user, { dataset_id: created.dataset.dataset_id });
  const validated = await validateDataset(base44, user, { dataset_id: created.dataset.dataset_id });
  const final = await finalizeDataset(base44, user, { dataset_id: created.dataset.dataset_id });
  return { dataset_id: created.dataset.dataset_id, built, validated, validation: validated.validation, final };
}