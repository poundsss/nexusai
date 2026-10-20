// In-memory regression for dry-run check 5b's contract (base44/shared/dryRunEvalParity.ts).
// Uses the real fingerprint function; no database, no AI calls.
import { verifyDryEvalItems } from "../../shared/dryRunEvalParity.ts";
import { inputsHash } from "../../shared/evaluation.ts";

export const config = { method: "POST" };

const fp = (t) => inputsHash({ trajectory_id: t.id, trajectory_revision: t.revision });
const item = (tid, eid) => ({ item_key: `eval:${tid}`, evaluation_id: eid, lineage: { trajectory_id: tid, evaluation_id: eid } });

Deno.serve(async () => {
  const traj = { t1: { id: "t1", revision: 1 }, t2: { id: "t2", revision: 1 } };
  const evals = { e1: { id: "e1", trajectory_id: "t1", inputs_hash: fp(traj.t1) }, e2: { id: "e2", trajectory_id: "t2", inputs_hash: fp(traj.t2) } };
  const opts = (expectedKeys = ["eval:t1", "eval:t2"]) => ({ expectedCount: expectedKeys.length, expectedKeys, stored: async (id) => evals[id] || null, recompute: async (tid) => fp(traj[tid]) });
  const results = [];
  const add = (name, r, want) => results.push({ name, ok: r.ok === want, detail: r.problems.join("; ") || "ok" });

  add("reuse when revision unchanged", await verifyDryEvalItems([item("t1", "e1"), item("t2", "e2")], opts()), true);
  const stale = { ...traj, t1: { id: "t1", revision: 2 } };
  const bumped = { ...opts(), recompute: async (tid) => fp(stale[tid]) };
  add("revision bump: placeholder of recomputed fingerprint accepted", await verifyDryEvalItems([item("t1", `dryrun_eval_${fp(stale.t1)}`), item("t2", "e2")], bumped), true);
  add("revision bump: stale stored evaluation rejected", await verifyDryEvalItems([item("t1", "e1"), item("t2", "e2")], bumped), false);
  add("wrong placeholder rejected", await verifyDryEvalItems([item("t1", "dryrun_eval_x"), item("t2", "e2")], opts()), false);
  add("changed item (lineage mismatch) rejected", await verifyDryEvalItems([{ ...item("t1", "e1"), lineage: { trajectory_id: "t1", evaluation_id: "e2" } }, item("t2", "e2")], opts()), false);
  add("missing item rejected", await verifyDryEvalItems([item("t1", "e1")], opts()), false);
  add("unexpected item rejected", await verifyDryEvalItems([item("t1", "e1"), item("t2", "e2")], opts(["eval:t1"])), false);

  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
});