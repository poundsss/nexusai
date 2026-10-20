// B5 — the ONE path that turns lockfile-pinned packages into browser ES modules.
//
// Preview and deployment both call packageModules(); nothing else produces package code.
//   • Curated mode: sources come from packageCuratedSources.ts (server code).
//   • Registry mode: the verified archive's reachable ESM files are kept in PRIVATE storage at
//     resolution time (storeModuleBundle); here they are read back server-side and digest-checked.
//     Neither the storage handle nor a signed URL ever leaves this module — only module text.
//   • Every module is parsed with Acorn. Import sources are rewritten by AST range to reserved
//     "nx:_pkg/…" markers that the shared browser loader resolves; nothing is regex-rewritten.
//   • Unsupported features (dynamic import, import.meta, CommonJS, unpinned/built-in imports,
//     reserved loader markers in the source text) are refused here, before any browser sees them.
import * as acorn from "npm:acorn@8.12.1";
import { installedPackages } from "./packageLock.ts";
import { curatedModuleSource } from "./packageCuratedSources.ts";
// packageSupply imports this module too; cacheKey is only read at call time, so the cycle is safe.
import { cacheKey } from "./packageSupply.ts";
import { loadAuthorizedProject, loadProjectState } from "./authz.ts";

// module_bytes mirrors SUPPLY_LIMITS.entry_bytes (not imported: top-level use would hit the cycle).
export const MODULE_LIMITS = { module_bytes: 400_000, total_bytes: 2_000_000, modules: 200 };
export const MARKER = "nx:";
const KEY_RE = /^_pkg\/[A-Za-z0-9@._\/-]+$/;

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const bytes = (s) => new TextEncoder().encode(s).length;
export async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const pkgKey = (name, version) => `_pkg/${name}@${version}.js`;
const innerKey = (name, version, path) => `_pkg/${name}@${version}/${path}`;

const parse = (source, where) => {
  try { return acorn.parse(source, { ecmaVersion: 2022, sourceType: "module" }); }
  catch (e) { fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${where}: not a parseable ES module (${e.message})`); }
};

function walk(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const k in node) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn));
    else if (v && typeof v === "object" && typeof v.type === "string") walk(v, fn);
  }
}

const sourceNodes = (ast) => ast.body.filter((n) =>
  n.type === "ImportDeclaration" || n.type === "ExportAllDeclaration" || (n.type === "ExportNamedDeclaration" && n.source));

/** Relative path inside a package; refuses anything that escapes the package root. */
function resolveInside(from, spec, where) {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") { if (!dir.length) fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${where}: import '${spec}' escapes the package`); dir.pop(); }
    else dir.push(seg);
  }
  return dir.join("/");
}
const candidates = (p) => [p, `${p}.js`, `${p}.mjs`, `${p}/index.js`, `${p}/index.mjs`];

/**
 * Parses one module, refuses unsupported features and rewrites its import sources (by AST range)
 * to loader markers. resolveSpec(spec) returns the dependency's module key or throws.
 */
export async function normalizeModule(source, { key, resolveSpec }) {
  if (!KEY_RE.test(key)) fail(422, "PACKAGE_MODULE_UNSUPPORTED", `invalid module key ${key}`);
  if (bytes(source) > MODULE_LIMITS.module_bytes) fail(413, "PACKAGE_MODULE_TOO_LARGE", `${key}: module exceeds ${MODULE_LIMITS.module_bytes} bytes`);
  if (source.includes("%%MOD:") || source.includes(`${MARKER}_pkg/`)) fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${key}: contains a reserved loader marker`);
  const ast = parse(source, key);
  walk(ast, (n) => {
    const bad = n.type === "ImportExpression" ? "dynamic import()"
      : n.type === "MetaProperty" && n.meta?.name === "import" ? "import.meta"
      : n.type === "CallExpression" && n.callee?.type === "Identifier" && n.callee.name === "require" ? "require()"
      : n.type === "MemberExpression" && n.object?.type === "Identifier" && n.object.name === "module" && (n.property?.name === "exports" || n.property?.value === "exports") ? "module.exports"
      : n.type === "AssignmentExpression" && n.left?.type === "MemberExpression" && n.left.object?.type === "Identifier" && n.left.object.name === "exports" ? "exports.* assignment"
      : null;
    if (bad) fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${key}: ${bad} is not supported in browser package modules`);
  });
  const sources = sourceNodes(ast).map((n) => n.source);
  const deps = [];
  let code = source;
  for (const lit of [...sources].sort((a, b) => b.start - a.start)) {
    const dep = resolveSpec(String(lit.value));
    deps.unshift(dep);
    code = code.slice(0, lit.start) + JSON.stringify(MARKER + dep) + code.slice(lit.end);
  }
  if (code.split(`"${MARKER}_pkg/`).length - 1 !== sources.length) fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${key}: marker count mismatch`);
  const exportNames = new Set();
  let star = false;
  for (const n of ast.body) {
    if (n.type === "ExportAllDeclaration") star = true;
    if (n.type === "ExportNamedDeclaration") {
      for (const s of n.specifiers || []) exportNames.add(s.exported.name ?? s.exported.value);
      const d = n.declaration;
      if (d?.id?.name) exportNames.add(d.id.name);
      for (const v of d?.declarations || []) if (v.id?.name) exportNames.add(v.id.name);
    }
  }
  return { key, code, deps: [...new Set(deps)], digest: await sha256(code), exports: [...exportNames], star };
}

// --- registry bytes: private storage --------------------------------------------------

/** At resolution time: keep the verified archive's reachable ESM files privately. Never throws. */
export async function storeModuleBundle(svc, files, entryPath) {
  try {
    if (!entryPath) return { module_status: "unsupported", module_error: "no entry module" };
    const byPath = new Map(files.map((f) => [f.path, f]));
    const out = {};
    let total = 0;
    const queue = [entryPath];
    while (queue.length) {
      const path = queue.shift();
      if (out[path] !== undefined) continue;
      const f = byPath.get(path);
      if (!f) return { module_status: "unsupported", module_error: `missing ${path}` };
      const text = new TextDecoder().decode(f.body);
      total += bytes(text);
      if (total > MODULE_LIMITS.total_bytes || Object.keys(out).length >= MODULE_LIMITS.modules) return { module_status: "unsupported", module_error: "package module graph exceeds the size cap" };
      out[path] = text;
      const ast = acorn.parse(text, { ecmaVersion: 2022, sourceType: "module" });
      for (const lit of sourceNodes(ast).map((n) => n.source)) {
        const spec = String(lit.value);
        if (!spec.startsWith(".")) continue;
        const target = candidates(resolveInside(path, spec, path)).find((c) => byPath.has(c));
        if (!target) return { module_status: "unsupported", module_error: `${path}: cannot resolve ${spec}` };
        queue.push(target);
      }
    }
    const json = JSON.stringify({ entry: entryPath, files: out });
    const stored = await svc.integrations.Core.UploadPrivateFile({ file: new File([json], "package-modules.json", { type: "application/json" }) });
    return { module_status: "ready", module_bundle_uri: stored.file_uri, module_bundle_sha256: await sha256(json) };
  } catch (e) {
    return { module_status: "unsupported", module_error: String(e.message || e).slice(0, 300) };
  }
}

async function loadRegistryBundle(svc, p) {
  const [entry] = await svc.entities.PackageCacheEntry.filter({ cache_key: cacheKey(p.name, p.version, p.integrity) }, "-created_date", 1).catch(() => []);
  if (!entry || entry.module_status !== "ready" || !entry.module_bundle_uri) {
    fail(422, "PACKAGE_MODULE_UNAVAILABLE", `${p.name}@${p.version} has no browser module${entry?.module_error ? `: ${entry.module_error}` : " (re-resolve the package)"}`);
  }
  if (p.content_sha512 && entry.content_sha512 !== p.content_sha512) fail(422, "PACKAGE_MODULE_DIGEST_MISMATCH", `${p.name}@${p.version}: cached content differs from the lockfile`);
  const { signed_url } = await svc.integrations.Core.CreateFileSignedUrl({ file_uri: entry.module_bundle_uri, expires_in: 60 });
  const res = await fetch(signed_url);
  if (!res.ok) fail(503, "PACKAGE_MODULE_UNAVAILABLE", `${p.name}@${p.version}: stored module could not be read`);
  const text = await res.text();
  if (await sha256(text) !== entry.module_bundle_sha256) fail(422, "PACKAGE_MODULE_DIGEST_MISMATCH", `${p.name}@${p.version}: stored module bytes failed their digest`);
  return JSON.parse(text);
}

// --- the one producer ------------------------------------------------------------------

/**
 * Lockfile-pinned packages → { imports: {name: key}, modules: [{key, code, deps, digest}], digest }.
 * Returns null when the lockfile pins nothing. loadBundle is injectable for certification only.
 */
export async function packageModules(svc, files, { loadBundle = loadRegistryBundle } = {}) {
  const packages = installedPackages(files);
  if (!packages.length) return null;
  const pinned = new Map(packages.map((p) => [p.name, p]));
  const bare = (spec, where) => {
    const p = pinned.get(spec);
    if (!p) fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${where}: import '${spec}' is not a lockfile-pinned package`);
    return pkgKey(p.name, p.version);
  };
  const pending = new Map(); // key -> { source, resolveSpec, pkg }
  for (const p of packages) {
    const key = pkgKey(p.name, p.version);
    if (p.content_sha512) {
      const bundle = await loadBundle(svc, p);
      for (const [path, source] of Object.entries(bundle.files || {})) {
        const k = path === bundle.entry ? key : innerKey(p.name, p.version, path);
        pending.set(k, {
          pkg: p, entry: path === bundle.entry, source,
          resolveSpec: (spec) => {
            if (!spec.startsWith(".")) return bare(spec, k);
            const target = candidates(resolveInside(path, spec, k)).find((c) => bundle.files[c] !== undefined);
            if (!target) fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${k}: cannot resolve ${spec}`);
            return target === bundle.entry ? key : innerKey(p.name, p.version, target);
          },
        });
      }
      if (!pending.has(key)) fail(422, "PACKAGE_MODULE_UNAVAILABLE", `${p.name}@${p.version}: stored bundle has no entry module`);
    } else {
      const source = curatedModuleSource(p.name, p.version);
      if (source == null) fail(422, "PACKAGE_MODULE_UNAVAILABLE", `${p.name}@${p.version} has no curated module source`);
      pending.set(key, {
        pkg: p, entry: true, source,
        resolveSpec: (spec) => (spec.startsWith(".") ? fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${key}: relative imports are not allowed in curated modules`) : bare(spec, key)),
      });
    }
  }
  if (pending.size > MODULE_LIMITS.modules) fail(413, "PACKAGE_MODULE_TOO_LARGE", `more than ${MODULE_LIMITS.modules} package modules`);
  const modules = [];
  let total = 0;
  for (const [key, item] of pending) {
    const m = await normalizeModule(item.source, { key, resolveSpec: item.resolveSpec });
    if (item.entry && !m.star) {
      const missing = item.pkg.exports.filter((x) => !m.exports.includes(x));
      if (missing.length) fail(422, "PACKAGE_EXPORTS_MISMATCH", `${item.pkg.name}@${item.pkg.version} does not export ${missing.join(", ")}`);
    }
    total += bytes(m.code);
    if (total > MODULE_LIMITS.total_bytes) fail(413, "PACKAGE_MODULE_TOO_LARGE", `package modules exceed ${MODULE_LIMITS.total_bytes} bytes in total`);
    modules.push({ key: m.key, code: m.code, deps: m.deps, digest: m.digest });
  }
  for (const m of modules) for (const d of m.deps) if (!pending.has(d)) fail(422, "PACKAGE_MODULE_UNSUPPORTED", `${m.key}: missing dependency ${d}`);
  modules.sort((a, b) => (a.key < b.key ? -1 : 1));
  const imports = Object.fromEntries(packages.map((p) => [p.name, pkgKey(p.name, p.version)]));
  return { imports, modules, total_bytes: total, digest: await aggregateDigest(imports, modules) };
}

const aggregateDigest = (imports, modules) => sha256(JSON.stringify({ imports, modules: modules.map((m) => [m.key, m.digest]) }));

/** Deploy pin gate: the shipped package modules must match the shipped lockfile and their digests. */
export async function verifyPackageModules(pm, packages) {
  if (!packages.length) return pm ? { ok: false, error: "package modules ship without pinned packages" } : { ok: true };
  if (!pm || !Array.isArray(pm.modules)) return { ok: false, error: "the artifact pins packages but ships no package modules" };
  const byKey = new Map(pm.modules.map((m) => [m.key, m]));
  let total = 0;
  for (const p of packages) {
    const key = pkgKey(p.name, p.version);
    if (pm.imports?.[p.name] !== key || !byKey.has(key)) return { ok: false, error: `no module for ${p.name}@${p.version}` };
  }
  for (const m of pm.modules) {
    if (!KEY_RE.test(m.key)) return { ok: false, error: `invalid module key ${m.key}` };
    if (await sha256(m.code) !== m.digest) return { ok: false, error: `module digest mismatch for ${m.key}` };
    if (bytes(m.code) > MODULE_LIMITS.module_bytes) return { ok: false, error: `${m.key} exceeds the module size cap` };
    total += bytes(m.code);
    for (const d of m.deps || []) if (!byKey.has(d)) return { ok: false, error: `${m.key} depends on missing ${d}` };
  }
  if (total > MODULE_LIMITS.total_bytes) return { ok: false, error: "package modules exceed the total size cap" };
  if (await aggregateDigest(pm.imports, pm.modules) !== pm.digest) return { ok: false, error: "package module set digest mismatch" };
  return { ok: true, count: pm.modules.length };
}

/** Builder preview endpoint: the same producer, authorized against the project. */
export async function previewPackageModules(base44, user, { project_id } = {}) {
  if (!user) fail(401, "AUTH_REQUIRED", "Unauthorized");
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const { files } = await loadProjectState(base44, project.id);
  const svc = base44.asServiceRole || base44;
  return { package_modules: await packageModules(svc, files) };
}