// Production declaration surface for project-scoped AppRelation (foreign-key) metadata.
//
// Modeled on appEntityRls: the BUILDER's per-project authoring endpoint for a NexusAI-native
// runtime annotation (referential integrity) that lives on top of Base44's plain ID-reference
// string fields. It changes ONLY AppRelation rows — no entity schema, no fields, no snapshot,
// no version, no AI tool contract, no Architecture extraction. Runtime enforcement (appData.ts
// via relations.ts) and Architecture consumption read AppRelation unchanged.
//
// Reuses ONLY existing contracts:
//   • loadAuthorizedProject — the EXISTING builder authorization path (project.read / project.write)
//   • validateRelationDef   — the EXISTING pure validator from relations.ts (the SAME gate the
//                              runtime enforcement engine accepts), so the UI can never persist a
//                              shape relations.ts would reject.
//   • canonical             — the EXISTING relation-to-FK normalizer, so field-placement checks
//                              match exactly what the enforcement engine enforces.
//   • AppRelation.{filter|create|update|delete} — the EXISTING persistence primitives.
//
// relations.ts (the enforcement engine) is not modified. AppRelation schema is preserved.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { validateRelationDef, canonical } from "../../shared/relations.ts";
import { reconcileArchitectureAfterMutation } from "../../shared/architectureReconcile.ts";

const publicRelation = (r) => ({
  id: r.id, name: r.name, from_entity: r.from_entity, from_field: r.from_field,
  to_entity: r.to_entity, type: r.type, on_delete: r.on_delete || "restrict", required: !!r.required,
});

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    if (!["list", "set", "delete"].includes(action)) {
      return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
    }
    const capability = action === "list" ? "project.read" : "project.write";
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, capability);
    const svc = base44.asServiceRole || base44;

    if (action === "list") {
      const rels = await svc.entities.AppRelation.filter({ project_id: project.id }, "name", 200);
      return Response.json({ relations: rels.map(publicRelation) });
    }

    if (action === "delete") {
      const name = String(body.name || "").trim();
      if (!name) return Response.json({ error: "name is required" }, { status: 400 });
      const rows = await svc.entities.AppRelation.filter({ project_id: project.id, name }, "name", 5);
      const row = rows[0];
      if (!row) return Response.json({ error: "Relation not found" }, { status: 404 });
      await svc.entities.AppRelation.delete(row.id);
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: "app_relation.deleted", resource: "AppRelation", resource_id: row.id, metadata: { name },
      }).catch(() => {});
      // Reconcile Architecture so belongs_to edges converge immediately. `user` authorized
      // project.write for this delete; best-effort — a failure never fails the relation delete.
      await reconcileArchitectureAfterMutation(base44, user, { project_id: project.id });
      return Response.json({ ok: true, deleted: name });
    }

    // action === "set": upsert one relation by name (project-scoped convergence).
    const rel = body.relation || body.relation_def;
    if (!rel || typeof rel !== "object") {
      return Response.json({ error: "relation is required" }, { status: 400 });
    }
    const def = {
      name: String(rel.name || "").trim(),
      from_entity: String(rel.from_entity || "").trim(),
      from_field: String(rel.from_field || "").trim(),
      to_entity: String(rel.to_entity || "").trim(),
      type: rel.type ? String(rel.type) : "many_to_one",
      on_delete: rel.on_delete ? String(rel.on_delete) : "restrict",
      required: !!rel.required,
    };
    if (!def.name) return Response.json({ error: "name is required" }, { status: 400 });

    // Load declared entities to reject dangling entity/field references — the SAME list the
    // runtime enforcement engine and Architecture extraction resolve against.
    const entities = await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 200);
    const entityNames = entities.map((e) => e.name);
    const check = validateRelationDef(def, entityNames);
    if (check.errors.length) {
      return Response.json({ error: check.errors.join("; ") }, { status: 400 });
    }

    // Field existence: the FK field lives on fkEntity per canonical() (many_to_one/one_to_one →
    // from_entity; one_to_many → to_entity). Matches exactly where the engine enforces it.
    const fk = canonical(def);
    const fkEntityRow = entities.find((e) => e.name === fk.fkEntity);
    const fields = (fkEntityRow && fkEntityRow.fields) || {};
    if (!Object.prototype.hasOwnProperty.call(fields, fk.fkField)) {
      return Response.json({ error: `from_field "${fk.fkField}" is not declared on entity "${fk.fkEntity}"` }, { status: 400 });
    }

    // Converge by name (create or update), project-scoped. No duplicate, no cross-project leak.
    const existing = await svc.entities.AppRelation.filter({ project_id: project.id, name: def.name }, "name", 5);
    const row = existing[0];
    const payload = {
      project_id: project.id,
      name: def.name,
      from_entity: def.from_entity,
      from_field: def.from_field,
      to_entity: def.to_entity,
      type: def.type,
      on_delete: def.on_delete,
      required: def.required,
    };
    let saved;
    let created = false;
    if (row) {
      await svc.entities.AppRelation.update(row.id, payload);
      saved = { ...row, ...payload };
    } else {
      saved = await svc.entities.AppRelation.create(payload);
      created = true;
    }
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: "app_relation.set", resource: "AppRelation", resource_id: saved.id,
      metadata: { name: def.name, created, type: def.type, from_entity: def.from_entity, to_entity: def.to_entity },
    }).catch(() => {});
    // Reconcile Architecture so belongs_to edges converge immediately. `user` authorized
    // project.write for this set; best-effort — a failure never fails the relation write.
    await reconcileArchitectureAfterMutation(base44, user, { project_id: project.id });
    return Response.json({ ok: true, relation: publicRelation(saved) });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}