// B5 certification C1–C11 — the shared package-module path (packageModules / normalizeModule /
// verifyPackageModules / storage digest read). Module-level: the browser loader lives in src/ and
// cannot be imported here, so execution (C1/C3) replays the loader's exact marker swap and runs the
// module graph in the platform's existing sandboxed interpreter (jsInterp).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { packageModules, normalizeModule, verifyPackageModules, storeModuleBundle, previewPackageModules, pkgKey, sha256, MODULE_LIMITS } from "../../shared/packageModules.ts";
import { installedPackages } from "../../shared/packageLock.ts";
import { cacheKey } from "../../shared/packageSupply.ts";
import { createInterpreter, parseModule } from "../../shared/jsInterp.ts";

const lockFiles = (packages) => [{ path: "package.lock.json", content: JSON.stringify({ lockfile_version: 1, packages }) }];

// Same substitution the shared loader performs (exact "nx:<dep>" literal → module reference).
async function execute(pm, entryKey) {
  const byKey = new Map(pm.modules.map((m) => [m.key, m]));
  const cache = new Map();
  const load = async (key) => {
    if (cache.has(key)) return cache.get(key);
    const m = byKey.get(key);
    if (!m) throw new Error(`unknown module ${key}`);
    let code = m.code;
    for (const dep of m.deps) code = code.split(JSON.stringify("nx:" + dep)).join(JSON.stringify(dep));
    const interp = createInterpreter({ resolveModule: (spec) => load(spec) });
    const ns = await interp.runModule(parseModule(code));
    cache.set(key, ns);
    return ns;
  };
  return (await load(entryKey)).named;
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let fixture = null;
  try {
    const me = await base44.auth.me().catch(() => null);
    if (me?.role !== "admin") return Response.json({ error: "Admin only" }, { status: 403 });

    // C1 — curated package with a transitive curated dependency executes.
    const curated = lockFiles([
      { name: "@nexus/currency", version: "1.0.0", exports: ["formatMoney"] },
      { name: "@nexus/decimal", version: "1.2.0", exports: ["add", "subtract", "multiply", "divide"], relation: "transitive" },
    ]);
    const pm = await packageModules(svc, curated);
    const cur = pm.modules.find((m) => m.key === pkgKey("@nexus/currency", "1.0.0"));
    h.check("C1a curated modules produced with pinned keys", pm.modules.length === 2 && cur?.deps[0] === pkgKey("@nexus/decimal", "1.2.0"), pm.modules.map((m) => m.key).join(","));
    let ran = null;
    try { ran = await (await execute(pm, cur.key)).formatMoney(1234.5); } catch (e) { ran = `ERR ${e.message}`; }
    h.check("C1b curated package code executes (formatMoney)", ran === "1,234.50 USD", String(ran));

    // C2 — deploy gate accepts exactly what the shared producer emits for the same lockfile.
    const ok = await verifyPackageModules(pm, installedPackages(curated));
    h.check("C2 deploy pin gate verifies the produced module set", ok.ok === true && ok.count === 2, JSON.stringify(ok));

    // C3 — registry package: internal relative file + transitive registry dependency.
    const regLock = lockFiles([
      { name: "reg-a", version: "1.0.0", exports: ["hello"], integrity: "sha512-a", content_sha512: "a" },
      { name: "reg-b", version: "2.1.0", exports: ["shout"], integrity: "sha512-b", content_sha512: "b", relation: "transitive" },
    ]);
    const bundles = {
      "reg-a": { entry: "index.js", files: { "index.js": `import { greet } from "./lib/greet.js";\nimport { shout } from "reg-b";\nexport function hello(n) { return shout(greet(n)); }`, "lib/greet.js": `export const greet = (n) => "hi " + n;` } },
      "reg-b": { entry: "index.js", files: { "index.js": `export function shout(s) { return s.toUpperCase(); }` } },
    };
    const reg = await packageModules(svc, regLock, { loadBundle: async (_s, p) => bundles[p.name] });
    const a = reg.modules.find((m) => m.key === pkgKey("reg-a", "1.0.0"));
    h.check("C3a registry deps resolve to exact pinned keys", !!a && a.deps.includes("_pkg/reg-a@1.0.0/lib/greet.js") && a.deps.includes(pkgKey("reg-b", "2.1.0")), JSON.stringify(a?.deps));
    let ran2 = null;
    try { ran2 = await (await execute(reg, a.key)).hello("bo"); } catch (e) { ran2 = `ERR ${e.message}`; }
    h.check("C3b registry graph executes", ran2 === "HI BO", String(ran2));

    // C4 — tampering is refused: module text at the deploy gate, and stored bytes on read.
    const tampered = { ...pm, modules: pm.modules.map((m, i) => (i === 0 ? { ...m, code: m.code + "\n//x" } : m)) };
    const t = await verifyPackageModules(tampered, installedPackages(curated));
    h.check("C4a tampered module text fails the deploy gate", !t.ok && /digest mismatch/.test(t.error || ""), t.error);
    const sealed = await storeModuleBundle(svc, [{ path: "index.js", body: new TextEncoder().encode("export const v = 1;") }], "index.js");
    const fx = { name: "b5-cert-fixture", version: "0.0.1", exports: ["v"], integrity: `sha512-b5cert-${crypto.randomUUID()}`, content_sha512: "b5cert" };
    fixture = await svc.entities.PackageCacheEntry.create({ cache_key: cacheKey(fx.name, fx.version, fx.integrity), package_name: fx.name, version: fx.version, integrity: fx.integrity, content_sha512: "b5cert", ...sealed });
    const fxFiles = lockFiles([fx]);
    const good = await packageModules(svc, fxFiles);
    h.check("C4b stored private bundle reads back digest-verified", sealed.module_status === "ready" && good?.modules.length === 1, `${sealed.module_status} ${sealed.module_error || ""}`);
    h.check("C4c no storage handle in produced output", !!sealed.module_bundle_uri && !JSON.stringify(good).includes(sealed.module_bundle_uri), "module text only");
    await svc.entities.PackageCacheEntry.update(fixture.id, { module_bundle_sha256: "0".repeat(64) });
    await h.expectThrow("C4d altered stored digest is refused", () => packageModules(svc, fxFiles), "PACKAGE_MODULE_DIGEST_MISMATCH");

    // C5 — unsupported module features are rejected at build time.
    const unpinned = (s) => { throw Object.assign(new Error(`unpinned ${s}`), { code: "PACKAGE_MODULE_UNSUPPORTED" }); };
    const reject = (name, src) => h.expectThrow(`C5 rejects ${name}`, () => normalizeModule(src, { key: "_pkg/x@1.0.0.js", resolveSpec: unpinned }), "PACKAGE_MODULE_UNSUPPORTED");
    await reject("dynamic import()", `export const f = () => import("y");`);
    await reject("require()", `const y = require("y"); export { y };`);
    await reject("module.exports", `module.exports = {};`);
    await reject("exports.* assignment", `exports.a = 1;`);
    await reject("import.meta", `export const u = import.meta.url;`);
    await h.expectThrow("C5 rejects node built-in", () => packageModules(svc, regLock, { loadBundle: async (_s, p) => (p.name === "reg-b" ? { entry: "index.js", files: { "index.js": `import fs from "node:fs"; export const shout = 1;` } } : bundles[p.name]) }), "PACKAGE_MODULE_UNSUPPORTED");
    await h.expectThrow("C5 rejects unpinned bare import", () => packageModules(svc, regLock, { loadBundle: async (_s, p) => (p.name === "reg-b" ? { entry: "index.js", files: { "index.js": `import "left-pad"; export const shout = 1;` } } : bundles[p.name]) }), "PACKAGE_MODULE_UNSUPPORTED");
    await h.expectThrow("C5 rejects package-root escape", () => packageModules(svc, regLock, { loadBundle: async (_s, p) => (p.name === "reg-b" ? { entry: "index.js", files: { "index.js": `import "../../x.js"; export const shout = 1;` } } : bundles[p.name]) }), "PACKAGE_MODULE_UNSUPPORTED");
    await h.expectThrow("C5 rejects lockfile exports the module lacks", () => packageModules(svc, lockFiles([{ name: "@nexus/slugify", version: "1.0.0", exports: ["slugify", "nope"] }])), "PACKAGE_EXPORTS_MISMATCH");

    // C6 — a lockfile/module version mismatch fails the gate.
    const shifted = installedPackages(curated).map((p) => (p.name === "@nexus/decimal" ? { ...p, version: "2.0.0" } : p));
    const v = await verifyPackageModules(pm, shifted);
    h.check("C6a version mismatch fails the deploy gate", !v.ok && /@nexus\/decimal@2\.0\.0/.test(v.error || ""), v.error);
    const v2 = await verifyPackageModules(null, installedPackages(curated));
    h.check("C6b pinned packages without modules fail the gate", !v2.ok, v2.error);

    // C8 — per-module and total size caps.
    await h.expectThrow("C8a per-module cap", () => normalizeModule(`export const s = "${"a".repeat(MODULE_LIMITS.module_bytes)}";`, { key: "_pkg/x@1.0.0.js", resolveSpec: unpinned }), "PACKAGE_MODULE_TOO_LARGE");
    const big = (i) => `export const s${i} = "${"b".repeat(MODULE_LIMITS.module_bytes - 100)}";`;
    const files = Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`f${i}.js`, big(i)]));
    files["index.js"] = [0, 1, 2, 3, 4, 5].map((i) => `export * from "./f${i}.js";`).join("\n");
    await h.expectThrow("C8b total cap", () => packageModules(svc, lockFiles([{ name: "reg-big", version: "1.0.0", exports: [], integrity: "sha512-z", content_sha512: "z" }]), { loadBundle: async () => ({ entry: "index.js", files }) }), "PACKAGE_MODULE_TOO_LARGE");

    // C9 — a project without packages is unchanged.
    const none = await packageModules(svc, [{ path: "src/main.js", content: "export default 1;" }]);
    const noneGate = await verifyPackageModules(null, []);
    h.check("C9 no lockfile → no modules, gate passes", none === null && noneGate.ok === true, String(none));

    // C10 — loader markers and import-like comments/strings.
    await reject("reserved nx:_pkg/ text", `export const s = "nx:_pkg/evil.js";`);
    await reject("reserved %%MOD: text", `export const s = "%%MOD:src/main.js%%";`);
    const commented = await normalizeModule(`// import "not-real"\nconst s = 'import "also-not"';\nexport { s };`, { key: "_pkg/x@1.0.0.js", resolveSpec: unpinned });
    h.check("C10 comments/strings that look like imports are left untouched", commented.deps.length === 0 && commented.code.includes(`'import "also-not"'`), commented.code.slice(0, 60));

    // C11 — preview and deploy parity: one producer, byte-identical output; endpoint is authorized.
    const again = await packageModules(svc, curated);
    h.check("C11a repeated production is byte-identical", again.digest === pm.digest && JSON.stringify(again) === JSON.stringify(pm), pm.digest.slice(0, 16));
    await h.expectThrow("C11b preview endpoint requires a user", () => previewPackageModules(base44, null, { project_id: "x" }), "AUTH_REQUIRED");
    h.check("C11c digest helper is SHA-256 hex", (await sha256("")).startsWith("e3b0c442"), "ok");
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    if (fixture) await svc.entities.PackageCacheEntry.delete(fixture.id).catch(() => {});
    const left = fixture ? await svc.entities.PackageCacheEntry.count({ package_name: "b5-cert-fixture" }).catch(() => -1) : 0;
    h.check("cleanup verified (0 fixtures left)", left === 0, String(left));
  }
  return harnessResponse(h);
}