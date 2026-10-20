// AI run cancellation.
//
// Cancellation is DURABLE and COOPERATIVE, because a run executes across several requests in a
// background worker the caller cannot reach:
//   • the endpoint records `cancel_requested` on the run — a persisted intent that survives
//     worker restarts and is authorized against the run's own project/workspace;
//   • a QUEUED run has no worker in flight, so it is made terminal immediately;
//   • an in-flight run is stopped by its worker, which checks the flag between phases and again
//     immediately before the commit phase mutates anything — so a cancelled run never writes
//     files, entities or a new version.
// Terminal accounting is the SAME exactly-once path every other outcome uses (`run:<id>` is the
// idempotency key): the reservation the run holds is released and nothing is charged, exactly as
// on the failure path. A run that was already settled is never settled again.
import { settleUsage } from "./aiOperations.ts";
import { loadAuthorizedProject, audit } from "./authz.ts";
// Learning data: the cancellation path is THE single terminal transition for a cancelled run, so
// the episode is sealed here. Best-effort — observability must never affect the cancellation.
import { finalizeTrajectory, emit } from "./trajectory.ts";

// Kept local on purpose: importing it from runPipeline.ts would create an import cycle, since
// the pipeline imports this module.
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];

const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

// The terminal transition. Safe to call twice and safe to call from either the endpoint (for a
// queued run) or the worker (for an in-flight one): a run that already reached a terminal state
// is reported as-is and nothing is settled, audited or mutated a second time.
export async function cancelRun(base44, run, { actor_id = null, reason = "Cancelled by request." } = {}) {
  const svc = base44.asServiceRole || base44;
  const fresh = await svc.entities.AIRun.get(run.id).catch(() => null);
  if (!fresh) fail(404, "RUN_NOT_FOUND", "Run not found");
  if (TERMINAL.includes(fresh.status)) {
    return { run: fresh, status: fresh.status, cancelled: fresh.status === "CANCELLED", already_terminal: true };
  }

  const project = await svc.entities.Project.get(fresh.project_id).catch(() => null);
  const workspace = project ? await svc.entities.Workspace.get(project.workspace_id).catch(() => null) : null;
  const startedMs = Date.parse(fresh.started_at || fresh.created_date);
  const duration = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;

  // Credit settlement. `settleUsage` resolves the operation the run reserved against under the
  // run's own idempotency key, so the reservation is released even though the pipeline's
  // in-memory model was lost — and a replayed cancellation settles the same operation instead of
  // moving credits twice.
  let operationId = fresh.operation_id || null;
  // Display parity: a cancelled run that already delivered usage IS billed by settleUsage, so the
  // run row shows what was actually charged. A run with no usage settles at 0; an already-settled
  // run keeps its stamped charge instead of being overwritten with 0. No UsageEvent is created on
  // the cancel path — settlement and ledger behaviour are unchanged.
  let chargedCredits = Number(fresh.credits_charged) || 0;
  if (workspace && !fresh.usage_event_id) {
    const settled = await settleUsage(svc, {
      workspace_id: workspace.id, project_id: fresh.project_id, run_id: fresh.id, user_id: fresh.created_by_id,
      operation_type: "ai_run", model: null,
      usage: { input_tokens: fresh.input_tokens || 0, output_tokens: fresh.output_tokens || 0 },
      usage_source: "estimated", idempotency_key: `run:${fresh.id}`, status: "cancelled", duration_ms: duration,
    }).catch(() => null);
    if (settled?.operation?.id) operationId = settled.operation.id;
    if (settled?.credits_charged) chargedCredits = settled.credits_charged;
  }

  const updated = await svc.entities.AIRun.update(fresh.id, {
    status: "CANCELLED", phase: "done", cancel_requested: true,
    error: reason, completed_at: nowIso(), heartbeat_at: nowIso(), duration_ms: duration,
    credits_charged: chargedCredits, ...(operationId ? { operation_id: operationId } : {}),
  });

  if (workspace) {
    await audit(svc, {
      workspace_id: workspace.id, project_id: fresh.project_id, user_id: actor_id || fresh.cancel_requested_by || (fresh.initiated_by_user_id ?? fresh.created_by_id),
      action: "ai.run.cancelled", resource: "AIRun", resource_id: fresh.id,
      metadata: { was: fresh.status, phase: fresh.phase || null, credits_charged: 0 },
    }).catch(() => {});
  }
  await emit(() => finalizeTrajectory(svc, {
    run_id: fresh.id, status: "CANCELLED", error: reason, duration_ms: duration,
    build_id: fresh.build_id || null, credits_charged: 0, repair_attempts: fresh.repair_attempts || 0,
  }), "cancel");

  if (fresh.conversation_id) {
    await svc.entities.Message.create({
      project_id: fresh.project_id, conversation_id: fresh.conversation_id, run_id: fresh.id, role: "assistant",
      content: "This run was cancelled, so nothing was saved to the project.",
    }).catch(() => {});
  }
  return { run: updated, status: "CANCELLED", cancelled: true, already_terminal: false };
}

// The worker's cancellation gate. Called between phases and immediately before the commit phase
// mutates canonical state; returns a terminal phase result when the run must stop, otherwise null.
export async function cancelIfRequested(base44, run, phase) {
  const svc = base44.asServiceRole || base44;
  const fresh = await svc.entities.AIRun.get(run.id).catch(() => null);
  if (!fresh || !fresh.cancel_requested || TERMINAL.includes(fresh.status)) return null;
  await cancelRun(base44, fresh, {
    actor_id: fresh.cancel_requested_by || null,
    reason: `Cancelled during ${phase}. No changes were saved to the project.`,
  });
  return { done: true, status: "CANCELLED", phase: "done", cancelled: true };
}

// The authorized entry point. The run id is resolved server-side to its project, and access is
// the project's own workspace role — so a caller cannot cancel a run in an account they are not
// a member of, and an anonymous caller cannot cancel at all.
export async function requestRunCancel(base44, user, { run_id } = {}) {
  if (!user || !user.id) fail(401, "AUTH_REQUIRED", "Sign in to cancel a run");
  if (!run_id) fail(400, "INVALID_INPUT", "run_id is required");
  const svc = base44.asServiceRole || base44;
  const run = await svc.entities.AIRun.get(String(run_id)).catch(() => null);
  if (!run) fail(404, "RUN_NOT_FOUND", "Run not found");
  await loadAuthorizedProject(base44, user, run.project_id, "project.write");

  if (TERMINAL.includes(run.status)) {
    return { run_id: run.id, status: run.status, cancelled: run.status === "CANCELLED", cancel_requested: run.cancel_requested === true, already_terminal: true, idempotent: true };
  }

  const already = run.cancel_requested === true;
  if (!already) {
    await svc.entities.AIRun.update(run.id, { cancel_requested: true, cancel_requested_at: nowIso(), cancel_requested_by: user.id });
  }

  // QUEUED: no worker has picked the run up, so there is nothing to cooperate with and the run
  // is made terminal right here. RUNNING (and every other in-flight status): the worker owns the
  // transition, so it observes the flag at its next gate and stops before mutating anything.
  if (run.status === "QUEUED") {
    const out = await cancelRun(svc, run, { actor_id: user.id, reason: "Cancelled before execution started. No changes were saved to the project." });
    return { run_id: run.id, status: out.status, cancelled: out.cancelled, cancel_requested: true, already_terminal: false, idempotent: already };
  }
  return { run_id: run.id, status: run.status, cancelled: false, cancel_requested: true, already_terminal: false, idempotent: already };
}