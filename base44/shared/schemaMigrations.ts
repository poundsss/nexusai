// P1 schema migrations for generated applications.
//
// Generated apps store rows in AppRecord (project_id + entity_name + a JSON `data`
// blob). When a project version changes an entity's field definitions, existing
// `data` blobs may no longer match the new schema. This module computes the field
// diff between two versions and migrates the data blobs IN PLACE, preserving every
// record and its RLS owner_id.
//
// DESIGN
//   • Project/version scoped: a migration always targets one project and one
//     to_version; the from_version supplies the old schema. No other project's data
//     is touched (every query is bound to project_id + entity_name).
//   • Idempotent: a SchemaMigration row with status "applied" for (project,
//     to_version, entity) gates re-runs; and every transform is itself converging
//     (add skips if present, rename skips if already renamed, type conversions
//     round-trip, remove skips if absent), so a forced re-run changes nothing.
//   • Never silently destroys data: destructive changes (remove a field that holds
//     data, an inconvertible type, an enum value outside the new set) ABORT before
//     any write unless `force` is set. With force, values are coerced and every
//     coercion is recorded as a warning in the SchemaMigration row.
//   • RLS/indexes/CRLS untouched: only the `data` blob is patched on update; the
//     top-level owner_id (the RLS index) is never read or written here.
//   • Bounded memory: records are streamed in batches (MIGRATION_BATCH); only one
//     batch + its pending updates are in memory at a time.
import { unpackSnapshot } from "./blobStore.ts";

export const MIGRATION_BATCH = 200;

// string/text/date are all string-shaped storage; converting between them never
// loses data, so they share a compatibility family.
function fam(t) {
  return ["string", "text", "date"].includes(t) ? "string" : t;
}

function sameEnum(a, b) {
  const A = a || [], B = b || [];
  return A.length === B.length && A.every((x) => B.includes(x));
}

// Compute the ordered field-change plan from old -> new schema. A rename is ONLY
// detected from an explicit `renamed_from` hint on the new field; without a hint a
// rename is indistinguishable from remove+add and is reported as such — we never
// move data under a guessed name.
export function diffEntity(oldFields, newFields) {
  const old = oldFields || {};
  const neu = newFields || {};
  const changes = [];
  const oldNames = new Set(Object.keys(old));
  const newNames = new Set(Object.keys(neu));
  const renamedFromOld = new Set();
  const renamedTo = new Set();
  for (const [name, f] of Object.entries(neu)) {
    const from = f && (f.renamed_from || f.renamedFrom);
    if (from && oldNames.has(from) && !newNames.has(from) && from !== name) {
      renamedFromOld.add(from);
      renamedTo.add(name);
      changes.push({ op: "rename", from, to: name, newField: f });
    }
  }
  for (const name of Object.keys(neu)) {
    if (renamedTo.has(name)) continue;
    if (!oldNames.has(name)) {
      changes.push({ op: "add", field: name, newField: neu[name] });
    } else {
      const o = old[name] || {}, n = neu[name] || {};
      if (fam(o.type) !== fam(n.type)) changes.push({ op: "type", field: name, oldType: o.type, newType: n.type, newField: n });
      if (!!o.required !== !!n.required) changes.push({ op: "required", field: name, oldRequired: !!o.required, newRequired: !!n.required, newField: n });
      if (!sameEnum(o.enum, n.enum)) changes.push({ op: "enum", field: name, oldEnum: o.enum || [], newEnum: n.enum || [], newField: n });
    }
  }
  for (const name of Object.keys(old)) {
    if (renamedFromOld.has(name)) continue;
    if (!newNames.has(name)) changes.push({ op: "remove", field: name, oldField: old[name] });
  }
  return changes;
}

// 'safe' never loses data and needs no value check. 'conditional' may lose or
// invalidate data and must be checked against existing values (and needs force).
function classify(change) {
  switch (change.op) {
    case "add":
      return change.newField && change.newField.required && change.newField.default === undefined ? "conditional" : "safe";
    case "rename":
    case "required":
      return "safe";
    case "enum": {
      const O = change.oldEnum || [], N = change.newEnum || [];
      return N.length >= O.length && O.every((x) => N.includes(x)) ? "safe" : "conditional";
    }
    case "type":
    case "remove":
      return "conditional";
    default:
      return "safe";
  }
}

// Convert a single value from oldType to newType. Returns {ok, value} or {ok:false, error}.
// Compatible families and widening to string always succeed; narrowing to number/boolean
// fails on non-convertible input (the caller decides force vs abort).
export function convertValue(value, oldType, newType) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (fam(oldType) === fam(newType)) return { ok: true, value };
  if (newType === "string" || newType === "text" || newType === "date") return { ok: true, value: String(value) };
  if (newType === "number") {
    const n = Number(value);
    if (value === "" || Number.isNaN(n)) return { ok: false, error: `cannot convert ${JSON.stringify(value)} to number` };
    return { ok: true, value: n };
  }
  if (newType === "boolean") {
    if (value === true || value === "true" || value === 1 || value === "1") return { ok: true, value: true };
    if (value === false || value === "false" || value === 0 || value === "0") return { ok: true, value: false };
    return { ok: false, error: `cannot convert ${JSON.stringify(value)} to boolean` };
  }
  return { ok: false, error: `unsupported conversion ${oldType} → ${newType}` };
}

// Read-only pre-scan: for every conditional change, check existing values and count
// how many records would break. Returns the breaking set (per change) so the caller
// can abort BEFORE any write when force is not set.
async function preScan(client, projectId, entityName, changes, force) {
  const conditional = changes.filter((c) => classify(c) === "conditional");
  const breakMap = new Map();
  const warnings = [];
  if (!conditional.length) return { breaking: [], warnings, scanned: 0 };
  let scanned = 0, skip = 0;
  while (true) {
    const rows = await client.entities.AppRecord.filter({ project_id: projectId, entity_name: entityName }, "-created_date", MIGRATION_BATCH, skip);
    if (!rows.length) break;
    for (const r of rows) {
      scanned++;
      const d = r.data || {};
      for (const c of conditional) {
        const key = c.op + ":" + c.field;
        if (c.op === "remove") {
          const v = d[c.field];
          if (v !== undefined && v !== null && v !== "" && !force) {
            if (!breakMap.has(key)) breakMap.set(key, { op: c.op, field: c.field, affected: 0, reason: `field "${c.field}" holds data in existing records; removal would destroy it` });
            breakMap.get(key).affected++;
          }
        } else if (c.op === "type") {
          if (c.field in d && d[c.field] !== null && d[c.field] !== undefined) {
            const conv = convertValue(d[c.field], c.oldType, c.newType);
            if (!conv.ok && !force) {
              if (!breakMap.has(key)) breakMap.set(key, { op: c.op, field: c.field, affected: 0, reason: conv.error });
              breakMap.get(key).affected++;
            }
          }
        } else if (c.op === "enum") {
          if (c.field in d && d[c.field] !== null && d[c.field] !== undefined && !(c.newEnum || []).includes(d[c.field]) && !force) {
            if (!breakMap.has(key)) breakMap.set(key, { op: c.op, field: c.field, affected: 0, reason: `value ${JSON.stringify(d[c.field])} is not in new enum [${(c.newEnum || []).join(", ")}]` });
            breakMap.get(key).affected++;
          }
        } else if (c.op === "add") {
          // add required without default: not breaking (data preserved), just warned.
          if (!(c.field in d) && c.newField && c.newField.required) warnings.push(`added required field "${c.field}" has no default; existing records left without it (will fail validation on next write)`);
        }
      }
    }
    skip += rows.length;
    if (rows.length < MIGRATION_BATCH) break;
  }
  return { breaking: [...breakMap.values()], warnings, scanned };
}

// Apply the change plan to one record's data blob. Converging/idempotent: a record
// already conformed to the new schema is returned with modified=false. `force`
// gates destructive coercions (remove, inconvertible type, invalid enum); when not
// forced, those are guaranteed absent by the pre-scan.
function applyToData(data, changes, force, warnings) {
  const out = { ...(data || {}) };
  let modified = false;
  for (const c of changes) {
    switch (c.op) {
      case "add": {
        if (!(c.field in out)) {
          if (c.newField && c.newField.default !== undefined) { out[c.field] = c.newField.default; modified = true; }
          // optional/no-default: leave absent (warned in pre-scan if required)
        }
        break;
      }
      case "rename": {
        if (c.from in out) {
          if (!(c.to in out)) out[c.to] = out[c.from];
          delete out[c.from];
          modified = true;
        }
        break;
      }
      case "required":
        break; // no data transform; validation enforces on next write
      case "type": {
        if (c.field in out && out[c.field] !== null && out[c.field] !== undefined) {
          const conv = convertValue(out[c.field], c.oldType, c.newType);
          if (conv.ok) {
            if (out[c.field] !== conv.value) { out[c.field] = conv.value; modified = true; }
          } else if (force) {
            warnings.push(`field "${c.field}": ${conv.error}; coerced to null`);
            out[c.field] = null; modified = true;
          }
        }
        break;
      }
      case "enum": {
        if (c.field in out && out[c.field] !== null && out[c.field] !== undefined && !(c.newEnum || []).includes(out[c.field])) {
          if (force) {
            const repl = (c.newEnum && c.newEnum[0]) ?? null;
            warnings.push(`field "${c.field}": value ${JSON.stringify(out[c.field])} not in new enum; coerced to ${JSON.stringify(repl)}`);
            out[c.field] = repl; modified = true;
          }
        }
        break;
      }
      case "remove": {
        if (c.field in out) { delete out[c.field]; modified = true; }
        break; // reached only when force, or when no record held the field (pre-scan)
      }
    }
  }
  return { data: out, modified };
}

// Migrate one entity's data blobs from oldFields to newFields. Returns a summary and
// records a SchemaMigration row (applied / failed / skipped / dry_run).
export async function migrateEntity(client, {
  projectId, entityName, oldFields, newFields, toVersionId, fromVersionId = null, force = false, dryRun = false,
}) {
  const started = Date.now();
  const changes = diffEntity(oldFields, newFields);

  // Idempotency gate: an applied migration for this (project, version, entity) means
  // the data already conforms — skip. force (or dryRun) bypasses the gate.
  if (!force && !dryRun) {
    const prior = await client.entities.SchemaMigration.filter(
      { project_id: projectId, to_version_id: toVersionId, entity_name: entityName, status: "applied" },
      "-created_date", 1,
    );
    if (prior.length) {
      return { entity: entityName, status: "skipped", reason: "already migrated to this version", changes, records_scanned: 0, records_modified: 0, duration_ms: Date.now() - started };
    }
  }

  const { breaking, warnings, scanned } = await preScan(client, projectId, entityName, changes, force);
  if (breaking.length && !force) {
    const error = breaking.map((b) => `${b.op}:${b.field} (${b.affected} record(s)) — ${b.reason}`).join("; ");
    await client.entities.SchemaMigration.create({
      project_id: projectId, entity_name: entityName, from_version_id: fromVersionId, to_version_id: toVersionId,
      changes, status: "failed", force, dry_run: false, records_scanned: scanned, warnings, error,
      applied_at: new Date().toISOString(), duration_ms: Date.now() - started,
    });
    return { entity: entityName, status: "failed", error, breaking, changes, duration_ms: Date.now() - started };
  }

  if (dryRun) {
    await client.entities.SchemaMigration.create({
      project_id: projectId, entity_name: entityName, from_version_id: fromVersionId, to_version_id: toVersionId,
      changes, status: "dry_run", force, dry_run: true, records_scanned: scanned, warnings,
      applied_at: new Date().toISOString(), duration_ms: Date.now() - started,
    });
    return { entity: entityName, status: "dry_run", changes, records_scanned: scanned, warnings, would_break: breaking, duration_ms: Date.now() - started };
  }

  // Apply pass: stream in batches, transform, and commit only changed records.
  // Only `data` is patched — owner_id (the RLS index) is never touched.
  let recordsScanned = 0, recordsModified = 0, recordsPreserved = 0, skip = 0;
  while (true) {
    const rows = await client.entities.AppRecord.filter({ project_id: projectId, entity_name: entityName }, "-created_date", MIGRATION_BATCH, skip);
    if (!rows.length) break;
    const updates = [];
    for (const r of rows) {
      recordsScanned++;
      const { data: newData, modified } = applyToData(r.data, changes, force, warnings);
      if (modified) updates.push({ id: r.id, data: newData });
      else recordsPreserved++;
    }
    for (let i = 0; i < updates.length; i += 50) {
      await Promise.all(updates.slice(i, i + 50).map((u) => client.entities.AppRecord.update(u.id, { data: u.data })));
    }
    recordsModified += updates.length;
    skip += rows.length;
    if (rows.length < MIGRATION_BATCH) break;
  }

  await client.entities.SchemaMigration.create({
    project_id: projectId, entity_name: entityName, from_version_id: fromVersionId, to_version_id: toVersionId,
    changes, status: "applied", force, dry_run: false, records_scanned: recordsScanned,
    records_modified: recordsModified, records_preserved: recordsPreserved, warnings,
    applied_at: new Date().toISOString(), duration_ms: Date.now() - started,
  });
  return { entity: entityName, status: "applied", changes, records_scanned: recordsScanned, records_modified: recordsModified, records_preserved: recordsPreserved, warnings, duration_ms: Date.now() - started };
}

// Migrate every entity (or one, when entityName is given) from the from-version's
// schema to the to-version's schema. Schemas come from the immutable version
// snapshots, so a migration is exact and reproducible.
export async function migrateProjectVersion(client, {
  projectId, fromVersionId = null, toVersionId, entityName = null, force = false, dryRun = false,
}) {
  const toVer = await client.entities.ProjectVersion.get(toVersionId).catch(() => null);
  if (!toVer || toVer.project_id !== projectId) {
    throw Object.assign(new Error("Target version not found in this project"), { status: 404 });
  }
  const toSnap = await unpackSnapshot(toVer);
  const toEntities = (toSnap.entities || []).map((e) => ({ name: e.name, fields: e.fields || {} }));

  let fromEntities = [];
  if (fromVersionId) {
    const fromVer = await client.entities.ProjectVersion.get(fromVersionId).catch(() => null);
    if (fromVer && fromVer.project_id === projectId) {
      const fromSnap = await unpackSnapshot(fromVer);
      fromEntities = (fromSnap.entities || []).map((e) => ({ name: e.name, fields: e.fields || {} }));
    }
  }

  const targets = entityName ? toEntities.filter((e) => e.name === entityName) : toEntities;
  if (entityName && !targets.length) {
    throw Object.assign(new Error(`Entity "${entityName}" is not in target version`), { status: 404 });
  }

  const results = [];
  for (const e of targets) {
    const old = fromEntities.find((x) => x.name === e.name);
    results.push(await migrateEntity(client, {
      projectId, entityName: e.name, oldFields: old ? old.fields : {}, newFields: e.fields,
      toVersionId, fromVersionId, force, dryRun,
    }));
  }
  return { from_version_id: fromVersionId || null, to_version_id: toVersionId, entities: results };
}