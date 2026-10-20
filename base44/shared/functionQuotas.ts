// Server-side resource quotas for generated backend functions.
//
// Three limits, all enforced OUTSIDE the sandbox so generated code cannot raise, disable or
// swallow them:
//   • TIMEOUT_MS      — wall-clock ceiling, checked by the interpreter's tick.
//   • MAX_STEPS       — work ceiling (AST steps), catches infinite and quadratic loops that
//                       finish no unit of real work.
//   • MAX_OUTPUT_BYTES— response payload ceiling, applied to the serialized body after the
//                       handler returns.
//
// Quota violations are raised as QuotaExceeded, which the interpreter refuses to let user
// `try/catch` swallow, and are reported with deterministic codes and HTTP statuses.
// The limits live here; a caller may pass tighter values (tests do), never looser ones from
// generated code — the function's own config has no influence over them.

export const FUNCTION_QUOTAS = {
  TIMEOUT_MS: 15000,
  MAX_STEPS: 1000000,
  MAX_OUTPUT_BYTES: 262144, // 256 KB
  // Streaming (functions.fetch, additive): wall-clock ceiling for ONE streamed response. Applied
  // by the executor's pump, outside the sandbox — generated code cannot raise it. The byte
  // ceiling is the SAME MAX_OUTPUT_BYTES, applied cumulatively across chunks.
  MAX_STREAM_MS: 120000,
};

export const QUOTA_CODES = {
  timeout: { code: "FUNCTION_TIMEOUT", status: 504 },
  steps: { code: "FUNCTION_STEP_LIMIT", status: 500 },
  output: { code: "FUNCTION_OUTPUT_TOO_LARGE", status: 500 },
};

// Merge caller overrides with the defaults, ignoring anything non-positive.
export function resolveQuotas(overrides = {}) {
  const pick = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    timeoutMs: pick(overrides.timeoutMs, FUNCTION_QUOTAS.TIMEOUT_MS),
    maxSteps: pick(overrides.maxSteps, FUNCTION_QUOTAS.MAX_STEPS),
    maxOutputBytes: pick(overrides.maxOutputBytes, FUNCTION_QUOTAS.MAX_OUTPUT_BYTES),
    maxStreamMs: pick(overrides.maxStreamMs, FUNCTION_QUOTAS.MAX_STREAM_MS),
  };
}

// Maps a thrown error to a quota termination, or null when it is an ordinary failure.
export function classifyQuotaError(error, quotas) {
  const kind = error?.quota || (typeof error?.message === "string" && error.message.includes("step limit") ? "steps"
    : typeof error?.message === "string" && error.message.includes("time limit") ? "timeout" : null);
  if (!kind) return null;
  const { code, status } = QUOTA_CODES[kind] || QUOTA_CODES.steps;
  const message = kind === "timeout"
    ? `Function exceeded its ${quotas.timeoutMs}ms execution time limit and was terminated.`
    : `Function exceeded its ${quotas.maxSteps}-step execution limit and was terminated (possible infinite loop).`;
  return { kind, code, status, message };
}

// Output ceiling. Returns { json } when within budget, or { violation } — never a truncated
// body, so a caller can't mistake a clipped payload for a complete one.
export function enforceOutputSize(body, quotas) {
  const json = JSON.stringify(body === undefined ? null : body);
  const bytes = new TextEncoder().encode(json ?? "null").length;
  if (bytes > quotas.maxOutputBytes) {
    const { code, status } = QUOTA_CODES.output;
    return {
      violation: {
        kind: "output", code, status, bytes,
        message: `Function response of ${bytes} bytes exceeds the ${quotas.maxOutputBytes}-byte response limit.`,
      },
    };
  }
  return { json, bytes };
}