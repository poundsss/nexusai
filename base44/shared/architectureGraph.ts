// NexusAI Architecture Intelligence — PURE EXTRACTION.
//
// This module derives a machine-readable architecture GRAPH from authoritative project state.
// It is pure and synchronous: no database, no network, no model call. Nothing here is a second
// source of truth — every node and edge carries a REFERENCE back to the system that owns the
// fact (project files own file truth, entity declarations own schema truth, build/runtime records
// own execution truth, deployments own deployment truth).
//
// Invariants enforced here rather than trusted to a prompt:
//   DERIVED, NOT INVENTED — every fact is parsed from real project state or an explicit user
//     decision. A model's claim is never an accepted source.
//   PROVENANCE — every node and edge names its source system, its source reference and its trust
//     state (verified | user_decision | inferred). A name-matching heuristic stays INFERRED with a
//     sub-1 confidence and is never promoted to verified.
//   DETERMINISTIC — the same project state produces byte-identical nodes, edges and fingerprint,
//     because everything is sorted by key and the fingerprint is content-addressed.
//   BOUNDED — hard node/edge ceilings, so a large project cannot produce an unbounded graph.
//   NO SECRETS — only secret NAMES are ever represented; values never reach this layer.
import { fingerprint } from "./benchmark.ts";
// Path CLASSIFICATION only, from the platform's own canonical layout + function-path contracts.
// Nothing here re-parses a resource document: the resource contracts own that, and their parsed
// output is handed in (see collectAuthoritativeState).
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";
import {
  isConfigPath, isAppConfigPath, isEntityFilePath, isTypesPath, isAssetPath,
  isActorFilePath, isAgentFilePath, isAgentSkillFilePath, isConnectorFilePath,
} from "./base44Layout.ts";
// The workflow RESOURCE path grammar, stated here as a classification rule so this pure module
// stays leaf-level (the document contract itself lives in shared/workflowResource.ts).
const isWorkflowFilePath = (path) => /^base44\/workflows\/[A-Za-z][A-Za-z0-9 _-]*\.jsonc$/.test(String(path || ""));
import { deriveResourceNodes, hostOf } from "./architectureResources.ts";

export const EXTRACTION_VERSION = "arch-extract-2";
export const ARCHITECTURE_SCHEMA_VERSION = 1;

export const NODE_TYPES = [
  "domain", "entity", "relationship", "page", "component", "function",
  "route", "workflow", "integration", "role", "external_dependency", "storage",
  // The platform's canonical resource primitives, represented as first-class architecture nodes.
  // Each is DERIVED from the project's own resource declaration — never from a second model.
  "config", "agent", "skill", "tool", "connector", "actor", "realtime_surface",
  "auth", "analytics", "asset", "plugin",
];
export const RELATIONSHIP_TYPES = [
  "depends_on", "reads", "writes", "calls", "renders", "triggers",
  "authorizes", "belongs_to", "transforms", "publishes", "consumes",
  // An agent's declared tool grants, and the resources a config declaration governs.
  "grants", "configures",
];
export const PROVENANCE_STATES = ["verified", "user_decision", "inferred"];
export const PROVENANCE_SOURCES = [
  "project_file", "entity_schema", "function", "page_component", "integration",
  "workflow", "permission", "project_version", "user_decision", "system_fact", "memory_decision",
  // The canonical resource declarations, each named as its own evidence source so a fact's origin
  // stays checkable against the contract that produced it.
  "config", "agent", "agent_skill", "connector", "actor", "auth", "analytics", "asset", "plugin",
];

// An inferred fact can never present itself with verified-level confidence.
const CONFIDENCE_CEILING = { verified: 1, user_decision: 1, inferred: 0.7 };
export const GRAPH_LIMITS = { nodes: 800, edges: 2500, per_file_refs: 40, text: 200, subgraph: 60, impact: 120, traversal_depth: 4 };

export const nodeKey = (node_type, key) => `${node_type}:${key}`;
export const edgeKey = (from, relationship, to) => `${from}|${relationship}|${to}`;

const clip = (v, n = GRAPH_LIMITS.text) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const uniq = (a) => [...new Set(a)];
const clampConfidence = (state, confidence) =>
  Math.max(0, Math.min(CONFIDENCE_CEILING[state] ?? 0.7, confidence == null ? CONFIDENCE_CEILING[state] ?? 0.7 : Number(confidence)));

// --- reference extraction from file content -----------------------------------

const IMPORT_RE = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DB_RE = /\bdb\.([A-Z][A-Za-z0-9_]*)\s*\.\s*([a-zA-Z]+)/g;
const SERVER_RE = /\bserver\.([a-zA-Z][A-Za-z0-9_]*)/g;
// Generated apps reach the same data and function surfaces through the `base44.*` SDK. These mirror
// the db./server. grammars so the SAME reads/writes/calls edges are produced from either style.
const BASE44_ENTITY_RE = /\bbase44\.entities\.([A-Z][A-Za-z0-9_]*)\s*\.\s*([a-zA-Z]+)/g;
const BASE44_FUNCTION_RE = /\bbase44\.functions\.invoke\(\s*['"]([a-zA-Z][A-Za-z0-9_]*)['"]/g;
const INTEGRATION_RE = /\bintegrations\.([a-zA-Z][A-Za-z0-9_]*)/g;
const SECRET_RE = /secrets\.(?:get|has)\(\s*['"]([A-Z0-9_]+)['"]/g;
const ROLE_RE = /(?:role\s*(?:===?|!==?)\s*['"]([a-zA-Z_][\w-]*)['"]|requireRole\(\s*['"]([a-zA-Z_][\w-]*)['"])/g;
const ROUTE_RE = /['"](\/[a-zA-Z0-9\-_/:]*)['"]/g;
// JSX <Route path="..." element={<Component />} /> bindings. The block regex stops at the first
// `>`, which is enough to expose the path and the element's component name for the common binding;
// a nested wrapper or dynamic element that does not resolve to a page stays unknown rather than
// invented (no renders edge is created for it).
const JSX_ROUTE_BLOCK_RE = /<Route\b[^>]*?\/?>/g;
const JSX_PATH_RE = /\bpath\s*=\s*['"]([^'"]+)['"]/;
const JSX_ELEMENT_RE = /\belement\s*=\s*\{\s*<\s*([A-Za-z_$][\w$]*)/;
const WRITE_OPS = new Set(["create", "update", "delete", "insert", "upsert", "bulkCreate", "createMany", "updateMany", "deleteMany", "save"]);

const matches = (content, re, pick = (m) => m[1]) => {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(content)) && out.length < GRAPH_LIMITS.per_file_refs * 3) {
    const v = pick(m);
    if (v) out.push(v);
  }
  return out;
};

/** What one project file references. Parsed from the file's real content — the authoritative truth. */
export function fileReferences(content) {
  const text = String(content || "");
  const entityOps = new Map();
  const mergeEntity = (name, op) => {
    const prev = entityOps.get(name) || { reads: false, writes: false };
    if (WRITE_OPS.has(op)) prev.writes = true; else prev.reads = true;
    entityOps.set(name, prev);
  };
  DB_RE.lastIndex = 0;
  let m;
  while ((m = DB_RE.exec(text))) mergeEntity(m[1], m[2]);
  BASE44_ENTITY_RE.lastIndex = 0;
  while ((m = BASE44_ENTITY_RE.exec(text))) mergeEntity(m[1], m[2]);
  return {
    imports: uniq(matches(text, IMPORT_RE)).slice(0, GRAPH_LIMITS.per_file_refs),
    entities: [...entityOps.entries()].map(([name, ops]) => ({ name, ...ops })).sort((a, b) => a.name.localeCompare(b.name)).slice(0, GRAPH_LIMITS.per_file_refs),
    functions: uniq([...matches(text, SERVER_RE), ...matches(text, BASE44_FUNCTION_RE)]).sort().slice(0, GRAPH_LIMITS.per_file_refs),
    integrations: uniq(matches(text, INTEGRATION_RE)).sort().slice(0, GRAPH_LIMITS.per_file_refs),
    secrets: uniq(matches(text, SECRET_RE)).sort().slice(0, GRAPH_LIMITS.per_file_refs),
    roles: uniq(matches(text, ROLE_RE, (mm) => mm[1] || mm[2])).sort().slice(0, GRAPH_LIMITS.per_file_refs),
    exports: uniq(matches(text, /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)).slice(0, GRAPH_LIMITS.per_file_refs),
  };
}

/**
 * Which kind of node ONE project file is, across BOTH layouts. A canonical resource DOCUMENT
 * (config, entity schema, actor, agent, skill, connector, workflow, asset, generated types) returns
 * null here on purpose: its own resource contract parses it and its node is derived from that parsed
 * declaration, so a resource is never represented twice.
 */
export function fileNodeType(path) {
  const p = String(path || "");
  if (isConfigPath(p) || isAppConfigPath(p) || isEntityFilePath(p) || isTypesPath(p) || isAssetPath(p)) return null;
  if (isActorFilePath(p) || isAgentFilePath(p) || isAgentSkillFilePath(p) || isConnectorFilePath(p) || isWorkflowFilePath(p)) return null;
  if (p.startsWith("src/pages/")) return "page";
  if (p.startsWith("src/components/")) return "component";
  if (isFunctionPath(p)) return "function";
  if (p.startsWith("integrations/")) return "integration";
  return null;
}

const baseName = (path) => String(path).split("/").pop().replace(/\.(jsx?|tsx?|json)$/, "");
// Function identity comes from the platform's own path contract, so a canonical
// base44/functions/<name>/entry.ts and a legacy functions/<name>.js resolve to the same name.
const functionName = (path) => functionNameFromPath(path);

// --- graph builder -------------------------------------------------------------

/**
 * Accumulates nodes and edges with deterministic identity. A repeated node or edge key is MERGED
 * (keeping the stronger provenance), never duplicated — which is what makes reconciliation of the
 * same project state idempotent at the graph level, before any database write happens.
 */
function createBuilder() {
  const nodes = new Map();
  const edges = new Map();
  const rank = { verified: 0, user_decision: 1, inferred: 2 };

  const addNode = (node_type, key, { name = null, domain = null, reference = {}, metadata = {}, state = "inferred", source, provenance_reference = null, detail = null, confidence = null } = {}) => {
    const nk = nodeKey(node_type, key);
    const candidate = {
      node_key: nk, node_type, key: clip(key, 300), name: clip(name || key, 200), domain: domain ? clip(domain, 120) : null,
      reference, metadata, provenance_state: state, provenance_source: source,
      provenance_reference: provenance_reference ? clip(provenance_reference, 300) : null,
      provenance_detail: detail ? clip(detail, 300) : null, confidence: clampConfidence(state, confidence),
    };
    const existing = nodes.get(nk);
    if (!existing) { if (nodes.size < GRAPH_LIMITS.nodes) nodes.set(nk, candidate); return nk; }
    // Stronger evidence wins; weaker evidence never downgrades a verified node.
    if (rank[candidate.provenance_state] < rank[existing.provenance_state]) {
      nodes.set(nk, { ...candidate, metadata: { ...existing.metadata, ...candidate.metadata }, domain: candidate.domain || existing.domain });
    } else if (candidate.domain && !existing.domain) existing.domain = candidate.domain;
    return nk;
  };

  const addEdge = (from, relationship, to, { state = "inferred", source, provenance_reference = null, detail = null, confidence = null, external = false } = {}) => {
    if (!from || !to || from === to) return null;
    const ek = edgeKey(from, relationship, to);
    const candidate = {
      edge_key: ek, relationship, from_node_key: from, to_node_key: to,
      from_node_type: from.split(":")[0], to_node_type: to.split(":")[0], external: !!external,
      provenance_state: state, provenance_source: source,
      provenance_reference: provenance_reference ? clip(provenance_reference, 300) : null,
      provenance_detail: detail ? clip(detail, 300) : null, confidence: clampConfidence(state, confidence),
    };
    const existing = edges.get(ek);
    if (!existing) { if (edges.size < GRAPH_LIMITS.edges) edges.set(ek, candidate); return ek; }
    if (rank[candidate.provenance_state] < rank[existing.provenance_state]) edges.set(ek, candidate);
    return ek;
  };

  return { nodes, edges, addNode, addEdge, has: (nk) => nodes.has(nk) };
}

/** Deterministic content hash of one node / edge. Feeds the architecture fingerprint. */
export const nodeHash = (n) => fingerprint("an", { node_key: n.node_key, node_type: n.node_type, key: n.key, domain: n.domain || null, reference: n.reference || {}, metadata: n.metadata || {}, state: n.provenance_state, source: n.provenance_source, confidence: n.confidence });
export const edgeHash = (e) => fingerprint("ae", { edge_key: e.edge_key, relationship: e.relationship, from: e.from_node_key, to: e.to_node_key, external: !!e.external, state: e.provenance_state, source: e.provenance_source, confidence: e.confidence });

/**
 * Fingerprint of the whole graph plus the extraction contract that produced it. Rebuilding from
 * the same authoritative project state reproduces this value exactly, which is what makes repeated
 * reconciliation idempotent and any real architectural change detectable.
 */
export const graphFingerprint = (nodes, edges) => fingerprint("arch", {
  extraction: EXTRACTION_VERSION, schema_version: ARCHITECTURE_SCHEMA_VERSION,
  nodes: nodes.map((n) => [n.node_key, n.content_hash]),
  edges: edges.map((e) => [e.edge_key, e.content_hash]),
});

/**
 * Derives the architecture graph from AUTHORITATIVE project state.
 *
 * Inputs are exactly what the platform already owns: project files, entity declarations, entity
 * relations, scheduled workflows, integration definitions, secret METADATA (names only) and any
 * explicit user decisions (from verified project memory). Nothing is generated by a model.
 */
export function deriveArchitecture({
  project, files = [], entities = [], relations = [], workflows = [], integrations = [],
  secrets = [], decisions = [], dependencies = [], source_project_version = null,
  // The canonical resource declarations, already parsed by their OWN contracts and handed in.
  config = null, app = null, plugins = [], assets = [], agents = [], skills = [],
  connectors = [], actors = [], workflow_resources = [], auth = null, analytics = null,
} = {}) {
  const b = createBuilder();
  const sources = {
    files: 0, entities: 0, relations: 0, functions: 0, routes: 0, integrations: 0, workflows: 0,
    permissions: 0, secrets: 0, decisions: 0, dependencies: 0,
    config: 0, agents: 0, skills: 0, connectors: 0, actors: 0, workflow_resources: 0, assets: 0, plugins: 0, auth: 0, analytics: 0,
  };
  // A connector resource and its runtime integration projection are ONE external service, so the
  // service is represented once: as a connector when the project declares one, else as the legacy
  // integration node. This is what keeps a canonical project from carrying two nodes per service.
  const connectorNames = new Set((connectors || []).map((c) => c.name));
  const serviceKey = (name) => (connectorNames.has(name) ? nodeKey("connector", name) : nodeKey("integration", name));
  const entityNames = entities.map((e) => e.name).filter(Boolean);
  const domainOf = (text) => entityNames.find((n) => String(text || "").toLowerCase().includes(n.toLowerCase())) || null;
  const domainKey = (n) => String(n).toLowerCase();

  // --- domains: an inferred grouping over the project's own entity vocabulary.
  for (const name of entityNames) {
    b.addNode("domain", domainKey(name), {
      name: `${name} domain`, domain: domainKey(name),
      reference: { entity_name: name },
      state: "inferred", source: "entity_schema", provenance_reference: name,
      detail: `Domain grouped from the ${name} entity declaration`, confidence: 0.6,
    });
  }

  // --- entities + schema: the entity declaration is schema TRUTH; we store a reference and the
  //     field NAMES only, never a second schema definition.
  for (const e of entities) {
    sources.entities++;
    const fieldNames = Object.keys(e.fields || {}).slice(0, GRAPH_LIMITS.per_file_refs);
    const nk = b.addNode("entity", e.name, {
      name: e.name, domain: domainKey(e.name),
      reference: { entity_name: e.name, entity_id: e.id || null, schema_owner: "AppEntity" },
      metadata: { field_names: fieldNames, field_count: fieldNames.length },
      state: "verified", source: "entity_schema", provenance_reference: e.name,
      detail: "Read from the project's authoritative entity declaration",
    });
    b.addEdge(nk, "belongs_to", nodeKey("domain", domainKey(e.name)), { state: "inferred", source: "entity_schema", provenance_reference: e.name, detail: "Entity grouped into its own domain", confidence: 0.6 });
    // The stored records of an entity are a data resource of the project.
    const storage = b.addNode("storage", `records:${e.name}`, {
      name: `${e.name} records`, domain: domainKey(e.name),
      reference: { entity_name: e.name, resource: "AppRecord" },
      metadata: { resource_kind: "entity_records" },
      state: "verified", source: "entity_schema", provenance_reference: e.name,
      detail: "Data resource backing the entity's stored records",
    });
    b.addEdge(nk, "writes", storage, { state: "verified", source: "entity_schema", provenance_reference: e.name, detail: "Entity persists into its own record store" });
  }

  // --- relationships: declared entity relations are verified schema facts.
  for (const r of relations) {
    sources.relations++;
    const from = nodeKey("entity", r.from_entity);
    const to = nodeKey("entity", r.to_entity);
    const nk = b.addNode("relationship", r.name, {
      name: r.name, domain: domainKey(r.from_entity || ""),
      reference: { relation_name: r.name, from_entity: r.from_entity, to_entity: r.to_entity, relation_id: r.id || null },
      metadata: { type: r.type, from_field: r.from_field, on_delete: r.on_delete || "restrict", required: !!r.required },
      state: "verified", source: "entity_schema", provenance_reference: r.name,
      detail: `Declared ${r.type} relation ${r.from_entity}.${r.from_field} → ${r.to_entity}`,
    });
    b.addEdge(nk, "belongs_to", from, { state: "verified", source: "entity_schema", provenance_reference: r.name, detail: "Relation declared on this entity" });
    b.addEdge(from, "depends_on", to, { state: "verified", source: "entity_schema", provenance_reference: r.name, detail: `Foreign key ${r.from_field} references ${r.to_entity}` });
  }

  // --- integrations: definition files are the authoritative integration record. Secret NAMES only.
  for (const i of integrations) {
    // The connector declaration is authoritative for a service the project declares as a connector;
    // its integration projection would otherwise duplicate the same service.
    if (connectorNames.has(i.name)) continue;
    sources.integrations++;
    const nk = b.addNode("integration", i.name, {
      name: i.name, domain: domainOf(i.name) ? domainKey(domainOf(i.name)) : null,
      reference: { integration_name: i.name, file_path: `integrations/${i.name}.json` },
      metadata: {
        base_url_host: hostOf(i.base_url), auth_type: i.auth?.type || "none",
        // The NAME of the secret an integration authenticates with — never its value.
        secret_name: i.auth?.secret || null,
        operations: (i.operations || []).map((o) => o.name).slice(0, GRAPH_LIMITS.per_file_refs),
      },
      state: "verified", source: "integration", provenance_reference: `integrations/${i.name}.json`,
      detail: "Read from the project's integration definition",
    });
    const host = hostOf(i.base_url);
    if (host) {
      const dep = b.addNode("external_dependency", host, {
        name: host, reference: { host }, metadata: { kind: "http_service" },
        state: "verified", source: "integration", provenance_reference: `integrations/${i.name}.json`,
        detail: "External HTTP service named by the integration definition",
      });
      b.addEdge(nk, "consumes", dep, { state: "verified", source: "integration", provenance_reference: i.name, detail: "Integration calls this external service", external: true });
    }
    if (i.auth?.secret) {
      const sec = b.addNode("storage", `secret:${i.auth.secret}`, {
        name: i.auth.secret, reference: { secret_name: i.auth.secret },
        metadata: { resource_kind: "secret_reference", value_stored: false },
        state: "verified", source: "integration", provenance_reference: `integrations/${i.name}.json`,
        detail: "Secret reference (name only) used by the integration",
      });
      b.addEdge(nk, "depends_on", sec, { state: "verified", source: "integration", provenance_reference: i.name, detail: "Integration authenticates with this secret reference" });
    }
  }

  // --- installed packages: the project's LOCKFILE is the authoritative dependency record, so each
  //     resolved package is a verified external dependency carrying its exact version. A file that
  //     imports one merges into this same node below, which is what lets a package change
  //     participate in impact analysis.
  for (const dep of dependencies) {
    if (!dep?.name) continue;
    sources.dependencies++;
    const nk = b.addNode("external_dependency", dep.name, {
      name: dep.name,
      reference: { specifier: dep.name, lockfile: "package.lock.json", resolved_version: dep.version || null },
      metadata: {
        kind: "package", resolved_version: dep.version || null, relation: dep.relation || "direct",
        integrity: dep.integrity || null, exports: (dep.exports || []).slice(0, GRAPH_LIMITS.per_file_refs),
        required_by: (dep.required_by || []).slice(0, GRAPH_LIMITS.per_file_refs),
      },
      state: "verified", source: "project_file", provenance_reference: "package.lock.json",
      detail: `Package pinned at ${dep.version || "unknown"} by the project's lockfile`,
    });
    // A package's own dependencies are recorded facts of the lockfile, not guesses.
    for (const child of Object.keys(dep.dependencies || {})) {
      b.addEdge(nk, "depends_on", nodeKey("external_dependency", child), {
        state: "verified", source: "project_file", provenance_reference: "package.lock.json",
        detail: `${dep.name} depends on ${child}`, external: true,
      });
    }
  }

  // --- secret metadata: names and set-state only, from the platform's own secret projection.
  for (const s of secrets) {
    sources.secrets++;
    b.addNode("storage", `secret:${s.name}`, {
      name: s.name, reference: { secret_name: s.name },
      metadata: { resource_kind: "secret_reference", is_set: !!s.is_set, required: s.required !== false, value_stored: false },
      state: "verified", source: "system_fact", provenance_reference: s.name,
      detail: "Secret reference from the platform's secret metadata projection (no value)",
    });
  }

  // --- files: pages, components, functions, integration definitions.
  const pageByName = new Map();
  for (const f of files) {
    const type = fileNodeType(f.path);
    if (!type) continue;
    sources.files++;
    const refs = fileReferences(f.content);
    if (type === "integration") continue; // the integration node above is authoritative for these
    const key = type === "function" ? functionName(f.path) : f.path;
    const domain = domainOf(f.path) || domainOf(baseName(f.path));
    const nk = b.addNode(type, key, {
      // A canonical function file is always entry.ts, so the function's NAME is its key.
      name: type === "function" ? key : baseName(f.path), domain: domain ? domainKey(domain) : null,
      reference: { file_path: f.path, ...(type === "function" ? { function_name: key } : {}) },
      metadata: { exports: refs.exports, size: String(f.content || "").length, entity_refs: refs.entities.map((e) => e.name), secret_names: refs.secrets },
      state: "verified", source: type === "function" ? "function" : "page_component", provenance_reference: f.path,
      detail: `Parsed from the project file ${f.path}`,
    });
    if (type === "function") sources.functions++;
    if (type === "page") pageByName.set(baseName(f.path).toLowerCase(), nk);
    if (domain) b.addEdge(nk, "belongs_to", nodeKey("domain", domainKey(domain)), { state: "inferred", source: "project_file", provenance_reference: f.path, detail: "Grouped by naming overlap with the domain's entity", confidence: 0.5 });

    // Entity access, parsed from the file's real calls.
    for (const e of refs.entities) {
      const target = nodeKey("entity", e.name);
      if (e.reads) b.addEdge(nk, "reads", target, { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Reads db.${e.name} in ${f.path}` });
      if (e.writes) b.addEdge(nk, "writes", target, { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Writes db.${e.name} in ${f.path}` });
      if (e.reads && e.writes) b.addEdge(nk, "transforms", target, { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Reads and writes db.${e.name} in ${f.path}` });
    }
    for (const fn of refs.functions) b.addEdge(nk, "calls", nodeKey("function", fn), { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Calls server.${fn} in ${f.path}` });
    for (const name of refs.integrations) b.addEdge(nk, "consumes", serviceKey(name), { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Uses integrations.${name} in ${f.path}`, external: true });
    for (const secret of refs.secrets) {
      b.addNode("storage", `secret:${secret}`, { name: secret, reference: { secret_name: secret }, metadata: { resource_kind: "secret_reference", value_stored: false }, state: "verified", source: "project_file", provenance_reference: f.path, detail: "Secret reference by name in project code" });
      b.addEdge(nk, "depends_on", nodeKey("storage", `secret:${secret}`), { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Reads the ${secret} secret reference` });
    }
    for (const role of refs.roles) {
      sources.permissions++;
      b.addNode("role", role, { name: role, reference: { role }, metadata: { kind: "app_role" }, state: "verified", source: "permission", provenance_reference: f.path, detail: `Role check for '${role}' in ${f.path}` });
      b.addEdge(nodeKey("role", role), "authorizes", nk, { state: "verified", source: "permission", provenance_reference: f.path, detail: `${f.path} gates behaviour on the '${role}' role` });
    }
    // Imports: project-local imports are dependencies; anything non-relative is external.
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    for (const spec of refs.imports) {
      if (spec.startsWith(".")) {
        const resolved = resolveImport(dir, spec);
        const targetFile = files.find((x) => x.path === resolved || x.path === `${resolved}.js` || x.path === `${resolved}.jsx`);
        if (!targetFile) continue;
        const targetType = fileNodeType(targetFile.path);
        if (!targetType || targetType === "integration") continue;
        const targetKey = targetType === "function" ? functionName(targetFile.path) : targetFile.path;
        const tnk = nodeKey(targetType, targetKey);
        b.addEdge(nk, "depends_on", tnk, { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Imports ${targetFile.path}` });
        if (type === "page" && targetType === "component") b.addEdge(nk, "renders", tnk, { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Page imports and renders ${targetFile.path}` });
      } else {
        const dep = b.addNode("external_dependency", spec, {
          name: spec, reference: { specifier: spec }, metadata: { kind: "module" },
          state: "verified", source: "project_file", provenance_reference: f.path,
          detail: `Non-project module imported by ${f.path}`,
        });
        b.addEdge(nk, "depends_on", dep, { state: "verified", source: "project_file", provenance_reference: f.path, detail: `Imports the external module ${spec}`, external: true });
      }
    }
  }

  // --- routes: declared in the app entry file; the route → page mapping is a NAME heuristic and
  //     therefore stays inferred.
  const entry = files.find((f) => f.path === "src/App.js" || f.path === "src/App.jsx" || f.path === "src/main.js");
  if (entry) {
    for (const route of uniq(matches(entry.content || "", ROUTE_RE)).filter((p) => p.length > 1 && !p.includes("//") && !/\.(js|css|json|png|svg)$/.test(p)).slice(0, GRAPH_LIMITS.per_file_refs)) {
      sources.routes++;
      const rk = b.addNode("route", route, {
        name: route, reference: { file_path: entry.path, route },
        metadata: { declared_in: entry.path },
        state: "verified", source: "project_file", provenance_reference: entry.path,
        detail: `Route literal declared in ${entry.path}`,
      });
      const segment = route.replace(/^\//, "").split("/")[0].toLowerCase();
      const page = pageByName.get(segment) || (segment === "" ? pageByName.get("home") : null);
      if (page) b.addEdge(rk, "renders", page, { state: "inferred", source: "project_file", provenance_reference: entry.path, detail: `Route path matches the page file name '${segment}'`, confidence: 0.6 });
    }

    // JSX <Route path="..." element={<Component />} /> bindings: the component is named explicitly,
    // so the route → page edge is verified when the named component resolves to a page file. A
    // dynamic/wrapper binding that does not resolve to a page stays unknown rather than invented.
    for (const block of matches(entry.content || "", JSX_ROUTE_BLOCK_RE, (m) => m[0]).slice(0, GRAPH_LIMITS.per_file_refs)) {
      const pm = block.match(JSX_PATH_RE);
      if (!pm) continue;
      const route = pm[1];
      sources.routes++;
      const em = block.match(JSX_ELEMENT_RE);
      const rk = b.addNode("route", route, {
        name: route, reference: { file_path: entry.path, route },
        metadata: { declared_in: entry.path, binding: "jsx", element_component: em ? em[1] : null },
        state: "verified", source: "project_file", provenance_reference: entry.path,
        detail: `JSX <Route path="${route}" .../> declared in ${entry.path}`,
      });
      if (!em) continue; // dynamic element — route known, target unknown (not invented)
      const page = pageByName.get(em[1].toLowerCase());
      if (page) b.addEdge(rk, "renders", page, { state: "verified", source: "project_file", provenance_reference: entry.path, detail: `JSX route "${route}" renders <${em[1]} /> from ${entry.path}` });
    }
  }

  // --- workflows: scheduled triggers are authoritative records of their own.
  for (const w of workflows) {
    sources.workflows++;
    const nk = b.addNode("workflow", w.name, {
      name: w.name, domain: domainOf(w.name) ? domainKey(domainOf(w.name)) : null,
      reference: { workflow_name: w.name, trigger_id: w.id || null, function_name: w.function_name },
      metadata: { schedule: w.cron || (w.interval_seconds ? `every ${w.interval_seconds}s` : null), enabled: w.enabled !== false, timezone: w.timezone || "UTC" },
      state: "verified", source: "workflow", provenance_reference: w.name,
      detail: "Read from the project's scheduled trigger record",
    });
    b.addEdge(nk, "triggers", nodeKey("function", w.function_name), { state: "verified", source: "workflow", provenance_reference: w.name, detail: `Scheduled trigger invokes the ${w.function_name} function` });
  }

  // --- canonical resource primitives: config, plugins, assets, agents, skills, connectors, actors,
  //     workflow resources, auth posture and analytics use. Each is derived from its own already-
  //     parsed declaration and attaches to the file/entity nodes created above, never to duplicates.
  const fileKey = (path) => {
    const f = files.find((x) => x.path === path);
    const t = f ? fileNodeType(f.path) : null;
    if (!t || t === "integration") return null;
    return nodeKey(t, t === "function" ? functionName(f.path) : f.path);
  };
  deriveResourceNodes(b, { config, app, plugins, assets, agents, skills, connectors, actors, workflow_resources, auth, analytics }, {
    sources, fileKey, domainOf: (text) => (domainOf(text) ? domainKey(domainOf(text)) : null),
  });

  // --- explicit user decisions: architecture facts a human declared. These are USER_DECISION, a
  //     third state that is neither a parsed fact nor a heuristic.
  for (const d of decisions) {
    if (!d?.node_type || !d?.key) continue;
    sources.decisions++;
    const nk = b.addNode(d.node_type, d.key, {
      name: d.name || d.key, domain: d.domain || null,
      reference: d.reference || { decided_by: "user" },
      metadata: d.metadata || {},
      state: "user_decision", source: d.source || "user_decision",
      provenance_reference: d.provenance_reference || null,
      detail: d.detail || "Declared by an explicit user decision",
    });
    for (const rel of d.edges || []) {
      if (!RELATIONSHIP_TYPES.includes(rel.relationship)) continue;
      b.addEdge(nk, rel.relationship, rel.to_node_key, { state: "user_decision", source: d.source || "user_decision", provenance_reference: d.provenance_reference || null, detail: rel.detail || "Declared by an explicit user decision" });
    }
  }

  const nodes = [...b.nodes.values()].sort((a, z) => a.node_key.localeCompare(z.node_key)).map((n) => ({ ...n, content_hash: nodeHash(n) }));
  const edges = [...b.edges.values()].sort((a, z) => a.edge_key.localeCompare(z.edge_key)).map((e) => ({ ...e, content_hash: edgeHash(e) }));

  return {
    nodes, edges,
    architecture_fingerprint: graphFingerprint(nodes, edges),
    extraction_version: EXTRACTION_VERSION,
    schema_version: ARCHITECTURE_SCHEMA_VERSION,
    source_project_version: source_project_version ?? project?.version_count ?? null,
    domains: uniq(nodes.filter((n) => n.node_type === "domain").map((n) => n.key)).sort(),
    counts: countsOf(nodes, edges),
    sources,
    truncated: { nodes: b.nodes.size >= GRAPH_LIMITS.nodes, edges: b.edges.size >= GRAPH_LIMITS.edges },
  };
}

function resolveImport(dir, spec) {
  const parts = `${dir}/${spec}`.split("/");
  const out = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export function countsOf(nodes, edges) {
  const tally = (rows, key) => rows.reduce((acc, r) => { acc[r[key]] = (acc[r[key]] || 0) + 1; return acc; }, {});
  return {
    nodes_total: nodes.length, edges_total: edges.length,
    node_types: tally(nodes, "node_type"), relationships: tally(edges, "relationship"),
    node_provenance: tally(nodes, "provenance_state"), edge_provenance: tally(edges, "provenance_state"),
    external_edges: edges.filter((e) => e.external).length,
  };
}

// --- consistency ---------------------------------------------------------------

// Which contradictions are ERRORS (the graph asserts something that cannot be true) and which are
// WARNINGS (suspicious but not necessarily broken). Nothing here repairs anything.
const ISSUE_SEVERITY = {
  missing_edge_target: "error",
  missing_edge_source: "error",
  missing_entity_reference: "error",
  function_missing_schema: "error",
  workflow_missing_function: "error",
  route_missing_target: "warning",
  integration_orphaned: "warning",
  permission_missing_role: "warning",
  unknown_relationship: "error",
  unknown_node_type: "error",
  inferred_only_dependency: "warning",
  agent_missing_skill: "error",
  connector_orphaned: "warning",
};

/**
 * Checks the graph for contradictions. Pure: it classifies findings as valid / warning / error and
 * NEVER repairs project state or rewrites the graph.
 */
export function checkConsistency({ nodes, edges, entities = [], files = [], workflows = [] } = {}) {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const entityNames = new Set(entities.map((e) => e.name));
  const filePaths = new Set(files.map((f) => f.path));
  const workflowFns = new Set(workflows.map((w) => w.function_name));
  const issues = [];
  const add = (type, message, extra = {}) => issues.push({ type, severity: ISSUE_SEVERITY[type] || "warning", message: clip(message, 300), ...extra });

  for (const e of edges) {
    if (!RELATIONSHIP_TYPES.includes(e.relationship)) add("unknown_relationship", `Relationship '${e.relationship}' is not part of the architecture contract`, { edge_key: e.edge_key });
    if (!byKey.has(e.from_node_key)) add("missing_edge_source", `Relationship ${e.edge_key} starts at a node that does not exist in this architecture`, { edge_key: e.edge_key, node_key: e.from_node_key });
    if (!byKey.has(e.to_node_key)) {
      const type = e.to_node_key.split(":")[0];
      if (type === "entity") add("missing_entity_reference", `${e.from_node_key} ${e.relationship} a missing entity (${e.to_node_key})`, { edge_key: e.edge_key, node_key: e.to_node_key });
      else if (type === "function" && e.from_node_type === "workflow") add("workflow_missing_function", `Workflow ${e.from_node_key} triggers a function that does not exist (${e.to_node_key})`, { edge_key: e.edge_key, node_key: e.to_node_key });
      else if (type === "role") add("permission_missing_role", `${e.from_node_key} references a role that is not declared (${e.to_node_key})`, { edge_key: e.edge_key, node_key: e.to_node_key });
      else if (type === "skill" && e.from_node_type === "agent") add("agent_missing_skill", `Agent ${e.from_node_key} references a skill the project does not declare (${e.to_node_key})`, { edge_key: e.edge_key, node_key: e.to_node_key });
      else add("missing_edge_target", `Relationship ${e.edge_key} points at a node that does not exist in this architecture`, { edge_key: e.edge_key, node_key: e.to_node_key });
    }
  }

  for (const n of nodes) {
    if (!NODE_TYPES.includes(n.node_type)) add("unknown_node_type", `Node type '${n.node_type}' is not part of the architecture contract`, { node_key: n.node_key });
    // A node claiming to come from a file/entity that no longer exists is a contradiction against
    // the authoritative system, which stays the source of truth.
    if (n.provenance_state === "verified" && n.reference?.file_path && filePaths.size && !filePaths.has(n.reference.file_path)) {
      add("missing_edge_source", `${n.node_key} claims file ${n.reference.file_path}, which the project no longer contains`, { node_key: n.node_key });
    }
    if (n.node_type === "entity" && entityNames.size && !entityNames.has(n.key)) {
      add("missing_entity_reference", `Entity node ${n.key} has no matching entity declaration`, { node_key: n.node_key });
    }
    if (n.node_type === "function" && (n.metadata?.entity_refs || []).some((e) => entityNames.size && !entityNames.has(e))) {
      add("function_missing_schema", `Function ${n.key} references an entity that is no longer declared`, { node_key: n.node_key });
    }
    if (n.node_type === "route") {
      const renders = edges.filter((e) => e.from_node_key === n.node_key && (e.relationship === "renders" || e.relationship === "calls"));
      if (!renders.length) add("route_missing_target", `Route ${n.key} does not resolve to a page or function`, { node_key: n.node_key });
    }
    if (n.node_type === "integration") {
      const consumers = edges.filter((e) => e.to_node_key === n.node_key && e.relationship === "consumes" && e.from_node_type !== "integration");
      if (!consumers.length) add("integration_orphaned", `Integration ${n.key} is not consumed by any page, component or function`, { node_key: n.node_key });
    }
    if (n.node_type === "connector") {
      const consumers = edges.filter((e) => e.to_node_key === n.node_key && e.relationship === "consumes" && e.from_node_type === "function");
      if (!consumers.length) add("connector_orphaned", `Connector ${n.key} is not used by any backend function`, { node_key: n.node_key });
    }
  }
  for (const fn of workflowFns) {
    if (!byKey.has(nodeKey("function", fn))) add("workflow_missing_function", `A scheduled workflow targets the function '${fn}', which the project does not contain`, { node_key: nodeKey("function", fn) });
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return {
    status: errors.length ? "error" : warnings.length ? "warning" : "valid",
    error_count: errors.length, warning_count: warnings.length,
    issues: issues.sort((a, z) => a.severity.localeCompare(z.severity) || a.type.localeCompare(z.type) || String(a.node_key || a.edge_key).localeCompare(String(z.node_key || z.edge_key))).slice(0, 200),
  };
}

// --- traversal / dependency graph ---------------------------------------------

/** Adjacency in both directions. Built once per query, never persisted as a second graph. */
export function buildAdjacency(edges) {
  const out = new Map();
  const inc = new Map();
  for (const e of edges) {
    if (!out.has(e.from_node_key)) out.set(e.from_node_key, []);
    if (!inc.has(e.to_node_key)) inc.set(e.to_node_key, []);
    out.get(e.from_node_key).push(e);
    inc.get(e.to_node_key).push(e);
  }
  return { out, inc };
}

/**
 * Bounded BFS traversal. `direction` "out" answers "what does this depend on", "in" answers "what
 * depends on this". Depth and result count are hard-capped, so a query over a large project cannot
 * walk the whole graph.
 */
export function traverse(edges, startKeys, { direction = "in", depth = 2, limit = GRAPH_LIMITS.impact, relationships = null } = {}) {
  const { out, inc } = buildAdjacency(edges);
  const maxDepth = Math.max(1, Math.min(Number(depth) || 1, GRAPH_LIMITS.traversal_depth));
  const cap = Math.max(1, Math.min(Number(limit) || GRAPH_LIMITS.impact, GRAPH_LIMITS.impact));
  const seen = new Set(startKeys);
  const results = [];
  let frontier = [...startKeys];
  let truncated = false;

  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next = [];
    for (const key of frontier) {
      const list = (direction === "out" ? out.get(key) : inc.get(key)) || [];
      for (const e of list.filter((x) => !relationships || relationships.includes(x.relationship)).sort((a, z) => a.edge_key.localeCompare(z.edge_key))) {
        const other = direction === "out" ? e.to_node_key : e.from_node_key;
        if (seen.has(other)) continue;
        if (results.length >= cap) { truncated = true; break; }
        seen.add(other);
        results.push({ node_key: other, depth: d, via: e.edge_key, relationship: e.relationship, from_node_key: e.from_node_key, to_node_key: e.to_node_key, external: !!e.external, provenance_state: e.provenance_state, confidence: e.confidence });
        next.push(other);
      }
      if (results.length >= cap) { truncated = true; break; }
    }
    frontier = next;
  }
  return { results, truncated, depth: maxDepth, direction };
}

// A dependency is high risk when many things depend on it, when it is a schema/data element, or
// when the dependency is external and therefore outside the project's control.
const HIGH_RISK_TYPES = new Set(["entity", "relationship", "storage", "integration", "connector", "external_dependency", "role", "auth", "config"]);

/**
 * Bounded impact analysis. Pure and READ-ONLY: it computes what a proposed change would touch and
 * never modifies the project, the graph or any authoritative record.
 */
export function analyzeImpact({ nodes, edges, targets = [], change_type = "modify", depth = 2, limit = GRAPH_LIMITS.impact } = {}) {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const present = targets.filter((k) => byKey.has(k));
  const unresolved = targets.filter((k) => !byKey.has(k));
  const { inc } = buildAdjacency(edges);

  const direct = (present.flatMap((k) => (inc.get(k) || []).map((e) => e.from_node_key)));
  const walked = traverse(edges, present, { direction: "in", depth, limit });
  const transitive = walked.results.filter((r) => !direct.includes(r.node_key) || r.depth > 1);
  const affectedKeys = uniq([...direct, ...walked.results.map((r) => r.node_key)]);
  const affected = affectedKeys.map((k) => byKey.get(k)).filter(Boolean);

  const dependentCount = (k) => (inc.get(k) || []).length;
  const high_risk = present
    .map((k) => ({ node: byKey.get(k), dependents: dependentCount(k) }))
    .filter(({ node, dependents }) => HIGH_RISK_TYPES.has(node.node_type) || dependents >= 3)
    .map(({ node, dependents }) => ({
      node_key: node.node_key, node_type: node.node_type, dependents,
      reason: HIGH_RISK_TYPES.has(node.node_type)
        ? `${node.node_type} changes propagate to every dependent element${change_type === "delete" ? " and this is a delete" : ""}`
        : `${dependents} elements depend on this node`,
    }));
  const externals = uniq(walked.results.filter((r) => r.external).map((r) => r.to_node_key));

  const risk_level = change_type === "delete" && high_risk.length ? "high"
    : high_risk.length && affected.length > 6 ? "high"
      : high_risk.length || affected.length > 2 ? "medium" : "low";

  return {
    change_type, targets, resolved_targets: present, unresolved_targets: unresolved,
    directly_affected: uniq(direct).sort(),
    transitively_affected: uniq(transitive.map((t) => t.node_key)).sort(),
    affected_count: affected.length, truncated: walked.truncated, depth: walked.depth,
    high_risk_dependencies: high_risk,
    external_dependencies: externals,
    likely_affected_files: uniq(affected.map((n) => n.reference?.file_path).filter(Boolean)).sort().slice(0, 60),
    likely_affected_entities: uniq(affected.filter((n) => n.node_type === "entity").map((n) => n.key)).sort(),
    likely_affected_functions: uniq(affected.filter((n) => n.node_type === "function").map((n) => n.key)).sort(),
    // Verification surfaces the existing build/runtime systems should cover after the change.
    verification_surfaces: uniq([
      "build",
      ...(affected.some((n) => ["page", "component", "route"].includes(n.node_type)) ? ["runtime_render"] : []),
      ...(affected.some((n) => n.node_type === "function") ? ["function_execution"] : []),
      ...(affected.some((n) => ["entity", "relationship", "storage"].includes(n.node_type)) ? ["schema_migration", "data_invariants"] : []),
      ...(affected.some((n) => n.node_type === "workflow") ? ["scheduled_trigger"] : []),
      ...(affected.some((n) => ["role", "auth"].includes(n.node_type)) ? ["authorization"] : []),
      ...(affected.some((n) => ["actor", "realtime_surface"].includes(n.node_type)) ? ["realtime_rooms"] : []),
      ...(affected.some((n) => ["agent", "skill", "tool"].includes(n.node_type)) ? ["agent_run"] : []),
      ...(affected.some((n) => n.node_type === "connector") ? ["connector_call"] : []),
    ]),
    risk_level,
    paths: walked.results.slice(0, 80),
  };
}

/** Diff of two architecture versions, by node/edge key and content hash. */
export function diffGraphs(from, to) {
  const map = (rows, key) => new Map(rows.map((r) => [r[key], r]));
  const fn = map(from.nodes || [], "node_key");
  const tn = map(to.nodes || [], "node_key");
  const fe = map(from.edges || [], "edge_key");
  const te = map(to.edges || [], "edge_key");
  const changed = [...tn.keys()].filter((k) => fn.has(k) && fn.get(k).content_hash !== tn.get(k).content_hash).sort();
  return {
    from_fingerprint: from.architecture_fingerprint || null, to_fingerprint: to.architecture_fingerprint || null,
    identical: (from.architecture_fingerprint || "f") === (to.architecture_fingerprint || "t"),
    nodes_added: [...tn.keys()].filter((k) => !fn.has(k)).sort(),
    nodes_removed: [...fn.keys()].filter((k) => !tn.has(k)).sort(),
    nodes_changed: changed,
    edges_added: [...te.keys()].filter((k) => !fe.has(k)).sort(),
    edges_removed: [...fe.keys()].filter((k) => !te.has(k)).sort(),
    edges_changed: [...te.keys()].filter((k) => fe.has(k) && fe.get(k).content_hash !== te.get(k).content_hash).sort(),
  };
}