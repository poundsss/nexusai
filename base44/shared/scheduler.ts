// Scheduled-trigger sweep: finds due triggers across all projects, claims each
// through an idempotent, leased run record, resolves the project's LIVE deployment
// + immutable artifact, and executes the selected function via the EXISTING
// function runtime (executeProjectFunction). Nothing here is a second runtime.
//
// SECURITY MODEL — a scheduled run is anonymous and holds no identity:
//   • executeProjectFunction is called with user = null. A scheduled run never
//     impersonates an end-user; ctx.user is null, so RLS-owned data is unreachable
//     (createServerDb rejects every op with AUTH_REQUIRED when rls is on and there
//     is no user). That is the correct behavior: scheduled jobs run as the system,
//     not as a tenant.
//   • Secret VALUES are resolved inside executeProjectFunction and redacted from
//     every log line, error and response. This module never sees them.
//   • Function SOURCE comes from the immutable artifact, never from the project's
//     mutable working files — editing in the builder cannot change a live schedule.
//   • Only projects with a LIVE deployment are executed; a draft or superseded
//     project is skipped and rescheduled.
//   • No control-plane operation is reachable: this reuses the read-only
//     currentLiveDeployment + loadArtifactPayload helpers and the function executor.
import { parseCron, nextRun, nextRunInZone } from "./cron.ts";
import { currentLiveDeployment, loadArtifactPayload } from "./deploy.ts";
import { audit } from "./authz.ts";
import { executeProjectFunction } from "./functionRuntime.ts";

const LEASE_MS = 120000;     // a sweep may hold a run for 2 minutes before it's reclaimable
const EXEC_TIMEOUT_MS = 30000; // wall-clock cap on a single scheduled function call
const SWEEP_LIMIT = 500;     // maximum triggers examined per tick (query cap)
// RELIABILITY (worker execution budget): one tick processes a bounded BATCH of triggers and
// stops at a wall-clock deadline, so a tick never runs past the worker's budget. Due triggers
// beyond the batch keep their slot UNTOUCHED and are processed by the next tick — no retry or
// missed-run machinery is introduced (idempotency, leases and next-run semantics unchanged).
const SWEEP_BATCH = 20;           // triggers processed per tick
const SWEEP_DEADLINE_MS = 40000;  // wall-clock budget for one tick's processing
// DOCUMENTED (Base44, Creating workflows): a scheduled workflow is deactivated after 5
// consecutive failures and the builder is notified. The pause writes that notification to the
// EXISTING builder surface — the workspace audit log the notifications view reads.
const FAILURE_PAUSE_THRESHOLD = 5;

const trunc = (v, n = 500) => String(v ?? "").slice(0, n);

// Next due time for a trigger, computed from `after`.
export function computeNextRun(trigger, after) {
  // One-time schedule: fires at the fixed UTC instant, then never again.
  if (trigger.one_time_at) {
    const t = Date.parse(trigger.one_time_at);
    if (!Number.isFinite(t)) return null;
    return t > after.getTime() ? new Date(t) : null;
  }
  const interval = Number(trigger.interval_seconds);
  if (Number.isFinite(interval) && interval > 0) {
    return new Date(after.getTime() + interval * 1000);
  }
  // Cron is evaluated in the trigger's timezone (the DOCUMENTED "a time you define in your
  // timezone"); "UTC" — the default — is the unchanged previous behavior.
  if (trigger.cron) {
    return nextRunInZone(parseCron(trigger.cron), after, trigger.timezone || "UTC");
  }
  return null; // no schedule configured
}

// Terminal-state bookkeeping shared by every terminal path: the consecutive-failure streak,
// the executed-run count, and the DOCUMENTED schedule-lifecycle behaviors applied with the
// existing fields — a one-time schedule ends after it runs; ends_type on/after archive the
// schedule; 5 consecutive failures pause it (with a builder notification). A missing function
// counts as a failed run (the documented pause counts failed runs regardless of cause).
function endPatch(trigger, status, error, next, extra = {}) {
  const failed = status === "failed" || status === "timeout";
  const failures = failed ? (Number(trigger.consecutive_failures) || 0) + 1 : 0;
  const runCount = (Number(trigger.run_count) || 0) + (status === "skipped" ? 0 : 1);
  const patch = {
    ...extra,
    consecutive_failures: failures, run_count: runCount,
    last_status: status, last_error: status === "success" ? null : (error || null),
  };
  if (next !== undefined) patch.next_run_at = next ? next.toISOString() : null;
  let pause = null;
  if (status !== "skipped") {
    if (trigger.one_time_at) pause = "completed";
    else if (String(trigger.ends_type || "never") === "after" && Number(trigger.ends_after_count) > 0 && runCount >= Number(trigger.ends_after_count)) pause = "schedule_ended";
    else if (String(trigger.ends_type || "never") === "on" && trigger.ends_on_date && next && Number.isFinite(Date.parse(trigger.ends_on_date)) && next.getTime() > Date.parse(trigger.ends_on_date)) pause = "schedule_ended";
    else if (failures >= FAILURE_PAUSE_THRESHOLD) pause = "consecutive_failures";
  }
  if (pause) { patch.enabled = false; patch.next_run_at = null; patch.paused_reason = pause; }
  return { patch, pause };
}

// The builder notification for a paused/ended schedule — written to the EXISTING notification
// surface (the workspace audit log). A notify failure never blocks the pause itself.
async function notifySchedulePaused(svc, project, trigger, reason, error) {
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: null,
    action: reason === "consecutive_failures" ? "schedule.paused" : "schedule.ended",
    resource: "ScheduledTrigger", resource_id: trigger.id,
    metadata: { name: trigger.name, function_name: trigger.function_name, reason, error: error ? String(error).slice(0, 200) : null },
  });
}

async function resolveLiveArtifact(svc, project) {
  const live = await currentLiveDeployment(svc, project);
  if (!live) return { ok: false, reason: "no_live_deployment" };
  const artifact = await svc.entities.DeploymentArtifact.get(live.artifact_id).catch(() => null);
  if (!artifact || artifact.project_id !== project.id) return { ok: false, reason: "artifact_unavailable" };
  let payload;
  try { payload = await loadArtifactPayload(artifact); }
  catch { return { ok: false, reason: "artifact_unreadable" }; }
  return { ok: true, live, artifact, payload };
}

// One run per (trigger, due time). A concurrent/recovering sweep reclaims an
// expired lease; a terminal run is never re-executed.
async function claimRun(svc, trigger, scheduledAt) {
  const key = `${trigger.id}:${scheduledAt}`;
  const existing = await svc.entities.ScheduledRun.filter({ idempotency_key: key }, "-created_date", 1);
  if (existing.length) {
    const run = existing[0];
    if (run.status === "running") {
      const leaseExp = Date.parse(run.lease_expires_at || "");
      if (Number.isFinite(leaseExp) && leaseExp > Date.now()) return { skip: "already_running" };
      const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await svc.entities.ScheduledRun.update(run.id, { lease_token: token, lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString() });
      const check = await svc.entities.ScheduledRun.get(run.id);
      return check.lease_token === token ? { run: check } : { skip: "lost_race" };
    }
    return { skip: "already_done" };
  }
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const run = await svc.entities.ScheduledRun.create({
    project_id: trigger.project_id, trigger_id: trigger.id, idempotency_key: key,
    function_name: trigger.function_name, scheduled_at: scheduledAt, status: "running",
    started_at: new Date().toISOString(), lease_token: token, lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString(),
  });
  return { run };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Scheduled execution timed out"), { kind: "timeout" })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Advance one trigger as far as possible. Every phase transition is persisted, so a
// killed worker resumes cleanly on the next tick (the leased run is reclaimed).
async function processOne(svc, trigger, now) {
  // Ensure next_run_at exists (new triggers start uncomputed).
  if (!trigger.next_run_at || !Number.isFinite(Date.parse(trigger.next_run_at))) {
    const base = trigger.created_date ? new Date(trigger.created_date) : now;
    const computed = computeNextRun(trigger, base);
    if (!computed) return { trigger_id: trigger.id, skipped: "no_schedule" };
    await svc.entities.ScheduledTrigger.update(trigger.id, { next_run_at: computed.toISOString() });
    trigger.next_run_at = computed.toISOString();
  }

  const dueMs = Date.parse(trigger.next_run_at);
  if (!Number.isFinite(dueMs) || dueMs > now.getTime()) return { trigger_id: trigger.id, not_due: true };

  // An ENDED schedule never runs again: the end date is inclusive (DOCUMENTED for automations;
  // NEXUSAI-DERIVED application here), and a fulfilled ends_after_count blocks further runs.
  const endsType = String(trigger.ends_type || "never");
  if (endsType === "on" && trigger.ends_on_date && Number.isFinite(Date.parse(trigger.ends_on_date)) && dueMs > Date.parse(trigger.ends_on_date)) {
    await svc.entities.ScheduledTrigger.update(trigger.id, { enabled: false, next_run_at: null, paused_reason: "schedule_ended" });
    return { trigger_id: trigger.id, paused: "schedule_ended" };
  }
  if (endsType === "after" && Number(trigger.ends_after_count) > 0 && (Number(trigger.run_count) || 0) >= Number(trigger.ends_after_count)) {
    await svc.entities.ScheduledTrigger.update(trigger.id, { enabled: false, next_run_at: null, paused_reason: "schedule_ended" });
    return { trigger_id: trigger.id, paused: "schedule_ended" };
  }

  const scheduledAt = new Date(dueMs).toISOString();
  const project = await svc.entities.Project.get(trigger.project_id).catch(() => null);
  if (!project) {
    await svc.entities.ScheduledTrigger.update(trigger.id, { enabled: false, last_status: "skipped", last_error: "project not found" });
    return { trigger_id: trigger.id, skipped: "project_not_found" };
  }

  const resolved = await resolveLiveArtifact(svc, project);
  if (!resolved.ok) {
    // No live deployment: skip this slot. A recurring schedule reschedules to the next future
    // time; a one-time schedule KEEPS its slot, so it still fires once the app is live again.
    const computed = trigger.one_time_at ? new Date(dueMs) : computeNextRun(trigger, now);
    await svc.entities.ScheduledTrigger.update(trigger.id, {
      next_run_at: computed ? computed.toISOString() : null,
      last_status: "skipped", last_error: resolved.reason,
    });
    return { trigger_id: trigger.id, skipped: resolved.reason };
  }

  const fn = (resolved.payload.functions || []).find((f) => f.name === trigger.function_name);
  if (!fn) {
    // A missing function is a FAILED scheduled run — the same terminal bookkeeping applies
    // (failure streak, ends/pause), though no ScheduledRun row exists to attach it to.
    const computed = trigger.one_time_at ? new Date(dueMs) : computeNextRun(trigger, now);
    const { patch, pause } = endPatch(trigger, "failed", `function "${trigger.function_name}" is not part of this deployment`, computed);
    await svc.entities.ScheduledTrigger.update(trigger.id, patch);
    if (pause) await notifySchedulePaused(svc, project, trigger, pause, patch.last_error).catch(() => {});
    return { trigger_id: trigger.id, failed: "function_not_in_deployment", ...(pause ? { paused: pause } : {}) };
  }

  const claim = await claimRun(svc, trigger, scheduledAt);
  if (claim.skip) {
    // already_running: another sweep owns it — leave next_run_at for that sweep to advance.
    // already_done: redundant tick before advancement — idempotently re-advance; for a
    // one-time schedule that slot's run already happened, so the schedule ends here.
    if (claim.skip !== "already_running") {
      if (trigger.one_time_at) {
        await svc.entities.ScheduledTrigger.update(trigger.id, { enabled: false, next_run_at: null, paused_reason: "completed" });
        return { trigger_id: trigger.id, duplicate: claim.skip, paused: "completed" };
      }
      const computed = computeNextRun(trigger, now);
      await svc.entities.ScheduledTrigger.update(trigger.id, { next_run_at: computed ? computed.toISOString() : null });
    }
    return { trigger_id: trigger.id, duplicate: claim.skip };
  }
  const run = claim.run;

  let status = "success", error = null, resultPreview = "";
  const execStart = Date.now();
  try {
    const res = await withTimeout(executeProjectFunction(svc, {
      project, entities: resolved.payload.entities, integrations: resolved.payload.integrations || [],
      name: trigger.function_name, source: fn.source, trigger: "scheduled",
      requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: trigger.payload ?? null },
      user: null,
    }), EXEC_TIMEOUT_MS);
    status = res.status < 400 ? "success" : "failed";
    if (status === "failed") error = trunc(typeof res.body === "string" ? res.body : JSON.stringify(res.body?.error || res.body));
    resultPreview = trunc(typeof res.body === "string" ? res.body : JSON.stringify(res.body));
  } catch (e) {
    status = e?.kind === "timeout" ? "timeout" : "failed";
    error = trunc(e?.message || String(e));
  }
  const duration = Date.now() - execStart;

  await svc.entities.ScheduledRun.update(run.id, {
    status, completed_at: new Date().toISOString(), duration_ms: duration,
    error, result_preview: resultPreview, lease_token: null, lease_expires_at: null,
  });

  const computed = trigger.one_time_at ? null : computeNextRun(trigger, now);
  const { patch, pause } = endPatch(trigger, status, error, computed, {
    last_run_at: new Date().toISOString(), last_run_id: run.id,
  });
  await svc.entities.ScheduledTrigger.update(trigger.id, patch);
  if (pause) await notifySchedulePaused(svc, project, trigger, pause, error).catch(() => {});
  return { trigger_id: trigger.id, status, duration_ms: duration, ...(pause ? { paused: pause } : {}) };
}

// One sweep tick. Loads every enabled trigger and advances each. Safe to call
// concurrently: the per-run lease + idempotency key prevent double execution.
export async function processDueTriggers(svc, now = new Date(), scope = null, options = {}) {
  // Optional scope NARROWS the sweep to one project — it never moves the clock. The default
  // (no scope) is the unchanged full sweep. Oldest first, so a bounded batch never starves
  // long-waiting triggers behind newer ones.
  const triggers = await svc.entities.ScheduledTrigger.filter({ enabled: true, ...(scope ? { project_id: scope } : {}) }, "created_date", SWEEP_LIMIT);
  // Bounded batch (worker execution budget): at most SWEEP_BATCH triggers per tick, never
  // past the wall-clock deadline. A trigger left beyond the batch keeps its due slot; the
  // next tick continues. The bounds are NOT raisable by any caller payload — the options
  // parameter is an internal test hook and can only lower them.
  const batchSize = Math.max(1, Math.min(SWEEP_BATCH, Number(options.batch_size) || SWEEP_BATCH));
  const deadline = Math.max(1000, Math.min(SWEEP_DEADLINE_MS, Number(options.deadline_ms) || SWEEP_DEADLINE_MS));
  const startedAt = Date.now();
  const results = [];
  for (const trigger of triggers) {
    if (results.length >= batchSize || Date.now() - startedAt >= deadline) break;
    try { results.push(await processOne(svc, trigger, now)); }
    catch (e) { results.push({ trigger_id: trigger.id, error: trunc(e?.message || String(e)) }); }
  }
  return {
    processed: triggers.length, results,
    ...(triggers.length > results.length ? { remaining: triggers.length - results.length } : {}),
  };
}