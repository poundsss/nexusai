// Shared worker-boundary authentication (G-3).
//
// The five background worker entry points (aiRunStep, deployStep, githubSyncStep,
// agentStep, reapStaleRuns) act with the SERVICE ROLE on persisted ids only —
// authorization happened when the work was enqueued. Nothing about them is safe
// for an outside caller to invoke directly, so every one of them authenticates
// the request itself before touching anything:
//
//   1. The platform's own workflow invocations are trusted by the `x-workflow-run`
//      header, which the platform injects on internal `invoke_backend_function`
//      calls. A client-supplied value does not survive the gateway (verified
//      empirically: a forged header never reaches the function), so its presence
//      is proof the call came from the workflow engine.
//   2. Every other caller — including function-to-function and test invocations —
//      must present the shared WORKER_SECRET, either in the `x-worker-secret`
//      header or as `Authorization: Bearer <secret>`. If the secret is not
//      configured the boundary FAILS CLOSED: no external invocation is allowed.
import { secrets } from "base44:runtime";

export const WORKER_SECRET_NAME = "WORKER_SECRET";
export const WORKER_SECRET_HEADER = "x-worker-secret";

// Constant-time string comparison — no early exit on mismatch, so a wrong
// secret is not distinguishable from a right one by response timing.
export function timingSafeEqual(a, b) {
  const aStr = String(a ?? "");
  const bStr = String(b ?? "");
  const len = Math.max(aStr.length, bStr.length);
  let diff = aStr.length ^ bStr.length;
  for (let i = 0; i < len; i++) {
    diff |= (aStr.charCodeAt(i) || 0) ^ (bStr.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function presentedWorkerSecret(req) {
  const header = req.headers.get(WORKER_SECRET_HEADER);
  if (header) return header;
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
}

// Pure decision core — testable without touching the configured secret.
export function workerAuthDecision(req, expectedSecret) {
  if (req.headers.get("x-workflow-run")) {
    return { ok: true, via: "workflow" };
  }
  const presented = presentedWorkerSecret(req);
  if (!presented) return { ok: false, code: "WORKER_AUTH_REQUIRED" };
  if (!expectedSecret) return { ok: false, code: "WORKER_SECRET_NOT_CONFIGURED" };
  if (!timingSafeEqual(presented, expectedSecret)) return { ok: false, code: "WORKER_AUTH_INVALID" };
  return { ok: true, via: "secret" };
}

// Drop-in guard for a worker entry point. Returns null when the caller is
// authenticated, or a ready-to-return 401 Response when it is not.
export function requireWorkerAuth(req) {
  const expected = secrets.get(WORKER_SECRET_NAME);
  const decision = workerAuthDecision(req, expected);
  if (decision.ok) return null;
  return Response.json(
    { error: "Unauthorized", code: decision.code },
    { status: 401 },
  );
}