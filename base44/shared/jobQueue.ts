// Durable background job queue.
//
// Everything a production queue must guarantee, guaranteed here:
//   * AT-MOST-ONE-WORKER per job — a lease token is written and then re-read, so two workers
//     that claim simultaneously cannot both proceed; the loser walks away.
//   * NO LOST WORK — a worker that dies mid-attempt leaves an expiring lease, and the job
//     becomes reclaimable instead of stalling forever.
//   * BOUNDED RETRIES — failures retry with exponential backoff and jitter, then dead-letter
//     with their full attempt history rather than retrying forever.
//   * IDEMPOTENT ENQUEUE — the same logical work enqueued twice while still in flight returns
//     the existing job, so a retried request does not double-execute.
//   * FAIRNESS — priority first, age second, so nothing starves.
import { log, recordMetric, redact, newTraceId } from "./observability.ts";
// Correlation across the worker boundary: a job carries the trace of whatever enqueued it, so
// work that finishes minutes later on another worker still belongs to the original operation.
import { recordSpan } from "./tracing.ts";

export const QUEUE_CONFIG = {
  default: { concurrency: 4, lease_ms: 60000, max_attempts: 5 },
  // Deployments and AI runs are long and expensive: fewer at once, longer leases, fewer retries.
  builds: { concurrency: 2, lease_ms: 180000, max_attempts: 3 },
  maintenance: { concurrency: 2, lease_ms: 60000, max_attempts: 3 },
  webhooks: { concurrency: 8, lease_ms: 30000, max_attempts: 6 },
  // High-volume, non-critical analytics ingestion: many at once, short leases, few retries.
  analytics: { concurrency: 8, lease_ms: 30000, max_attempts: 3 },
};

export const queueConfig = (queue) => QUEUE_CONFIG[queue] || QUEUE_CONFIG.default;

export const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "dead_letter", "cancelled"];

export class JobLeaseLost extends Error {
  constructor(job_id) { super(`Lease lost for job ${job_id}`); this.code = "LEASE_LOST"; this.status = 409; }
}

const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 300000;

// Exponential backoff with jitter. Jitter is what stops a batch of jobs that failed together
// from retrying in lockstep and re-overloading whatever they failed against.
export function backoffMs(attempt, { jitter = 0.2, base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS } = {}) {
  const raw = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  if (!jitter) return raw;
  const spread = raw * jitter;
  return Math.round(raw - spread + Math.random() * spread * 2);
}

const svcOf = (base44) => base44.asServiceRole || base44;
const nowIso = () => new Date().toISOString();
const token = () => `lease_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * Enqueues work. `idempotency_key` makes the enqueue safe to retry: while an equivalent job is
 * pending or leased, the same key returns that job instead of adding a second one.
 */
export async function enqueue(base44, {
  queue = "default", job_type, payload = {}, priority = 0, max_attempts = null,
  delay_ms = 0, idempotency_key = null, workspace_id = null, project_id = null, trace_id = null,
}) {
  const svc = svcOf(base44);
  if (!job_type) throw new Error("jobQueue: job_type is required");
  const cfg = queueConfig(queue);

  if (idempotency_key) {
    const existing = await svc.entities.BackgroundJob.filter({ queue, idempotency_key }, { sort: "-created_date", limit: 10 }).then((p) => p.items || []);
    const inflight = existing.find((j) => !TERMINAL_JOB_STATUSES.includes(j.status));
    if (inflight) return { job: inflight, duplicate: true };
  }

  const job = await svc.entities.BackgroundJob.create({
    queue, job_type, payload, priority, status: "pending",
    max_attempts: max_attempts && max_attempts > 0 ? max_attempts : cfg.max_attempts,
    available_at: new Date(Date.now() + Math.max(0, delay_ms)).toISOString(),
    attempts: 0, attempt_log: [], idempotency_key, workspace_id, project_id,
    trace_id: trace_id || newTraceId(),
  });
  log("info", "job.enqueued", { job_id: job.id, queue, job_type, trace_id: job.trace_id });
  await recordMetric(base44, { metric: "job.enqueued", labels: { queue, job_type } });
  return { job, duplicate: false };
}

/**
 * Claims up to `limit` jobs for one worker, respecting the queue's concurrency ceiling.
 *
 * A job is claimable when it is pending and due, OR when it is leased but its lease expired
 * (its worker is presumed dead — that attempt is charged so a job that repeatedly kills its
 * worker eventually dead-letters instead of looping).
 */
export async function claim(base44, { queue = "default", worker_id, limit = 1, lease_ms = null, now = Date.now() }) {
  const svc = svcOf(base44);
  const cfg = queueConfig(queue);
  const leaseFor = lease_ms && lease_ms > 0 ? lease_ms : cfg.lease_ms;

  const leased = await svc.entities.BackgroundJob.filter({ queue, status: "leased" }, { sort: "-created_date", limit: 200 }).then((p) => p.items || []);
  const active = leased.filter((j) => j.lease_expires_at && new Date(j.lease_expires_at).getTime() > now);
  const capacity = Math.max(0, cfg.concurrency - active.length);
  if (!capacity) return [];

  const pending = await svc.entities.BackgroundJob.filter({ queue, status: "pending" }, { sort: "created_date", limit: 200 }).then((p) => p.items || []);
  const reclaimable = leased.filter((j) => !j.lease_expires_at || new Date(j.lease_expires_at).getTime() <= now);
  const candidates = [...pending.filter((j) => !j.available_at || new Date(j.available_at).getTime() <= now), ...reclaimable]
    .filter((j) => !j.cancel_requested)
    // Fairness: priority first, then oldest.
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.created_date).localeCompare(String(b.created_date)))
    .slice(0, Math.min(limit, capacity));

  const claimed = [];
  for (const candidate of candidates) {
    const mine = token();
    const wasLost = candidate.status === "leased";
    await svc.entities.BackgroundJob.update(candidate.id, {
      status: "leased", lease_token: mine, worker_id,
      lease_expires_at: new Date(now + leaseFor).toISOString(),
      heartbeat_at: nowIso(), started_at: candidate.started_at || nowIso(),
      ...(wasLost ? {
        attempts: (candidate.attempts || 0) + 1,
        error_code: "WORKER_LOST", last_error: "Previous worker stopped reporting; lease reclaimed",
        attempt_log: [...(candidate.attempt_log || []), { attempt: (candidate.attempts || 0) + 1, error: "worker lost", code: "WORKER_LOST", worker_id: candidate.worker_id, at: nowIso() }],
      } : {}),
    });
    // Confirm the lease actually landed with us: if another worker's write won, we do not run it.
    const fresh = await svc.entities.BackgroundJob.get(candidate.id);
    if (fresh.lease_token !== mine) { log("warn", "job.claim_lost", { job_id: candidate.id, queue }); continue; }
    // A job whose retry budget is spent by worker loss dead-letters here rather than running again.
    if ((fresh.attempts || 0) >= (fresh.max_attempts || 5)) {
      await deadLetter(base44, fresh, { code: fresh.error_code || "ATTEMPTS_EXHAUSTED", error: fresh.last_error || "Retry budget exhausted" });
      continue;
    }
    claimed.push(fresh);
  }
  if (claimed.length) log("info", "job.claimed", { queue, worker_id, count: claimed.length });
  return claimed;
}

const assertLease = (job, lease_token) => { if (!lease_token || job.lease_token !== lease_token) throw new JobLeaseLost(job.id); };

export async function heartbeat(base44, job_id, lease_token, { extend_ms = null } = {}) {
  const svc = svcOf(base44);
  const job = await svc.entities.BackgroundJob.get(job_id);
  assertLease(job, lease_token);
  const cfg = queueConfig(job.queue);
  return svc.entities.BackgroundJob.update(job_id, {
    heartbeat_at: nowIso(),
    lease_expires_at: new Date(Date.now() + (extend_ms && extend_ms > 0 ? extend_ms : cfg.lease_ms)).toISOString(),
  });
}

export async function complete(base44, job_id, lease_token, result = {}) {
  const svc = svcOf(base44);
  const job = await svc.entities.BackgroundJob.get(job_id);
  assertLease(job, lease_token);
  const started = Date.parse(job.started_at || job.created_date);
  const duration_ms = Number.isFinite(started) ? Date.now() - started : 0;
  const done = await svc.entities.BackgroundJob.update(job_id, {
    status: "succeeded", attempts: (job.attempts || 0) + 1, result, lease_token: null,
    completed_at: nowIso(), duration_ms, last_error: null, error_code: null,
  });
  log("info", "job.succeeded", { job_id, queue: job.queue, job_type: job.job_type, duration_ms, trace_id: job.trace_id });
  await recordMetric(base44, { metric: "job.completed", value: duration_ms, labels: { queue: job.queue, job_type: job.job_type } });
  return done;
}

async function deadLetter(base44, job, { code, error }) {
  const svc = svcOf(base44);
  const dead = await svc.entities.BackgroundJob.update(job.id, {
    status: "dead_letter", lease_token: null, error_code: code, last_error: redact(error),
    completed_at: nowIso(),
  });
  log("error", "job.dead_letter", { job_id: job.id, queue: job.queue, job_type: job.job_type, code, error: redact(error), attempts: job.attempts, trace_id: job.trace_id });
  await recordMetric(base44, { metric: "job.dead_letter", labels: { queue: job.queue, job_type: job.job_type, code } });
  return dead;
}

/**
 * Records a failed attempt. Retryable failures go back to pending with backoff until the retry
 * budget is spent; a non-retryable failure (bad input, unknown handler) skips retrying entirely,
 * because repeating deterministic work cannot change its outcome.
 */
export async function fail(base44, job_id, lease_token, error, { retryable = true, code = null } = {}) {
  const svc = svcOf(base44);
  const job = await svc.entities.BackgroundJob.get(job_id);
  assertLease(job, lease_token);
  const attempts = (job.attempts || 0) + 1;
  const message = redact(error?.message || error);
  const errCode = code || error?.code || "HANDLER_ERROR";
  const attempt_log = [...(job.attempt_log || []), { attempt: attempts, error: message, code: errCode, worker_id: job.worker_id, at: nowIso() }];
  await svc.entities.BackgroundJob.update(job_id, { attempts, attempt_log, last_error: message, error_code: errCode });

  if (!retryable || attempts >= (job.max_attempts || 5)) {
    return deadLetter(base44, { ...job, attempts, attempt_log }, { code: retryable ? "ATTEMPTS_EXHAUSTED" : errCode, error: message });
  }
  const delay = backoffMs(attempts);
  const retried = await svc.entities.BackgroundJob.update(job_id, {
    status: "pending", lease_token: null, lease_expires_at: null,
    available_at: new Date(Date.now() + delay).toISOString(),
  });
  log("warn", "job.retry_scheduled", { job_id, queue: job.queue, job_type: job.job_type, attempt: attempts, delay_ms: delay, error: message, trace_id: job.trace_id });
  await recordMetric(base44, { metric: "job.failed", labels: { queue: job.queue, job_type: job.job_type, code: errCode } });
  return retried;
}

// Cooperative cancellation: a pending job stops immediately, an in-flight one is flagged and
// stops at its next checkpoint rather than being killed mid-write.
export async function cancel(base44, job_id, { reason = null } = {}) {
  const svc = svcOf(base44);
  const job = await svc.entities.BackgroundJob.get(job_id);
  if (TERMINAL_JOB_STATUSES.includes(job.status)) return { job, cancelled: false, reason: `already ${job.status}` };
  if (job.status === "pending") {
    const done = await svc.entities.BackgroundJob.update(job_id, { status: "cancelled", cancel_requested: true, error_code: "CANCELLED", last_error: redact(reason || "cancelled"), completed_at: nowIso(), lease_token: null });
    return { job: done, cancelled: true };
  }
  const flagged = await svc.entities.BackgroundJob.update(job_id, { cancel_requested: true });
  return { job: flagged, cancelled: false, reason: "in flight; will stop at next checkpoint" };
}

// Re-queues dead-lettered work with a fresh retry budget, after whatever caused it was fixed.
export async function replayDeadLetter(base44, job_id, { max_attempts = null } = {}) {
  const svc = svcOf(base44);
  const job = await svc.entities.BackgroundJob.get(job_id);
  if (job.status !== "dead_letter") throw Object.assign(new Error(`Job ${job_id} is ${job.status}, not dead-lettered`), { code: "NOT_DEAD_LETTER", status: 409 });
  return svc.entities.BackgroundJob.update(job_id, {
    status: "pending", attempts: 0, available_at: nowIso(), lease_token: null, lease_expires_at: null,
    error_code: null, last_error: null, cancel_requested: false,
    max_attempts: max_attempts && max_attempts > 0 ? max_attempts : job.max_attempts,
  });
}

/**
 * Executes claimed jobs with a handler registry, inside a wall-clock budget so a worker always
 * returns before its request window closes, leaving the rest of the queue for the next tick.
 * An unknown job type is never executed — it dead-letters immediately.
 */
export async function runJobs(base44, { queue = "default", handlers, worker_id = `w_${Math.random().toString(36).slice(2, 8)}`, max_jobs = 5, budget_ms = 45000, lease_ms = null }) {
  const started = Date.now();
  const summary = { queue, worker_id, claimed: 0, succeeded: 0, failed: 0, dead_lettered: 0, skipped: 0, jobs: [] };

  while (summary.claimed < max_jobs && Date.now() - started < budget_ms) {
    const [job] = await claim(base44, { queue, worker_id, limit: 1, lease_ms });
    if (!job) break;
    summary.claimed++;
    const handler = handlers[job.job_type];
    if (!handler) {
      await fail(base44, job.id, job.lease_token, `No handler registered for job type "${job.job_type}"`, { retryable: false, code: "UNKNOWN_JOB_TYPE" });
      summary.dead_lettered++; summary.jobs.push({ id: job.id, job_type: job.job_type, outcome: "dead_letter" });
      continue;
    }
    if (job.cancel_requested) {
      await cancel(base44, job.id, { reason: "cancelled before execution" });
      summary.skipped++; summary.jobs.push({ id: job.id, job_type: job.job_type, outcome: "cancelled" });
      continue;
    }
    try {
      const result = await handler(job, {
        base44,
        heartbeat: () => heartbeat(base44, job.id, job.lease_token),
        // Handlers check this at safe points, so cancellation never interrupts a partial write.
        cancelled: async () => !!(await svcOf(base44).entities.BackgroundJob.get(job.id)).cancel_requested,
      });
      await complete(base44, job.id, job.lease_token, result && typeof result === "object" ? result : { value: result ?? null });
      summary.succeeded++; summary.jobs.push({ id: job.id, job_type: job.job_type, outcome: "succeeded" });
      await recordSpan(base44, {
        trace_id: job.trace_id, workspace_id: job.workspace_id || null, project_id: job.project_id || null,
        job_id: job.id, event_type: "background_job", name: job.job_type, status: "ok",
        // The attempt number is the job's own, so a job that ran three times reads as three
        // attempts of one operation rather than three separate pieces of work.
        attempt: (job.attempts || 0) + 1, reference_id: job.id, metadata: { queue, worker_id },
      });
    } catch (e) {
      const out = await fail(base44, job.id, job.lease_token, e, { retryable: e.retryable !== false, code: e.code });
      await recordSpan(base44, {
        trace_id: job.trace_id, workspace_id: job.workspace_id || null, project_id: job.project_id || null,
        job_id: job.id, event_type: "background_job", name: job.job_type, status: "error",
        error: e, error_code: e.code || "HANDLER_ERROR", attempt: (job.attempts || 0) + 1,
        reference_id: job.id, metadata: { queue, worker_id, outcome: out.status },
      });
      if (out.status === "dead_letter") summary.dead_lettered++; else summary.failed++;
      summary.jobs.push({ id: job.id, job_type: job.job_type, outcome: out.status, error: redact(e.message) });
    }
  }
  summary.duration_ms = Date.now() - started;
  return summary;
}

// Releases leases whose worker stopped reporting, so lost work becomes claimable again instead
// of sitting "in progress" forever. Charging the attempt is what bounds a poison job.
export async function reapExpiredLeases(base44, { queue = null, now = Date.now() } = {}) {
  const svc = svcOf(base44);
  const leased = await svc.entities.BackgroundJob.filter({ status: "leased", ...(queue ? { queue } : {}) }, { sort: "-created_date", limit: 200 }).then((p) => p.items || []);
  const expired = leased.filter((j) => j.lease_expires_at && new Date(j.lease_expires_at).getTime() <= now);
  const out = { reaped: 0, dead_lettered: 0 };
  for (const job of expired) {
    const attempts = (job.attempts || 0) + 1;
    const attempt_log = [...(job.attempt_log || []), { attempt: attempts, error: "worker lost", code: "WORKER_LOST", worker_id: job.worker_id, at: nowIso() }];
    if (attempts >= (job.max_attempts || 5)) {
      await svc.entities.BackgroundJob.update(job.id, { attempts, attempt_log });
      await deadLetter(base44, { ...job, attempts }, { code: "WORKER_LOST", error: "Worker stopped reporting and the retry budget is exhausted" });
      out.dead_lettered++;
      continue;
    }
    await svc.entities.BackgroundJob.update(job.id, {
      status: "pending", attempts, attempt_log, lease_token: null, lease_expires_at: null,
      error_code: "WORKER_LOST", last_error: "Worker stopped reporting; job requeued",
      available_at: new Date(now + backoffMs(attempts)).toISOString(),
    });
    out.reaped++;
  }
  if (out.reaped || out.dead_lettered) log("warn", "job.leases_reaped", out);
  return out;
}

export async function queueStats(base44, { queue = null } = {}) {
  const svc = svcOf(base44);
  const stats = { queues: {}, totals: { pending: 0, leased: 0, succeeded: 0, failed: 0, dead_letter: 0, cancelled: 0 } };
  for (const status of ["pending", "leased", "dead_letter", "succeeded", "cancelled"]) {
    const rows = await svc.entities.BackgroundJob.filter({ status, ...(queue ? { queue } : {}) }, { sort: "-created_date", limit: 500 }).then((p) => p.items || []).catch(() => []);
    for (const row of rows) {
      const q = (stats.queues[row.queue] ||= { pending: 0, leased: 0, succeeded: 0, dead_letter: 0, cancelled: 0, concurrency: queueConfig(row.queue).concurrency });
      q[status] = (q[status] || 0) + 1;
      stats.totals[status] = (stats.totals[status] || 0) + 1;
    }
  }
  return stats;
}