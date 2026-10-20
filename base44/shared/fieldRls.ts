// R-7 Phase 1: field-level READ enforcement for the shared data engine.
// Blocked reads omit the field; queries, sorts and projections naming a blocked field are
// refused (no inference); aggregate/distinct are refused for entities with field read rules.
// Only callers that opt in (fieldRules: true) get a plan — service-role/builder paths never do.
import { gateFor, recordView } from "./rls.ts";
// Same structured shape as appData's dbError (kept local to avoid an import cycle).
const dbError = (code, message, details) => Object.assign(new Error(message), { name: "DatabaseError", code, details: details || {} });

const isPureUserCondition = (rule) =>
  !!rule && typeof rule === "object" && !Array.isArray(rule) && Object.keys(rule).length === 1 && "user_condition" in rule;

/** True when any declared field carries a non-null `rls.read` rule. */
export const hasFieldReadRules = (def) =>
  Object.values((def && def.fields) || {}).some((f) => f && f.rls && f.rls.read !== undefined && f.rls.read !== null);

export const anyFieldReadRules = (entities) => (entities || []).some(hasFieldReadRules);

/** Compiled per entity per request. `null` means nothing to enforce. */
export function fieldReadPlan(def, user) {
  if (!hasFieldReadRules(def)) return null;
  const fields = [];
  for (const [name, f] of Object.entries(def.fields || {})) {
    if (!f || !f.rls || f.rls.read === undefined || f.rls.read === null) continue;
    const gate = gateFor({ rls: { read: f.rls.read } }, "read", user || null);
    if (gate.open) continue;
    // Querying is allowed only when readability does not depend on the record itself.
    const queryable = !gate.deny && isPureUserCondition(f.rls.read) && gate.allows(recordView({}));
    fields.push({ name, gate, queryable, rule: f.rls.read });
  }
  return { entity: def.name, fields };
}

const denied = (entity, field, operation) =>
  Object.assign(dbError("DATABASE_FIELD_NOT_READABLE", `Not permitted: field '${field}' of ${entity} is not readable`, { entity, field, operation }), { status: 403 });

/** Field names a query references, including inside $or/$and/$nor. */
function queryFieldNames(q, out = new Set()) {
  if (!q || typeof q !== "object") return out;
  for (const [k, v] of Object.entries(q)) {
    if (k === "$or" || k === "$and" || k === "$nor") { if (Array.isArray(v)) v.forEach((b) => queryFieldNames(b, out)); continue; }
    if (k.startsWith("$")) continue;
    out.add(k.replace(/^data\./, ""));
  }
  return out;
}

export function assertQueryable(plan, { query, sort, fields, operation }) {
  if (!plan || !plan.fields.length) return;
  const blocked = new Map(plan.fields.filter((f) => !f.queryable).map((f) => [f.name, f]));
  if (!blocked.size) return;
  for (const n of queryFieldNames(query)) if (blocked.has(n)) throw denied(plan.entity, n, operation);
  if (sort) { const s = String(sort).replace(/^[-+]/, "").replace(/^data\./, ""); if (blocked.has(s)) throw denied(plan.entity, s, operation); }
  if (Array.isArray(fields)) for (const f of fields) if (blocked.has(f)) throw denied(plan.entity, f, operation);
}

export function assertNoFieldRules(plan, operation) {
  if (plan) throw Object.assign(dbError("DATABASE_FIELD_RULES_UNSUPPORTED", `${operation} is not available on ${plan.entity} because it declares field-level read rules`, { entity: plan.entity, operation }), { status: 403 });
}

/** Removes every field the caller may not read on this record. */
export function omitBlocked(plan, item, row) {
  if (!plan || !plan.fields.length) return item;
  const view = recordView(row);
  for (const f of plan.fields) if (!f.gate.allows(view)) delete item[f.name];
  return item;
}

// R-7 Phase 3: a field is "hidden" for relation errors when ANY non-open read gate applies
// to it for this caller (conservative: record-dependent rules count as hidden).
export const isFieldHidden = (plan, field) => !!plan && plan.fields.some((f) => f.name === field && !(f.queryable && f.gate.allows(recordView({}))));

// R-7 Phase 3: strips hidden fields from a stored entity event before delivery. The event's
// record is re-viewed as a row; a rule that depends on record ownership cannot be evaluated
// when the event carries no owner, so such events are DROPPED (returns null), never sent raw.
export function filterEventData(plan, data, ownerId) {
  if (!plan || !plan.fields.length || !data || typeof data !== "object") return data;
  const { id, created_date, updated_date, ...rest } = data;
  const ownerKnown = ownerId != null || rest.owner_id != null;
  const row = { id, created_date, updated_date, owner_id: ownerId ?? null, data: rest };
  const view = recordView(row);
  const out = { ...data };
  for (const f of plan.fields) {
    if (!f.queryable && !ownerKnown && /created_by/.test(JSON.stringify(f.rule ?? null))) return null;
    if (!f.gate.allows(view)) delete out[f.name];
  }
  return out;
}

// R-7 Phase 2: field-level WRITE enforcement. create → field rls.create ?? rls.write;
// update → field rls.update ?? rls.write. Delete stays record-level (no field check).
// Checked only on the keys the caller supplies, inside each op's pre-write phase, so a denial
// aborts the whole operation before the first mutation. Opt-in (fieldRules: true) only.
export function fieldWritePlan(def, user) {
  const plan = { entity: def && def.name, create: [], update: [] };
  for (const [name, f] of Object.entries((def && def.fields) || {})) {
    const r = f && f.rls;
    if (!r) continue;
    for (const op of ["create", "update"]) {
      const rule = r[op] !== undefined && r[op] !== null ? r[op] : r.write;
      if (rule === undefined || rule === null) continue;
      const gate = gateFor({ rls: { [op]: rule } }, op, user || null);
      if (!gate.open) plan[op].push({ name, gate });
    }
  }
  return plan.create.length || plan.update.length ? plan : null;
}

export function assertFieldsWritable(plan, op, keys, view, operation, index = null) {
  if (!plan) return;
  const supplied = new Set(keys || []);
  for (const f of plan[op]) {
    if (!supplied.has(f.name) || f.gate.allows(view)) continue;
    throw Object.assign(dbError("DATABASE_FIELD_NOT_WRITABLE", `Not permitted: field '${f.name}' of ${plan.entity} is not writable${index != null ? ` (record ${index + 1})` : ""}`, { entity: plan.entity, field: f.name, operation, ...(index != null ? { index } : {}) }), { status: 403 });
  }
}