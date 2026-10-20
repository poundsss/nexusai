// Advanced code mutation + file operations over the virtual project filesystem.
//
// Everything here is a pure transformation of the in-memory FS (projectFs), so the existing
// commit path (computeChanges → commitFiles → createVersion) persists it unchanged and the
// build/runtime/design gates still run over the result. No competing filesystem abstraction.
//
// Two capabilities the previous edit surface lacked:
//   1. Structural edits — atomic multi-patch, anchored insertion, line-range replacement,
//      whole-symbol rewrite, project-wide symbol rename. All fail LOUDLY and change nothing
//      when an anchor is missing or ambiguous, so a half-applied edit is impossible.
//   2. File lifecycle — move/rename, copy and bulk delete, each keeping the project WIRED:
//      relative imports that pointed at the file are rewritten, the moved file's own relative
//      imports are re-based, and `server.<fn>` call sites follow a renamed backend function.
import { normalizePath, readFile, writeFile, deleteFile, activeFiles } from "./projectFs.ts";
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";

const MAX_BULK_DELETE = 10;

// --- source scanning ---------------------------------------------------------

// Skips strings, template literals and comments so brace balancing is not fooled by
// `"{"` inside a template — which is common in htm`` UI code.
function scanBlockEnd(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") { i = src.indexOf("\n", i); if (i === -1) return -1; continue; }
    if (c === "/" && next === "*") { i = src.indexOf("*/", i); if (i === -1) return -1; i++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === quote) break;
        else i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

function statementEnd(src, from) {
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") { i = src.indexOf("\n", i); if (i === -1) return src.length; continue; }
    if (c === "/" && next === "*") { i = src.indexOf("*/", i); if (i === -1) return src.length; i++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c; i++;
      while (i < src.length) { if (src[i] === "\\") i += 2; else if (src[i] === quote) break; else i++; }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") { const end = c === "{" ? scanBlockEnd(src, i) : matchPair(src, i); if (end === -1) return src.length; i = end - 1; continue; }
    if (c === ";") return i + 1;
    if (c === "\n") {
      // A declaration may end without a semicolon; only treat the newline as the end when
      // the next non-blank line starts a new top-level statement.
      const rest = src.slice(i + 1);
      if (/^\s*(export|import|function|const|let|var|class|\/\/|\/\*|$)/.test(rest.split("\n")[0] || "")) return i + 1;
    }
  }
  return src.length;
}

function matchPair(src, openIdx) {
  const open = src[openIdx];
  const close = open === "(" ? ")" : "]";
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { const q = c; i++; while (i < src.length) { if (src[i] === "\\") i += 2; else if (src[i] === q) break; else i++; } continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// Locates a top-level declaration of `symbol` and returns its full source range.
export function findSymbol(source, symbol) {
  if (!/^[A-Za-z_$][\w$]*$/.test(String(symbol || ""))) throw new Error(`invalid symbol name '${symbol}'`);
  const patterns = [
    new RegExp(`export\\s+default\\s+(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${symbol}\\b`),
    new RegExp(`export\\s+(?:const|let|var)\\s+${symbol}\\b`),
    new RegExp(`(?:^|\\n)\\s*(?:const|let|var)\\s+${symbol}\\b`),
    new RegExp(`export\\s+(?:default\\s+)?class\\s+${symbol}\\b`),
  ];
  for (const re of patterns) {
    const m = re.exec(source);
    if (!m) continue;
    const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
    const isFn = /function|class/.test(m[0]);
    let end;
    if (isFn) {
      const brace = source.indexOf("{", m.index + m[0].length);
      end = brace === -1 ? -1 : scanBlockEnd(source, brace);
    } else {
      end = statementEnd(source, m.index + m[0].length);
    }
    if (end === -1) throw new Error(`could not determine where '${symbol}' ends (unbalanced braces)`);
    return { start, end, text: source.slice(start, end) };
  }
  return null;
}

// --- structural edits --------------------------------------------------------

// Atomic multi-patch: every find must resolve uniquely against the progressively edited
// content, and the file is written once. One bad patch aborts the whole set.
export function applyPatches(fs, path, patches) {
  const list = Array.isArray(patches) ? patches : [];
  if (!list.length) throw new Error("apply_patches: 'patches' must be a non-empty list of { find, replace }");
  let content = readFile(fs, path);
  const applied = [];
  list.forEach((p, i) => {
    const find = String(p?.find ?? "");
    if (!find) throw new Error(`apply_patches: patch ${i + 1} has an empty 'find'`);
    const idx = content.indexOf(find);
    if (idx === -1) throw new Error(`apply_patches: patch ${i + 1} 'find' text was not found in ${path} (patch ${i + 1} of ${list.length}; no changes applied)`);
    if (content.indexOf(find, idx + 1) !== -1) throw new Error(`apply_patches: patch ${i + 1} 'find' text matches more than one place in ${path}; include more context (no changes applied)`);
    content = content.slice(0, idx) + String(p.replace ?? "") + content.slice(idx + find.length);
    applied.push(i + 1);
  });
  writeFile(fs, path, content);
  return { path, patches_applied: applied.length };
}

export function insertAt(fs, path, { anchor, position = "after", content }) {
  const src = readFile(fs, path);
  const text = String(content ?? "");
  if (!text) throw new Error("insert_at: 'content' is required");
  if (!["before", "after", "start", "end"].includes(position)) throw new Error("insert_at: position must be before | after | start | end");
  if (position === "start") { writeFile(fs, path, text.endsWith("\n") ? text + src : `${text}\n${src}`); return { path, position }; }
  if (position === "end") { writeFile(fs, path, src.endsWith("\n") || !src ? src + text : `${src}\n${text}`); return { path, position }; }
  const a = String(anchor ?? "");
  if (!a) throw new Error("insert_at: 'anchor' is required for before/after");
  const idx = src.indexOf(a);
  if (idx === -1) throw new Error(`insert_at: anchor was not found in ${path}`);
  if (src.indexOf(a, idx + 1) !== -1) throw new Error(`insert_at: anchor matches more than one place in ${path}; include more context`);
  const at = position === "before" ? idx : idx + a.length;
  const glue = position === "before" ? `${text}\n` : `\n${text}`;
  writeFile(fs, path, src.slice(0, at) + glue + src.slice(at));
  return { path, position, anchor_line: src.slice(0, idx).split("\n").length };
}

export function replaceRange(fs, path, { start_line, end_line, content }) {
  const lines = readFile(fs, path).split("\n");
  const s = Number(start_line), e = Number(end_line);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s) throw new Error("replace_range: start_line/end_line must be 1-based integers with end_line >= start_line");
  if (e > lines.length) throw new Error(`replace_range: ${path} has ${lines.length} lines, cannot replace through line ${e}`);
  const replacement = content == null ? [] : String(content).split("\n");
  const next = [...lines.slice(0, s - 1), ...replacement, ...lines.slice(e)];
  writeFile(fs, path, next.join("\n"));
  return { path, lines_replaced: e - s + 1, lines_written: replacement.length };
}

export function replaceSymbol(fs, path, symbol, content) {
  const src = readFile(fs, path);
  const found = findSymbol(src, symbol);
  if (!found) throw new Error(`replace_symbol: '${symbol}' is not declared at the top level of ${path}`);
  const text = String(content ?? "");
  if (!text.trim()) throw new Error("replace_symbol: 'content' is required (use delete-oriented tools to remove code)");
  writeFile(fs, path, src.slice(0, found.start) + text + src.slice(found.end));
  return { path, symbol, replaced_chars: found.end - found.start };
}

// Project-wide identifier rename, word-boundary and string-safe enough for generated code:
// it renames the declaration and every reference, and never touches a substring match
// (`Customer` does not become `CustomerCard`).
export function renameSymbol(fs, { from, to, paths = null }) {
  if (!/^[A-Za-z_$][\w$]*$/.test(String(from || "")) || !/^[A-Za-z_$][\w$]*$/.test(String(to || ""))) throw new Error("rename_symbol: 'from' and 'to' must be identifiers");
  if (from === to) throw new Error("rename_symbol: 'from' and 'to' are identical");
  const re = new RegExp(`\\b${from}\\b`, "g");
  const targets = activeFiles(fs).filter((f) => (paths ? paths.map(normalizePath).includes(f.path) : /\.js$/.test(f.path)));
  const changed = [];
  let total = 0;
  for (const f of targets) {
    // Module specifiers are FILE PATHS, not identifiers: renaming a symbol must never rewrite
    // `'./components/Card.js'` (that is move_file's job), so they are masked out first.
    const specs = [];
    const masked = f.content.replace(SPEC_RE, (full) => { specs.push(full); return `\u0000SPEC${specs.length - 1}\u0000`; });
    const hits = (masked.match(re) || []).length;
    if (!hits) continue;
    if (f.frozen) throw new Error(`rename_symbol: ${f.path} is frozen and references '${from}'`);
    const renamed = masked.replace(re, to).replace(/\u0000SPEC(\d+)\u0000/g, (_, i) => specs[Number(i)]);
    writeFile(fs, f.path, renamed);
    changed.push({ path: f.path, occurrences: hits });
    total += hits;
  }
  if (!total) throw new Error(`rename_symbol: '${from}' does not appear in the project`);
  return { from, to, files_changed: changed.length, occurrences: total, files: changed };
}

// --- file lifecycle ---------------------------------------------------------

const dirOf = (p) => { const i = p.lastIndexOf("/"); return i === -1 ? "" : p.slice(0, i); };

export function resolveSpecifier(importerPath, spec) {
  if (!spec.startsWith(".")) return null;
  const parts = dirOf(importerPath).split("/").filter(Boolean);
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

export function relativeSpecifier(fromPath, toPath) {
  const fromDir = dirOf(fromPath).split("/").filter(Boolean);
  const toParts = toPath.split("/").filter(Boolean);
  let i = 0;
  while (i < fromDir.length && i < toParts.length - 1 && fromDir[i] === toParts[i]) i++;
  const up = fromDir.slice(i).map(() => "..");
  const down = toParts.slice(i);
  const rel = [...up, ...down].join("/");
  return up.length ? rel : `./${rel}`;
}

const SPEC_RE = /(from\s*|import\s*)(['"])([^'"]+)\2/g;

function rewriteSpecifiers(content, importerPath, mapper) {
  return content.replace(SPEC_RE, (full, lead, quote, spec) => {
    const next = mapper(spec, importerPath);
    return next && next !== spec ? `${lead}${quote}${next}${quote}` : full;
  });
}

// Re-bases the file's OWN relative imports for its new location.
function rebaseOwnImports(content, oldPath, newPath) {
  return rewriteSpecifiers(content, oldPath, (spec) => {
    const target = resolveSpecifier(oldPath, spec);
    return target ? relativeSpecifier(newPath, target) : null;
  });
}

// Points every OTHER file's relative imports at the file's new location.
function rewriteReferences(fs, oldPath, newPath, skipPath) {
  const updated = [];
  for (const f of activeFiles(fs)) {
    if (f.path === skipPath || !/\.js$/.test(f.path)) continue;
    let next = rewriteSpecifiers(f.content, f.path, (spec) => (resolveSpecifier(f.path, spec) === oldPath ? relativeSpecifier(f.path, newPath) : null));
    // A renamed backend function changes its callable name too, so `server.old(...)` must follow.
    if (isFunctionPath(oldPath) && isFunctionPath(newPath)) {
      const oldName = functionNameFromPath(oldPath), newName = functionNameFromPath(newPath);
      if (oldName !== newName) next = next.replace(new RegExp(`server\\s*\\.\\s*${oldName}\\b`, "g"), `server.${newName}`);
    }
    if (next !== f.content) { if (f.frozen) throw new Error(`${f.path} is frozen but imports ${oldPath}`); writeFile(fs, f.path, next); updated.push(f.path); }
  }
  return updated;
}

export function moveFile(fs, from, to) {
  const src = normalizePath(from), dst = normalizePath(to);
  if (src === dst) throw new Error("move_file: 'from' and 'to' are the same path");
  const content = readFile(fs, src);
  if (activeFiles(fs).some((f) => f.path === dst)) throw new Error(`move_file: ${dst} already exists`);
  writeFile(fs, dst, rebaseOwnImports(content, src, dst));
  const rewritten = rewriteReferences(fs, src, dst, dst);
  deleteFile(fs, src);
  return { from: src, to: dst, imports_rewritten: rewritten };
}

export function copyFile(fs, from, to) {
  const src = normalizePath(from), dst = normalizePath(to);
  if (src === dst) throw new Error("copy_file: 'from' and 'to' are the same path");
  const content = readFile(fs, src);
  if (activeFiles(fs).some((f) => f.path === dst)) throw new Error(`copy_file: ${dst} already exists`);
  writeFile(fs, dst, rebaseOwnImports(content, src, dst));
  return { from: src, to: dst };
}

// Bulk delete with a real reference check: a file another file still imports (or a backend
// function the frontend still calls) is refused unless `force` is set, so a delete cannot
// silently break the app.
export function deleteFiles(fs, paths, { force = false } = {}) {
  const list = [...new Set((Array.isArray(paths) ? paths : [paths]).map(normalizePath).filter(Boolean))];
  if (!list.length) throw new Error("delete_files: 'paths' is required");
  if (list.length > MAX_BULK_DELETE) throw new Error(`delete_files: refusing to delete ${list.length} files in one call (max ${MAX_BULK_DELETE})`);
  for (const p of list) readFile(fs, p); // existence + clear error before any mutation
  if (!force) {
    const blocked = [];
    for (const p of list) {
      const referrers = activeFiles(fs).filter((f) => !list.includes(f.path) && /\.js$/.test(f.path) && (
        [...f.content.matchAll(SPEC_RE)].some((m) => resolveSpecifier(f.path, m[3]) === p) ||
        (isFunctionPath(p) && new RegExp(`server\\s*\\.\\s*${functionNameFromPath(p)}\\b`).test(f.content))
      )).map((f) => f.path);
      if (referrers.length) blocked.push(`${p} (still used by ${referrers.join(", ")})`);
    }
    if (blocked.length) throw new Error(`delete_files: refused — ${blocked.join("; ")}. Remove the references first, or pass force: true.`);
  }
  for (const p of list) deleteFile(fs, p);
  return { deleted: list };
}