// R-5 regression for dataset.ts read handling. Part 1 (pure, in-memory): runValidation's stored-item
// read and lineage reads. Part 2 (scratch DB fixtures + fault-injecting proxy): every lifecycle
// path turns a failed read into a retryable 503 DATASET_READ_UNAVAILABLE, a genuine absence stays
// 404, and a build on incomplete reads ends FAILED with no checksum. No AI calls.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runValidation, datasetChecksum, createDataset, buildDataset, validateDataset, finalizeDataset, getLineage, loadCandidate, readFinalizedItems } from "../../shared/dataset.ts";
import { createDatasetEpisode, buildDatasetToFinal } from "../../shared/datasetTestFixtures.ts";
import { purgeBy } from "../../shared/testHarness.ts";

const ds = { id: "d1", dataset_type: "evaluation", source_policy_version: "pol_x", project_id: "p1", scope: "project", eligibility: {} };
const rows = [{ item_key: "eval:t1", item_checksum: "itm_a", trajectory_id: "t1", evaluation_id: "e1", project_id: "p1" }, { item_key: "eval:t2", item_checksum: "itm_b", trajectory_id: "t2", evaluation_id: "e2", project_id: "p1" }];
const err = (status) => Object.assign(new Error(`simulated ${status}`), { status });
const stub = (read, trajGet = async () => { throw err(404); }) => ({ entities: {
  DatasetItem: { filter: read },
  Trajectory: { get: trajGet }, Evaluation: { get: async () => null }, Reward: { get: async () => null },
} });
const check = (rep, name) => rep.checks.find((c) => c.name === name)?.ok;
const capture = async (fn) => { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, status: e.status, code: e.code, message: e.message }; } };

export default async function (req) {
  try { return await main(req); } catch (e) { return Response.json({ ok: false, error: e.message, stack: String(e.stack || "").slice(0, 600) }, { status: 500 }); }
}

async function main(req) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok: !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  const good = { ...ds, item_count: 2, checksum: datasetChecksum(ds, rows) };

  // --- Part 1: pure ---------------------------------------------------------------
  const r0 = await capture(() => runValidation(stub(async () => { throw err(429); }), good));
  add("1. item read error propagates", r0.status === 429, r0);
  const ok = await runValidation(stub(async () => rows), good);
  add("2. valid rows pass item_count + checksum", check(ok, "item_count") && check(ok, "checksum"), "");
  const short = await runValidation(stub(async () => rows.slice(0, 1)), good);
  add("3. count mismatch fails", check(short, "item_count") === false && check(short, "checksum") === false, short.failed.join(","));
  let reads = 0;
  const lagged = await runValidation(stub(async () => (++reads === 1 ? rows.slice(0, 1) : rows)), good);
  add("3b. a lagging read-after-write is re-read and then passes", check(lagged, "item_count") && check(lagged, "checksum") && reads === 2, `reads ${reads}`);
  const tampered = await runValidation(stub(async () => [rows[0], { ...rows[1], item_checksum: "itm_z" }]), good);
  add("4. checksum mismatch fails (count intact)", check(tampered, "item_count") && check(tampered, "checksum") === false, tampered.failed.join(","));
  const r5 = await capture(() => runValidation(stub(async () => rows, async () => { throw err(500); }), good));
  add("5. lineage read failure is 503, not 'broken lineage'", r5.status === 503 && r5.code === "DATASET_READ_UNAVAILABLE", r5);
  const absent = await runValidation(stub(async () => rows), good);
  add("6. genuinely absent trajectory (404) still reports broken lineage", check(absent, "lineage_integrity") === false, absent.failed.join(","));
  const r7 = await capture(() => loadCandidate({ entities: { Evaluation: { filter: async () => { throw err(500); } } } }, { id: "t1" }));
  add("7. candidate evaluation read failure is 503 (never silently excluded)", r7.status === 503 && r7.code === "DATASET_READ_UNAVAILABLE", r7);
  // Finalized-dataset consumers (candidate scoring, learning-cycle provenance check).
  const c1 = await capture(() => readFinalizedItems(stub(async () => { throw err(429); }), good));
  add("8. consumer read failure is 503 DATASET_READ_UNAVAILABLE", c1.status === 503 && c1.code === "DATASET_READ_UNAVAILABLE", c1);
  const c2 = await capture(() => readFinalizedItems(stub(async () => rows.slice(0, 1)), good));
  add("9. consumer still-short read is 503 DATASET_ITEMS_INCOMPLETE (never a smaller measurement)", c2.status === 503 && c2.code === "DATASET_ITEMS_INCOMPLETE", c2);
  let cr = 0;
  const c3 = await capture(() => readFinalizedItems(stub(async () => (++cr === 1 ? [] : rows)), good));
  add("10. consumer lagging read settles to the full item set", c3.ok && c3.v.length === 2 && cr === 2, { cr });

  // --- Part 2: lifecycle with fault injection --------------------------------------
  const base44 = createClientFromRequest(req);
  const raw = base44.asServiceRole.entities;
  const faults = {}; // "Entity.method" → status to throw
  const ents = new Proxy(raw, { get: (e, name) => new Proxy(e[name], { get: (t, m) => {
    const f = t[m];
    if (typeof f !== "function") return f;
    return async (...a) => { const s = faults[`${String(name)}.${String(m)}`]; if (s) throw err(s); return f.apply(t, a); };
  } }) });
  const client = { asServiceRole: { entities: ents }, entities: ents };
  const inject = async (key, fn, status = 500) => { faults[key] = status; try { return await capture(fn); } finally { delete faults[key]; } };
  const is503 = (r) => !r.ok && r.status === 503;
  let ws = null, proj = null;
  try {
    const user = await base44.auth.me();
    ws = await raw.Workspace.create({ name: "R5 Dataset Cert", owner_id: user.id, credits_balance: 0 });
    proj = await raw.Project.create({ workspace_id: ws.id, name: `r5-ds-${Date.now()}`, status: "ready", version_count: 1 });
    const scores = { correctness: 0.9, build: 1, runtime: 1, regression: 0.9 };
    const ep = await createDatasetEpisode({ entities: raw }, { project: proj, prompt: "R5 episode", scores, reward: 0.9 });
    const payload = { name: "r5 dataset", dataset_type: "evaluation", project_id: proj.id };

    const base = await buildDatasetToFinal(client, user, payload);
    add("8. normal create → build → validate → finalize unchanged", base.final?.finalized === true || base.final?.dataset?.status === "FINALIZED", base.final?.dataset?.status);

    const before = (await raw.Dataset.filter({ project_id: proj.id }, "created_date", 50)).length;
    const c = await inject("Dataset.filter", () => createDataset(client, user, payload));
    const after = (await raw.Dataset.filter({ project_id: proj.id }, "created_date", 50)).length;
    add("9. create: earlier-versions read failure → 503, nothing created", is503(c) && c.code === "DATASET_READ_UNAVAILABLE" && after === before, { c, before, after });

    const d2 = (await createDataset(client, user, payload)).dataset.dataset_id;
    const stateOf = async () => { const d = await raw.Dataset.get(d2); return { status: d.status, checksum: d.checksum || null, items: (await raw.DatasetItem.filter({ dataset_id: d2 }, "created_at", 50)).length }; };
    const failedClean = (s) => s.status === "FAILED" && s.checksum === null;

    const b1 = await inject("Trajectory.filter", () => buildDataset(client, user, { dataset_id: d2 }));
    const s1 = await stateOf();
    add("10. build: trajectory read failure → 503, FAILED, no checksum, no items", is503(b1) && b1.code === "DATASET_READ_UNAVAILABLE" && failedClean(s1) && s1.items === 0, { b1, s1 });

    const b2 = await inject("Evaluation.filter", () => buildDataset(client, user, { dataset_id: d2 }));
    const s2 = await stateOf();
    add("11. build: evaluation read failure → 503, FAILED, no checksum, no items", is503(b2) && failedClean(s2) && s2.items === 0, { b2, s2 });

    const b3ok = await capture(() => buildDataset(client, user, { dataset_id: d2 }));
    const b3 = await inject("DatasetItem.delete", () => buildDataset(client, user, { dataset_id: d2 }));
    const s3 = await stateOf();
    add("12. rebuild: failed cleanup delete → 503 DATASET_CLEANUP_FAILED, FAILED, no checksum", b3ok.ok && is503(b3) && b3.code === "DATASET_CLEANUP_FAILED" && failedClean(s3), { b3, s3 });

    const b4 = await capture(() => buildDataset(client, user, { dataset_id: d2 }));
    const s4 = await stateOf();
    add("13. rebuild after recovery succeeds with no accumulated rows", b4.ok && s4.status === "BUILT" && s4.items === b4.v.item_count, { s4, items: b4.v?.item_count });

    const v = await inject("Trajectory.get", () => validateDataset(client, user, { dataset_id: d2 }));
    add("14. validate: lineage read failure → 503 (not a validation failure)", is503(v) && v.code === "DATASET_READ_UNAVAILABLE", v);

    await validateDataset(client, user, { dataset_id: d2 });
    const f = await inject("Dataset.filter", () => finalizeDataset(client, user, { dataset_id: d2 }));
    const s5 = await stateOf();
    add("15. finalize: duplicate-check read failure → 503, not finalized", is503(f) && s5.status !== "FINALIZED" && s5.status !== "DUPLICATE", { f, s5 });

    const g1 = await inject("Dataset.get", () => validateDataset(client, user, { dataset_id: d2 }));
    const g2 = await capture(() => validateDataset(client, user, { dataset_id: "000000000000000000000000" }));
    add("16. load: read failure → 503; genuinely absent → 404", is503(g1) && g2.status === 404 && g2.code === "DATASET_NOT_FOUND", { g1, g2 });

    const item = (await raw.DatasetItem.filter({ dataset_id: base.dataset_id }, "created_at", 1))[0];
    const l1 = await inject("Trajectory.get", () => getLineage(client, user, { item_id: item.id }));
    const l2 = await capture(() => getLineage(client, user, { item_id: item.id }));
    add("17. lineage: read failure → 503; normal lineage complete", is503(l1) && l2.ok && l2.v.complete === true && l2.v.chain.trajectory?.trajectory_id === ep.traj.id, { l1, complete: l2.v?.complete });
  } catch (e) {
    add("fixture error", false, `${e.status || ""} ${e.message}`);
  } finally {
    if (proj) {
      for (const d of await raw.Dataset.filter({ project_id: proj.id }, "created_date", 100).catch(() => [])) {
        await purgeBy({ entities: raw }, "DatasetItem", { dataset_id: d.id });
        await raw.Dataset.delete(d.id).catch(() => {});
      }
      for (const n of ["Reward", "Evaluation", "Trajectory", "AIRun"]) await purgeBy({ entities: raw }, n, { project_id: proj.id });
      await raw.Project.delete(proj.id).catch(() => {});
    }
    if (ws) await raw.Workspace.delete(ws.id).catch(() => {});
  }
  const failed = results.filter((r) => !r.ok).length;
  return Response.json({ ok: !failed, passed: results.length - failed, failed, results });
}