// Best-effort, per-instance rate limiter for the PUBLIC app runtime.
//
// The public runtime has no authenticated identity, so the only available key is the
// app slug + the client IP. State is held in memory per warm instance: a warm worker
// shares counters across its requests, and a cold start simply resets the window
// (less strict — never stricter — so it fails safe). This is a P0 abuse control, not
// a distributed guarantee; it deliberately uses no external storage so it can be
// added without touching entities, auth, billing or deployment.
//
// Limits are centralized in RATE_LIMIT_CONFIG. Tune them there.

export const RATE_LIMIT_CONFIG = {
  WINDOW_MS: 60_000,   // sliding window length
  MAX_DB: 60,          // max "db" actions per slug+ip per window
  MAX_FN: 60,          // max "fn" actions per slug+ip per window
  MAX_AUTH: 30,        // max "auth" actions per slug+ip per window (signup/login are abuse-prone)
  MAX_FILES: 20,       // max "files" actions per slug+ip per window (uploads are the costliest path)
  KEY_TTL_MS: 120_000, // evict idle keys after this long to bound memory
};

// key -> { db: number[], fn: number[], auth: number[], files: number[] }  (request timestamps within the window)
const buckets = new Map();
let lastSweep = 0;

function clientIp(req) {
  try {
    const xff = req.headers?.get?.("x-forwarded-for");
    if (xff) return String(xff).split(",")[0].trim();
  } catch { /* fall through to unknown */ }
  return "unknown";
}

function sweep(now) {
  if (now - lastSweep < RATE_LIMIT_CONFIG.KEY_TTL_MS) return;
  lastSweep = now;
  const cutoff = now - RATE_LIMIT_CONFIG.KEY_TTL_MS;
  for (const [k, b] of buckets) {
    b.db = b.db.filter((t) => t > cutoff);
    b.fn = b.fn.filter((t) => t > cutoff);
    b.auth = b.auth.filter((t) => t > cutoff);
    b.files = b.files.filter((t) => t > cutoff);
    if (!b.db.length && !b.fn.length && !b.auth.length && !b.files.length) buckets.delete(k);
  }
}

// Returns true when the request is allowed, false when the limit is exceeded.
// Only "db", "fn", "auth" and "files" actions are limited; any other action is allowed unconditionally.
export function allowRequest(req, slug, action) {
  const now = Date.now();
  const field = action === "fn" ? "fn" : action === "auth" ? "auth" : action === "files" ? "files" : "db";
  const limit = action === "fn" ? RATE_LIMIT_CONFIG.MAX_FN : action === "auth" ? RATE_LIMIT_CONFIG.MAX_AUTH : action === "files" ? RATE_LIMIT_CONFIG.MAX_FILES : RATE_LIMIT_CONFIG.MAX_DB;
  const key = `${slug || ""}:${clientIp(req)}`;
  const windowStart = now - RATE_LIMIT_CONFIG.WINDOW_MS;

  let b = buckets.get(key);
  if (!b) { b = { db: [], fn: [], auth: [], files: [] }; buckets.set(key, b); }
  b[field] = b[field].filter((t) => t > windowStart);
  if (b[field].length >= limit) {
    sweep(now);
    return false;
  }
  b[field].push(now);
  sweep(now);
  return true;
}