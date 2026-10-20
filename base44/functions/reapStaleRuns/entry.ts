// Recovery sweep for background work that lost its worker.
//
// AI runs: a run that stopped reporting progress is marked STALE, so nothing is left stuck
// in a non-terminal state after the process was killed mid-flight. A QUEUED run that never
// started is re-driven through the worker path instead: no heartbeat there only means no
// worker has picked the request up yet, so the user's request is never dropped just for
// sitting in the queue.
//
// Agent runs: the executor workflow drives a bounded number of invocations. If the worker
// (or the workflow itself) disappears while the agent is still non-terminal, this sweep is
// what resumes it from its persisted checkpoint — or makes it terminal when recovery is no
// longer safe. It only ever touches a run whose lease has EXPIRED, so a live worker can
// never be reaped out from under itself.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { AGENT_TERMINAL, releaseAgentReservation } from "../../shared/agentLoop.ts";
import { DEPLOY_TERMINAL, DEPLOY_ACTIVE, MAX_DEPLOY_RECOVERIES, reconcileEnvironmentPointer, ENVIRONMENTS } from "../../shared/deploy.ts";
import { GIT_TERMINAL, GIT_ACTIVE, MAX_GIT_RECOVERIES, destroyJobToken } from "../../shared/gitSync.ts";
import { recoverPendingCommits, findJournalForRun } from "../../shared/commitJournal.ts";
import { finalizeRecoveredRun, settleStaleRun } from "../../shared/runPipeline.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

const SAVE_IN_PROGRESS = ["prepared", "applying", "applied"];

// What a stale run actually saved. Read-only: never creates a version, only finds one.
//   { inProgress: true }            → a commit journal is still unresolved; leave the run alone
//   { version: { id, number } }     → the save succeeded; the run is really complete
//   {}                              → nothing was saved
async function savedOutcome(db, base44, run) {
  const journal = await findJournalForRun(base44.asServiceRole, run.id).catch(() => null);
  if (journal && SAVE_IN_PROGRESS.includes(journal.status)) return { inProgress: true };
  const versionId = run.version_id || (journal?.status === "committed" ? journal.version_id : null);
  if (versionId) {
    const v = await db.ProjectVersion.get(versionId).catch(() => null);
    if (v) return { version: v };
  }
  // A rolled-back journal already deleted this run's versions, so a surviving one is committed.
  if (journal?.status !== "rolled_back") {
    const [v] = await db.ProjectVersion.filter({ project_id: run.project_id, run_id: run.id }, "-number", 1).catch(() => []);
    if (v) return { version: v };
  }
  return {};
}

const NON_TERMINAL = ["QUEUED", "RUNNING", "CONTEXT_LOADING", "PLANNING", "EXECUTING", "VALIDATING", "REPAIRING"];
const AGENT_NON_TERMINAL = ["QUEUED", "RUNNING", "PLANNING", "EXECUTING", "OBSERVING", "VERIFYING"];
const STALE_AFTER_MS = 3 * 60 * 1000;
const MAX_RECOVERIES = 3;
// A never-started queued run is re-driven for at most this long (bounded by the run's own
// age, so no new run state or schema is needed) before it is dropped as never picked up.
const AI_QUEUE_MAX_AGE_MS = 30 * 60 * 1000;
// An Agent whose lease was released normally is idle (not lost) while its heartbeat is younger than this.
const AGENT_IDLE_RESUME_MAX_MS = 15 * 60 * 1000;

export default async function (req) {
  // G-3: the recovery sweep acts with the service role across ALL workspaces, so
  // it is the most sensitive surface here. Authenticated before anything is touched.
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole.entities;
  const cutoff = Date.now() - STALE_AFTER_MS;
  const reaped = [];

  // Commit journals: a worker killed during the commit phase leaves a journal that describes
  // both the previous and the intended canonical state. Recovery resolves it deterministically —
  // roll forward when canonical state already matches the target in full, otherwise restore the
  // previous state — so a project is never left half-committed and never gains a second version.
  // Resolved FIRST, so the run sweep below sees each commit's final outcome.
  const commits = await recoverPendingCommits(base44.asServiceRole).catch(() => ({ recovered_count: 0, recovered: [] }));

  // --- AI runs: QUEUED never-started vs EXECUTING -------------------------------
  // A QUEUED run has no worker yet, so a missing heartbeat means the executor has not picked
  // it up — NOT that a worker died. Marking it STALE would discard a user request that never
  // executed. A never-started queued run is therefore re-driven through the normal worker
  // path: same run, same ids, same `run:<id>` idempotency keys. The phase lease inside
  // executeRunPhase means a re-drive can never produce a second worker or a second charge;
  // only the run's AGE bounds how long re-driving is attempted.
  for (const run of await db.AIRun.filter({ status: "QUEUED" }, "-created_date", 200)) {
    const last = Date.parse(run.heartbeat_at || run.started_at || run.created_date);
    // Recently touched or freshly re-driven: the executor (or a claimed lease) is on it.
    if (!Number.isFinite(last) || last > cutoff) continue;
    const leaseUntil = Date.parse(run.phase_lease_expires_at || "");
    if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) continue; // a live worker claimed the phase
    // A phase already started is executing-work semantics: leave it to the sweep below.
    if ((run.steps || []).length || (run.phase && run.phase !== "plan") || run.version_id) continue;
    const age = Date.now() - Date.parse(run.created_date || "");
    if (Number.isFinite(age) && age > AI_QUEUE_MAX_AGE_MS) {
      await db.AIRun.update(run.id, {
        status: "STALE",
        error: `This run was never picked up by a worker within ${Math.round(AI_QUEUE_MAX_AGE_MS / 60000)} minutes and was dropped. No changes were saved; please try again.`,
        completed_at: new Date().toISOString(),
      });
      if (run.project_id && run.conversation_id) {
        await db.Message.create({
          project_id: run.project_id, conversation_id: run.conversation_id, run_id: run.id, role: "assistant",
          content: "This run was stuck in the queue and never started, so it was dropped. Please try again.",
        }).catch(() => {});
      }
      reaped.push({ run_id: run.id, was: "QUEUED", action: "STALE_NEVER_STARTED" });
      continue;
    }
    // Re-drive through the normal worker path (also the path whose cancellation gate settles
    // a durable cancel). The fresh heartbeat keeps the executing sweep from touching the run
    // while its worker claims the phase lease; the invoke itself is fire-and-forget.
    await db.AIRun.update(run.id, { heartbeat_at: new Date().toISOString() });
    base44.asServiceRole.functions.invoke("aiRunStep", { run_id: run.id }).catch(() => {});
    reaped.push({ run_id: run.id, was: "QUEUED", action: "RE_DRIVEN" });
  }

  // Executing runs (and a QUEUED row that already started a phase): existing dead-worker
  // semantics — a stale heartbeat means the worker is gone, so the run is completed from its
  // saved outcome or marked STALE.
  for (const status of NON_TERMINAL) {
    const runs = await db.AIRun.filter({ status }, "-created_date", 200);
    for (const run of runs) {
      // A live worker holds an unexpired phase lease (including the just-claimed window before
      // its first progress write): never touch it, whatever the heartbeat says — the same
      // lease-first rule the agent/deployment/GitHub sweeps below already apply.
      const leaseUntil = Date.parse(run.phase_lease_expires_at || "");
      if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) continue;
      const last = Date.parse(run.heartbeat_at || run.started_at || run.created_date);
      if (!Number.isFinite(last) || last > cutoff) continue;
      const startedMs = Date.parse(run.started_at || run.created_date);

      const outcome = await savedOutcome(db, base44, run);
      // A save is still unresolved: leave the run for the next cycle, after journal recovery.
      if (outcome.inProgress) continue;
      // The save already landed: the run is complete, linked to the version it produced.
      if (outcome.version) {
        // Same finalization as a normal completion (intelligence, audit, settlement); falls back
        // to the plain status update only when the project/workspace can no longer be loaded.
        const finalized = await finalizeRecoveredRun(base44.asServiceRole, run, outcome.version).catch(() => null);
        if (!finalized) await db.AIRun.update(run.id, {
          status: "COMPLETED", phase: "done",
          version_id: outcome.version.id, version_number: outcome.version.number,
          phase_lease_token: null, phase_lease_expires_at: null,
          completed_at: new Date().toISOString(),
          ...(Number.isFinite(startedMs) ? { duration_ms: last - startedMs } : {}),
        });
        if (run.project_id && run.conversation_id) {
          await db.Message.create({
            project_id: run.project_id, conversation_id: run.conversation_id, run_id: run.id, role: "assistant",
            content: `This run was interrupted after its changes were saved as version ${outcome.version.number}.`,
          }).catch(() => {});
        }
        reaped.push({ run_id: run.id, was: status, action: "COMPLETED", version_number: outcome.version.number });
        continue;
      }

      // STALE settles through the SAME idempotent path a FAILED run takes (usage settlement
      // + credit-hold release, guarded by usage_event_id and the operation's `run:<id>`
      // key), so a worker-lost run neither strands its reservation nor double-charges on a
      // replayed sweep.
      await settleStaleRun(base44.asServiceRole, run, {
        error: `Run stopped reporting progress at "${status}" and was terminated. No changes were saved to the project.`,
      }).catch(() => {});
      if (run.project_id && run.conversation_id) {
        await db.Message.create({
          project_id: run.project_id, conversation_id: run.conversation_id, run_id: run.id, role: "assistant",
          content: "This run was interrupted before it finished, so nothing was saved to the project. Please try again.",
        }).catch(() => {});
      }
      reaped.push({ run_id: run.id, was: status });
    }
  }

  const agents = [];
  for (const status of AGENT_NON_TERMINAL) {
    const runs = await db.AgentRun.filter({ status }, "-created_date", 100);
    for (const run of runs) {
      if (AGENT_TERMINAL.includes(run.status)) continue;
      // A live worker holds an unexpired lease and heartbeats every step: never touch it.
      const leaseUntil = Date.parse(run.lease_expires_at || "");
      if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) continue;
      const last = Date.parse(run.heartbeat_at || run.started_at || run.created_date);
      if (!Number.isFinite(last) || last > cutoff) continue;

      const finish = async (state, failure_code, result_summary) => {
        await db.AgentRun.update(run.id, {
          status: state, failure_code, result_summary, current_phase: state.toLowerCase(),
          completed_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
          lease_token: null, lease_expires_at: null,
        });
        // A terminal agent must not keep holding Message credits.
        await releaseAgentReservation(base44.asServiceRole, run, state).catch(() => {});
        await db.AuditLog.create({
          workspace_id: run.workspace_id, project_id: run.project_id, user_id: run.user_id,
          action: `agent.run.${state.toLowerCase()}`, resource: "AgentRun", resource_id: run.id,
          metadata: { reason: failure_code, steps: run.current_step, recovery_count: run.recovery_count || 0 },
        }).catch(() => {});
        agents.push({ agent_run_id: run.id, was: status, action: state });
      };

      // Cancellation is durable and wins over recovery: a lost worker is never resumed
      // into another mutation after the user cancelled.
      if (run.cancel_requested) {
        await finish("CANCELLED", "CANCELLED", "The agent was cancelled while its worker was unavailable. No further changes were made.");
        continue;
      }
      // Idle, not dead: the last worker released its lease normally (executor window ended, or it
      // is waiting on a delegated Builder run). Resume without counting a worker loss and without
      // writing to the run. Past the idle window it falls through to bounded recovery below.
      if (!run.lease_token && Date.now() - last < AGENT_IDLE_RESUME_MAX_MS) {
        base44.asServiceRole.functions.invoke("agentStep", { agent_run_id: run.id }).catch(() => {});
        agents.push({ agent_run_id: run.id, was: status, action: "RESUMED_IDLE", from_step: run.current_step });
        continue;
      }
      // Bounded recovery: a worker that keeps dying must not retry forever.
      if ((run.recovery_count || 0) >= MAX_RECOVERIES) {
        await finish("STALE", "WORKER_LOST", `The agent lost its worker ${run.recovery_count} times and was stopped after ${run.current_step} step(s). Any versions already committed by completed builder runs remain.`);
        continue;
      }
      if ((run.current_step || 0) >= (run.max_steps || 0)) {
        await finish("FAILED", "MAX_STEPS_EXCEEDED", `Stopped at its ${run.max_steps}-step limit without completing the goal.`);
        continue;
      }

      // Resume from the persisted checkpoint through the normal worker path.
      await db.AgentRun.update(run.id, {
        recovery_count: (run.recovery_count || 0) + 1, current_phase: "resuming after worker loss",
        heartbeat_at: new Date().toISOString(), lease_token: null, lease_expires_at: null,
      });
      await db.AuditLog.create({
        workspace_id: run.workspace_id, project_id: run.project_id, user_id: run.user_id,
        action: "agent.run.recovered", resource: "AgentRun", resource_id: run.id,
        metadata: { was: status, from_step: run.current_step, recovery_count: (run.recovery_count || 0) + 1 },
      }).catch(() => {});
      base44.asServiceRole.functions.invoke("agentStep", { agent_run_id: run.id }).catch(() => {});
      agents.push({ agent_run_id: run.id, was: status, action: "RESUMED", from_step: run.current_step });
    }
  }

  // Deployments use the same durable-job contract as agents: expired lease + dead
  // heartbeat means the worker is gone. A deployment is resumed from its persisted phase,
  // or failed terminally — production is never left mid-update, and an unfinished
  // deployment never blocks the project's next one forever.
  const deployments = [];
  for (const status of DEPLOY_ACTIVE) {
    const rows = await db.Deployment.filter({ status }, "-created_date", 100);
    for (const d of rows) {
      if (DEPLOY_TERMINAL.includes(d.status)) continue;
      const leaseUntil = Date.parse(d.lease_expires_at || "");
      if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) continue;
      const last = Date.parse(d.heartbeat_at || d.started_at || d.created_date);
      if (!Number.isFinite(last) || last > cutoff) continue;

      const terminal = async (state, failure_code, failure_summary) => {
        await db.Deployment.update(d.id, {
          status: state, failure_code, failure_summary, completed_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(), lease_token: null, lease_expires_at: null,
        });
        await db.AuditLog.create({
          workspace_id: d.workspace_id, project_id: d.project_id, user_id: d.deployed_by,
          action: `deployment.${state.toLowerCase()}`, resource: "Deployment", resource_id: d.id,
          metadata: { reason: failure_code, was: status, recovery_count: d.recovery_count || 0 },
        }).catch(() => {});
        deployments.push({ deployment_id: d.id, was: status, action: state });
      };

      if (d.cancel_requested) {
        await terminal("CANCELLED", "CANCELLED", "Cancelled while its worker was unavailable. Production was left untouched.");
        continue;
      }
      if ((d.recovery_count || 0) >= MAX_DEPLOY_RECOVERIES) {
        await terminal("FAILED", "WORKER_LOST", `The deployment worker was lost ${d.recovery_count} times at "${status}". Production still serves the previous deployment.`);
        continue;
      }
      await db.Deployment.update(d.id, {
        recovery_count: (d.recovery_count || 0) + 1, heartbeat_at: new Date().toISOString(),
        lease_token: null, lease_expires_at: null,
      });
      await db.AuditLog.create({
        workspace_id: d.workspace_id, project_id: d.project_id, user_id: d.deployed_by,
        action: "deployment.recovered", resource: "Deployment", resource_id: d.id,
        metadata: { was: status, recovery_count: (d.recovery_count || 0) + 1 },
      }).catch(() => {});
      base44.asServiceRole.functions.invoke("deployStep", { deployment_id: d.id }).catch(() => {});
      deployments.push({ deployment_id: d.id, was: status, action: "RESUMED" });
    }
  }

  // GitHub source-control jobs use the same durable-job contract: expired lease + dead
  // heartbeat means the worker is gone. A job is resumed from its persisted phase, or made
  // terminal — and a terminal job always has its short-lived GitHub credential destroyed,
  // so a lost worker never leaves a usable token behind.
  const syncs = [];
  for (const status of GIT_ACTIVE) {
    const rows = await db.GitSyncRun.filter({ status }, "-created_date", 100);
    for (const g of rows) {
      if (GIT_TERMINAL.includes(g.status)) continue;
      const leaseUntil = Date.parse(g.lease_expires_at || "");
      if (Number.isFinite(leaseUntil) && leaseUntil > Date.now()) continue;
      const last = Date.parse(g.heartbeat_at || g.started_at || g.created_date);
      if (!Number.isFinite(last) || last > cutoff) continue;

      const terminal = async (state, failure_code, failure_summary) => {
        await db.GitSyncRun.update(g.id, {
          status: state, failure_code, failure_summary, current_phase: state.toLowerCase(),
          completed_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
          lease_token: null, lease_expires_at: null, credential_ref: null,
        });
        await destroyJobToken(base44.asServiceRole, g.workspace_id, g.credential_ref);
        await db.AuditLog.create({
          workspace_id: g.workspace_id, project_id: g.project_id, user_id: g.user_id,
          action: `github.${g.direction}.${state.toLowerCase()}`, resource: "GitSyncRun", resource_id: g.id,
          metadata: { reason: failure_code, was: status, repo: g.repo_full_name, commit_sha: g.commit_sha || null, recovery_count: g.recovery_count || 0 },
        }).catch(() => {});
        syncs.push({ sync_run_id: g.id, was: status, action: state });
      };

      if (g.cancel_requested) {
        await terminal("CANCELLED", "CANCELLED", "Cancelled while its worker was unavailable. Nothing was changed.");
        continue;
      }
      if ((g.recovery_count || 0) >= MAX_GIT_RECOVERIES) {
        await terminal("STALE", "WORKER_LOST", `The GitHub ${g.direction} lost its worker ${g.recovery_count} times at "${status}" and was stopped. The project and production were not changed by the unfinished operation.`);
        continue;
      }
      await db.GitSyncRun.update(g.id, {
        recovery_count: (g.recovery_count || 0) + 1, current_phase: "resuming after worker loss",
        heartbeat_at: new Date().toISOString(), lease_token: null, lease_expires_at: null,
      });
      await db.AuditLog.create({
        workspace_id: g.workspace_id, project_id: g.project_id, user_id: g.user_id,
        action: "github.sync.recovered", resource: "GitSyncRun", resource_id: g.id,
        metadata: { was: status, direction: g.direction, recovery_count: (g.recovery_count || 0) + 1 },
      }).catch(() => {});
      base44.asServiceRole.functions.invoke("githubSyncStep", { sync_run_id: g.id }).catch(() => {});
      syncs.push({ sync_run_id: g.id, was: status, action: "RESUMED" });
    }
  }

  // A worker killed between "deployment is LIVE" and "project pointer updated" leaves that
  // environment's pointer stale. The runtime already derives the right deployment, so this
  // only repairs the cached pointer the builder UI reads — per environment, so fixing
  // staging can never disturb production.
  const pointers = [];
  const withPointer = await db.Project.filter({}, "-updated_date", 200);
  for (const p of withPointer) {
    for (const env of ENVIRONMENTS) {
      const fixed = await reconcileEnvironmentPointer(base44.asServiceRole, p, env).catch(() => null);
      if (fixed) pointers.push({ project_id: p.id, environment: env, now_serving: fixed.version_number });
    }
  }

  return Response.json({ reaped_count: reaped.length, reaped, commits_recovered: commits.recovered_count, commits: commits.recovered, agents_count: agents.length, agents, deployments_count: deployments.length, deployments, syncs_count: syncs.length, syncs, pointers_fixed: pointers.length, pointers });
}