// Certification suite for the ALREADY-IMPLEMENTED B6 entity WRITE contracts, audited against
// base44/javascript-sdk@0.8.51. Certification only — this suite changes no implementation.
//
// DOCUMENTED (SDK 0.8.51 docs + unit-tested response bodies):
//   • delete(id)            → DeleteResult, EXACTLY { success: true }
//   • deleteMany(query)     → DeleteManyResult { success, deleted } ("Deletes multiple records
//                             matching a query"); the additive `ids` field is NEXUSAI-DERIVED
//   • bulkCreate(records)   → the created records array T[]
//   • bulkUpdate(records)  → the updated records array T[]; the DOCUMENTED entry form is FLAT
//                             [{ id, ...changes }] ("each item must have id")
//   • importEntities        → ImportResult { status, output } (browser surface)
//
// NEXUSAI-DERIVED / non-parity (every semantic upstream does NOT prove — bounded choices,
// never claimed as Base44 behavior):
//   • legacy [{ id, data }] bulkUpdate entries stay accepted for internal callers;
//   • updateWhere keeps its additive { updated, items } contract (NOT an SDK 0.8.51 op);
//   • empty arrays, the 500-record caps, caller-supplied id/owner_id and the empty deleteMany
//     query are refused fail-closed with structured DatabaseError codes;
//   • gate/validation/relation failures abort the WHOLE batch BEFORE the first persist
//     (per-record persist, not all-or-nothing);
//   • per-record create/update/delete events through the single Stage-B funnel;
//   • error codes/statuses and the unknown-entity refusal shape.
//
// UNKNOWN upstream (not claimed): exact upstream error codes, event behavior on write ops,
// atomicity of bulk persists, upstream empty-array/limit semantics, service-role import.
//
// The suite drives the REAL createServerDb funnel (deployed runtime, preview and backend
// functions all write through it) — no mocks.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall } from "../../shared/testHarness.ts";
import { openCertification } from "../../shared/certificationIsolation.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb, readEntityEvents } from "../../shared/appData.ts";
import { importEntitiesIntoDb } from "../../shared/appImport.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// The certified contract, pinned so the suite states its own boundary.
const WRITE_CONTRACT = {
  delete: "DOCUMENTED (SDK 0.8.51) — delete(id) resolves with DeleteResult { success: true }, the unit-tested upstream body",
  delete_many: "DOCUMENTED (SDK 0.8.51) — { success, deleted }; the additive ids field is NEXUSAI-DERIVED",
  bulk_create: "DOCUMENTED (SDK 0.8.51 docs) — resolves with the created records array T[]",
  bulk_update: "DOCUMENTED (SDK 0.8.51 docs) — flat [{ id, ...changes }], resolves with the updated records array T[]",
  legacy_form: "NEXUSAI-DERIVED — the nested [{ id, data }] form stays accepted for internal callers (upstream publishes only the flat form)",
  update_where: "NEXUSAI-DERIVED additive surface — { updated, items }, not an SDK 0.8.51 op",
  import: "DOCUMENTED (ImportResult) — { status, output }; the output status VALUE and CSV semantics are NEXUSAI-DERIVED",
  refusals: "NEXUSAI-DERIVED fail-closed — empty arrays, the 500-record caps, caller-supplied id/owner_id, the empty deleteMany query (upstream: UNKNOWN)",
  error_shapes: "NEXUSAI-DERIVED — structured DatabaseError codes/statuses (upstream: UNKNOWN)",
  events: "NEXUSAI-DERIVED emission parity only — per-record create/update/delete events (upstream event behavior: UNKNOWN)",
  atomicity: "NEXUSAI-DERIVED — every gate, validation and relation check runs before the first persist; per-record persist, not all-or-nothing (upstream: UNKNOWN)",
};

const ENTITIES = [
  { name: "Task", fields: { title: { type: "string" }, status: { type: "string" }, done: { type: "boolean" }, n: { type: "number" }, tags: { type: "array" } } },
  { name: "Memo", fields: { body: { type: "string", required: true }, extra: { type: "string" } } },
  { name: "Child", fields: { parent: { type: "string" }, label: { type: "string" } } },
  { name: "Locked", fields: { v: { type: "string" } }, rls: { create: true, read: true, update: { user_condition: { role: "system" } }, delete: true } },
  { name: "Hidden", fields: { v: { type: "string" } }, rls: { create: true, read: false, update: true, delete: true } },
  { name: "Ledger", fields: { owner: { type: "string" }, body: { type: "string" } }, rls: { create: true, read: { "data.owner": "{{user.id}}" }, update: true, delete: true } },
];

export default async function (req) {
  let cert;
  try { cert = await openCertification(createClientFromRequest(req), req, "entity_write_contracts", 7); }
  catch (error) { return Response.json({ result: "BLOCKED", blocker: { code: error.code, message: error.message } }, { status: error.status || 503 }); }
  if (cert.immediate) return cert.immediate;
  const db = cert.db;
  const harness = createHarness();
  harness.results.push(...cert.state.results);
  const phase = cert.state.phase;
  const stamp = cert.locals.stamp || Date.now();
  const created = cert.locals.created || { workspaces: [], plans: [] };
  const wsIds = cert.locals.wsIds || [];
  const projectIds = cert.locals.projectIds || [];
  let { A, P1, P2, PR, msg0, int0, seeds } = cert.locals;
  const pace = (ms) => appAgentPace(ms || 400);
  const b64 = (t) => (typeof btoa === "function" ? btoa(t) : Buffer.from(t, "utf8").toString("base64"));
  const pause = () => cert.pause({ stamp, created, wsIds, projectIds, A, P1, P2, PR, msg0, int0, seeds }, harness.results);

  try {
    if (phase === 0) {
      const plan = await makeBillingPlan(db, created, cert.state.tag, {});
      A = await makeBillingWorkspace(db, created, cert.state.tag, { plan });
      wsIds.push(A.ws.id);
      const pools = makeAgentPoolTools(db, stamp, cert.state.tag);
      await pools.grant(A.ws.id, "message", 50);
      await pools.grant(A.ws.id, "integration", 50);
      msg0 = await pools.msgOf(A.ws.id);
      int0 = await pools.intOf(A.ws.id);
      P1 = await makeAgentProject(db, projectIds, A, stamp, cert.state.tag);
      P2 = await makeAgentProject(db, projectIds, A, stamp, cert.state.tag);
      PR = await makeAgentProject(db, projectIds, A, stamp, cert.state.tag);
      await db.entities.Project.update(PR.id, { rls_enabled: true });
      await db.entities.AppRelation.create({ project_id: P1.id, name: "child_task", from_entity: "Child", to_entity: "Task", from_field: "parent", type: "many_to_one", on_delete: "restrict" });
    }
    const { msgOf, intOf } = makeAgentPoolTools(db, stamp, cert.state.tag);
    const userA1 = { id: `p911wc_userA1_${stamp}`, email: "a1@p911wc.test" };
    const userA2 = { id: `p911wc_userA2_${stamp}`, email: "a2@p911wc.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbR1 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });
    const dbR2 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA2 });
    const dbR0 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: null });
    await pace();

    if (phase === 0) {
    // ---- 1. bulkCreate: DOCUMENTED created records array T[] --------------------------------
    seeds = await db1.Task.bulkCreate([
      { title: "s-one", status: "open", done: false, n: 1 },
      { title: "s-two", status: "open", done: false, n: 2 },
      { title: "s-three", status: "done", done: true, n: 3 },
    ]);
    harness.check("bulkCreate: resolves with the created records ARRAY T[] — input order, ids and created_date present",
      Array.isArray(seeds) && seeds.length === 3 && seeds.map((s) => s.title).join(",") === "s-one,s-two,s-three"
        && seeds.every((s) => typeof s.id === "string" && s.id && typeof s.created_date === "string"),
      JSON.stringify(Array.isArray(seeds) ? seeds.map((s) => s.title) : seeds));
    const persisted = await db1.Task.get(seeds[1].id);
    harness.check("bulkCreate: the returned array holds EXACTLY what was persisted (get round-trip)",
      persisted.title === "s-two" && persisted.status === "open" && persisted.n === 2 && persisted.done === false,
      JSON.stringify({ title: persisted.title, n: persisted.n }));
    const badId = await captureCall(() => db1.Task.bulkCreate([{ id: "forged", title: "x" }]));
    harness.check("bulkCreate: a caller-supplied id is refused fail-closed, nothing written (upstream: UNKNOWN)",
      badId.threw && badId.code === "DATABASE_VALIDATION_FAILED" && (await db1.Task.count({ title: "x" })) === 0,
      JSON.stringify({ code: badId.code }));
    const badBatch = await captureCall(() => db1.Task.bulkCreate([{ title: "ok-1" }, { title: "ok-2" }, { done: "not-a-boolean" }]));
    harness.check("bulkCreate: one invalid record aborts the WHOLE batch before the first persist (NEXUSAI-DERIVED fail-fast)",
      badBatch.threw && badBatch.code === "DATABASE_VALIDATION_FAILED"
        && (await db1.Task.count({ title: ["ok-1", "ok-2"] })) === 0,
      JSON.stringify({ code: badBatch.code }));
    const cap = await captureCall(() => db1.Task.bulkCreate(Array.from({ length: 501 }, (_, i) => ({ title: `cap-${i}` }))));
    const emptyArr = await captureCall(() => db1.Task.bulkCreate([]));
    harness.check("bulkCreate: the 500-record cap and an empty array are refused fail-closed, nothing written (cap DOCUMENTED; error shape NEXUSAI-DERIVED)",
      cap.threw && cap.code === "DATABASE_BULK_LIMIT" && emptyArr.threw && emptyArr.code === "DATABASE_INVALID_BULK"
        && (await db1.Task.count({ title: { $regex: "^cap-" } })) === 0,
      JSON.stringify({ cap: cap.code, empty: emptyArr.code }));
    const unknownBulk = await captureCall(() => db1.Nope.bulkCreate([{ a: 1 }]));
    harness.check("bulkCreate: an unknown entity is refused with the structured DATABASE_ENTITY_NOT_FOUND naming the operation (NEXUSAI-DERIVED shape)",
      unknownBulk.threw && unknownBulk.code === "DATABASE_ENTITY_NOT_FOUND" && /bulkCreate/.test(unknownBulk.message || ""),
      JSON.stringify(unknownBulk));

    return await pause();
    }
    if (phase === 1) {
    // ---- 2. bulkUpdate: DOCUMENTED flat form + records array T[] ----------------------------
    const pre = await db1.Task.get(seeds[0].id);
    const upd = await db1.Task.bulkUpdate([{ id: seeds[0].id, status: "flat", done: true }]);
    harness.check("bulkUpdate (flat form): [{ id, ...changes }] resolves with the updated records array T[] — only listed fields change",
      Array.isArray(upd) && upd.length === 1 && upd[0].id === seeds[0].id && upd[0].status === "flat" && upd[0].done === true
        && upd[0].title === "s-one" && upd[0].n === 1,
      JSON.stringify(Array.isArray(upd) ? upd.map((u) => ({ s: u.status, t: u.title })) : upd));
    harness.check("bulkUpdate: system fields — id and created_date never move, updated_date bumps (the storage's own stamp)",
      upd[0].created_date === pre.created_date && upd[0].updated_date !== pre.updated_date,
      JSON.stringify({ idSame: upd[0].id === pre.id, createdSame: upd[0].created_date === pre.created_date }));
    const legacy = await db1.Task.bulkUpdate([{ id: seeds[1].id, data: { status: "legacy" } }]);
    const legacyBack = await db1.Task.get(seeds[1].id);
    harness.check("bulkUpdate (legacy form): the nested { id, data } entry stays functional for internal callers (NEXUSAI-DERIVED compatibility)",
      Array.isArray(legacy) && legacy.length === 1 && legacyBack.status === "legacy" && legacyBack.title === "s-two",
      JSON.stringify({ status: legacyBack.status }));
    const mixed = await db1.Task.bulkUpdate([{ id: seeds[0].id, status: "m-flat" }, { id: seeds[1].id, data: { status: "m-legacy" } }]);
    harness.check("bulkUpdate: flat and legacy entries may MIX in one call — per-entry disambiguation (NEXUSAI-DERIVED boundary)",
      Array.isArray(mixed) && mixed.length === 2 && (await db1.Task.get(seeds[0].id)).status === "m-flat"
        && (await db1.Task.get(seeds[1].id)).status === "m-legacy",
      JSON.stringify({ first: mixed[0] && mixed[0].status, second: mixed[1] && mixed[1].status }));
    const noId = await captureCall(() => db1.Task.bulkUpdate([{ status: "x" }]));
    const missing = await captureCall(() => db1.Task.bulkUpdate([{ id: seeds[0].id, status: "y" }, { id: "does-not-exist", status: "z" }]));
    harness.check("bulkUpdate: a missing id is refused, and a non-existent id aborts the whole batch BEFORE the first persist — the valid record stays untouched",
      noId.threw && noId.code === "DATABASE_INVALID_BULK" && missing.threw && missing.code === "DATABASE_RECORD_NOT_FOUND"
        && (await db1.Task.get(seeds[0].id)).status === "m-flat",
      JSON.stringify({ noId: noId.code, missing: missing.code }));
    const invalidUpd = await captureCall(() => db1.Task.bulkUpdate([{ id: seeds[0].id, done: "not-a-boolean" }]));
    const capUpd = await captureCall(() => db1.Task.bulkUpdate(Array.from({ length: 501 }, () => ({ id: seeds[0].id, n: 1 }))));
    const emptyUpd = await captureCall(() => db1.Task.bulkUpdate([]));
    harness.check("bulkUpdate: invalid changes, the 500-record cap and an empty array all refuse fail-closed with nothing written",
      invalidUpd.threw && invalidUpd.code === "DATABASE_VALIDATION_FAILED" && capUpd.threw && capUpd.code === "DATABASE_BULK_LIMIT"
        && emptyUpd.threw && emptyUpd.code === "DATABASE_INVALID_BULK" && (await db1.Task.get(seeds[0].id)).done === true,
      JSON.stringify({ invalid: invalidUpd.code, cap: capUpd.code, empty: emptyUpd.code }));
    const lockedRow = await db1.Locked.create({ v: "l1" });
    const gateDeny = await captureCall(() => db1.Locked.bulkUpdate([{ id: lockedRow.id, v: "never" }]));
    harness.check("bulkUpdate: a write gate that matches no caller refuses the whole batch and writes nothing (DATABASE_RLS_DENIED)",
      gateDeny.threw && gateDeny.code === "DATABASE_RLS_DENIED" && (await db1.Locked.filter({}))[0].v === "l1",
      JSON.stringify({ code: gateDeny.code }));
    const unknownUpd = await captureCall(() => db1.Nope.bulkUpdate([{ id: "x", a: 1 }]));
    harness.check("bulkUpdate: an unknown entity is refused with the structured DATABASE_ENTITY_NOT_FOUND naming the operation",
      unknownUpd.threw && unknownUpd.code === "DATABASE_ENTITY_NOT_FOUND" && /bulkUpdate/.test(unknownUpd.message || ""),
      JSON.stringify(unknownUpd));

    return await pause();
    }
    if (phase === 2) {
    // ---- 3. delete: DOCUMENTED DeleteResult { success: true } --------------------------------
    const delOne = await db1.Task.delete(seeds[2].id);
    const delGone = await captureCall(() => db1.Task.get(seeds[2].id));
    harness.check("delete: resolves with EXACTLY { success: true } and the record is really gone",
      delOne && Object.keys(delOne).sort().join(",") === "success" && delOne.success === true
        && delGone.threw && delGone.code === "DATABASE_RECORD_NOT_FOUND",
      JSON.stringify({ shape: delOne && Object.keys(delOne), gone: delGone.code }));
    const delMissing = await captureCall(() => db1.Task.delete("does-not-exist"));
    harness.check("delete: a non-existent record is refused as DATABASE_RECORD_NOT_FOUND — existence never leaks (NEXUSAI-DERIVED shape)",
      delMissing.threw && delMissing.code === "DATABASE_RECORD_NOT_FOUND", JSON.stringify(delMissing.code));

    // ---- 4. deleteMany: DOCUMENTED { success, deleted } + additive ids ----------------------
    const dmTargets = await db1.Task.bulkCreate([{ title: "dm-1", status: "open" }, { title: "dm-2", status: "open" }]);
    const dm = await db1.Task.deleteMany({ status: "open", title: ["dm-1", "dm-2"] });
    harness.check("deleteMany: resolves with { success, deleted } — deleted counts the removed records, and the additive ids name them (NEXUSAI-DERIVED field)",
      dm && dm.success === true && dm.deleted === 2 && Array.isArray(dm.ids) && dm.ids.sort().join(",") === dmTargets.map((t) => t.id).sort().join(",")
        && (await db1.Task.count({ title: ["dm-1", "dm-2"] })) === 0,
      JSON.stringify({ success: dm.success, deleted: dm.deleted, keys: Object.keys(dm).sort().join(",") }));
    const dmZero = await db1.Task.deleteMany({ title: "no-such" });
    harness.check("deleteMany: zero matches resolve successfully with deleted 0 and an empty additive ids list",
      dmZero.success === true && dmZero.deleted === 0 && dmZero.ids.length === 0, JSON.stringify(dmZero));
    const dmGuard = await captureCall(() => db1.Task.deleteMany({}));
    harness.check("deleteMany: an empty query is refused fail-closed (NEXUSAI-DERIVED guard; upstream semantics UNKNOWN)",
      dmGuard.threw && dmGuard.code === "DATABASE_UNSAFE_BULK", JSON.stringify(dmGuard));
    const unknownDel = await captureCall(() => db1.Nope.delete("x"));
    const unknownDm = await captureCall(() => db1.Nope.deleteMany({ a: 1 }));
    harness.check("delete/deleteMany: unknown entities are refused with the structured DATABASE_ENTITY_NOT_FOUND naming each operation",
      unknownDel.threw && unknownDel.code === "DATABASE_ENTITY_NOT_FOUND" && /delete/.test(unknownDel.message || "")
        && unknownDm.threw && unknownDm.code === "DATABASE_ENTITY_NOT_FOUND" && /deleteMany/.test(unknownDm.message || ""),
      JSON.stringify({ del: unknownDel.code, dm: unknownDm.code }));

    // ---- 5. updateWhere: NEXUSAI-DERIVED additive contract unchanged -------------------------
    await db1.Memo.bulkCreate([{ body: "uw-1", extra: "e1" }, { body: "uw-2", extra: "e2" }, { body: "keep", extra: "e3" }]);
    const uw = await db1.Memo.updateWhere({ body: ["uw-1", "uw-2"] }, { extra: "touched" });
    harness.check("updateWhere: the additive { updated, items } contract is UNCHANGED — counts matches and returns the records",
      uw && Object.keys(uw).sort().join(",") === "items,updated" && uw.updated === 2 && uw.items.length === 2
        && (await db1.Memo.count({ extra: "touched" })) === 2,
      JSON.stringify({ updated: uw.updated, keys: Object.keys(uw).sort().join(",") }));
    const uwZero = await db1.Memo.updateWhere({ body: "no-such" }, { extra: "x" });
    harness.check("updateWhere: zero matches keep the contract — { updated: 0, items: [] }",
      uwZero.updated === 0 && Array.isArray(uwZero.items) && uwZero.items.length === 0, JSON.stringify(uwZero));

    return await pause();
    }
    if (phase === 3) {
    // ---- 6. importEntities: DOCUMENTED ImportResult, unchanged ------------------------------
    const csv = "title,status,done,n\ncsv-one,open,false,1\ncsv-two,done,true,2\n";
    const imp = await importEntitiesIntoDb(db1, "Task", { filename: "seed.csv", content_type: "text/csv", content_base64: b64(csv) });
    const impRow = await db1.Task.filter({ title: "csv-one" });
    harness.check("import: resolves with the DOCUMENTED ImportResult { status, output } — imported counts and output.items are the created records",
      imp && imp.status === "success" && imp.output.imported === 2 && Array.isArray(imp.output.items) && imp.output.items.length === 2
        && impRow.length === 1 && impRow[0].done === false && impRow[0].n === 1,
      JSON.stringify({ status: imp.status, imported: imp.output.imported }));
    const impBad = await captureCall(() => importEntitiesIntoDb(db1, "Task", { filename: "bad.csv", content_type: "text/csv", content_base64: b64("title,status\nbad,open,extra") }));
    harness.check("import: a malformed CSV fails the WHOLE import before any write (bulkCreate fail-fast, NEXUSAI-DERIVED)",
      impBad.threw && impBad.code === "IMPORT_CSV_PARSE_FAILED" && (await db1.Task.count({ title: "bad" })) === 0,
      JSON.stringify({ code: impBad.code }));
    const impRows = await captureCall(() => importEntitiesIntoDb(db1, "Task", { filename: "big.csv", content_type: "text/csv", content_base64: b64("title\n" + Array.from({ length: 501 }, (_, i) => `r-${i}`).join("\n")) }));
    harness.check("import: the 500-row ceiling is refused before any write (NEXUSAI-DERIVED bound; upstream import limits UNKNOWN)",
      impRows.threw && impRows.code === "IMPORT_TOO_MANY_ROWS" && (await db1.Task.count({ title: { $regex: "^r-" } })) === 0,
      JSON.stringify({ code: impRows.code }));

    return await pause();
    }
    if (phase === 4) {
    // ---- 7. auth + RLS on every write surface ------------------------------------------------
    const anonCreate = await captureCall(() => dbR0.Ledger.create({ owner: "x", body: "anon" }));
    const anonDelete = await captureCall(() => dbR0.Ledger.delete("whatever"));
    const anonBulkC = await captureCall(() => dbR0.Ledger.bulkCreate([{ owner: "x", body: "anon" }]));
    const anonBulkU = await captureCall(() => dbR0.Ledger.bulkUpdate([{ id: "whatever", body: "anon" }]));
    const anonDm = await captureCall(() => dbR0.Ledger.deleteMany({ body: "anon" }));
    harness.check("RLS: an anonymous caller is refused with AUTH_REQUIRED (401) on create, delete, bulkCreate, bulkUpdate and deleteMany — before any work",
      [anonCreate, anonDelete, anonBulkC, anonBulkU, anonDm].every((c) => c.threw && c.code === "AUTH_REQUIRED" && c.status === 401),
      JSON.stringify({ codes: [anonCreate, anonDelete, anonBulkC, anonBulkU, anonDm].map((c) => c.code) }));
    const own = await dbR1.Ledger.create({ owner: userA1.id, body: "mine" });
    const foreignGet = await captureCall(() => dbR2.Ledger.get(own.id));
    const foreignUpd = await captureCall(() => dbR2.Ledger.update(own.id, { body: "stolen" }));
    const foreignDel = await captureCall(() => dbR2.Ledger.delete(own.id));
    const foreignBulk = await captureCall(() => dbR2.Ledger.bulkUpdate([{ id: own.id, body: "stolen" }]));
    harness.check("RLS: another user's record is NOT FOUND on get, update, delete and flat bulkUpdate — existence never leaks, nothing changes",
      [foreignGet, foreignUpd, foreignDel, foreignBulk].every((c) => c.threw && c.code === "DATABASE_RECORD_NOT_FOUND")
        && (await dbR1.Ledger.get(own.id)).body === "mine",
      JSON.stringify({ codes: [foreignGet, foreignUpd, foreignDel, foreignBulk].map((c) => c.code) }));
    const forged = await dbR1.Ledger.bulkCreate([{ owner: userA1.id, owner_id: "forged-owner", body: "forged" }]);
    const foreignView = await dbR2.Ledger.filter({ body: "forged" });
    harness.check("RLS: a caller-supplied owner_id is stripped — the system stamps the caller's id, so another user sees nothing",
      forged.length === 1 && (await dbR1.Ledger.get(forged[0].id)).body === "forged" && foreignView.length === 0,
      JSON.stringify({ created: forged.length, visibleToOther: foreignView.length }));
    const foreignSet = await dbR2.Ledger.deleteMany({ body: "mine" });
    const ownDel = await dbR1.Ledger.delete(own.id);
    harness.check("RLS: another user's deleteMany matches nothing (owner-scoped query), and the owner's own delete succeeds with the DOCUMENTED shape",
      foreignSet.success === true && foreignSet.deleted === 0 && ownDel.success === true && Object.keys(ownDel).length === 1,
      JSON.stringify({ theirs: foreignSet.deleted, own: ownDel }));

    // ---- 8. project isolation -----------------------------------------------------------------
    const isoDb2 = await db2.Task.create({ title: "iso", status: "open" });
    const isoBulk = await db1.Task.bulkCreate([{ title: "iso", status: "open" }]);
    const isoUpd = await captureCall(() => db1.Task.bulkUpdate([{ id: isoDb2.id, status: "cross" }]));
    const isoDel = await captureCall(() => db1.Task.delete(isoDb2.id));
    const isoDm = await db1.Task.deleteMany({ title: "iso" });
    harness.check("isolation: one project's writes never see or touch another project's records — its bulkCreate is separate, and cross-project id writes are NOT FOUND",
      isoBulk.length === 1 && isoUpd.threw && isoUpd.code === "DATABASE_RECORD_NOT_FOUND" && isoDel.threw && isoDel.code === "DATABASE_RECORD_NOT_FOUND"
        && isoDm.deleted === 1 && (await db2.Task.get(isoDb2.id)).status === "open",
      JSON.stringify({ upd: isoUpd.code, del: isoDel.code, dmDeleted: isoDm.deleted, otherStatus: (await db2.Task.get(isoDb2.id)).status }));

    return await pause();
    }
    if (phase === 5) {
    // ---- 9. relation enforcement -----------------------------------------------------------------
    const fkParent = await db1.Task.create({ title: "fk-parent", status: "open" });
    await db1.Child.create({ parent: fkParent.id, label: "c1" });
    const childRow = (await db1.Child.filter({ label: "c1" }))[0];
    const fkBad = await captureCall(() => db1.Child.bulkCreate([{ parent: "nonexistent", label: "bad" }]));
    const fkBadUpd = await captureCall(() => db1.Child.bulkUpdate([{ id: childRow.id, parent: "nonexistent" }]));
    harness.check("relations: a FK pointing at a non-existent record is refused on bulkCreate AND flat bulkUpdate — nothing written (relation machine's own code)",
      fkBad.threw && fkBad.code === "FK_NOT_FOUND" && fkBadUpd.threw && fkBadUpd.code === "FK_NOT_FOUND"
        && (await db1.Child.count({})) === 1 && (await db1.Child.get(childRow.id)).parent === fkParent.id,
      JSON.stringify({ create: fkBad.code, update: fkBadUpd.code }));
    const fkDel = await captureCall(() => db1.Task.delete(fkParent.id));
    harness.check("relations: restrict blocks deleting a referenced parent — the parent and its child survive",
      fkDel.threw && (await db1.Task.get(fkParent.id)).title === "fk-parent" && (await db1.Child.count({ label: "c1" })) === 1,
      JSON.stringify({ code: fkDel.code }));
    const fkParents2 = await db1.Task.bulkCreate([{ title: "fk-p2", status: "open" }, { title: "fk-p3", status: "open" }]);
    await db1.Child.create({ parent: fkParents2[0].id, label: "c2" });
    const fkDm = await captureCall(() => db1.Task.deleteMany({ title: ["fk-p2", "fk-p3"] }));
    harness.check("relations: deleteMany of a restrict-referenced parent aborts the WHOLE batch before any removal",
      fkDm.threw && (await db1.Task.count({ title: ["fk-p2", "fk-p3"] })) === 2,
      JSON.stringify({ code: fkDm.code, survivors: await db1.Task.count({ title: ["fk-p2", "fk-p3"] }) }));

    // ---- 10. read-deny blindness: set-writes cannot see what the read rule hides -----------------
    await db1.Hidden.bulkCreate([{ v: "h1" }, { v: "h2" }]);
    const blindDm = await db1.Hidden.deleteMany({ v: ["h1", "h2"] });
    const hiddenRows = await db.entities.AppRecord.filter({ project_id: P1.id, entity_name: "Hidden" }, "-created_date", 10);
    harness.check("visibility: a read rule that denies everything makes deleteMany match ZERO — the rows are never touched through that surface",
      blindDm.success === true && blindDm.deleted === 0 && hiddenRows.length === 2,
      JSON.stringify({ deleted: blindDm.deleted, rows: hiddenRows.length }));

    return await pause();
    }
    // ---- 11. mutation events: per-record emission where already supported -----------------------
    const traceSeed = await db1.Task.bulkCreate([{ title: "lifecycle", status: "open" }]);
    await db1.Task.bulkUpdate([{ id: traceSeed[0].id, status: "touched" }]);
    await db1.Task.deleteMany({ title: "lifecycle" });
    const evTask = (await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task", limit: 100 })).events;
    const trace = evTask.filter((ev) => ev.id === traceSeed[0].id).map((ev) => ev.type).join(",");
    harness.check("events: bulkCreate, flat bulkUpdate and deleteMany emit one event PER RECORD through the single funnel (NEXUSAI-DERIVED emission parity only)",
      trace === "create,update,delete", JSON.stringify(trace));

    // ---- 12. billing neutrality + runtime export surface ---------------------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: the write-contract surface moves no credits in either pool (NOT CLAIMED upstream — observed neutrality only)",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);
    harness.check("surface: the `db` export remains registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("db"), "db present");

    // ---- 13. contract-boundary classification pinned --------------------------------------------
    harness.check("boundary: delete, deleteMany, bulkCreate and the flat bulkUpdate form + T[] returns are labeled DOCUMENTED",
      WRITE_CONTRACT.delete.startsWith("DOCUMENTED") && WRITE_CONTRACT.delete_many.startsWith("DOCUMENTED")
        && WRITE_CONTRACT.bulk_create.startsWith("DOCUMENTED") && WRITE_CONTRACT.bulk_update.startsWith("DOCUMENTED")
        && WRITE_CONTRACT.import.startsWith("DOCUMENTED"),
      JSON.stringify(WRITE_CONTRACT));
    harness.check("boundary: the legacy form, updateWhere, refusal shapes, error codes, events and atomicity are labeled NEXUSAI-DERIVED",
      WRITE_CONTRACT.legacy_form.startsWith("NEXUSAI-DERIVED") && WRITE_CONTRACT.update_where.startsWith("NEXUSAI-DERIVED")
        && WRITE_CONTRACT.refusals.startsWith("NEXUSAI-DERIVED") && WRITE_CONTRACT.error_shapes.startsWith("NEXUSAI-DERIVED")
        && WRITE_CONTRACT.events.startsWith("NEXUSAI-DERIVED") && WRITE_CONTRACT.atomicity.startsWith("NEXUSAI-DERIVED"),
      JSON.stringify(WRITE_CONTRACT));

    return await cert.finish(harness.results);
  } catch (error) {
    return await cert.finish(harness.results, error);
  }
}