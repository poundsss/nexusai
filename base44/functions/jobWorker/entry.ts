// Queue worker. Runs on a schedule and drains the durable job queue.
//
// Safety properties this endpoint relies on, all enforced by the queue itself:
//   * one worker per job (lease token verified after every claim),
//   * a wall-clock budget, so the worker always returns and the next tick continues the queue,
//   * expired leases reclaimed before claiming, so work lost to a dead worker is picked back up,
//   * bounded retries with backoff, then dead-letter with the full attempt history.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runJobs, reapExpiredLeases, enqueue, queueStats } from "../../shared/jobQueue.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";
import { MAINTENANCE_HANDLERS, MAINTENANCE_SCHEDULE } from "../../shared/jobHandlers.ts";
import { log, newTraceId } from "../../shared/observability.ts";

const QUEUES = ["maintenance", "default", "webhooks", "builds"];

export default async function (req) {
  // P-1: the queue drain acts with the service role across all workspaces, so it
  // authenticates the caller first — the same G-3 worker boundary. A workflow
  // invocation passes via its x-workflow-run marker; anything else needs the secret.
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const worker_id = String(body.worker_id || `w_${Date.now().toString(36)}`);
  const budget_ms = Math.min(45000, Number(body.budget_ms) || 40000);
  const trace_id = newTraceId();

  // Lost work first: a job whose worker died must become claimable before we claim anything new.
  const reaped = await reapExpiredLeases(base44);

  // Recurring housekeeping, enqueued idempotently per hour so repeated ticks do not pile up.
  const hour = new Date().toISOString().slice(0, 13);
  const scheduled = [];
  if (body.skip_maintenance !== true) {
    for (const item of MAINTENANCE_SCHEDULE) {
      const { duplicate } = await enqueue(base44, { ...item, idempotency_key: `${item.job_type}:${hour}`, trace_id });
      if (!duplicate) scheduled.push(item.job_type);
    }
  }

  const queues = Array.isArray(body.queues) && body.queues.length ? body.queues.filter((q) => QUEUES.includes(q)) : QUEUES;
  const perQueueBudget = Math.floor(budget_ms / queues.length);
  const runs = [];
  for (const queue of queues) {
    runs.push(await runJobs(base44, {
      queue, handlers: MAINTENANCE_HANDLERS, worker_id,
      max_jobs: Number(body.max_jobs) || 5, budget_ms: perQueueBudget,
    }));
  }

  const totals = runs.reduce((acc, r) => ({
    claimed: acc.claimed + r.claimed, succeeded: acc.succeeded + r.succeeded,
    failed: acc.failed + r.failed, dead_lettered: acc.dead_lettered + r.dead_lettered,
  }), { claimed: 0, succeeded: 0, failed: 0, dead_lettered: 0 });
  log("info", "worker.tick", { worker_id, trace_id, ...totals, reaped: reaped.reaped });

  return Response.json({ worker_id, trace_id, reaped, scheduled, totals, runs, stats: await queueStats(base44) });
}