// The worker's handler registry.
//
// A job may only run work that appears HERE. A job_type is a key into this map, never a code
// path or a function name taken from the payload — so an attacker who could somehow write a job
// row still cannot make a worker execute arbitrary platform functions.
import { purgeExpired, invalidateNamespace } from "./cache.ts";
import { purgeOldBuckets } from "./apiLimits.ts";
import { reapExpiredLeases } from "./jobQueue.ts";
import { log } from "./observability.ts";
import { reconcileAbandonedOperations } from "./aiOperations.ts";
import { deliverQueuedWebhook } from "./webhookDelivery.ts";
import { deliverConnectorAutomation, AUTOMATION_JOB_TYPE } from "./connectorAutomations.ts";
import { assertSingleton, enforceRetention, cleanupStagingBlobs, cleanupOrphanVerification, pruneLogs, cleanupDeadLetters, cleanupPackageSupply, cleanupAppAnalytics, runBillingMaintenance } from "./maintenance.ts";
import { processQueuedIngestion } from "./analyticsIngest.ts";
import { ANALYTICS_JOB_TYPE } from "./analyticsContract.ts";
import { invokePrimitiveAsSystem, PRIMITIVE_JOB_TYPE } from "./primitives.ts";
import { resolvePrimitive } from "./primitiveContract.ts";
import { advanceWorkflowRun } from "./workflowEngine.ts";
import { WORKFLOW_JOB_TYPE } from "./workflowContract.ts";
import { executeRestoreBatch } from "./dataHistory.ts";
import { executeSecurityScan, SECURITY_SCAN_JOB_TYPE } from "./securityScan.ts";
import { executeViralityImageJob, VIRALITY_IMAGE_JOB_TYPE } from "./virality.ts";
import { executeViralityScheduleJob, SCHEDULE_JOB_TYPE, executeViralityPublishJob, PUBLISH_JOB_TYPE } from "./socialCalendar.ts";
import { executeOutreachEmailStep, OUTREACH_JOB_TYPE } from "./outreach.ts";
import { executeListenMonitorJob, LISTEN_JOB_TYPE } from "./growListening.ts";
import { executeColdCallJob, COLD_CALL_JOB_TYPE } from "./coldCalling.ts";
import { executeAdsReportJob, ADS_REPORT_JOB_TYPE } from "./adsReporting.ts";
import { executeAeoJob, AEO_JOB_TYPE } from "./growAeo.ts";
import { executeSupportMessage, SUPPORT_JOB_TYPE } from "./growSupport.ts";

// Scoping a sweep from a payload is allowed only to NARROW it (ids), never to move its clock:
// `now` is always the worker's, so a forged payload cannot make live data look expired.
const ids = (v) => (Array.isArray(v) && v.length ? v.map(String).slice(0, 50) : null);
const sweep = (fn, args) => async (job, ctx) => { await assertSingleton(ctx.base44, job); return fn(ctx.base44, args(job.payload || {})); };

// Background functions a job is allowed to trigger. Anything not listed is refused, so the
// allowlist — not the payload — decides what the platform will run.
export const INVOKABLE_FUNCTIONS = ["reapStaleRuns", "runScheduledTriggers", "deployStep", "agentStep", "aiRunStep", "githubSyncStep"];

export const MAINTENANCE_HANDLERS = {
  "cache.purge_expired": async (job, { base44 }) => purgeExpired(base44, { limit: job.payload?.limit || 300 }),

  "cache.invalidate_namespace": async (job, { base44 }) => {
    const namespace = String(job.payload?.namespace || "");
    if (!namespace) throw Object.assign(new Error("namespace is required"), { retryable: false, code: "INVALID_PAYLOAD" });
    return invalidateNamespace(base44, namespace);
  },

  "ratelimit.purge": async (job, { base44 }) => purgeOldBuckets(base44, { olderThanMs: job.payload?.older_than_ms || 86400000 }),

  "queue.reap_leases": async (job, { base44 }) => reapExpiredLeases(base44, { queue: job.payload?.queue || null }),

  // Data Version History: the queued data-restore executor. Idempotent (a retry converges),
  // so the queue's bounded retries are safe.
  "data.restore_batch": async (job, { base44 }) => {
    const batchId = String(job.payload?.batch_id || "");
    if (!batchId) throw Object.assign(new Error("batch_id is required"), { retryable: false, code: "INVALID_PAYLOAD" });
    return executeRestoreBatch(base44.asServiceRole || base44, batchId);
  },

  // Fan-out to an allowlisted background function. Bad input is non-retryable on purpose:
  // retrying a payload that can never be valid only burns capacity.
  "platform.invoke_function": async (job, { base44 }) => {
    const name = String(job.payload?.function_name || "");
    if (!INVOKABLE_FUNCTIONS.includes(name)) {
      throw Object.assign(new Error(`Function "${name}" is not invokable from a job`), { retryable: false, code: "FUNCTION_NOT_ALLOWED" });
    }
    const res = await (base44.asServiceRole || base44).functions.invoke(name, job.payload?.args || {});
    log("info", "job.invoked_function", { function_name: name, job_id: job.id });
    return { function_name: name, ok: true, data: res?.data ?? null };
  },

  // Credit recovery. An operation whose worker died still holds its reservation and carries the
  // real usage it accumulated; this settles it from that usage and releases the hold. It is the
  // SAME sweep an owner can trigger manually from the billing page (commerce → reconcile) —
  // scheduled here so recovery does not depend on someone noticing.
  "billing.reconcile_operations": async (job, { base44, heartbeat }) => {
    const db = base44.asServiceRole || base44;
    const older_than_ms = Number(job.payload?.older_than_ms) || 15 * 60 * 1000;
    const workspaces = await db.entities.Workspace.filter({ status: "active" }, "-updated_date", 200);
    const reconciled = [];
    for (const ws of workspaces) {
      const settled = await reconcileAbandonedOperations(db, { workspace_id: ws.id, older_than_ms });
      if (settled.length) reconciled.push({ workspace_id: ws.id, settled });
      await heartbeat();
    }
    if (reconciled.length) log("info", "billing.operations_reconciled", { workspaces: reconciled.length, job_id: job.id });
    return { workspaces_scanned: workspaces.length, reconciled };
  },

  // Scheduled billing lifecycle (P-8.3): due subscription transitions (trial expiry, downgrade at
  // period end, cancel-at-period-end expiry), entitlement recalculation and period-keyed credit
  // rollover — through the same functions the on-read path uses, so the ledger stays the only
  // credit truth. Suspended/terminated workspaces are skipped; `now` is always the worker's.
  "billing.apply_scheduled_changes": sweep(runBillingMaintenance, (p) => ({ workspace_ids: ids(p.workspace_ids) })),

  // Retry of a VERIFIED webhook delivery that failed. The signature was already checked at the
  // edge, so this never re-opens the public path; it only re-runs the project function. Failing
  // here is what drives backoff and, once the attempt budget is spent, dead-lettering.
  "webhook.deliver": async (job, { base44 }) => deliverQueuedWebhook(base44, job.payload || {}),

  // Backend Connector Automations: delivery of a verified, already-deduplicated connector event
  // to a generated function's config.automations subscription. The ingest claim covered replay;
  // this only executes the project function through the existing executor. A 5xx (or a thrown
  // handler) retries with backoff and then dead-letters — the same machinery as webhook.deliver.
  [AUTOMATION_JOB_TYPE]: async (job, { base44 }) => deliverConnectorAutomation(base44, job.payload || {}),

  // Scheduled maintenance sweeps. Each is singleton-guarded (one leased job per type), idempotent
  // and conservative — see shared/maintenance.ts for what each one refuses to touch.
  "retention.enforce": sweep(enforceRetention, (p) => ({ workspace_ids: ids(p.workspace_ids) })),
  "storage.cleanup_staging": sweep(cleanupStagingBlobs, (p) => ({ project_ids: ids(p.project_ids) })),
  "verification.cleanup_orphans": sweep(cleanupOrphanVerification, (p) => ({ project_ids: ids(p.project_ids) })),
  "logs.prune": sweep(pruneLogs, (p) => ({ project_ids: ids(p.project_ids) })),
  "queue.cleanup_dead_letters": sweep(cleanupDeadLetters, (p) => ({ queues: ids(p.queues) })),
  "packages.cleanup_supply": sweep(cleanupPackageSupply, (p) => ({ project_ids: ids(p.project_ids) })),
  // Generated-app analytics retention (#30), applied per project from its own configuration.
  "analytics.cleanup": sweep(cleanupAppAnalytics, (p) => ({ project_ids: ids(p.project_ids) })),

  // Deferred ANALYTICS ingestion (#30). The project comes from the job row, and the queued events
  // are re-validated against the same contract the synchronous path uses — so a queued submission
  // can neither reach another project nor bypass validation, redaction or idempotency.
  [ANALYTICS_JOB_TYPE]: async (job, { base44 }) => {
    if (!job.payload?.project_id) throw Object.assign(new Error("analytics.ingest requires project_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    return processQueuedIngestion(base44, job.payload);
  },

  // A deferred PRIMITIVE (#27), continuing an invocation that was already authorized when it was
  // enqueued. The payload can only name a registry primitive and the project the job row carries,
  // so the queue cannot reach a project or capability the enqueuing caller lacked. Retries,
  // backoff and dead-lettering are this queue's — the primitive layer adds no second worker.
  [PRIMITIVE_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id || !p.primitive) {
      throw Object.assign(new Error("primitive.invoke requires project_id and primitive"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    // The job id is the natural idempotency key for a retried attempt, but only a primitive whose
    // contract SUPPORTS idempotency may receive one — a read-only primitive is re-executed instead.
    const target = resolvePrimitive(String(p.primitive), p.version || null);
    const res = await invokePrimitiveAsSystem(base44, {
      project_id: String(p.project_id), primitive: String(p.primitive), version: p.version || null,
      input: p.input || {}, trace_id: job.trace_id || p.trace_id || null, job_id: job.id,
      idempotency_key: target?.idempotency?.supported ? `job:${job.id}` : null,
    });
    // A failed primitive fails the JOB with its own classification, so the queue's existing retry
    // policy applies to transient failures and a deterministic one dead-letters immediately.
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code, retryable: res.error.retryable });
    return { primitive: res.primitive, version: res.version, invocation_id: res.invocation_id, output: res.output };
  },

  // One durable advance of a WORKFLOW run (#28), continuing a run that was already authorized when
  // it was triggered. The payload can only name a run row, whose project and definition version are
  // read from the record — so the queue cannot reach a project or a definition the trigger lacked.
  // Retries, backoff and dead-lettering are this queue's; the workflow layer adds no second worker.
  [WORKFLOW_JOB_TYPE]: async (job, { base44 }) => {
    const workflow_run_id = String(job.payload?.workflow_run_id || "");
    if (!workflow_run_id) throw Object.assign(new Error("workflow.advance requires workflow_run_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    const res = await advanceWorkflowRun(base44, { workflow_run_id, job_id: job.id });
    return { workflow_run_id, status: res.status, outcome: res.outcome || null, current_step: res.current_step || null };
  },

  // Base44 Security Scan executor: the queued background scan. The payload can only name a
  // scan row (its project/workspace are read from the record), so the queue cannot reach a
  // project the enqueuing caller was not authorized against. The executor is idempotent and
  // resolves terminal states itself, so a retry converges instead of duplicating scans.
  [SECURITY_SCAN_JOB_TYPE]: async (job, { base44 }) => {
    const scanId = String(job.payload?.scan_id || "");
    if (!scanId) throw Object.assign(new Error("security.scan requires scan_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    const row = await executeSecurityScan(base44.asServiceRole || base44, scanId);
    return { scan_id: scanId, status: row.status };
  },

  // Virality Engine background post image (#documented inline/background split): the payload
  // can only name a plan post of the project the job row carries, so the queue cannot reach
  // another project's plan. The executor is idempotent and resolves terminal states itself
  // (ready/failed posts are skipped), so a retry converges instead of duplicating images.
  [VIRALITY_IMAGE_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id || !p.plan_id || !p.post_id) {
      throw Object.assign(new Error("virality.image requires project_id, plan_id and post_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    const out = await executeViralityImageJob(base44.asServiceRole || base44, { project_id: String(p.project_id), plan_id: String(p.plan_id), post_id: String(p.post_id) });
    return out;
  },

  // Virality Phase 2 scheduling job: selects the calendar's scheduled posts inside
  // [scheduled_from, scheduled_until) and materializes each into ONE idempotent publish job
  // (the queue's duplicate-publication guard). The executor converges, so retries are safe.
  [SCHEDULE_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id || !p.scheduled_from || !p.scheduled_until) {
      throw Object.assign(new Error("virality.schedule requires project_id, scheduled_from and scheduled_until"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    return executeViralityScheduleJob(base44.asServiceRole || base44, {
      project_id: String(p.project_id), scheduled_from: String(p.scheduled_from), scheduled_until: String(p.scheduled_until),
    });
  },

  // Virality Phase 2 per-post publisher: idempotent (posted/failed/needs_reconnect rows are
  // skipped; a stale in-flight marker converges to publish_outcome_unknown), so retries are
  // safe. A failed post is NEVER retried by this handler — that convergence is the executor's.
  [PUBLISH_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id || !p.post_id) {
      throw Object.assign(new Error("virality.publish requires project_id and post_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    return executeViralityPublishJob(base44.asServiceRole || base44, { project_id: String(p.project_id), post_id: String(p.post_id) });
  },

  // Runable Grow — Phase 3: the queued cold-email step. The payload can only name a contact
  // of the project the job row carries, so the queue cannot reach another project's pipeline.
  // The executor is idempotent (a step whose job already succeeded is skipped, not resent), so
  // the queue's bounded retries and dead-letter policy are safe for email.
  [OUTREACH_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id || !p.customer_id || !Number.isFinite(Number(p.step_index))) {
      throw Object.assign(new Error("outreach email requires project_id, customer_id and step_index"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    return executeOutreachEmailStep(base44.asServiceRole || base44, {
      project_id: String(p.project_id), customer_id: String(p.customer_id), step_index: Number(p.step_index),
      subject: String(p.subject || ""), body: String(p.body || ""),
    });
  },

  // Runable Grow — Phase 4: the queued social-listening monitor. The payload can only name the
  // project the job row carries; the executor reads the project itself and keeps the interval
  // chain alive only while active terms remain. One idempotent run per interval bucket.
  [LISTEN_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id) {
      throw Object.assign(new Error("listen monitor requires project_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    return executeListenMonitorJob(base44.asServiceRole || base44, {
      project_id: String(p.project_id), interval_minutes: Number(p.interval_minutes) || undefined,
    });
  },

  // Runable Grow — Phase 5: the queued AEO measurement. The payload can only name the project
  // the job row carries; the executor reads the project itself and keeps the interval chain
  // alive only while active probes remain. One idempotent run per interval bucket.
  [AEO_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id) {
      throw Object.assign(new Error("aeo job requires project_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    return executeAeoJob(base44.asServiceRole || base44, {
      project_id: String(p.project_id), interval_minutes: Number(p.interval_minutes) || undefined,
    });
  },

  // Runable Grow — Phase 7: the queued OUTBOUND-ONLY support message. The payload can only name
  // a contact of the project the job row carries; the executor is idempotent (a message whose
  // job already succeeded is skipped, never resent) and never advances the pipeline stage.
  [SUPPORT_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id || !p.customer_id) {
      throw Object.assign(new Error("support message requires project_id and customer_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    return executeSupportMessage(base44.asServiceRole || base44, {
      project_id: String(p.project_id), customer_id: String(p.customer_id),
      subject: String(p.subject || ""), body: String(p.body || ""),
    });
  },

  // Runable Grow — the queued cold-call DIAL. The payload can only name a call of the project
  // the job row carries. The executor is the fail-closed telephony adapter: the dial refuses
  // with the certified blocker, the call converges to terminal failed, and NOTHING is fabricated.
  [COLD_CALL_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id || !p.call_id) {
      throw Object.assign(new Error("cold call requires project_id and call_id"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    return executeColdCallJob(base44.asServiceRole || base44, {
      project_id: String(p.project_id), call_id: String(p.call_id),
    });
  },

  // Runable Grow — the queued WEEKLY ads performance report. The payload can only name the
  // project the job row carries and one registered channel; the executor reads the project
  // itself and keeps the weekly chain alive only while an ACTIVE account remains.
  [ADS_REPORT_JOB_TYPE]: async (job, { base44 }) => {
    const p = job.payload || {};
    if (!p.project_id || !p.channel) {
      throw Object.assign(new Error("ads weekly report requires project_id and channel"), { retryable: false, code: "INVALID_PAYLOAD" });
    }
    return executeAdsReportJob(base44.asServiceRole || base44, {
      project_id: String(p.project_id), channel: String(p.channel), source_job_id: String(job.id || "") || null,
    });
  },

  // Heartbeat-only job used to prove the worker path is alive end to end.
  "platform.ping": async (job, { heartbeat }) => { await heartbeat(); return { pong: true, at: new Date().toISOString() }; },
};

// The recurring maintenance schedule. Each entry is enqueued with an hour-keyed idempotency
// key, so a worker tick that runs twice in the same hour does not queue the work twice.
export const MAINTENANCE_SCHEDULE = [
  { job_type: "cache.purge_expired", queue: "maintenance", payload: {} },
  { job_type: "ratelimit.purge", queue: "maintenance", payload: {} },
  { job_type: "queue.reap_leases", queue: "maintenance", payload: {} },
  { job_type: "billing.reconcile_operations", queue: "maintenance", payload: {} },
  { job_type: "billing.apply_scheduled_changes", queue: "maintenance", payload: {} },
  { job_type: "retention.enforce", queue: "maintenance", payload: {} },
  { job_type: "storage.cleanup_staging", queue: "maintenance", payload: {} },
  { job_type: "verification.cleanup_orphans", queue: "maintenance", payload: {} },
  { job_type: "logs.prune", queue: "maintenance", payload: {} },
  { job_type: "queue.cleanup_dead_letters", queue: "maintenance", payload: {} },
  { job_type: "packages.cleanup_supply", queue: "maintenance", payload: {} },
  { job_type: "analytics.cleanup", queue: "maintenance", payload: {} },
];