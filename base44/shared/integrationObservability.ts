// Durable per-integration-call observability.
//
// The integration adapters already execute correctly (credential injection, OAuth2 exchange,
// bounded idempotency-aware retries, SSRF guard, redaction) and already report into
// FunctionInvocation.external_calls. What was missing is a DURABLE, queryable record of one
// logical integration call and its place in the existing diagnostic trail.
//
// This module is that and nothing else:
//   • ONE IntegrationInvocation row per logical call. The retry engine may spend three HTTP
//     attempts; that is one record with attempts=3, never three records.
//   • ONE TraceEvent span written through the EXISTING tracing module, carrying the operation's
//     existing trace_id — no second tracing system, no new correlation id.
//   • ONE AuditLog entry naming the project secrets a call consumed, by NAME only.
// Every string is passed through the execution's own secret redactor and then the platform's
// credential scrubber, so no key, token or authorization header can enter any of them.
//
// Writes are best-effort by construction: observability must never fail the operation it
// observes, and never alters retry behaviour or the error the caller sees.
import { recordSpan, scrub, scrubText } from "./tracing.ts";
import { log } from "./observability.ts";

const svcOf = (base44) => base44.asServiceRole || base44;

export const newInvocationId = () => `iv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Integration error vocabulary → coarse category. Deterministic failures (validation,
// authorization) are classified as such so an upstream outage is never counted as a platform
// defect, and vice versa.
export function categorizeFailure(code, status, kind) {
  if (kind === "rate_limited" || status === 429) return "rate_limit";
  // A per-project usage limit is a deterministic platform refusal, never an upstream fault.
  if (kind === "quota_exceeded" || code === "QUOTA_EXCEEDED") return "quota";
  switch (code) {
    case "INVALID_INPUT": return "validation";
    case "AUTH_FAILURE": return "authorization";
    case "TIMEOUT": return "timeout";
    case "OPERATION_NOT_FOUND":
    case "INTEGRATION_NOT_FOUND": return "not_found";
    case "PLATFORM_FAILURE": return "internal";
    case "UPSTREAM_FAILURE": return status === 404 ? "not_found" : "upstream";
    default: return status && status >= 400 && status < 500 ? "upstream" : "internal";
  }
}

/**
 * Builds the `observe` dependency the adapters call exactly once per logical call.
 *
 * The project is captured HERE, from the execution's own project record, so an observed call can
 * never be attributed to another project. `redact` is the execution's live secret redactor.
 */
export function createIntegrationObserver(client, {
  project, trace_id = null, run_id = null, function_name = null, trigger = null,
  redact = (t) => String(t ?? ""),
} = {}) {
  const svc = svcOf(client);
  const safe = (text, max = 500) => scrubText(redact(String(text ?? "")), max);

  return async function observe(call) {
    const invocation_id = newInvocationId();
    const failure = call.error || null;
    const category = failure ? categorizeFailure(failure.code, call.status, call.failure_kind) : null;
    const row = {
      invocation_id,
      project_id: project.id,
      workspace_id: project.workspace_id || undefined,
      integration_name: call.integration_name,
      integration_id: call.integration_id || undefined,
      integration_type: call.integration_type || "http",
      operation: call.operation,
      host: call.host || undefined,
      method: call.method || undefined,
      tool: call.tool || undefined,
      ok: !failure,
      status: Number.isFinite(Number(call.status)) ? Number(call.status) : 0,
      // A call that was refused before the upstream was contacted made ZERO attempts, and is
      // recorded as zero — never floored to 1, which would claim contact that never happened.
      attempts: Number.isFinite(Number(call.attempts)) ? Math.max(0, Math.round(Number(call.attempts))) : 1,
      latency_ms: Math.max(0, Math.round(Number(call.latency_ms) || 0)),
      ...(failure ? {
        error_code: String(failure.code || "UPSTREAM_FAILURE").slice(0, 80),
        error_category: category,
        retryable: !!call.retryable,
        scrubbed_error_message: safe(failure.message),
        ...(call.failure_kind ? { failure_kind: String(call.failure_kind).slice(0, 60) } : {}),
      } : {}),
      // "When known" means exactly that: a posture the platform has no signal for stays absent
      // rather than being reported as healthy or unlimited.
      ...(call.rate_limit_state ? { rate_limit_state: scrub(call.rate_limit_state) } : {}),
      ...(call.breaker_state ? { breaker_state: scrub(call.breaker_state) } : {}),
      ...(call.quota_state ? { quota_state: scrub(call.quota_state) } : {}),
      // NAMES only. A value can never reach this field.
      ...(call.secret_names?.length ? { secret_names: call.secret_names.map((n) => String(n).slice(0, 80)) } : {}),
      trace_id: trace_id || undefined,
      run_id: run_id || undefined,
      function_name: function_name || undefined,
      trigger: trigger || undefined,
      started_at: call.started_at || undefined,
      completed_at: call.completed_at || new Date().toISOString(),
    };

    let record = null;
    try {
      record = await svc.entities.IntegrationInvocation.create(row);
    } catch (e) {
      log("warn", "integration.invocation_write_failed", { integration: call.integration_name, error: e.message });
    }

    // One span in the EXISTING trace, pointing AT the authoritative record rather than copying it.
    if (trace_id) {
      await recordSpan(client, {
        trace_id, workspace_id: project.workspace_id || null, project_id: project.id, run_id,
        event_type: "integration_call",
        name: `${call.integration_name}.${call.operation}`,
        status: failure ? "error" : "ok",
        attempt: row.attempts,
        duration_ms: row.latency_ms,
        error_code: failure ? row.error_code : null,
        error: failure ? row.scrubbed_error_message : null,
        reference_id: record?.id || null,
        metadata: {
          integration: call.integration_name, operation: call.operation, adapter: row.integration_type,
          host: row.host || null, method: row.method || null, status: row.status,
          attempts: row.attempts, ...(category ? { error_category: category } : {}),
          ...(call.secret_names?.length ? { secret_names: call.secret_names } : {}),
        },
      });
    }

    // Credential-use audit: which integration operation consumed which secret NAME. The existing
    // ProjectSecret.last_used_at stamping in the function runtime is untouched.
    if (call.secret_names?.length) {
      try {
        await svc.entities.AuditLog.create({
          workspace_id: project.workspace_id || "unknown",
          project_id: project.id,
          action: "integration.credential_used",
          resource: "integration",
          resource_id: `${call.integration_name}.${call.operation}`,
          metadata: {
            integration: call.integration_name, operation: call.operation,
            secret_names: call.secret_names.map((n) => String(n).slice(0, 80)),
            host: row.host || null, status: row.status, ok: row.ok,
            attempts: row.attempts, trace_id: trace_id || null, run_id: run_id || null,
            invocation_id,
          },
        });
      } catch (e) {
        log("warn", "integration.credential_audit_failed", { integration: call.integration_name, error: e.message });
      }
    }
    return record;
  };
}

/**
 * Project-scoped read of integration invocations. `project_id` is mandatory and every query is
 * filtered by it, so an invocation belonging to another project is unreachable through this path.
 */
export async function listIntegrationInvocations(client, { project_id, limit = 50 }) {
  if (!project_id) throw Object.assign(new Error("project_id is required"), { status: 400, code: "INVALID_INPUT" });
  return await svcOf(client).entities.IntegrationInvocation.filter({ project_id }, "-created_date", limit).catch(() => []);
}