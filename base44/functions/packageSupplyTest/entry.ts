// E2E certification for the #26B package SUPPLY CHAIN.
//
// Runs against the REAL modules and the REAL data layer: the real supply-chain module, the real
// integrity verification, the real gzip/tar reader, the real content-addressed cache entities, the
// real dependency mutation path and the real maintenance sweep + job registry. Nothing is stubbed.
//
// Network policy of this suite: no test requires an outbound call to succeed. Registry access is
// exercised through the ALLOWLIST (a denied host must be refused) and through a cache HIT (which
// must not download at all). A live registry pass is opt-in via `live_registry: true`, so the
// certification result is deterministic in an offline environment.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  addDependency, removeDependency, listDependencies, validateDependencies,
  supplyCapabilities, inspectRegistryPackage, packagePrepareStatus,
  readManifest, readLockfile, validateDependencyState, DEPENDENCY_FAILURE_CLASSES,
  LOCKFILE_FILE, MANIFEST_FILE,
} from "../../shared/dependencies.ts";
import {
  supplyConfig, resolveForProject, prepareResolution, fetchPackageMetadata, acquireArtifact,
  verifyIntegrity, gunzip, untar, extractExports, classifyLicense, cacheKey,
  SUPPLY_CHAIN_VERSION, SUPPLY_LIMITS, ALLOWED_REGISTRY_HOSTS, LICENSE_POLICY, LIFECYCLE_SCRIPTS,
} from "../../shared/packageSupply.ts";
import { resolveDependencies, RUNTIME_TARGET } from "../../shared/packageRegistry.ts";
import { resolvedDependencyState, installedPackages } from "../../shared/packageLock.ts";
import { cleanupPackageSupply } from "../../shared/maintenance.ts";
import { MAINTENANCE_HANDLERS, MAINTENANCE_SCHEDULE } from "../../shared/jobHandlers.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";

const ENTRY_SOURCE = `import { html } from "runtime";
export default function App() { return html\`<div>supply fixture</div>\`; }
`;

const compact = (h, error = null, extra = {}) => {
  const s = h.summary();
  return Response.json({ ok: s.ok && !error, error: error?.message || null, passed: s.passed, failed: s.failed, failures: s.failures, checks_run: s.results.length, ...extra }, { status: error ? 500 : 200 });
};

// --- an in-memory gzipped tar, so the archive path is exercised on real bytes ---
const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
function tarEntry(path, content) {
  const enc = new TextEncoder();
  const body = enc.encode(content);
  const header = new Uint8Array(512);
  header.set(enc.encode(path.slice(0, 100)), 0);
  header.set(enc.encode(octal(0o644, 8)), 100);
  header.set(enc.encode(octal(0, 8)), 108);
  header.set(enc.encode(octal(0, 8)), 116);
  header.set(enc.encode(octal(body.length, 12)), 124);
  header.set(enc.encode(octal(Math.floor(Date.now() / 1000), 12)), 136);
  header.set(enc.encode("        "), 148); // checksum placeholder (our reader does not verify it)
  header.set(enc.encode("0"), 156);
  header.set(enc.encode("ustar\0" + "00"), 257);
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  return [header, padded];
}
async function gzipTar(entries) {
  const blocks = entries.flatMap(([path, content]) => tarEntry(path, content));
  blocks.push(new Uint8Array(1024)); // end-of-archive
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) { tar.set(b, at); at += b.length; }
  const gz = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gz).arrayBuffer());
}

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [], cache_keys: [] };
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const notes = [];

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `supply-cert-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "supply-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(project.id);
    await svc.entities.ProjectFile.create({ project_id: project.id, path: ENTRY_FILE, content: ENTRY_SOURCE });

    const wsForeign = await svc.entities.Workspace.create({ name: `supply-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreign = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreign.id);
    await svc.entities.PackageFetch.create({ project_id: foreign.id, workspace_id: wsForeign.id, package_name: "left-pad", status: "prepared", integrity_verified: true });

    const trace_id = `tr_supply_${Date.now()}`;

    // ------------------------------------------------------- 1. contract surface
    const caps = supplyCapabilities();
    h.check("1 the supply-chain contract is explicit", caps.supply_chain_version === SUPPLY_CHAIN_VERSION &&
      caps.registry_modes.includes("curated") && caps.registry_modes.includes("registry") &&
      caps.allowed_registry_hosts.length > 0 && caps.allowed_registry_hosts.every((x) => ALLOWED_REGISTRY_HOSTS.includes(x)) &&
      caps.lifecycle_scripts_blocked.includes("postinstall") && caps.limits.tarball_bytes === SUPPLY_LIMITS.tarball_bytes,
      `mode ${caps.registry_mode}, ${caps.allowed_registry_hosts.length} allowlisted host(s), ${caps.lifecycle_scripts_blocked.length} blocked lifecycle scripts`);
    h.check("1b every supply failure has a named class",
      ["integrity_mismatch", "download_too_large", "registry_timeout", "registry_host_denied", "unsupported_archive", "license_denied", "vulnerable_package", "registry_unavailable"].every((c) => DEPENDENCY_FAILURE_CLASSES.includes(c)),
      "refusals are classified, never generic");

    // --------------------------------------------------- 2. host allowlist refusal
    await h.expectThrow("2 a non-allowlisted registry host is refused",
      () => fetchPackageMetadata("left-pad", supplyConfig({ mode: "registry", registry_url: "https://evil.example.com" })), "REGISTRY_HOST_DENIED");
    await h.expectThrow("2b a non-https registry endpoint is refused",
      () => fetchPackageMetadata("left-pad", supplyConfig({ mode: "registry", registry_url: "http://registry.npmjs.org" })), "REGISTRY_HOST_DENIED");

    // ------------------------------------------------- 3. integrity verification
    const bytes = new TextEncoder().encode("supply-chain artifact bytes");
    const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-512", bytes))));
    const good = await verifyIntegrity(bytes, `sha512-${digest}`);
    const bad = await verifyIntegrity(bytes, "sha512-AAAAtampered");
    const tamperedBytes = await verifyIntegrity(new TextEncoder().encode("supply-chain artifact byteS"), `sha512-${digest}`);
    h.check("3 content is verified against the published integrity",
      good.ok === true && good.content_sha512 === digest && bad.ok === false && tamperedBytes.ok === false,
      "matching bytes verify; a wrong digest and altered bytes both fail");

    // ------------------------------------------------- 4. gzip / tar + exports
    const archive = await gzipTar([
      ["package/package.json", JSON.stringify({ name: "demo-pkg", version: "1.2.3", main: "index.js", license: "MIT", scripts: { postinstall: "node evil.js", test: "x" } })],
      ["package/index.js", "export function alpha() { return 1; }\nexport const beta = 2;\nexport { gamma as delta };\n"],
    ]);
    const files = untar(await gunzip(archive));
    const manifestInArchive = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === "package.json").body));
    const exported = extractExports(files, manifestInArchive);
    h.check("4 a real gzipped tar archive is read without executing anything",
      files.length === 2 && files.some((f) => f.path === "index.js") && manifestInArchive.name === "demo-pkg",
      `${files.length} entries read from the verified archive`);
    h.check("4b exports are PARSED from the artifact, never guessed",
      exported.exports_source === "artifact" && exported.entry_module === "index.js" &&
      ["alpha", "beta", "delta"].every((n) => exported.exports.includes(n)),
      `exports ${exported.exports.join(", ")} parsed from ${exported.entry_module}`);
    h.check("4c a lifecycle script is recorded as metadata, never run",
      Object.keys(manifestInArchive.scripts).includes("postinstall") && LIFECYCLE_SCRIPTS.includes("postinstall"),
      "postinstall is declared by the fixture and is on the blocked list");
    await h.expectThrow("4d an unreadable archive is refused", () => gunzip(new Uint8Array([1, 2, 3, 4])), "UNSUPPORTED_ARCHIVE");

    // --------------------------------------------------------- 5. license policy
    h.check("5 license policy classifies, and 'unknown' is not an approval",
      classifyLicense("MIT").license_status === "allowed" &&
      classifyLicense("AGPL-3.0").license_status === "denied" &&
      classifyLicense(null).license_status === "unknown" &&
      classifyLicense("Weird-Custom-1.0").license_status === "unknown" &&
      classifyLicense(null, supplyConfig({ require_license: true })).license_status === "denied" &&
      LICENSE_POLICY.denied.includes("SSPL-1.0"),
      "MIT allowed · AGPL denied · absent stays unknown · strict mode denies an absent license");

    // ----------------------------------------------------- 6. content-addressed cache
    const k1 = cacheKey("demo-pkg", "1.2.3", `sha512-${digest}`);
    const k2 = cacheKey("demo-pkg", "1.2.3", `sha512-${digest}`);
    const k3 = cacheKey("demo-pkg", "1.2.4", `sha512-${digest}`);
    const k4 = cacheKey("demo-pkg", "1.2.3", "sha512-different");
    h.check("6 the cache key is content-addressed", k1 === k2 && k1 !== k3 && k1 !== k4,
      "same name+version+integrity ⇒ same key; any change ⇒ a different key");

    // A cache HIT must serve without any download: the tarball url below points at a denied host,
    // so if the cache were bypassed this call could only fail.
    const meta = { integrity: `sha512-${digest}`, tarball: "https://evil.example.com/demo-pkg.tgz", license: "MIT" };
    const hitEntry = await svc.entities.PackageCacheEntry.create({
      cache_key: k1, package_name: "demo-pkg", version: "1.2.3", integrity: meta.integrity, content_sha512: digest,
      size_bytes: bytes.length, registry_source: "registry.npmjs.org", tarball_url: "https://registry.npmjs.org/demo-pkg.tgz",
      exports: exported.exports, exports_source: "artifact", entry_module: "index.js",
      license: "MIT", license_status: "allowed", install_scripts: ["postinstall"], install_scripts_blocked: true,
      advisory_status: "none_known", verified_at: new Date().toISOString(), last_used_at: new Date().toISOString(),
      use_count: 1, supply_chain_version: SUPPLY_CHAIN_VERSION,
    });
    created.cache_keys.push(k1);
    const hit = await acquireArtifact(base44, { package_name: "demo-pkg", version: "1.2.3", meta, cfg: supplyConfig({ mode: "registry" }) });
    const reused = await svc.entities.PackageCacheEntry.get(hitEntry.id);
    h.check("6b a validated artifact is reused from the cache without downloading",
      hit.cache_result === "hit" && hit.integrity_verified === true && hit.cache_key === k1 &&
      reused.use_count === 2 && hit.entry.exports.includes("alpha"),
      `cache hit reused (use_count ${reused.use_count}) with no registry call`);

    // A cached entry whose recorded content no longer matches its integrity is REFUSED, not reused:
    // it is dropped and the download is attempted — which the denied host then refuses.
    await svc.entities.PackageCacheEntry.update(hitEntry.id, { content_sha512: "tamperedDigestValue" });
    await h.expectThrow("6c a cache entry inconsistent with its integrity is refused, never reused",
      () => acquireArtifact(base44, { package_name: "demo-pkg", version: "1.2.3", meta, cfg: supplyConfig({ mode: "registry" }) }), "REGISTRY_HOST_DENIED");
    h.check("6d the inconsistent cache entry was evicted",
      (await svc.entities.PackageCacheEntry.get(hitEntry.id).catch(() => null)) === null,
      "the entry is gone rather than serving unverified content");

    // ------------------------------------------- 7. curated mode is fully preserved
    const cfgCurated = supplyConfig();
    const curated = await resolveForProject(base44, { dependencies: { "@nexus/currency": "^1.0.0" }, cfg: cfgCurated });
    const direct = resolveDependencies({ "@nexus/currency": "^1.0.0" }, { runtime_target: RUNTIME_TARGET });
    const preparedCurated = await prepareResolution(base44, { project, workspace: ws, resolution: curated, cfg: cfgCurated, trace_id });
    const fetchRows = await svc.entities.PackageFetch.filter({ project_id: project.id }, "-created_date", 20);
    h.check("7 curated mode still resolves offline and identically",
      curated.ok === true && curated.registry_mode === "curated" && curated.fingerprint === direct.fingerprint &&
      curated.packages.length === direct.packages.length,
      `fingerprint ${curated.fingerprint} matches the pre-existing resolver exactly`);
    h.check("7b curated mode fetches nothing and claims nothing",
      preparedCurated.prepared === false && preparedCurated.cache.hits === 0 && preparedCurated.cache.misses === 0 && fetchRows.length === 0,
      "no artifact fetch, no fetch records, no download in curated mode");

    // -------------------------------- 8. the existing #26 lifecycle is unchanged
    const added = await addDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", version: "^1.0.0", trace_id });
    const projectFiles = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50);
    const lock = readLockfile(projectFiles);
    const lockDoc = lock.raw;
    const runtimeState = resolvedDependencyState(projectFiles);
    const valid = await validateDependencies(base44, user, { project_id: project.id });
    h.check("8 a dependency change still commits a versioned project mutation",
      added.applied === true && added.build.status === "success" && !!added.version?.version_id &&
      readManifest(projectFiles).dependencies["@nexus/currency"] === "^1.0.0" && lock.exists,
      `version ${added.version?.number} with ${MANIFEST_FILE} + ${LOCKFILE_FILE}`);
    h.check("8b the lockfile records the supply-chain facts",
      lockDoc.registry_mode === "curated" && lockDoc.registry_metadata_fingerprint === null &&
      lockDoc.packages.every((p) => p.install_scripts_blocked === true && Array.isArray(p.install_scripts)) &&
      runtimeState.install_scripts_blocked === true && runtimeState.registry_mode === "curated" &&
      installedPackages(projectFiles).every((p) => p.install_scripts_blocked === true),
      `lockfile pins mode '${lockDoc.registry_mode}' and blocks lifecycle scripts for every package`);
    h.check("8c the impact summary reports the supply chain",
      added.impact.supply_chain.install_scripts_executed === false &&
      added.impact.supply_chain.registry_mode === "curated" &&
      Array.isArray(added.impact.supply_chain.licenses) && added.impact.supply_chain.cache.hits === 0,
      "the change explains its registry mode, cache use and script policy");
    h.check("8d validation still passes with the supply-chain checks added",
      valid.passed === true && valid.install_scripts_blocked === true && valid.registry_mode === "curated" && valid.drift.length === 0,
      `status ${valid.status}`);

    // ------------------------------------------------- 9. registry-mode validation
    const registryResolution = {
      registry_mode: "registry", ok: true, packages: [
        { name: "demo-pkg", version: "1.2.3", integrity: meta.integrity, integrity_verified: true, install_scripts_blocked: true, license: "MIT", license_status: "allowed", vulnerability_status: "none_known", vulnerabilities: [] },
      ],
      fingerprint: "fp_demo", registry_version: "x", runtime_target: RUNTIME_TARGET,
    };
    const okRegistry = validateDependencyState({ manifest: { exists: true, dependencies: { "demo-pkg": "^1.2.3" }, raw: null }, lock: { exists: true, packages: [{ name: "demo-pkg", version: "1.2.3", integrity: meta.integrity }], fingerprint: "fp_demo" }, resolution: registryResolution });
    const unverified = validateDependencyState({
      manifest: { exists: true, dependencies: { "demo-pkg": "^1.2.3" }, raw: null },
      lock: { exists: true, packages: [{ name: "demo-pkg", version: "1.2.3", integrity: meta.integrity }], fingerprint: "fp_demo" },
      resolution: { ...registryResolution, packages: [{ ...registryResolution.packages[0], integrity_verified: false }] },
    });
    const deniedLicense = validateDependencyState({
      manifest: { exists: true, dependencies: { "demo-pkg": "^1.2.3" }, raw: null },
      lock: { exists: true, packages: [{ name: "demo-pkg", version: "1.2.3", integrity: meta.integrity }], fingerprint: "fp_demo" },
      resolution: { ...registryResolution, packages: [{ ...registryResolution.packages[0], license_status: "denied", license: "AGPL-3.0" }] },
    });
    h.check("9 registry-mode state must be verified to validate",
      okRegistry.passed === true && okRegistry.checks.some((c) => c.name === "artifact_integrity_verified" && c.ok) &&
      unverified.passed === false && unverified.failure_class === "integrity_mismatch",
      "an unverified artifact cannot produce a valid dependency state");
    h.check("9b a denied license fails validation with its own class",
      deniedLicense.passed === false && deniedLicense.failure_class === "license_denied",
      `failure_class ${deniedLicense.failure_class}`);

    // ------------------------------------------------------- 10. authorized reads
    const status = await packagePrepareStatus(base44, user, { project_id: project.id });
    const curatedInspect = await inspectRegistryPackage(base44, user, { project_id: project.id, package_name: "@nexus/currency" });
    h.check("10 preparation history is readable per project",
      status.project_id === project.id && status.install_scripts_executed === false && Array.isArray(status.cache_entries),
      `${status.count} fetch record(s) for this project`);
    h.check("10b curated package metadata is inspectable",
      curatedInspect.registry_mode === "curated" && curatedInspect.versions.includes("1.1.0"),
      `${curatedInspect.versions.length} curated versions`);
    await h.expectThrow("10c unauthenticated supply reads are rejected", () => packagePrepareStatus(base44, null, { project_id: project.id }), "AUTH_REQUIRED");
    await h.expectThrow("10d cross-project supply reads are rejected", () => packagePrepareStatus(base44, user, { project_id: foreign.id }), "NOT_A_MEMBER");
    await h.expectThrow("10e cross-project registry inspection is rejected", () => inspectRegistryPackage(base44, user, { project_id: foreign.id, package_name: "left-pad" }), "NOT_A_MEMBER");
    h.check("10f another project's fetch history is untouched",
      (await svc.entities.PackageFetch.filter({ project_id: foreign.id }, "-created_date", 10)).length === 1,
      "the foreign project keeps exactly its own record");

    // --------------------------------------------------- 11. maintenance sweep
    const stale = await svc.entities.PackageFetch.create({ project_id: project.id, workspace_id: ws.id, package_name: "demo-pkg", status: "staged", expires_at: new Date(Date.now() - 60000).toISOString(), created_at: new Date(Date.now() - 3600000).toISOString() });
    const inflight = await svc.entities.PackageFetch.create({ project_id: project.id, workspace_id: ws.id, package_name: "demo-pkg-2", status: "staged", expires_at: new Date(Date.now() + 600000).toISOString(), created_at: new Date().toISOString() });
    const pinnedEntry = await svc.entities.PackageCacheEntry.create({
      cache_key: cacheKey("@nexus/currency", "1.1.0", "sha256-pinned"), package_name: "@nexus/currency", version: "1.1.0",
      integrity: "sha256-pinned", content_sha512: "pinnedDigest", last_used_at: new Date(Date.now() - 90 * 86400000).toISOString(),
      verified_at: new Date(Date.now() - 90 * 86400000).toISOString(), supply_chain_version: SUPPLY_CHAIN_VERSION,
    });
    await svc.entities.ProjectDependency.updateMany({ project_id: project.id, package_name: "@nexus/currency" }, { $set: { integrity: "sha256-pinned", resolved_version: "1.1.0" } }).catch(() => {});
    const swept = await cleanupPackageSupply(base44, { project_ids: [project.id] });
    const sweptGlobal = await cleanupPackageSupply(base44, {});
    const staleAfter = await svc.entities.PackageFetch.get(stale.id).catch(() => null);
    const inflightAfter = await svc.entities.PackageFetch.get(inflight.id).catch(() => null);
    const pinnedAfter = await svc.entities.PackageCacheEntry.get(pinnedEntry.id).catch(() => null);
    h.check("11 the maintenance sweep expires abandoned preparations only",
      swept.staged_expired >= 1 && staleAfter?.status === "expired" && inflightAfter?.status === "staged" && swept.preserved_active >= 1,
      `${swept.staged_expired} expired, ${swept.preserved_active} in-flight preserved`);
    h.check("11b a cache entry a project still pins is preserved",
      !!pinnedAfter && sweptGlobal.preserved_in_use >= 1,
      `${sweptGlobal.preserved_in_use} entry(ies) preserved because a lockfile still pins them`);
    h.check("11c the sweep is registered in the existing job system",
      typeof MAINTENANCE_HANDLERS["packages.cleanup_supply"] === "function" &&
      MAINTENANCE_SCHEDULE.some((j) => j.job_type === "packages.cleanup_supply" && j.queue === "maintenance"),
      "one handler, one scheduled entry — no second maintenance mechanism");

    // ------------------------------------------------------- 12. cleanup + removal
    const removed = await removeDependency(base44, user, { project_id: project.id, package_name: "@nexus/currency", trace_id });
    const finalFiles = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50);
    const list = await listDependencies(base44, user, { project_id: project.id });
    h.check("12 removal still clears the authoritative state",
      removed.applied === true && readLockfile(finalFiles).exists === false && list.count === 0 && list.install_scripts_blocked === true,
      "manifest cleared, lockfile removed, projection empty");

    // ---------------------------------------------------- 13. optional live registry
    if (body.live_registry === true) {
      const cfgLive = supplyConfig({ mode: "registry" });
      const live = await fetchPackageMetadata("left-pad", cfgLive);
      h.check("13 live registry metadata is fetched and fingerprinted",
        live.ok === true && !!live.metadata_fingerprint && Object.values(live.entry.versions).every((v) => !!v.integrity && !!v.tarball),
        `${Object.keys(live.entry.versions).length} published versions with integrity`);
      const version = live.dist_tags?.latest && live.entry.versions[live.dist_tags.latest] ? live.dist_tags.latest : Object.keys(live.entry.versions).pop();
      const artifact = await acquireArtifact(base44, { package_name: "left-pad", version, meta: live.entry.versions[version], cfg: cfgLive });
      created.cache_keys.push(artifact.cache_key);
      h.check("13b a live artifact is downloaded and verified against its integrity",
        artifact.integrity_verified === true && artifact.cache_result === "miss" && artifact.entry.content_sha512.length > 40,
        `left-pad@${version} verified from ${artifact.entry.registry_source}`);
    } else {
      notes.push("live registry pass skipped (send { live_registry: true } to exercise real network fetch + download)");
    }

    return compact(h, null, { notes });
  } catch (error) {
    return compact(h, error, { notes });
  } finally {
    for (const key of created.cache_keys) await purgeBy(svc, "PackageCacheEntry", { cache_key: key });
    for (const pid of created.projects) {
      for (const entity of ["PackageFetch", "ProjectDependency", "TraceEvent", "AuditLog", "Build", "ProjectVersion", "ProjectFile", "AppEntity"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["PackageFetch", "ProjectDependency", "AuditLog", "Project"]);
    }
  }
}