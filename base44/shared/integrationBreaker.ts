// Circuit breaker for a project's external integrations.
//
// It answers exactly one question before a call: "has THIS project's THIS integration on THIS
// host been failing upstream so consistently that sending another request is pointless?" When the
// answer is yes the call is refused deterministically, without contacting the service, for a
// BOUNDED period — a breaker here can never latch open permanently.
//
// What it counts is deliberately narrow, and it reuses the EXISTING error classification rather
// than inventing one: repeated 5xx, timeouts and connection failures are upstream faults. An auth
// or configuration error, a validation failure, a 4xx business error, a platform/policy refusal
// and a rate-limit refusal are NOT — none of them says the upstream is unhealthy, and treating
// them as such would disable a working integration because the project misconfigured one call.
//
// A 429 stays governed by the rate-limit window (#31B): it is never counted here, so ordinary
// throttling can never be laundered into an outage.
//
// The breaker also judges the LOGICAL call, not each retry attempt: one call that spent three
// attempts produces one breaker decision.
//
// This is a separate mechanism from the AI/model breaker in providerHealth.ts on purpose — that
// one governs model providers by their own health signals and shares nothing with project
// integrations, whose state must stay project-scoped and per host.
//
// The SAME state machine is reused (workspace-scoped) by the MCP tool-invocation path — see
// createMcpBreaker below. One implementation, two keying scopes.
import { log } from "./observability.ts";

const svcOf = (base44) => base44.asServiceRole || base44;

// Bounded defaults. A project may tune them, but only inside these limits: the breaker can never
// be configured to be unbounded, to never recover, or to admit an unlimited probe flood.
export const BREAKER_DEFAULTS = { threshold: 5, window_ms: 60_000, open_ms: 30_000, half_open_max_probes: 1 };
const LIMITS = {
  threshold: [1, 20], window_ms: [1_000, 600_000], open_ms: [100, 600_000], half_open_max_probes: [1, 5],
};
const PROBE_TTL_MS = 15_000;
const MAX_FAILURE_TIMES = 40;

const clamp = (value, [lo, hi], fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

export function breakerConfig(integration = {}) {
  const c = integration.breaker || {};
  if (c.enabled === false) return { enabled: false, ...BREAKER_DEFAULTS };
  return {
    enabled: true,
    threshold: clamp(c.threshold, LIMITS.threshold, BREAKER_DEFAULTS.threshold),
    window_ms: clamp(c.window_ms, LIMITS.window_ms, BREAKER_DEFAULTS.window_ms),
    open_ms: clamp(c.open_ms, LIMITS.open_ms, BREAKER_DEFAULTS.open_ms),
    half_open_max_probes: clamp(c.half_open_max_probes, LIMITS.half_open_max_probes, BREAKER_DEFAULTS.half_open_max_probes),
  };
}

/**
 * Does this outcome say the UPSTREAM is unhealthy?
 * Built from the existing integration error vocabulary and failure kinds — nothing new.
 */
export function countsAsBreakerFailure({ ok, code, status, failure_kind }) {
  if (ok) return false;
  // Rate limiting is the upstream working correctly and telling us so — #31B's business, not ours.
  if (failure_kind === "rate_limited" || status === 429) return false;
  // Never sent: a breaker refusal, a rate-limit window, or a deterministic policy/budget refusal.
  if (failure_kind === "circuit_open" || failure_kind === "quota_exceeded" || failure_kind === "disabled" || failure_kind === "budget" || failure_kind === "invalid_url" || failure_kind === "runtime") return false;
  if (failure_kind === "timeout" || failure_kind === "network" || failure_kind === "oauth_timeout") return true;
  // Auth/configuration, validation and the platform's own faults are excluded by code.
  if (code === "TIMEOUT") return true;
  if (code !== "UPSTREAM_FAILURE") return false;
  // Remaining upstream failures count only when the SERVICE broke: 5xx (or a transport failure
  // with no status). A 4xx business error, a not_found and an MCP tool error do not.
  if (failure_kind === "not_found" || failure_kind === "client_error" || failure_kind === "tool_error") return false;
  return !Number.isFinite(status) || status === 0 || status >= 500;
}

export const breakerKeyOf = (project_id, integration_name, host) => `${project_id}|${integration_name}|${host}`;

// Workspace-scoped identity for MCP breakers. MCP connections are account-scoped builder
// infrastructure with no project, so the breaker is keyed by workspace + connection + host.
// The IntegrationBreaker row carries a RESERVED `project_id` namespace ("mcp") ONLY as a storage
// discriminator: it keeps MCP breakers disjoint from real project breakers (whose project_id is a
// real project id) and from other workspaces. No project is fabricated and no project record is
// implied — the namespace is a constant key, not a project.
export const MCP_BREAKER_NAMESPACE = "mcp";
export const mcpBreakerKeyOf = (workspace_id, connection_name, host) => `${workspace_id}|${connection_name}|${host}`;

const snapshot = (row, extra = {}) => ({
  state: row?.state || "CLOSED",
  failure_count: row?.failure_count || 0,
  threshold: row?.threshold ?? undefined,
  window_ms: row?.window_ms ?? undefined,
  opened_at: row?.opened_at || undefined,
  open_until: row?.open_until || undefined,
  probe_count: row?.probe_count || undefined,
  trips: row?.trips || undefined,
  ...extra,
});

const pruned = (row, now, window_ms) =>
  (row?.failure_times || []).filter((t) => now - Date.parse(t) < window_ms);

/**
 * The SINGLE state-machine implementation shared by project and MCP breakers.
 *
 *   check(...)  → { allow, probe_token, breaker_state }  — consulted BEFORE the call
 *   record(...) → breaker_state                          — ONE decision per logical call
 *
 * `keying` describes ONLY the storage identity (filter + row identity) — the CLOSED/OPEN/HALF_OPEN
 * transitions, the bounded probe discipline and the write-then-verify concurrency discipline are
 * identical for both scopes. Both are best-effort: a storage failure degrades this protection, it
 * never fails the call.
 */
function createBreakerCore(svc, keying, { trace_id = null } = {}) {
  const load = async (integration_name, host) => {
    // Scoped by the keying's three parts (project|integration|host OR workspace|connection|host).
    const rows = await svc.entities.IntegrationBreaker
      .filter(keying.filterArgs(integration_name, host), "-updated_at", 1)
      .catch(() => []);
    return rows[0] || null;
  };

  // Write-then-verify: both concurrent writers stamp their own token, and the one that finds a
  // foreign token knows it lost and re-applies its outcome onto the winner's state. That is what
  // stops two simultaneous failures from clobbering each other's count.
  const commit = async (integration_name, host, config, computePatch, attempts = 3) => {
    let row = await load(integration_name, host);
    for (let i = 0; i < attempts; i++) {
      const token = crypto.randomUUID();
      const patch = computePatch(row);
      if (!patch) return row ? snapshot(row) : null;
      const payload = {
        ...patch, writer_token: token, version: (row?.version || 0) + 1,
        threshold: config.threshold, window_ms: config.window_ms, open_ms: config.open_ms,
        half_open_max_probes: config.half_open_max_probes,
        updated_at: new Date().toISOString(), trace_id: trace_id || undefined,
      };
      let fresh;
      if (row) {
        await svc.entities.IntegrationBreaker.update(row.id, payload);
        fresh = await svc.entities.IntegrationBreaker.get(row.id);
      } else {
        fresh = await svc.entities.IntegrationBreaker.create({
          ...keying.identity(integration_name, host), ...payload,
        });
        // Two concurrent first failures can both find no row and both create one. The earliest row
        // is canonical: the later writer removes its own duplicate and re-applies its outcome onto
        // the canonical one, so one breaker never splits into two half-counted breakers.
        const all = await svc.entities.IntegrationBreaker
          .filter(keying.filterArgs(integration_name, host), "created_date", 5).catch(() => []);
        if (all.length > 1 && all[0].id !== fresh.id) {
          await svc.entities.IntegrationBreaker.delete(fresh.id).catch(() => {});
          row = all[0];
          continue;
        }
      }
      if (fresh?.writer_token === token) return snapshot(fresh);
      row = fresh; // lost the race — fold this outcome into the winner's state and retry
    }
    return snapshot(row);
  };

  return {
    async check({ integration, host, config }) {
      if (!host || config?.enabled === false) return { allow: true, breaker_state: null };
      const row = await load(integration, host);
      if (!row || row.state === "CLOSED") return { allow: true, breaker_state: row ? snapshot(row) : null };
      const now = Date.now();

      if (row.state === "OPEN") {
        if (Date.parse(row.open_until || 0) > now) {
          svc.entities.IntegrationBreaker.update(row.id, { refusals: (row.refusals || 0) + 1 }).catch(() => {});
          return { allow: false, breaker_state: snapshot(row, { refused_before_call: true, reason: "circuit_open", retry_after_ms: Date.parse(row.open_until) - now }) };
        }
        // The open period elapsed: admit ONE bounded probe.
        const state = await commit(integration, host, config, (current) => {
          if (current?.state === "HALF_OPEN" && Date.parse(current.probe_expires_at || 0) > now) return null;
          return { state: "HALF_OPEN", probe_token: crypto.randomUUID(), probe_expires_at: new Date(now + PROBE_TTL_MS).toISOString(), probe_count: (current?.probe_count || 0) + 1 };
        });
        const claimed = await load(integration, host);
        const mine = claimed?.state === "HALF_OPEN" && claimed.probe_token && Date.parse(claimed.probe_expires_at || 0) > now;
        if (!mine) return { allow: false, breaker_state: snapshot(claimed, { refused_before_call: true, reason: "probe_limit" }) };
        return { allow: true, probe_token: claimed.probe_token, breaker_state: snapshot(claimed, { probe: true }), ...(state ? {} : {}) };
      }

      // HALF_OPEN: only the bounded probe slot may pass. Everything else is refused, so recovery
      // never becomes a flood of concurrent probes against a struggling upstream.
      if (Date.parse(row.probe_expires_at || 0) > now) {
        return { allow: false, breaker_state: snapshot(row, { refused_before_call: true, reason: "probe_limit" }) };
      }
      const reclaimed = await commit(integration, host, config, (current) => ({
        state: "HALF_OPEN", probe_token: crypto.randomUUID(),
        probe_expires_at: new Date(now + PROBE_TTL_MS).toISOString(), probe_count: (current?.probe_count || 0) + 1,
      }));
      const claimed = await load(integration, host);
      const mine = claimed?.probe_token && Date.parse(claimed.probe_expires_at || 0) > now;
      if (!mine) return { allow: false, breaker_state: snapshot(claimed, { refused_before_call: true, reason: "probe_limit" }) };
      return { allow: true, probe_token: claimed.probe_token, breaker_state: snapshot(claimed, { probe: true, ...(reclaimed ? {} : {}) }) };
    },

    // ONE decision per logical call. `ok` and the error classification describe the whole call,
    // however many attempts the retry engine spent inside it.
    async record({ integration, host, config, ok, code = null, status = 0, failure_kind = null, probe_token = null }) {
      if (!host || config?.enabled === false) return null;
      const now = Date.now();
      const counted = countsAsBreakerFailure({ ok, code, status, failure_kind });
      try {
        if (ok) {
          return await commit(integration, host, config, (current) => {
            if (!current) return null; // nothing to remember: a healthy call on a closed breaker
            // A successful probe closes the breaker; an ordinary success clears the window.
            return { state: "CLOSED", failure_times: [], failure_count: 0, probe_token: null, probe_expires_at: null, opened_at: null, open_until: null, last_success_at: new Date(now).toISOString() };
          });
        }
        if (!counted) {
          const current = await load(integration, host);
          // A probe that failed for a reason the policy ignores must not hold the slot open.
          if (current?.state === "HALF_OPEN" && probe_token && current.probe_token === probe_token) {
            return await commit(integration, host, config, () => ({ state: "OPEN", probe_token: null, probe_expires_at: null, opened_at: new Date(now).toISOString(), open_until: new Date(now + config.open_ms).toISOString() }));
          }
          return current ? snapshot(current) : null;
        }
        return await commit(integration, host, config, (current) => {
          const times = [...pruned(current, now, config.window_ms), new Date(now).toISOString()].slice(-MAX_FAILURE_TIMES);
          const base = { failure_times: times, failure_count: times.length, last_failure_at: new Date(now).toISOString(), last_error_code: code || undefined, probe_token: null, probe_expires_at: null };
          // A failed probe returns straight to OPEN; otherwise the threshold decides.
          const trip = current?.state === "HALF_OPEN" || times.length >= config.threshold;
          if (!trip) return { ...base, state: "CLOSED" };
          return { ...base, state: "OPEN", opened_at: new Date(now).toISOString(), open_until: new Date(now + config.open_ms).toISOString(), trips: (current?.trips || 0) + 1 };
        });
      } catch (e) {
        log("warn", "integration.breaker_write_failed", { integration, host, error: e.message });
        return null;
      }
    },
  };
}

/**
 * The `breaker` dependency the project-integration execution path uses. Project-scoped:
 * project + integration + host.
 */
export function createIntegrationBreaker(client, { project, trace_id = null } = {}) {
  const svc = svcOf(client);
  const keying = {
    filterArgs: (integration_name, host) => ({ project_id: project.id, integration_name, host }),
    identity: (integration_name, host) => ({
      breaker_key: breakerKeyOf(project.id, integration_name, host), project_id: project.id,
      workspace_id: project.workspace_id || undefined, integration_name, host,
    }),
  };
  return createBreakerCore(svc, keying, { trace_id });
}

/**
 * The `breaker` dependency the MCP tool-invocation path uses. Workspace-scoped:
 * workspace + connection + host. Same state machine, same failure classification, different key.
 */
export function createMcpBreaker(client, { workspace_id, trace_id = null } = {}) {
  const svc = svcOf(client);
  const keying = {
    filterArgs: (connection_name, host) => ({ workspace_id, project_id: MCP_BREAKER_NAMESPACE, integration_name: connection_name, host }),
    identity: (connection_name, host) => ({
      breaker_key: mcpBreakerKeyOf(workspace_id, connection_name, host), project_id: MCP_BREAKER_NAMESPACE,
      workspace_id, integration_name: connection_name, host,
    }),
  };
  return createBreakerCore(svc, keying, { trace_id });
}

/** Project-scoped read of breaker state. `project_id` is mandatory. */
export async function listIntegrationBreakers(client, { project_id, limit = 50 }) {
  if (!project_id) throw Object.assign(new Error("project_id is required"), { status: 400, code: "INVALID_INPUT" });
  return await svcOf(client).entities.IntegrationBreaker.filter({ project_id }, "-updated_at", limit).catch(() => []);
}