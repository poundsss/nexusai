// Benchmark run identity: ONE measurement per deterministic run key.
//   • startClaim — a durable single-use claim on (benchmark, run_key) taken BEFORE any scratch project,
//     AI run or agent run is created, so two concurrent starts cannot execute the same measurement
//     twice. A failed claim read is a retryable 503, never "unclaimed".
//   • a PENDING row is persisted before the side effect; a start that died between the side effect
//     and recording its run id is resolved as an unscored infrastructure failure after a staleness
//     bound — it is NEVER re-run (the original execution may have happened).
//   • canonicalResults — legacy duplicate rows for a run key are excluded from aggregation: the
//     oldest row is the measurement, later ones are duplicates.
// UNKNOWN: claim atomicity depends on production database read consistency (no unique constraint).
export const START_CLAIM_TTL_MS = 15 * 60 * 1000;
export const START_STALE_MS = 10 * 60 * 1000;

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const live = (rows, now) => rows.filter((r) => new Date(r.expires_at).getTime() > now);

async function readClaims(svc, cache_key) {
  try { return await svc.entities.CacheEntry.filter({ cache_key }, "created_date", 5); }
  catch { fail(503, "BENCHMARK_CLAIM_UNAVAILABLE", "The benchmark execution could not be verified; retry later."); }
}

export async function startClaim(svc, benchmarkId, runKey, now = Date.now()) {
  const cache_key = `bench_start:${benchmarkId}:${runKey}`;
  if (live(await readClaims(svc, cache_key), now).length) return false;
  const mine = await svc.entities.CacheEntry.create({
    namespace: "benchmark_start", cache_key, value: { claimed_at: new Date(now).toISOString() },
    expires_at: new Date(now + START_CLAIM_TTL_MS).toISOString(), stale_at: new Date(now + START_CLAIM_TTL_MS).toISOString(),
    size_bytes: 64, version: 1,
  });
  const all = live(await readClaims(svc, cache_key), now);
  return (all[0]?.id || mine.id) === mine.id;
}

const createdAt = (r) => Date.parse(r.created_date || r.started_at || "") || 0;

/** Oldest row per run key is the measurement; later rows are duplicates. */
export function canonicalResults(rows) {
  const byKey = new Map();
  const duplicates = [];
  for (const r of [...rows].sort((a, b) => createdAt(a) - createdAt(b) || String(a.id).localeCompare(String(b.id)))) {
    const first = byKey.get(r.run_key);
    if (first) duplicates.push({ row: r, canonical_id: first.id });
    else byKey.set(r.run_key, r);
  }
  return { canonical: [...byKey.values()], duplicates };
}

/** A PENDING row with no recorded execution older than the bound: its start outcome is unknown. */
export function isStartOrphan(row, now = Date.now()) {
  return row.status === "PENDING" && !row.run_id && !row.agent_run_id
    && now - (Date.parse(row.started_at || row.created_date || "") || now) > START_STALE_MS;
}