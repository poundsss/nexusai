// NexusAI package SUPPLY CHAIN — real registry metadata, verified artifacts, cached content.
//
// This module is the only place that talks to a package registry, and it is deliberately narrow:
//   • ALLOWLISTED HOSTS ONLY — an https host outside the allowlist is refused, so this can never be
//     used as a general-purpose outbound fetch.
//   • BOUNDED — metadata and artifact size, request timeout, version count, archive file count and
//     entry-module size are all capped, so a hostile package cannot exhaust the platform.
//   • VERIFIED OR REFUSED — a downloaded (or cached) artifact is accepted only when the digest the
//     platform computes itself matches the integrity the registry published. There is NO fallback
//     path from a failed verification.
//   • NO SCRIPT EXECUTION — lifecycle scripts are recorded as metadata and never run. Exports are
//     PARSED from the verified archive, so nothing from a package is ever evaluated.
//   • HONEST UNKNOWNS — when the advisory source cannot be consulted the answer is 'unavailable',
//     never 'none_known'; a package with no declared license stays 'unknown', never "allowed".
//
// Reuse, not reinvention: fingerprints from benchmark.ts, scrubbing from tracing.ts, semver and the
// resolution algorithm from packageRegistry.ts, and the two persisted entities
// (PackageCacheEntry, PackageFetch) for the shared cache and the per-project fetch history.
import { fingerprint } from "./benchmark.ts";
import { scrubText } from "./tracing.ts";
import { storeModuleBundle } from "./packageModules.ts";
import {
  RUNTIME_TARGET, PACKAGE_LIMITS, parseVersion, compareVersions,
  resolveDependencies, packageEntry, availableVersions,
} from "./packageRegistry.ts";

export const SUPPLY_CHAIN_VERSION = "pkg-supply-1";
/** 'curated' resolves offline against the built-in catalog; 'registry' uses the real registry. */
export const REGISTRY_MODES = ["curated", "registry"];
export const ALLOWED_REGISTRY_HOSTS = ["registry.npmjs.org"];
export const ALLOWED_ADVISORY_HOSTS = ["api.osv.dev"];
/** Lifecycle scripts a package may declare. Recorded, never executed. */
export const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "preuninstall", "postuninstall", "prepublish"];
/** License policy. Anything not listed is 'unknown' — which is NOT an approval. */
export const LICENSE_POLICY = {
  allowed: ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "Python-2.0"],
  denied: ["AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0", "BUSL-1.1", "UNLICENSED", "Commons-Clause"],
};
export const SUPPLY_LIMITS = {
  metadata_bytes: 6_000_000, tarball_bytes: 8_000_000, timeout_ms: 9_000,
  versions: 500, archive_files: 3_000, entry_bytes: 400_000, advisory_timeout_ms: 6_000,
  staged_ttl_ms: 30 * 60 * 1000,
};
export const SUPPLY_FAILURE_CLASSES = [
  "integrity_mismatch", "download_too_large", "registry_timeout", "registry_host_denied",
  "unsupported_archive", "license_denied", "vulnerable_package", "advisory_unavailable",
  "registry_unavailable", "metadata_invalid",
];

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const env = (key) => { try { return Deno.env.get(key) || null; } catch { return null; } };
const fail = (status, code, message, details = {}, failure_class = "registry_unavailable") => {
  throw Object.assign(new Error(message), { status, code, details, failure_class });
};

/**
 * The effective supply-chain configuration. Mode and endpoints come from SERVER configuration, so a
 * client cannot point the platform at a registry of its choosing.
 */
export function supplyConfig(overrides = {}) {
  const mode = REGISTRY_MODES.includes(overrides.mode) ? overrides.mode
    : REGISTRY_MODES.includes(env("PACKAGE_REGISTRY_MODE")) ? env("PACKAGE_REGISTRY_MODE") : "curated";
  return {
    mode,
    registry_url: overrides.registry_url || env("PACKAGE_REGISTRY_URL") || "https://registry.npmjs.org",
    advisory_url: overrides.advisory_url || env("PACKAGE_ADVISORY_URL") || "https://api.osv.dev/v1/query",
    // Which advisory severities refuse an install outright.
    security_threshold: overrides.security_threshold || env("PACKAGE_SECURITY_THRESHOLD") || "high",
    // Whether a package with no classifiable license may be installed. Default: yes, but recorded
    // as 'unknown' rather than reported as approved.
    require_license: overrides.require_license ?? (env("PACKAGE_REQUIRE_LICENSE") === "true"),
    runtime_target: overrides.runtime_target || RUNTIME_TARGET,
  };
}

// --- bounded, allowlisted HTTP ---------------------------------------------------

function assertAllowedHost(url, allowed) {
  let parsed;
  try { parsed = new URL(url); } catch { fail(400, "REGISTRY_HOST_DENIED", "The configured registry URL is not a valid URL", {}, "registry_host_denied"); }
  if (parsed.protocol !== "https:") fail(400, "REGISTRY_HOST_DENIED", "Only https registry endpoints are permitted", { host: parsed.host }, "registry_host_denied");
  if (!allowed.includes(parsed.host)) fail(400, "REGISTRY_HOST_DENIED", `Registry host '${parsed.host}' is not allowlisted`, { host: parsed.host, allowed }, "registry_host_denied");
  return parsed;
}

export async function boundedFetch(url, { allowed, timeout_ms, max_bytes, init = {}, failure_class = "registry_unavailable" }) {
  assertAllowedHost(url, allowed);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout_ms);
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctl.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = String(e?.name) === "AbortError";
    fail(504, timedOut ? "REGISTRY_TIMEOUT" : "REGISTRY_UNAVAILABLE", timedOut ? `The registry did not respond within ${timeout_ms}ms` : `The registry could not be reached: ${scrubText(e.message, 120)}`, {}, timedOut ? "registry_timeout" : failure_class);
  }
  clearTimeout(timer);
  if (res.status === 404) return { found: false, status: 404, bytes: null };
  if (!res.ok) fail(502, "REGISTRY_UNAVAILABLE", `The registry responded ${res.status}`, { status: res.status }, failure_class);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > max_bytes) fail(413, "DOWNLOAD_TOO_LARGE", `The response is ${declared} bytes, above the ${max_bytes} byte ceiling`, { size_bytes: declared, max_bytes }, "download_too_large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max_bytes) fail(413, "DOWNLOAD_TOO_LARGE", `The response is ${bytes.length} bytes, above the ${max_bytes} byte ceiling`, { size_bytes: bytes.length, max_bytes }, "download_too_large");
  return { found: true, status: res.status, bytes };
}

const decodeJson = (bytes, what) => {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(502, "REGISTRY_METADATA_INVALID", `The registry returned ${what} that is not valid JSON`, {}, "metadata_invalid"); }
};

// --- registry metadata ----------------------------------------------------------

const declaredScripts = (scripts) => Object.keys(scripts || {}).filter((s) => LIFECYCLE_SCRIPTS.includes(s)).sort();

/**
 * The published metadata for one package: every usable version with its integrity, tarball, own
 * dependencies, peer/optional dependencies, declared license and whether it declares lifecycle
 * scripts. Only exact semver versions are admitted — a pre-release or non-semver tag is ignored, so
 * resolution stays deterministic.
 */
export async function fetchPackageMetadata(name, cfg = supplyConfig()) {
  const base = new URL(cfg.registry_url);
  const url = `${base.origin}/${name.split("/").map(encodeURIComponent).join("/")}`;
  const res = await boundedFetch(url, {
    allowed: ALLOWED_REGISTRY_HOSTS, timeout_ms: SUPPLY_LIMITS.timeout_ms, max_bytes: SUPPLY_LIMITS.metadata_bytes,
    init: { headers: { accept: "application/vnd.npm.install-v1+json, application/json" } },
  });
  if (!res.found) return { ok: false, package_name: name };
  const doc = decodeJson(res.bytes, "package metadata");
  const versions = {};
  for (const [version, meta] of Object.entries(doc.versions || {})) {
    if (!parseVersion(version)) continue;
    if (Object.keys(versions).length >= SUPPLY_LIMITS.versions) break;
    const integrity = meta?.dist?.integrity || (meta?.dist?.shasum ? `sha1-${meta.dist.shasum}` : null);
    if (!integrity || !meta?.dist?.tarball) continue; // no integrity ⇒ not installable
    versions[version] = {
      version, integrity, tarball: meta.dist.tarball,
      unpacked_size: meta.dist.unpackedSize ?? null,
      deprecated: meta.deprecated ? scrubText(meta.deprecated, 200) : null,
      dependencies: meta.dependencies || {},
      peer_dependencies: meta.peerDependencies || {},
      optional_dependencies: meta.optionalDependencies || {},
      license: typeof meta.license === "string" ? meta.license : (meta.license?.type || null),
      has_install_script: declaredScripts(meta.scripts).length > 0,
      // Registry packages target the platform runtime contract; runtime compatibility is still
      // enforced by the resolver, which refuses anything that does not.
      runtime_target: cfg.runtime_target,
      exports: [], vulnerabilities: [],
    };
  }
  return {
    ok: Object.keys(versions).length > 0, package_name: name,
    dist_tags: doc["dist-tags"] || {},
    // advisory_data stays false on the metadata snapshot: until the advisory source is actually
    // consulted during preparation, the honest posture of a registry package is 'unknown'.
    entry: { name, description: scrubText(doc.description || "", 200), advisory_data: false, source: new URL(cfg.registry_url).host, versions },
    metadata_fingerprint: fingerprint("pkgmeta", { name, versions: Object.keys(versions).sort().map((v) => [v, versions[v].integrity]) }),
  };
}

/** The declared license, classified against policy. 'unknown' is explicitly not an approval. */
export function classifyLicense(license, cfg = supplyConfig()) {
  const id = typeof license === "string" ? license.trim() : "";
  if (!id) return { license: null, license_status: cfg.require_license ? "denied" : "unknown" };
  if (LICENSE_POLICY.denied.some((d) => id.toUpperCase().includes(d.toUpperCase()))) return { license: id, license_status: "denied" };
  if (LICENSE_POLICY.allowed.some((a) => a.toLowerCase() === id.toLowerCase())) return { license: id, license_status: "allowed" };
  return { license: id, license_status: cfg.require_license ? "denied" : "unknown" };
}

const SEVERITY_RANK = { low: 1, moderate: 2, medium: 2, high: 3, critical: 4 };

/**
 * Advisory posture for one exact version. When the advisory source cannot be consulted the answer
 * is 'unavailable' and NO safety claim is made — it is never folded into 'none_known'.
 */
export async function fetchAdvisories(name, version, cfg = supplyConfig()) {
  try {
    const res = await boundedFetch(cfg.advisory_url, {
      allowed: ALLOWED_ADVISORY_HOSTS, timeout_ms: SUPPLY_LIMITS.advisory_timeout_ms, max_bytes: SUPPLY_LIMITS.metadata_bytes,
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version, package: { name, ecosystem: "npm" } }) },
    });
    if (!res.found) return { advisory_status: "none_known", vulnerabilities: [], available: true };
    const doc = decodeJson(res.bytes, "advisory data");
    const vulns = (doc.vulns || []).slice(0, 20).map((v) => ({
      advisory_id: v.id, severity: String(v.database_specific?.severity || v.severity?.[0]?.type || "unknown").toLowerCase(),
      summary: scrubText(v.summary || "", 200),
      patched_in: v.affected?.[0]?.ranges?.[0]?.events?.find((e) => e.fixed)?.fixed || null,
    }));
    return { advisory_status: vulns.length ? "vulnerable" : "none_known", vulnerabilities: vulns, available: true };
  } catch {
    // Advisory outage is not a safety claim in either direction.
    return { advisory_status: "unavailable", vulnerabilities: [], available: false };
  }
}

// --- integrity + archive --------------------------------------------------------

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Digests the bytes the platform actually received and compares them to the published integrity. */
export async function verifyIntegrity(bytes, integrity) {
  const [algo, expected] = String(integrity || "").split("-");
  const sha512 = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
  const content_sha512 = b64(sha512);
  if (algo === "sha512") return { ok: expected === content_sha512, content_sha512, algorithm: "sha512" };
  if (algo === "sha256") {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return { ok: expected === b64(d), content_sha512, algorithm: "sha256" };
  }
  if (algo === "sha1") {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
    // npm publishes legacy shasums in hex.
    return { ok: expected === hex(d) || expected === b64(d), content_sha512, algorithm: "sha1" };
  }
  return { ok: false, content_sha512, algorithm: algo || "unknown" };
}

/** Gunzips bytes using the platform's own decompression — no third-party unpacker is involved. */
export async function gunzip(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    fail(422, "UNSUPPORTED_ARCHIVE", `The package archive is not readable gzip: ${scrubText(e.message, 120)}`, {}, "unsupported_archive");
  }
}

/**
 * Minimal, bounded tar reader. Reads headers only — it never executes anything and never writes to
 * disk; entries are held in memory and capped by count and size.
 */
export function untar(bytes) {
  const files = [];
  const dec = new TextDecoder();
  let offset = 0;
  let longName = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const str = (start, len) => dec.decode(header.subarray(start, start + len)).replace(/\0.*$/, "").trim();
    const name = longName || str(0, 100);
    const size = parseInt(str(124, 12) || "0", 8) || 0;
    const type = str(156, 1) || "0";
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    longName = null;
    if (type === "L") { longName = dec.decode(body).replace(/\0.*$/, "").trim(); continue; }
    if (type !== "0" && type !== "" && type !== "0\0") continue;
    if (files.length >= SUPPLY_LIMITS.archive_files) break;
    files.push({ path: name.replace(/^package\//, ""), size, body });
  }
  if (!files.length) fail(422, "UNSUPPORTED_ARCHIVE", "The package archive contained no readable files", {}, "unsupported_archive");
  return files;
}

const EXPORT_RE = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
const NAMED_EXPORT_RE = /export\s*\{([^}]*)\}/g;
const CJS_RE = /(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=/g;

/**
 * Named exports PARSED from the verified archive's own entry module. Parsed, never evaluated — and
 * when no entry module is parseable the result is an explicit 'unknown' rather than a guess.
 */
export function extractExports(files, manifest) {
  const candidates = [manifest?.module, manifest?.main, "index.mjs", "index.js", "dist/index.mjs", "dist/index.js", "src/index.js"].filter(Boolean).map((p) => String(p).replace(/^\.\//, ""));
  const entry = candidates.map((c) => files.find((f) => f.path === c)).find(Boolean);
  if (!entry || entry.size > SUPPLY_LIMITS.entry_bytes) return { exports: [], entry_module: entry?.path || null, exports_source: "unknown" };
  const code = new TextDecoder().decode(entry.body);
  const names = new Set();
  for (const re of [EXPORT_RE, CJS_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) && names.size < PACKAGE_LIMITS.tree) names.add(m[1]);
  }
  NAMED_EXPORT_RE.lastIndex = 0;
  let g;
  while ((g = NAMED_EXPORT_RE.exec(code)) && names.size < PACKAGE_LIMITS.tree) {
    for (const part of g[1].split(",")) {
      const alias = part.split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(alias)) names.add(alias);
    }
  }
  return { exports: [...names].sort(), entry_module: entry.path, exports_source: names.size ? "artifact" : "unknown" };
}

// --- content-addressed cache ----------------------------------------------------

/** Cache identity: name + exact version + published integrity. Different content ⇒ different key. */
export const cacheKey = (name, version, integrity) => fingerprint("pkgcache", { name, version, integrity, contract: SUPPLY_CHAIN_VERSION });

/**
 * Returns ONE validated artifact for a package version: from the shared cache when the cached
 * content still matches its integrity, otherwise by a bounded download whose bytes are verified
 * before anything is recorded. A cached entry whose recorded digest no longer matches its integrity
 * is REFUSED and replaced, never reused.
 */
export async function acquireArtifact(base44, { package_name, version, meta, cfg = supplyConfig() }) {
  const svc = svcOf(base44);
  const key = cacheKey(package_name, version, meta.integrity);
  const [cached] = await svc.entities.PackageCacheEntry.filter({ cache_key: key }, "-created_date", 1).catch(() => []);
  if (cached) {
    const check = await verifyIntegrity(new Uint8Array(), meta.integrity).catch(() => null);
    // B5: an entry recorded before browser modules existed has no stored module bundle; it is
    // re-downloaded once so the verified bytes can be kept privately.
    const consistent = cached.content_sha512 && cached.integrity === meta.integrity && !!cached.module_status &&
      (check?.algorithm !== "sha512" || meta.integrity === `sha512-${cached.content_sha512}`);
    if (consistent) {
      await svc.entities.PackageCacheEntry.update(cached.id, { last_used_at: nowIso(), use_count: (cached.use_count || 1) + 1 }).catch(() => {});
      return { cache_result: "hit", cache_key: key, entry: cached, integrity_verified: true, size_bytes: cached.size_bytes || 0 };
    }
    await svc.entities.PackageCacheEntry.delete(cached.id).catch(() => {});
  }

  const started = Date.now();
  const res = await boundedFetch(meta.tarball, { allowed: ALLOWED_REGISTRY_HOSTS, timeout_ms: SUPPLY_LIMITS.timeout_ms, max_bytes: SUPPLY_LIMITS.tarball_bytes });
  if (!res.found) fail(404, "PACKAGE_ARTIFACT_MISSING", `The registry no longer serves ${package_name}@${version}`, { package_name, version }, "registry_unavailable");
  const verified = await verifyIntegrity(res.bytes, meta.integrity);
  if (!verified.ok) {
    // No fallback: content that does not match its published integrity is never usable.
    fail(422, "INTEGRITY_MISMATCH", `The downloaded content for ${package_name}@${version} does not match the integrity published by the registry`, { package_name, version, integrity: meta.integrity }, "integrity_mismatch");
  }
  const files = untar(await gunzip(res.bytes));
  const pkgFile = files.find((f) => f.path === "package.json");
  const manifest = pkgFile ? (() => { try { return JSON.parse(new TextDecoder().decode(pkgFile.body)); } catch { return null; } })() : null;
  const { exports, entry_module, exports_source } = extractExports(files, manifest);
  const install_scripts = declaredScripts(manifest?.scripts);
  const license = classifyLicense(manifest?.license ?? meta.license, cfg);
  const advisory = await fetchAdvisories(package_name, version, cfg);
  // B5: the verified archive's reachable ESM files, kept in PRIVATE storage for packageModules().
  const moduleBundle = await storeModuleBundle(svc, files, entry_module);

  const entry = await svc.entities.PackageCacheEntry.create({
    cache_key: key, package_name, version, integrity: meta.integrity, content_sha512: verified.content_sha512,
    size_bytes: res.bytes.length, registry_source: new URL(meta.tarball).host, tarball_url: meta.tarball,
    exports, exports_source, entry_module,
    license: license.license || undefined, license_status: license.license_status,
    install_scripts, install_scripts_blocked: true, file_count: files.length,
    advisory_status: advisory.advisory_status, verified_at: nowIso(), last_used_at: nowIso(),
    use_count: 1, supply_chain_version: SUPPLY_CHAIN_VERSION,
    ...moduleBundle,
  });
  return {
    cache_result: "miss", cache_key: key, entry, integrity_verified: true,
    size_bytes: res.bytes.length, duration_ms: Date.now() - started,
    advisory, license,
  };
}

// --- resolution against real metadata -------------------------------------------

/**
 * Builds a metadata SNAPSHOT catalog for a manifest, then resolves it with the EXISTING resolver, so
 * registry mode and curated mode share one resolution algorithm, one conflict report and one
 * fingerprint definition. The snapshot is fetched transitively and bounded by the same limits.
 */
export async function resolveFromRegistry(dependencies, cfg = supplyConfig()) {
  const catalog = {};
  const fingerprints = [];
  const queue = Object.keys(dependencies || {});
  const seen = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || seen.size > PACKAGE_LIMITS.tree) continue;
    seen.add(name);
    const meta = await fetchPackageMetadata(name, cfg);
    if (!meta.ok) return { ok: false, code: "PACKAGE_NOT_FOUND", message: `Package '${name}' is not published by ${new URL(cfg.registry_url).host}`, details: { package_name: name } };
    catalog[name] = meta.entry;
    fingerprints.push([name, meta.metadata_fingerprint]);
    for (const v of Object.values(meta.entry.versions)) {
      for (const dep of [...Object.keys(v.dependencies), ...Object.keys(v.peer_dependencies)]) if (!seen.has(dep)) queue.push(dep);
    }
  }
  const resolution = resolveDependencies(dependencies, { runtime_target: cfg.runtime_target, catalog });
  if (!resolution.ok) return resolution;
  return {
    ...resolution,
    registry_source: new URL(cfg.registry_url).host,
    registry_metadata_fingerprint: fingerprint("regmeta", fingerprints.sort()),
    metadata_catalog: catalog,
  };
}

/**
 * THE resolution entry point for the dependency layer. Curated mode stays exactly as it was — fully
 * offline and deterministic — and registry mode resolves against real published metadata.
 */
export async function resolveForProject(base44, { dependencies, cfg = supplyConfig() } = {}) {
  if (cfg.mode !== "registry") {
    const resolution = resolveDependencies(dependencies, { runtime_target: cfg.runtime_target });
    return resolution.ok ? { ...resolution, registry_mode: "curated" } : resolution;
  }
  const resolution = await resolveFromRegistry(dependencies, cfg);
  return resolution.ok ? { ...resolution, registry_mode: "registry" } : resolution;
}

// --- preparation (policy + verified artifacts) ----------------------------------

const severityRefuses = (severity, threshold) => (SEVERITY_RANK[severity] || 0) >= (SEVERITY_RANK[threshold] || 3);

/**
 * Prepares every resolved package BEFORE any project file is written: policy (license, advisories),
 * then a verified artifact from the cache or a bounded download, its exports read from the validated
 * content and its lifecycle scripts recorded as blocked. A refusal here throws, so the caller's
 * project state is left untouched.
 *
 * Curated mode has no artifacts to fetch, so it returns the catalog-derived posture unchanged.
 */
export async function prepareResolution(base44, { project, workspace, resolution, cfg = supplyConfig(), trace_id = null, run_id = null } = {}) {
  const svc = svcOf(base44);
  if (cfg.mode !== "registry") {
    return {
      prepared: false, mode: "curated",
      cache: { hits: 0, misses: 0 },
      advisory: { available: true, source: "curated-catalog" },
      blocked_install_scripts: [], unknown_advisory_packages: resolution.packages.filter((p) => p.vulnerability_status === "unknown").map((p) => `${p.name}@${p.version}`),
    };
  }
  const cache = { hits: 0, misses: 0 };
  const blocked = [];
  const unknownAdvisory = [];
  let advisoryAvailable = true;

  const recordFetch = (patch) => svc.entities.PackageFetch.create({
    project_id: project.id, workspace_id: workspace.id, trace_id: trace_id || undefined, run_id: run_id || undefined,
    registry_source: new URL(cfg.registry_url).host, created_at: nowIso(), install_scripts_blocked: true, ...patch,
  }).catch(() => null);

  for (const p of resolution.packages) {
    const meta = resolution.metadata_catalog?.[p.name]?.versions?.[p.version];
    if (!meta) {
      await recordFetch({ package_name: p.name, resolved_version: p.version, status: "failed", failure_class: "metadata_invalid", detail: "the resolved version is absent from the metadata snapshot" });
      fail(422, "REGISTRY_METADATA_INVALID", `The registry metadata no longer contains ${p.name}@${p.version}`, { package_name: p.name }, "metadata_invalid");
    }
    // A staged row exists for the duration of the preparation, so an abandoned fetch is visible to
    // the existing maintenance sweep rather than invisible.
    const staged = await recordFetch({
      package_name: p.name, requested_range: p.requested, resolved_version: p.version, status: "staged",
      integrity: meta.integrity, registry_metadata_fingerprint: resolution.registry_metadata_fingerprint,
      expires_at: new Date(Date.now() + SUPPLY_LIMITS.staged_ttl_ms).toISOString(),
    });
    const finish = (patch) => (staged ? svc.entities.PackageFetch.update(staged.id, { ...patch, expires_at: null }).catch(() => {}) : recordFetch({ package_name: p.name, resolved_version: p.version, ...patch }));

    let acquired;
    try {
      acquired = await acquireArtifact(base44, { package_name: p.name, version: p.version, meta, cfg });
    } catch (e) {
      await finish({ status: "failed", cache_result: e.failure_class === "integrity_mismatch" ? "rejected" : "miss", failure_class: e.failure_class || "registry_unavailable", detail: scrubText(e.message, 240), integrity_verified: false });
      throw e;
    }
    const entry = acquired.entry;
    if (acquired.cache_result === "hit") cache.hits++; else cache.misses++;

    // Policy: a denied license or an advisory at or above the threshold refuses the install.
    if (entry.license_status === "denied") {
      await finish({ status: "failed", cache_result: acquired.cache_result, cache_key: acquired.cache_key, failure_class: "license_denied", detail: `license '${entry.license || "none declared"}' is not permitted by policy`, license: entry.license || undefined, license_status: "denied", integrity_verified: true });
      fail(422, "LICENSE_DENIED", `${p.name}@${p.version} declares the license '${entry.license || "none"}', which policy does not permit`, { package_name: p.name, license: entry.license || null }, "license_denied");
    }
    const vulns = entry.advisory_status === "vulnerable" ? (await fetchAdvisories(p.name, p.version, cfg)).vulnerabilities : [];
    const blockingVuln = vulns.find((v) => severityRefuses(v.severity, cfg.security_threshold));
    if (blockingVuln) {
      await finish({ status: "failed", cache_result: acquired.cache_result, cache_key: acquired.cache_key, failure_class: "vulnerable_package", detail: `${blockingVuln.advisory_id} (${blockingVuln.severity})`, advisory_status: "vulnerable", integrity_verified: true });
      fail(422, "VULNERABLE_PACKAGE", `${p.name}@${p.version} has a known ${blockingVuln.severity} advisory (${blockingVuln.advisory_id})`, { package_name: p.name, advisory: blockingVuln }, "vulnerable_package");
    }
    if (entry.advisory_status === "unavailable") { advisoryAvailable = false; unknownAdvisory.push(`${p.name}@${p.version}`); }
    if ((entry.install_scripts || []).length) blocked.push({ package_name: p.name, scripts: entry.install_scripts });

    // The verified facts are folded onto the resolved package, so the lockfile pins content the
    // platform itself validated rather than metadata it merely read.
    p.integrity_verified = true;
    p.content_sha512 = entry.content_sha512;
    p.exports = (entry.exports || []).length ? entry.exports : p.exports;
    p.exports_source = entry.exports_source;
    p.license = entry.license ?? null;
    p.license_status = entry.license_status;
    p.advisory_status = entry.advisory_status;
    p.vulnerability_status = entry.advisory_status === "vulnerable" ? "vulnerable" : entry.advisory_status === "none_known" ? "none_known" : "unknown";
    p.vulnerabilities = vulns;
    p.install_scripts = entry.install_scripts || [];
    p.install_scripts_blocked = true;
    p.cache_key = acquired.cache_key;

    await finish({
      status: "prepared", cache_result: acquired.cache_result, cache_key: acquired.cache_key,
      integrity: entry.integrity, content_sha512: entry.content_sha512, integrity_verified: true,
      size_bytes: acquired.size_bytes || entry.size_bytes || 0, duration_ms: acquired.duration_ms || 0,
      advisory_status: entry.advisory_status, license: entry.license || undefined, license_status: entry.license_status,
      blocked_install_scripts: entry.install_scripts || [], registry_metadata_fingerprint: resolution.registry_metadata_fingerprint,
    });
  }

  return {
    prepared: true, mode: "registry", cache,
    advisory: { available: advisoryAvailable, source: new URL(cfg.advisory_url).host },
    blocked_install_scripts: blocked, install_scripts_executed: false,
    unknown_advisory_packages: unknownAdvisory,
  };
}

/** Curated-mode helper kept here so callers never branch on the catalog directly. */
export const curatedLatest = (name) => (packageEntry(name) ? availableVersions(name).slice(-1)[0] || null : null);
export { compareVersions };