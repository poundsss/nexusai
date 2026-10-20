// Targeted Data-surface certification (Agent → More → Data parity): exercises the certified
// contracts the new record manager uses — mcpQueryEntityRecords (project.read), mcpMutateEntityRecord
// (project.write, schema-validated), getEntitySchema, and the Entity Trash (delete → trash,
// list, restore). DISPOSABLE synthetic project/entity/records only, cleaned up after.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { queryEntityRecords, mutateEntityRecord, getEntitySchema } from "../../shared/mcpServerTools.ts";
import { entityTrashSurface } from "../../shared/entityTrash.ts";

export const config = { public: true };

const ENTITY = "CertNote";

async function run(base44) {
  const svc = base44.asServiceRole || base44;
  const user = await base44.auth.me();
  if (!user) return { all_passed: false, results: [{ name: "auth", ok: false, detail: "cert requires an authenticated builder session" }] };
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail: detail || null });

  const wsPage = await svc.entities.Workspace.filter({ owner_id: user.id }, "-created_date", 1);
  const ws = (wsPage.items || wsPage || [])[0];
  if (!ws) return { all_passed: false, results: [{ name: "workspace", ok: false, detail: "no workspace for the session user" }] };

  // Disposable synthetic project + entity + seed records
  const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "__cert_data_surface__" });
  try {
    const entity = await svc.entities.AppEntity.create({
      project_id: project.id, name: ENTITY,
      fields: {
        title: { type: "string", required: true },
        status: { type: "string", enum: ["open", "done"] },
        score: { type: "number" },
      },
    });
    check("entity_listing", entity?.name === ENTITY && !!entity.fields?.title);

    // 2. authorized table access + schema view
    const schema = await getEntitySchema(base44, user, { project_id: project.id, entity: ENTITY });
    check("schema_view", schema?.entity === ENTITY && !!schema?.fields?.title);

    // 7. Add Item (certified, schema-validated create)
    const a = await mutateEntityRecord(base44, user, { project_id: project.id, entity: ENTITY, operation: "create", data: { title: "alpha record", status: "open", score: 1 } });
    const b = await mutateEntityRecord(base44, user, { project_id: project.id, entity: ENTITY, operation: "create", data: { title: "beta record", status: "done", score: 2 } });
    check("add_item", !!a?.record?.id && !!b?.record?.id);
    let invalidRefused = false;
    try { await mutateEntityRecord(base44, user, { project_id: project.id, entity: ENTITY, operation: "create", data: { score: 5 } }); }
    catch { invalidRefused = true; }
    check("schema_validation", invalidRefused, "missing required title refused");

    // 4. search ($or/$contains over data fields)
    const search = await queryEntityRecords(base44, user, { project_id: project.id, entity: ENTITY, filter: { $or: [{ title: { $contains: "alpha" } }] }, limit: 50 });
    check("search", search?.count === 1 && search.records[0].title === "alpha record", `matches: ${search?.count}`);

    // 5. filters (equality on a data field)
    const filtered = await queryEntityRecords(base44, user, { project_id: project.id, entity: ENTITY, filter: { status: "open" }, limit: 50 });
    check("filters", filtered?.count === 1 && filtered.records[0].title === "alpha record", `matches: ${filtered?.count}`);

    // 8. inline edit (certified, schema-validated update)
    await mutateEntityRecord(base44, user, { project_id: project.id, entity: ENTITY, operation: "update", record_id: b.record.id, data: { status: "open", score: 5 } });

    // 9. persistence after reload (independent read)
    const after = await queryEntityRecords(base44, user, { project_id: project.id, entity: ENTITY, filter: {}, limit: 50 });
    const beta = (after?.records || []).find((r) => r.id === b.record.id);
    check("persistence", after?.count === 2 && beta?.score === 5 && beta?.status === "open", `records: ${after?.count}`);

    // 3. unauthorized / cross-workspace access → fail-closed
    let readStatus = 0; let writeStatus = 0;
    try { await queryEntityRecords(base44, user, { project_id: "cert-nonexistent-project", entity: ENTITY }); }
    catch (e) { readStatus = e.status || 0; }
    try { await mutateEntityRecord(base44, user, { project_id: "cert-nonexistent-project", entity: ENTITY, operation: "create", data: {} }); }
    catch (e) { writeStatus = e.status || 0; }
    check("authorization_fail_closed", readStatus === 404 && writeStatus === 404, `read ${readStatus}, write ${writeStatus}`);

    // 12/13. Delete All → trash; Recently Deleted lists what was trashed
    const live = await queryEntityRecords(base44, user, { project_id: project.id, entity: ENTITY, filter: {}, limit: 100 });
    for (const r of live.records) {
      await entityTrashSurface(svc, { action: "delete", project_id: project.id, entity_name: ENTITY, record_id: r.id });
    }
    const liveAfter = await queryEntityRecords(base44, user, { project_id: project.id, entity: ENTITY, filter: {}, limit: 100 });
    const trash = await entityTrashSurface(svc, { action: "list", project_id: project.id, entity_name: ENTITY });
    check("delete_all_trash", liveAfter?.count === 0 && (trash?.length || 0) === 2, `live ${liveAfter?.count}, trashed ${trash?.length}`);

    // 13/14. Recently Deleted carries deleted_date; restore brings the record back verbatim
    const stamped = (trash || []).every((t) => !!t.deleted_date);
    const restored = await entityTrashSurface(svc, { action: "restore", project_id: project.id, entity_name: ENTITY, record_id: a.record.id });
    const afterRestore = await queryEntityRecords(base44, user, { project_id: project.id, entity: ENTITY, filter: {}, limit: 100 });
    check("recently_deleted", stamped, `all rows carry deleted_date`);
    check("restore", restored?.id === a.record.id && restored?.title === "alpha record" && afterRestore?.count === 1, `restored id matches: ${restored?.id === a.record.id}`);
  } finally {
    // Cleanup: every disposable record (live + trash rows), the entity and the project
    const rows = await svc.entities.AppRecord.filter({ project_id: project.id }, "created_date", 1000);
    for (const r of rows) await svc.entities.AppRecord.delete(r.id).catch(() => {});
    await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 200)
      .then((page) => Promise.all((page.items || []).map((e) => svc.entities.AppEntity.delete(e.id)))).catch(() => {});
    await svc.entities.Project.delete(project.id).catch(() => {});
    results.push({ name: "cleanup", ok: true, detail: "synthetic project/entity/records removed" });
  }

  return { all_passed: results.every((r) => r.ok), results };
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    return Response.json(await run(base44));
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "CERT_ERROR" }, { status: 500 });
  }
}