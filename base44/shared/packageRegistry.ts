// NexusAI package registry — the ONE source of package metadata for generated applications.
//
// Generated apps do not fetch packages from the open internet and no install script is ever
// executed: the platform resolves against this curated, versioned catalog and the resolved code is
// linked by the existing build/runtime path. That is what makes an install deterministic
// (no network, no drift), reproducible (the same manifest always resolves identically) and safe
// (nothing arbitrary runs during installation).
//
// Everything a dependency decision needs lives on a catalog entry: the module's exports (so the
// existing build engine can link named imports), its own dependencies, its peer requirements, the
// runtime contract it targets, an integrity checksum, and — separately — whether advisory data is
// even AVAILABLE for it. Absence of advisories is reported as unknown, never as "safe".
import { fingerprint, stableStringify } from "./benchmark.ts";

export const REGISTRY_VERSION = "nexusai-pkg-registry-1";
export const REGISTRY_SOURCE = "nexusai-curated";
/** The runtime contract generated apps execute under. A package must target this to be installable. */
export const RUNTIME_TARGET = "nexusai-runtime-1";

export const PACKAGE_LIMITS = { direct: 40, tree: 200, name: 120, range: 60 };

// --- semver ---------------------------------------------------------------------

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const RANGE_RE = /^(\^|~|>=|>|=)?(\d+)\.(\d+)\.(\d+)$/;

export const parseVersion = (v) => {
  const m = VERSION_RE.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export const compareVersions = (a, b) => {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** Parses a supported range. Returns null for anything unsupported, which callers refuse outright. */
export function parseRange(range) {
  const text = String(range || "").trim();
  if (!text) return null;
  if (text === "*" || text === "latest") return { operator: "*", version: null, text };
  const m = RANGE_RE.exec(text);
  if (!m) return null;
  return { operator: m[1] || "=", version: `${m[2]}.${m[3]}.${m[4]}`, text };
}

export function satisfies(version, range) {
  const r = parseRange(range);
  const v = parseVersion(version);
  if (!r || !v) return false;
  if (r.operator === "*") return true;
  const base = parseVersion(r.version);
  const cmp = compareVersions(version, r.version);
  switch (r.operator) {
    case "=": return cmp === 0;
    case ">": return cmp > 0;
    case ">=": return cmp >= 0;
    // Caret allows changes that do not modify the left-most non-zero element.
    case "^": return cmp >= 0 && (base[0] === 0 ? v[0] === 0 && v[1] === base[1] : v[0] === base[0]);
    case "~": return cmp >= 0 && v[0] === base[0] && v[1] === base[1];
    default: return false;
  }
}

/** Highest catalog version satisfying EVERY range. Deterministic: versions are compared, not iterated by chance. */
export function maxSatisfying(versions, ranges) {
  return [...versions]
    .filter((v) => ranges.every((r) => satisfies(v, r)))
    .sort((a, b) => compareVersions(b, a))[0] || null;
}

// --- catalog --------------------------------------------------------------------

/** Deterministic integrity checksum of a catalog entry's content. */
const integrityOf = (name, version, meta) =>
  `sha256-${fingerprint("pkg", { name, version, exports: meta.exports, dependencies: meta.dependencies || {}, peer_dependencies: meta.peer_dependencies || {}, runtime: meta.runtime_target })}`;

// `advisory_data` says whether the advisory source covers this package AT ALL. When it is false the
// platform reports 'unknown' and makes no safety claim, however empty the advisory list looks.
const RAW_CATALOG = {
  "@nexus/date-format": {
    description: "Deterministic date formatting helpers.", advisory_data: true,
    versions: {
      "1.0.0": { exports: ["formatDate", "parseDate"] },
      "1.2.0": { exports: ["formatDate", "parseDate", "formatRelative"] },
      "2.0.0": { exports: ["formatDate", "parseDate", "formatRelative", "formatRange"] },
    },
  },
  "@nexus/decimal": {
    description: "Fixed-point decimal arithmetic.", advisory_data: true,
    versions: {
      "1.0.0": { exports: ["add", "subtract", "multiply"] },
      "1.2.0": { exports: ["add", "subtract", "multiply", "divide"] },
      "2.0.0": { exports: ["add", "subtract", "multiply", "divide", "round"] },
    },
  },
  "@nexus/currency": {
    description: "Currency formatting built on decimal arithmetic.", advisory_data: true,
    versions: {
      "1.0.0": { exports: ["formatMoney"], dependencies: { "@nexus/decimal": "^1.0.0" } },
      "1.1.0": { exports: ["formatMoney", "parseMoney"], dependencies: { "@nexus/decimal": "^1.0.0" } },
    },
  },
  "@nexus/strict-decimal": {
    description: "Strict decimal wrapper that requires the 2.x decimal core.", advisory_data: true,
    versions: {
      "1.0.0": { exports: ["strictAdd"], dependencies: { "@nexus/decimal": "^2.0.0" } },
    },
  },
  "@nexus/markdown": {
    description: "Markdown rendering.", advisory_data: true,
    versions: {
      "1.0.0": {
        exports: ["renderMarkdown"],
        vulnerabilities: [{ advisory_id: "NEXUS-ADV-0001", severity: "high", summary: "Unescaped HTML in rendered markdown allows script injection.", patched_in: "1.1.0" }],
      },
      "1.1.0": { exports: ["renderMarkdown", "renderInline"] },
    },
  },
  "@nexus/slugify": {
    // No advisory coverage: every resolution of this package reports vulnerability_status 'unknown'.
    description: "URL slug helpers.", advisory_data: false,
    versions: { "1.0.0": { exports: ["slugify"] } },
  },
  "@nexus/charts": {
    description: "Chart primitives; needs the 2.x date formatter.", advisory_data: true,
    versions: {
      "1.0.0": { exports: ["LineChart", "BarChart"], peer_dependencies: { "@nexus/date-format": "^2.0.0" } },
    },
  },
  "@nexus/legacy-runtime": {
    // Targets a runtime contract the platform no longer executes.
    description: "Legacy helpers for the retired runtime contract.", advisory_data: true,
    versions: { "1.0.0": { exports: ["legacyHelper"], runtime_target: "nexusai-runtime-0" } },
  },
};

/** The frozen, fully-derived catalog. Integrity checksums are content-derived, never hand-written. */
export const PACKAGE_CATALOG = Object.fromEntries(Object.entries(RAW_CATALOG).map(([name, entry]) => [name, {
  name, description: entry.description, advisory_data: entry.advisory_data !== false, source: REGISTRY_SOURCE,
  versions: Object.fromEntries(Object.entries(entry.versions).map(([version, meta]) => {
    const full = {
      version,
      exports: [...meta.exports].sort(),
      dependencies: meta.dependencies || {},
      peer_dependencies: meta.peer_dependencies || {},
      runtime_target: meta.runtime_target || RUNTIME_TARGET,
      vulnerabilities: meta.vulnerabilities || [],
    };
    return [version, { ...full, integrity: integrityOf(name, version, full) }];
  })),
}]));

// Every lookup accepts an optional catalog, so the SAME resolver can run against the built-in
// curated catalog or a snapshot of real registry metadata. Default stays the curated catalog.
export const packageEntry = (name, catalog = PACKAGE_CATALOG) => catalog[String(name)] || null;
export const packageVersion = (name, version, catalog = PACKAGE_CATALOG) => packageEntry(name, catalog)?.versions[String(version)] || null;
export const availableVersions = (name, catalog = PACKAGE_CATALOG) => Object.keys(packageEntry(name, catalog)?.versions || {}).sort((a, b) => compareVersions(a, b));

/**
 * Vulnerability posture of one resolved version. Deliberately three-valued: with no advisory
 * coverage the answer is 'unknown', because "we found nothing" and "nothing is known to us" are not
 * the same claim and only one of them is honest.
 */
export function vulnerabilityStatus(name, version, catalog = PACKAGE_CATALOG) {
  const entry = packageEntry(name, catalog);
  const meta = packageVersion(name, version, catalog);
  if (!entry || !meta) return { vulnerability_status: "unknown", vulnerabilities: [], advisory_data_available: false };
  if (!entry.advisory_data) {
    return { vulnerability_status: "unknown", vulnerabilities: [], advisory_data_available: false, note: "No vulnerability data is available for this package; no safety claim is made." };
  }
  return {
    vulnerability_status: meta.vulnerabilities.length ? "vulnerable" : "none_known",
    vulnerabilities: meta.vulnerabilities,
    advisory_data_available: true,
  };
}

/** The catalog as an operator-facing list. Metadata only — no code and no install behaviour. */
export const listCatalog = () => Object.values(PACKAGE_CATALOG).map((e) => ({
  name: e.name, description: e.description, source: e.source,
  versions: availableVersions(e.name),
  latest: availableVersions(e.name).slice(-1)[0] || null,
  advisory_data_available: e.advisory_data,
  runtime_targets: [...new Set(Object.values(e.versions).map((v) => v.runtime_target))],
}));

// --- resolution -----------------------------------------------------------------

const resolutionError = (code, message, details = {}) => ({ ok: false, code, message, details });

/**
 * Resolves a manifest's direct dependencies into a complete, deterministic package tree.
 *
 * Constraints are accumulated across the whole tree and every package is resolved to the highest
 * catalog version satisfying ALL of them, so a conflict is REPORTED rather than papered over by
 * installing two copies. Nothing here mutates project state: the caller only proceeds when
 * `ok` is true, which is what makes a failed resolution leave no partial state behind.
 */
export function resolveDependencies(directDeps, { runtime_target = RUNTIME_TARGET, catalog = PACKAGE_CATALOG } = {}) {
  const entryOf = (n) => packageEntry(n, catalog);
  const versionOf = (n, v) => packageVersion(n, v, catalog);
  const versionsOf = (n) => availableVersions(n, catalog);
  const registrySource = catalog === PACKAGE_CATALOG ? REGISTRY_SOURCE : (Object.values(catalog)[0]?.source || REGISTRY_SOURCE);
  const direct = Object.entries(directDeps || {}).sort(([a], [b]) => a.localeCompare(b));
  if (direct.length > PACKAGE_LIMITS.direct) return resolutionError("TOO_MANY_DEPENDENCIES", `A project may declare at most ${PACKAGE_LIMITS.direct} direct dependencies`);

  // 1) Every requested range must be a supported range, and every package must exist.
  const constraints = new Map(); // name -> [{ range, required_by }]
  const addConstraint = (name, range, required_by) => {
    if (!constraints.has(name)) constraints.set(name, []);
    constraints.get(name).push({ range, required_by });
  };
  for (const [name, range] of direct) {
    if (!parseRange(range)) return resolutionError("INVALID_VERSION", `'${range}' is not a supported version range for ${name}. Use an exact version, ^x.y.z, ~x.y.z or >=x.y.z.`, { package_name: name, requested_version: range });
    if (!entryOf(name)) return resolutionError("PACKAGE_NOT_FOUND", `Package '${name}' is not available in the ${registrySource} registry`, { package_name: name, available: Object.keys(catalog).slice(0, 50) });
    addConstraint(name, range, "project");
  }

  // 2) Fixed-point resolution: resolve, expand the resolved versions' own dependencies, repeat
  //    until the constraint set stops growing. Deterministic and terminating.
  let resolved = new Map();
  for (let pass = 0; pass < 8; pass++) {
    resolved = new Map();
    for (const [name, list] of [...constraints.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const versions = versionsOf(name);
      if (!versions.length) return resolutionError("PACKAGE_NOT_FOUND", `Package '${name}' is not available in the ${registrySource} registry`, { package_name: name });
      const pick = maxSatisfying(versions, list.map((c) => c.range));
      if (!pick) {
        return resolutionError("PACKAGE_CONFLICT", `No version of ${name} satisfies every requirement`, {
          package_name: name, available: versions,
          requirements: list.map((c) => ({ range: c.range, required_by: c.required_by })),
        });
      }
      resolved.set(name, pick);
    }
    const before = [...constraints.values()].reduce((n, l) => n + l.length, 0);
    for (const [name, version] of resolved) {
      for (const [dep, range] of Object.entries(versionOf(name, version).dependencies)) {
        if (!entryOf(dep)) return resolutionError("PACKAGE_NOT_FOUND", `${name}@${version} depends on '${dep}', which is not in the registry`, { package_name: dep, required_by: `${name}@${version}` });
        const existing = constraints.get(dep) || [];
        if (!existing.some((c) => c.range === range && c.required_by === `${name}@${version}`)) addConstraint(dep, range, `${name}@${version}`);
      }
    }
    if ([...constraints.values()].reduce((n, l) => n + l.length, 0) === before) break;
  }
  if (resolved.size > PACKAGE_LIMITS.tree) return resolutionError("TOO_MANY_DEPENDENCIES", `The resolved tree exceeds ${PACKAGE_LIMITS.tree} packages`);

  // 3) Runtime compatibility — refused BEFORE anything is written.
  for (const [name, version] of resolved) {
    const meta = versionOf(name, version);
    if (meta.runtime_target !== runtime_target) {
      return resolutionError("RUNTIME_INCOMPATIBLE", `${name}@${version} targets runtime ${meta.runtime_target}, but this project runs ${runtime_target}`, { package_name: name, resolved_version: version, package_runtime: meta.runtime_target, project_runtime: runtime_target });
    }
  }

  // 4) Peer dependencies: a peer that is absent or unsatisfied is a conflict, not a warning to
  //    discover at runtime.
  for (const [name, version] of resolved) {
    for (const [peer, range] of Object.entries(versionOf(name, version).peer_dependencies || {})) {
      const have = resolved.get(peer);
      if (!have) {
        return resolutionError("PEER_DEPENDENCY_MISSING", `${name}@${version} requires the peer dependency ${peer}@${range}, which the project does not install`, { package_name: name, peer_dependency: peer, required_range: range });
      }
      if (!satisfies(have, range)) {
        return resolutionError("PEER_DEPENDENCY_CONFLICT", `${name}@${version} requires ${peer}@${range} but ${peer}@${have} is installed`, { package_name: name, peer_dependency: peer, required_range: range, resolved_version: have });
      }
    }
  }

  const directNames = new Set(direct.map(([n]) => n));
  const packages = [...resolved.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => {
    const meta = versionOf(name, version);
    const list = constraints.get(name) || [];
    const vuln = vulnerabilityStatus(name, version, catalog);
    return {
      name, version,
      requested: (direct.find(([n]) => n === name) || [null, list[0]?.range || version])[1],
      source: registrySource, relation: directNames.has(name) ? "direct" : "transitive",
      required_by: [...new Set(list.map((c) => c.required_by))].sort(),
      integrity: meta.integrity, runtime_target: meta.runtime_target,
      exports: meta.exports, dependencies: meta.dependencies,
      peer_dependencies: meta.peer_dependencies || {}, optional_dependencies: meta.optional_dependencies || {},
      license: meta.license ?? null, declares_install_script: !!meta.has_install_script,
      vulnerability_status: vuln.vulnerability_status, vulnerabilities: vuln.vulnerabilities,
      advisory_data_available: vuln.advisory_data_available,
    };
  });

  return {
    ok: true, packages,
    registry_version: REGISTRY_VERSION, runtime_target, registry_source: registrySource,
    fingerprint: dependencyFingerprint({ direct: Object.fromEntries(direct), packages, runtime_target }),
  };
}

/**
 * Deterministic fingerprint of a resolved dependency graph: the same manifest, the same registry
 * state and the same runtime constraints always produce this same value.
 */
export function dependencyFingerprint({ direct, packages, runtime_target = RUNTIME_TARGET }) {
  return fingerprint("dep", {
    registry: REGISTRY_VERSION, runtime: runtime_target,
    direct: Object.keys(direct || {}).sort().map((k) => [k, direct[k]]),
    packages: (packages || []).map((p) => [p.name, p.version, p.integrity]).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
  });
}