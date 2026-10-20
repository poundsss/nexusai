// The manifest / lockfile READERS — a leaf module with no dependencies of its own.
//
// It lives apart from dependencies.ts so the build engine and the shared execution contract can
// read the resolved dependency state without importing the mutation layer (which in turn imports
// the build engine). One reader, used by every environment: that is what keeps verification,
// preview and production from drifting apart, and why there is no second dependency loader.
export const MANIFEST_FILE = "package.json";
export const LOCKFILE_FILE = "package.lock.json";
export const LOCKFILE_VERSION = 1;

const lockDoc = (files) => {
  const file = (files || []).find((f) => f.path === LOCKFILE_FILE);
  if (!file) return null;
  try { return JSON.parse(file.content || "{}"); } catch { return null; }
};

/**
 * The installed package set as the build and the runtime need it: name, exact resolved version and
 * the module's allowed exports. Derived from the project's own lockfile, so an environment can only
 * load what the lockfile pinned.
 */
export function installedPackages(files) {
  const doc = lockDoc(files);
  if (!doc) return [];
  return (Array.isArray(doc.packages) ? doc.packages : [])
    .filter((p) => p && p.name && p.version)
    .map((p) => ({
      name: String(p.name), version: String(p.version),
      exports: Array.isArray(p.exports) ? p.exports.map(String) : [],
      integrity: p.integrity || null, relation: p.relation || "direct",
      // Supply-chain facts the lockfile pinned in registry mode (absent in curated mode).
      content_sha512: p.content_sha512 || null, license: p.license ?? null,
      license_status: p.license_status || null, advisory_status: p.advisory_status || null,
      install_scripts: Array.isArray(p.install_scripts) ? p.install_scripts.map(String) : [],
      install_scripts_blocked: p.install_scripts_blocked !== false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * DOCUMENT-level validation of one file set's dependency documents — the ONE check the build and the
 * deployment verification share. It resolves nothing and installs nothing: it states only whether
 * the manifest and the lockfile are well-formed and agree with each other, so a malformed document,
 * or a manifest declaring a package the lockfile does not pin, fails BEFORE an artifact exists.
 * A file set carrying neither document has nothing to validate and is valid.
 */
export function validateDependencyFiles(files) {
  const errors = [];
  const manifestFile = (files || []).find((f) => f.path === MANIFEST_FILE);
  const lockFile = (files || []).find((f) => f.path === LOCKFILE_FILE);
  if (!manifestFile && !lockFile) return { ok: true, errors, declared: [], pinned: [] };

  let declaredDeps = null;
  if (manifestFile) {
    try {
      const doc = JSON.parse(manifestFile.content || "{}");
      const deps = doc.dependencies;
      if (deps && (typeof deps !== "object" || Array.isArray(deps))) errors.push(`${MANIFEST_FILE}: 'dependencies' must be an object of package name → version range`);
      else declaredDeps = deps || {};
    } catch (e) {
      errors.push(`${MANIFEST_FILE}: is not valid JSON (${e.message})`);
    }
  }

  let lockPackages = null;
  if (lockFile) {
    try {
      const doc = JSON.parse(lockFile.content || "{}");
      if (!Array.isArray(doc.packages)) errors.push(`${LOCKFILE_FILE}: 'packages' must be an array of pinned packages`);
      else if (!doc.dependency_fingerprint) errors.push(`${LOCKFILE_FILE}: is missing its dependency_fingerprint`);
      else lockPackages = installedPackages(files);
    } catch (e) {
      errors.push(`${LOCKFILE_FILE}: is not valid JSON (${e.message})`);
    }
  }

  // Drift: a declared dependency with no pinned resolution was never installed, so nothing may be
  // built against it.
  if (declaredDeps && lockPackages) {
    const pinned = new Set(lockPackages.map((p) => p.name));
    for (const name of Object.keys(declaredDeps)) {
      if (!pinned.has(name)) errors.push(`${MANIFEST_FILE}: declares '${name}' but ${LOCKFILE_FILE} does not pin it — install dependencies to resolve it before building.`);
    }
  } else if (declaredDeps && Object.keys(declaredDeps).length && !lockFile) {
    errors.push(`${MANIFEST_FILE}: declares ${Object.keys(declaredDeps).length} dependency/dependencies but ${LOCKFILE_FILE} is missing — install dependencies to pin them.`);
  }

  return {
    ok: errors.length === 0, errors,
    declared: declaredDeps ? Object.keys(declaredDeps).sort() : [],
    pinned: lockPackages ? lockPackages.map((p) => `${p.name}@${p.version}`) : [],
  };
}

/** The resolved dependency state of one file set, for the shared execution contract. */
export function resolvedDependencyState(files) {
  const doc = lockDoc(files);
  const packages = installedPackages(files);
  return {
    packages,
    dependency_fingerprint: doc?.dependency_fingerprint || null,
    runtime_target: doc?.runtime_target || null,
    registry_source: doc?.registry_source || null,
    registry_mode: doc?.registry_mode || "curated",
    registry_metadata_fingerprint: doc?.registry_metadata_fingerprint || null,
    // No environment ever executes a package lifecycle script: the lockfile records the block and
    // the runtimes only link the exports it pinned.
    install_scripts_blocked: true,
    lockfile_present: !!doc,
    package_count: packages.length,
  };
}