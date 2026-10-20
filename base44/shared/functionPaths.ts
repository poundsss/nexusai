// Backend-function paths, in BOTH supported layout shapes.
//
//   canonical: base44/functions/<name>/entry.ts   (Base44 layout)
//   legacy:    functions/<name>.js                (flat layout, every existing project)
//
// A function is an ordinary project file in either shape, so it inherits the existing filesystem,
// build, commit, version and rollback machinery unchanged. Legacy behaviour is preserved exactly:
// `functionPath(name)` still returns the flat path, and every legacy helper answers as it always
// did — the canonical shape is additive.
export const FUNCTIONS_DIR = "functions/";
export const CANONICAL_FUNCTIONS_DIR = "base44/functions/";
export const FUNCTION_ENTRY = "entry.ts";
export const FUNCTION_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const LEGACY_RE = /^functions\/([a-zA-Z][a-zA-Z0-9_]*)\.js$/;
const CANONICAL_RE = /^base44\/functions\/([a-zA-Z][a-zA-Z0-9_]*)\/entry\.ts$/;

/** The flat, legacy path of a function. Unchanged, so existing callers keep their behaviour. */
export const functionPath = (name) => `${FUNCTIONS_DIR}${name}.js`;
/** The canonical Base44 path of a function. */
export const canonicalFunctionPath = (name) => `${CANONICAL_FUNCTIONS_DIR}${name}/${FUNCTION_ENTRY}`;

export const isLegacyFunctionPath = (path) => LEGACY_RE.test(String(path || ""));
export const isCanonicalFunctionPath = (path) => CANONICAL_RE.test(String(path || ""));

/** True for a backend function file in EITHER layout. */
export const isFunctionPath = (path) => isLegacyFunctionPath(path) || isCanonicalFunctionPath(path);
/** Same check, named for validation call sites. */
export const isValidFunctionPath = (path) => isFunctionPath(path);

/** The function's name, whichever shape its path has. */
export function functionNameFromPath(path) {
  const p = String(path || "");
  return (CANONICAL_RE.exec(p) || LEGACY_RE.exec(p) || [null, p])[1];
}

/**
 * The path a function should be written to, given the paths the project ALREADY has: an existing
 * file of either shape is reused, so a flat-layout project never gains a second copy of a function
 * in the canonical directory. A project with neither gets the canonical path.
 */
export function resolveFunctionPath(name, existingPaths = []) {
  const canonical = canonicalFunctionPath(name);
  const legacy = functionPath(name);
  const paths = Array.isArray(existingPaths) ? existingPaths.map((p) => (typeof p === "string" ? p : p?.path)) : [];
  if (paths.includes(canonical)) return canonical;
  if (paths.includes(legacy)) return legacy;
  return canonical;
}