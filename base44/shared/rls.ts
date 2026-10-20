// THE row-level-security evaluator. One implementation, used by every enforcement point.
//
// SCOPE — exactly the verified Base44 contract, nothing more:
//   • RLS is declared per ENTITY, as a top-level `rls` block on the entity document:
//       { read, create, update, delete } — each one a Mongo-style filter object.
//     There is no field-level RLS, and none is invented here.
//   • An operation with no rule is OPEN. `{}` and `true` are open. `false` DENIES read and
//     delete; on create/update `false` is not enforced and is therefore treated as open.
//   • `update`/`delete`, when absent, inherit `write`, then `read`. A legacy `write: false`
//     denies delete and leaves update open — the same asymmetry as `false` itself.
//   • READS are database queries and accept the comparison/array operator set. WRITES are
//     checked against ONE record in application code and accept only the compact set
//     (equality, $in/$nin, $ne, alternating $or/$and, user_condition, single-segment
//     `data.<field>`). An operator outside the set for that mode never silently becomes a
//     different comparison: the rule simply does not match.
//   • $regex is deliberately absent.
//
// OWNERSHIP COMPATIBILITY — NexusAI stores ownership as the top-level `AppRecord.owner_id`
// (with a legacy `data.owner_id` fallback on older rows). `created_by_id` is a LOGICAL ALIAS
// resolved here at evaluation time, so a Base44-shaped rule
// `{ "created_by_id": "{{user.id}}" }` matches the records NexusAI already stamped. Nothing
// is renamed, no row is rewritten, and no migration is implied.

const READ_OPS = new Set(["$eq", "$ne", "$in", "$nin", "$gt", "$gte", "$lt", "$lte", "$exists", "$all", "$size", "$elemMatch"]);
const WRITE_OPS = new Set(["$eq", "$ne", "$in", "$nin"]);
const LOGICAL = ["$or", "$and", "$nor"];
const WRITE_LOGICAL = ["$or", "$and"];

/** Built-in record fields addressable at the top level of a rule. */
const TOP_FIELDS = new Set(["id", "created_by_id", "created_by", "created_date", "updated_date"]);

/** True when the entity declares any RLS at all. */
export const hasRls = (entity) => !!(entity && entity.rls && typeof entity.rls === "object" && Object.keys(entity.rls).length);

/** True when ANY entity of a project declares RLS — what decides whether a session is needed. */
export const anyEntityRls = (entities) => (entities || []).some(hasRls);

/**
 * The record shape a rule is evaluated against. Built-ins live at the top level; every
 * user-declared field lives under `data.`, exactly as the contract addresses them.
 * `created_by_id` is the alias of the stored `owner_id` (with the legacy in-blob fallback).
 */
export function recordView(row) {
  const r = row || {};
  const data = r.data || {};
  const owner = r.owner_id != null ? r.owner_id : (data.owner_id != null ? data.owner_id : null);
  return {
    id: r.id ?? null,
    created_by_id: owner,
    created_by: r.created_by ?? null,
    created_date: r.created_date ?? null,
    updated_date: r.updated_date ?? null,
    data,
  };
}

/** The view of a record that does not exist yet (a create). Ownership is the server's, not the caller's. */
export function pendingView(data, { userId = null, email = null } = {}) {
  return { id: null, created_by_id: userId, created_by: email, created_date: null, updated_date: null, data: data || {} };
}

const UNSUPPORTED = Symbol("unsupported");

/** One user attribute, by the verified names only. */
function userAttr(user, attr) {
  if (!user) return null;
  if (attr === "id") return user.id ?? null;
  if (attr === "email") return user.email ?? null;
  if (attr === "role") return user.role ?? (Array.isArray(user.roles) ? (user.roles[0] ?? null) : null);
  if (attr.startsWith("data.")) {
    const field = attr.slice(5);
    if (field.includes(".")) return null;               // one level only
    const bag = user.data && typeof user.data === "object" ? user.data : user;
    return bag[field] ?? null;
  }
  return null;
}

const TEMPLATE_RE = /^\{\{\s*user\.(id|email|role|data\.[A-Za-z0-9_]+)\s*\}\}$/;

/**
 * Resolves a `{{user.*}}` template. A non-template value is returned untouched, and an
 * unrecognised template is left verbatim (so it matches nothing) rather than guessed at.
 * An array-valued user field resolves to the array itself, which is why it only works as
 * the whole `$in` operand.
 */
export function resolveTemplate(value, user) {
  if (typeof value !== "string") return value;
  const m = TEMPLATE_RE.exec(value.trim());
  return m ? userAttr(user, m[1]) : value;
}

/** The record value a rule key addresses. `data.<field>` for app fields, built-ins at top level. */
function valueAt(view, key, mode) {
  const k = String(key);
  if (k.startsWith("data.")) {
    const segs = k.slice(5).split(".");
    if (mode === "write" && segs.length > 1) return UNSUPPORTED;   // nested write keys are out of contract
    let cur = view.data;
    for (const s of segs) cur = cur == null ? undefined : cur[s];
    return cur;
  }
  if (k.includes(".")) return UNSUPPORTED;
  return TOP_FIELDS.has(k) ? view[k] : undefined;      // an unknown field matches nothing
}

const same = (a, b) => a === b || (a == null && b == null) || JSON.stringify(a) === JSON.stringify(b);

/** Equality. On READS a scalar also matches a member of an array field (verified read behaviour). */
function eq(actual, expected, mode) {
  if (mode === "read" && Array.isArray(actual) && !Array.isArray(expected)) return actual.some((v) => same(v, expected));
  return same(actual, expected);
}

function inList(actual, list, mode) {
  if (!Array.isArray(list)) return false;
  if (Array.isArray(actual)) return actual.some((v) => list.some((x) => same(v, x)));
  return list.some((x) => eq(actual, x, mode));
}

function cmp(actual, expected, op) {
  if (actual == null || expected == null) return false;
  if (op === "$gt") return actual > expected;
  if (op === "$gte") return actual >= expected;
  if (op === "$lt") return actual < expected;
  return actual <= expected;
}

/** One field condition. An operator outside this mode's set makes the condition fail — never mean something else. */
function matchCondition(actual, cond, user, mode) {
  if (actual === UNSUPPORTED) return false;
  const isOperatorObject = cond && typeof cond === "object" && !Array.isArray(cond) && Object.keys(cond).some((k) => k.startsWith("$"));
  if (!isOperatorObject) return eq(actual, resolveTemplate(cond, user), mode);
  const allowed = mode === "read" ? READ_OPS : WRITE_OPS;
  for (const [op, rawArg] of Object.entries(cond)) {
    if (!allowed.has(op)) return false;
    const arg = resolveTemplate(rawArg, user);
    if (op === "$eq" && !eq(actual, arg, mode)) return false;
    else if (op === "$ne" && eq(actual, arg, mode)) return false;
    else if (op === "$in" && !inList(actual, arg, mode)) return false;
    else if (op === "$nin" && inList(actual, arg, mode)) return false;
    else if (op === "$exists" && (actual !== undefined && actual !== null) !== !!arg) return false;
    else if (["$gt", "$gte", "$lt", "$lte"].includes(op) && !cmp(actual, arg, op)) return false;
    else if (op === "$all" && !(Array.isArray(arg) && Array.isArray(actual) && arg.every((x) => actual.some((v) => same(v, x))))) return false;
    else if (op === "$size" && !(Array.isArray(actual) && actual.length === Number(arg))) return false;
    else if (op === "$elemMatch") {
      if (!Array.isArray(actual) || !arg || typeof arg !== "object") return false;
      if (!actual.some((el) => Object.entries(arg).every(([f, c]) => matchCondition(el && typeof el === "object" ? el[f] : undefined, c, user, mode)))) return false;
    }
  }
  return true;
}

/** `user_condition` — exact equality on user attributes, and the only key in its object. */
function matchUserCondition(spec, user) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return false;
  return Object.entries(spec).every(([attr, expected]) => same(userAttr(user, attr), expected));
}

/**
 * Evaluates ONE rule object against one record view. `mode` decides the operator set:
 * "read" for query-shaped rules, "write" for the per-record checks on create/update/delete.
 */
export function evaluateRule(rule, view, user, mode) {
  if (rule == null || rule === true) return true;
  if (rule === false) return false;
  if (typeof rule !== "object" || Array.isArray(rule)) return false;
  const keys = Object.keys(rule);
  if (!keys.length) return true;

  if (keys.includes("user_condition")) return keys.length === 1 && matchUserCondition(rule.user_condition, user);

  const logical = (mode === "read" ? LOGICAL : WRITE_LOGICAL).find((k) => keys.includes(k));
  if (logical) {
    if (keys.length !== 1) return false;               // a logical group must be the only key
    const branches = rule[logical];
    if (!Array.isArray(branches)) return false;
    if (logical === "$or") return branches.some((b) => evaluateRule(b, view, user, mode));
    if (logical === "$and") return branches.every((b) => evaluateRule(b, view, user, mode));
    return !branches.some((b) => evaluateRule(b, view, user, mode));   // $nor (read only)
  }
  // An unrecognised $operator at the top level is not a field key and is not interpreted.
  if (keys.some((k) => k.startsWith("$"))) return false;

  return keys.every((k) => matchCondition(valueAt(view, k, mode), rule[k], user, mode));
}

const isOpenValue = (v) => v === undefined || v === null || v === true || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * The rule that governs one operation, following the verified inheritance:
 *   read   → rls.read
 *   create → rls.create
 *   update → rls.update, else rls.write, else rls.read
 *   delete → rls.delete, else rls.write, else rls.read
 * `from` records where the value came from, because a legacy `write: false` behaves
 * differently for update (open) than for delete (deny).
 */
export function ruleFor(rls, op) {
  const r = rls && typeof rls === "object" ? rls : {};
  if (op === "read") return { value: r.read, from: "read" };
  if (op === "create") return { value: r.create, from: "create" };
  if (r[op] !== undefined) return { value: r[op], from: op };
  if (r.write !== undefined) return { value: r.write, from: "write" };
  return { value: r.read, from: "read" };
}

/**
 * The compiled gate for one entity + operation: `{ open }`, `{ deny }`, or an `allows(view)`
 * predicate. Every enforcement point asks for a gate and honours these three answers, so read
 * filtering and write checks can never drift apart.
 */
export function gateFor(entity, op, user) {
  if (!hasRls(entity)) return { open: true, deny: false, allows: () => true };
  const { value, from } = ruleFor(entity.rls, op);
  if (isOpenValue(value)) return { open: true, deny: false, allows: () => true };
  if (value === false) {
    // `false` denies read and delete. On create/update it is not enforced — including when it
    // was inherited from a legacy `write: false`, which denies delete but leaves update open.
    const denies = op === "read" || op === "delete";
    return denies ? { open: false, deny: true, allows: () => false } : { open: true, deny: false, allows: () => true };
  }
  const mode = op === "read" ? "read" : "write";
  // An inherited read rule still gates a write, and is evaluated with the write operator set.
  void from;
  return { open: false, deny: false, allows: (view) => evaluateRule(value, view, user, mode) };
}