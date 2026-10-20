// AI run phase leasing + bounded phase retries.
//
// A run executes as a sequence of phases, each in its own worker request, driven by a workflow
// that can legitimately fire again while a phase is still running (retry, overlap, restart). Two
// guarantees are needed and both are persisted ON THE RUN — never in worker memory, so a restart
// cannot reset them:
//
//   * AT-MOST-ONE WORKER per phase — a lease token is written and then re-read, so two workers
//     that claim simultaneously cannot both proceed, and the loser walks away without executing.
//     The commit path re-asserts the lease immediately before it mutates canonical state, so a
//     worker that lost its lease (slow, resumed, presumed dead) can never commit behind the
//     winner's back.
//   * BOUNDED RETRIES — a transient phase failure (provider blip, timeout, storage hiccup) is
//     retried a fixed number of times per phase; a deterministic failure (validation, auth,
//     budget, version conflict, security) is never retried, because repeating it cannot change
//     the outcome. The counter lives in `phase_attempts`, so the budget survives worker restarts.
//
// This reuses the run's own identifiers and the existing commit journal for idempotency; it adds
// no queue, no second worker system and no new billing behaviour.

export const PHASE_LEASE_MS = 150000;
export const MAX_PHASE_ATTEMPTS = 3;

export class PhaseLeaseLost extends Error {
  constructor(run_id, phase) {
    super(`Lease lost for run ${run_id} phase ${phase}: another worker owns this phase, so this worker must not continue`);
    this.code = "PHASE_LEASE_LOST";
    this.status = 409;
    this.retryable = false;
  }
}

// Failures that are a property of the request, not of the moment. Retrying them would burn
// credits and time to reach the identical outcome, so they go terminal on the first attempt.
const NON_RETRYABLE_CODES = new Set([
  "NO_COMPATIBLE_MODEL", "MODEL_TOO_EXPENSIVE", "INSUFFICIENT_CREDITS", "BUDGET_EXCEEDED",
  "PLAN_LIMIT_EXCEEDED", "AUTH_REQUIRED", "FORBIDDEN", "INVALID_INPUT", "VALIDATION_ERROR",
  "VERSION_CONFLICT", "PHASE_LEASE_LOST", "UNKNOWN_MODEL", "SCHEMA_VIOLATION",
]);
const NON_RETRYABLE_RE = /(version conflict|not authorized|forbidden|invalid|budget|insufficient credits|no compatible model|lease lost|build failed)/i;
const RETRYABLE_RE = /(timed out|timeout|temporarily|unavailable|rate limit|429|50[0234]|econnreset|socket hang up|network|fetch failed|overloaded|provider error)/i;

/** Whether a phase failure is worth another attempt. Defaults to NOT retrying when unsure. */
export function isRetryablePhaseError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  if (error.retryable === false) return false;
  const code = error.code || "";
  if (NON_RETRYABLE_CODES.has(code)) return false;
  const msg = String(error.message || error);
  if (NON_RETRYABLE_RE.test(msg)) return false;
  return RETRYABLE_RE.test(msg);
}

const nowIso = () => new Date().toISOString();
const token = () => `phase_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const svcOf = (base44) => base44.asServiceRole || base44;

export const phaseAttempts = (run, phase) => Number((run?.phase_attempts || {})[phase] || 0);

/**
 * Claims the run's current phase for one worker.
 *
 * Returns `{ ok: false }` when another worker holds a live lease — the caller must then do
 * nothing at all, which is what makes a duplicate workflow tick harmless. On success the
 * attempt counter for that phase has already been incremented and persisted.
 */
export async function acquirePhaseLease(base44, run, { worker_id, phase, lease_ms = PHASE_LEASE_MS, now = Date.now() }) {
  const svc = svcOf(base44);
  const fresh = await svc.entities.AIRun.get(run.id);
  const expires = Date.parse(fresh.phase_lease_expires_at || "");
  const heldByOther =
    fresh.phase_lease_token &&
    fresh.phase_lease_owner !== worker_id &&
    Number.isFinite(expires) && expires > now;
  if (heldByOther) {
    return { ok: false, reason: "lease_held", holder: fresh.phase_lease_owner, expires_at: fresh.phase_lease_expires_at, run: fresh };
  }

  const mine = token();
  const attempt = phaseAttempts(fresh, phase) + 1;
  await svc.entities.AIRun.update(run.id, {
    phase_lease_token: mine, phase_lease_owner: worker_id,
    phase_lease_expires_at: new Date(now + lease_ms).toISOString(),
    phase_attempts: { ...(fresh.phase_attempts || {}), [phase]: attempt },
    heartbeat_at: nowIso(),
  });
  // Confirm the write landed with US: if a racing worker's write won, we do not execute.
  const confirmed = await svc.entities.AIRun.get(run.id);
  if (confirmed.phase_lease_token !== mine) {
    return { ok: false, reason: "claim_lost", holder: confirmed.phase_lease_owner, run: confirmed };
  }
  return { ok: true, lease_token: mine, attempt, run: confirmed };
}

/** Re-asserts ownership. Called immediately before canonical state is mutated. */
export async function assertPhaseLease(base44, run, lease_token, phase) {
  if (!lease_token) return;
  const fresh = await svcOf(base44).entities.AIRun.get(run.id);
  if (fresh.phase_lease_token !== lease_token) throw new PhaseLeaseLost(run.id, phase);
}

/** Releases the lease if we still hold it, so the next phase can be claimed immediately. */
export async function releasePhaseLease(base44, run_id, lease_token) {
  if (!lease_token) return;
  const svc = svcOf(base44);
  const fresh = await svc.entities.AIRun.get(run_id).catch(() => null);
  if (!fresh || fresh.phase_lease_token !== lease_token) return;
  await svc.entities.AIRun.update(run_id, { phase_lease_token: null, phase_lease_expires_at: null, heartbeat_at: nowIso() }).catch(() => {});
}

/**
 * Records a retryable phase failure and leaves the run in its CURRENT phase so the executor
 * workflow drives it again. Returns false when the persisted retry budget is spent, in which
 * case the caller fails the run through its existing terminal path.
 */
export async function schedulePhaseRetry(base44, run, phase, error, { max_attempts = MAX_PHASE_ATTEMPTS } = {}) {
  const svc = svcOf(base44);
  const fresh = await svc.entities.AIRun.get(run.id);
  const attempt = phaseAttempts(fresh, phase);
  if (attempt >= max_attempts) return { retrying: false, attempt, max_attempts };
  await svc.entities.AIRun.update(run.id, {
    // Status/phase are untouched: the run stays exactly where it was, which is what makes the
    // retry a continuation of the same operation rather than a new one.
    phase_error_code: error?.code || "PHASE_RETRY",
    error: `Attempt ${attempt} of phase "${phase}" failed and will be retried: ${String(error?.message || error).slice(0, 300)}`,
    phase_lease_token: null, phase_lease_expires_at: null, heartbeat_at: nowIso(),
  });
  return { retrying: true, attempt, max_attempts };
}