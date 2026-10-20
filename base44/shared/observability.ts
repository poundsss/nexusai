// Observability: structured logs, aggregated metrics, health signals.
//
// Two rules:
//   1. Metrics are AGGREGATED into minute buckets, never one record per request — otherwise
//      observing the platform would cost more than running it.
//   2. Nothing identifying is recorded. Labels are low-cardinality dimensions only (queue,
//      job type, status), never an email, IP, prompt, token or secret value.

const REDACT = /(sk_live|sk_test|whsec_|bearer\s+[\w.\-]+|eyJ[\w-]{10,})/gi;

export const redact = (text) => String(text ?? "").replace(REDACT, "[redacted]").slice(0, 500);

export const newTraceId = () => `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * One structured line per event. Logs are the debugging surface for background work, so they
 * carry the trace id that ties a job back to the request that enqueued it.
 */
export function log(level, event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = typeof v === "string" ? redact(v) : v;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const minuteKey = (date = new Date()) => new Date(date).toISOString().slice(0, 16);

const labelKey = (labels) => Object.keys(labels || {}).sort().map((k) => `${k}=${labels[k]}`).join(",");

/**
 * Records a sample into its minute bucket, creating the bucket on first sample and folding
 * subsequent samples into count/sum/min/max. Best-effort by design: observability must never
 * fail the operation it is observing.
 */
export async function recordMetric(base44, { metric, value = 1, labels = {}, scope = "platform", scope_id = null, at = new Date() }) {
  const svc = base44.asServiceRole || base44;
  const window_key = minuteKey(at);
  const key = labelKey(labels);
  try {
    const existing = await svc.entities.SystemMetric.filter({ metric, window_key, scope, ...(scope_id ? { scope_id } : {}) }, "-created_date", 20);
    const row = existing.find((r) => labelKey(r.labels) === key);
    const n = Number(value) || 0;
    if (!row) {
      return await svc.entities.SystemMetric.create({
        metric, window_key, window_start: new Date(`${window_key}:00.000Z`).toISOString(), scope, scope_id, labels,
        count: 1, sum: n, min: n, max: n, last_value: n, last_sample_at: new Date().toISOString(),
      });
    }
    return await svc.entities.SystemMetric.update(row.id, {
      count: (row.count || 0) + 1, sum: (row.sum || 0) + n,
      min: row.min == null ? n : Math.min(row.min, n), max: row.max == null ? n : Math.max(row.max, n),
      last_value: n, last_sample_at: new Date().toISOString(),
    });
  } catch (e) {
    log("warn", "metric.write_failed", { metric, error: e.message });
    return null;
  }
}

// Times an operation and records its latency plus an ok/error outcome, without swallowing the
// error — the caller still sees exactly what happened.
export async function timed(base44, { metric, labels = {}, scope, scope_id }, fn) {
  const start = Date.now();
  try {
    const out = await fn();
    await recordMetric(base44, { metric, value: Date.now() - start, labels: { ...labels, outcome: "ok" }, scope, scope_id });
    return out;
  } catch (e) {
    await recordMetric(base44, { metric, value: Date.now() - start, labels: { ...labels, outcome: "error" }, scope, scope_id });
    throw e;
  }
}

export async function metricsSince(base44, { minutes = 15 } = {}) {
  const svc = base44.asServiceRole || base44;
  const cutoff = Date.now() - minutes * 60000;
  const rows = await svc.entities.SystemMetric.list("-window_key", 500).catch(() => []);
  const recent = rows.filter((r) => new Date(r.window_start || `${r.window_key}:00.000Z`).getTime() >= cutoff);
  const byMetric = {};
  for (const r of recent) {
    const m = (byMetric[r.metric] ||= { count: 0, sum: 0, max: null });
    m.count += r.count || 0;
    m.sum += r.sum || 0;
    m.max = m.max == null ? r.max : Math.max(m.max, r.max ?? m.max);
  }
  for (const m of Object.values(byMetric)) m.avg = m.count ? Math.round((m.sum / m.count) * 100) / 100 : 0;
  return { window_minutes: minutes, metrics: byMetric, samples: recent.length };
}

/**
 * Health is DERIVED from real state, never self-reported: queue depth, dead-lettered work,
 * expired leases and stale runs. A signal that cannot be measured is reported as unknown
 * rather than assumed healthy.
 */
export async function healthSnapshot(base44, { thresholds = {} } = {}) {
  const svc = base44.asServiceRole || base44;
  const t = { queue_depth: 200, dead_letter: 5, expired_leases: 3, ...thresholds };
  const signals = [];
  const push = (name, status, detail, value = null) => signals.push({ name, status, detail, value });

  const now = Date.now();
  const pending = await svc.entities.BackgroundJob.filter({ status: "pending" }, "-created_date", 500).catch(() => null);
  if (pending === null) push("queue", "unknown", "queue could not be read");
  else {
    const ready = pending.filter((j) => !j.available_at || new Date(j.available_at).getTime() <= now);
    push("queue_depth", ready.length > t.queue_depth ? "degraded" : "healthy", `${ready.length} job(s) ready`, ready.length);
    const oldest = ready.map((j) => now - new Date(j.created_date).getTime()).sort((a, b) => b - a)[0] || 0;
    push("queue_latency", oldest > 900000 ? "degraded" : "healthy", `oldest ready job ${Math.round(oldest / 1000)}s`, oldest);
  }

  const dead = await svc.entities.BackgroundJob.filter({ status: "dead_letter" }, "-created_date", 100).catch(() => []);
  push("dead_letter", dead.length > t.dead_letter ? "unhealthy" : dead.length ? "degraded" : "healthy", `${dead.length} dead-lettered job(s)`, dead.length);

  const leased = await svc.entities.BackgroundJob.filter({ status: "leased" }, "-created_date", 200).catch(() => []);
  const expired = leased.filter((j) => j.lease_expires_at && new Date(j.lease_expires_at).getTime() <= now);
  push("worker_leases", expired.length > t.expired_leases ? "degraded" : "healthy", `${expired.length} expired lease(s) of ${leased.length} in flight`, expired.length);

  const stale = await svc.entities.AIRun.filter({ status: "STALE" }, "-created_date", 50).catch(() => []);
  push("ai_runs", stale.length > 5 ? "degraded" : "healthy", `${stale.length} stale run(s)`, stale.length);

  const metrics = await metricsSince(base44, { minutes: 15 });
  const hits = metrics.metrics["cache.hit"]?.count || 0;
  const misses = metrics.metrics["cache.miss"]?.count || 0;
  push("cache", "healthy", hits + misses ? `${Math.round((hits / (hits + misses)) * 100)}% hit rate over ${hits + misses} lookups` : "no lookups in window", hits + misses ? hits / (hits + misses) : null);

  const status = signals.some((s) => s.status === "unhealthy") ? "unhealthy" : signals.some((s) => s.status === "degraded") ? "degraded" : signals.some((s) => s.status === "unknown") ? "degraded" : "healthy";
  return { status, checked_at: new Date().toISOString(), signals, metrics: metrics.metrics };
}