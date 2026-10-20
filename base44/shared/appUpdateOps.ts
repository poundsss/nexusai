// updateMany MongoDB-operator parsing/application + the canonical key-sorted JSON helper.
// Moved verbatim from appData.ts; see the updateMany notes there for the documented vs
// NEXUSAI-derived semantics.
import { dbError } from "./appRecordValidation.ts";

const nowIso = () => new Date().toISOString();

// Deterministic JSON with sorted object keys (cursor/key/group comparison; key order can never
// cause a spurious mismatch).
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

export const UPDATE_MANY_OPS = new Set(["$set", "$rename", "$unset", "$inc", "$mul", "$min", "$max", "$currentDate", "$addToSet", "$push", "$pull"]);
export const UPDATE_MANY_BATCH = 500;

/** Validates a MongoDB update-operator document fail-closed. */
export function parseUpdateOperators(def, doc) {
  const schemaFields = def.fields || {};
  const fail = (message, details) => dbError("DATABASE_VALIDATION_FAILED", `${def.name}.updateMany: ${message}`, { entity: def.name, operation: "updateMany", ...(details || {}) });
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw fail("requires a MongoDB update operator document (e.g. { $set: { field: value } })");
  const entries = Object.entries(doc);
  if (!entries.length) throw fail("the update document is empty");
  for (const [op] of entries) {
    if (!UPDATE_MANY_OPS.has(op)) throw fail(`unknown update operator "${op}" — only ${[...UPDATE_MANY_OPS].join(", ")} are documented; a plain partial update is not this surface (use update(id, data) or bulkUpdate)`, { operator: op });
  }
  const fields = new Map();
  const ops = {};
  for (const [op, operand] of entries) {
    if (!operand || typeof operand !== "object" || Array.isArray(operand)) throw fail(`operator "${op}" requires a { field: value } object`, { operator: op });
    const names = Object.keys(operand);
    if (!names.length) throw fail(`operator "${op}" is empty`, { operator: op });
    for (const field of names) {
      if (!(field in schemaFields)) throw fail(`"${field}" is not a declared field of ${def.name}`, { operator: op, field });
      if (fields.has(field)) throw fail(`field "${field}" appears under both "${fields.get(field)}" and "${op}" — each field may only appear in one operator per call`, { field, first: fields.get(field), second: op });
      fields.set(field, op);
      const arg = operand[field];
      if (op === "$rename") {
        if (typeof arg !== "string" || !arg || !(arg in schemaFields)) throw fail(`$rename of "${field}" must name a declared field of ${def.name}`, { field, target: String(arg) });
        if (fields.has(arg)) throw fail(`field "${arg}" appears under both "${fields.get(arg)}" and "$rename" — each field may only appear in one operator per call`, { field: arg, first: fields.get(arg), second: op });
        fields.set(arg, op);
      } else if (op === "$inc" || op === "$mul" || op === "$min" || op === "$max") {
        if (typeof arg !== "number" || !Number.isFinite(arg)) throw fail(`${op} on "${field}" requires a finite number`, { operator: op, field });
      } else if (op === "$currentDate") {
        const ok = arg === true || (arg && typeof arg === "object" && !Array.isArray(arg) && Object.keys(arg).length === 1 && (arg.$type === "date" || arg.$type === "timestamp"));
        if (!ok) throw fail(`$currentDate on "${field}" accepts true or { $type: "date" | "timestamp" }`, { field });
      } else if (op === "$push" || op === "$pull" || op === "$addToSet") {
        if (arg && typeof arg === "object" && !Array.isArray(arg) && "$each" in arg) throw fail(`the $each modifier is not part of the documented ${op} surface`, { operator: op, field });
      }
    }
    ops[op] = operand;
  }
  return { ops, touched: [...fields.keys()] };
}

/** Applies a PARSED operator document to one record projection; returns the merged projection. */
export function applyUpdateOperators(def, item, parsed, index) {
  const out = { ...item };
  const fail = (message) => { throw dbError("DATABASE_VALIDATION_FAILED", `${def.name}.updateMany record ${index + 1}: ${message}`, { entity: def.name, operation: "updateMany", index }); };
  for (const [op, operand] of Object.entries(parsed.ops)) {
    for (const [field, arg] of Object.entries(operand)) {
      const cur = out[field];
      switch (op) {
        case "$set": out[field] = arg; break;
        case "$unset": delete out[field]; break;
        case "$rename": { const value = cur; delete out[field]; out[arg] = value; break; }
        case "$inc":
        case "$mul": {
          const base = cur === undefined || cur === null ? 0 : (typeof cur === "number" && Number.isFinite(cur) ? cur : fail(`${op} target "${field}" holds a non-numeric value`));
          out[field] = op === "$inc" ? base + arg : base * arg;
          break;
        }
        case "$min":
        case "$max": {
          if (cur === undefined || cur === null) out[field] = arg;
          else if (typeof cur !== "number" || !Number.isFinite(cur)) fail(`${op} target "${field}" holds a non-numeric value`);
          else if ((op === "$min" && arg < cur) || (op === "$max" && arg > cur)) out[field] = arg;
          break;
        }
        case "$currentDate": out[field] = nowIso(); break;
        case "$push": {
          const arr = cur === undefined || cur === null ? [] : (Array.isArray(cur) ? cur : fail(`$push target "${field}" is not an array`));
          out[field] = [...arr, arg];
          break;
        }
        case "$addToSet": {
          const arr = cur === undefined || cur === null ? [] : (Array.isArray(cur) ? cur : fail(`$addToSet target "${field}" is not an array`));
          if (!arr.some((el) => stableStringify(el) === stableStringify(arg))) out[field] = [...arr, arg];
          break;
        }
        case "$pull": {
          if (cur === undefined || cur === null) break;
          if (!Array.isArray(cur)) fail(`$pull target "${field}" is not an array`);
          out[field] = cur.filter((el) => stableStringify(el) !== stableStringify(arg));
          break;
        }
      }
    }
  }
  return out;
}