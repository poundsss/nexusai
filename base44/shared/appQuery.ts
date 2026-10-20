// Pure in-memory query utilities for AppRecord data (extracted from appData.ts verbatim).
//
// In-memory matcher for app-field (data.*) conditions the storage layer cannot push down.
// DOCUMENTED (Base44 SDK 0.8.51 types + entities reference page, V2 query audit): field-level
// operators $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists, $regex (string fields), $all,
// $size (array fields) and $not (a negated object of these leaf operators); root-level logical
// operators $or, $and, $nor combine nested queries; array shorthand matches any listed value.
// $contains is a NexusAI-derived ADDITIVE operator and is kept unchanged. $elemMatch is NOT
// implemented — it appears in one docs operator list but is absent from the SDK types (UNKNOWN,
// pending canon decision). Nested $or under a field condition remains NOT implemented (the
// certified boundary). Unknown operators and malformed conditions fail closed (match nothing);
// an empty or malformed $or/$and/$nor matches nothing — the same bounded fail-closed choice
// the certified $or pin made.
const LEAF_OPS = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$exists", "$regex", "$all", "$size", "$contains"]);
function applyOperator(v, op, arg) {
  switch (op) {
    case "$contains": return String(v ?? "").toLowerCase().includes(String(arg).toLowerCase());
    case "$eq": return v === arg;
    case "$in": return Array.isArray(arg) && arg.includes(v);
    case "$nin": return Array.isArray(arg) && !arg.includes(v);
    case "$ne": return v !== arg;
    case "$gt": return v > arg;
    case "$gte": return v >= arg;
    case "$lt": return v < arg;
    case "$lte": return v <= arg;
    case "$exists": return (v !== undefined) === !!arg;
    // $regex — DERIVED behavior choice (Base44 links MongoDB semantics but pins no flavor, and
    // this runtime is not MongoDB): the pattern is a JavaScript RegExp source, case-sensitive,
    // anchored exactly as written; only string values can match; $options is NOT typed in the
    // SDK and is not supported; an invalid pattern fails closed (matches nothing).
    case "$regex": {
      if (typeof v !== "string" || typeof arg !== "string") return false;
      try { return new RegExp(arg).test(v); } catch { return false; }
    }
    // $all / $size — array-field operators (SDK types). Mongo-documented edges kept: an empty
    // $all list matches nothing; a non-array field matches nothing.
    case "$all": return Array.isArray(v) && Array.isArray(arg) && arg.length > 0 && arg.every((el) => v.includes(el));
    case "$size": return Array.isArray(v) && typeof arg === "number" && v.length === arg;
    // $not — negated object of leaf operators (Mongo semantics: no logical operators, no nested
    // $not). Any non-leaf, unknown or empty entry fails the whole condition closed.
    case "$not": {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) return false;
      const inner = Object.entries(arg);
      if (!inner.length || !inner.every(([op2]) => LEAF_OPS.has(op2))) return false;
      return !inner.every(([op2, arg2]) => applyOperator(v, op2, arg2));
    }
    default: return false;
  }
}

export function matches(item, query) {
  return Object.entries(query || {}).every(([k, cond]) => {
    if (k === "$or") return Array.isArray(cond) && cond.length > 0 && cond.some((sub) => matches(item, sub));
    if (k === "$and") return Array.isArray(cond) && cond.length > 0 && cond.every((sub) => matches(item, sub));
    if (k === "$nor") return Array.isArray(cond) && cond.length > 0 && !cond.some((sub) => matches(item, sub));
    const v = item[k];
    if (Array.isArray(cond)) return cond.includes(v);
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, arg]) => applyOperator(v, op, arg));
    }
    return v === cond;
  });
}

export function sortItems(items, sort) {
  if (!sort) return items;
  // DOCUMENTED (Base44 SortField): '+' prefix or no prefix = ascending, '-' = descending.
  const desc = sort.startsWith("-");
  const key = desc || sort.startsWith("+") ? sort.slice(1) : sort;
  return [...items].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === y) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x > y ? 1 : -1) * (desc ? -1 : 1);
  });
}