// G4: the BUILDER's per-entity RLS authoring endpoint. The UI persistence path for the Entity
// Permissions panel. It changes ONLY `AppEntity.rls` — no fields, no schema, no evaluator.
//
// Reuses ONLY existing contracts:
//   • loadAuthorizedProject  — the EXISTING builder authorization path (project.read / project.write)
//   • validateRlsBlock       — the EXISTING shape-only validator from base44Layout.ts (the SAME
//                               gate the AI tool path uses), so the UI can never write a shape the
//                               evaluator would not already accept.
//   • AppEntity.update       — the EXISTING persistence primitive (the same call commitJournal /
//                               persistence.ts make). The entity FILE is reconciled by the build
//                               pipeline from state; this endpoint updates the runtime row only,
//                               exactly as the existing DB-only persistence paths do.
//
// `rls.ts` (the evaluator) is not imported and not modified. No new permission model is created.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { validateRlsBlock } from "../../shared/base44Layout.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "get");
    const capability = action === "get" ? "project.read" : "project.write";
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, capability);
    const svc = base44.asServiceRole || base44;

    const name = String(body.entity_name || "");
    if (!name) return Response.json({ error: "entity_name is required" }, { status: 400 });
    const rows = await svc.entities.AppEntity.filter({ project_id: project.id, name }, "name", 5);
    const row = rows[0];
    if (!row) return Response.json({ error: "Entity not found" }, { status: 404 });

    if (action === "get") {
      return Response.json({ rls: row.rls ?? null });
    }
    if (action !== "set") return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });

    // `undefined` (UI says "clear all") normalizes to null; validateRlsBlock(null) ⇒ ok, rls undefined.
    const check = validateRlsBlock(body.rls === undefined ? null : body.rls);
    if (!check.ok) return Response.json({ error: `rls ${check.error}` }, { status: 400 });
    const rls = check.rls ?? null;

    // Persist ONLY the rls field. Fields, name and project_id are untouched on this path.
    await svc.entities.AppEntity.update(row.id, { rls });
    await audit(svc, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "app_entity.rls_set", resource: "AppEntity", resource_id: row.id, metadata: { entity: name } }).catch(() => {});
    return Response.json({ ok: true, rls: rls || null });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}