// Record shaping, schema validation, fields projection and the structured DB error helper.
// Moved verbatim from appData.ts (re-exported there for backward compatibility).

export function toItem(r) {
  return { id: r.id, created_date: r.created_date, updated_date: r.updated_date, ...(r.data || {}) };
}

// Structured database diagnostic. `code` + `details` give the AI repair loop precise
// context; `message` stays safe for the browser (entity/field names only, never data or secrets).
export function dbError(code, message, details) {
  return Object.assign(new Error(message), { name: "DatabaseError", code, details: details || {} });
}

export function validateRecord(def, data) {
  const errors = [];
  const issues = [];
  const fields = def.fields || {};
  for (const [name, f] of Object.entries(fields)) {
    const v = data[name];
    if (v === undefined || v === null || v === "") {
      if (f.required) { errors.push(`${name} is required`); issues.push({ field: name, reason: "required" }); }
      continue;
    }
    if (f.type === "number" && typeof v !== "number") { errors.push(`${name} must be a number`); issues.push({ field: name, reason: "type", expected: "number", got: typeof v }); }
    else if (f.type === "boolean" && typeof v !== "boolean") { errors.push(`${name} must be true/false`); issues.push({ field: name, reason: "type", expected: "boolean", got: typeof v }); }
    else if (f.type === "enum" && !(f.enum || []).includes(v)) { errors.push(`${name} must be one of ${(f.enum || []).join(", ")}`); issues.push({ field: name, reason: "enum", value: v, allowed: f.enum || [] }); }
    else if (["string", "text", "date"].includes(f.type) && typeof v !== "string") { errors.push(`${name} must be a string`); issues.push({ field: name, reason: "type", expected: f.type, got: typeof v }); }
  }
  const unknown = Object.keys(data).filter((k) => !fields[k]);
  if (unknown.length) { errors.push(`unknown field(s): ${unknown.join(", ")}`); for (const u of unknown) issues.push({ field: u, reason: "unknown_field", known_fields: Object.keys(fields) }); }
  if (errors.length) {
    throw dbError("DATABASE_VALIDATION_FAILED", `Validation failed for ${def.name}: ${errors.join("; ")}`, { entity: def.name, issues });
  }
}

// DOCUMENTED (Base44 SDK reference): list/filter accept `fields: (keyof T)[]` — "Array of
// field names to include in the response. Defaults to all fields." The projection is pure
// response shaping applied AFTER the read gate. The `fields` list is validated BEFORE any
// storage work — an entry that is not a schema field or a built-in is refused with a
// structured error, never silently dropped.
export function makeProjection(def, fields) {
  if (fields === undefined || fields === null || !Array.isArray(fields) || fields.length === 0) return (items) => items;
  const known = new Set(["id", "created_date", "updated_date", ...Object.keys((def || {}).fields || {})]);
  for (const f of fields) {
    if (typeof f !== "string" || !known.has(f)) {
      throw dbError("DATABASE_VALIDATION_FAILED", `Validation failed for ${def.name}: unknown field in fields projection: ${String(f)}`, { entity: def.name, field: String(f), known_fields: [...known] });
    }
  }
  return (items) => items.map((it) => {
    const out = {};
    for (const k of fields) if (it[k] !== undefined) out[k] = it[k];
    return out;
  });
}