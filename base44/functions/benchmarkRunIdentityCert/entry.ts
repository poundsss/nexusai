// In-memory certification of benchmark run identity: start claim, canonical rows, start orphans.
import { startClaim, canonicalResults, isStartOrphan, START_STALE_MS } from "../../shared/benchmarkRunIdentity.ts";

function store({ failRead = false } = {}) {
  const rows = [];
  let n = 0;
  const CacheEntry = {
    async filter(q) { if (failRead) throw new Error("read down"); return rows.filter((r) => r.cache_key === q.cache_key); },
    async create(d) { const r = { id: `c${++n}`, ...d }; rows.push(r); return r; },
  };
  return { svc: { entities: { CacheEntry } }, rows };
}

export default async function () {
  const results = [];
  const add = (name, ok, detail = null) => results.push({ name, ok: !!ok, detail: detail && JSON.stringify(detail).slice(0, 200) });

  const a = store();
  const first = await startClaim(a.svc, "b1", "k1");
  const second = await startClaim(a.svc, "b1", "k1");
  const other = await startClaim(a.svc, "b1", "k2");
  add("claim: first start wins, a second start of the same run key is refused", first === true && second === false, { first, second });
  add("claim: a different run key is independent", other === true);
  a.rows[0].expires_at = new Date(Date.now() - 1000).toISOString();
  add("claim: an expired claim neither blocks nor wins", (await startClaim(a.svc, "b1", "k1")) === true);
  const raced = await Promise.all([startClaim(a.svc, "b1", "k3"), startClaim(a.svc, "b1", "k3")]);
  add("claim: two racing starts execute exactly once", raced.filter(Boolean).length === 1, raced);
  let code = null; try { await startClaim(store({ failRead: true }).svc, "b1", "k1"); } catch (e) { code = e.code; }
  add("claim: a failed claim read is a retryable 503, never a win", code === "BENCHMARK_CLAIM_UNAVAILABLE", { code });

  const rows = [
    { id: "r2", run_key: "A", created_date: "2026-01-02T00:00:00Z", status: "RUNNING" },
    { id: "r1", run_key: "A", created_date: "2026-01-01T00:00:00Z", status: "COMPLETED" },
    { id: "r3", run_key: "B", created_date: "2026-01-03T00:00:00Z", status: "COMPLETED" },
  ];
  const { canonical, duplicates } = canonicalResults(rows);
  add("canonical: the oldest row per run key is the measurement", canonical.map((r) => r.id).sort().join() === "r1,r3", canonical.map((r) => r.id));
  add("canonical: later rows are duplicates pointing at the canonical row", duplicates.length === 1 && duplicates[0].row.id === "r2" && duplicates[0].canonical_id === "r1", duplicates);

  const now = Date.now();
  const old = new Date(now - START_STALE_MS - 1000).toISOString();
  add("orphan: a stale PENDING row without an execution is an unknown-outcome start", isStartOrphan({ status: "PENDING", started_at: old }, now));
  add("orphan: a fresh PENDING row is still starting", !isStartOrphan({ status: "PENDING", started_at: new Date(now).toISOString() }, now));
  add("orphan: a PENDING row WITH a run id is never an orphan", !isStartOrphan({ status: "PENDING", started_at: old, run_id: "x" }, now));
  add("orphan: a RUNNING row is never an orphan", !isStartOrphan({ status: "RUNNING", started_at: old }, now));

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: failed === 0, passed: results.length - failed, failed, results });
}