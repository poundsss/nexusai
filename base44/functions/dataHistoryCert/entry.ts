// Focused certification for Data Version History / Backup & Restore (the completed audit's
// behavior target). Drives the REAL surface (dataVersionsSurface), the REAL write-path hooks
// (createServerDb + emitEntityEvent capture + restore edit-pause), the REAL job-queue executor
// and the REAL Entity Trash. Nothing is stubbed.
//
// Certified: action whitelist; info states (needs_upgrade / Elite 7 / Enterprise 30); automatic
// CRUD capture with burst dedupe and snapshot contents; free plan captures nothing; cursor-
// paginated list (order, shape, entity filter, from/to, cursor mismatch, >200 names); download
// (declared fields then built-ins, records verbatim); restore 202 + executor (ID preservation,
// exact field values, removed-field exclusion, post-point records to Entity Trash and back);
// undo restore; concurrent-restore skip; edit pause per entity and release; User exclusion
// (no capture + restore refusal); retention purge (7-day Elite purges, 8-day Enterprise
// survives); project isolation (download 404, status empty); unknown checkpoint 404.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { DEFAULT_PLANS } from "../../shared/billing.ts";
import { createServerDb, toItem } from "../../shared/appData.ts";
import { unpackJson } from "../../shared/blobStore.ts";
import { dataVersionsSurface, captureCheckpoint, executeRestoreBatch, DATA_VERSION_ACTIONS } from "../../shared/dataHistory.ts";
import { entityTrashSurface } from "../../shared/entityTrash.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [] };
  const projects = [];
  const surface = (input) => dataVersionsSurface(db, input);
  const mkProject = async (wsId, label) => {
    const p = await db.entities.Project.create({ workspace_id: wsId, name: `dhcert-${label}-${stamp}` });
    projects.push(p.id);
    return p;
  };
  const mkEntity = (pid, name, fields) => db.entities.AppEntity.create({ project_id: pid, name, fields });
  const cps = (pid, entity = null) =>
    db.entities.DataCheckpoint.filter(entity ? { project_id: pid, entity_name: entity } : { project_id: pid }, "created_date", 50);
  const live = (pid, entity) =>
    db.entities.AppRecord.filter({ project_id: pid, entity_name: entity }, "created_date", 50).then((r) => r.map(toItem));

  let projElite = null, projFree = null, projEnt = null, projR = null, projC = null;
  let A = null, ent = null;

  try {
    // Plan mirror rows for the tiers under test (only when absent).
    for (const code of ["free", "scale_monthly", "enterprise"]) {
      const existing = await db.entities.BillingPlan.filter({ code }, "name", 1);
      if (!existing.length) {
        const def = DEFAULT_PLANS.find((p) => p.code === code);
        if (def) await db.entities.BillingPlan.create(def).catch(() => {});
      }
    }

    A = await makeBillingWorkspace(db, created, `elite${stamp}`, { plan: { code: "scale_monthly" } });
    const free = await makeBillingWorkspace(db, created, `free${stamp}`, { plan: null });
    ent = await makeBillingWorkspace(db, created, `ent${stamp}`, { plan: { code: "enterprise" } });
    projElite = await mkProject(A.ws.id, "elite");
    projFree = await mkProject(free.ws.id, "free");
    projEnt = await mkProject(ent.ws.id, "ent");
    projR = await mkProject(A.ws.id, "restore");
    projC = await mkProject(A.ws.id, "conc");
    await mkEntity(projElite.id, "Invoice", { amount: { type: "number" }, status: { type: "string" } });
    await mkEntity(projFree.id, "Invoice", { amount: { type: "number" } });
    await mkEntity(projEnt.id, "Invoice", {});
    const entInvoice = await mkEntity(projR.id, "Invoice", { amount: { type: "number" }, status: { type: "string" } });
    await mkEntity(projC.id, "Invoice", { amount: { type: "number" } });
    await mkEntity(projC.id, "Memo", { text: { type: "string" } });
    await mkEntity(projC.id, "User", { name: { type: "string" } });

    // ---- 1. whitelist ---------------------------------------------------------------------
    harness.check("the surface exposes exactly the six documented actions",
      JSON.stringify(DATA_VERSION_ACTIONS) === JSON.stringify(["info", "list", "download", "restore", "status", "undo"]),
      JSON.stringify(DATA_VERSION_ACTIONS));

    // ---- 2. versions/info: plan states ----------------------------------------------------
    const infoFree = await surface({ action: "info", project_id: projFree.id, workspace_id: free.ws.id });
    const infoElite = await surface({ action: "info", project_id: projElite.id, workspace_id: A.ws.id });
    const infoEnt = await surface({ action: "info", project_id: projEnt.id, workspace_id: ent.ws.id });
    harness.check("info: free needs_upgrade; Elite enabled 7 days; Enterprise 30 days",
      infoFree.state === "needs_upgrade" && infoFree.retention_days === null && infoFree.history_available_since === null &&
      infoElite.state === "enabled" && infoElite.retention_days === 7 && infoElite.history_available_since === null &&
      infoEnt.state === "enabled" && infoEnt.retention_days === 30,
      JSON.stringify({ free: infoFree.state, elite: infoElite.retention_days, ent: infoEnt.retention_days }));

    // ---- 3. automatic capture (Elite) + burst dedupe --------------------------------------
    const appDb = createServerDb(db, projElite.id, [{ name: "Invoice", fields: { amount: { type: "number" }, status: { type: "string" } } }]);
    const a1 = await appDb.Invoice.create({ amount: 1, status: "draft" });
    await appDb.Invoice.create({ amount: 2, status: "draft" }); // same burst → deduped
    await sleep(1700);
    await appDb.Invoice.update(a1.id, { amount: 10 });
    const eliteCps = await cps(projElite.id, "Invoice");
    const newest = eliteCps[eliteCps.length - 1];
    const snap = newest ? await unpackJson(newest.snapshot_url) : null;
    harness.check("CRUD writes capture automatic crud checkpoints (burst produces one; snapshot exact)",
      eliteCps.length === 2 && eliteCps.every((c) => c.trigger_type === "crud") && newest.record_count === 2 &&
      newest.fields.join(",") === "amount,status" &&
      snap && snap.records.length === 2 && snap.records.find((r) => r.id === a1.id).data.amount === 10,
      JSON.stringify({ checkpoints: eliteCps.length, fields: newest ? newest.fields.join(",") : null, records: snap ? snap.records.length : 0 }));

    // ---- 4. free plan captures nothing ----------------------------------------------------
    const appDbFree = createServerDb(db, projFree.id, [{ name: "Invoice", fields: { amount: { type: "number" } } }]);
    await appDbFree.Invoice.create({ amount: 1 });
    harness.check("a plan without backups captures no checkpoints",
      (await cps(projFree.id)).length === 0, {});

    // ---- 5. restore scenario: prepare a checkpoint and post-point damage ------------------
    const appDbR = createServerDb(db, projR.id, [{ name: "Invoice", fields: { amount: { type: "number" }, status: { type: "string" } } }]);
    const r1 = await appDbR.Invoice.create({ amount: 1, status: "draft" });
    const r2 = await appDbR.Invoice.create({ amount: 2, status: "draft" });
    await sleep(1700);
    await appDbR.Invoice.update(r2.id, { amount: 2 }); // touch → capture holding BOTH records
    const cpA = (await cps(projR.id, "Invoice")).find((c) => c.record_count === 2);
    await sleep(1700);
    const r3 = await appDbR.Invoice.create({ amount: 3, status: "draft" }); // post-point record
    await appDbR.Invoice.update(r1.id, { amount: 99 });                     // post-point edit
    await appDbR.Invoice.delete(r2.id);                                     // post-point delete → trash
    await db.entities.AppEntity.update(entInvoice.id, { fields: { amount: { type: "number" }, status: { type: "string" }, b: { type: "number" } } });
    const appDbR2 = createServerDb(db, projR.id, [{ name: "Invoice", fields: { amount: { type: "number" }, status: { type: "string" }, b: { type: "number" } } }]);
    await appDbR2.Invoice.update(r1.id, { b: 5 }); // a field the checkpoint does not know

    // ---- 6. download ----------------------------------------------------------------------
    const dl = await surface({ action: "download", project_id: projR.id, entity_name: "Invoice", checkpoint_id: cpA.id });
    const byId = new Map(dl.records.map((r) => [r.id, r]));
    harness.check("download: declared fields then built-ins, records verbatim",
      JSON.stringify(dl.fields) === JSON.stringify(["amount", "status", "id", "created_date", "updated_date", "created_by_id"]) &&
      dl.records.length === 2 && byId.get(r1.id).amount === 1 && byId.get(r1.id).status === "draft" && byId.get(r2.id).amount === 2,
      { fields: dl.fields.join(","), records: dl.records.length });

    // ---- 7. restore: 202 + executor semantics ---------------------------------------------
    const res = await surface({ action: "restore", project_id: projR.id, workspace_id: A.ws.id, checkpoint_id: cpA.id, entity_names: ["Invoice"] });
    harness.check("restore returns the 202 shape before any data moves",
      !!res.batch_id && res.launched.length === 1 && res.launched[0].entity_name === "Invoice" && !!res.launched[0].operation_id && res.skipped_entities.length === 0,
      { launched: res.launched.length, skipped: res.skipped_entities.length });
    await executeRestoreBatch(db, res.batch_id);
    const status = await surface({ action: "status", project_id: projR.id, batch_id: res.batch_id });
    const after = await live(projR.id, "Invoice");
    const r3Row = await db.entities.AppRecord.get(r3.id).catch(() => null);
    harness.check("restore: IDs preserved, values exact, post-point record trashed, new field untouched",
      status.restore_to === cpA.data_as_of && !!status.undo_checkpoint_id && !!status.operations[0].pre_restore_checkpoint_id &&
      status.operations[0].counts.deleted === 1 && status.operations[0].counts.reinserted === 1 && status.operations[0].counts.reverted === 1 &&
      after.find((r) => r.id === r1.id).amount === 1 && after.find((r) => r.id === r1.id).b === 5 &&
      after.find((r) => r.id === r2.id).amount === 2 && !after.some((r) => r.id === r3.id) &&
      r3Row && r3Row.entity_name === "TRASH:Invoice" && !!r3Row.trashed_at,
      JSON.stringify({ counts: status.operations[0].counts, undo: status.undo_checkpoint_id, pre: status.operations[0].pre_restore_checkpoint_id, r3: r3Row?.entity_name }));

    // ---- 8. post-point record is trash-recoverable ----------------------------------------
    const back = await entityTrashSurface(db, { project_id: projR.id, action: "restore", entity_name: "Invoice", record_id: r3.id });
    harness.check("a record the restore moved to trash comes back through Entity Trash with its ID",
      back.id === r3.id && back.amount === 3, JSON.stringify({ id: back.id, wanted: r3.id, amount: back.amount }));

    // ---- 9. undo restore ------------------------------------------------------------------
    const undoRes = await surface({ action: "undo", project_id: projR.id, workspace_id: A.ws.id, batch_id: res.batch_id });
    harness.check("undo launches a batch from the pre-restore checkpoint",
      !!undoRes.batch_id && undoRes.launched.length === 1 && undoRes.launched[0].entity_name === "Invoice",
      { launched: undoRes.launched.length });
    await executeRestoreBatch(db, undoRes.batch_id);
    const afterUndo = await live(projR.id, "Invoice");
    const r2Trash = await db.entities.AppRecord.get(r2.id).catch(() => null);
    harness.check("undo puts the restore back: pre-restore values, r3 alive, r2 trashed again",
      afterUndo.find((r) => r.id === r1.id).amount === 99 && afterUndo.find((r) => r.id === r1.id).b === 5 &&
      afterUndo.some((r) => r.id === r3.id && r.amount === 3) && !afterUndo.some((r) => r.id === r2.id) &&
      r2Trash && r2Trash.entity_name === "TRASH:Invoice",
      JSON.stringify({ r1: afterUndo.find((r) => r.id === r1.id)?.amount, b: afterUndo.find((r) => r.id === r1.id)?.b, r2: r2Trash ? r2Trash.entity_name : null, r3: afterUndo.some((r) => r.id === r3.id) }));

    // ---- 10. fields removed from the current schema are NOT restored -----------------------
    await db.entities.AppEntity.update(entInvoice.id, { fields: { amount: { type: "number" }, b: { type: "number" } } });
    const r1Row = await db.entities.AppRecord.get(r1.id);
    await db.entities.AppRecord.update(r1.id, { data: { amount: 50, b: 5 } }); // strip the removed field's values, as a migration would
    await sleep(1700);
    await appDbR2.Invoice.update(r1.id, { amount: 50 }); // touch → capture (schema without status)
    const res2 = await surface({ action: "restore", project_id: projR.id, workspace_id: A.ws.id, checkpoint_id: cpA.id, entity_names: ["Invoice"] });
    await executeRestoreBatch(db, res2.batch_id);
    const after2 = await live(projR.id, "Invoice");
    const r1After = after2.find((r) => r.id === r1.id);
    harness.check("a field removed from the current schema is not restored; the rest come back exactly",
      r1After.amount === 1 && r1After.b === 5 && r1After.status === undefined,
      JSON.stringify({ amount: r1After ? r1After.amount : null, b: r1After ? r1After.b : null, status: r1After ? r1After.status : null }));

    // ---- 11. concurrent restore + edit pause -----------------------------------------------
    const appDbC = createServerDb(db, projC.id, [
      { name: "Invoice", fields: { amount: { type: "number" } } },
      { name: "Memo", fields: { text: { type: "string" } } },
      { name: "User", fields: { name: { type: "string" } } },
    ]);
    const c1 = await appDbC.Invoice.create({ amount: 1 });
    await sleep(1700);
    await appDbC.Invoice.update(c1.id, { amount: 1 }); // touch → checkpoint
    const cpC = (await cps(projC.id, "Invoice"))[0];
    const p1 = await surface({ action: "restore", project_id: projC.id, workspace_id: A.ws.id, checkpoint_id: cpC.id, entity_names: ["Invoice"] });
    const p2 = await surface({ action: "restore", project_id: projC.id, workspace_id: A.ws.id, checkpoint_id: cpC.id, entity_names: ["Invoice"] });
    harness.check("a second restore of a running entity is skipped, not queued",
      p2.batch_id && p2.launched.length === 0 && JSON.stringify(p2.skipped_entities) === JSON.stringify(["Invoice"]),
      JSON.stringify({ skipped: p2.skipped_entities, launched: p2.launched.length }));
    const paused = await captureCall(() => appDbC.Invoice.create({ amount: 5 }));
    const memoOk = await appDbC.Memo.create({ text: "unaffected" });
    harness.check("editing the restoring entity is paused; other entities are not",
      paused.threw && paused.code === "DATABASE_RESTORE_PAUSED" && memoOk.text === "unaffected",
      JSON.stringify({ paused: paused.code, memo: memoOk ? memoOk.text : null }));
    await executeRestoreBatch(db, p1.batch_id);
    const released = await appDbC.Invoice.create({ amount: 5 });
    harness.check("the pause releases once the restore finishes",
      released.amount === 5, {});

    // ---- 12. User exclusion ----------------------------------------------------------------
    await appDbC.User.create({ name: "u" });
    const userCps = await cps(projC.id, "User");
    const userRestore = await captureCall(() => surface({ action: "restore", project_id: projC.id, workspace_id: A.ws.id, checkpoint_id: cpC.id, entity_names: ["User"] }));
    harness.check("User is outside data history: no checkpoints, restore refused",
      userCps.length === 0 && userRestore.threw && userRestore.code === "DATA_HISTORY_ENTITY_EXCLUDED",
      JSON.stringify({ checkpoints: userCps.length, code: userRestore.code }));

    // ---- 13. retention purge ---------------------------------------------------------------
    await db.entities.DataCheckpoint.update(cpC.id, { data_as_of: new Date(Date.now() - 8 * 86400000).toISOString() });
    await sleep(1700);
    await appDbC.Invoice.update(c1.id, { amount: 6 }); // capture → purge past Elite's 7 days
    const afterPurge = await cps(projC.id, "Invoice");
    const entCp = await captureCheckpoint(db, projEnt.id, ent.ws.id, "Invoice");
    await db.entities.DataCheckpoint.update(entCp.id, { data_as_of: new Date(Date.now() - 8 * 86400000).toISOString() });
    await captureCheckpoint(db, projEnt.id, ent.ws.id, "Invoice"); // 30-day retention: survives
    const entAfter = await cps(projEnt.id, "Invoice");
    harness.check("retention: Elite purges an 8-day-old checkpoint, Enterprise keeps it",
      !afterPurge.some((c) => c.id === cpC.id) && afterPurge.length > 0 && entAfter.some((c) => c.id === entCp.id),
      JSON.stringify({ elite_n: afterPurge.length, ent_n: entAfter.length }));

    // ---- 14. list: cursor pagination + filters --------------------------------------------
    const all = await cps(projR.id, "Invoice");
    const page1 = await surface({ action: "list", project_id: projR.id, limit: 1 });
    const page2 = await surface({ action: "list", project_id: projR.id, limit: 1, cursor: page1.next_cursor });
    const shape = Object.keys(page1.items[0] || {}).sort().join(",");
    const memoList = await surface({ action: "list", project_id: projR.id, entity_names: ["Memo"], limit: 20 });
    const toFiltered = await surface({ action: "list", project_id: projR.id, to: all[all.length - 2].data_as_of, limit: 50 });
    const mismatch = await captureCall(() => surface({ action: "list", project_id: projR.id, entity_names: ["Memo"], cursor: page1.next_cursor, limit: 1 }));
    const tooMany = await captureCall(() => surface({ action: "list", project_id: projR.id, entity_names: Array(201).fill("X"), limit: 1 }));
    harness.check("list: newest-first cursor pages, documented shape, filters and refusals",
      page1.items.length === 1 && page2.items.length === 1 &&
      page1.items[0].checkpoint_id === all[all.length - 1].id && page2.items[0].checkpoint_id === all[all.length - 2].id &&
      shape === "checkpoint_id,data_as_of,entity_name,trigger_type" && page1.items[0].trigger_type === "crud" &&
      memoList.items.length === 0 && toFiltered.items.length === all.length - 2 &&
      toFiltered.items.every((c) => c.data_as_of < all[all.length - 2].data_as_of) &&
      mismatch.threw && mismatch.code === "DATA_HISTORY_CURSOR_MISMATCH" && tooMany.threw && tooMany.code === "DATA_HISTORY_INVALID",
      JSON.stringify({ p1: page1.items.length, p2: page2.items.length, shape, total: all.length, to: toFiltered.items.length, mismatch: mismatch.code, tooMany: tooMany.code }));

    // ---- 15. isolation + unknown checkpoint -----------------------------------------------
    const leaked = await captureCall(() => surface({ action: "download", project_id: projC.id, entity_name: "Invoice", checkpoint_id: cpA.id }));
    const foreignStatus = await surface({ action: "status", project_id: projC.id, batch_id: res.batch_id });
    const unknownCp = await captureCall(() => surface({ action: "restore", project_id: projR.id, workspace_id: A.ws.id, checkpoint_id: "nonexistent", entity_names: ["Invoice"] }));
    harness.check("another project's checkpoint is 404, a foreign batch reports empty, unknown checkpoint 404",
      leaked.threw && leaked.status === 404 && leaked.code === "DATA_HISTORY_CHECKPOINT_NOT_FOUND" &&
      foreignStatus.operations.length === 0 && foreignStatus.restore_to === null &&
      unknownCp.threw && unknownCp.status === 404 && unknownCp.code === "DATA_HISTORY_CHECKPOINT_NOT_FOUND",
      JSON.stringify({ leaked: leaked.code, foreign: foreignStatus.operations.length, unknown: unknownCp.code }));

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    for (const pid of projects) {
      await purgeBy(db, "DataCheckpoint", { project_id: pid });
      await purgeBy(db, "DataRestoreBatch", { project_id: pid });
      await purgeBy(db, "DataRestoreOperation", { project_id: pid });
      await purgeBy(db, "AppRecord", { project_id: pid });
      await purgeBy(db, "AppEntity", { project_id: pid });
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(db, wsId, ["CreditLedgerEntry", "Subscription"]);
    }
  }
}