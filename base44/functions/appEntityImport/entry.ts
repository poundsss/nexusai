// Builder-side Data → Import CSV. The ONLY new thing here is the builder-authorized entry point;
// every semantic is reused unchanged:
//   • loadAuthorizedProject  — EXISTING builder authz (project.write)
//   • loadProjectState       — EXISTING entity registry (the {id,name,fields,rls?} shape
//                              createServerDb consumes)
//   • createServerDb         — EXISTING server DB accessor (rls:false, user:null ⇒ the SAME
//                              write path an anonymous runtime app uses; no end-user owner stamp)
//   • importEntitiesIntoDb   — EXISTING RFC-4180 parser + validation + bulkCreate. New rows ONLY,
//                              no upsert/update/overwrite, fail-fast whole on parse/validation
//                              error, existing 500-row / 5MB limits.
//
// Nothing in appImport.ts, appData.ts, the RLS evaluator, AppRecord schema, or the runtime
// import behavior is modified.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, loadProjectState, audit } from "../../shared/authz.ts";
import { createServerDb } from "../../shared/appData.ts";
import { importEntitiesIntoDb } from "../../shared/appImport.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.write");
    const svc = base44.asServiceRole || base44;

    const name = String(body.entity_name || "");
    if (!name) return Response.json({ error: "entity_name is required" }, { status: 400 });

    const { entities } = await loadProjectState(svc, project.id);
    if (!entities.some((e) => e.name === name)) return Response.json({ error: "Entity not found" }, { status: 404 });

    // Builder seeding context: no app end-user, no RLS owner — identical to an anonymous
    // (rls-off) runtime write. importEntitiesIntoDb parses, validates, and bulkCreates new
    // rows only; existing validation, row/file limits, and fail-fast behavior are unchanged.
    const db = createServerDb(svc, project.id, entities, { rls: false, user: null });
    const result = await importEntitiesIntoDb(db, name, {
      filename: body.filename,
      content_type: body.content_type,
      content_base64: body.content_base64,
    });

    await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "app_entity.import_csv", resource: "AppEntity", resource_id: name, metadata: { entity: name, imported: result?.output?.imported ?? 0 } }).catch(() => {});
    return Response.json({ ok: true, result });
  } catch (error) {
    const isDbError = !!error.code && (String(error.code).startsWith("DATABASE_") || String(error.code).startsWith("IMPORT_"));
    const status = error.status || (isDbError ? 400 : 500);
    return Response.json({ error: error.message, code: error.code || null }, { status });
  }
}