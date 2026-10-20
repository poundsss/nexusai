// In-memory regression for R-3: the agent tool-step claim (executeClaimed). No database, no paid calls.
import { executeClaimed } from "../../shared/appAgentRuntime.ts";
import { stopIfInProgress, toolFingerprint, TOOL_CLAIM_STALE_MS, OUTCOME_UNKNOWN_CODE } from "../../shared/agentToolClaim.ts";
import { claimLease } from "../../shared/agentInvokeIndex.ts";

export const config = { method: "POST" };

function stub({ failRead = 0, failUpdate = false } = {}) {
  const rows = [];
  let reads = 0, seq = 0;
  const CacheEntry = {
    filter: async (q) => {
      if (++reads === failRead) throw new Error("simulated read failure");
      return rows.filter((r) => r.cache_key === q.cache_key).sort((a, b) => a.created_date.localeCompare(b.created_date));
    },
    create: async (d) => { const r = { ...d, id: `c${++seq}`, created_date: new Date(Date.now() + seq).toISOString() }; rows.push(r); return r; },
    update: async (id, d) => { if (failUpdate) throw new Error("simulated save failure"); const r = rows.find((x) => x.id === id); Object.assign(r, d); return r; },
  };
  return { svc: { entities: { CacheEntry } }, rows };
}

const turn = { id: "turn-1" };
const outcome = async (p) => { try { return { v: await p }; } catch (e) { return { code: e?.code, status: e?.status }; } };
const counter = () => { const c = { n: 0 }; c.run = async () => { c.n++; return { ok: true, observation: "done" }; }; return c; };
const exec = (s, c) => executeClaimed(s.svc, { turn, step: 1, run: c.run });

Deno.serve(async () => {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: JSON.stringify(detail).slice(0, 240) });

  const s0 = stub(); const c0 = counter();
  const a = await outcome(exec(s0, c0)); const b = await outcome(exec(s0, c0));
  add("success then replay: runs once, replays the saved result", c0.n === 1 && a.v?.ok && b.v?.observation === "done", { a, b, n: c0.n });

  const s1 = stub({ failRead: 1 }); const c1 = counter();
  const r1 = await outcome(exec(s1, c1));
  add("first-read failure: 503, no claim, not executed", r1.status === 503 && r1.code === "AGENT_TOOL_CLAIM_UNAVAILABLE" && s1.rows.length === 0 && c1.n === 0, r1);

  const s2 = stub({ failRead: 2 }); const c2 = counter();
  const r2 = await outcome(exec(s2, c2));
  add("winner re-read failure: 503, not executed", r2.status === 503 && c2.n === 0, r2);

  const s3 = stub(); const c3 = counter();
  await s3.svc.entities.CacheEntry.create({ cache_key: "appagent_tools:turn-1:t1", value: { claimed: true }, expires_at: new Date(Date.now() + 60000).toISOString() });
  const r3 = await outcome(exec(s3, c3));
  add("duplicate without saved result: non-success in-progress, not executed",
    r3.v?.ok === false && r3.v?.in_progress === true && r3.v?.code === "TOOL_STEP_IN_PROGRESS" && r3.v?.error?.code === "TOOL_STEP_IN_PROGRESS" && c3.n === 0, r3);

  const s4 = stub({ failUpdate: true }); const c4 = counter();
  const r4 = await outcome(exec(s4, c4));
  const s4b = { svc: { entities: { CacheEntry: { ...s4.svc.entities.CacheEntry } } } };
  const r4b = await outcome(exec(s4b, c4));
  add("result-save failure: 503 surfaced, retry is in-progress and never re-runs",
    r4.status === 503 && r4.code === "AGENT_TOOL_RESULT_UNSAVED" && r4b.v?.ok === false && r4b.v?.in_progress === true && c4.n === 1, { r4, r4b, n: c4.n });

  const s5 = stub(); const c5 = counter();
  await s5.svc.entities.CacheEntry.create({ cache_key: "appagent_tools:turn-1:t1", value: { claimed: true, result: { ok: true, observation: "stale" } }, expires_at: new Date(Date.now() - 1000).toISOString() });
  const r5 = await outcome(exec(s5, c5));
  add("expired claim neither blocks nor wins: fresh execution", r5.v?.observation === "done" && c5.n === 1, r5);

  const s6 = stub(); const c6 = counter();
  const race = await Promise.all([outcome(exec(s6, c6)), outcome(exec(s6, c6))]);
  add("two concurrent attempts: executed exactly once", c6.n === 1, { race, n: c6.n });

  const s7 = stub(); let thrown = 0;
  const boom = async () => { thrown++; throw Object.assign(new Error("primitive blew up"), { code: "PRIMITIVE_CRASH" }); };
  const r7 = await outcome(executeClaimed(s7.svc, { turn, step: 1, run: boom }));
  const r7b = await outcome(executeClaimed(s7.svc, { turn, step: 1, run: boom }));
  add("thrown action: recorded as a failure result, claim not left result-less, never re-run",
    r7.v?.ok === false && r7.v?.code === "PRIMITIVE_CRASH" && r7.v?.error?.code === "PRIMITIVE_CRASH" && r7b.v?.code === "PRIMITIVE_CRASH" && !r7b.v?.in_progress && thrown === 1, { r7, r7b, thrown });

  // R-4 recovery: a crashed runner's result-less claim, once stale, resolves to a recorded
  // unknown outcome — never a re-run — and every later retry replays that same outcome.
  const s8 = stub(); const c8 = counter();
  await s8.svc.entities.CacheEntry.create({ cache_key: "appagent_tools:turn-1:t1", value: { claimed: true, claimed_at: new Date(Date.now() - TOOL_CLAIM_STALE_MS - 1000).toISOString() }, expires_at: new Date(Date.now() + 60000).toISOString() });
  const r8 = await outcome(exec(s8, c8)); const r8b = await outcome(exec(s8, c8));
  add("stale result-less claim (crash mid-tool): unknown outcome recorded, never executed, replayed",
    r8.v?.outcome_unknown === true && r8b.v?.outcome_unknown === true && !!s8.rows[0].value.result && c8.n === 0, { r8, n: c8.n });
  let stopped = null; try { stopIfInProgress(r8.v); } catch (e) { stopped = e.code; }
  add("unknown outcome ends the turn (AGENT_TOOL_OUTCOME_UNKNOWN)", stopped === OUTCOME_UNKNOWN_CODE, { stopped });

  const s9 = stub(); const c9 = counter();
  await s9.svc.entities.CacheEntry.create({ cache_key: "appagent_tools:turn-1:t1", value: { claimed: true, claimed_at: new Date().toISOString() }, expires_at: new Date(Date.now() + 60000).toISOString() });
  const r9 = await outcome(exec(s9, c9));
  add("fresh result-less claim stays in-progress (not converted early)", r9.v?.in_progress === true && !r9.v?.outcome_unknown && c9.n === 0, r9);

  const s10 = stub();
  await s10.svc.entities.CacheEntry.create({ cache_key: "k:lease", value: {}, expires_at: new Date(Date.now() + 60000).toISOString() });
  const held = await claimLease(s10.svc, "k");
  s10.rows[0].expires_at = new Date(Date.now() - 1000).toISOString(); // the crashed holder's lease lapses
  const after = await claimLease(s10.svc, "k");
  add("live crashed lease blocks; after expiry the lease is claimable", held.won === false && after.won === true, { held: held.won, after: after.won });

  // R-6: step fingerprints.
  const s11 = stub(); const c11a = counter(); const c11b = counter();
  const fA = toolFingerprint("entity_task_create", { title: "A" }), fB = toolFingerprint("entity_task_create", { title: "B" });
  await executeClaimed(s11.svc, { turn, step: 1, run: c11a.run, fingerprint: fA });
  const same = await executeClaimed(s11.svc, { turn, step: 1, run: c11a.run, fingerprint: fA });
  add("fingerprint: the SAME call at a used step replays its saved result (no re-run)", c11a.n === 1 && same.observation === "done", { n: c11a.n });
  const diff = await executeClaimed(s11.svc, { turn, step: 1, run: c11b.run, fingerprint: fB });
  add("fingerprint: a DIFFERENT call at a used step is not executed and not mis-attributed", c11b.n === 0 && diff.ok === false && diff.code === "TOOL_STEP_ALREADY_USED" && !diff.in_progress, diff);
  let mismatchStop = null; try { stopIfInProgress(diff); } catch (e) { mismatchStop = e.code; }
  add("fingerprint: the mismatch does not stop the turn (the call can run at the next step)", mismatchStop === null, { mismatchStop });
  const s12 = stub(); const c12 = counter();
  await s12.svc.entities.CacheEntry.create({ cache_key: "appagent_tools:turn-1:t1", value: { claimed: true, claimed_at: new Date().toISOString(), fingerprint: fA }, expires_at: new Date(Date.now() + 60000).toISOString() });
  const pend = await executeClaimed(s12.svc, { turn, step: 1, run: c12.run, fingerprint: fB });
  add("fingerprint: a different call against an UNFINISHED step stays in-progress (turn stops, nothing runs)", c12.n === 0 && pend.in_progress === true, pend);
  const s13 = stub(); const c13 = counter();
  await s13.svc.entities.CacheEntry.create({ cache_key: "appagent_tools:turn-1:t1", value: { claimed: true, result: { ok: true, observation: "legacy" } }, expires_at: new Date(Date.now() + 60000).toISOString() });
  const leg = await executeClaimed(s13.svc, { turn, step: 1, run: c13.run, fingerprint: fB });
  add("fingerprint: a legacy claim without a fingerprint keeps the certified replay", c13.n === 0 && leg.observation === "legacy", leg);

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});