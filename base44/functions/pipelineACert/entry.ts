// In-memory regression for Pipeline A: bulk partial-write semantics and recoverable tool-result
// saves. No database, no paid calls.
import { persistEach } from "../../shared/appBulkPersist.ts";
import { executeClaimed, RESULT_SAVE_ATTEMPTS } from "../../shared/agentToolClaim.ts";

export const config = { method: "POST" };

function toolStub(failUpdates) {
  const rows = []; let seq = 0, fails = failUpdates;
  const CacheEntry = {
    filter: async (q) => rows.filter((r) => r.cache_key === q.cache_key),
    create: async (d) => { const r = { ...d, id: `c${++seq}`, created_date: new Date().toISOString() }; rows.push(r); return r; },
    update: async (id, d) => { if (fails-- > 0) throw new Error("simulated save failure"); Object.assign(rows.find((x) => x.id === id), d); },
  };
  return { svc: { entities: { CacheEntry } }, rows };
}
const outcome = async (p) => { try { return { v: await p }; } catch (e) { return { e }; } };

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail ?? "").slice(0, 240) });

  // 1. Bulk persist: success, and an explicit partial failure.
  const all = await persistEach("Task", "bulkCreate", [1, 2, 3], async (n) => ({ id: `r${n}` }));
  add("all writes succeed → every record returned in order", all.map((a) => a.id).join() === "r1,r2,r3", all);
  const written = [];
  const p = await outcome(persistEach("Task", "bulkCreate", [1, 2, 3, 4], async (n) => {
    if (n === 3) throw Object.assign(new Error("storage down"), { code: "X" });
    written.push(n); return { id: `r${n}` };
  }));
  const d = p.e?.details || {};
  add("partial failure → DATABASE_BULK_PARTIAL, status 500", p.e?.code === "DATABASE_BULK_PARTIAL" && p.e?.status === 500, p.e?.code);
  add("partial failure reports exactly which records were written", d.failed_index === 2 && d.written_count === 2 && d.not_written_count === 2 && d.written_ids.join() === "r1,r2" && d.cause_code === "X", d);
  add("partial failure stops: nothing after the failed record is written", written.join() === "1,2", written);
  add("message states no rollback happened", /not rolled back/.test(p.e?.message || ""), p.e?.message);
  const f0 = await outcome(persistEach("Task", "bulkDelete", [1], async () => { throw new Error("x"); }));
  add("first-record failure reports zero written", f0.e?.details?.written_count === 0, f0.e?.details);

  // 2. Tool result save: transient failures recover without re-running the action.
  const turn = { id: "t1" };
  let runs = 0; const run = async () => { runs++; return { ok: true, observation: "done" }; };
  const t1 = toolStub(RESULT_SAVE_ATTEMPTS - 1);
  const r1 = await outcome(executeClaimed(t1.svc, { turn, step: 1, run }));
  add("transient save failures recover: result returned and saved", r1.v?.ok === true && t1.rows[0]?.value?.result?.ok === true, r1);
  add("recovered save keeps the original claimed_at", !!t1.rows[0]?.value?.claimed_at, t1.rows[0]?.value);
  add("action ran exactly once", runs === 1, runs);
  const replay = await executeClaimed(t1.svc, { turn, step: 1, run });
  add("a retry replays the saved result without re-running", replay.ok === true && runs === 1, runs);
  runs = 0;
  const t2 = toolStub(RESULT_SAVE_ATTEMPTS);
  const r2 = await outcome(executeClaimed(t2.svc, { turn, step: 1, run }));
  add("persistent save failure → 503 AGENT_TOOL_RESULT_UNSAVED", r2.e?.code === "AGENT_TOOL_RESULT_UNSAVED" && r2.e?.status === 503, r2.e?.code);
  const r2b = await executeClaimed(t2.svc, { turn, step: 1, run });
  add("after an unsaved result, a retry is in-progress and never re-runs", r2b.in_progress === true && runs === 1, { r2b, runs });

  // 3. Pipeline B: compensation of already-applied records.
  const undone = [];
  const fail3 = async (n) => { if (n === 3) throw new Error("storage down"); return { id: `r${n}` }; };
  const rb = await outcome(persistEach("Task", "bulkCreate", [1, 2, 3], fail3, async (_p, item) => { undone.push(item.id); return true; }));
  add("full compensation → DATABASE_BULK_ROLLED_BACK, nothing remains", rb.e?.code === "DATABASE_BULK_ROLLED_BACK" && rb.e?.details?.written_count === 0 && rb.e?.details?.rollback === "complete", rb.e?.details);
  add("compensation runs in reverse order", undone.join() === "r2,r1", undone);
  const pr = await outcome(persistEach("Task", "bulkUpdate", [1, 2, 3], fail3, async (_p, item) => item.id !== "r1"));
  add("concurrent-change skip → DATABASE_BULK_PARTIAL lists what remains", pr.e?.code === "DATABASE_BULK_PARTIAL" && pr.e?.details?.rollback === "incomplete" && pr.e?.details?.written_ids.join() === "r1" && pr.e?.details?.rolled_back_ids.join() === "r2", pr.e?.details);
  const th = await outcome(persistEach("Task", "bulkUpdate", [1, 2, 3], fail3, async () => { throw new Error("undo down"); }));
  add("a throwing undo never masks the report", th.e?.code === "DATABASE_BULK_PARTIAL" && th.e?.details?.written_count === 2, th.e?.details);

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});