// Minimal, safe jq-subset evaluator for the DOCUMENTED (Base44) top-level workflow trigger
// `condition`: "Add a top-level condition to skip a dispatch unless a jq expression over the
// trigger payload is truthy."
//
// This is the ONLY jq evaluator in the platform — there is no existing one to parallel. It
// supports a deliberately small, side-effect-free subset sufficient for trigger-payload
// predicates: identity (.), field/index paths (.a.b[0]), literals (string / number / true /
// false / null), comparisons (== != > >= < <=), boolean composition (and / or / not),
// parentheses and the pipe (|). It evaluates against a single JSON value (the trigger payload)
// and returns a boolean using jq truthiness: only `false` and `null` are falsy.
//
// SAFETY: no eval, no Function constructor, no identifier resolution, no host/file/env access.
// A malformed, unsupported or empty-after-trim expression ALWAYS fails closed (returns false),
// so a broken condition never dispatches and never breaks workflow processing. The caller
// decides what "absent condition" means; this function returns true for an absent/empty
// expression only so it can be used directly as "no filter".

const isTruthy = (v) => v !== false && v !== null && v !== undefined;

function jqEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === typeof b) return a === b;
  return false;
}

const num = (v) => (typeof v === "number" ? v : Number(v));

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === ".") { toks.push({ t: "dot" }); i++; continue; }
    if (c === "|") { toks.push({ t: "pipe" }); i++; continue; }
    if (c === "(") { toks.push({ t: "lparen" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rparen" }); i++; continue; }
    if (c === "[") { toks.push({ t: "lbrack" }); i++; continue; }
    if (c === "]") { toks.push({ t: "rbrack" }); i++; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) { s += src[j + 1]; j += 2; }
        else { s += src[j]; j++; }
      }
      if (j >= n) throw new Error("unterminated string");
      toks.push({ t: "str", v: s }); i = j + 1; continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=") { toks.push({ t: "op", v: two }); i += 2; continue; }
    if (c === "<" || c === ">") { toks.push({ t: "op", v: c }); i++; continue; }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: "num", v: Number(src.slice(i, j)) }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      if (w === "and" || w === "or" || w === "not" || w === "true" || w === "false" || w === "null") toks.push({ t: "kw", v: w });
      else toks.push({ t: "ident", v: w });
      i = j; continue;
    }
    throw new Error("bad char " + c);
  }
  return toks;
}

/**
 * Evaluates a jq expression over `data` and returns its jq truthiness.
 * Absent/empty expression → true (no filter). Malformed/unsupported → false (fail closed).
 */
// The compiled grammar — tokenize once, then a parse/eval over a given input. Shared by
// evalJqCondition and jqConditionValid so a condition's validity check and its runtime
// evaluation can never diverge.
function compileJq(expr) {
  const toks = tokenize(expr);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t) => { const x = next(); if (!x || x.t !== t) throw new Error("expected " + t); return x; };

  function parseOr(input) {
    let v = parseAnd(input);
    while (peek() && peek().t === "kw" && peek().v === "or") {
      next();
      const r = parseAnd(input);
      v = isTruthy(v) || isTruthy(r);
    }
    return v;
  }
  function parseAnd(input) {
    let v = parseCmp(input);
    while (peek() && peek().t === "kw" && peek().v === "and") {
      next();
      const r = parseCmp(input);
      v = isTruthy(v) && isTruthy(r);
    }
    return v;
  }
  function parseCmp(input) {
    const l = parsePipe(input);
    const t = peek();
    if (t && t.t === "op") {
      next();
      const r = parsePipe(input);
      switch (t.v) {
        case "==": return jqEqual(l, r);
        case "!=": return !jqEqual(l, r);
        case ">": return num(l) > num(r);
        case ">=": return num(l) >= num(r);
        case "<": return num(l) < num(r);
        case "<=": return num(l) <= num(r);
      }
    }
    return l;
  }
  function parsePipe(input) {
    let v = parsePrimary(input);
    while (peek() && peek().t === "pipe") { next(); v = parsePrimary(v); }
    return v;
  }
  function parsePrimary(input) {
    const t = peek();
    if (!t) throw new Error("unexpected end");
    if (t.t === "lparen") { next(); const v = parseOr(input); expect("rparen"); return v; }
    if (t.t === "dot") { next(); return parsePath(input); }
    if (t.t === "str") { next(); return t.v; }
    if (t.t === "num") { next(); return t.v; }
    if (t.t === "kw" && (t.v === "true" || t.v === "false" || t.v === "null")) {
      next(); return t.v === "true" ? true : t.v === "false" ? false : null;
    }
    if (t.t === "kw" && t.v === "not") { next(); return !isTruthy(parsePrimary(input)); }
    throw new Error("unexpected token");
  }
  function parsePath(input) {
    let cur = input;
    if (peek() && peek().t === "ident") { const f = next(); cur = cur == null ? null : cur[f.v]; }
    while (peek()) {
      const t = peek();
      if (t.t === "dot") {
        next();
        const f = peek();
        if (f && f.t === "ident") { next(); cur = cur == null ? null : cur[f.v]; }
        else if (f && f.t === "lbrack") { next(); const idx = expect("num"); expect("rbrack"); cur = Array.isArray(cur) ? cur[idx.v] : null; }
        else break;
      } else if (t.t === "lbrack") {
        next(); const idx = expect("num"); expect("rbrack"); cur = Array.isArray(cur) ? cur[idx.v] : null;
      } else break;
    }
    return cur;
  }

  return {
    run: (input) => {
      pos = 0;
      const v = parseOr(input);
      if (pos < toks.length) throw new Error("unexpected trailing tokens");
      return v;
    },
  };
}

export function evalJqCondition(expr, data) {
  if (typeof expr !== "string" || !expr.trim()) return true;
  try {
    return isTruthy(compileJq(expr).run(data));
  } catch {
    return false; // malformed / unsupported → fail closed
  }
}

/**
 * Structural validity check for a trigger condition. DOCUMENTED (Base44): Slack (`slack`) and
 * Slack Bot (`slackbot`) connector automations REQUIRE trigger conditions — enforced at
 * authoring. Valid = a non-empty expression that parses under the EXACT grammar
 * evalJqCondition enforces (trailing junk refused). No new syntax is introduced.
 */
export function jqConditionValid(expr) {
  if (typeof expr !== "string" || !expr.trim()) return false;
  try {
    compileJq(expr).run({});
    return true;
  } catch {
    return false;
  }
}