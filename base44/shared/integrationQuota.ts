// Per-project integration call quota (#31D).
//
// It answers exactly one question before a call BEGINS: "has THIS project's THIS integration
// already used every logical call it is allowed inside the current window?" When the answer is
// yes the call is refused deterministically, without contacting the upstream, until the window
// rolls forward. This is a usage LIMIT, not money: nothing here touches the credit ledger, and no
// second ledger is introduced.
//
// What it counts is deliberately narrow:
//   • ONE logical invocation consumes ONE unit. The retry engine spending three HTTP attempts is
//     still one unit, so a 429 retry window can never double-charge the quota (#31B).
//   • A call refused BEFORE execution began — an OPEN circuit breaker (#31C) — consumes NOTHING,
//     because the quota governs calls the platform actually began executing.
//   • A quota refusal is itself never usage; it is counted separately as a refusal.
//
// Isolation is structural: the state key is project + integration, so project A can never consume
// project B's allowance, and two integrations in one project are counted apart. The project is
// always the EXECUTING project record — never a client-supplied id — and every read is filtered by
// it, so quota state is unreachable across projects.
//
// Window rollover is lazy and deterministic: an expired window is rolled forward by the next call
// itself. There is no cleanup job and no new scheduler.
import { log } from "./observability.ts";

const svcOf = (base44) => base44.asServiceRole || base44;

// Bounded defaults. A project may tune them, but only inside these limits: a quota can never be
// configured to be unbounded, and a window can never be made effectively infinite.
export const QUOTA_DEFAULTS = { limit: 1000, window_ms: 3_600_000 };
const LIMITS = { limit: [1, 100_000], window_ms: [1_000, 86_400_000] };

const clamp = (value, [lo, hi], fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

/** Resolves the effective quota configuration for one integration document. */
export function quotaConfig(integration = {}) {
  const c = integration.quota || {};
  if (c.enabled === false) return { enabled: false, ...QUOTA_DEFAULTS };
  return {
    enabled: true,
    limit: clamp(c.limit ?? c.calls ?? c.max_calls, LIMITS.limit, QUOTA_DEFAULTS.limit),
    window_ms: clamp(c.window_ms, LIMITS.window_ms, QUOTA_DEFAULTS.window_ms),
  };
}

export const quotaKeyOf = (project_id, integration_name) => `${project_id}|${integration_name}`;

const snapshot = (row, extra = {}) => ({
  status: row?.status || "ok",
  used: row?.used || 0,
  allowed: row?.allowed ?? undefined,
  remaining: Math.max(0, (row?.allowed ?? 0) - (row?.used || 0)),
  window_ms: row?.window_ms ?? undefined,
  window_start: row?.window_start || undefined,
  window_end: row?.window_end || undefined,
  windows: row?.windows || undefined,
  refusals: row?.refusals || undefined,
  ...extra,
});

const expired = (row, now) => !row?.window_end || Date.parse(row.window_end) <= now;

/**
 * The `quota` dependency the integration execution path uses.
 *
 *   consume(...) → { allow, quota_state }  — called ONCE per logical call, before execution
 *
 * Best-effort on storage failure: a quota that cannot be read must not fail the integration call
 * (failing closed here would break every project's integrations on a storage blip), but it is
 * logged so the gap is visible.
 */
export function createIntegrationQuota(client, { project, trace_id = null } = {}) {
  const svc = svcOf(client);

  const load = async (integration_name) => {
    // Scoped by project AND integration — the two parts of the key.
    const rows = await svc.entities.IntegrationQuota
      .filter({ project_id: project.id, integration_name }, "-updated_at", 1)
      .catch(() => []);
    return rows[0] || null;
  };

  // Write-then-verify, the same concurrency discipline the breaker uses: each writer stamps its own
  // token and re-reads. A writer that finds a foreign token knows it lost the race and re-applies
  // its own consumption onto the winner's state, so two simultaneous calls can never both believe
  // they claimed the same last unit.
  const commit = async (integration_name, config, computePatch, attempts = 4) => {
    let row = await load(integration_name);
    for (let i = 0; i < attempts; i++) {
      const token = crypto.randomUUID();
      const patch = computePatch(row);
      if (!patch) return { row, won: true };
      const payload = {
        ...patch, writer_token: token, version: (row?.version || 0) + 1,
        allowed: config.limit, window_ms: config.window_ms,
        updated_at: new Date().toISOString(), trace_id: trace_id || undefined,
      };
      let fresh;
      if (row) {
        await svc.entities.IntegrationQuota.update(row.id, payload);
        fresh = await svc.entities.IntegrationQuota.get(row.id);
      } else {
        fresh = await svc.entities.IntegrationQuota.create({
          quota_key: quotaKeyOf(project.id, integration_name), project_id: project.id,
          workspace_id: project.workspace_id || undefined, integration_name, ...payload,
        });
        // Two concurrent first calls can both find no row and both create one. The earliest row is
        // canonical: the later writer removes its own duplicate and re-applies its consumption onto
        // the canonical one, so one quota never splits into two half-counted quotas.
        const all = await svc.entities.IntegrationQuota
          .filter({ project_id: project.id, integration_name }, "created_date", 5).catch(() => []);
        if (all.length > 1 && all[0].id !== fresh.id) {
          await svc.entities.IntegrationQuota.delete(fresh.id).catch(() => {});
          row = all[0];
          continue;
        }
      }
      if (fresh?.writer_token === token) return { row: fresh, won: true };
      row = fresh; // lost the race — fold this consumption into the winner's state and retry
    }
    return { row, won: false };
  };

  return {
    /**
     * Claims ONE quota unit for a logical call that is about to begin executing.
     * Returns { allow: false } with the state when the window's allowance is already spent.
     */
    async consume({ integration, config }) {
      if (config?.enabled === false) return { allow: true, quota_state: null };
      try {
        const now = Date.now();
        let refused = false;
        const { row } = await commit(integration, config, (current) => {
          // An expired window rolls forward here, in the call that noticed it — no cleanup job.
          if (!current || expired(current, now)) {
            return {
              used: 1, status: config.limit <= 1 ? "exhausted" : "ok",
              window_start: new Date(now).toISOString(),
              window_end: new Date(now + config.window_ms).toISOString(),
              windows: (current?.windows || 0) + 1,
              last_consumed_at: new Date(now).toISOString(),
            };
          }
          if ((current.used || 0) >= config.limit) {
            refused = true;
            return {
              status: "exhausted", refusals: (current.refusals || 0) + 1,
              last_refused_at: new Date(now).toISOString(),
              // window_start/window_end are deliberately untouched: a refusal never extends or
              // resets the window it was refused in.
            };
          }
          const used = (current.used || 0) + 1;
          return {
            used, status: used >= config.limit ? "exhausted" : "ok",
            last_consumed_at: new Date(now).toISOString(),
          };
        });
        if (refused) {
          return {
            allow: false,
            quota_state: snapshot(row, { refused_before_call: true, reason: "quota_exceeded", retry_after_ms: Math.max(0, Date.parse(row?.window_end || 0) - now) }),
          };
        }
        return { allow: true, quota_state: snapshot(row, { consumed: 1 }) };
      } catch (e) {
        log("warn", "integration.quota_write_failed", { integration, error: e.message });
        return { allow: true, quota_state: null };
      }
    },
  };
}

/** Project-scoped read of integration quota state. `project_id` is mandatory. */
export async function listIntegrationQuotas(client, { project_id, limit = 50 }) {
  if (!project_id) throw Object.assign(new Error("project_id is required"), { status: 400, code: "INVALID_INPUT" });
  return await svcOf(client).entities.IntegrationQuota.filter({ project_id }, "-updated_at", limit).catch(() => []);
}