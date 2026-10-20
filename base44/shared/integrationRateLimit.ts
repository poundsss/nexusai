// Upstream-declared rate-limit state for one project's integration + host.
//
// This is NOT a second rate limiter. The platform imposes no limit of its own here and counts
// nothing: it simply REMEMBERS what an upstream service already told us with a 429 and its
// Retry-After, so the very next call does not walk into the same closed door. All enforcement
// still belongs to the upstream; this module only stops the platform from ignoring it.
//
// Isolation is structural: the state key is project + integration + host, so one project's 429
// can never defer another project's calls, and a host reached through two integrations (with
// different credentials and different quotas) is tracked separately.
//
// A window is only ever recorded from what the response ACTUALLY said. When a 429 carries no
// parseable Retry-After, the limit is remembered but `retry_until` stays absent and nothing is
// refused — the platform never invents a wait.
import { log } from "./observability.ts";

const svcOf = (base44) => base44.asServiceRole || base44;

/**
 * Parses an HTTP `Retry-After` header, in BOTH forms the specification allows.
 *   • numeric seconds  → "120"
 *   • HTTP-date        → "Wed, 21 Oct 2026 07:28:00 GMT", measured against the server's clock now
 * An HTTP-date already in the past is clamped to 0 rather than producing a negative wait.
 * Returns null when the header is absent, and { ms: 0, source: "invalid" } when it is unusable.
 */
export function parseRetryAfter(header, now = Date.now()) {
  if (header === undefined || header === null || String(header).trim() === "") return null;
  const raw = String(header).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return { ms: Math.max(0, Math.round(seconds * 1000)), source: "header_seconds" };
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return { ms: Math.max(0, at - now), source: "header_date" };
  return { ms: 0, source: "invalid" };
}

export const stateKeyOf = (project_id, integration_name, host) => `${project_id}|${integration_name}|${host}`;

/**
 * The `rateLimit` dependency the http adapter uses.
 *
 * `check` answers "is this project+integration+host still inside a window the upstream declared?"
 * `note` records a 429 the adapter just received. Both are best-effort: a storage failure must
 * degrade this protection, never fail the integration call.
 */
export function createIntegrationRateLimitState(client, { project, trace_id = null } = {}) {
  const svc = svcOf(client);
  // Per-execution memo, so several calls to the same host inside one function do not re-read.
  const memo = new Map();

  const load = async (integration_name, host) => {
    const key = stateKeyOf(project.id, integration_name, host);
    if (memo.has(key)) return memo.get(key);
    // Scoped by project AND integration AND host — the three parts of the key.
    const rows = await svc.entities.IntegrationRateLimit
      .filter({ project_id: project.id, integration_name, host }, "-observed_at", 1)
      .catch(() => []);
    const row = rows[0] || null;
    memo.set(key, row);
    return row;
  };

  return {
    async check({ integration, host }) {
      if (!host) return null;
      const row = await load(integration, host);
      if (!row?.retry_until) return null;
      const remaining = Date.parse(row.retry_until) - Date.now();
      if (!(remaining > 0)) return null;
      // Count what this state prevented; the refusal itself is what matters, so a failed
      // increment is ignored.
      svc.entities.IntegrationRateLimit.update(row.id, { refusals: (row.refusals || 0) + 1 })
        .catch(() => {});
      return {
        retry_until: row.retry_until, retry_after_ms: remaining,
        retry_after_source: row.retry_after_source || "absent",
        observed_at: row.observed_at || null, occurrences: row.occurrences || 1,
      };
    },

    async note({ integration, host, status = 429, retry_after_ms = null, retry_after_source = "absent" }) {
      if (!host) return null;
      const now = Date.now();
      const observed_at = new Date(now).toISOString();
      // A window is only claimed when the upstream actually declared one.
      const retry_until = Number.isFinite(retry_after_ms) && retry_after_ms > 0
        ? new Date(now + retry_after_ms).toISOString() : null;
      const patch = {
        status, retry_until, retry_after_ms: Number.isFinite(retry_after_ms) ? retry_after_ms : undefined,
        retry_after_source, observed_at, trace_id: trace_id || undefined,
      };
      const key = stateKeyOf(project.id, integration, host);
      try {
        const existing = await load(integration, host);
        const row = existing
          ? await svc.entities.IntegrationRateLimit.update(existing.id, { ...patch, occurrences: (existing.occurrences || 0) + 1 })
          : await svc.entities.IntegrationRateLimit.create({
            state_key: key, project_id: project.id, workspace_id: project.workspace_id || undefined,
            integration_name: integration, host, ...patch, occurrences: 1, refusals: 0,
          });
        memo.set(key, row);
        return row;
      } catch (e) {
        log("warn", "integration.rate_limit_write_failed", { integration, host, error: e.message });
        return null;
      }
    },
  };
}

/** Project-scoped read of known rate-limit windows. `project_id` is mandatory. */
export async function listIntegrationRateLimits(client, { project_id, limit = 50 }) {
  if (!project_id) throw Object.assign(new Error("project_id is required"), { status: 400, code: "INVALID_INPUT" });
  return await svcOf(client).entities.IntegrationRateLimit.filter({ project_id }, "-observed_at", limit).catch(() => []);
}