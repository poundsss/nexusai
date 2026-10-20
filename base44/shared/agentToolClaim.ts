// Durable single-use claim on an in-app agent's (turn, step) — extracted from appAgentRuntime.
// The step protocol executes EXACTLY ONE tool per step, so the step number identifies the call.
// R-3: claim reads fail closed, only live claims compete, a thrown action is recorded as a
// failure, a lost result save is surfaced, and a result-less duplicate is a non-success
// in-progress outcome. UNKNOWN: atomicity still depends on database read consistency.
import { scrubText } from "./tracing.ts";

// R-4 recovery: a claim outlives every keyed retry (same window as the invoke index), so an
// expired claim can never let a retry re-run a step. A result-less claim older than the stale
// bound (the invoke run-lease TTL: its runner is gone) is resolved ONCE to a recorded
// TOOL_OUTCOME_UNKNOWN result — never re-executed — and the turn ends with a fixed reply.
// UNKNOWN boundary: whether the interrupted action took effect cannot be known (tool execution
// and result persistence are not atomic); the bound assumes no tool runs longer than it.
export const TOOL_RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOOL_CLAIM_STALE_MS = 10 * 60 * 1000;
export const OUTCOME_UNKNOWN_REPLY = "The previous attempt was interrupted while an action was running. Its outcome is unknown, so it was not repeated. Please check before trying again.";
export const TOOL_NAMESPACE = "appagent_tools";
export const RESULT_SAVE_ATTEMPTS = 3;
const agentError = (status, code, message) => Object.assign(new Error(String(message || code)), { status, code });

// R-6: a step claim records WHICH call it holds (tool name + input fingerprint). A retried turn
// whose model asks for a DIFFERENT call at an already-used step gets the recorded call's
// outcome labelled as such — the new call is NOT executed there and the old result is never
// mis-attributed to it; the model can re-issue it at the next (fresh) step.
export function toolFingerprint(name, input) {
  const s = `${String(name)}\u0000${JSON.stringify(input ?? null)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${String(name).slice(0, 80)}#${h.toString(16)}`;
}
const stepUsedByOther = (recorded) => {
  const tool = String(recorded || "").split("#")[0] || "another call";
  const message = `this step already executed ${tool} in an earlier attempt of this turn; the requested call was NOT executed here — issue it again if it is still needed`;
  return { ok: false, code: "TOOL_STEP_ALREADY_USED", step_mismatch: true, message, error: { code: "TOOL_STEP_ALREADY_USED", message }, observation: `[tool not run] ${message}` };
};

async function claimToolStep(svc, turnId, step, namespace, fingerprint = null) {
  const cache_key = `${namespace}:${turnId}:t${step}`;
  const expires_at = new Date(Date.now() + TOOL_RESULT_TTL_MS).toISOString();
  const readClaims = async () => {
    try {
      const rows = await svc.entities.CacheEntry.filter({ cache_key }, "created_date", 5);
      const now = Date.now();
      return rows.filter((r) => new Date(r.expires_at).getTime() > now);
    } catch {
      throw agentError(503, "AGENT_TOOL_CLAIM_UNAVAILABLE", "The tool step could not be verified; retry later.");
    }
  };
  const live = await readClaims();
  if (live.length) return { row: live[0], won: false };
  const mine = await svc.entities.CacheEntry.create({
    namespace: TOOL_NAMESPACE, cache_key, value: { claimed: true, claimed_at: new Date().toISOString(), ...(fingerprint ? { fingerprint } : {}) },
    expires_at, stale_at: expires_at, size_bytes: 64, version: 1,
  });
  const all = await readClaims();
  const won = (all[0]?.id || mine.id) === mine.id;
  return { row: won ? mine : all[0], won };
}

// Non-success duplicate outcome, shaped for every caller (observation / message / error).
const STEP_IN_PROGRESS_MESSAGE = "this step has no saved result yet (another attempt is executing or did not finish); it was NOT executed here";
const stepInProgress = () => ({
  ok: false, code: "TOOL_STEP_IN_PROGRESS", in_progress: true,
  message: STEP_IN_PROGRESS_MESSAGE,
  error: { code: "TOOL_STEP_IN_PROGRESS", message: STEP_IN_PROGRESS_MESSAGE },
  observation: `[tool duplicate] ${STEP_IN_PROGRESS_MESSAGE}`,
});

// Codes that end a turn through the normal cleanup path (settle/release, draft cleared).
export const TURN_ABORT_CODES = ["AGENT_TOOL_CLAIM_UNAVAILABLE", "AGENT_TOOL_RESULT_UNSAVED", "AGENT_TOOL_STEP_IN_PROGRESS"];
export const OUTCOME_UNKNOWN_CODE = "AGENT_TOOL_OUTCOME_UNKNOWN";

const outcomeUnknown = () => ({
  ok: false, code: "TOOL_OUTCOME_UNKNOWN", outcome_unknown: true,
  message: "interrupted; outcome unknown; not repeated",
  error: { code: "TOOL_OUTCOME_UNKNOWN", message: "interrupted; outcome unknown; not repeated" },
  observation: "[tool interrupted] outcome unknown; not repeated",
});

// An in-progress step stops the WHOLE turn: the action is never reissued at a later step.
// An unknown outcome also ends the turn (with OUTCOME_UNKNOWN_REPLY), so nothing re-issues it.
export function stopIfInProgress(r) {
  if (r && r.outcome_unknown) throw agentError(200, OUTCOME_UNKNOWN_CODE, OUTCOME_UNKNOWN_REPLY);
  if (r && r.in_progress) throw agentError(409, "AGENT_TOOL_STEP_IN_PROGRESS", "A tool step of this turn has no saved result yet; the turn was stopped instead of re-running it.");
}

export async function executeClaimed(svc, { turn, step, run, namespace = TOOL_NAMESPACE, fingerprint = null }) {
  const claim = await claimToolStep(svc, turn.id, step, namespace, fingerprint);
  if (!claim.won) {
    const v = claim.row.value || {};
    // Legacy claims (no recorded fingerprint) keep the certified replay behavior.
    // A finished different call is reported as such; an unfinished one falls through to the
    // certified in-progress / outcome-unknown handling (the turn stops either way).
    if (fingerprint && v.fingerprint && v.fingerprint !== fingerprint && v.result) return stepUsedByOther(v.fingerprint);
    if (v.result) return v.result;
    const at = new Date(v.claimed_at || claim.row.created_date).getTime();
    if (!(Date.now() - at > TOOL_CLAIM_STALE_MS)) return stepInProgress();
    // Stale result-less claim: record the unknown outcome durably so every later retry
    // replays it. A failed write is a retryable 503 — the step is still never re-run.
    const result = outcomeUnknown();
    try { await svc.entities.CacheEntry.update(claim.row.id, { value: { ...v, result } }); } catch {
      throw agentError(503, "AGENT_TOOL_CLAIM_UNAVAILABLE", "The tool step could not be verified; retry later.");
    }
    return result;
  }
  let result;
  try {
    result = await run();
  } catch (err) {
    // A thrown action is recorded as a failure so the claim never stays result-less.
    const code = String(err?.code || "TOOL_FAILED");
    const message = scrubText(String(err?.message || code), 200);
    result = { ok: false, code, message, error: { code, message }, observation: `tool failed: ${code} — ${message}` };
  }
  // Pipeline A: the result save is retried a bounded number of times (the action is NEVER
  // re-run), so a transient write failure no longer forces the turn into an unknown outcome.
  const value = { ...(claim.row.value || {}), claimed: true, result };
  let saved = false;
  for (let attempt = 0; attempt < RESULT_SAVE_ATTEMPTS && !saved; attempt++) {
    try { await svc.entities.CacheEntry.update(claim.row.id, { value }); saved = true; } catch { /* retry */ }
  }
  if (!saved) {
    // The action ran but its result is not durable: fail the turn rather than report success.
    // A retry finds the claim without a result and gets the in-progress outcome — never a re-run.
    throw agentError(503, "AGENT_TOOL_RESULT_UNSAVED", "The tool step ran but its result could not be saved; retry later.");
  }
  return result;
}