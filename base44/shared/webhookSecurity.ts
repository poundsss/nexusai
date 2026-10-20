// Request authentication for the PUBLIC webhook endpoint (appWebhook).
//
// The endpoint has no user session, so authenticity has to come from the request itself. Every
// delivery must carry a timestamp and an HMAC-SHA256 signature computed with the receiving
// project's own signing secret, and each of the four checks below runs BEFORE any project
// function executes:
//
//   1. RATE LIMIT — durable (shared across workers, not per warm instance), keyed on the
//      project + client IP, so flooding the endpoint cannot be spread across instances.
//   2. SIGNATURE — required. `HMAC-SHA256(secret, "<timestamp>.<raw body>")`, compared in
//      constant time, over the EXACT bytes received; a re-serialized body is not verified.
//   3. FRESHNESS — the signed timestamp must be inside a short window, so a captured request
//      stops being usable almost immediately.
//   4. REPLAY — a signature is accepted at most once inside that window, recorded durably, so
//      a request captured and re-sent within the window is refused too.
//
// The secret is a normal project secret (WEBHOOK_SIGNING_SECRET), so it is encrypted at rest
// and decrypted only here, server-side, at verification time. It is never echoed, logged or
// included in a rejection reason.
import { decryptSecretValue } from "./secretCrypto.ts";
import { consume } from "./apiLimits.ts";

export const SIGNING_SECRET_NAME = "WEBHOOK_SIGNING_SECRET";
export const SIGNATURE_HEADER = "x-nexus-signature";
export const TIMESTAMP_HEADER = "x-nexus-timestamp";
export const REPLAY_WINDOW_MS = 300000; // 5 minutes
export const WEBHOOK_RATE_LIMIT = { limit: 120, window_ms: 60000 };

export class WebhookRejected extends Error {
  constructor(code, message, status = 401) {
    super(message);
    this.name = "WebhookRejected";
    this.code = code;
    this.status = status;
  }
}

const svcOf = (client) => client.asServiceRole || client;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function computeSignature(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody ?? ""}`)));
}

// Length-independent comparison: a byte-by-byte early return would leak how much of a guessed
// signature was correct.
function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const clientIp = (headers) => String(headers["x-forwarded-for"] || headers["x-real-ip"] || "unknown").split(",")[0].trim();

// The project's signing secret, decrypted at the point of verification. A project with no
// secret configured cannot be delivered to — the endpoint refuses rather than falling back to
// accepting unsigned requests.
export async function resolveSigningSecret(client, projectId) {
  const svc = svcOf(client);
  const row = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: SIGNING_SECRET_NAME }, "name", 1))[0] || null;
  if (!row?.value) {
    throw new WebhookRejected("SIGNING_SECRET_NOT_CONFIGURED", `This project has no ${SIGNING_SECRET_NAME} configured, so signed webhook deliveries cannot be verified.`, 503);
  }
  return decryptSecretValue(projectId, SIGNING_SECRET_NAME, row.value);
}

// Durable single-use claim on one signature. The row is created, then re-read: if two workers
// raced, only the earliest row wins and the loser is treated as a replay — the limiter never
// lets a race admit the same signature twice.
async function claimSignatureOnce(client, cacheKey, now) {
  const svc = svcOf(client);
  const existing = await svc.entities.CacheEntry.filter({ cache_key: cacheKey }, "created_date", 5).catch(() => []);
  const live = existing.filter((r) => new Date(r.expires_at).getTime() > now);
  if (live.length) return false;
  const mine = await svc.entities.CacheEntry.create({
    namespace: "webhook_replay", cache_key: cacheKey, value: { claimed_at: new Date(now).toISOString() },
    expires_at: new Date(now + REPLAY_WINDOW_MS * 2).toISOString(), stale_at: new Date(now + REPLAY_WINDOW_MS * 2).toISOString(),
    size_bytes: 64, version: 1,
  });
  const all = (await svc.entities.CacheEntry.filter({ cache_key: cacheKey }, "created_date", 5).catch(() => [mine]));
  return (all[0]?.id || mine.id) === mine.id;
}

/**
 * The full pre-execution gate. Throws WebhookRejected on the first failed check; returns the
 * verified delivery id (the signature) when the request may proceed to the project function.
 */
export async function verifyWebhookRequest(client, { project, headers, rawBody, name, now = Date.now() }) {
  const ip = clientIp(headers);

  // 1. Rate limit — durable, and applied before any cryptography or database lookup for the
  //    payload, so a flood costs the platform as little as possible.
  const limit = await consume(client, {
    identity: `webhook:${project.id}:ip:${ip}`, action: "webhook",
    workspace_id: project.workspace_id, limit: WEBHOOK_RATE_LIMIT.limit, window_ms: WEBHOOK_RATE_LIMIT.window_ms, now,
  });
  if (!limit.allowed) {
    throw new WebhookRejected("RATE_LIMITED", `Too many webhook deliveries for this project. Retry after ${limit.reset_at}.`, 429);
  }

  // 2. Signature and timestamp must both be present.
  const provided = String(headers[SIGNATURE_HEADER] || "").replace(/^sha256=/, "").trim();
  const timestamp = String(headers[TIMESTAMP_HEADER] || "").trim();
  if (!provided || !timestamp) {
    throw new WebhookRejected("MISSING_SIGNATURE", `Both ${SIGNATURE_HEADER} and ${TIMESTAMP_HEADER} headers are required.`, 401);
  }

  // 3. Freshness — checked before the HMAC, since a stale request is refused either way.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - (ts < 1e12 ? ts * 1000 : ts)) > REPLAY_WINDOW_MS) {
    throw new WebhookRejected("EXPIRED_TIMESTAMP", `The signed timestamp is missing, malformed, or outside the ${REPLAY_WINDOW_MS / 1000}s delivery window.`, 401);
  }

  // 4. HMAC over the exact received bytes.
  const secret = await resolveSigningSecret(client, project.id);
  const expected = await computeSignature(secret, timestamp, rawBody ?? "");
  if (!constantTimeEqual(provided, expected)) {
    throw new WebhookRejected("INVALID_SIGNATURE", "The webhook signature does not match the request body.", 401);
  }

  // 5. Single use inside the window.
  const claimed = await claimSignatureOnce(client, `webhook_replay:${project.id}:${name}:${expected}`, now);
  if (!claimed) {
    throw new WebhookRejected("REPLAYED_REQUEST", "This signed webhook delivery was already processed.", 409);
  }

  return { delivery_id: expected, ip, rate_limit: { remaining: limit.remaining, reset_at: limit.reset_at } };
}