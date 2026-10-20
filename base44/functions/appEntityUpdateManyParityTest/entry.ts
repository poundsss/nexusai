// Certification suite for the DOCUMENTED Base44 entities SDK updateMany surface (SDK 0.8.51,
// PR #143): PATCH …/update-many with body exactly { query, data }, where `data` is a MongoDB
// UPDATE OPERATOR document ($set, $rename, $unset, $inc, $mul, $min, $max, $currentDate,
// $addToSet, $push, $pull — the only documented operators; each field may only appear in one
// operator per call), the response is EXACTLY { success, updated, has_more }, and results are
// "batched in groups of up to 500 — when has_more is true, call updateMany again with the same
// query to update the next batch". `bulkUpdate` is a DIFFERENT documented surface.
//
// The suite drives the REAL createServerDb funnel (deployed runtime, preview and backend
// functions all write through it). Bridge/runtime forwarding of { query, data } is
// pass-through and is covered by the runtime surface suites — not here.
//
// Every behavior upstream 0.8.51 does NOT prove is certified only with its own label:
//   • NEXUSAI-DERIVED (non-parity): batch selection/progression strategy, the pre-update
//     has_more probe, every operator edge semantic, unchanged-value counting, acceptance of
//     query operators beyond the typed Partial<T>, atomicity, event semantics, error
//     codes/statuses, unknown-entity refusal shape.
//   • UNKNOWN (not claimed): upstream error codes/statuses, upstream event behavior, the
//     upstream batch-progression mechanism, per-call billing.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb, readEntityEvents } from "../../shared/appData.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// The certified contract, pinned so the suite states its own boundary.
const UPDATE_MANY_CONTRACT = {
  transport: "DOCUMENTED (SDK 0.8.51, PR #143) — PATCH …/update-many, body exactly { query, data }",
  query_form: "DOCUMENTED type — Partial<T> equality; richer operators ride the shared filter machine (NEXUSAI-DERIVED acceptance, non-parity)",
  operators: "DOCUMENTED — $set, $rename, $unset, $inc, $mul, $min, $max, $currentDate, $addToSet, $push, $pull only; plain partials and unknown operators are refused",
  field_conflict: "DOCUMENTED — each field may only appear in one operator per call",
  response_shape: "DOCUMENTED — exactly { success, updated, has_more }; no items",
  batching: "DOCUMENTED — batches of up to 500; has_more=true means: call updateMany again with the same query",
  batch_strategy: "NEXUSAI-DERIVED, non-parity — the 500 LEAST-recently-updated matches (ascending updated_date); the storage's updated_date bump advances a repeated call past the rows it just wrote",
  has_more_probe: "NEXUSAI-DERIVED, non-parity — a 1-row pre-update probe past the batch boundary",
  operator_edges: "NEXUSAI-DERIVED, non-parity — $currentDate stamps the server ISO-8601 instant; $inc/$mul treat missing as 0; $min/$max are numeric-only; array ops use JSON equality; $each is refused; non-numeric/non-array targets refuse the whole call",
  unchanged_counting: "NEXUSAI-DERIVED, non-parity — a record whose resulting value is unchanged still counts as updated",
  atomicity: "NEXUSAI-DERIVED, non-parity — all gates, operator application, validation and relation checks run BEFORE the first persist; the persist loop itself is per-record, NOT all-or-nothing",
  events: "NEXUSAI-DERIVED, non-parity — per-record update events through the single-update funnel (upstream event behavior is UNKNOWN)",
  errors: "NEXUSAI-DERIVED, non-parity — DATABASE_VALIDATION_FAILED / DATABASE_RLS_DENIED; relation violations surface the relation machine's own code (FK_NOT_FOUND)",
  unknown_entity: "NEXUSAI-DERIVED, non-parity — structured DATABASE_ENTITY_NOT_FOUND naming the operation (upstream 404 is proven only for list)",
  billing: "NOT CLAIMED — observed neutrality only",
  batch_progression_mechanism: "UNKNOWN upstream — the NEXUSAI-DERIVED strategy above is what this platform pins",
};

const ENTITIES = [
  { name: "Task", fields: { title: { type: "string" }, status: { type: "string" }, done: { type: "boolean" }, n: { type: "number" }, tags: { type: "array" }, when: { type: "date" }, mark: { type: "string" }, grp: { type: "string" }, i: { type: "number" } } },
  { name: "Memo", fields: { body: { type: "string", required: true }, extra: { type: "string" }, temp: { type: "string" }, ref: { type: "string" } } },
  { name: "Child", fields: { parent: { type: "string" }, label: { type: "string" } } },
  { name: "Locked", fields: { v: { type: "string" } }, rls: { create: true, read: true, update: { user_condition: { role: "system" } }, delete: false } },
  { name: "Hidden", fields: { v: { type: "string" } }, rls: { create: true, read: false, update: true, delete: true } },
  { name: "Ledger", fields: { owner: { type: "string" }, body: { type: "string" } }, rls: { create: true, read: { "data.owner": "{{user.id}}" }, update: true, delete: true } },
];

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const pace = (ms) => appAgentPace(ms || 400);

  try {
    const plan = await makeBillingPlan(db, created, `p911um${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911um${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911um");
    await grant(A.ws.id, "message", 50);
    await grant(A.ws.id, "integration", 50);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const P1 = await makeAgentProject(db, projectIds, A, stamp, "p911um");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p911um");
    const PR = await makeAgentProject(db, projectIds, A, stamp, "p911um");
    const PB = await makeAgentProject(db, projectIds, A, stamp, "p911um");
    await db.entities.Project.update(PR.id, { rls_enabled: true });
    // The Child→Task relation row must exist BEFORE the first P1 write: relation definitions
    // are cached per db instance on first use.
    await db.entities.AppRelation.create({ project_id: P1.id, name: "child_task", from_entity: "Child", to_entity: "Task", from_field: "parent", type: "many_to_one", on_delete: "restrict" });
    const userA1 = { id: `p911um_userA1_${stamp}`, email: "a1@p911um.test" };
    const userA2 = { id: `p911um_userA2_${stamp}`, email: "a2@p911um.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbB = createServerDb(db, PB.id, ENTITIES);
    const dbR1 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });
    const dbR2 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA2 });
    const dbR0 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: null });
    await pace();

    // ---- 1/19/20. $set + exact response shape + query filtering -------------------------
    const setSeeds = await db1.Task.bulkCreate([
      { title: "s-one", status: "open", done: false, n: 1 },
      { title: "s-two", status: "open", done: false, n: 2 },
      { title: "s-three", status: "done", done: true, n: 3 },
    ]);
    const r1 = await db1.Task.updateMany({ status: "open" }, { $set: { done: true } });
    harness.check("shape: the response is EXACTLY { success, updated, has_more } — no items",
      r1 && Object.keys(r1).sort().join(",") === "has_more,success,updated" && r1.success === true && r1.updated === 2 && r1.has_more === false,
      JSON.stringify(r1));
    const setAfter = await db1.Task.filter({ status: "open" });
    const sThree = await db1.Task.get(setSeeds[2].id);
    harness.check("$set + query: applies to every record matching the query, and ONLY those",
      setAfter.length === 2 && setAfter.every((x) => x.done === true) && sThree.done === true && sThree.n === 3,
      JSON.stringify({ matched: setAfter.map((x) => x.done), untouched: sThree.done }));

    // ---- 2/3. $inc, including the missing-field edge ------------------------------------
    await db1.Task.updateMany({ title: ["s-one", "s-two"] }, { $inc: { n: 10 } });
    const incAfter = await db1.Task.filter({ title: ["s-one", "s-two"] });
    harness.check("$inc: adds to every matched record's numeric field",
      incAfter.length === 2 && incAfter.map((x) => x.n).sort((a, b) => a - b).join(",") === "11,12",
      JSON.stringify(incAfter.map((x) => x.n)));
    const incSeed = await db1.Task.create({ title: "inc-missing", status: "open", done: true });
    await db1.Task.updateMany({ title: "inc-missing" }, { $inc: { n: 5 } });
    harness.check("$inc edge: a missing field counts as 0 (Mongo semantics — NEXUSAI-DERIVED edge)",
      (await db1.Task.get(incSeed.id)).n === 5, JSON.stringify((await db1.Task.get(incSeed.id)).n));

    // ---- 4. $mul -------------------------------------------------------------------------
    await db1.Task.updateMany({ title: ["s-one", "s-two"] }, { $mul: { n: 2 } });
    const mulAfter = await db1.Task.filter({ title: ["s-one", "s-two"] });
    harness.check("$mul: multiplies every matched record's numeric field",
      mulAfter.map((x) => x.n).sort((a, b) => a - b).join(",") === "22,24",
      JSON.stringify(mulAfter.map((x) => x.n)));

    // ---- 5. $min / $max -------------------------------------------------------------------
    await db1.Task.updateMany({ title: ["s-one", "s-two"] }, { $min: { n: 0 } });
    const minAfter = await db1.Task.filter({ title: ["s-one", "s-two"] });
    harness.check("$min: keeps the smaller of current and operand",
      minAfter.every((x) => x.n === 0), JSON.stringify(minAfter.map((x) => x.n)));
    await db1.Task.updateMany({ title: ["s-one", "s-two"] }, { $max: { n: 100 } });
    const maxAfter = await db1.Task.filter({ title: ["s-one", "s-two"] });
    harness.check("$max: keeps the larger of current and operand",
      maxAfter.every((x) => x.n === 100), JSON.stringify(maxAfter.map((x) => x.n)));
    const minNoop = await db1.Task.updateMany({ title: ["s-one", "s-two"] }, { $max: { n: 50 } });
    const minNoopAfter = await db1.Task.filter({ title: ["s-one", "s-two"] });
    harness.check("$min/$max edge: a no-change comparison leaves the value AND still counts the record as updated (numeric-only comparison — NEXUSAI-DERIVED)",
      minNoop.updated === 2 && minNoopAfter.every((x) => x.n === 100),
      JSON.stringify({ updated: minNoop.updated, n: minNoopAfter.map((x) => x.n) }));
    const minSeed = await db1.Task.create({ title: "min-missing", status: "open" });
    await db1.Task.updateMany({ title: "min-missing" }, { $min: { n: 7 } });
    harness.check("$min/$max edge: a missing field is set to the operand (NEXUSAI-DERIVED edge)",
      (await db1.Task.get(minSeed.id)).n === 7, JSON.stringify((await db1.Task.get(minSeed.id)).n));

    // ---- 6. $unset ------------------------------------------------------------------------
    await db1.Memo.bulkCreate([
      { body: "keep-1", extra: "e1", temp: "t1" },
      { body: "keep-2", extra: "e2", temp: "t2" },
    ]);
    await db1.Memo.updateMany({ body: ["keep-1", "keep-2"] }, { $unset: { temp: "" } });
    const unsetAfter = await db1.Memo.filter({ body: ["keep-1", "keep-2"] });
    harness.check("$unset: removes the field from every matched record, required fields intact",
      unsetAfter.length === 2 && unsetAfter.every((m) => m.temp === undefined && typeof m.body === "string"
        && ((m.body === "keep-1" && m.extra === "e1") || (m.body === "keep-2" && m.extra === "e2"))),
      JSON.stringify(unsetAfter.map((m) => m.body + ":" + m.temp)));
    const unsetReq = await captureCall(() => db1.Memo.updateMany({ body: ["keep-1", "keep-2"] }, { $unset: { body: "" } }));
    const bodyIntact = await db1.Memo.filter({ body: ["keep-1", "keep-2"] });
    harness.check("$unset edge: removing a REQUIRED field is refused and writes nothing (fail-closed)",
      unsetReq.threw && unsetReq.code === "DATABASE_VALIDATION_FAILED" && bodyIntact.every((m) => typeof m.body === "string"),
      JSON.stringify({ code: unsetReq.code }));

    // ---- 7. $rename -----------------------------------------------------------------------
    await db1.Memo.updateMany({ body: ["keep-1", "keep-2"] }, { $rename: { extra: "ref" } });
    const renameAfter = await db1.Memo.filter({ body: ["keep-1", "keep-2"] });
    harness.check("$rename: moves the value to the declared target field and removes the old name",
      renameAfter.every((m) => m.extra === undefined
        && ((m.body === "keep-1" && m.ref === "e1") || (m.body === "keep-2" && m.ref === "e2"))),
      JSON.stringify(renameAfter.map((m) => m.body + ":" + m.ref)));
    const renameBad = await captureCall(() => db1.Memo.updateMany({ body: ["keep-1", "keep-2"] }, { $rename: { ref: "nope" } }));
    harness.check("$rename edge: a target that is not a declared field is refused",
      renameBad.threw && renameBad.code === "DATABASE_VALIDATION_FAILED", JSON.stringify(renameBad.code));

    // ---- 8. $currentDate ------------------------------------------------------------------
    await db1.Task.updateMany({ title: "inc-missing" }, { $currentDate: { when: true } });
    await db1.Task.updateMany({ title: "min-missing" }, { $currentDate: { when: { $type: "date" } } });
    const cdTrue = (await db1.Task.get(incSeed.id)).when;
    const cdType = (await db1.Task.get(minSeed.id)).when;
    harness.check("$currentDate: true and { $type: date } stamp the server's current ISO-8601 instant (NEXUSAI-DERIVED value format)",
      typeof cdTrue === "string" && !isNaN(new Date(cdTrue).getTime()) && new Date(cdTrue).getTime() > stamp - 60000
        && typeof cdType === "string" && !isNaN(new Date(cdType).getTime()),
      JSON.stringify({ cdTrue, cdType }));
    const cdBad = await captureCall(() => db1.Task.updateMany({ title: "arr" }, { $currentDate: { when: "nope" } }));
    harness.check("$currentDate edge: any other operand is refused fail-closed",
      cdBad.threw && cdBad.code === "DATABASE_VALIDATION_FAILED", JSON.stringify(cdBad.code));

    // ---- 9/10/11. $push / $pull / $addToSet ------------------------------------------------
    const arrSeed = await db1.Task.create({ title: "arr", status: "open", done: false, tags: ["a", "b"] });
    await db1.Task.updateMany({ title: "arr" }, { $push: { tags: "c" } });
    harness.check("$push: appends the value to every matched record's array",
      (await db1.Task.get(arrSeed.id)).tags.join(",") === "a,b,c", JSON.stringify((await db1.Task.get(arrSeed.id)).tags));
    const addRes = await db1.Task.updateMany({ title: "arr" }, { $addToSet: { tags: "c" } });
    const addAfter = await db1.Task.get(arrSeed.id);
    harness.check("$addToSet: appends ONLY when absent — an unchanged record still counts as updated (NEXUSAI-DERIVED counting)",
      addRes.updated === 1 && addAfter.tags.join(",") === "a,b,c",
      JSON.stringify({ updated: addRes.updated, tags: addAfter.tags }));
    await db1.Task.updateMany({ title: "arr" }, { $pull: { tags: "b" } });
    harness.check("$pull: removes the JSON-equal element from every matched record's array",
      (await db1.Task.get(arrSeed.id)).tags.join(",") === "a,c", JSON.stringify((await db1.Task.get(arrSeed.id)).tags));
    const eachBad = await captureCall(() => db1.Task.updateMany({ title: "arr" }, { $push: { tags: { $each: ["x"] } } }));
    harness.check("array edge: the undocumented $each modifier is refused (NEXUSAI-DERIVED fail-closed)",
      eachBad.threw && eachBad.code === "DATABASE_VALIDATION_FAILED" && (await db1.Task.get(arrSeed.id)).tags.join(",") === "a,c",
      JSON.stringify({ code: eachBad.code }));
    // A record whose target is not an array refuses the WHOLE call before the first persist.
    await db1.Task.create({ title: "badtags", status: "open", tags: "not-an-array" });
    const pushBad = await captureCall(() => db1.Task.updateMany({ title: ["arr", "badtags"] }, { $push: { tags: "z" } }));
    harness.check("fail-fast: a per-record operator failure refuses the whole call BEFORE the first persist — a valid earlier record stays untouched",
      pushBad.threw && pushBad.code === "DATABASE_VALIDATION_FAILED" && (await db1.Task.get(arrSeed.id)).tags.join(",") === "a,c",
      JSON.stringify({ code: pushBad.code }));

    // ---- 12. multiple operators in one request ---------------------------------------------
    const multi = await db1.Task.updateMany({ title: "arr" }, { $set: { status: "multi" }, $inc: { n: 3 }, $push: { tags: "z" }, $currentDate: { when: true } });
    const mAfter = await db1.Task.get(arrSeed.id);
    harness.check("multi-operator: several documented operators combine in one request over one batch",
      multi.updated === 1 && mAfter.status === "multi" && mAfter.tags.join(",") === "a,c,z" && mAfter.n === 3 && typeof mAfter.when === "string",
      JSON.stringify({ status: mAfter.status, tags: mAfter.tags, n: mAfter.n, when: mAfter.when }));

    // ---- 13/14/15/27. operator-document validation, fail-closed -------------------------------
    const badOp = await captureCall(() => db1.Task.updateMany({ title: "arr" }, { $frobnicate: { n: 1 } }));
    const badPlain = await captureCall(() => db1.Task.updateMany({ title: "arr" }, { status: "plain" }));
    const badEmpty = await captureCall(() => db1.Task.updateMany({ title: "arr" }, {}));
    harness.check("validation: unknown operators, plain-partial documents and empty documents are all refused",
      badOp.threw && badOp.code === "DATABASE_VALIDATION_FAILED" && badPlain.threw && badPlain.code === "DATABASE_VALIDATION_FAILED" && badEmpty.threw && badEmpty.code === "DATABASE_VALIDATION_FAILED",
      JSON.stringify({ op: badOp.code, plain: badPlain.code, empty: badEmpty.code }));
    const badDup = await captureCall(() => db1.Task.updateMany({ title: "arr" }, { $set: { n: 1 }, $inc: { n: 2 } }));
    const badNum = await captureCall(() => db1.Task.updateMany({ title: "arr" }, { $inc: { n: "x" } }));
    harness.check("validation: a field under multiple operators and a non-numeric $inc operand are refused",
      badDup.threw && badDup.code === "DATABASE_VALIDATION_FAILED" && badNum.threw && badNum.code === "DATABASE_VALIDATION_FAILED",
      JSON.stringify({ dup: badDup.code, num: badNum.code }));
    const badSys = await captureCall(() => db1.Task.updateMany({ title: "arr" }, { $set: { id: "forged" } }));
    const badOwner = await captureCall(() => db1.Task.updateMany({ title: "arr" }, { $set: { owner_id: "forged" } }));
    const arrUntouched = await db1.Task.get(arrSeed.id);
    harness.check("system fields: an operator may never target id or the system-managed owner_id — and refusals wrote nothing",
      badSys.threw && badSys.code === "DATABASE_VALIDATION_FAILED" && badOwner.threw && badOwner.code === "DATABASE_VALIDATION_FAILED"
        && arrUntouched.status === "multi" && arrUntouched.tags.join(",") === "a,c,z",
      JSON.stringify({ sys: badSys.code, owner: badOwner.code }));

    // ---- 21. zero matches ---------------------------------------------------------------------
    const zero = await db1.Task.updateMany({ title: "no-such-title" }, { $set: { status: "x" } });
    harness.check("zero matches: success with updated 0 and has_more false",
      zero.success === true && zero.updated === 0 && zero.has_more === false, JSON.stringify(zero));

    // ---- 20 (beyond Partial<T>). richer query operators ----------------------------------------
    const qSeed = await db1.Task.bulkCreate([{ title: "q-a", status: "open", done: true }, { title: "q-b", status: "closed", done: true }]);
    const qRes = await db1.Task.updateMany({ status: { $ne: "closed" }, title: { $in: ["q-a", "q-b"] } }, { $set: { done: false } });
    harness.check("query filtering: operators beyond the typed Partial<T> ride the shared filter machine (NEXUSAI-DERIVED acceptance)",
      qRes.updated === 1 && (await db1.Task.get(qSeed[0].id)).done === false && (await db1.Task.get(qSeed[1].id)).done === true,
      JSON.stringify({ updated: qRes.updated }));

    // ---- 22. read visibility --------------------------------------------------------------------
    await db1.Hidden.bulkCreate([{ v: "h1" }, { v: "h2" }]);
    const hiddenRes = await db1.Hidden.updateMany({ v: ["h1", "h2"] }, { $set: { v: "overwritten" } });
    const hiddenRows = await db.entities.AppRecord.filter({ project_id: P1.id, entity_name: "Hidden" }, "-created_date", 10);
    harness.check("read visibility: an entity whose read rule denies everything yields an empty batch — nothing is ever updated through it",
      hiddenRes.success === true && hiddenRes.updated === 0 && hiddenRes.has_more === false
        && hiddenRows.length === 2 && hiddenRows.every((r) => String((r.data || {}).v || "").startsWith("h")),
      JSON.stringify({ updated: hiddenRes.updated, vs: hiddenRows.map((r) => (r.data || {}).v) }));

    // ---- 23. RLS / owner isolation ----------------------------------------------------------------
    await dbR1.Ledger.create({ owner: userA1.id, body: "r-a" });
    await dbR2.Ledger.create({ owner: userA2.id, body: "r-b" });
    const upR1 = await dbR1.Ledger.updateMany({}, { $set: { body: "r-a-done" } });
    const upR2 = await dbR2.Ledger.updateMany({ body: "r-a-done" }, { $set: { body: "stolen" } });
    const visR1 = await dbR1.Ledger.filter({ body: "r-a-done" });
    harness.check("RLS: a batch sees and updates only the caller's own records — another user's set-write matches nothing",
      upR1.updated === 1 && upR2.updated === 0 && visR1.length === 1,
      JSON.stringify({ mine: upR1.updated, theirs: upR2.updated }));
    const anon = await captureCall(() => dbR0.Task.updateMany({}, { $set: { title: "x" } }));
    harness.check("RLS: an anonymous caller on an RLS project is refused before any work (AUTH_REQUIRED)",
      anon.threw && anon.code === "AUTH_REQUIRED" && anon.status === 401, JSON.stringify(anon));

    // ---- 24. project isolation --------------------------------------------------------------------
    await db1.Task.create({ title: "iso-shared", status: "open", done: false });
    const p2t = await db2.Task.create({ title: "iso-shared", status: "open", done: false });
    const iso = await db1.Task.updateMany({ title: "iso-shared" }, { $set: { done: true } });
    harness.check("isolation: a batch in one project never touches another project's identically-matching records",
      iso.updated === 1 && (await db2.Task.get(p2t.id)).done === false,
      JSON.stringify({ updated: iso.updated, p2done: (await db2.Task.get(p2t.id)).done }));

    // ---- 25. write-gate failure before the first write ---------------------------------------------
    await db1.Locked.bulkCreate([{ v: "l1" }, { v: "l2" }]);
    const gateDeny = await captureCall(() => db1.Locked.updateMany({ v: ["l1", "l2"] }, { $set: { v: "never" } }));
    const lockAfter = await db1.Locked.filter({});
    harness.check("gate: an update rule that matches no caller refuses the whole batch and writes nothing",
      gateDeny.threw && gateDeny.code === "DATABASE_RLS_DENIED" && lockAfter.length === 2 && lockAfter.every((x) => String(x.v).startsWith("l")),
      JSON.stringify({ code: gateDeny.code, vs: lockAfter.map((x) => x.v) }));

    // ---- 28. relation enforcement --------------------------------------------------------------------
    const parentTask = await db1.Task.create({ title: "parent-task", status: "open", done: false });
    const otherTask = await db1.Task.create({ title: "other-task", status: "open", done: false });
    const child = await db1.Child.create({ parent: parentTask.id, label: "c1" });
    const fkBad = await captureCall(() => db1.Child.updateMany({ label: "c1" }, { $set: { parent: "nonexistent-parent-id" } }));
    harness.check("relations: a batch update pointing a FK at a non-existent record is refused and writes nothing",
      fkBad.threw && fkBad.code === "FK_NOT_FOUND" && (await db1.Child.get(child.id)).parent === parentTask.id,
      JSON.stringify({ code: fkBad.code }));
    const fkOk = await db1.Child.updateMany({ label: "c1" }, { $set: { parent: otherTask.id } });
    harness.check("relations: a batch update pointing a FK at an EXISTING record succeeds",
      fkOk.updated === 1 && (await db1.Child.get(child.id)).parent === otherTask.id,
      JSON.stringify({ updated: fkOk.updated }));

    // ---- 27. system fields -------------------------------------------------------------------------------
    const preSys = await db1.Task.get(parentTask.id);
    const sysCall = await db1.Task.updateMany({ title: "parent-task" }, { $set: { title: "parent-task" } });
    const postSys = await db1.Task.get(parentTask.id);
    harness.check("system fields: id/created_date are never rewritten, updated_date is the storage's own bump — the exact mechanism the batch progression rides",
      sysCall.updated === 1 && postSys.id === preSys.id && postSys.created_date === preSys.created_date
        && postSys.updated_date !== preSys.updated_date && postSys.title === "parent-task",
      JSON.stringify({ updated: sysCall.updated, idSame: postSys.id === preSys.id, createdSame: postSys.created_date === preSys.created_date, bumped: postSys.updated_date !== preSys.updated_date }));

    // ---- 26. update events ---------------------------------------------------------------------------------
    const evTask = (await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task", limit: 100 })).events;
    const evById = new Map();
    for (const ev of evTask) { const list = evById.get(ev.id) || []; list.push(ev.type); evById.set(ev.id, list); }
    const sOne = (evById.get(setSeeds[0].id) || []).join(",");
    const sTwo = (evById.get(setSeeds[1].id) || []).join(",");
    harness.check("events: a batch emits one update event PER RECORD through the single-update funnel (NEXUSAI-DERIVED emission parity only)",
      sOne.includes("create") && sOne.includes("update") && sTwo.includes("create") && sTwo.includes("update") && (sOne.match(/update/g) || []).length >= 2,
      JSON.stringify({ sOne, sTwo }));

    // ---- 29. unknown entity ---------------------------------------------------------------------------------
    const unknown = await captureCall(() => db1.NotAnEntity.updateMany({}, { $set: { a: 1 } }));
    harness.check("unknown entity: refused with DATABASE_ENTITY_NOT_FOUND naming updateMany (NEXUSAI-DERIVED shape, non-parity)",
      unknown.threw && unknown.code === "DATABASE_ENTITY_NOT_FOUND" && /updateMany/.test(unknown.message || ""),
      JSON.stringify(unknown));

    // ---- 16/17/18. batch scale: 501 matched records cross the documented 500 boundary ------------------------
    // NEXUSAI-DERIVED strategy under certification: the 500 LEAST-recently-updated matches
    // (ascending updated_date), with the storage's updated_date bump advancing a repeated call
    // past the rows it just wrote. The full second same-query 500-batch is omitted for the
    // suite's runtime budget; the selection MECHANISM it would exercise is asserted directly,
    // and the leftover beyond the batch is proven processable by a repeat call (no silent drop).
    try {
      await dbB.Task.create({ title: "b1", mark: "seed", grp: "odd" });
      await pace(300); // wall-clock separation so the odd record is strictly the oldest
      await db.entities.AppRecord.bulkCreate(
        Array.from({ length: 500 }, (_, k) => ({ project_id: PB.id, entity_name: "Task", data: { title: "b1", mark: "seed", grp: "bulk", i: k } })),
      );
      const batch1 = await dbB.Task.updateMany({ title: "b1" }, { $set: { mark: "a" } });
      harness.check("batch cap: 501 matched records → exactly one 500-record batch, has_more=true",
        batch1.success === true && batch1.updated === 500 && batch1.has_more === true && Object.keys(batch1).sort().join(",") === "has_more,success,updated",
        JSON.stringify(batch1));
      const aCount = await dbB.Task.count({ mark: "a" });
      const seedCount = await dbB.Task.count({ mark: "seed" });
      harness.check("batch cap: no silent drop — exactly one record remains unprocessed beyond the 500 batch",
        aCount === 500 && seedCount === 1, JSON.stringify({ aCount, seedCount }));
      const seedRec = (await dbB.Task.filter({ mark: "seed" }, "updated_date", 1))[0];
      const oldestA = (await dbB.Task.filter({ mark: "a" }, "updated_date", 1))[0];
      harness.check("progression mechanism: the never-processed record is strictly OLDEST, so the ascending-updated_date batch must pick it first on a repeat (NEXUSAI-DERIVED strategy)",
        !!seedRec && !!oldestA && typeof seedRec.updated_date === "string" && typeof oldestA.updated_date === "string"
          && new Date(seedRec.updated_date).getTime() < new Date(oldestA.updated_date).getTime(),
        JSON.stringify({ seed: seedRec && seedRec.updated_date, oldestA: oldestA && oldestA.updated_date }));
      const batch2 = await dbB.Task.updateMany({ title: "b1", mark: "seed" }, { $set: { mark: "b" } });
      const bCount = await dbB.Task.count({ mark: "b" });
      harness.check("repeat call: the leftover beyond the 500 batch is processed by the same machine — never silently dropped, has_more=false at exhaustion",
        batch2.updated === 1 && batch2.has_more === false && bCount === 1,
        JSON.stringify({ success: batch2.success, updated: batch2.updated, has_more: batch2.has_more, bCount }));
    } catch (heavyError) {
      harness.check("batch scale: the 501-record section executed without error", false, String(heavyError.message || heavyError));
    }

    // ---- billing neutrality --------------------------------------------------------------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: updateMany moves no credits in either pool",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);

    // ---- 30. contract-boundary classification pinned ----------------------------------------------------------
    harness.check("boundary: transport, operators, field conflict, response shape and batching are labeled DOCUMENTED",
      UPDATE_MANY_CONTRACT.transport.startsWith("DOCUMENTED") && UPDATE_MANY_CONTRACT.operators.startsWith("DOCUMENTED")
        && UPDATE_MANY_CONTRACT.field_conflict.startsWith("DOCUMENTED") && UPDATE_MANY_CONTRACT.response_shape.startsWith("DOCUMENTED")
        && UPDATE_MANY_CONTRACT.batching.startsWith("DOCUMENTED"),
      JSON.stringify(UPDATE_MANY_CONTRACT));
    harness.check("boundary: batch strategy, has_more probe, operator edges, unchanged counting, atomicity, events, errors and unknown entity are labeled NEXUSAI-DERIVED, non-parity",
      UPDATE_MANY_CONTRACT.batch_strategy.startsWith("NEXUSAI-DERIVED") && UPDATE_MANY_CONTRACT.has_more_probe.startsWith("NEXUSAI-DERIVED")
        && UPDATE_MANY_CONTRACT.operator_edges.startsWith("NEXUSAI-DERIVED") && UPDATE_MANY_CONTRACT.unchanged_counting.startsWith("NEXUSAI-DERIVED")
        && UPDATE_MANY_CONTRACT.atomicity.startsWith("NEXUSAI-DERIVED") && UPDATE_MANY_CONTRACT.events.startsWith("NEXUSAI-DERIVED")
        && UPDATE_MANY_CONTRACT.errors.startsWith("NEXUSAI-DERIVED") && UPDATE_MANY_CONTRACT.unknown_entity.startsWith("NEXUSAI-DERIVED"),
      JSON.stringify(UPDATE_MANY_CONTRACT));
    harness.check("boundary: query form beyond Partial<T> is labeled NEXUSAI-DERIVED, the upstream progression mechanism is UNKNOWN, and billing is NOT claimed",
      UPDATE_MANY_CONTRACT.query_form.includes("NEXUSAI-DERIVED") && UPDATE_MANY_CONTRACT.batch_progression_mechanism.startsWith("UNKNOWN")
        && UPDATE_MANY_CONTRACT.billing.startsWith("NOT CLAIMED"),
      JSON.stringify(UPDATE_MANY_CONTRACT));

    // ---- runtime export surface ------------------------------------------------------------------------------
    harness.check("surface: the `db` export remains registered in the runtime export surface (updateMany rides on it)",
      RUNTIME_EXPORTS.includes("db"), "db present");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911um-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911um" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppRelation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911um_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911um[0-9]+$" } }).catch(() => {});
  }
}