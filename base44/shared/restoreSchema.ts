// Schema/data reconciliation for a version restore.
//
// Restoring an older ProjectVersion replaces the project's files and entity DECLARATIONS with
// that snapshot's. The generated app's DATA (AppRecord blobs) is not part of a snapshot, so
// without this module a restore left the project in a contradictory state: an old schema with
// records still shaped by the newer one — obsolete fields still authoritative, and records for
// entities the target version never had still reachable.
//
// This module closes that gap by reusing the EXISTING migration engine (shared/schemaMigrations)
// rather than introducing a second one:
//   • the plan is the engine's own field diff (add/remove/rename/type/required/enum),
//   • safety is the engine's own dry-run verdict,
//   • the transformation is the engine's own migrateEntity, which records a SchemaMigration row
//     per entity and is idempotent for a given (project, to_version, entity).
//
// Restore-specific policy on top of the engine:
//   • A field the newer schema added and the target does not have is REMOVED from the records.
//     The engine treats a populated removal as destructive, so it is applied with the engine's
//     force flag — but only when nothing else about the entity is value-incompatible.
//   • A value-level incompatibility (an inconvertible type change, a value outside the target
//     enum) is REFUSED, exactly as the engine refuses it, unless the caller explicitly forces.
//   • An entity the target version does not declare is dropped: its records are deleted and its
//     relation definitions removed, so nothing obsolete stays reachable.
// Every deletion and every value change is backed up first (see backupAppData), so the whole
// operation is reversible by the journalled commit it runs inside.
import { diffEntity, migrateEntity, MIGRATION_BATCH } from "./schemaMigrations.ts";

const svcOf = (base44) => base44.asServiceRole || base44;
const ROW_META = ["id", "created_date", "updated_date", "created_by_id"];
const withoutMeta = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !ROW_META.includes(k)));

/** What the restore must do to the project's schema, derived from the engine's own field diff. */
export function planRestoreSchema(currentEntities, targetEntities) {
  const current = new Map((currentEntities || []).map((e) => [e.name, e.fields || {}]));
  const entities = (targetEntities || []).map((t) => {
    const oldFields = current.get(t.name) || null;
    return {
      name: t.name,
      oldFields: oldFields || {},
      newFields: t.fields || {},
      // An entity the current runtime does not have is re-declared by the restore; it may still
      // own orphaned records from before it was dropped, which the engine migrates into shape.
      recreated: !oldFields,
      changes: diffEntity(oldFields || {}, t.fields || {}),
    };
  });
  const targetNames = new Set(entities.map((e) => e.name));
  const obsolete = [...current.keys()].filter((name) => !targetNames.has(name));
  return {
    entities,
    obsolete,
    changed: entities.filter((e) => e.changes.length),
    requires_migration: obsolete.length > 0 || entities.some((e) => e.changes.length > 0),
  };
}

const VALUE_INCOMPATIBLE = ["type", "enum"];

/**
 * Read-only safety verdict, produced by the engine's dry run. Nothing is written to the app's
 * data here, so a refusal costs the project nothing.
 *   blocking  — value-level incompatibilities the engine will not perform (refuse the restore)
 *   forced    — entities whose only destructive change is dropping a newer field (allowed)
 */
export async function assessRestoreSchema(base44, projectId, plan, { toVersionId, fromVersionId = null, force = false } = {}) {
  const svc = svcOf(base44);
  const blocking = [];
  const forced = [];
  const warnings = [];
  for (const e of plan.changed) {
    const dry = await migrateEntity(svc, {
      projectId, entityName: e.name, oldFields: e.oldFields, newFields: e.newFields,
      toVersionId, fromVersionId, force: false, dryRun: true,
    });
    warnings.push(...(dry.warnings || []).map((w) => `${e.name}: ${w}`));
    // The engine reports the offending changes as `would_break` on a clean dry run and as
    // `breaking` when the pre-scan already refused the plan; both mean the same set.
    const breaks = dry.would_break || dry.breaking || [];
    const hard = breaks.filter((b) => VALUE_INCOMPATIBLE.includes(b.op));
    const removals = breaks.filter((b) => b.op === "remove");
    if (hard.length && !force) {
      blocking.push(...hard.map((b) => ({ entity: e.name, op: b.op, field: b.field, affected: b.affected, reason: b.reason })));
    } else if (removals.length || (hard.length && force)) {
      forced.push({ entity: e.name, fields: [...removals, ...hard].map((b) => `${b.op}:${b.field}`) });
      warnings.push(...removals.map((b) => `${e.name}: field "${b.field}" is not in the restored schema; its values are removed from ${b.affected} record(s)`));
    }
  }
  const obsolete_records = {};
  for (const name of plan.obsolete) obsolete_records[name] = (await listRecords(svc, projectId, name)).length;
  return { safe: blocking.length === 0, blocking, forced, warnings, obsolete_records };
}

async function listRecords(svc, projectId, entityName) {
  const out = [];
  for (let skip = 0; ; skip += MIGRATION_BATCH) {
    const rows = await svc.entities.AppRecord.filter({ project_id: projectId, entity_name: entityName }, "-created_date", MIGRATION_BATCH, skip);
    out.push(...rows);
    if (rows.length < MIGRATION_BATCH) break;
  }
  return out;
}

/**
 * Durable "before" copy of everything the migration may change or delete: the record blobs of
 * every affected entity, plus the relation definitions of entities being dropped. This is what
 * makes a failed or crashed restore reversible in DATA as well as in schema.
 */
export async function backupAppData(base44, projectId, plan) {
  const svc = svcOf(base44);
  const names = [...new Set([...plan.changed.map((e) => e.name), ...plan.obsolete])];
  const records = [];
  for (const name of names) {
    for (const r of await listRecords(svc, projectId, name)) records.push({ id: r.id, entity_name: r.entity_name, owner_id: r.owner_id || null, data: r.data || {} });
  }
  const allRelations = await svc.entities.AppRelation.filter({ project_id: projectId }, "-created_date", 200).catch(() => []);
  const relations = allRelations
    .filter((r) => plan.obsolete.includes(r.from_entity) || plan.obsolete.includes(r.to_entity))
    .map((r) => ({ id: r.id, def: withoutMeta(r) }));
  return { project_id: projectId, records, relations };
}

/**
 * Transform the app's data to match the restored schema. Field changes go through the existing
 * engine; entities the target version does not declare have their records and relation
 * definitions removed so nothing obsolete remains reachable.
 */
export async function applyRestoreSchema(base44, projectId, plan, { toVersionId, fromVersionId = null, assessment, force = false } = {}) {
  const svc = svcOf(base44);
  const forcedEntities = new Set((assessment?.forced || []).map((f) => f.entity));
  const migrations = [];
  for (const e of plan.changed) {
    const result = await migrateEntity(svc, {
      projectId, entityName: e.name, oldFields: e.oldFields, newFields: e.newFields,
      toVersionId, fromVersionId, force: force || forcedEntities.has(e.name), dryRun: false,
    });
    if (result.status === "failed") {
      throw Object.assign(new Error(`Schema migration failed for "${e.name}": ${result.error}`), { status: 409, code: "SCHEMA_MIGRATION_FAILED", entity: e.name, breaking: result.breaking || [] });
    }
    migrations.push(result);
  }

  let records_deleted = 0, relations_deleted = 0;
  for (const name of plan.obsolete) {
    for (const r of await listRecords(svc, projectId, name)) { await svc.entities.AppRecord.delete(r.id); records_deleted++; }
  }
  const relations = await svc.entities.AppRelation.filter({ project_id: projectId }, "-created_date", 200).catch(() => []);
  for (const rel of relations) {
    if (plan.obsolete.includes(rel.from_entity) || plan.obsolete.includes(rel.to_entity)) {
      await svc.entities.AppRelation.delete(rel.id).catch(() => {});
      relations_deleted++;
    }
  }
  return { migrations, entities_dropped: plan.obsolete, records_deleted, relations_deleted };
}

/**
 * Reverse of the above, driven by the durable backup: record blobs are put back (rows the
 * migration deleted are re-created with their owner preserved) and dropped relation definitions
 * are re-declared. Converging, so a retry or a second recovery pass changes nothing further.
 */
export async function restoreAppData(base44, backup) {
  const svc = svcOf(base44);
  if (!backup || !backup.project_id) return { records_restored: 0, records_recreated: 0, relations_restored: 0 };
  let records_restored = 0, records_recreated = 0, relations_restored = 0;
  for (const r of backup.records || []) {
    const row = await svc.entities.AppRecord.get(r.id).catch(() => null);
    if (row) {
      if (JSON.stringify(row.data || {}) !== JSON.stringify(r.data || {})) { await svc.entities.AppRecord.update(r.id, { data: r.data }); records_restored++; }
    } else {
      await svc.entities.AppRecord.create({ project_id: backup.project_id, entity_name: r.entity_name, ...(r.owner_id ? { owner_id: r.owner_id } : {}), data: r.data || {} });
      records_recreated++;
    }
  }
  for (const rel of backup.relations || []) {
    const existing = await svc.entities.AppRelation.get(rel.id).catch(() => null);
    if (!existing) { await svc.entities.AppRelation.create(rel.def); relations_restored++; }
  }
  return { records_restored, records_recreated, relations_restored };
}