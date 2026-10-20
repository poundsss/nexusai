// In-memory regression for base44/shared/certCleanup.ts. No database, no AI calls, no real waits.
import { cleanupAndVerify } from "../../shared/certCleanup.ts";

export const config = { method: "POST" };

function stubDb(seed, { readFail = null, deleteFail = null, verifyFail = false, transient429 = 0 } = {}) {
  const rows = { ...seed };
  let pending429 = transient429;
  const api = (name) => ({
    filter: async (q, _s, limit) => {
      if (pending429 > 0) { pending429--; throw Object.assign(new Error("Rate limit exceeded"), { status: 429 }); }
      if (readFail === name || (verifyFail && limit === 1)) throw Object.assign(new Error("Rate limit exceeded"), { status: 429 });
      return (rows[name] || []).filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)).slice(0, limit);
    },
    delete: async (id) => {
      if (deleteFail === id) throw new Error("delete refused");
      rows[name] = rows[name].filter((r) => r.id !== id);
    },
  });
  return { entities: new Proxy({}, { get: (_, n) => api(n) }), rows };
}
const fakeSleep = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms); } }; };
const many = (n, p) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, project_id: "p1" }));
const plan = [{ entity: "Evaluation", query: { project_id: "p1" } }, { entity: "Trajectory", query: { project_id: "p1" } }];

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail).slice(0, 300) });

  const okDb = stubDb({ Evaluation: many(250, "e"), Trajectory: many(3, "t") });
  const ok = await cleanupAndVerify(okDb, plan, fakeSleep());
  add("successful cleanup past one page (250 rows)", ok.ok && okDb.rows.Evaluation.length === 0, ok);

  const rf = await cleanupAndVerify(stubDb({ Evaluation: many(2, "e"), Trajectory: many(1, "t") }, { readFail: "Evaluation" }), plan, fakeSleep());
  add("persistent 429 read failure collected after retries, cleanup fails", !rf.ok && rf.errors.some((e) => e.op === "read" && e.entity === "Evaluation"), rf);

  const df = await cleanupAndVerify(stubDb({ Evaluation: many(2, "e"), Trajectory: many(1, "t") }, { deleteFail: "e0" }), plan, fakeSleep());
  add("delete failure collected and leftover detected", !df.ok && df.errors.some((e) => e.op === "delete" && e.id === "e0") && df.leftovers.some((l) => l.entity === "Evaluation"), df);

  const vf = await cleanupAndVerify(stubDb({ Evaluation: many(1, "e"), Trajectory: [] }, { verifyFail: true }), plan, fakeSleep());
  add("verification read failure fails the check", !vf.ok && vf.verifyErrors.length === 2, vf);

  const lo = stubDb({ Evaluation: many(1, "e"), Trajectory: [], Reward: [{ id: "r0", project_id: "p1" }] });
  const sneaky = { entities: new Proxy({}, { get: (_, n) => n === "Reward" ? { filter: lo.entities.Reward.filter, delete: async () => {} } : lo.entities[n] }) };
  const left = await cleanupAndVerify(sneaky, [...plan, { entity: "Reward", query: { project_id: "p1" } }], fakeSleep());
  add("silent non-delete is caught as leftover", !left.ok && left.leftovers.some((l) => l.entity === "Reward"), left);

  const t = fakeSleep();
  const trDb = stubDb({ Evaluation: many(2, "e"), Trajectory: many(1, "t") }, { transient429: 2 });
  const tr = await cleanupAndVerify(trDb, plan, t);
  const backoffs = t.waits.filter((w) => w >= 1000);
  add("transient 429 retried with 1s/2s backoff then succeeds", tr.ok && trDb.rows.Evaluation.length === 0 && JSON.stringify(backoffs) === "[1000,2000]", { tr, backoffs });

  const p = fakeSleep();
  await cleanupAndVerify(stubDb({ Evaluation: many(2, "e"), Trajectory: [] }), plan, p);
  // Evaluation: 1 short-page read + 2 deletes; Trajectory: 1 empty read; verify: 2 reads = 6 paced calls, no extra re-read.
  add("short page skips extra read; every call paced 150ms", p.waits.length === 6 && p.waits.every((w) => w === 150), p.waits);

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});