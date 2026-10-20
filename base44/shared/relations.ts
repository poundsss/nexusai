// Project-scoped relation (foreign-key) definitions and server-side referential
// integrity for generated applications.
//
// Relations are stored as AppRelation rows (project-scoped) and enforced inside
// createServerDb on create/update/delete — on top of the existing CRUD/RLS layer,
// not instead of it. This module holds the pure model + enforcement logic; storage
// access is supplied by the caller via a `store` object so the engine stays free of
// SDK imports and is independently testable.

export const RELATION_TYPES = ["one_to_one", "one_to_many", "many_to_one"];
export const ON_DELETE_POLICIES = ["restrict", "set_null", "cascade"];

// R-7 Phase 3: the link field is hidden from the caller — no ids, counts or field names.
const hiddenViolation = (entity) => fkError("DATABASE_RELATION_VIOLATION", `Relation constraint violated on ${entity}`, { entity });

function fkError(code, message, details) {
  return Object.assign(new Error(message), { name: "RelationError", code, details: details || {} });
}

// Normalize any declared relation to a canonical FK form: the FK field lives on
// `fkEntity` and points to `refEntity`.
//   many_to_one  → FK on from_entity, references to_entity (not unique)
//   one_to_one   → FK on from_entity, references to_entity (unique)
//   one_to_many  → declared from the "one" side; FK is on to_entity, references from_entity
export function canonical(rel) {
  const type = rel.type || "many_to_one";
  const onDelete = rel.on_delete || "restrict";
  const required = !!rel.required;
  if (type === "one_to_many") {
    return { name: rel.name, fkEntity: rel.to_entity, fkField: rel.from_field, refEntity: rel.from_entity, unique: false, onDelete, required };
  }
  return { name: rel.name, fkEntity: rel.from_entity, fkField: rel.from_field, refEntity: rel.to_entity, unique: type === "one_to_one", onDelete, required };
}

// Validate a relation definition. `entityNames` is optional (the project's declared
// entities); when provided, both sides must be declared.
export function validateRelationDef(rel, entityNames) {
  const errors = [];
  if (!rel || typeof rel !== "object") return { errors: ["relation is not an object"] };
  if (!rel.name) errors.push("name is required");
  if (!rel.from_entity) errors.push("from_entity is required");
  if (!rel.to_entity) errors.push("to_entity is required");
  if (!rel.from_field) errors.push("from_field is required");
  if (!RELATION_TYPES.includes(rel.type)) errors.push(`type must be one of ${RELATION_TYPES.join(", ")}`);
  if (rel.on_delete && !ON_DELETE_POLICIES.includes(rel.on_delete)) errors.push(`on_delete must be one of ${ON_DELETE_POLICIES.join(", ")}`);
  if (rel.from_entity && rel.to_entity && rel.from_entity === rel.to_entity) errors.push("from_entity and to_entity must differ");
  if (rel.required && rel.on_delete === "set_null") errors.push("required relations cannot use on_delete=set_null (would null a required field)");
  if (entityNames && rel.from_entity && !entityNames.includes(rel.from_entity)) errors.push(`from_entity "${rel.from_entity}" is not a declared entity`);
  if (entityNames && rel.to_entity && !entityNames.includes(rel.to_entity)) errors.push(`to_entity "${rel.to_entity}" is not a declared entity`);
  return { errors };
}

export function fkRelationsFor(rels, entity) { return rels.filter((r) => r.fkEntity === entity); }
export function dependentRelationsFor(rels, entity) { return rels.filter((r) => r.refEntity === entity); }

// Enforce referential integrity on a create/update of a record in `entity`.
// `data` is the full record state to validate (merged for update). `existingId` is the
// record's own id (for uniqueness self-exclusion on update). `updateKeys` are the fields
// actually being changed (only used to decide whether to enforce `required` on update).
export async function enforceOnWrite({ rels, entity, data, existingId = null, isUpdate = false, updateKeys = [], store }) {
  for (const rel of fkRelationsFor(rels, entity)) {
    const val = data[rel.fkField];
    const isNull = val === undefined || val === null || val === "";
    if (isNull) {
      const enforceRequired = !isUpdate || updateKeys.includes(rel.fkField);
      if (rel.required && enforceRequired) {
        throw fkError("FK_REQUIRED", `${entity}.${rel.fkField} is required (relation ${rel.name})`, { field: rel.fkField, relation: rel.name });
      }
      continue;
    }
    const ref = await store.getRef(rel.refEntity, val);
    if (!ref) {
      throw fkError("FK_NOT_FOUND", `${entity}.${rel.fkField} references a non-existent ${rel.refEntity}`, { field: rel.fkField, relation: rel.name, refEntity: rel.refEntity, refId: String(val) });
    }
    if (rel.unique) {
      const other = await store.findWithFk(rel.fkEntity, rel.fkField, val, existingId);
      if (other.length && store.isHidden?.(rel.fkEntity, rel.fkField)) throw hiddenViolation(entity);
      if (other.length) {
        throw fkError("FK_NOT_UNIQUE", `${entity}.${rel.fkField} must be unique (relation ${rel.name}); another ${rel.fkEntity} already references ${rel.refEntity} ${val}`, { field: rel.fkField, relation: rel.name, refId: String(val) });
      }
    }
  }
}

// Enforce on_delete policy for a record about to be deleted from `entity` (the
// referenced side). Finds dependents (scoped by owner when RLS is on, via store) and
// applies restrict / set_null / cascade. Cascade recurses into dependents' own
// dependents before deleting them, so chains are cleaned up and no orphans remain.
export async function enforceOnDelete({ rels, entity, id, store }) {
  for (const rel of dependentRelationsFor(rels, entity)) {
    const deps = await store.findWithFk(rel.fkEntity, rel.fkField, id, null);
    if (!deps.length) continue;
    if (rel.onDelete === "restrict" && store.isHidden?.(rel.fkEntity, rel.fkField)) throw hiddenViolation(entity);
    if (rel.onDelete === "restrict") {
      throw fkError("FK_RESTRICT", `Cannot delete ${entity}: ${deps.length} ${rel.fkEntity} record(s) reference it via ${rel.name}`, { relation: rel.name, fkEntity: rel.fkEntity, count: deps.length });
    }
    if (rel.onDelete === "set_null") {
      for (const d of deps) await store.nullFk(d.id, rel.fkField);
    } else if (rel.onDelete === "cascade") {
      for (const d of deps) {
        await enforceOnDelete({ rels, entity: rel.fkEntity, id: d.id, store });
        await store.deleteRecord(d.id);
      }
    }
  }
}