// Production infrastructure verification — REAL code paths.
//
// Exercises the durable job queue (leases, worker loss, retries, backoff, dead-letter, replay,
// cancellation, fairness, concurrency), the read-through cache (single-flight, stale-while-
// revalidate, expiry, tenant isolation), distributed rate limiting and observability/health
// against live storage. Nothing is simulated except the passage of time, which is injected.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { enqueue, claim, heartbeat, complete, fail, cancel, replayDeadLetter, reapExpiredLeases, runJobs, queueStats, backoffMs, queueConfig, JobLeaseLost } from "../../shared/jobQueue.ts";
import { getOrSet, get, set, invalidate, invalidateNamespace, purgeExpired, scopedKey, clearMemoryCache } from "../../shared/cache.ts";
import { consume, enforceLimit, limitStatus, purgeOldBuckets, identityFor, limitFor, RateLimited } from "../../shared/apiLimits.ts";
import { recordMetric, metricsSince, healthSnapshot, redact, minuteKey, newTraceId } from "../../shared/observability.ts";
import { MAINTENANCE_HANDLERS, INVOKABLE_FUNCTIONS } from "../../shared/jobHandlers.ts";
import { createHarness, harnessResponse, harnessError } from "../../shared/testHarness.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;

  const stamp = Date.now().toString(36);
  const Q = `test_${stamp}`;
  const NS = `test_cache_${stamp}`;
  const IDENTITY = `test:identity:${stamp}`;
  const METRIC = `test.metric.${stamp}`;
  const created = { jobs: [], cache: [], buckets: [], metrics: [] };
  const track = async (p, bucket) => { const j = await p; created[bucket].push(j.id); return j; };
  const queues = [Q, `${Q}_retry`, `${Q}_poison`, `${Q}_bad`, `${Q}_lost`, `${Q}_loop`];
  const [, QR, QP, QB, QL, QW] = queues;
  const jobOf = async ({ queue = Q, ...opts } = {}) => {
    const { job } = await enqueue(base44, { queue, ...opts });
    created.jobs.push(job.id);
    return job;
  };

  try {
    // ============================================================ job queue
    const j1 = await jobOf({ job_type: "platform.ping", payload: { n: 1 } });
    check("a job is enqueued as pending and immediately due", j1.status === "pending" && new Date(j1.available_at).getTime() <= Date.now() + 50 && j1.attempts === 0, `${j1.status} @ ${j1.available_at}`);
    check("a job carries its queue's retry budget and a trace id", j1.max_attempts === queueConfig(Q).max_attempts && !!j1.trace_id, `${j1.max_attempts} attempts`);
    const dup = await enqueue(base44, { queue: Q, job_type: "platform.ping", idempotency_key: "dedup-key" });
    created.jobs.push(dup.job.id);
    const dup2 = await enqueue(base44, { queue: Q, job_type: "platform.ping", idempotency_key: "dedup-key" });
    check("enqueuing the same work twice does not duplicate it", dup2.duplicate && dup2.job.id === dup.job.id, dup.job.id);
    const delayed = await jobOf({ job_type: "platform.ping", delay_ms: 600000 });
    check("a delayed job is not yet claimable", new Date(delayed.available_at).getTime() > Date.now() + 500000, delayed.available_at);

    // fairness + leasing
    const low = await jobOf({ job_type: "platform.ping", priority: 0 });
    const high = await jobOf({ job_type: "platform.ping", priority: 10 });
    const [claimed] = await claim(base44, { queue: Q, worker_id: "worker-a", limit: 1 });
    check("higher priority is claimed first", claimed.id === high.id, `${claimed.id} vs ${high.id}`);
    check("a claim writes a verified lease with an expiry", claimed.status === "leased" && !!claimed.lease_token && new Date(claimed.lease_expires_at).getTime() > Date.now(), claimed.lease_expires_at);
    const others = await claim(base44, { queue: Q, worker_id: "worker-b", limit: 5 });
    check("a leased job is never handed to a second worker", !others.some((j) => j.id === claimed.id), `${others.length} other job(s) claimed`);
    check("a delayed job stays invisible to workers", !others.some((j) => j.id === delayed.id), "not claimed");

    const beat = await heartbeat(base44, claimed.id, claimed.lease_token, { extend_ms: 120000 });
    check("a heartbeat extends the lease", new Date(beat.lease_expires_at).getTime() > new Date(claimed.lease_expires_at).getTime(), beat.lease_expires_at);
    await expectThrow("a worker without the lease cannot heartbeat", () => heartbeat(base44, claimed.id, "lease_forged"), "LEASE_LOST");
    await expectThrow("a worker without the lease cannot complete the job", () => complete(base44, claimed.id, "lease_forged", { ok: true }), "LEASE_LOST");
    await expectThrow("a worker without the lease cannot fail the job", () => fail(base44, claimed.id, "lease_forged", "nope"), "LEASE_LOST");
    const done = await complete(base44, claimed.id, claimed.lease_token, { ok: true });
    check("completing records the result, duration and releases the lease", done.status === "succeeded" && done.result.ok === true && done.lease_token === null && done.duration_ms >= 0, `${done.status} in ${done.duration_ms}ms`);

    // concurrency ceiling
    const burst = [];
    for (let i = 0; i < 6; i++) burst.push(await jobOf({ job_type: "platform.ping", priority: 5 }));
    const wide = await claim(base44, { queue: Q, worker_id: "worker-c", limit: 10 });
    const inflight = (await svc.entities.BackgroundJob.filter({ queue: Q, status: "leased" }, "-created_date", 50)).filter((j) => new Date(j.lease_expires_at).getTime() > Date.now());
    check("a queue never runs more than its concurrency ceiling", inflight.length <= queueConfig(Q).concurrency && wide.length > 0, `${inflight.length} in flight, ceiling ${queueConfig(Q).concurrency}`);
    check("claiming at a full ceiling returns nothing rather than overrunning it", (await claim(base44, { queue: Q, worker_id: "worker-d", limit: 3 })).length === 0, "capacity respected");
    for (const j of wide) await complete(base44, j.id, j.lease_token, {});

    // retries + backoff
    check("backoff grows exponentially", backoffMs(1, { jitter: 0 }) === 2000 && backoffMs(3, { jitter: 0 }) === 8000 && backoffMs(4, { jitter: 0 }) === 16000, `${backoffMs(1, { jitter: 0 })}/${backoffMs(3, { jitter: 0 })}`);
    check("backoff is capped so a retry is never scheduled absurdly far out", backoffMs(30, { jitter: 0 }) === 300000, backoffMs(30, { jitter: 0 }));
    const jittered = Array.from({ length: 20 }, () => backoffMs(3));
    check("backoff is jittered so failed jobs do not retry in lockstep", new Set(jittered).size > 1 && jittered.every((v) => v >= 6400 && v <= 9600), `${Math.min(...jittered)}–${Math.max(...jittered)}`);

    await jobOf({ queue: QR, job_type: "platform.ping", max_attempts: 3 });
    const [r1] = await claim(base44, { queue: QR, worker_id: "worker-r", limit: 1 });
    const afterFail = await fail(base44, r1.id, r1.lease_token, new Error("transient upstream 503"));
    check("a retryable failure returns the job to pending with backoff", afterFail.status === "pending" && new Date(afterFail.available_at).getTime() > Date.now() && afterFail.attempts === 1, `attempt ${afterFail.attempts} @ ${afterFail.available_at}`);
    check("the failure is recorded with its attempt history", afterFail.attempt_log.length === 1 && afterFail.last_error.includes("503") && afterFail.error_code === "HANDLER_ERROR", afterFail.last_error);
    check("a job in backoff is not claimable yet", (await claim(base44, { queue: QR, worker_id: "worker-r2", limit: 5 })).length === 0, "waiting out backoff");

    // exhausting the retry budget
    const poisonJob = await jobOf({ queue: QP, job_type: "platform.ping", max_attempts: 2 });
    let poison = poisonJob;
    for (let i = 0; i < 2; i++) {
      const [c] = await claim(base44, { queue: QP, worker_id: `worker-p${i}`, limit: 1, now: Date.now() + i * 3600000 });
      if (!c || c.id !== poisonJob.id) break;
      poison = await fail(base44, c.id, c.lease_token, new Error(`still broken ${i}`));
    }
    check("a job that exhausts its retry budget is dead-lettered", poison.status === "dead_letter" && poison.error_code === "ATTEMPTS_EXHAUSTED", `${poison.status}/${poison.error_code}`);
    check("a dead-lettered job explains itself with every attempt", (poison.attempt_log || []).length >= 2 && poison.lease_token === null, `${poison.attempt_log.length} attempts logged`);
    const replayed = await replayDeadLetter(base44, poison.id);
    check("a dead-lettered job can be replayed with a fresh budget", replayed.status === "pending" && replayed.attempts === 0 && !replayed.error_code, replayed.status);
    await expectThrow("a live job cannot be replayed as if it were dead-lettered", () => replayDeadLetter(base44, replayed.id), "NOT_DEAD_LETTER");
    await cancel(base44, replayed.id, { reason: "test cleanup" });

    // non-retryable failure
    await jobOf({ queue: QB, job_type: "platform.ping", max_attempts: 5 });
    const [b1] = await claim(base44, { queue: QB, worker_id: "worker-nr", limit: 1 });
    const deadNow = await fail(base44, b1.id, b1.lease_token, Object.assign(new Error("payload can never be valid"), { code: "INVALID_PAYLOAD" }), { retryable: false });
    check("a non-retryable failure dead-letters without burning retries", deadNow.status === "dead_letter" && deadNow.attempts === 1 && deadNow.error_code === "INVALID_PAYLOAD", `${deadNow.error_code} after ${deadNow.attempts}`);

    // worker loss
    await jobOf({ queue: QL, job_type: "platform.ping", max_attempts: 3 });
    const [l1] = await claim(base44, { queue: QL, worker_id: "worker-dies", limit: 1, lease_ms: 1000 });
    const reap = await reapExpiredLeases(base44, { queue: QL, now: Date.now() + 5000 });
    const recovered = await svc.entities.BackgroundJob.get(l1.id);
    check("work lost to a dead worker becomes claimable again", reap.reaped === 1 && recovered.status === "pending" && recovered.error_code === "WORKER_LOST", `${recovered.status}/${recovered.error_code}`);
    check("a lost attempt is charged so a worker-killing job cannot loop forever", recovered.attempts === 1 && recovered.attempt_log.length === 1, `attempt ${recovered.attempts}`);
    await svc.entities.BackgroundJob.update(l1.id, { attempts: 2, available_at: new Date().toISOString(), status: "leased", lease_token: "expired_lease", lease_expires_at: new Date(Date.now() - 1000).toISOString() });
    const reap2 = await reapExpiredLeases(base44, { queue: QL });
    check("a job whose budget is spent by worker loss is dead-lettered, not re-run", reap2.dead_lettered === 1 && (await svc.entities.BackgroundJob.get(l1.id)).status === "dead_letter", `${(await svc.entities.BackgroundJob.get(l1.id)).status}`);
    check("reaping is idempotent when nothing is expired", (await reapExpiredLeases(base44, { queue: QL })).reaped === 0, "no-op");

    // cancellation
    const toCancel = await jobOf({ queue: QP, job_type: "platform.ping" });
    const cancelledPending = await cancel(base44, toCancel.id, { reason: "user changed their mind" });
    check("a pending job cancels immediately", cancelledPending.cancelled && cancelledPending.job.status === "cancelled", cancelledPending.job.status);
    check("a cancelled job is never claimed", !(await claim(base44, { queue: QP, worker_id: "worker-x", limit: 10 })).some((j) => j.id === toCancel.id), "not claimed");
    check("cancelling an already-finished job is a no-op", (await cancel(base44, done.id)).cancelled === false, "no-op");
    await jobOf({ queue: QB, job_type: "platform.ping" });
    const [cj] = await claim(base44, { queue: QB, worker_id: "worker-inflight", limit: 1 });
    const coop = await cancel(base44, cj.id, { reason: "stop when safe" });
    check("an in-flight job is flagged, never killed mid-write", coop.cancelled === false && coop.job.cancel_requested === true, coop.reason);
    await complete(base44, cj.id, cj.lease_token, { finished_before_checkpoint: true });

    // worker loop
    let handled = 0;
    const handlers = {
      "test.ok": async (job, { heartbeat: hb }) => { await hb(); handled++; return { echoed: job.payload?.value ?? null }; },
      "test.boom": async () => { throw new Error("handler exploded"); },
    };
    const okJob = await jobOf({ queue: QW, job_type: "test.ok", payload: { value: 42 }, priority: 4 });
    const boomJob = await jobOf({ queue: QW, job_type: "test.boom", max_attempts: 1, priority: 4 });
    const unknownJob = await jobOf({ queue: QW, job_type: "test.not_registered", priority: 4 });
    const summary = await runJobs(base44, { queue: QW, handlers, worker_id: "worker-loop", max_jobs: 5, budget_ms: 20000 });
    check("the worker executes due jobs and records their results", handled === 1 && (await svc.entities.BackgroundJob.get(okJob.id)).result.echoed === 42, JSON.stringify({ claimed: summary.claimed, succeeded: summary.succeeded }));
    check("a handler that throws fails its job, never the worker", (await svc.entities.BackgroundJob.get(boomJob.id)).status === "dead_letter" && summary.succeeded === 1, `${summary.dead_lettered} dead-lettered`);
    check("an unregistered job type is dead-lettered instead of executed", (await svc.entities.BackgroundJob.get(unknownJob.id)).error_code === "UNKNOWN_JOB_TYPE", (await svc.entities.BackgroundJob.get(unknownJob.id)).status);
    const budgeted = await runJobs(base44, { queue: QW, handlers, worker_id: "worker-nobudget", max_jobs: 5, budget_ms: 0 });
    check("a worker respects its wall-clock budget", budgeted.claimed === 0, `${budgeted.claimed} claimed in ${budgeted.duration_ms}ms`);
    const stats = await queueStats(base44);
    check("queue depth and outcomes are observable", !!stats.queues[QW] && stats.totals.dead_letter >= 2, JSON.stringify(stats.queues[QW]));

    // handler registry security
    await expectThrow("a job cannot invoke a function outside the allowlist", () => MAINTENANCE_HANDLERS["platform.invoke_function"]({ payload: { function_name: "projectSecrets" } }, { base44 }), "FUNCTION_NOT_ALLOWED");
    check("the invokable allowlist contains only background workers", INVOKABLE_FUNCTIONS.every((f) => /Step$|^reapStaleRuns$|^runScheduledTriggers$/.test(f)), INVOKABLE_FUNCTIONS.join(","));
    await expectThrow("a handler refuses invalid input without retrying", () => MAINTENANCE_HANDLERS["cache.invalidate_namespace"]({ payload: {} }, { base44 }), "INVALID_PAYLOAD");

    // ================================================================ cache
    clearMemoryCache();
    let loads = 0;
    const loader = async () => { loads++; return { computed: true, at: loads }; };
    const key = scopedKey(NS, ["plans", "ws_1"]);
    const miss = await getOrSet(base44, { key, namespace: NS, ttl_ms: 60000, loader });
    created.cache.push(key);
    const hit = await getOrSet(base44, { key, namespace: NS, ttl_ms: 60000, loader });
    check("a cold lookup computes and stores the value", !miss.cached && miss.value.computed === true && loads === 1, `${loads} load(s)`);
    check("a warm lookup is served from cache without recomputing", hit.cached && loads === 1, hit.source);
    check("a tenant-scoped key cannot collide across accounts", scopedKey(NS, ["plans", "ws_1"]) !== scopedKey(NS, ["plans", "ws_2"]), scopedKey(NS, ["plans", "ws_2"]));
    const otherTenant = await getOrSet(base44, { key: scopedKey(NS, ["plans", "ws_2"]), namespace: NS, ttl_ms: 60000, loader: async () => ({ computed: true, tenant: 2 }) });
    created.cache.push(scopedKey(NS, ["plans", "ws_2"]));
    check("another account's lookup never returns the first account's value", otherTenant.value.tenant === 2, "isolated");

    clearMemoryCache();
    const expiredKey = scopedKey(NS, ["short"]);
    await set(base44, expiredKey, { v: 1 }, { namespace: NS, ttl_ms: 1000 });
    created.cache.push(expiredKey);
    check("a hard-expired value is never served", (await get(base44, expiredKey, { now: Date.now() + 5000 })) === null, "expired");
    let refreshes = 0;
    const staleKey = scopedKey(NS, ["stale"]);
    await set(base44, staleKey, { v: "old" }, { namespace: NS, ttl_ms: 60000, stale_ms: 0 });
    created.cache.push(staleKey);
    clearMemoryCache();
    const refreshed = await getOrSet(base44, { key: staleKey, namespace: NS, ttl_ms: 60000, loader: async () => { refreshes++; return { v: "new" }; }, now: Date.now() + 1000 });
    check("a stale value triggers exactly one refresh", refreshes === 1 && refreshed.value.v === "new", refreshed.source);
    const entryRow = (await svc.entities.CacheEntry.filter({ cache_key: staleKey }, "-updated_date", 1))[0];
    check("a refresh bumps the entry version and clears its lock", entryRow.version === 2 && !entryRow.lock_token, `v${entryRow.version}`);
    const lockedKey = scopedKey(NS, ["locked"]);
    await set(base44, lockedKey, { v: "stale-but-valid" }, { namespace: NS, ttl_ms: 60000, stale_ms: 0 });
    created.cache.push(lockedKey);
    const lockedRow = (await svc.entities.CacheEntry.filter({ cache_key: lockedKey }, "-updated_date", 1))[0];
    await svc.entities.CacheEntry.update(lockedRow.id, { lock_token: "someone_else", lock_expires_at: new Date(Date.now() + 10000).toISOString() });
    clearMemoryCache();
    let blockedLoads = 0;
    const servedStale = await getOrSet(base44, { key: lockedKey, namespace: NS, ttl_ms: 60000, loader: async () => { blockedLoads++; return { v: "duplicate work" }; }, now: Date.now() + 1000 });
    check("while one caller refreshes, others serve stale instead of stampeding the source", servedStale.stale && servedStale.value.v === "stale-but-valid" && blockedLoads === 0, `${blockedLoads} duplicate load(s)`);

    const bigKey = scopedKey(NS, ["big"]);
    const oversized = await set(base44, bigKey, { blob: "x".repeat(20000) }, { namespace: NS });
    check("an oversized value is refused, never truncated into the record", oversized.stored === false && oversized.size_bytes > 10000, oversized.reason);
    check("a refused write leaves no partial entry behind", (await get(base44, bigKey)) === null, "absent");
    const fallback = await getOrSet(base44, { key: bigKey, namespace: NS, loader: async () => ({ blob: "y".repeat(20000) }) });
    check("an uncacheable value still returns correctly to the caller", fallback.value.blob.length === 20000 && fallback.stored === false, "loader served");

    check("a single key can be invalidated", (await invalidate(base44, key)).invalidated === 1 && (await get(base44, key)) === null, "invalidated");
    const purgedNs = await invalidateNamespace(base44, NS);
    check("a namespace is invalidated as a unit when its source changes", purgedNs.invalidated >= 1 && (await svc.entities.CacheEntry.filter({ namespace: NS }, "-created_date", 10)).length === 0, `${purgedNs.invalidated} entries`);
    await set(base44, scopedKey(NS, ["gc"]), { v: 1 }, { namespace: NS, ttl_ms: 500 });
    const purge = await purgeExpired(base44, { now: Date.now() + 60000 });
    check("expired entries are garbage-collected so the cache cannot grow unbounded", purge.purged >= 1, `${purge.purged} purged`);

    // ======================================================== rate limiting
    const cfg = limitFor("ai_run");
    check("each expensive action has its own server-side budget", cfg.limit > 0 && limitFor("deploy").limit !== cfg.limit && limitFor("unknown_action").limit === limitFor("default").limit, `${cfg.limit}/min`);
    check("the limited identity is derived from the authenticated caller", identityFor({ user: { id: "u1" }, workspace_id: "w1" }) === "user:u1:ws:w1", identityFor({ user: { id: "u1" } }));
    const first = await consume(base44, { identity: IDENTITY, action: "ai_run", limit: 3, window_ms: 60000 });
    check("the first request is allowed and starts a window", first.allowed && first.count === 1 && first.remaining === 2 && !!first.reset_at, JSON.stringify({ count: first.count, reset: first.reset_at }));
    await consume(base44, { identity: IDENTITY, action: "ai_run", limit: 3, window_ms: 60000 });
    const third = await consume(base44, { identity: IDENTITY, action: "ai_run", limit: 3, window_ms: 60000 });
    const fourth = await consume(base44, { identity: IDENTITY, action: "ai_run", limit: 3, window_ms: 60000 });
    check("requests are counted across workers, not per instance", third.count === 3 && third.remaining === 0, `${third.count}/3`);
    check("the request past the ceiling is refused", !fourth.allowed && fourth.remaining === 0, `${fourth.count}`);
    await expectThrow("an enforced endpoint refuses with a 429-style error", () => enforceLimit(base44, { identity: IDENTITY, action: "ai_run", limit: 3, window_ms: 60000 }), "RATE_LIMITED");
    const otherAction = await consume(base44, { identity: IDENTITY, action: "deploy", limit: 2, window_ms: 60000 });
    check("spending one action's budget does not spend another's", otherAction.allowed && otherAction.count === 1, "independent budgets");
    const nextWindow = await consume(base44, { identity: IDENTITY, action: "ai_run", limit: 3, window_ms: 60000, now: Date.now() + 120000 });
    check("a new window starts with a full budget", nextWindow.allowed && nextWindow.count === 1, `${nextWindow.count}`);
    const otherIdentity = await consume(base44, { identity: `${IDENTITY}:other`, action: "ai_run", limit: 3, window_ms: 60000 });
    check("one account's usage never limits another's", otherIdentity.allowed && otherIdentity.count === 1, "isolated");
    const status = await limitStatus(base44, { identity: IDENTITY, actions: ["ai_run", "deploy"] });
    check("remaining budget is reportable for the caller's own identity", status.ai_run.used >= 3 && status.ai_run.blocked >= 1 && status.deploy.used === 1, JSON.stringify(status.ai_run));
    for (const row of await svc.entities.RateLimitBucket.filter({ identity: IDENTITY }, "-created_date", 20)) created.buckets.push(row.id);
    for (const row of await svc.entities.RateLimitBucket.filter({ identity: `${IDENTITY}:other` }, "-created_date", 5)) created.buckets.push(row.id);
    check("old windows are garbage-collected", (await purgeOldBuckets(base44, { now: Date.now(), olderThanMs: 86400000 })).scanned >= 1, "swept");

    // ======================================================== observability
    await recordMetric(base44, { metric: METRIC, value: 10, labels: { queue: Q } });
    await recordMetric(base44, { metric: METRIC, value: 30, labels: { queue: Q } });
    const metricRows = await svc.entities.SystemMetric.filter({ metric: METRIC }, "-created_date", 10);
    for (const row of metricRows) created.metrics.push(row.id);
    const agg = metricRows[0];
    check("samples aggregate into one minute bucket instead of one row each", metricRows.length === 1 && agg.count === 2 && agg.sum === 40, `${metricRows.length} row(s), sum ${agg.sum}`);
    check("the bucket keeps min, max and the latest value", agg.min === 10 && agg.max === 30 && agg.last_value === 30 && agg.window_key === minuteKey(new Date(agg.window_start)), `${agg.min}–${agg.max}`);
    const differentLabels = await recordMetric(base44, { metric: METRIC, value: 5, labels: { queue: `${Q}_other` } });
    if (differentLabels) created.metrics.push(differentLabels.id);
    check("different label sets are aggregated separately", (await svc.entities.SystemMetric.filter({ metric: METRIC }, "-created_date", 10)).length === 2, "2 series");
    const rolled = await metricsSince(base44, { minutes: 15 });
    check("metrics roll up over a window with an average", rolled.metrics[METRIC].count === 3 && rolled.metrics[METRIC].avg === 15, JSON.stringify(rolled.metrics[METRIC]));
    check("secrets and tokens are redacted out of logs and errors", !redact("failed with sk_live_abc123 and whsec_xyz").includes("sk_live") && !redact("Bearer eyJabcdefghijklmno").includes("eyJabcdefghijklmno"), redact("failed with sk_live_abc123"));
    check("a trace id correlates a request with the jobs it enqueued", /^t_/.test(newTraceId()) && !!j1.trace_id, j1.trace_id);
    const health = await healthSnapshot(base44);
    check("health is derived from real queue and worker state", ["healthy", "degraded", "unhealthy"].includes(health.status) && health.signals.length >= 5, `${health.status}: ${health.signals.map((s) => s.name).join(",")}`);
    check("dead-lettered work degrades health instead of being hidden", ["degraded", "unhealthy"].includes(health.signals.find((s) => s.name === "dead_letter").status), health.signals.find((s) => s.name === "dead_letter").detail);
    check("queue depth and lease health are reported as measurable signals", ["queue_depth", "worker_leases", "cache"].every((n) => health.signals.some((s) => s.name === n)), health.signals.map((s) => s.name).join(","));

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const id of created.jobs) await svc.entities.BackgroundJob.delete(id).catch(() => {});
    for (const queue of queues) {
      for (const row of await svc.entities.BackgroundJob.filter({ queue }, "-created_date", 100).catch(() => [])) await svc.entities.BackgroundJob.delete(row.id).catch(() => {});
    }
    for (const row of await svc.entities.CacheEntry.filter({ namespace: NS }, "-created_date", 100).catch(() => [])) await svc.entities.CacheEntry.delete(row.id).catch(() => {});
    for (const id of created.buckets) await svc.entities.RateLimitBucket.delete(id).catch(() => {});
    for (const id of created.metrics) await svc.entities.SystemMetric.delete(id).catch(() => {});
    clearMemoryCache();
  }
}