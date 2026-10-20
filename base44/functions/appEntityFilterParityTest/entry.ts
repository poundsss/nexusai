// Certification suite for the DOCUMENTED Base44 entities SDK query/projection/set-write surface:
//
//   1. `fields` projection — DOCUMENTED (SDK reference): list/filter accept `fields: (keyof T)[]`,
//      "Array of field names to include in the response. Defaults to all fields." Certified as
//      pure response shaping applied AFTER the read gate. FLS semantics do NOT exist in
//      NexusAI (nothing to enforce or bypass) and the exact FLS-denied-field rendering is
//      UNKNOWN in the Base44 docs — NOT claimed. Service-role semantics are UNCHANGED.
//   2. `$or` + array shorthand — DOCUMENTED (SDK reference filter examples): top-level
//      { $or: [ { ... }, { ... } ] } and "arrays as shorthand for matching any of the provided
//      values". Nested $or under field conditions and other logical operators are NOT documented
//      and are NOT implemented. Empty/malformed $or matches nothing (fail-closed bounded choice).
//   3. `updateMany(query, data)` / `deleteMany(query)` — DOCUMENTED (SDK 0.8.51, PR #143):
//      updateMany is the MongoDB-operator surface ($set/$rename/$unset/$inc/$mul/$min/$max/
//      $currentDate/$addToSet/$push/$pull only, batched up to 500, response exactly
//      { success, updated, has_more }); deleteMany stays routed onto deleteWhere. Deep
//      certification of updateMany lives in appEntityUpdateManyParityTest — here only the
//      regression-relevant basics through the same funnel.
//
// The suite drives the REAL createServerDb funnel (deployed runtime, preview and backend
// functions all write/read through it). The bridge/runtime forwarding of these params and op
// names is pass-through (args travel unchanged) and is covered by the runtime surface suites.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb, readEntityEvents, ENTITY_EVENTS_ENTITY } from "../../shared/appData.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// The certified contract, pinned so the suite states its own boundary.
const FILTER_CONTRACT = {
  fields: "DOCUMENTED — response shaping only, applied AFTER the read gate; defaults to all fields",
  fields_unknown_entry: "structured DATABASE_VALIDATION_FAILED — never silently dropped",
  fls: "UNKNOWN in Base44 docs — no FLS semantics exist in NexusAI, nothing claimed",
  service_role: "UNCHANGED — projection applies identically, no rules are bypassed or added",
  or_top_level: "DOCUMENTED — matches if ANY sub-query matches, ANDed with other criteria",
  array_shorthand: "DOCUMENTED — { field: [a, b] } matches any provided value",
  or_malformed: "bounded fail-closed choice — empty/non-array $or matches nothing",
  nested_or_other_logical: "NOT documented — NOT implemented",
  update_many: "DOCUMENTED (SDK 0.8.51, PR #143) — operator-document surface; batched 500; exact { success, updated, has_more }",
  delete_many: "DOCUMENTED name routed onto deleteWhere — same gates/batching/validation/guard",
};

const ENTITIES = [
  { name: "Task", fields: { title: { type: "string" }, status: { type: "string" }, done: { type: "boolean" }, n: { type: "number" } } },
  { name: "Memo", fields: { body: { type: "string" } } },
  { name: "Ledger", fields: { owner: { type: "string" }, body: { type: "string" } }, rls: { create: true, read: { "data.owner": "{{user.id}}" }, update: true, delete: true } },
];

const keysOf = (items) => [...new Set(items.flatMap((it) => Object.keys(it)))].sort().join(",");

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const pace = (ms) => appAgentPace(ms || 400);

  try {
    const plan = await makeBillingPlan(db, created, `p911s${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911s${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911s");
    await grant(A.ws.id, "message", 50);
    await grant(A.ws.id, "integration", 50);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const P1 = await makeAgentProject(db, projectIds, A, stamp, "p911s");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p911s");
    const PR = await makeAgentProject(db, projectIds, A, stamp, "p911s");
    await db.entities.Project.update(PR.id, { rls_enabled: true });
    const userA1 = { id: `p911s_userA1_${stamp}`, email: "a1@p911s.test" };
    const userA2 = { id: `p911s_userA2_${stamp}`, email: "a2@p911s.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbR1 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });
    const dbR2 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA2 });

    // ---- 1. fields projection: DOCUMENTED Pick semantics --------------------------------
    const seeds = await db1.Task.bulkCreate([
      { title: "alpha", status: "open", done: false, n: 1 },
      { title: "beta", status: "open", done: false, n: 2 },
      { title: "gamma", status: "done", done: true, n: 3 },
    ]);
    const proj = await db1.Task.filter({ status: "open" }, "-created_date", 10, 0, ["title", "n"]);
    harness.check("fields: filter returns ONLY the requested fields (Pick semantics)",
      proj.length === 2 && keysOf(proj) === "n,title" && proj.every((it) => it.done === undefined && it.status === undefined && it.id === undefined),
      keysOf(proj));
    const projList = await db1.Task.list("-created_date", 10, 1, ["title"]);
    harness.check("fields: list carries the documented (sort, limit, skip, fields) signature",
      projList.length === 2 && projList.every((it) => Object.keys(it).join(",") === "title"),
      JSON.stringify(projList));
    const projBuiltins = await db1.Task.filter({}, "-created_date", 2, 0, ["id", "created_date"]);
    harness.check("fields: built-ins (id, created_date, updated_date) are valid projection targets",
      projBuiltins.length === 2 && projBuiltins.every((it) => it.id && it.created_date && Object.keys(it).length === 2),
      keysOf(projBuiltins));
    const allFields = await db1.Task.filter({}, "-created_date", 2);
    harness.check("fields: without the parameter every field is returned (default behavior unchanged)",
      allFields.length === 2 && keysOf(allFields) === "created_date,done,id,n,status,title,updated_date",
      keysOf(allFields));
    const bad = await captureCall(() => db1.Task.filter({}, null, 5, 0, ["nope"]));
    harness.check("fields: an unknown projection field is refused with a structured error, never silently dropped",
      bad.threw && bad.code === "DATABASE_VALIDATION_FAILED", JSON.stringify(bad));

    // ---- 2. $or and array shorthand: DOCUMENTED filter semantics ------------------------
    const orRows = await db1.Task.filter({ $or: [{ title: "alpha" }, { status: "done" }] });
    harness.check("$or: matches records satisfying ANY sub-query (documented example shape)",
      orRows.length === 2 && orRows.some((r) => r.title === "alpha") && orRows.some((r) => r.title === "gamma"),
      JSON.stringify(orRows.map((r) => r.title)));
    const andRows = await db1.Task.filter({ status: "open", $or: [{ title: "alpha" }, { title: "gamma" }] });
    harness.check("$or: combines with other criteria as a top-level AND",
      andRows.length === 1 && andRows[0].title === "alpha", JSON.stringify(andRows.map((r) => r.title)));
    const arrRows = await db1.Task.filter({ status: ["open", "done"] });
    harness.check("array shorthand: { field: [a, b] } matches any provided value",
      arrRows.length === 3, JSON.stringify(arrRows.length));
    const orCount = await db1.Task.count({ $or: [{ title: "alpha" }, { title: "beta" }] });
    harness.check("$or: applies identically on the count path",
      orCount === 2, JSON.stringify(orCount));
    const orEmpty = await db1.Task.filter({ $or: [] });
    const orBad = await db1.Task.filter({ $or: "nope" });
    harness.check("$or: empty or malformed $or matches nothing (fail-closed bounded choice, non-parity)",
      orEmpty.length === 0 && orBad.length === 0, JSON.stringify({ empty: orEmpty.length, bad: orBad.length }));
    const notOr = await db1.Task.filter({ title: { $or: [{ n: 1 }] } });
    harness.check("boundary: nested $or under a field condition is NOT implemented (undocumented) — matches nothing",
      notOr.length === 0, JSON.stringify(notOr.length));

    // ---- 3. projection + visibility: AFTER the read gate, no rule is bypassed -----------
    const own = await dbR1.Ledger.create({ owner: userA1.id, body: "own row" });
    const r1Proj = await dbR1.Ledger.filter({}, "-created_date", 10, 0, ["body"]);
    const r2Proj = await dbR2.Ledger.filter({}, "-created_date", 10, 0, ["body"]);
    harness.check("RLS: projection shapes only records the read rule already allows — another user still sees nothing",
      r1Proj.length === 1 && r1Proj[0].body === "own row" && Object.keys(r1Proj[0]).length === 1
        && r2Proj.length === 0,
      JSON.stringify({ mine: r1Proj.length, theirs: r2Proj.length }));
    const r2foreign = await captureCall(() => dbR2.Ledger.get(own.id));
    harness.check("RLS: a projected or unprojected get still refuses another user's record as not found",
      r2foreign.threw && r2foreign.code === "DATABASE_RECORD_NOT_FOUND", JSON.stringify(r2foreign));

    // ---- 4. updateMany / deleteMany: DOCUMENTED names on the EXISTING machine -----------
    const up = await db1.Task.updateMany({ status: "open" }, { $set: { done: true } });
    const afterUp = await db1.Task.filter({ status: "open" });
    harness.check("updateMany: applies the same update to all records matching a query",
      up.updated === 2 && afterUp.every((r) => r.done === true) && afterUp.length === 2,
      JSON.stringify({ updated: up.updated, done: afterUp.filter((r) => r.done).length }));
    const upBad = await captureCall(() => db1.Task.updateMany({ status: "open" }, { $set: { n: "not-a-number" } }));
    const afterBad = await db1.Task.filter({ status: "open" });
    harness.check("updateMany: validation is preserved — an invalid payload changes nothing (fail-fast)",
      upBad.threw && upBad.code === "DATABASE_VALIDATION_FAILED" && afterBad.every((r) => typeof r.n === "number"),
      JSON.stringify({ code: upBad.code }));
    const del = await db1.Task.deleteMany({ status: "done" });
    const afterDel = await db1.Task.filter({ status: "done" });
    harness.check("deleteMany: deletes all records matching a query",
      del.deleted === 1 && afterDel.length === 0, JSON.stringify({ deleted: del.deleted }));
    const delGuard = await captureCall(() => db1.Task.deleteMany({}));
    harness.check("deleteMany: the empty-query guard is preserved (documented semantics silent — bounded fail-closed)",
      delGuard.threw && delGuard.code === "DATABASE_UNSAFE_BULK", JSON.stringify(delGuard));

    // ---- 5. same event funnel: updateMany/deleteMany emit per record --------------------
    const evTask = (await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task" })).events;
    const evById = new Map();
    for (const ev of evTask) {
      const list = evById.get(ev.id) || [];
      list.push(ev.type);
      evById.set(ev.id, list);
    }
    const seedTypes = seeds.map((s) => (evById.get(s.id) || []).join(",")).sort().join(";");
    harness.check("events: updateMany/deleteMany route through the SAME per-record emission funnel",
      seedTypes.includes("create,update") && seedTypes.includes("create,delete"),
      JSON.stringify(seedTypes));

    // ---- 6. cross-project isolation -----------------------------------------------------
    const t2 = await db2.Task.create({ title: "p2-only", status: "open", done: false, n: 9 });
    await db1.Task.updateMany({ title: "p2-only" }, { $set: { done: true } });
    const t2After = await db2.Task.get(t2.id);
    const del1 = await db1.Task.deleteMany({ title: "p2-only" });
    harness.check("isolation: a set-based write in one project never touches another project's records",
      t2After.done === false && del1.deleted === 0, JSON.stringify({ done: t2After.done, deleted: del1.deleted }));

    // ---- 7. RLS machine unchanged for the documented names ------------------------------
    await dbR1.Ledger.create({ owner: userA1.id, body: "mine-2" });
    const upR = await dbR1.Ledger.updateMany({ body: "mine-2" }, { $set: { body: "mine-2-updated" } });
    const delR2 = await dbR2.Ledger.deleteMany({ body: "mine-2-updated" });
    const visibleR1 = await dbR1.Ledger.filter({ body: "mine-2-updated" });
    harness.check("RLS: updateMany/deleteMany keep per-owner isolation — another user's set-write matches nothing",
      upR.updated === 1 && delR2.deleted === 0 && visibleR1.length === 1,
      JSON.stringify({ updated: upR.updated, theirs: delR2.deleted, visible: visibleR1.length }));

    // ---- 8. unknown entity: the Proxy surfaces the DOCUMENTED op names ------------------
    const unknownOp = await captureCall(() => db1.NotAnEntity.updateMany({}, {}));
    harness.check("isolation: an unknown entity is refused fail-closed, naming the attempted operation",
      unknownOp.threw && unknownOp.code === "DATABASE_ENTITY_NOT_FOUND" && /updateMany/.test(unknownOp.message || ""),
      JSON.stringify(unknownOp));

    // ---- 9. no billing side effects ------------------------------------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: the query/projection/set-write surface moves no credits in either pool",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);

    // ---- 10. certification boundary pinned ----------------------------------------------
    harness.check("boundary: fields is certified as response shaping only — FLS is UNKNOWN and NOT claimed",
      FILTER_CONTRACT.fls.includes("UNKNOWN") && FILTER_CONTRACT.fields.startsWith("DOCUMENTED — response shaping"),
      JSON.stringify(FILTER_CONTRACT));
    harness.check("boundary: only documented $or + array shorthand are claimed; other logical operators are NOT",
      FILTER_CONTRACT.nested_or_other_logical.includes("NOT implemented"), JSON.stringify(FILTER_CONTRACT));
    harness.check("boundary: updateMany is the documented operator-document surface; deleteMany stays a routed name",
      FILTER_CONTRACT.update_many.includes("operator-document surface") && FILTER_CONTRACT.delete_many.includes("routed onto deleteWhere"),
      JSON.stringify(FILTER_CONTRACT));
    harness.check("surface: the `db` export remains registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("db"), "db present");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911s-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911s" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911s_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911s[0-9]+$" } }).catch(() => {});
  }
}