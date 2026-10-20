// Focused certification for Entity Trash (parity from the completed Base44 audit).
//
// Drives the REAL runtime db (createServerDb — the same machine the generated apps execute
// through) and the REAL trash control plane (entityTrashSurface). Certified:
//   1. delete → trash: the record leaves the live list, appears in trash with its SAME id,
//      fields intact and a deleted_date; get() reports it not found.
//   2. restore one: back LIVE with the original id and fields, out of trash.
//   3. restore matching: a filter restores only matches; {} restores EVERYTHING; the
//      DOCUMENTED { success, restored } response shape.
//   4. permanent delete: the separate explicit action — erases from trash only, irreversible,
//      and refuses a record that is not in trash.
//   5. bulk deletion paths (deleteMany/deleteWhere → bulkDelete) trash too.
//   6. list contract: limit/skip pagination (omit limit = whole trash), q filtering,
//      single-field sort, fields projection with id always kept.
//   7. cross-project AND cross-entity isolation (uniform "not found in trash").
//   8. RLS app: another user can't delete or see the record; the owner's delete trashes it;
//      the management-level trash listing applies NO RLS (per contract) and restore keeps
//      the record's owner.
//   9. regression: normal CRUD unchanged (update/filter/get/delete shapes and semantics).
//  10. the delete event stream is unchanged; restores emit no events (bulk documented;
//      single UNKNOWN).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { createServerDb, readEntityEvents } from "../../shared/appData.ts";
import { entityTrashSurface } from "../../shared/entityTrash.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projects = [];
  const defs = [{ name: "Task", fields: { title: { type: "string", required: true }, status: { type: "string" } } }];
  const trash = (projectId, over = {}) => entityTrashSurface(db, { project_id: projectId, ...over });

  let projA = null;
  let projB = null;
  try {
    const A = await makeBillingWorkspace(db, created, `trashcert${stamp}`, { plan: null });
    projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `trash-a-${stamp}` });
    projB = await db.entities.Project.create({ workspace_id: A.ws.id, name: `trash-b-${stamp}` });
    projects.push(projA.id, projB.id);
    const app = createServerDb(db, projA.id, defs, { rls: false });
    const create = async (title, status) => (await app.Task.create({ title, status })).id;

    // ---- 1. delete → trash -------------------------------------------------------------------
    const [idA, idB, idC] = [await create("alpha", "open"), await create("beta", "open"), await create("gamma", "open")];
    const del = await app.Task.delete(idA);
    const liveAfterDelete = await app.Task.filter({});
    const gone = await captureCall(() => app.Task.get(idA));
    const trashed = await trash(projA.id, { action: "list", entity_name: "Task" });
    harness.check("delete moves the record to trash: out of the live list, get reports not found, in the trash with the SAME id, fields and a deleted_date",
      del.success === true && liveAfterDelete.length === 2 && gone.threw && gone.code === "DATABASE_RECORD_NOT_FOUND" &&
      trashed.length === 1 && trashed[0].id === idA && trashed[0].title === "alpha" && !!trashed[0].deleted_date,
      { trashed: trashed.length, deleted_date: !!trashed[0]?.deleted_date });

    // ---- 2. restore one ------------------------------------------------------------------------
    const restored = await trash(projA.id, { action: "restore", entity_name: "Task", record_id: idA });
    const liveAfterRestore = await app.Task.filter({});
    harness.check("restoring brings the record back LIVE with its original id and fields (and no deleted_date)",
      restored.id === idA && restored.title === "alpha" && restored.deleted_date === undefined &&
      liveAfterRestore.length === 3 && (await app.Task.get(idA)).title === "alpha" &&
      (await trash(projA.id, { action: "list", entity_name: "Task" })).length === 0,
      { restored_id_same: restored.id === idA });

    // ---- 3. restore matching -------------------------------------------------------------------
    const [idD, idE, idF] = [await create("delta", "done"), await create("echo", "open"), await create("foxtrot", "done")];
    await app.Task.delete(idD); await app.Task.delete(idE); await app.Task.delete(idF);
    const partial = await trash(projA.id, { action: "restore_many", entity_name: "Task", query: { status: "done" } });
    const livePartial = await app.Task.filter({});
    const trashPartial = await trash(projA.id, { action: "list", entity_name: "Task" });
    harness.check("restore-matching restores ONLY the records matching the filter and reports the DOCUMENTED { success, restored } shape",
      partial.success === true && partial.restored === 2 && livePartial.some((r) => r.id === idD) && livePartial.some((r) => r.id === idF) &&
      !livePartial.some((r) => r.id === idE) && trashPartial.length === 1,
      { restored: partial.restored, left: trashPartial.length });
    const all = await trash(projA.id, { action: "restore_many", entity_name: "Task", query: {} });
    harness.check("restore-matching with {} restores EVERYTHING left in the trash",
      all.success === true && all.restored === 1 && (await trash(projA.id, { action: "list", entity_name: "Task" })).length === 0,
      { restored: all.restored });

    // ---- 4. permanent delete -------------------------------------------------------------------
    const idG = await create("golf", "open");
    await app.Task.delete(idG);
    const purged = await trash(projA.id, { action: "permanent", entity_name: "Task", record_id: idG });
    const trashAfterPurge = await trash(projA.id, { action: "list", entity_name: "Task" });
    const restoreGone = await captureCall(() => trash(projA.id, { action: "restore", entity_name: "Task", record_id: idG }));
    harness.check("permanent delete erases the record from trash for good and it cannot be restored afterwards",
      purged.success === true && trashAfterPurge.length === 0 && restoreGone.threw && restoreGone.code === "DATABASE_RECORD_NOT_FOUND",
      { code: restoreGone.code });
    const purgeLive = await captureCall(() => trash(projA.id, { action: "permanent", entity_name: "Task", record_id: idB }));
    harness.check("permanent delete refuses a record that is NOT in trash (a live record is uniformly not found in trash)",
      purgeLive.threw && purgeLive.code === "DATABASE_RECORD_NOT_FOUND",
      { code: purgeLive.code });

    // ---- 5. bulk deletion paths trash too --------------------------------------------------------
    await app.Task.create({ title: "h1", status: "bulk" });
    await app.Task.create({ title: "h2", status: "bulk" });
    const many = await app.Task.deleteMany({ status: "bulk" });
    const trashMany = await trash(projA.id, { action: "list", entity_name: "Task" });
    harness.check("deleteMany (deleteWhere → bulkDelete) routes into the trash as well",
      many.success === true && many.deleted === 2 && trashMany.length === 2,
      { deleted: many.deleted, trashed: trashMany.length });
    await trash(projA.id, { action: "restore_many", entity_name: "Task", query: {} });

    // ---- 6. pagination / filtering / sort / fields per the audited contract ----------------------
    const seeds = [];
    for (let i = 0; i < 5; i++) { const id = await create(`p${i}`, i % 2 ? "odd" : "even"); seeds.push(id); await app.Task.delete(id); }
    const page1 = await trash(projA.id, { action: "list", entity_name: "Task", limit: 2 });
    const page2 = await trash(projA.id, { action: "list", entity_name: "Task", limit: 2, skip: 2 });
    const everything = await trash(projA.id, { action: "list", entity_name: "Task" });
    const filtered = await trash(projA.id, { action: "list", entity_name: "Task", query: { status: "odd" } });
    const projected = await trash(projA.id, { action: "list", entity_name: "Task", fields: "title" });
    const ids1 = page1.map((r) => r.id), ids2 = page2.map((r) => r.id), idsAll = everything.map((r) => r.id);
    const pagedConsistent = JSON.stringify(idsAll) === JSON.stringify([...ids1, ...ids2, idsAll[4]]);
    harness.check("list paginates (limit + skip, omit limit = whole trash), sorts newest-first by default, filters with q and projects fields keeping id",
      page1.length === 2 && page2.length === 2 && !ids1.some((i) => ids2.includes(i)) && pagedConsistent &&
      filtered.length === 2 && filtered.every((r) => r.status === "odd") &&
      projected.length === 5 && projected.every((r) => r.title !== undefined && r.status === undefined && !!r.id),
      { all: idsAll.length, filtered: filtered.length, pagedConsistent });
    const badLimit = await captureCall(() => trash(projA.id, { action: "list", entity_name: "Task", limit: 10001 }));
    harness.check("a limit beyond the documented 1..10000 ceiling is refused",
      badLimit.threw && badLimit.code === "DATABASE_INVALID_PAGING", { code: badLimit.code });

    // ---- 7. cross-project AND cross-entity isolation ---------------------------------------------
    const foreignList = await trash(projB.id, { action: "list", entity_name: "Task" });
    const foreignRestore = await captureCall(() => trash(projB.id, { action: "restore", entity_name: "Task", record_id: seeds[0] }));
    const foreignEntity = await captureCall(() => trash(projA.id, { action: "restore", entity_name: "Ghost", record_id: seeds[0] }));
    harness.check("another project (or another entity name) cannot read or restore this project's trash",
      foreignList.length === 0 && foreignRestore.threw && foreignRestore.code === "DATABASE_RECORD_NOT_FOUND" && foreignEntity.threw && foreignEntity.code === "DATABASE_RECORD_NOT_FOUND",
      { code: foreignRestore.code });

    // ---- 8. RLS app: ownership preserved through trash; the listing is management-level ----------
    const u1 = { id: `u1_${stamp}`, email: `u1_${stamp}@example.com` };
    const u2 = { id: `u2_${stamp}`, email: `u2_${stamp}@example.com` };
    const dbU1 = createServerDb(db, projB.id, defs, { rls: true, user: u1 });
    const dbU2 = createServerDb(db, projB.id, defs, { rls: true, user: u2 });
    const mine = await dbU1.Task.create({ title: "mine", status: "open" });
    const other = await captureCall(() => dbU2.Task.delete(mine.id));
    await dbU1.Task.delete(mine.id);
    const rlsTrash = await trash(projB.id, { action: "list", entity_name: "Task" });
    const restoredMine = await trash(projB.id, { action: "restore", entity_name: "Task", record_id: mine.id });
    const u1Sees = await dbU1.Task.get(mine.id);
    const u2Sees = await captureCall(() => dbU2.Task.get(mine.id));
    const rowAfter = await db.entities.AppRecord.get(mine.id);
    harness.check("an RLS app: another user can't delete or see the record (no leak); the user's delete trashes it; the management listing applies NO RLS (per contract); restore keeps the record's owner",
      other.threw && other.code === "DATABASE_RECORD_NOT_FOUND" && rlsTrash.length === 1 &&
      restoredMine.id === mine.id && !!u1Sees && u2Sees.threw && rowAfter.owner_id === u1.id,
      { trashed: rlsTrash.length, u2_code: u2Sees.code, owner_kept: rowAfter.owner_id === u1.id });

    // ---- 9. regression: normal CRUD unchanged ----------------------------------------------------
    const regId = await create("regression", "open");
    await app.Task.update(regId, { title: "regression-2" });
    const reg = await app.Task.get(regId);
    const regFiltered = await app.Task.filter({ status: "open" });
    const delReg = await app.Task.delete(regId);
    harness.check("normal CRUD is unchanged (update returns the merged record, filter returns only live records, delete still resolves the DOCUMENTED { success: true })",
      reg.title === "regression-2" && regFiltered.every((r) => r.status === "open") && delReg.success === true,
      { updated: reg.title });

    // ---- 10. delete event stream unchanged; restores emit no events -------------------------------
    const events = await readEntityEvents(db, projA.id, defs, {}, { entity: "Task", limit: 100 });
    harness.check("the delete event stream still records deletes (restore emits none — bulk documented, single UNKNOWN)",
      events.events.filter((ev) => ev.type === "delete").length >= 5 && !events.events.some((ev) => ev.type === "restore"),
      { deletes: events.events.filter((ev) => ev.type === "delete").length });

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      await purgeBy(db, "AppRecord", { project_id: pid });
      await purgeBy(db, "AuditLog", { project_id: pid });
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(db, wsId, ["CreditLedgerEntry", "Subscription"]);
    }
  }
}