// Durable read-through cache with single-flight refresh.
//
// Correctness rules that make a cache safe rather than dangerous:
//   * A tenant-scoped value MUST carry its workspace/project id in the key. `scopedKey` builds
//     keys so a lookup can never return another account's data.
//   * A hard-expired value is NEVER served. Between stale_at and expires_at it may be served
//     while ONE caller refreshes (single-flight), which is what prevents a stampede on the
//     source when a hot key expires.
//   * The cache is a copy of data the caller could already read: no credentials, no secrets.
//   * A cache failure must never fail the request — every path falls back to the loader.
import { recordMetric, log } from "./observability.ts";

const MAX_VALUE_BYTES = 10000;
const DEFAULT_TTL_MS = 300000;
const LOCK_MS = 15000;

// L1: per-instance memory, bounded and cheap. A cold instance simply misses through to L2.
const memory = new Map();
const MEMORY_MAX = 200;

const svcOf = (base44) => base44.asServiceRole || base44;
const nowIso = () => new Date().toISOString();

export const scopedKey = (namespace, parts) => `${namespace}:${[].concat(parts).filter((p) => p !== null && p !== undefined).join(":")}`;

function memGet(key, now) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.expires <= now) { memory.delete(key); return null; }
  return hit;
}

function memSet(key, value, expires, version) {
  if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value);
  memory.set(key, { value, expires, version });
}

export const clearMemoryCache = () => memory.clear();

const row = async (svc, cache_key) => (await svc.entities.CacheEntry.filter({ cache_key }, "-updated_date", 1))[0] || null;

export async function get(base44, cache_key, { now = Date.now() } = {}) {
  const svc = svcOf(base44);
  const mem = memGet(cache_key, now);
  if (mem) return { value: mem.value, source: "memory", version: mem.version, stale: false };
  const found = await row(svc, cache_key);
  if (!found) return null;
  const expires = new Date(found.expires_at).getTime();
  if (expires <= now) return null;
  const stale = found.stale_at ? new Date(found.stale_at).getTime() <= now : false;
  if (!stale) memSet(cache_key, found.value, expires, found.version);
  return { value: found.value, source: "store", version: found.version, stale, entry: found };
}

/**
 * Writes a value. Oversized values are REFUSED rather than truncated or stored — a cache write
 * must never be the reason a record fails to save, and a clipped value would be silently wrong.
 */
export async function set(base44, cache_key, value, { namespace = null, ttl_ms = DEFAULT_TTL_MS, stale_ms = null, now = Date.now() } = {}) {
  const svc = svcOf(base44);
  const wrapped = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
  const size_bytes = JSON.stringify(wrapped).length;
  if (size_bytes > MAX_VALUE_BYTES) {
    log("warn", "cache.value_too_large", { cache_key, size_bytes });
    await recordMetric(base44, { metric: "cache.rejected", labels: { reason: "too_large" } });
    return { stored: false, reason: "value too large to cache", size_bytes };
  }
  const expires_at = new Date(now + ttl_ms).toISOString();
  const stale_at = new Date(now + Math.min(ttl_ms, stale_ms ?? Math.round(ttl_ms * 0.6))).toISOString();
  const existing = await row(svc, cache_key);
  const fields = {
    namespace: namespace || String(cache_key).split(":")[0], cache_key, value: wrapped,
    expires_at, stale_at, size_bytes, last_refreshed_at: nowIso(), lock_token: null, lock_expires_at: null,
  };
  const saved = existing
    ? await svc.entities.CacheEntry.update(existing.id, { ...fields, version: (existing.version || 1) + 1 })
    : await svc.entities.CacheEntry.create({ ...fields, version: 1 });
  memSet(cache_key, wrapped, now + ttl_ms, saved.version);
  return { stored: true, entry: saved, version: saved.version };
}

// Single-flight lock. Only the holder recomputes; everyone else serves stale or computes without
// writing, so the source sees one refresh per key instead of one per caller.
async function acquireLock(svc, entry, cache_key, now) {
  const mine = `lock_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const locked = entry?.lock_token && entry.lock_expires_at && new Date(entry.lock_expires_at).getTime() > now;
  if (locked) return null;
  if (!entry) return mine; // no row yet: the writer creates it
  await svc.entities.CacheEntry.update(entry.id, { lock_token: mine, lock_expires_at: new Date(now + LOCK_MS).toISOString() });
  const fresh = await svc.entities.CacheEntry.get(entry.id);
  return fresh.lock_token === mine ? mine : null;
}

/**
 * Read-through with stale-while-revalidate.
 *
 * @param loader recomputes the value. Always called when nothing servable exists, so a cache
 *   miss degrades to a normal read rather than an error.
 */
export async function getOrSet(base44, { key, namespace = null, ttl_ms = DEFAULT_TTL_MS, stale_ms = null, loader, now = Date.now() }) {
  const svc = svcOf(base44);
  const cache_key = key;
  let hit = null;
  try { hit = await get(base44, cache_key, { now }); } catch (e) { log("warn", "cache.read_failed", { cache_key, error: e.message }); }

  if (hit && !hit.stale) {
    await recordMetric(base44, { metric: "cache.hit", labels: { namespace: namespace || cache_key.split(":")[0] } });
    if (hit.entry) svc.entities.CacheEntry.update(hit.entry.id, { hits: (hit.entry.hits || 0) + 1 }).catch(() => {});
    return { value: hit.value, cached: true, stale: false, source: hit.source };
  }

  const entry = hit?.entry || (await row(svc, cache_key));
  const lock = await acquireLock(svc, entry, cache_key, now).catch(() => null);

  if (!lock && hit?.stale) {
    // Someone else is already refreshing: serve the still-valid stale value rather than piling on.
    await recordMetric(base44, { metric: "cache.stale_served", labels: { namespace: namespace || cache_key.split(":")[0] } });
    return { value: hit.value, cached: true, stale: true, source: hit.source };
  }

  await recordMetric(base44, { metric: "cache.miss", labels: { namespace: namespace || cache_key.split(":")[0] } });
  const value = await loader();
  if (lock) {
    const stored = await set(base44, cache_key, value, { namespace, ttl_ms, stale_ms, now }).catch(() => ({ stored: false }));
    return { value: stored.entry ? stored.entry.value : value, cached: false, stale: false, stored: stored.stored, source: "loader" };
  }
  // No lock and nothing servable: compute for this caller only, so the source is never
  // hammered by every concurrent miss writing the same key.
  return { value, cached: false, stale: false, stored: false, source: "loader" };
}

export async function invalidate(base44, cache_key) {
  const svc = svcOf(base44);
  memory.delete(cache_key);
  const found = await row(svc, cache_key);
  if (found) await svc.entities.CacheEntry.delete(found.id);
  await recordMetric(base44, { metric: "cache.invalidated", labels: { scope: "key" } });
  return { invalidated: found ? 1 : 0 };
}

// Namespace invalidation, used whenever a source of truth changes (a plan edit, a catalog sync).
export async function invalidateNamespace(base44, namespace) {
  const svc = svcOf(base44);
  const rows = await svc.entities.CacheEntry.filter({ namespace }, "-created_date", 500).catch(() => []);
  for (const r of rows) { memory.delete(r.cache_key); await svc.entities.CacheEntry.delete(r.id).catch(() => {}); }
  await recordMetric(base44, { metric: "cache.invalidated", value: rows.length, labels: { scope: "namespace" } });
  return { invalidated: rows.length };
}

// Housekeeping: expired rows are removed so the cache cannot grow without bound.
export async function purgeExpired(base44, { now = Date.now(), limit = 300 } = {}) {
  const svc = svcOf(base44);
  const rows = await svc.entities.CacheEntry.list("expires_at", limit).catch(() => []);
  let purged = 0;
  for (const r of rows) {
    if (new Date(r.expires_at).getTime() <= now) { memory.delete(r.cache_key); await svc.entities.CacheEntry.delete(r.id).catch(() => {}); purged++; }
  }
  return { purged, scanned: rows.length };
}