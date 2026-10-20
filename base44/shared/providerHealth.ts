// Provider health state for the model gateway.
//
// This is NOT a second health system: the routing gate already exists (`withProviderHealth` in
// aiRouter.ts, which marks an unhealthy provider's models unavailable). What was missing is the
// STATE that gate consumes. This module is that state and nothing else — a small circuit breaker
// keyed by the BILLING provider (google/openai/anthropic), fed by the gateway's own call outcomes.
//
// Deliberately in-memory: it is a short-lived availability signal for the worker making calls,
// not a durable fact about the platform, so it must never outlive the process or need a table.
// Durable evidence of provider failures already exists (AIRun.error, TraceEvent spans, metrics).

const FAILURE_THRESHOLD = 3;
const OPEN_MS = 60000;

const STATE = new Map();

const entry = (provider) => {
  let s = STATE.get(provider);
  if (!s) { s = { failures: 0, opened_until: 0, last_error: null, last_code: null }; STATE.set(provider, s); }
  return s;
};

/** Records one provider call outcome. Consecutive transient failures open the breaker. */
export function recordProviderResult(provider, { ok, code = null, error = null } = {}) {
  if (!provider) return;
  const s = entry(provider);
  if (ok) { s.failures = 0; s.opened_until = 0; s.last_error = null; s.last_code = null; return; }
  s.failures += 1;
  s.last_code = code || null;
  s.last_error = String(error?.message || error || "").slice(0, 200);
  if (s.failures >= FAILURE_THRESHOLD) s.opened_until = Date.now() + OPEN_MS;
}

export function isProviderHealthy(provider, now = Date.now()) {
  const s = STATE.get(provider);
  return !(s && s.opened_until > now);
}

/** The snapshot `withProviderHealth` consumes: { <provider>: { healthy, reason } }. */
export function providerHealth(now = Date.now()) {
  const out = {};
  for (const [provider, s] of STATE) {
    if (s.opened_until > now) {
      out[provider] = { healthy: false, reason: `${s.failures} consecutive failures (${s.last_code || "provider error"}); retrying after ${new Date(s.opened_until).toISOString()}` };
    }
  }
  return out;
}

/** Test/administrative reset. Never called on a normal execution path. */
export function resetProviderHealth(provider = null) {
  if (provider) STATE.delete(provider); else STATE.clear();
}

/** Forces a breaker open — used by the verification suite to assert the routing gate reacts. */
export function markProviderUnhealthy(provider, reason = "forced unhealthy", ms = OPEN_MS) {
  const s = entry(provider);
  s.failures = FAILURE_THRESHOLD;
  s.last_code = "FORCED";
  s.last_error = reason;
  s.opened_until = Date.now() + ms;
}