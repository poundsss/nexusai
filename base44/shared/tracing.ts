// End-to-end correlation.
//
// The platform already keeps rich, authoritative per-subsystem records: AIRun (steps, tool_log),
// MCPInvocation, FunctionInvocation, Build logs, Deployment logs and AuditLog. What was missing
// is the thread between them — a way to ask "what did THIS operation do, everywhere, including
// the parts that ran later on a worker after two retries".
//
// This module adds that thread and nothing else:
//   • ONE trace_id is minted where an operation enters the platform and then carried, never
//     regenerated — through phases, worker hand-offs, background jobs and retries. A retry is a
//     new ATTEMPT of the same trace, which is what keeps a failure attributable to the operation
//     that caused it instead of looking like unrelated work.
//   • Each execution boundary writes one small TraceEvent span pointing AT the authoritative
//     record (reference_id) rather than copying it. Existing logs and audit rows are untouched
//     and remain the source of truth.
//   • Every string that lands in a span or a runtime-error report goes through `scrub` first, so
//     no secret, token, OAuth credential, key or authorization header can enter the diagnostic
//     trail — including values nested inside metadata.
//   • Diagnostic reads are project-scoped: the caller is authorized against the project by the
//     endpoint, and every query here filters by that project id, so a trace id from another
//     workspace resolves to nothing.
// Span writes are best-effort by construction: observability must never fail the operation it
// observes.
import { redact, log, newTraceId } from "./observability.ts";

export { newTraceId };

export const newSpanId = () => `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Field names whose VALUE is a credential by definition. Matched on the key, because a token is
// often a plain opaque string that no pattern would catch.
const SECRET_KEY_RE = /(secret|token|password|passwd|credential|api[_-]?key|apikey|authorization|auth_header|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?id|cookie|signature|bearer|encryption[_-]?key)/i;
// Value shapes that are credentials wherever they appear.
const SECRET_VALUE_RE = /(sk_live_[\w-]+|sk_test_[\w-]+|whsec_[\w-]+|ghp_[\w-]+|gho_[\w-]+|github_pat_[\w-]+|xox[abposr]-[\w-]+|AKIA[0-9A-Z]{12,}|eyJ[\w-]{10,}\.[\w-]{5,}|Bearer\s+[\w.\-]{8,}|Basic\s+[A-Za-z0-9+/=]{12,})/gi;

export const MAX_TEXT = 500;

/** Scrubs one string: known credential shapes first, then the platform's own redactor. */
export function scrubText(value, max = MAX_TEXT) {
  return redact(String(value ?? "").replace(SECRET_VALUE_RE, "[REDACTED]")).slice(0, max);
}

/**
 * Deep scrub for structured diagnostic context. A key that names a credential is dropped
 * entirely (its presence is recorded, its value never is); every other string is scrubbed.
 */
export function scrub(value, depth = 0) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return scrubText(value, 300);
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 30)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : scrub(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

const svcOf = (base44) => base44.asServiceRole || base44;

/**
 * Writes one correlation span. Returns the row (or null when the write failed) — callers never
 * branch on it, because a missing span must degrade diagnostics, not break execution.
 */
export async function recordSpan(base44, {
  trace_id, span_id = null, parent_span_id = null, workspace_id = null, project_id = null,
  run_id = null, job_id = null, event_type, name, status = "ok", attempt = 1,
  error_code = null, error = null, duration_ms = null, reference_id = null, metadata = null, at = null,
}) {
  if (!trace_id || !event_type || !name) return null;
  try {
    return await svcOf(base44).entities.TraceEvent.create({
      trace_id, span_id: span_id || newSpanId(), parent_span_id, workspace_id, project_id, run_id, job_id,
      // 0 is a meaningful attempt count: an operation refused before it ran made no attempt, and
      // the span must not claim one. Anything unusable still defaults to 1.
      event_type, name: String(name).slice(0, 120), status,
      attempt: Number.isFinite(Number(attempt)) ? Math.max(0, Math.round(Number(attempt))) : 1,
      error_code: error_code ? String(error_code).slice(0, 80) : null,
      error_message: error ? scrubText(error?.message || error) : null,
      duration_ms: duration_ms == null ? null : Math.round(duration_ms),
      reference_id, metadata: metadata ? scrub(metadata) : {}, at: at || new Date().toISOString(),
    });
  } catch (e) {
    log("warn", "trace.span_write_failed", { event_type, name, error: e.message });
    return null;
  }
}

/** Times a boundary and records exactly one span for it, success or failure, without swallowing. */
export async function tracedSpan(base44, span, fn) {
  const started = Date.now();
  try {
    const out = await fn();
    await recordSpan(base44, { ...span, status: "ok", duration_ms: Date.now() - started, ...(typeof span.after === "function" ? span.after(out) : {}) });
    return out;
  } catch (e) {
    await recordSpan(base44, { ...span, status: "error", error: e, error_code: e.code || e.name || "ERROR", duration_ms: Date.now() - started });
    throw e;
  }
}

/**
 * The trace id of a run. A run enqueued before this capability existed (or by a path that did
 * not mint one) is back-filled ONCE and keeps that id for every later phase and retry, so no
 * in-flight run loses correlation.
 */
export async function ensureRunTrace(base44, run) {
  if (run.trace_id) return run.trace_id;
  const trace_id = newTraceId();
  await svcOf(base44).entities.AIRun.update(run.id, { trace_id }).catch(() => {});
  run.trace_id = trace_id;
  return trace_id;
}

// --- persisted frontend / preview runtime errors ------------------------------

const REPORT_LIMITS = { message: 500, stack: 4000, file: 200, route: 200, user_agent: 200 };

/**
 * Persists one runtime error from a preview, the builder UI or a deployed app.
 *
 * The project and workspace are resolved server-side by the caller; the reporter only supplies
 * diagnostics. An identical error (same project, kind, message, file and line) already reported
 * in the last hour is FOLDED into the existing row, so a component that throws on every frame
 * produces one diagnostic with an occurrence count instead of thousands of rows.
 */
export async function persistRuntimeError(base44, { project, workspace_id, report = {}, trace_id = null, run_id = null }) {
  const svc = svcOf(base44);
  const message = scrubText(report.message || "Unknown runtime error", REPORT_LIMITS.message);
  const kind = ["error", "unhandled_rejection", "render_error", "console_error", "network_error"].includes(report.kind) ? report.kind : "error";
  const environment = ["preview", "staging", "production"].includes(report.environment) ? report.environment : "preview";
  const source = ["preview_runtime", "builder_ui", "deployed_app"].includes(report.source) ? report.source : "preview_runtime";
  const file = report.file ? scrubText(report.file, REPORT_LIMITS.file) : null;
  const line = Number.isFinite(Number(report.line)) ? Number(report.line) : null;
  const now = new Date().toISOString();

  const recent = await svc.entities.RuntimeError.filter({ project_id: project.id, kind }, "-created_date", 50).catch(() => []);
  const hourAgo = Date.now() - 3600000;
  const dup = recent.find((r) => r.message === message && (r.file || null) === file && (r.line ?? null) === line && Date.parse(r.last_seen_at || r.created_date) >= hourAgo);
  if (dup) {
    const folded = await svc.entities.RuntimeError.update(dup.id, {
      occurrences: (dup.occurrences || 1) + 1, last_seen_at: now,
      // A later report may know the correlation the first one did not.
      ...(trace_id && !dup.trace_id ? { trace_id } : {}), ...(run_id && !dup.run_id ? { run_id } : {}),
    });
    return { runtime_error: folded, folded: true };
  }

  const row = await svc.entities.RuntimeError.create({
    project_id: project.id, workspace_id, trace_id, run_id,
    version_number: Number.isFinite(Number(report.version_number)) ? Number(report.version_number) : (project.version_count ?? null),
    deployment_id: report.deployment_id ? String(report.deployment_id) : null,
    environment, source, kind, message,
    error_name: report.error_name ? scrubText(report.error_name, 100) : null,
    stack: report.stack ? scrubText(report.stack, REPORT_LIMITS.stack) : null,
    file, line, column: Number.isFinite(Number(report.column)) ? Number(report.column) : null,
    route: report.route ? scrubText(report.route, REPORT_LIMITS.route) : null,
    user_agent: report.user_agent ? scrubText(report.user_agent, REPORT_LIMITS.user_agent) : null,
    occurrences: 1, last_seen_at: now, metadata: scrub(report.metadata || {}),
  });

  // The error joins the same trail as the operation that produced the code, when one is known.
  if (trace_id) {
    await recordSpan(base44, {
      trace_id, workspace_id, project_id: project.id, run_id, event_type: "frontend_error",
      name: kind, status: "error", error_code: report.error_name || kind, error: message,
      reference_id: row.id, at: now,
      metadata: { environment, source, file, line, route: row.route, version_number: row.version_number },
    });
  }
  return { runtime_error: row, folded: false };
}

// --- unified diagnostic trail -------------------------------------------------

const iso = (v) => (v ? String(v) : "");

/**
 * Reconstructs one operation as a single, ordered diagnostic trail.
 *
 * Correlation spans are joined with the authoritative records that share the trace: the run
 * itself, its MCP invocations, its generated-function invocations, its background jobs (with
 * their per-attempt failure history) and any persisted runtime errors. Nothing is rewritten —
 * each entry names the record it came from.
 *
 * ISOLATION: `project_id` is mandatory and every query is filtered by it, so a trace id
 * belonging to another project or workspace yields an empty trail rather than another
 * account's execution history.
 */
export async function diagnosticTrail(base44, { trace_id, project_id, limit = 300 }) {
  if (!trace_id) throw Object.assign(new Error("trace_id is required"), { status: 400, code: "INVALID_INPUT" });
  if (!project_id) throw Object.assign(new Error("project_id is required"), { status: 400, code: "INVALID_INPUT" });
  const svc = svcOf(base44);

  const [spans, runs, mcpCalls, fnCalls, jobs, errors] = await Promise.all([
    svc.entities.TraceEvent.filter({ trace_id, project_id }, "at", limit).catch(() => []),
    svc.entities.AIRun.filter({ trace_id, project_id }, "created_date", 20).catch(() => []),
    svc.entities.MCPInvocation.filter({ trace_id, project_id }, "created_date", 100).catch(() => []),
    svc.entities.FunctionInvocation.filter({ trace_id, project_id }, "created_date", 100).catch(() => []),
    svc.entities.BackgroundJob.filter({ trace_id, project_id }, "created_date", 50).catch(() => []),
    svc.entities.RuntimeError.filter({ trace_id, project_id }, "created_date", 50).catch(() => []),
  ]);

  const entries = [];
  const push = (e) => entries.push(e);
  for (const s of spans) {
    push({
      at: iso(s.at || s.created_date), source: "TraceEvent", record_id: s.id, event_type: s.event_type,
      name: s.name, status: s.status, attempt: s.attempt || 1, duration_ms: s.duration_ms ?? null,
      error_code: s.error_code || null, error_message: s.error_message || null,
      run_id: s.run_id || null, job_id: s.job_id || null, span_id: s.span_id, parent_span_id: s.parent_span_id || null,
      reference_id: s.reference_id || null, trace_id: s.trace_id, metadata: s.metadata || {},
    });
  }
  for (const r of runs) {
    push({
      at: iso(r.started_at || r.created_date), source: "AIRun", record_id: r.id, event_type: "ai_run",
      name: `run ${r.mode}`, status: r.status === "COMPLETED" ? "ok" : ["FAILED", "STALE"].includes(r.status) ? "error" : r.status === "CANCELLED" ? "cancelled" : "running",
      attempt: (r.repair_attempts || 0) + 1, duration_ms: r.duration_ms ?? null,
      error_code: r.status, error_message: r.error ? scrubText(r.error) : null,
      run_id: r.id, trace_id: r.trace_id,
      metadata: { phase: r.phase, model: r.model, tool_calls: r.tool_calls, version_number: r.version_number ?? null, build_id: r.build_id || null },
    });
  }
  for (const m of mcpCalls) {
    push({
      at: iso(m.created_date), source: "MCPInvocation", record_id: m.id, event_type: "mcp_call",
      name: `${m.connection_name}.${m.tool_name}`, status: m.ok ? "ok" : "error", attempt: 1,
      duration_ms: m.duration_ms ?? null, error_code: m.error_code || null, error_message: m.error_message || null,
      run_id: m.run_id || null, trace_id: m.trace_id, metadata: { trigger: m.trigger, mode: m.mode || null, result_bytes: m.result_bytes ?? null },
    });
  }
  for (const f of fnCalls) {
    push({
      at: iso(f.created_date), source: "FunctionInvocation", record_id: f.id, event_type: "function_exec",
      name: f.function_name, status: f.ok ? "ok" : "error", attempt: 1, duration_ms: f.duration_ms ?? null,
      error_code: f.error_class || null, error_message: f.error_message || null,
      run_id: f.run_id || null, trace_id: f.trace_id,
      metadata: { trigger: f.trigger, method: f.method, http_status: f.status, external_calls: (f.external_calls || []).length },
    });
  }
  for (const j of jobs) {
    push({
      at: iso(j.started_at || j.created_date), source: "BackgroundJob", record_id: j.id, event_type: "background_job",
      name: j.job_type, status: j.status === "succeeded" ? "ok" : ["failed", "dead_letter"].includes(j.status) ? "error" : j.status === "cancelled" ? "cancelled" : "running",
      attempt: j.attempts || 1, duration_ms: j.duration_ms ?? null, error_code: j.error_code || null,
      error_message: j.last_error ? scrubText(j.last_error) : null, job_id: j.id, trace_id: j.trace_id,
      metadata: { queue: j.queue, attempt_log: (j.attempt_log || []).map((a) => ({ attempt: a.attempt, code: a.code, at: a.at })) },
    });
  }
  for (const e of errors) {
    push({
      at: iso(e.created_date), source: "RuntimeError", record_id: e.id, event_type: "frontend_error",
      name: e.kind, status: "error", attempt: e.occurrences || 1, duration_ms: null,
      error_code: e.error_name || e.kind, error_message: e.message, run_id: e.run_id || null, trace_id: e.trace_id,
      metadata: { environment: e.environment, source: e.source, file: e.file, line: e.line, route: e.route, version_number: e.version_number ?? null, occurrences: e.occurrences || 1 },
    });
  }

  entries.sort((a, b) => a.at.localeCompare(b.at) || String(a.record_id).localeCompare(String(b.record_id)));
  const failures = entries.filter((e) => e.status === "error");
  return {
    trace_id, project_id, entry_count: entries.length,
    started_at: entries[0]?.at || null, ended_at: entries[entries.length - 1]?.at || null,
    status: failures.length ? "error" : entries.some((e) => e.status === "running") ? "running" : "ok",
    counts: entries.reduce((acc, e) => { acc[e.event_type] = (acc[e.event_type] || 0) + 1; return acc; }, {}),
    attempts: Math.max(1, ...entries.map((e) => e.attempt || 1)),
    failures: failures.map((f) => ({ at: f.at, source: f.source, event_type: f.event_type, name: f.name, error_code: f.error_code, error_message: f.error_message, attempt: f.attempt })),
    entries,
  };
}

/** Recent traces for a project, newest first — the entry point into the trail. */
export async function listTraces(base44, { project_id, limit = 20 }) {
  const svc = svcOf(base44);
  const spans = await svc.entities.TraceEvent.filter({ project_id }, "-created_date", 500).catch(() => []);
  const byTrace = new Map();
  for (const s of spans) {
    const t = byTrace.get(s.trace_id) || { trace_id: s.trace_id, run_id: s.run_id || null, events: 0, errors: 0, started_at: s.at || s.created_date, ended_at: s.at || s.created_date, types: {} };
    t.events++;
    if (s.status === "error") t.errors++;
    t.run_id = t.run_id || s.run_id || null;
    const at = iso(s.at || s.created_date);
    if (at < t.started_at) t.started_at = at;
    if (at > t.ended_at) t.ended_at = at;
    t.types[s.event_type] = (t.types[s.event_type] || 0) + 1;
    byTrace.set(s.trace_id, t);
  }
  return [...byTrace.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
}