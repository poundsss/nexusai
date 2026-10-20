// Distributed rate limiting for the AUTHENTICATED control plane.
//
// The public runtime's in-memory limiter (rateLimit.ts) protects deployed apps per instance.
// This one is durable and shared across workers, because the expensive control-plane actions —
// AI runs, deployments, billing writes, invitations — must be limited for the account as a
// whole, not per warm instance.
//
// Rules:
//   * The identity is DERIVED SERVER-SIDE from the authenticated caller. A client cannot name
//     its own identity, or it could exempt itself or throttle somebody else.
//   * Counting is a read-modify-write with verification. Under a race the verified re-read
//     keeps the higher count, so the limiter errs toward enforcing rather than letting through.
//   * Fixed windows are keyed by timestamp, so counters self-expire instead of needing a reset.
import { recordMetric, log } from "./observability.ts";

export const API_LIMITS = {
  ai_run: { limit: 30, window_ms: 60000 },
  deploy: { limit: 10, window_ms: 60000 },
  billing_write: { limit: 20, window_ms: 60000 },
  invite: { limit: 20, window_ms: 3600000 },
  domain_verify: { limit: 30, window_ms: 3600000 },
  mcp_tool: { limit: 120, window_ms: 60000 },
  // Generated-app end-user auth (#29), keyed per project + hashed email/ip inside appAuth.
  app_signin: { limit: 10, window_ms: 300000 },
  app_signup: { limit: 20, window_ms: 3600000 },
  app_password_reset: { limit: 5, window_ms: 3600000 },
  app_verify: { limit: 5, window_ms: 3600000 },
  app_session: { limit: 60, window_ms: 60000 },
  // Delegated OAuth flows (#31G): begin + callback per resolved app user, per project.
  delegated_oauth: { limit: 20, window_ms: 3600000 },
  // Deployed-app social sign-in (P-9.8), keyed per project + hashed ip inside appOAuth.
  app_oauth_begin: { limit: 30, window_ms: 3600000 },
  app_oauth_callback: { limit: 30, window_ms: 3600000 },
  // Agent channel foundation (P-9.10A): connect-URL issuance per project + app user, and
  // webhook flood control per project (authenticated deliveries only) — keyed inside appAgentChannels.
  channel_activation: { limit: 20, window_ms: 3600000 },
  channel_webhook: { limit: 60, window_ms: 60000 },
  // Anonymous agent access (P-9.11C): the ONE necessary durable limit — anonymous identity
  // minting. Web conversation starts are keyed per project, channel chat bindings per chat
  // (keyed inside appAuth/appAgentChannels); authenticated limits are untouched.
  app_anonymous_session: { limit: 60, window_ms: 3600000 },
  default: { limit: 60, window_ms: 60000 },
};

export class RateLimited extends Error {
  constructor(action, detail) {
    super(`Rate limit exceeded for "${action}". Try again shortly.`);
    this.code = "RATE_LIMITED";
    this.status = 429;
    this.detail = detail;
  }
}

const svcOf = (base44) => base44.asServiceRole || base44;
export const limitFor = (action) => API_LIMITS[action] || API_LIMITS.default;
const windowKey = (window_ms, now) => new Date(Math.floor(now / window_ms) * window_ms).toISOString();

/**
 * Records one request against an identity+action budget.
 *
 * @returns { allowed, remaining, reset_at, count, limit } — the caller decides what to do; use
 *   `enforceLimit` when the request should simply be refused.
 */
export async function consume(base44, { identity, action, workspace_id = null, limit = null, window_ms = null, now = Date.now(), cost = 1 }) {
  const svc = svcOf(base44);
  if (!identity) throw new Error("apiLimits: identity is required");
  const cfg = limitFor(action);
  const max = limit && limit > 0 ? limit : cfg.limit;
  const win = window_ms && window_ms > 0 ? window_ms : cfg.window_ms;
  const window_key = windowKey(win, now);
  const reset_at = new Date(new Date(window_key).getTime() + win).toISOString();

  try {
    const existing = (await svc.entities.RateLimitBucket.filter({ identity, action, window_key }, "-created_date", 2))[0] || null;
    if (!existing) {
      const created = await svc.entities.RateLimitBucket.create({
        identity, action, window_key, window_start: window_key, window_ms: win, count: cost, limit: max,
        workspace_id, last_request_at: new Date(now).toISOString(),
      });
      return { allowed: cost <= max, remaining: Math.max(0, max - cost), reset_at, count: created.count, limit: max };
    }
    const count = (existing.count || 0) + cost;
    if (existing.count >= max) {
      await svc.entities.RateLimitBucket.update(existing.id, { blocked: (existing.blocked || 0) + 1, last_request_at: new Date(now).toISOString() });
      await recordMetric(base44, { metric: "ratelimit.blocked", labels: { action } });
      return { allowed: false, remaining: 0, reset_at, count: existing.count, limit: max };
    }
    await svc.entities.RateLimitBucket.update(existing.id, { count, limit: max, last_request_at: new Date(now).toISOString() });
    // Verification re-read: if a concurrent writer recorded a higher count, that count stands —
    // the limiter never lets a race lower the recorded usage.
    const fresh = await svc.entities.RateLimitBucket.get(existing.id);
    const effective = Math.max(count, fresh.count || 0);
    if (effective !== fresh.count) await svc.entities.RateLimitBucket.update(existing.id, { count: effective });
    return { allowed: effective <= max, remaining: Math.max(0, max - effective), reset_at, count: effective, limit: max };
  } catch (e) {
    // A limiter outage must not take the platform down with it; the request proceeds and the
    // failure is recorded rather than silently ignored.
    log("error", "ratelimit.unavailable", { action, error: e.message });
    return { allowed: true, remaining: null, reset_at, count: null, limit: max, degraded: true };
  }
}

// Refuses the request when the budget is spent. Use at the top of an expensive endpoint.
export async function enforceLimit(base44, args) {
  const res = await consume(base44, args);
  if (!res.allowed) throw new RateLimited(args.action, { reset_at: res.reset_at, limit: res.limit });
  return res;
}

// Identity is always server-derived: the authenticated user, optionally narrowed to the
// workspace they are acting in.
export const identityFor = ({ user, workspace_id = null }) => `user:${user?.id || "anonymous"}${workspace_id ? `:ws:${workspace_id}` : ""}`;

export async function limitStatus(base44, { identity, actions = Object.keys(API_LIMITS), now = Date.now() }) {
  const svc = svcOf(base44);
  const out = {};
  for (const action of actions) {
    if (action === "default") continue;
    const cfg = limitFor(action);
    const row = (await svc.entities.RateLimitBucket.filter({ identity, action, window_key: windowKey(cfg.window_ms, now) }, "-created_date", 1))[0] || null;
    out[action] = { used: row?.count || 0, limit: cfg.limit, window_ms: cfg.window_ms, blocked: row?.blocked || 0 };
  }
  return out;
}

// Housekeeping: windows older than a day carry no enforcement value and are removed.
export async function purgeOldBuckets(base44, { olderThanMs = 86400000, now = Date.now(), limit = 500 } = {}) {
  const svc = svcOf(base44);
  const rows = await svc.entities.RateLimitBucket.list("created_date", limit).catch(() => []);
  let purged = 0;
  for (const r of rows) {
    if (new Date(r.window_start || r.window_key).getTime() < now - olderThanMs) { await svc.entities.RateLimitBucket.delete(r.id).catch(() => {}); purged++; }
  }
  return { purged, scanned: rows.length };
}