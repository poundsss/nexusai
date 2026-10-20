// R-4: durable idempotency index for keyed in-app agent invokes, on the EXISTING CacheEntry
// contract (top-level, server-filterable cache_key) — no schema change. One index row per
// (project, app user, idempotency key) records the turn, conversation and completed reply ids,
// so a same-key retry is resolved by a direct lookup however long the user's history is.
// A separate run LEASE (same claim pattern) lets exactly one runner work a key at a time, so a
// concurrent duplicate never writes a user message. UNKNOWN: both claims still depend on
// database read consistency (there is no unique index) — they are not proven exactly-once.
export const INVOKE_NAMESPACE = "appagent_invoke";
export const INVOKE_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // replay window for a key
export const INVOKE_LEASE_TTL_MS = 10 * 60 * 1000;           // a crashed runner blocks the key at most this long
const agentError = (status, code, message) => Object.assign(new Error(String(message || code)), { status, code });
const unavailable = () => agentError(503, "AGENT_HISTORY_UNAVAILABLE", "Conversation history could not be read; retry later.");

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function invokeIndexKey(projectId, userId, key) {
  return `${INVOKE_NAMESPACE}:${projectId}:${userId}:${await sha256Hex(key)}`;
}

async function readLive(svc, cache_key) {
  let rows;
  try { rows = await svc.entities.CacheEntry.filter({ cache_key }, "created_date", 5); } catch { throw unavailable(); }
  const now = Date.now();
  return rows.filter((r) => new Date(r.expires_at).getTime() > now);
}

/** Resolves or claims a row; the earliest live row wins. Read failures are 503. */
export async function claimInvoke(svc, cache_key, ttlMs = INVOKE_INDEX_TTL_MS) {
  const live = await readLive(svc, cache_key);
  if (live.length) return { row: live[0], won: false };
  const expires_at = new Date(Date.now() + ttlMs).toISOString();
  const mine = await svc.entities.CacheEntry.create({
    namespace: INVOKE_NAMESPACE, cache_key, value: { claimed_at: new Date().toISOString() },
    expires_at, stale_at: expires_at, size_bytes: 128, version: 1,
  });
  const all = await readLive(svc, cache_key);
  const won = (all[0]?.id || mine.id) === mine.id;
  if (!won) await svc.entities.CacheEntry.delete(mine.id).catch(() => {}); // expires on its own otherwise
  return { row: won ? mine : all[0], won };
}

/** Fresh fail-closed re-read of the index row (another runner may have completed it). */
export async function rereadInvoke(svc, row) {
  return (await readLive(svc, row.cache_key)).find((r) => r.id === row.id) || row;
}

export async function recordInvoke(svc, row, patch) {
  const value = { ...(row.value || {}), ...patch };
  try { await svc.entities.CacheEntry.update(row.id, { value }); } catch {
    throw agentError(503, "AGENT_INVOKE_INDEX_UNSAVED", "The request could not be recorded; retry later.");
  }
  row.value = value;
  return row;
}

export const claimLease = (svc, cache_key) => claimInvoke(svc, `${cache_key}:lease`, INVOKE_LEASE_TTL_MS);
export async function releaseLease(svc, lease) {
  if (lease) await svc.entities.CacheEntry.delete(lease.id).catch(() => {}); // expires on its own if this fails
}

export const inProgress = () => agentError(409, "AGENT_TURN_IN_PROGRESS", "An identical request is already being processed; retry shortly.");

/** Fail-closed fetch of an indexed AppRecord: read failure → 503, absent/foreign → null. */
export async function indexedRow(svc, { project, user, id, entity }) {
  if (!id) return null;
  let rows;
  try { rows = await svc.entities.AppRecord.filter({ id: String(id), project_id: project.id, owner_id: user.id, entity_name: entity }, "created_date", 1); } catch { throw unavailable(); }
  return rows[0] || null;
}