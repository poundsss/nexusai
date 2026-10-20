// NexusAI dependency / package layer — SERVER-SIDE, authorized, deterministic.
//
// The project's own manifest and lockfile are THE dependency state. They are ordinary project
// files, which is deliberate and is what gives this layer its safety properties for free:
//   • a package change is a normal project mutation → it produces a project version, appears in
//     the version's changed files, and is restored by the EXISTING rollback path;
//   • an immutable historical version keeps the manifest/lockfile it shipped with, so a later
//     install can never rewrite what an old version depended on;
//   • verification, preview and production all read the same lockfile out of the same file set,
//     so there is exactly one dependency loader and no environment can drift from another.
//
// The ProjectDependency rows are a QUERYABLE PROJECTION of the lockfile, re-synced from it on every
// read and write — never a second source of truth.
//
// Reuse, not reinvention: authorization and audit from authz.ts, tracing from tracing.ts, the
// virtual filesystem from projectFs.ts, commit/versioning from persistence.ts, static validation
// from buildEngine.ts, resolution from packageRegistry.ts, and impact from the #25 architecture
// graph. This module adds no second mechanism for any of them.
import { loadAuthorizedProject, loadProjectState, audit } from "./authz.ts";
import { createFs, writeFile, deleteFile, activeFiles, computeChanges } from "./projectFs.ts";
import { commitFiles, createVersion } from "./persistence.ts";
import { runBuild } from "./buildEngine.ts";
import { scrub, scrubText, recordSpan } from "./tracing.ts";
import { MANIFEST_FILE, LOCKFILE_FILE, LOCKFILE_VERSION, installedPackages, resolvedDependencyState } from "./packageLock.ts";
import { analyzeImpact } from "./architectureGraph.ts";
import {
  PACKAGE_CATALOG, REGISTRY_VERSION, REGISTRY_SOURCE, RUNTIME_TARGET, PACKAGE_LIMITS,
  parseRange, satisfies, availableVersions, packageVersion, packageEntry,
  resolveDependencies, dependencyFingerprint, vulnerabilityStatus, compareVersions, listCatalog,
} from "./packageRegistry.ts";
import {
  supplyConfig, resolveForProject, prepareResolution, fetchPackageMetadata, classifyLicense, cacheKey,
  REGISTRY_MODES, ALLOWED_REGISTRY_HOSTS, LICENSE_POLICY, LIFECYCLE_SCRIPTS, SUPPLY_CHAIN_VERSION,
  SUPPLY_LIMITS, SUPPLY_FAILURE_CLASSES,
} from "./packageSupply.ts";

export { MANIFEST_FILE, LOCKFILE_FILE, LOCKFILE_VERSION, installedPackages, resolvedDependencyState };
export const DEPENDENCY_OPERATIONS = ["add", "remove", "update"];
/** Failure classes recorded on every refused or failed dependency operation. */
export const DEPENDENCY_FAILURE_CLASSES = [
  "none", "invalid_input", "resolution_failure", "conflict", "runtime_incompatible",
  "integrity_mismatch", "build_failure", "version_conflict", "authorization_failure",
  ...SUPPLY_FAILURE_CLASSES.filter((c) => c !== "integrity_mismatch"),
];

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message, details = {}) => { throw Object.assign(new Error(message), { status, code, details }); };
const requireUser = (user) => { if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to manage dependencies"); };

// --- manifest / lockfile ---------------------------------------------------------

const stableJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sortedDeps = (deps) => Object.fromEntries(Object.keys(deps || {}).sort().map((k) => [k, deps[k]]));

/** Reads the manifest from a file set. A project with no manifest simply has no dependencies. */
export function readManifest(files) {
  const file = (files || []).find((f) => f.path === MANIFEST_FILE);
  if (!file) return { exists: false, dependencies: {}, raw: null };
  try {
    const doc = JSON.parse(file.content || "{}");
    const deps = doc.dependencies && typeof doc.dependencies === "object" ? doc.dependencies : {};
    return { exists: true, dependencies: sortedDeps(deps), raw: doc };
  } catch (e) {
    fail(422, "MANIFEST_INVALID", `${MANIFEST_FILE} is not valid JSON: ${scrubText(e.message, 160)}`);
  }
}

export function readLockfile(files) {
  const file = (files || []).find((f) => f.path === LOCKFILE_FILE);
  if (!file) return { exists: false, packages: [], fingerprint: null, raw: null };
  try {
    const doc = JSON.parse(file.content || "{}");
    return {
      exists: true,
      packages: Array.isArray(doc.packages) ? doc.packages : [],
      fingerprint: doc.dependency_fingerprint || null,
      registry_version: doc.registry_version || null,
      runtime_target: doc.runtime_target || null,
      lockfile_version: doc.lockfile_version || LOCKFILE_VERSION,
      raw: doc,
    };
  } catch (e) {
    fail(422, "LOCKFILE_INVALID", `${LOCKFILE_FILE} is not valid JSON: ${scrubText(e.message, 160)}`);
  }
}

const manifestContent = (dependencies, previous) => stableJson({
  ...(previous || {}),
  name: previous?.name || "generated-app",
  version: previous?.version || "1.0.0",
  dependencies: sortedDeps(dependencies),
});

/** Serializes a lockfile deterministically: same resolution ⇒ byte-identical file. */
const lockfileContent = (resolution) => stableJson({
  lockfile_version: LOCKFILE_VERSION,
  registry_version: resolution.registry_version,
  registry_source: resolution.registry_source || REGISTRY_SOURCE,
  registry_mode: resolution.registry_mode || "curated",
  registry_metadata_fingerprint: resolution.registry_metadata_fingerprint || null,
  runtime_target: resolution.runtime_target,
  dependency_fingerprint: resolution.fingerprint,
  packages: resolution.packages.map((p) => ({
    name: p.name, version: p.version, requested: p.requested, source: p.source,
    relation: p.relation, required_by: p.required_by, integrity: p.integrity,
    // The digest the platform computed over the bytes it verified, when it verified any.
    content_sha512: p.content_sha512 || null, integrity_verified: p.integrity_verified !== undefined ? !!p.integrity_verified : null,
    runtime_target: p.runtime_target, exports: p.exports,
    license: p.license ?? null, license_status: p.license_status || null,
    advisory_status: p.advisory_status || null,
    // Lifecycle scripts the package declares. Recorded so the block is auditable; never executed.
    install_scripts: p.install_scripts || [], install_scripts_blocked: true,
    dependencies: sortedDeps(p.dependencies),
  })),
});

// --- validation ------------------------------------------------------------------

/**
 * Validates the recorded dependency state against the manifest and the registry.
 *
 * Checks are kept SEPARATE so a refusal is explainable: manifest/lockfile agreement (no silent
 * drift), exact resolved versions present, integrity match, runtime compatibility, and advisory
 * posture. Nothing is repaired here.
 */
export function validateDependencyState({ manifest, lock, resolution: provided = null }) {
  const checks = [];
  const add = (name, ok, detail, severity = "error") => checks.push({ name, ok, severity, detail: scrubText(detail, 240) });
  // In registry mode the caller resolves against real published metadata and passes that resolution
  // in; curated mode resolves here, offline, exactly as before.
  const resolution = provided || resolveDependencies(manifest.dependencies, { runtime_target: RUNTIME_TARGET });

  if (!resolution.ok) {
    add("resolution", false, `${resolution.code}: ${resolution.message}`);
    return {
      status: "error", passed: false, checks, resolution,
      failure_class: resolution.code === "RUNTIME_INCOMPATIBLE" ? "runtime_incompatible"
        : resolution.code === "INVALID_VERSION" ? "invalid_input"
          : ["PACKAGE_CONFLICT", "PEER_DEPENDENCY_CONFLICT", "PEER_DEPENDENCY_MISSING"].includes(resolution.code) ? "conflict" : "resolution_failure",
      failed_checks: ["resolution"], vulnerabilities: [], drift: [],
    };
  }
  add("resolution", true, `${resolution.packages.length} package(s) resolved deterministically`);
  add("runtime_compatibility", true, `every package targets ${RUNTIME_TARGET}`);

  // Lockfile agreement: an absent lockfile, a changed fingerprint or a differing resolved version
  // is DRIFT, and drift is reported rather than silently re-resolved.
  const drift = [];
  const locked = new Map(lock.packages.map((p) => [p.name, p]));
  // A project with no dependencies correctly has NO lockfile: there is nothing to pin, so the
  // absent file is the valid state rather than drift.
  const noDependencies = resolution.packages.length === 0;
  if (!lock.exists) {
    if (!noDependencies) drift.push({ type: "lockfile_missing", detail: `${LOCKFILE_FILE} is missing` });
  } else {
    if (lock.fingerprint !== resolution.fingerprint) drift.push({ type: "fingerprint_mismatch", detail: `lockfile fingerprint ${lock.fingerprint} does not match the resolved ${resolution.fingerprint}` });
    for (const p of resolution.packages) {
      const l = locked.get(p.name);
      if (!l) { drift.push({ type: "missing_from_lockfile", package_name: p.name, detail: `${p.name} resolves but is not locked` }); continue; }
      if (l.version !== p.version) drift.push({ type: "version_drift", package_name: p.name, detail: `lockfile pins ${p.name}@${l.version} but the manifest resolves to ${p.version}` });
      if (l.integrity && l.integrity !== p.integrity) drift.push({ type: "integrity_mismatch", package_name: p.name, detail: `integrity for ${p.name}@${p.version} does not match the registry` });
    }
    for (const l of lock.packages) if (!resolution.packages.some((p) => p.name === l.name)) drift.push({ type: "orphaned_lock_entry", package_name: l.name, detail: `${l.name} is locked but no longer required` });
  }
  const integrityMismatch = drift.some((d) => d.type === "integrity_mismatch");
  add("lockfile_integrity", !integrityMismatch, integrityMismatch ? "a locked integrity checksum does not match the registry" : "every locked integrity checksum matches the registry");
  add("lockfile_agreement", drift.filter((d) => d.type !== "integrity_mismatch").length === 0, drift.length ? drift.map((d) => d.detail).join(" | ") : "the lockfile matches the manifest resolution exactly");
  add("exact_versions_recorded", noDependencies || (lock.exists && lock.packages.every((p) => /^\d+\.\d+\.\d+$/.test(String(p.version || "")))), noDependencies ? "the project declares no dependencies, so there is nothing to pin" : "every locked package records an exact resolved version");

  // Advisory posture. A package with no advisory coverage is reported as UNKNOWN — never as safe.
  const vulnerabilities = resolution.packages.filter((p) => p.vulnerability_status === "vulnerable")
    .flatMap((p) => p.vulnerabilities.map((v) => ({ package_name: p.name, resolved_version: p.version, ...v })));
  const unknown = resolution.packages.filter((p) => p.vulnerability_status === "unknown").map((p) => `${p.name}@${p.version}`);
  add("known_vulnerabilities", vulnerabilities.length === 0, vulnerabilities.length ? vulnerabilities.map((v) => `${v.package_name}@${v.resolved_version} ${v.advisory_id} (${v.severity})`).join(" | ") : "no known advisories apply to the resolved versions", "warning");
  add("advisory_coverage", unknown.length === 0, unknown.length ? `no vulnerability data available for ${unknown.join(", ")} — no safety claim is made` : "advisory data covers every resolved package", "warning");

  // Registry mode only: every package must carry a platform-verified content digest, and no package
  // may claim an executed lifecycle script. Curated packages have no artifacts, so these do not apply.
  if ((resolution.registry_mode || "curated") === "registry") {
    const unverified = resolution.packages.filter((p) => !p.integrity_verified).map((p) => `${p.name}@${p.version}`);
    add("artifact_integrity_verified", unverified.length === 0, unverified.length ? `content was not verified against the published integrity for ${unverified.join(", ")}` : "every artifact's content digest matched the integrity the registry published");
    add("install_scripts_blocked", resolution.packages.every((p) => p.install_scripts_blocked !== false), "no package lifecycle script was executed");
    const denied = resolution.packages.filter((p) => p.license_status === "denied").map((p) => `${p.name}@${p.version}`);
    add("license_policy", denied.length === 0, denied.length ? `policy denies the license of ${denied.join(", ")}` : "no resolved package declares a denied license");
  }

  const failed = checks.filter((c) => !c.ok && c.severity === "error");
  const warned = checks.filter((c) => !c.ok && c.severity === "warning");
  return {
    status: failed.length ? "error" : warned.length ? "warning" : "valid",
    passed: failed.length === 0, checks, resolution, drift,
    vulnerabilities, unknown_advisory_packages: unknown,
    failure_class: failed.length ? (integrityMismatch || failed.some((c) => c.name === "artifact_integrity_verified") ? "integrity_mismatch" : failed.some((c) => c.name === "license_policy") ? "license_denied" : "resolution_failure") : "none",
    failed_checks: failed.map((c) => c.name),
  };
}

// --- projection ------------------------------------------------------------------

export const publicDependency = (d) => ({
  dependency_id: d.id, project_id: d.project_id, package_name: d.package_name,
  requested_version: d.requested_version || null, resolved_version: d.resolved_version,
  source: d.source || REGISTRY_SOURCE, relation: d.relation || "direct",
  required_by: d.required_by || [], status: d.status || "installed",
  integrity: d.integrity || null, runtime_target: d.runtime_target || null,
  vulnerability_status: d.vulnerability_status || "unknown", vulnerabilities: d.vulnerabilities || [],
  dependency_fingerprint: d.dependency_fingerprint || null,
  source_version_number: d.source_version_number ?? null,
  installed_at: d.installed_at || d.created_date, updated_at: d.updated_at || d.updated_date,
});

/**
 * Re-syncs the queryable projection from the lockfile. Idempotent by construction: a row is keyed
 * by (project, package) and updated in place, so repeating an operation cannot create duplicates.
 */
async function syncProjection(svc, { project, workspace, resolution, validation, version_number }) {
  const existing = await svc.entities.ProjectDependency.filter({ project_id: project.id }, "package_name", PACKAGE_LIMITS.tree + 50);
  const byName = new Map(existing.map((r) => [r.package_name, r]));
  const rows = [];
  for (const p of resolution.packages) {
    const conflicted = (validation?.drift || []).some((d) => d.package_name === p.name && d.type === "integrity_mismatch");
    const latest = availableVersions(p.name).slice(-1)[0];
    const status = conflicted ? "conflicted"
      : p.vulnerability_status === "vulnerable" ? "vulnerable"
        : latest && compareVersions(latest, p.version) > 0 ? "outdated" : "installed";
    const patch = {
      project_id: project.id, workspace_id: workspace.id, package_name: p.name,
      requested_version: p.requested, resolved_version: p.version, source: p.source,
      relation: p.relation, required_by: p.required_by, status,
      integrity: p.integrity, runtime_target: p.runtime_target,
      vulnerability_status: p.vulnerability_status, vulnerabilities: p.vulnerabilities,
      dependency_fingerprint: resolution.fingerprint, lockfile_version: LOCKFILE_VERSION,
      source_version_number: version_number ?? null, updated_at: nowIso(),
    };
    const row = byName.get(p.name);
    rows.push(row ? await svc.entities.ProjectDependency.update(row.id, patch) : await svc.entities.ProjectDependency.create({ ...patch, installed_at: nowIso() }));
    byName.delete(p.name);
  }
  // Anything no longer in the lockfile is gone from the project's dependency state.
  for (const stale of byName.values()) await svc.entities.ProjectDependency.delete(stale.id).catch(() => {});
  return rows;
}

// --- architecture integration (#25, read-only) -----------------------------------

/**
 * Which architecture nodes a package change touches, using the EXISTING #25 graph. Read-only: the
 * architecture is never written here, and when no architecture version exists yet the answer is an
 * explicit "not available" rather than an invented one.
 */
export async function architectureImpact(svc, { project, package_names = [], change_type = "modify" }) {
  const [architecture] = await svc.entities.Architecture.filter({ project_id: project.id, status: "FINALIZED" }, "-version", 1).catch(() => []);
  if (!architecture) return { available: false, reason: "no finalized architecture version exists for this project yet", affected_nodes: [], package_nodes: [] };
  const [nodes, edges] = await Promise.all([
    svc.entities.ArchitectureNode.filter({ architecture_id: architecture.id }, "node_key", 800),
    svc.entities.ArchitectureEdge.filter({ architecture_id: architecture.id }, "edge_key", 2500),
  ]);
  const targets = package_names.map((n) => `external_dependency:${n}`).filter((k) => nodes.some((n) => n.node_key === k));
  if (!targets.length) {
    return {
      available: true, architecture_id: architecture.id, architecture_version: architecture.version,
      affected_nodes: [], package_nodes: [],
      reason: "no architecture node deterministically references these packages",
    };
  }
  const impact = analyzeImpact({ nodes, edges, targets, change_type, depth: 2 });
  return {
    available: true, architecture_id: architecture.id, architecture_version: architecture.version,
    architecture_fingerprint: architecture.architecture_fingerprint,
    package_nodes: targets,
    affected_nodes: [...impact.directly_affected, ...impact.transitively_affected].sort(),
    affected_files: impact.likely_affected_files, affected_functions: impact.likely_affected_functions,
    risk_level: impact.risk_level, verification_surfaces: impact.verification_surfaces,
  };
}

// --- impact summary ---------------------------------------------------------------

/** The structured, pre-mutation summary of a dependency change. */
function changeSummary({ before, after }) {
  const beforeMap = new Map(before.map((p) => [p.name, p]));
  const afterMap = new Map(after.map((p) => [p.name, p]));
  const added = after.filter((p) => !beforeMap.has(p.name)).map((p) => ({ package_name: p.name, resolved_version: p.version, relation: p.relation }));
  const removed = before.filter((p) => !afterMap.has(p.name)).map((p) => ({ package_name: p.name, resolved_version: p.version, relation: p.relation }));
  const changed = after.filter((p) => beforeMap.has(p.name) && beforeMap.get(p.name).version !== p.version)
    .map((p) => ({ package_name: p.name, from_version: beforeMap.get(p.name).version, to_version: p.version }));
  return { added, removed, changed, unchanged: after.filter((p) => beforeMap.get(p.name)?.version === p.version).length };
}

// --- authorized reads --------------------------------------------------------------

/** Lists the project's dependencies, re-synced from the authoritative lockfile. */
export async function listDependencies(base44, user, { project_id, registry_mode = null } = {}) {
  requireUser(user);
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const { files } = await loadProjectState(base44, project.id);
  const manifest = readManifest(files);
  const lock = readLockfile(files);
  const cfg = supplyConfig({ mode: registry_mode || lock.raw?.registry_mode || undefined });
  // A read never fetches artifacts: it resolves metadata only, so listing dependencies cannot
  // download anything or mutate the cache.
  const resolution = await resolveForProject(base44, { dependencies: manifest.dependencies, cfg }).catch(() => null);
  const validation = validateDependencyState({ manifest, lock, resolution });
  if (validation.resolution.ok) await syncProjection(svc, { project, workspace, resolution: validation.resolution, validation, version_number: project.version_count });
  const rows = await svc.entities.ProjectDependency.filter({ project_id: project.id }, "package_name", PACKAGE_LIMITS.tree + 50);
  return {
    project_id: project.id,
    manifest_present: manifest.exists, lockfile_present: lock.exists,
    manifest: manifest.dependencies,
    dependency_fingerprint: lock.fingerprint || validation.resolution.fingerprint || null,
    registry_version: REGISTRY_VERSION, runtime_target: RUNTIME_TARGET,
    registry_mode: cfg.mode, registry_source: lock.raw?.registry_source || REGISTRY_SOURCE,
    registry_metadata_fingerprint: lock.raw?.registry_metadata_fingerprint || null,
    install_scripts_blocked: true,
    count: rows.length, dependencies: rows.map(publicDependency),
    validation: { status: validation.status, failed_checks: validation.failed_checks, drift: validation.drift, vulnerabilities: validation.vulnerabilities, unknown_advisory_packages: validation.unknown_advisory_packages },
  };
}

/** The resolved tree: direct dependencies, what each one pulled in, and who required it. */
export async function inspectDependencyTree(base44, user, { project_id, registry_mode = null } = {}) {
  requireUser(user);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const { files } = await loadProjectState(base44, project.id);
  const manifest = readManifest(files);
  const lock = readLockfile(files);
  const cfg = supplyConfig({ mode: registry_mode || lock.raw?.registry_mode || undefined });
  const resolution = await resolveForProject(base44, { dependencies: manifest.dependencies, cfg });
  if (!resolution.ok) {
    return { project_id: project.id, ok: false, code: resolution.code, message: resolution.message, details: resolution.details, tree: [], locked: lock.packages };
  }
  const tree = resolution.packages.map((p) => ({
    package_name: p.name, resolved_version: p.version, requested_version: p.requested,
    relation: p.relation, required_by: p.required_by, integrity: p.integrity,
    dependencies: Object.entries(p.dependencies).map(([name, range]) => ({ package_name: name, range, resolved_version: resolution.packages.find((x) => x.name === name)?.version || null })),
    peer_dependencies: Object.entries(p.peer_dependencies || {}).map(([name, range]) => ({ package_name: name, range, resolved_version: resolution.packages.find((x) => x.name === name)?.version || null })),
    vulnerability_status: p.vulnerability_status, exports: p.exports,
    license: p.license ?? null, license_status: p.license_status || null,
    declares_install_script: !!p.declares_install_script, install_scripts_blocked: true,
  }));
  return {
    project_id: project.id, ok: true,
    dependency_fingerprint: resolution.fingerprint,
    lockfile_fingerprint: lock.fingerprint || null,
    lockfile_matches: lock.exists ? lock.fingerprint === resolution.fingerprint : false,
    direct: tree.filter((t) => t.relation === "direct").map((t) => t.package_name),
    transitive: tree.filter((t) => t.relation === "transitive").map((t) => t.package_name),
    count: tree.length, tree,
  };
}

/** Validates the recorded dependency state without changing anything. */
export async function validateDependencies(base44, user, { project_id, registry_mode = null } = {}) {
  requireUser(user);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const { files } = await loadProjectState(base44, project.id);
  const manifest = readManifest(files);
  const lock = readLockfile(files);
  const cfg = supplyConfig({ mode: registry_mode || lock.raw?.registry_mode || undefined });
  const resolution = await resolveForProject(base44, { dependencies: manifest.dependencies, cfg }).catch(() => null);
  const validation = validateDependencyState({ manifest, lock, resolution });
  return {
    project_id: project.id, status: validation.status, passed: validation.passed,
    failure_class: validation.failure_class, failed_checks: validation.failed_checks,
    checks: validation.checks, drift: validation.drift,
    vulnerabilities: validation.vulnerabilities, unknown_advisory_packages: validation.unknown_advisory_packages,
    dependency_fingerprint: validation.resolution.ok ? validation.resolution.fingerprint : null,
    registry_version: REGISTRY_VERSION, runtime_target: RUNTIME_TARGET,
    registry_mode: cfg.mode, install_scripts_blocked: true,
  };
}

export const dependencyCatalog = () => ({ registry_version: REGISTRY_VERSION, source: REGISTRY_SOURCE, runtime_target: RUNTIME_TARGET, packages: listCatalog() });

// --- mutation ---------------------------------------------------------------------

function nextManifest({ operation, current, package_name, version }) {
  const deps = { ...current };
  if (operation === "remove") {
    if (!(package_name in deps)) fail(404, "DEPENDENCY_NOT_FOUND", `${package_name} is not a direct dependency of this project`, { package_name });
    delete deps[package_name];
    return deps;
  }
  if (operation === "update") {
    if (!(package_name in deps)) fail(404, "DEPENDENCY_NOT_FOUND", `${package_name} is not a direct dependency of this project`, { package_name });
  }
  const range = String(version || "").trim() || `^${availableVersions(package_name).slice(-1)[0] || "0.0.0"}`;
  if (!parseRange(range)) fail(422, "INVALID_VERSION", `'${range}' is not a supported version range. Use an exact version, ^x.y.z, ~x.y.z or >=x.y.z.`, { package_name, requested_version: range });
  deps[package_name] = range;
  return deps;
}

/**
 * THE dependency mutation path. Every package change — add, remove, update — goes through here.
 *
 * Order matters and is the safety property: resolve → validate → write files → BUILD → only then
 * commit and version. A failure at any step before the commit leaves the project exactly as it was,
 * so a failed resolution or a failed build can never leave partially applied dependency state.
 *
 * `dry_run` returns the same structured impact summary without mutating anything, which is how a
 * caller sees what a change would do before applying it.
 */
export async function applyDependencyChange(base44, user, {
  project_id, operation, package_name, version = null,
  dry_run = false, expected_version_number = null, trace_id = null, run_id = null,
  registry_mode = null,
} = {}) {
  requireUser(user);
  if (!DEPENDENCY_OPERATIONS.includes(operation)) fail(400, "INVALID_OPERATION", `operation must be one of ${DEPENDENCY_OPERATIONS.join(", ")}`);
  const name = String(package_name || "").trim().slice(0, PACKAGE_LIMITS.name);
  if (!name) fail(400, "INVALID_INPUT", "package_name is required");
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const svc = svcOf(base44);
  const started = Date.now();

  const record = async (status, extra) => {
    if (!trace_id) return;
    await recordSpan(svc, {
      trace_id, workspace_id: workspace.id, project_id: project.id, run_id: run_id || null,
      event_type: "background_job", name: `dependency.${operation}`, status,
      reference_id: project.id, duration_ms: Date.now() - started,
      metadata: scrub({ package_name: name, requested_version: version, dry_run, ...extra }),
    }).catch(() => {});
  };
  // The refusal span is written BEFORE the error is thrown, so a refused operation is always
  // visible in the trace rather than racing the caller's next read.
  const refuse = async (status, code, message, details, failure_class) => {
    await record("error", { code, failure_class });
    return fail(status, code, message, { ...details, failure_class });
  };

  // The state this operation starts from. Captured once, so the concurrency check below compares
  // against a version the caller actually observed.
  const { files, entities, secrets } = await loadProjectState(base44, project.id);
  const baseVersion = project.version_count || 0;
  if (expected_version_number != null && Number(expected_version_number) !== baseVersion) {
    await refuse(409, "VERSION_CONFLICT", `The project moved to version ${baseVersion} since this dependency change was prepared`, { expected_version_number, current_version_number: baseVersion }, "version_conflict");
  }
  const manifest = readManifest(files);
  const beforeLock = readLockfile(files);
  // The supply-chain mode comes from SERVER configuration (or the project's own lockfile), never
  // from an unbounded client value.
  const cfg = supplyConfig({ mode: registry_mode || beforeLock.raw?.registry_mode || undefined });
  const beforeResolution = await resolveForProject(base44, { dependencies: manifest.dependencies, cfg }).catch(() => ({ ok: false, packages: [] }));

  if (operation !== "remove" && cfg.mode === "curated" && !packageEntry(name)) {
    await refuse(404, "PACKAGE_NOT_FOUND", `Package '${name}' is not available in the ${REGISTRY_SOURCE} registry`, { package_name: name, available: Object.keys(PACKAGE_CATALOG) }, "resolution_failure");
  }
  // Registry mode with no explicit range pins the registry's highest published version at request
  // time; a package the registry does not publish is refused before anything is prepared.
  if (operation !== "remove" && cfg.mode === "registry" && !String(version || "").trim()) {
    let meta;
    try { meta = await fetchPackageMetadata(name, cfg); } catch (e) {
      await refuse(e.status || 502, e.code || "REGISTRY_UNAVAILABLE", e.message, e.details || {}, e.failure_class || "registry_unavailable");
    }
    if (!meta.ok) await refuse(404, "PACKAGE_NOT_FOUND", `Package '${name}' is not published by ${new URL(cfg.registry_url).host}`, { package_name: name }, "resolution_failure");
    const latest = meta.entry.versions[meta.dist_tags?.latest] ? meta.dist_tags.latest : Object.keys(meta.entry.versions).sort((a, b) => compareVersions(b, a))[0];
    version = `^${latest}`;
  }
  // Input-level refusals (unknown direct dependency, unsupported range) are traced through the same
  // channel as every other refusal, so no refused operation is invisible in the trace.
  let desired;
  try {
    desired = nextManifest({ operation, current: manifest.dependencies, package_name: name, version });
  } catch (e) {
    await refuse(e.status || 422, e.code || "INVALID_INPUT", e.message, e.details || {}, e.code === "INVALID_VERSION" ? "invalid_input" : "resolution_failure");
  }

  // 1) Resolution — refused BEFORE any write, with the structured reason.
  let resolution;
  try {
    resolution = await resolveForProject(base44, { dependencies: desired, cfg });
  } catch (e) {
    await refuse(e.status || 502, e.code || "REGISTRY_UNAVAILABLE", e.message, e.details || {}, e.failure_class || "registry_unavailable");
  }
  if (!resolution.ok) {
    const failure_class = resolution.code === "RUNTIME_INCOMPATIBLE" ? "runtime_incompatible"
      : resolution.code === "INVALID_VERSION" ? "invalid_input"
        : ["PACKAGE_CONFLICT", "PEER_DEPENDENCY_CONFLICT", "PEER_DEPENDENCY_MISSING"].includes(resolution.code) ? "conflict" : "resolution_failure";
    await refuse(422, resolution.code, resolution.message, resolution.details, failure_class);
  }

  const before = beforeResolution.ok ? beforeResolution.packages : beforeLock.packages.map((p) => ({ name: p.name, version: p.version, relation: p.relation }));
  const summary = changeSummary({ before, after: resolution.packages });
  const arch = await architectureImpact(svc, { project, package_names: [...summary.added, ...summary.changed, ...summary.removed].map((c) => c.package_name), change_type: operation === "remove" ? "delete" : "modify" });
  const impact = {
    operation, package_name: name, requested_version: version,
    packages_added: summary.added, packages_removed: summary.removed, packages_changed: summary.changed,
    resolved_version_changes: summary.changed,
    dependency_fingerprint: resolution.fingerprint,
    previous_dependency_fingerprint: beforeLock.fingerprint || null,
    known_vulnerabilities: resolution.packages.filter((p) => p.vulnerability_status === "vulnerable").flatMap((p) => p.vulnerabilities.map((v) => ({ package_name: p.name, resolved_version: p.version, ...v }))),
    unknown_vulnerability_data: resolution.packages.filter((p) => p.vulnerability_status === "unknown").map((p) => `${p.name}@${p.version}`),
    conflicts: [],
    architecture_impact: arch,
    base_version_number: baseVersion,
  };

  // 2) Idempotency — an operation that changes nothing produces no version and no duplicate rows.
  const unchanged = beforeLock.exists && beforeLock.fingerprint === resolution.fingerprint &&
    JSON.stringify(sortedDeps(manifest.dependencies)) === JSON.stringify(sortedDeps(desired));
  if (unchanged) {
    await syncProjection(svc, { project, workspace, resolution, validation: null, version_number: baseVersion });
    await record("ok", { unchanged: true, dependency_fingerprint: resolution.fingerprint });
    return { ok: true, unchanged: true, applied: false, dry_run: !!dry_run, impact, build: null, version: null, dependency_fingerprint: resolution.fingerprint, dependencies: resolution.packages.map((p) => ({ package_name: p.name, resolved_version: p.version, relation: p.relation })) };
  }

  // 3) SUPPLY CHAIN — every resolved package is prepared BEFORE a single project file is written:
  //    license and advisory policy, then a validated cached artifact or a bounded download whose
  //    bytes are verified against the published integrity, its exports read from the verified
  //    archive, its lifecycle scripts recorded as blocked. A refusal here writes nothing.
  let supply;
  try {
    supply = await prepareResolution(base44, { project, workspace, resolution, cfg, trace_id, run_id });
  } catch (e) {
    await refuse(e.status || 422, e.code || "PACKAGE_PREPARE_FAILED", e.message, e.details || {}, e.failure_class || "resolution_failure");
  }
  impact.supply_chain = {
    registry_mode: cfg.mode, registry_source: resolution.registry_source || REGISTRY_SOURCE,
    registry_metadata_fingerprint: resolution.registry_metadata_fingerprint || null,
    prepared: !!supply.prepared, cache: supply.cache, advisory: supply.advisory,
    unknown_advisory_packages: supply.unknown_advisory_packages || impact.unknown_vulnerability_data,
    blocked_install_scripts: supply.blocked_install_scripts, install_scripts_executed: false,
    integrity_verified: cfg.mode === "registry" ? resolution.packages.every((p) => p.integrity_verified) : "catalog_derived",
    licenses: resolution.packages.map((p) => ({ package_name: p.name, license: p.license ?? null, license_status: p.license_status || null })),
  };
  // Re-derive the advisory-driven summary from the PREPARED posture, so the impact report reflects
  // what was actually verified rather than what the metadata alone suggested.
  impact.known_vulnerabilities = resolution.packages.filter((p) => p.vulnerability_status === "vulnerable").flatMap((p) => (p.vulnerabilities || []).map((v) => ({ package_name: p.name, resolved_version: p.version, ...v })));
  impact.unknown_vulnerability_data = resolution.packages.filter((p) => p.vulnerability_status === "unknown").map((p) => `${p.name}@${p.version}`);

  // 4) Write the manifest + lockfile into the virtual filesystem, then run the EXISTING build
  //    validation over the result. Nothing is committed yet.
  const fs = createFs(files);
  writeFile(fs, MANIFEST_FILE, manifestContent(desired, manifest.raw));
  if (Object.keys(desired).length === 0 && resolution.packages.length === 0) {
    if (beforeLock.exists) deleteFile(fs, LOCKFILE_FILE); // no dependencies ⇒ no lockfile
  } else writeFile(fs, LOCKFILE_FILE, lockfileContent(resolution));

  const nextFiles = activeFiles(fs);
  const validation = validateDependencyState({ manifest: readManifest(nextFiles), lock: readLockfile(nextFiles), resolution });
  if (!validation.passed) {
    await refuse(422, "DEPENDENCY_VALIDATION_FAILED", `The resulting dependency state is not valid: ${validation.failed_checks.join(", ")}`, { checks: validation.checks, drift: validation.drift }, validation.failure_class);
  }
  const build = runBuild(fs, entities, secrets);
  impact.build = { status: build.status, errors: build.errors, duration_ms: build.duration_ms, error_logs: build.logs.filter((l) => l.startsWith("error")).slice(0, 6) };
  impact.validation = { status: validation.status, checks: validation.checks };

  if (dry_run) {
    await record("ok", { dry_run: true, build_status: build.status });
    return { ok: build.status === "success", applied: false, dry_run: true, unchanged: false, impact, build: impact.build, version: null, dependency_fingerprint: resolution.fingerprint };
  }
  if (build.status !== "success") {
    // Build failure ⇒ nothing is written. The project keeps its previous dependency state exactly.
    // R-9/R-10 (provisional, PA-42): the build error is preserved; a lost history row is reported.
    let build_history_saved = true;
    try {
      await svc.entities.Build.create({ project_id: project.id, run_id: run_id || undefined, status: build.status, logs: build.logs.slice(-100), error_count: build.errors, file_count: build.file_count, duration_ms: build.duration_ms });
    } catch { build_history_saved = false; }
    await refuse(422, "BUILD_FAILED", `The dependency change does not build: ${impact.build.error_logs.join(" | ") || `${build.errors} error(s)`}${build_history_saved ? "" : " (this failed build could not be saved to build history)"}`, { build: impact.build, build_history_saved }, "build_failure");
  }

  // 4) Concurrency: re-assert the version the change was prepared against immediately before the
  //    commit, so two simultaneous mutations cannot overwrite each other.
  const fresh = await svc.entities.Project.get(project.id);
  if ((fresh.version_count || 0) !== baseVersion) {
    await refuse(409, "VERSION_CONFLICT", `The project moved to version ${fresh.version_count} while this dependency change was validating`, { base_version_number: baseVersion, current_version_number: fresh.version_count || 0 }, "version_conflict");
  }

  // 5) Commit through the EXISTING project mutation + versioning path.
  const changedFiles = computeChanges(fs);
  await commitFiles(svc, project.id, fs);
  const summaryText = operation === "remove" ? `Remove dependency ${name}`
    : operation === "update" ? `Update dependency ${name} to ${desired[name]}`
      : `Add dependency ${name}@${desired[name]}`;
  const projectVersion = await createVersion(svc, {
    project: fresh, fs, entities, secrets,
    message: summaryText, changedFiles, runId: run_id || null,
  });
  const buildRow = await svc.entities.Build.create({
    project_id: project.id, run_id: run_id || undefined, status: build.status,
    logs: build.logs.slice(-100), error_count: build.errors, file_count: build.file_count, duration_ms: build.duration_ms,
  }).catch(() => null);
  const rows = await syncProjection(svc, { project, workspace, resolution, validation, version_number: projectVersion.number });

  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: `dependency.${operation}`, resource: "ProjectDependency", resource_id: project.id,
    metadata: scrub({
      package_name: name, requested_version: desired[name] || null, operation,
      dependency_fingerprint: resolution.fingerprint, previous_dependency_fingerprint: beforeLock.fingerprint || null,
      registry_mode: cfg.mode, registry_metadata_fingerprint: resolution.registry_metadata_fingerprint || null,
      cache_hits: supply.cache?.hits ?? 0, cache_misses: supply.cache?.misses ?? 0,
      integrity_verified: impact.supply_chain.integrity_verified,
      blocked_install_scripts: (supply.blocked_install_scripts || []).map((b) => `${b.package_name}: ${b.scripts.join(",")}`),
      install_scripts_executed: false,
      version_number: projectVersion.number, build_status: build.status,
      packages_added: summary.added.map((p) => `${p.package_name}@${p.resolved_version}`),
      packages_removed: summary.removed.map((p) => p.package_name),
      packages_changed: summary.changed.map((p) => `${p.package_name} ${p.from_version}→${p.to_version}`),
      trace_id: trace_id || null, run_id: run_id || null,
    }),
  });
  await record("ok", {
    dependency_fingerprint: resolution.fingerprint, version_number: projectVersion.number, build_status: build.status,
    registry_mode: cfg.mode, registry_metadata_fingerprint: resolution.registry_metadata_fingerprint || null,
    integrity_verified: impact.supply_chain.integrity_verified,
    advisory_available: supply.advisory?.available ?? null,
    cache_hits: supply.cache?.hits ?? 0, cache_misses: supply.cache?.misses ?? 0,
    blocked_install_scripts: (supply.blocked_install_scripts || []).length, install_scripts_executed: false,
  });

  return {
    ok: true, applied: true, unchanged: false, dry_run: false,
    impact, build: impact.build,
    version: { version_id: projectVersion.id, number: projectVersion.number, message: summaryText, changed_files: changedFiles },
    build_id: buildRow?.id || null,
    dependency_fingerprint: resolution.fingerprint,
    dependencies: rows.map(publicDependency),
  };
}

// --- supply-chain inspection --------------------------------------------------------

/** The supply-chain contract itself: mode, registry, limits and policy. No project state. */
export const supplyCapabilities = () => {
  const cfg = supplyConfig();
  return {
    registry_mode: cfg.mode, registry_modes: REGISTRY_MODES,
    registry_source: cfg.mode === "registry" ? new URL(cfg.registry_url).host : REGISTRY_SOURCE,
    allowed_registry_hosts: ALLOWED_REGISTRY_HOSTS,
    advisory_source: cfg.mode === "registry" ? new URL(cfg.advisory_url).host : "curated-catalog",
    security_threshold: cfg.security_threshold,
    license_policy: LICENSE_POLICY, require_license: cfg.require_license,
    lifecycle_scripts_blocked: LIFECYCLE_SCRIPTS,
    supply_chain_version: SUPPLY_CHAIN_VERSION, limits: SUPPLY_LIMITS,
  };
};

/**
 * Registry metadata for ONE package: published versions and the per-version integrity, dependency,
 * license and lifecycle-script facts. Authorized (the caller must be able to read the project this
 * is inspected for) and allowlisted, so this is not a general-purpose outbound fetch.
 */
export async function inspectRegistryPackage(base44, user, { project_id, package_name, version = null, registry_mode = null } = {}) {
  requireUser(user);
  await loadAuthorizedProject(base44, user, project_id, "project.read");
  const name = String(package_name || "").trim().slice(0, PACKAGE_LIMITS.name);
  if (!name) fail(400, "INVALID_INPUT", "package_name is required");
  const cfg = supplyConfig({ mode: registry_mode || undefined });
  if (cfg.mode !== "registry") {
    const entry = packageEntry(name);
    if (!entry) fail(404, "PACKAGE_NOT_FOUND", `Package '${name}' is not available in the ${REGISTRY_SOURCE} registry`, { package_name: name });
    return {
      registry_mode: "curated", registry_source: REGISTRY_SOURCE, package_name: name, exists: true,
      versions: availableVersions(name), advisory_data_available: entry.advisory_data,
      version_metadata: Object.fromEntries(availableVersions(name).map((v) => [v, packageVersion(name, v)])),
    };
  }
  const meta = await fetchPackageMetadata(name, cfg);
  if (!meta.ok) fail(404, "PACKAGE_NOT_FOUND", `Package '${name}' is not published by ${new URL(cfg.registry_url).host}`, { package_name: name });
  const versions = Object.keys(meta.entry.versions).sort(compareVersions);
  const pick = version && meta.entry.versions[version] ? version : (meta.entry.versions[meta.dist_tags?.latest] ? meta.dist_tags.latest : versions.slice(-1)[0]);
  const chosen = meta.entry.versions[pick];
  return {
    registry_mode: "registry", registry_source: new URL(cfg.registry_url).host,
    package_name: name, exists: true, versions, dist_tags: meta.dist_tags,
    registry_metadata_fingerprint: meta.metadata_fingerprint, inspected_version: pick,
    version_metadata: {
      version: chosen.version, integrity: chosen.integrity, tarball: chosen.tarball,
      unpacked_size: chosen.unpacked_size, deprecated: chosen.deprecated,
      dependencies: chosen.dependencies, peer_dependencies: chosen.peer_dependencies,
      optional_dependencies: chosen.optional_dependencies,
      declares_install_script: chosen.has_install_script, install_scripts_blocked: true,
      ...classifyLicense(chosen.license, cfg),
      cache_key: cacheKey(name, chosen.version, chosen.integrity),
    },
  };
}

/** Package preparation history for a project, plus the verified cache entries it resolved to. */
export async function packagePrepareStatus(base44, user, { project_id, limit = 50 } = {}) {
  requireUser(user);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const fetches = await svc.entities.PackageFetch.filter({ project_id: project.id }, "-created_date", Math.min(Number(limit) || 50, 200));
  const keys = [...new Set(fetches.map((f) => f.cache_key).filter(Boolean))].slice(0, 50);
  const cache_entries = [];
  for (const key of keys) {
    const [row] = await svc.entities.PackageCacheEntry.filter({ cache_key: key }, "-created_date", 1).catch(() => []);
    if (row) {
      cache_entries.push({
        cache_key: row.cache_key, package_name: row.package_name, version: row.version,
        integrity: row.integrity, content_sha512: row.content_sha512, exports: row.exports || [],
        exports_source: row.exports_source, license: row.license || null, license_status: row.license_status,
        advisory_status: row.advisory_status, install_scripts: row.install_scripts || [],
        install_scripts_blocked: true, use_count: row.use_count || 1, verified_at: row.verified_at,
        supply_chain_version: row.supply_chain_version || null,
      });
    }
  }
  return {
    project_id: project.id, count: fetches.length, install_scripts_executed: false,
    fetches: fetches.map((f) => ({
      fetch_id: f.id, package_name: f.package_name, requested_range: f.requested_range || null,
      resolved_version: f.resolved_version || null, status: f.status, cache_result: f.cache_result,
      integrity_verified: !!f.integrity_verified, failure_class: f.failure_class || null, detail: f.detail || null,
      advisory_status: f.advisory_status, license: f.license || null, license_status: f.license_status,
      blocked_install_scripts: f.blocked_install_scripts || [], install_scripts_blocked: true,
      size_bytes: f.size_bytes ?? null, duration_ms: f.duration_ms ?? null,
      registry_source: f.registry_source || null, trace_id: f.trace_id || null,
      created_at: f.created_at || f.created_date,
    })),
    cache_entries,
  };
}

export const addDependency = (base44, user, args = {}) => applyDependencyChange(base44, user, { ...args, operation: "add" });
export const removeDependency = (base44, user, args = {}) => applyDependencyChange(base44, user, { ...args, operation: "remove" });
export const updateDependency = (base44, user, args = {}) => applyDependencyChange(base44, user, { ...args, operation: "update" });