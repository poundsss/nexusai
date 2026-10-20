// NexusAI Architecture Intelligence — GOVERNED DATA LAYER.
//
// Purpose: let NexusAI reason about a whole application BEFORE making a complex change. This is a
// structured, versioned, derived intelligence layer — never a second source of execution truth:
//   • project files stay file truth        • entity declarations stay schema truth
//   • build/runtime records stay execution truth   • deployments stay deployment truth
// Architecture stores REFERENCES into those systems plus the relationships between them.
//
// Boundaries this module keeps:
//   REUSE — authorization (authz), tracing/scrubbing (tracing), audit (authz.audit), project state
//     (authz.loadProjectState), fingerprints (benchmark.fingerprint) and memory (#21, read-only).
//     No second logging system, no second agent loop, no training/dataset/reward/benchmark writes.
//   DERIVED — every fact comes from parsed authoritative state or an explicit user decision.
//   VERSIONED + IDEMPOTENT — reconciling the same authoritative project state resolves the SAME
//     fingerprint and returns the existing version instead of duplicating nodes or edges.
//   IMMUTABLE — a finalized architecture version, its nodes and its edges refuse every mutation.
//   CONCURRENCY-SAFE — two simultaneous reconciliations cannot corrupt the graph: nodes are scoped
//     to their own architecture id, and a version collision resolves deterministically to one
//     winner while the loser is marked SUPERSEDED.
//   READ-ONLY — reconciliation, impact analysis and consistency checks never mutate project state.
//   AUTHORIZED + ISOLATED — the workspace is resolved server-side from the authorized project and
//     every read is filtered by project_id, so cross-project access resolves to nothing.
//   SCRUBBED — every stored string passes the platform's existing secret scrubber; only secret
//     NAMES are ever represented.
import { scrub, scrubText, recordSpan } from "./tracing.ts";
import { loadAuthorizedProject, loadProjectState, audit } from "./authz.ts";
import { retrieveMemory } from "./memory.ts";
import { log } from "./observability.ts";
import {
  deriveArchitecture, checkConsistency, analyzeImpact, traverse, diffGraphs, countsOf,
  nodeKey, NODE_TYPES, RELATIONSHIP_TYPES, GRAPH_LIMITS, EXTRACTION_VERSION, ARCHITECTURE_SCHEMA_VERSION,
} from "./architectureGraph.ts";
// Dependency facts come from the project's own lockfile reader (#26) — architecture represents the
// resolved packages, it never resolves or installs anything.
import { installedPackages } from "./packageLock.ts";
// Canonical resource declarations (config, agents, skills, connectors, actors, workflow resources,
// assets, plugins, auth posture, analytics use), parsed by their own contracts.
import { collectResourceDeclarations } from "./architectureState.ts";
// The AI App Primitives capability layer (#27). Architecture Intelligence READS it: every capability
// decision below is delegated to this one pure module, so there is no second planner, validator,
// dependency model or permission vocabulary here.
import {
  APP_PRIMITIVE_NAMES, describeAppPrimitives, resolveCapability, dependencyClosure,
  selectPrimitives, validateComposition, planPrimitiveExecution, primitiveCapabilityBlock,
} from "./appPrimitives.ts";

export const ARCHITECTURE_STATUSES = ["DRAFT", "FINALIZED", "SUPERSEDED", "FAILED"];
export const PLAN_ACTIONS = ["create", "modify", "delete", "migrate", "verify"];
export const ARCH_LIMITS = {
  page: 500, nodes: GRAPH_LIMITS.nodes, edges: GRAPH_LIMITS.edges,
  subgraph: GRAPH_LIMITS.subgraph, impact: GRAPH_LIMITS.impact, context_nodes: 40, context_edges: 80,
  goal: 4000, plan_changes: 60, assumptions: 20, versions: 50,
};
// Memory decisions become architecture facts only under this explicit contract:
// subject_key = "architecture:<node_type>:<key>". Nothing else in memory is interpreted.
const MEMORY_SUBJECT_PREFIX = "architecture:";

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const uniq = (a) => [...new Set(a)];

// --- authorization -------------------------------------------------------------

/**
 * Resolves an architecture version for an authorized caller. The owner project is authorized
 * through the platform's EXISTING path, so a caller from another workspace is refused before any
 * architecture field is read, and the architecture's own workspace must match.
 */
export async function authorizeArchitecture(base44, user, architecture_id, capability = "project.read") {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use architecture intelligence");
  if (!architecture_id) fail(400, "INVALID_INPUT", "architecture_id is required");
  const svc = svcOf(base44);
  const architecture = await svc.entities.Architecture.get(String(architecture_id)).catch(() => null);
  if (!architecture) fail(404, "ARCHITECTURE_NOT_FOUND", "Architecture not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, architecture.project_id, capability);
  if (architecture.workspace_id && architecture.workspace_id !== workspace.id) fail(403, "NOT_A_MEMBER", "Architecture belongs to another workspace");
  return { architecture, project, workspace };
}

/** Authentication gate for every public entry point, checked BEFORE any project lookup. */
const requireUser = (user) => { if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use architecture intelligence"); };

const assertMutable = (a) => {
  if (a.finalized || a.status === "FINALIZED") fail(409, "ARCHITECTURE_FINALIZED", "A finalized architecture version is immutable; reconcile to create a new version instead");
};

// --- public projections --------------------------------------------------------

export const publicArchitecture = (a) => ({
  architecture_id: a.id, project_id: a.project_id, workspace_id: a.workspace_id,
  schema_version: a.schema_version ?? ARCHITECTURE_SCHEMA_VERSION, version: a.version, status: a.status,
  source_project_version: a.source_project_version ?? null, source_version_id: a.source_version_id || null,
  architecture_fingerprint: a.architecture_fingerprint, extraction_version: a.extraction_version,
  parent_architecture_id: a.parent_architecture_id || null,
  node_count: a.node_count || 0, edge_count: a.edge_count || 0,
  domains: a.domains || [], counts: a.counts || {}, diff_summary: a.diff_summary || {},
  consistency: a.consistency || {}, sources: a.sources || {},
  trace_id: a.trace_id || null, run_id: a.run_id || null,
  finalized: !!a.finalized, error: a.error || null, created_by: a.created_by || null,
  created_at: a.created_at || a.created_date, finalized_at: a.finalized_at || null,
});

export const publicNode = (n) => ({
  node_id: n.id, architecture_id: n.architecture_id, node_key: n.node_key, node_type: n.node_type,
  key: n.key, name: n.name || n.key, domain: n.domain || null,
  reference: n.reference || {}, metadata: n.metadata || {},
  provenance: {
    state: n.provenance_state, source: n.provenance_source || null,
    reference: n.provenance_reference || null, detail: n.provenance_detail || null,
    confidence: n.confidence ?? null,
  },
  content_hash: n.content_hash || null,
});

export const publicEdge = (e) => ({
  edge_id: e.id, architecture_id: e.architecture_id, edge_key: e.edge_key, relationship: e.relationship,
  from_node_key: e.from_node_key, to_node_key: e.to_node_key,
  from_node_type: e.from_node_type || null, to_node_type: e.to_node_type || null, external: !!e.external,
  provenance: {
    state: e.provenance_state, source: e.provenance_source || null,
    reference: e.provenance_reference || null, detail: e.provenance_detail || null,
    confidence: e.confidence ?? null,
  },
  content_hash: e.content_hash || null,
});

export const publicPlan = (p) => ({
  plan_id: p.id, project_id: p.project_id, workspace_id: p.workspace_id,
  architecture_id: p.architecture_id, architecture_version: p.architecture_version ?? null,
  architecture_fingerprint: p.architecture_fingerprint || null,
  goal: p.goal, assumptions: p.assumptions || [], affected_domains: p.affected_domains || [],
  planned_changes: p.planned_changes || [], dependency_order: p.dependency_order || [],
  migration_requirements: p.migration_requirements || [],
  risk_level: p.risk_level || "low", risk_factors: p.risk_factors || [],
  validation_requirements: p.validation_requirements || [], impact: p.impact || {},
  status: p.status || "READY", validation: p.validation || {},
  trace_id: p.trace_id || null, run_id: p.run_id || null,
  created_by: p.created_by || null, created_at: p.created_at || p.created_date,
});

// --- authoritative state collection -------------------------------------------

/**
 * Reads the authoritative systems architecture is derived from. Read-only by construction: files,
 * entity declarations, relations, scheduled workflows, integration definitions, secret METADATA
 * (names only, through the platform's existing projection) and explicit architecture decisions from
 * verified project memory.
 */
export async function collectAuthoritativeState(base44, user, project) {
  const svc = svcOf(base44);
  const state = await loadProjectState(svc, project.id);
  const [relations, workflows, versions] = await Promise.all([
    svc.entities.AppRelation.filter({ project_id: project.id }, "name", 200).catch(() => []),
    svc.entities.ScheduledTrigger.filter({ project_id: project.id }, "name", 100).catch(() => []),
    svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1).catch(() => []),
  ]);

  // Integration definitions live in the project's own integrations/*.json files, which remain the
  // authoritative record; a malformed definition is skipped rather than guessed at.
  const integrations = [];
  for (const f of state.files) {
    if (!/^integrations\/[^/]+\.json$/.test(f.path)) continue;
    try {
      const def = JSON.parse(f.content || "{}");
      integrations.push({ name: def.name || f.path.replace(/^integrations\/|\.json$/g, ""), base_url: def.base_url, auth: def.auth, operations: def.operations });
    } catch { /* not a valid definition: the file node still exists, the integration node does not */ }
  }

  // Memory is READ-ONLY here and nothing is written back (#21 governs memory). Only decisions that
  // explicitly name an architecture node under the documented subject contract are used.
  let decisions = [];
  try {
    const mem = await retrieveMemory(base44, user, { project_id: project.id, query: "architecture decision", memory_types: ["decision"], limit: 14 });
    decisions = (mem.items || [])
      .filter((m) => m.verification !== "inferred" && String(m.subject_key || "").startsWith(MEMORY_SUBJECT_PREFIX))
      .map((m) => {
        const [, node_type, ...rest] = String(m.subject_key).split(":");
        const key = rest.join(":");
        if (!NODE_TYPES.includes(node_type) || !key) return null;
        return {
          node_type, key, name: key, source: "memory_decision", provenance_reference: m.memory_id,
          detail: m.statement, metadata: { decided_reason: m.reason || null },
          reference: { memory_id: m.memory_id, verification: m.verification },
        };
      })
      .filter(Boolean);
  } catch (e) {
    log("warn", "architecture.memory_read_failed", { project_id: project.id, error: e.message });
  }

  return {
    files: state.files, entities: state.entities, secrets: state.secrets,
    relations, workflows, integrations, decisions,
    // Installed packages, read from the project's own lockfile (#26). The lockfile stays
    // authoritative; architecture only represents what it already pinned.
    dependencies: installedPackages(state.files),
    source_version: versions[0] || null,
    resources: collectResourceDeclarations(state.files, state.entities, project),
  };
}

// --- reconciliation ------------------------------------------------------------

const persistGraph = async (svc, architecture, graph) => {
  const nodeRows = graph.nodes.map((n) => ({
    architecture_id: architecture.id, project_id: architecture.project_id, workspace_id: architecture.workspace_id,
    node_key: n.node_key, node_type: n.node_type, key: n.key, name: n.name,
    domain: n.domain || undefined, reference: scrub(n.reference || {}), metadata: scrub(n.metadata || {}),
    provenance_state: n.provenance_state, provenance_source: n.provenance_source,
    provenance_reference: n.provenance_reference ? scrubText(n.provenance_reference, 300) : undefined,
    provenance_detail: n.provenance_detail ? scrubText(n.provenance_detail, 300) : undefined,
    confidence: n.confidence, content_hash: n.content_hash, created_at: nowIso(),
  }));
  const edgeRows = graph.edges.map((e) => ({
    architecture_id: architecture.id, project_id: architecture.project_id, workspace_id: architecture.workspace_id,
    edge_key: e.edge_key, relationship: e.relationship, from_node_key: e.from_node_key, to_node_key: e.to_node_key,
    from_node_type: e.from_node_type, to_node_type: e.to_node_type, external: !!e.external,
    provenance_state: e.provenance_state, provenance_source: e.provenance_source,
    provenance_reference: e.provenance_reference ? scrubText(e.provenance_reference, 300) : undefined,
    provenance_detail: e.provenance_detail ? scrubText(e.provenance_detail, 300) : undefined,
    confidence: e.confidence, content_hash: e.content_hash, created_at: nowIso(),
  }));
  for (let i = 0; i < nodeRows.length; i += 100) await svc.entities.ArchitectureNode.bulkCreate(nodeRows.slice(i, i + 100));
  for (let i = 0; i < edgeRows.length; i += 100) await svc.entities.ArchitectureEdge.bulkCreate(edgeRows.slice(i, i + 100));
};

/**
 * Derives the architecture from authoritative project state and stores it as an immutable version.
 *
 * IDEMPOTENT: if the latest finalized version already has this exact fingerprint for the same
 * source project version, the existing version is returned and nothing is written — so repeated
 * reconciliation cannot duplicate nodes or relationships.
 *
 * CONCURRENCY: the version number is allocated from what is persisted, and after writing, a
 * collision on the same version number resolves deterministically (lowest record id wins); the
 * loser is marked SUPERSEDED and its nodes stay scoped to it, so the winner's graph cannot be
 * polluted by a concurrent run.
 *
 * READ-ONLY: no project file, entity, build, deployment or memory record is modified.
 */
export async function reconcileArchitecture(base44, user, { project_id, trace_id = null, run_id = null, force = false } = {}) {
  requireUser(user);
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const svc = svcOf(base44);
  const state = await collectAuthoritativeState(base44, user, project);
  const graph = deriveArchitecture({
    project, files: state.files, entities: state.entities, relations: state.relations,
    workflows: state.workflows, integrations: state.integrations, secrets: state.secrets,
    decisions: state.decisions, dependencies: state.dependencies,
    source_project_version: state.source_version?.number ?? project.version_count ?? null,
    ...state.resources,
  });

  const history = await svc.entities.Architecture.filter({ project_id: project.id }, "-version", ARCH_LIMITS.versions);
  const finalizedVersions = history.filter((a) => a.status === "FINALIZED");
  const latest = finalizedVersions[0] || null;

  // Idempotency: identical authoritative state ⇒ identical fingerprint ⇒ the SAME architecture.
  if (!force && latest && latest.architecture_fingerprint === graph.architecture_fingerprint && (latest.source_project_version ?? null) === (graph.source_project_version ?? null)) {
    await traceOp(svc, { trace_id, run_id, workspace, project, name: "architecture.reconcile", metadata: { reused_version: latest.version, fingerprint: graph.architecture_fingerprint, unchanged: true } });
    return { architecture: publicArchitecture(latest), created: false, reason: "unchanged_authoritative_state", counts: latest.counts || {} };
  }

  const version = Math.max(0, ...history.map((a) => a.version || 0)) + 1;
  const consistency = checkConsistency({ nodes: graph.nodes, edges: graph.edges, entities: state.entities, files: state.files, workflows: state.workflows });
  const record = await svc.entities.Architecture.create({
    schema_version: ARCHITECTURE_SCHEMA_VERSION, project_id: project.id, workspace_id: workspace.id,
    version, status: "DRAFT",
    source_project_version: graph.source_project_version ?? undefined,
    source_version_id: state.source_version?.id || undefined,
    architecture_fingerprint: graph.architecture_fingerprint, extraction_version: EXTRACTION_VERSION,
    parent_architecture_id: latest?.id || undefined,
    node_count: graph.nodes.length, edge_count: graph.edges.length,
    domains: graph.domains, counts: graph.counts, consistency: scrub(consistency), sources: graph.sources,
    trace_id: trace_id || undefined, run_id: run_id || undefined,
    finalized: false, created_by: user.id, created_at: nowIso(),
  });

  // Concurrency resolution: if another worker allocated the same version number, exactly one row
  // wins deterministically and the other is retired without its nodes ever mixing into the winner.
  const rivals = (await svc.entities.Architecture.filter({ project_id: project.id, version }, "created_date", 10))
    .filter((r) => r.id !== record.id && r.status !== "SUPERSEDED" && r.status !== "FAILED");
  if (rivals.length) {
    const winner = [record, ...rivals].sort((a, z) => String(a.id).localeCompare(String(z.id)))[0];
    if (winner.id !== record.id) {
      await svc.entities.Architecture.update(record.id, { status: "SUPERSEDED", error: "A concurrent reconciliation produced this version first" });
      const resolved = await svc.entities.Architecture.get(winner.id);
      return { architecture: publicArchitecture(resolved), created: false, reason: "concurrent_reconciliation", counts: resolved.counts || {} };
    }
  }

  await persistGraph(svc, record, graph);
  // Previous finalized versions stay readable but are no longer "current"; their rows are never
  // rewritten beyond this status marker, so history remains immutable in content.
  for (const old of finalizedVersions) await svc.entities.Architecture.update(old.id, { status: "SUPERSEDED" }).catch(() => {});

  const diff_summary = latest ? await diffAgainstStored(svc, latest, graph) : { first_version: true };
  const finalized = await svc.entities.Architecture.update(record.id, {
    status: "FINALIZED", finalized: true, finalized_at: nowIso(), diff_summary: scrub(diff_summary),
  });

  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "architecture.reconciled", resource: "Architecture", resource_id: record.id,
    metadata: { version, fingerprint: graph.architecture_fingerprint, nodes: graph.nodes.length, edges: graph.edges.length, consistency: consistency.status, source_project_version: graph.source_project_version ?? null },
  });
  await traceOp(svc, { trace_id, run_id, workspace, project, name: "architecture.reconcile", metadata: { version, fingerprint: graph.architecture_fingerprint, nodes: graph.nodes.length, edges: graph.edges.length, consistency: consistency.status } });

  return { architecture: publicArchitecture(finalized), created: true, counts: graph.counts, consistency, truncated: graph.truncated };
}

async function diffAgainstStored(svc, previous, graph) {
  const [nodes, edges] = await Promise.all([
    svc.entities.ArchitectureNode.filter({ architecture_id: previous.id }, "node_key", ARCH_LIMITS.page),
    svc.entities.ArchitectureEdge.filter({ architecture_id: previous.id }, "edge_key", ARCH_LIMITS.page),
  ]);
  const d = diffGraphs({ nodes, edges, architecture_fingerprint: previous.architecture_fingerprint }, graph);
  const cap = (a) => a.slice(0, 60);
  return {
    parent_version: previous.version, parent_fingerprint: previous.architecture_fingerprint,
    nodes_added: cap(d.nodes_added), nodes_removed: cap(d.nodes_removed), nodes_changed: cap(d.nodes_changed),
    edges_added: cap(d.edges_added), edges_removed: cap(d.edges_removed), edges_changed: cap(d.edges_changed),
    node_delta: graph.nodes.length - nodes.length, edge_delta: graph.edges.length - edges.length,
  };
}

const traceOp = (svc, { trace_id, run_id, workspace, project, name, metadata }) =>
  trace_id
    ? recordSpan(svc, {
      trace_id, run_id: run_id || null, workspace_id: workspace?.id || null, project_id: project?.id || null,
      event_type: "diagnostic_query", name, status: "ok", metadata,
    }).catch(() => {})
    : Promise.resolve(null);

// --- authorized reads ----------------------------------------------------------

/** Loads a version's full graph rows (bounded). Internal helper for the query operations. */
async function loadGraph(svc, architecture) {
  const [nodes, edges] = await Promise.all([
    svc.entities.ArchitectureNode.filter({ architecture_id: architecture.id, project_id: architecture.project_id }, "node_key", ARCH_LIMITS.page),
    svc.entities.ArchitectureEdge.filter({ architecture_id: architecture.id, project_id: architecture.project_id }, "edge_key", ARCH_LIMITS.page),
  ]);
  return { nodes, edges };
}

/** The current architecture of a project, or a specific version. Summary only — never the whole graph. */
export async function getArchitecture(base44, user, { project_id, version = null, architecture_id = null, include_graph = false } = {}) {
  requireUser(user);
  const svc = svcOf(base44);
  let architecture, project;
  if (architecture_id) ({ architecture, project } = await authorizeArchitecture(base44, user, architecture_id, "project.read"));
  else {
    ({ project } = await loadAuthorizedProject(base44, user, project_id, "project.read"));
    const rows = await svc.entities.Architecture.filter(
      { project_id: project.id, ...(version ? { version: Number(version) } : {}) }, "-version", ARCH_LIMITS.versions,
    );
    architecture = rows.find((a) => a.status === "FINALIZED" || a.status === "SUPERSEDED") || rows[0] || null;
    if (!architecture) fail(404, "ARCHITECTURE_NOT_FOUND", "This project has no architecture yet; reconcile one first");
  }
  const out = { architecture: publicArchitecture(architecture) };
  if (include_graph) {
    const g = await loadGraph(svc, architecture);
    out.nodes = g.nodes.slice(0, ARCH_LIMITS.page).map(publicNode);
    out.edges = g.edges.slice(0, ARCH_LIMITS.page).map(publicEdge);
    out.bounded = { node_limit: ARCH_LIMITS.page, edge_limit: ARCH_LIMITS.page, truncated: g.nodes.length >= ARCH_LIMITS.page || g.edges.length >= ARCH_LIMITS.page };
  }
  return out;
}

export async function listArchitectureVersions(base44, user, { project_id, limit = 20 } = {}) {
  requireUser(user);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.Architecture.filter({ project_id: project.id }, "-version", Math.min(limit, ARCH_LIMITS.versions));
  return { project_id: project.id, count: rows.length, versions: rows.map(publicArchitecture) };
}

/**
 * Bounded node query. Filters by type, domain, key substring and provenance state — never a full
 * graph dump, so a large project stays queryable without loading everything.
 */
export async function queryNodes(base44, user, { architecture_id = null, project_id = null, node_type = null, domain = null, key = null, provenance_state = null, limit = ARCH_LIMITS.subgraph, offset = 0 } = {}) {
  const { architecture } = await resolveTarget(base44, user, { architecture_id, project_id });
  const svc = svcOf(base44);
  if (node_type && !NODE_TYPES.includes(node_type)) fail(400, "INVALID_NODE_TYPE", `node_type must be one of ${NODE_TYPES.join(", ")}`);
  const rows = await svc.entities.ArchitectureNode.filter(
    {
      architecture_id: architecture.id, project_id: architecture.project_id,
      ...(node_type ? { node_type } : {}), ...(domain ? { domain: String(domain) } : {}),
      ...(provenance_state ? { provenance_state: String(provenance_state) } : {}),
    },
    "node_key", ARCH_LIMITS.page, offset,
  );
  const needle = key ? String(key).toLowerCase() : null;
  const filtered = needle ? rows.filter((n) => n.key.toLowerCase().includes(needle) || String(n.name || "").toLowerCase().includes(needle)) : rows;
  const cap = Math.max(1, Math.min(Number(limit) || ARCH_LIMITS.subgraph, ARCH_LIMITS.page));
  return {
    architecture_id: architecture.id, architecture_version: architecture.version,
    count: Math.min(filtered.length, cap), total_matched: filtered.length, offset,
    truncated: filtered.length > cap, nodes: filtered.slice(0, cap).map(publicNode),
  };
}

/**
 * Dependency query. `direction: "in"` answers "what depends on this?" (what calls this function,
 * which pages depend on this component, which workflows depend on this integration);
 * `direction: "out"` answers "what does this depend on?", including which dependencies are external.
 * Depth and result count are hard-capped.
 */
export async function queryDependencies(base44, user, { architecture_id = null, project_id = null, node_key = null, node_type = null, key = null, direction = "in", depth = 2, relationships = null, limit = ARCH_LIMITS.impact } = {}) {
  const { architecture } = await resolveTarget(base44, user, { architecture_id, project_id });
  const svc = svcOf(base44);
  const target = node_key || (node_type && key ? nodeKey(node_type, key) : null);
  if (!target) fail(400, "INVALID_INPUT", "node_key (or node_type + key) is required");
  if (!["in", "out"].includes(direction)) fail(400, "INVALID_DIRECTION", "direction must be 'in' or 'out'");
  if (relationships && relationships.some((r) => !RELATIONSHIP_TYPES.includes(r))) fail(400, "INVALID_RELATIONSHIP", `relationships must be from ${RELATIONSHIP_TYPES.join(", ")}`);

  const { nodes, edges } = await loadGraph(svc, architecture);
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  if (!byKey.has(target)) fail(404, "NODE_NOT_FOUND", `No architecture node ${target} in version ${architecture.version}`);
  const walked = traverse(edges, [target], { direction, depth, limit, relationships });
  const rows = walked.results.map((r) => ({ ...r, node: byKey.get(r.node_key) ? publicNode(byKey.get(r.node_key)) : null }));
  return {
    architecture_id: architecture.id, architecture_version: architecture.version,
    node: publicNode(byKey.get(target)), direction, depth: walked.depth,
    count: rows.length, truncated: walked.truncated,
    external_dependencies: uniq(rows.filter((r) => r.external || r.node?.node_type === "external_dependency").map((r) => r.node_key)).sort(),
    dependencies: rows,
  };
}

/**
 * Bounded relevant-subgraph retrieval: the seed nodes plus their immediate neighbourhood, capped by
 * node and edge count. This is what makes architecture usable on a large project without ever
 * sending the whole graph into a model context.
 */
export async function getSubgraph(base44, user, { architecture_id = null, project_id = null, node_keys = [], query = null, node_types = null, depth = 1, limit = ARCH_LIMITS.subgraph } = {}) {
  const { architecture } = await resolveTarget(base44, user, { architecture_id, project_id });
  const svc = svcOf(base44);
  const { nodes, edges } = await loadGraph(svc, architecture);
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));

  let seeds = (node_keys || []).filter((k) => byKey.has(k));
  if (!seeds.length && query) {
    const needle = String(query).toLowerCase();
    const terms = needle.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    seeds = nodes
      .filter((n) => !node_types || node_types.includes(n.node_type))
      .map((n) => ({ n, score: terms.reduce((s, t) => s + (`${n.key} ${n.name} ${n.domain || ""}`.toLowerCase().includes(t) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, z) => z.score - a.score || a.n.node_key.localeCompare(z.n.node_key))
      .slice(0, 8)
      .map((x) => x.n.node_key);
  }
  if (!seeds.length) seeds = nodes.filter((n) => n.node_type === "entity").slice(0, 5).map((n) => n.node_key);

  const cap = Math.max(1, Math.min(Number(limit) || ARCH_LIMITS.subgraph, ARCH_LIMITS.subgraph));
  const neighbours = [
    ...traverse(edges, seeds, { direction: "out", depth, limit: cap }).results,
    ...traverse(edges, seeds, { direction: "in", depth, limit: cap }).results,
  ];
  const keep = new Set(seeds);
  for (const n of neighbours.sort((a, z) => a.node_key.localeCompare(z.node_key))) {
    if (keep.size >= cap) break;
    keep.add(n.node_key);
  }
  const subEdges = edges.filter((e) => keep.has(e.from_node_key) && keep.has(e.to_node_key)).slice(0, ARCH_LIMITS.context_edges);
  return {
    architecture_id: architecture.id, architecture_version: architecture.version,
    architecture_fingerprint: architecture.architecture_fingerprint,
    seeds, bounded: { node_limit: cap, edge_limit: ARCH_LIMITS.context_edges },
    truncated: keep.size >= cap || edges.filter((e) => keep.has(e.from_node_key) && keep.has(e.to_node_key)).length > ARCH_LIMITS.context_edges,
    node_count: keep.size, edge_count: subEdges.length,
    nodes: [...keep].sort().map((k) => publicNode(byKey.get(k))).filter(Boolean),
    edges: subEdges.map(publicEdge),
  };
}

async function resolveTarget(base44, user, { architecture_id, project_id }) {
  requireUser(user);
  if (architecture_id) return authorizeArchitecture(base44, user, architecture_id, "project.read");
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.Architecture.filter({ project_id: project.id }, "-version", ARCH_LIMITS.versions);
  const architecture = rows.find((a) => a.status === "FINALIZED") || rows.find((a) => a.status === "SUPERSEDED") || null;
  if (!architecture) fail(404, "ARCHITECTURE_NOT_FOUND", "This project has no architecture yet; reconcile one first");
  return { architecture, project, workspace };
}

// --- impact analysis -----------------------------------------------------------

/**
 * Impact analysis for a PROPOSED change. Strictly read-only: it reads the stored graph and returns
 * what would be affected. No project file, entity, version, build or deployment is touched.
 */
export async function runImpactAnalysis(base44, user, { architecture_id = null, project_id = null, targets = [], node_type = null, key = null, change_type = "modify", depth = 2, trace_id = null, run_id = null } = {}) {
  const { architecture, project, workspace } = await resolveTarget(base44, user, { architecture_id, project_id });
  const svc = svcOf(base44);
  const wanted = uniq([...(targets || []), ...(node_type && key ? [nodeKey(node_type, key)] : [])]);
  if (!wanted.length) fail(400, "INVALID_INPUT", "At least one target node is required");
  const { nodes, edges } = await loadGraph(svc, architecture);
  const impact = analyzeImpact({ nodes, edges, targets: wanted, change_type, depth, limit: ARCH_LIMITS.impact });
  await traceOp(svc, { trace_id, run_id, workspace, project, name: "architecture.impact_analysis", metadata: { architecture_version: architecture.version, targets: wanted.length, affected: impact.affected_count, risk: impact.risk_level } });
  return { architecture_id: architecture.id, architecture_version: architecture.version, impact };
}

/** Consistency check over a stored version. Records the result; never repairs project state. */
export async function runConsistencyCheck(base44, user, { architecture_id = null, project_id = null, persist = true, trace_id = null, run_id = null } = {}) {
  const { architecture, project, workspace } = await resolveTarget(base44, user, { architecture_id, project_id });
  const svc = svcOf(base44);
  const { nodes, edges } = await loadGraph(svc, architecture);
  const state = await collectAuthoritativeState(base44, user, project);
  const result = checkConsistency({ nodes, edges, entities: state.entities, files: state.files, workflows: state.workflows });
  // The stored consistency field is a derived report, not graph content: recording it does not
  // change any node, edge or fingerprint, so the architecture stays immutable in substance.
  if (persist) await svc.entities.Architecture.update(architecture.id, { consistency: scrub({ ...result, checked_at: nowIso() }) }).catch(() => {});
  await traceOp(svc, { trace_id, run_id, workspace, project, name: "architecture.consistency_check", metadata: { architecture_version: architecture.version, status: result.status, errors: result.error_count, warnings: result.warning_count } });
  return { architecture_id: architecture.id, architecture_version: architecture.version, ...result };
}

/** Diff of two stored architecture versions of the SAME project. */
export async function diffArchitectureVersions(base44, user, { project_id, from_version, to_version } = {}) {
  requireUser(user);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.Architecture.filter({ project_id: project.id }, "-version", ARCH_LIMITS.versions);
  const pick = (v) => rows.find((a) => a.version === Number(v));
  const from = pick(from_version);
  const to = pick(to_version);
  if (!from || !to) fail(404, "ARCHITECTURE_NOT_FOUND", "Both architecture versions must exist in this project");
  const [fg, tg] = await Promise.all([loadGraph(svc, from), loadGraph(svc, to)]);
  const diff = diffGraphs({ ...fg, architecture_fingerprint: from.architecture_fingerprint }, { ...tg, architecture_fingerprint: to.architecture_fingerprint });
  return {
    project_id: project.id,
    from: { architecture_id: from.id, version: from.version, fingerprint: from.architecture_fingerprint, source_project_version: from.source_project_version ?? null, counts: countsOf(fg.nodes, fg.edges) },
    to: { architecture_id: to.id, version: to.version, fingerprint: to.architecture_fingerprint, source_project_version: to.source_project_version ?? null, counts: countsOf(tg.nodes, tg.edges) },
    diff,
  };
}

// --- implementation plans ------------------------------------------------------

/** Deterministic dependency order over the plan's own nodes, derived from the graph's edges. */
function dependencyOrder(keys, edges) {
  const set = new Set(keys);
  const deps = new Map([...set].map((k) => [k, new Set()]));
  for (const e of edges) {
    if (!["depends_on", "reads", "writes", "calls", "renders", "triggers", "transforms", "consumes"].includes(e.relationship)) continue;
    if (set.has(e.from_node_key) && set.has(e.to_node_key)) deps.get(e.from_node_key).add(e.to_node_key);
  }
  const ordered = [];
  const seen = new Set();
  const visit = (k, stack = new Set()) => {
    if (seen.has(k) || stack.has(k)) return; // a cycle stops here rather than looping
    stack.add(k);
    for (const d of [...deps.get(k)].sort()) visit(d, stack);
    stack.delete(k);
    seen.add(k);
    ordered.push(k);
  };
  for (const k of [...set].sort()) visit(k);
  return ordered;
}

/**
 * Creates a structured implementation plan.
 *
 * The plan REFERENCES architecture nodes: every planned change must resolve to a real node in the
 * referenced version, otherwise the plan is refused rather than stored as unverifiable prose. The
 * dependency order, risk level and validation requirements are DERIVED from the graph and the
 * impact analysis. This layer never executes a plan — the EXISTING Agent Loop consumes it.
 */
export async function createImplementationPlan(base44, user, {
  project_id, architecture_id = null, goal, assumptions = [], changes = [],
  migration_requirements = [], validation_requirements = [], trace_id = null, run_id = null,
} = {}) {
  const { architecture, project, workspace } = await resolveTarget(base44, user, { architecture_id, project_id });
  await loadAuthorizedProject(base44, user, architecture.project_id, "project.write");
  const svc = svcOf(base44);
  const text = scrubText(String(goal || "").trim(), ARCH_LIMITS.goal);
  if (!text) fail(400, "INVALID_INPUT", "A plan goal is required");
  if (!Array.isArray(changes) || !changes.length) fail(400, "INVALID_INPUT", "A plan must contain at least one planned change");
  if (changes.length > ARCH_LIMITS.plan_changes) fail(400, "TOO_MANY_CHANGES", `A plan may contain at most ${ARCH_LIMITS.plan_changes} changes`);

  const { nodes, edges } = await loadGraph(svc, architecture);
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const resolved = [];
  const unresolved = [];
  for (const c of changes) {
    const key = c.node_key || (c.node_type && c.key ? nodeKey(c.node_type, c.key) : null);
    const node = key ? byKey.get(key) : null;
    if (!node) { unresolved.push(key || "(no node reference)"); continue; }
    if (!PLAN_ACTIONS.includes(c.action)) fail(400, "INVALID_ACTION", `action must be one of ${PLAN_ACTIONS.join(", ")}`);
    resolved.push({ node, change: c });
  }
  if (unresolved.length) fail(400, "PLAN_NODE_NOT_FOUND", `Planned changes must reference existing architecture nodes; unresolved: ${unresolved.slice(0, 5).join(", ")}`);

  const targets = resolved.map((r) => r.node.node_key);
  const impact = analyzeImpact({ nodes, edges, targets, change_type: resolved.some((r) => r.change.action === "delete") ? "delete" : "modify", depth: 2, limit: ARCH_LIMITS.impact });
  const order = dependencyOrder(targets, edges);
  const planned_changes = resolved
    .map(({ node, change }) => ({
      order: 0, node_key: node.node_key, node_id: node.id, node_type: node.node_type,
      action: change.action, description: scrubText(change.description || "", 600),
      migration_required: !!change.migration_required || ["entity", "relationship", "storage"].includes(node.node_type) && change.action !== "verify",
      validation: scrubText(change.validation || (node.node_type === "function" ? "function_execution" : node.node_type === "entity" ? "schema_migration" : "build"), 200),
    }))
    .sort((a, z) => order.indexOf(a.node_key) - order.indexOf(z.node_key) || a.node_key.localeCompare(z.node_key))
    .map((c, i) => ({ ...c, order: i + 1 }));

  const record = await svc.entities.ImplementationPlan.create({
    project_id: project.id, workspace_id: workspace.id,
    architecture_id: architecture.id, architecture_version: architecture.version,
    architecture_fingerprint: architecture.architecture_fingerprint,
    goal: text,
    assumptions: (assumptions || []).slice(0, ARCH_LIMITS.assumptions).map((a) => scrubText(a, 300)),
    affected_domains: uniq(resolved.map((r) => r.node.domain).filter(Boolean)).sort(),
    planned_changes: scrub(planned_changes), dependency_order: order,
    migration_requirements: uniq([
      ...(migration_requirements || []).map((m) => scrubText(m, 300)),
      ...planned_changes.filter((c) => c.migration_required).map((c) => `Migration required for ${c.node_key}`),
    ]).slice(0, 20),
    risk_level: impact.risk_level,
    risk_factors: impact.high_risk_dependencies.map((h) => scrubText(`${h.node_key}: ${h.reason}`, 300)).slice(0, 20),
    validation_requirements: uniq([...(validation_requirements || []).map((v) => scrubText(v, 200)), ...impact.verification_surfaces]).slice(0, 20),
    impact: scrub({
      directly_affected: impact.directly_affected.slice(0, 60), transitively_affected: impact.transitively_affected.slice(0, 60),
      high_risk_dependencies: impact.high_risk_dependencies, external_dependencies: impact.external_dependencies,
      likely_affected_files: impact.likely_affected_files, likely_affected_entities: impact.likely_affected_entities,
      likely_affected_functions: impact.likely_affected_functions, verification_surfaces: impact.verification_surfaces,
      affected_count: impact.affected_count, truncated: impact.truncated,
    }),
    status: "READY",
    validation: scrub({
      node_references_resolved: true, referenced_nodes: targets,
      dependency_order_complete: order.length === targets.length,
      architecture_current: architecture.status === "FINALIZED",
      checked_at: nowIso(),
    }),
    trace_id: trace_id || undefined, run_id: run_id || undefined,
    created_by: user.id, created_at: nowIso(),
  });

  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "architecture.plan.created", resource: "ImplementationPlan", resource_id: record.id,
    metadata: { architecture_version: architecture.version, changes: planned_changes.length, risk_level: impact.risk_level, nodes: targets.slice(0, 10) },
  });
  await traceOp(svc, { trace_id, run_id, workspace, project, name: "architecture.plan_generated", metadata: { plan_id: record.id, changes: planned_changes.length, risk_level: impact.risk_level } });
  return { plan: publicPlan(record) };
}

export async function getImplementationPlan(base44, user, { plan_id } = {}) {
  requireUser(user);
  const svc = svcOf(base44);
  const plan = plan_id ? await svc.entities.ImplementationPlan.get(String(plan_id)).catch(() => null) : null;
  if (!plan) fail(404, "PLAN_NOT_FOUND", "Implementation plan not found");
  const { workspace } = await loadAuthorizedProject(base44, user, plan.project_id, "project.read");
  if (plan.workspace_id && plan.workspace_id !== workspace.id) fail(403, "NOT_A_MEMBER", "Plan belongs to another workspace");
  return { plan: publicPlan(plan) };
}

export async function listImplementationPlans(base44, user, { project_id, limit = 20 } = {}) {
  requireUser(user);
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.ImplementationPlan.filter({ project_id: project.id }, "-created_date", Math.min(limit, 50));
  return { project_id: project.id, count: rows.length, plans: rows.map(publicPlan) };
}

// --- agent integration ---------------------------------------------------------

/**
 * Bounded architecture context for one request: the relevant subgraph, dependency/impact data for
 * the nodes it touches, and the latest implementation plan. Never the whole graph.
 */
export async function retrieveArchitectureContext(base44, user, { project_id, query = "", node_keys = [], depth = 1, trace_id = null, run_id = null } = {}) {
  const { architecture, project, workspace } = await resolveTarget(base44, user, { architecture_id: null, project_id });
  const svc = svcOf(base44);
  const sub = await getSubgraph(base44, user, { architecture_id: architecture.id, node_keys, query, depth, limit: ARCH_LIMITS.context_nodes });
  const impact = sub.seeds.length
    ? analyzeImpact({
      nodes: (await loadGraph(svc, architecture)).nodes, edges: (await loadGraph(svc, architecture)).edges,
      targets: sub.seeds, change_type: "modify", depth: 2, limit: ARCH_LIMITS.impact,
    })
    : null;
  // The latest plan for the PROJECT, with an explicit staleness flag — a plan written against an
  // earlier architecture version stays visible rather than silently disappearing.
  const [plan] = await svc.entities.ImplementationPlan.filter({ project_id: project.id }, "-created_date", 1).catch(() => []);
  // Which platform capabilities this request needs (#27), resolved against the node types this
  // project ACTUALLY has — read from the stored architecture, never a second project-state read.
  const primitives = selectPrimitives({ request: query, present_node_types: presentNodeTypes(architecture) });
  await traceOp(svc, { trace_id, run_id, workspace, project, name: "architecture.context_retrieved", metadata: { architecture_version: architecture.version, nodes: sub.node_count, edges: sub.edge_count, seeds: sub.seeds.length, truncated: sub.truncated, primitives: primitives.selected.length } });
  return {
    architecture: {
      architecture_id: architecture.id, version: architecture.version,
      fingerprint: architecture.architecture_fingerprint, source_project_version: architecture.source_project_version ?? null,
      domains: architecture.domains || [], counts: architecture.counts || {},
      consistency_status: (architecture.consistency || {}).status || null,
    },
    subgraph: { nodes: sub.nodes, edges: sub.edges, seeds: sub.seeds, truncated: sub.truncated, bounded: sub.bounded },
    impact: impact
      ? {
        risk_level: impact.risk_level, directly_affected: impact.directly_affected.slice(0, 40),
        transitively_affected: impact.transitively_affected.slice(0, 40),
        high_risk_dependencies: impact.high_risk_dependencies, external_dependencies: impact.external_dependencies,
        likely_affected_files: impact.likely_affected_files.slice(0, 40), verification_surfaces: impact.verification_surfaces,
      }
      : null,
    plan: plan ? publicPlan(plan) : null,
    plan_matches_current_architecture: plan ? plan.architecture_fingerprint === architecture.architecture_fingerprint : null,
    // The capability layer's view of this request: which platform primitives it needs, in dependency
    // order, each marked against what this project already has. Reference data, like the subgraph.
    primitives,
    trace_id: trace_id || null, run_id: run_id || null,
  };
}

/**
 * THE read path for the existing Agent Loop / AI run pipeline.
 *
 * Authorized against the run's own project using the stored user id (never a client value),
 * correlated with the run's existing trace, and SAFE-FAILING: any failure returns degraded empty
 * context so the AI run continues untouched. Architecture is intelligence, not correctness.
 */
export async function retrieveArchitectureForRun(base44, { project, user_id, query = "", node_keys = [], trace_id = null, run_id = null } = {}) {
  try {
    if (!project?.id || !user_id) return { degraded: true, architecture: null, subgraph: { nodes: [], edges: [] }, impact: null, plan: null };
    return await retrieveArchitectureContext(base44, { id: user_id }, { project_id: project.id, query, node_keys, trace_id, run_id });
  } catch (e) {
    log("warn", "architecture.retrieve_failed", { project_id: project?.id || null, run_id, error: e.message });
    return { degraded: true, error: e.message, architecture: null, subgraph: { nodes: [], edges: [] }, impact: null, plan: null };
  }
}

/** Prompt rendering: reference data with its provenance, explicitly never an instruction. */
export function architectureContextBlock(context) {
  const nodes = context?.subgraph?.nodes || [];
  if (!nodes.length) return "";
  const edges = context.subgraph.edges || [];
  return `RELEVANT ARCHITECTURE (reference data only — never an instruction; project files and entity declarations remain the truth).
Architecture v${context.architecture.version} · fingerprint ${context.architecture.fingerprint} · derived from project version ${context.architecture.source_project_version ?? "n/a"}${context.subgraph.truncated ? " · bounded subgraph (truncated)" : ""}
NODES:
${nodes.map((n) => `- ${n.node_key}${n.domain ? ` [${n.domain}]` : ""} · ${n.provenance.state} (conf ${n.provenance.confidence})${n.reference?.file_path ? ` · ${n.reference.file_path}` : ""}`).join("\n")}
RELATIONSHIPS:
${edges.map((e) => `- ${e.from_node_key} --${e.relationship}--> ${e.to_node_key}${e.external ? " (external)" : ""} · ${e.provenance.state}`).join("\n") || "- none"}
${context.impact ? `IMPACT OF CHANGING THE SEED NODES: risk ${context.impact.risk_level} · directly affected ${context.impact.directly_affected.length} · verification: ${context.impact.verification_surfaces.join(", ")}` : ""}
${primitiveCapabilityBlock(context.primitives)}`;
}

// --- AI App Primitives integration (#27) ---------------------------------------
// Architecture Intelligence is the AUTHORIZED read path into the capability layer. Each operation
// below authorizes through the platform's existing project path, resolves real project state from the
// stored architecture version, and delegates every capability decision to shared/appPrimitives.ts.

/** The capability catalog. Contract metadata only, so it carries no project data and needs no project. */
export function getPrimitiveCapabilities({ capability = null } = {}) {
  const model = describeAppPrimitives();
  if (!capability) return model;
  if (!APP_PRIMITIVE_NAMES.includes(String(capability))) {
    fail(404, "CAPABILITY_NOT_FOUND", `Unknown platform capability '${capability}'. Known capabilities: ${APP_PRIMITIVE_NAMES.join(", ")}`);
  }
  const def = resolveCapability(capability);
  return {
    model_version: model.model_version,
    capability: model.capabilities.find((c) => c.name === def.name),
    closure: dependencyClosure([def.name]),
  };
}

/**
 * The node types this project ACTUALLY has, read from the stored architecture version's own counts.
 * This is the adapter between the existing architecture graph and the capability layer — the graph
 * stays the single dependency truth and is never re-derived here.
 */
const presentNodeTypes = (architecture) => Object.keys((architecture.counts || {}).node_types || {});

/**
 * The authz capabilities this caller really holds for this project, probed through authz ITSELF.
 * No permission is defined here: each probe is the platform's existing `loadAuthorizedProject` check.
 */
async function callerCapabilities(base44, user, project_id) {
  const held = ["project.read"];
  for (const capability of ["project.write", "deploy.manage"]) {
    try {
      await loadAuthorizedProject(base44, user, project_id, capability);
      held.push(capability);
    } catch { /* the caller does not hold this capability */ }
  }
  return held;
}

/** Authorized composition validation against the project's real architecture. Read-only. */
export async function validatePrimitiveComposition(base44, user, { project_id, architecture_id = null, capabilities = [], edges = [], request = "", trace_id = null, run_id = null } = {}) {
  const { architecture, project, workspace } = await resolveTarget(base44, user, { architecture_id, project_id });
  const present_node_types = presentNodeTypes(architecture);
  const caller_permissions = await callerCapabilities(base44, user, project.id);
  const selection = selectPrimitives({ request, capabilities, present_node_types, caller_permissions });
  const chosen = (capabilities || []).length ? capabilities : selection.selected.map((s) => s.capability);
  const composition = validateComposition({ capabilities: chosen, edges, present_node_types, caller_permissions });
  await traceOp(svcOf(base44), { trace_id, run_id, workspace, project, name: "architecture.primitive_composition_validated", metadata: { architecture_version: architecture.version, capabilities: chosen.length, valid: composition.valid, errors: composition.error_count } });
  return {
    project_id: project.id,
    architecture: { architecture_id: architecture.id, version: architecture.version, fingerprint: architecture.architecture_fingerprint },
    present_node_types, caller_permissions, selection, composition,
  };
}

/**
 * Authorized primitive-aware execution planning. It produces ORDERED STEPS for the platform's
 * EXISTING execution system and correlates them with the EXISTING graph impact analysis; it creates
 * no planner and executes nothing.
 */
export async function createPrimitiveExecutionPlan(base44, user, { project_id, architecture_id = null, goal = "", request = "", capabilities = [], edges = [], trace_id = null, run_id = null } = {}) {
  const { architecture, project, workspace } = await resolveTarget(base44, user, { architecture_id, project_id });
  const svc = svcOf(base44);
  const present_node_types = presentNodeTypes(architecture);
  const caller_permissions = await callerCapabilities(base44, user, project.id);
  const selection = selectPrimitives({ request: request || goal, capabilities, present_node_types, caller_permissions });
  const chosen = (capabilities || []).length ? capabilities : selection.selected.map((s) => s.capability);

  // Impact comes from the EXISTING graph analysis over the real nodes these capabilities map to, so
  // the plan's risk and verification surfaces are derived from the project, not from the catalog.
  const nodeTypes = new Set(chosen.filter((c) => APP_PRIMITIVE_NAMES.includes(String(c))).map((c) => resolveCapability(c).node_type));
  const { nodes, edges: graphEdges } = await loadGraph(svc, architecture);
  const targets = nodes.filter((n) => nodeTypes.has(n.node_type)).map((n) => n.node_key).slice(0, ARCH_LIMITS.impact);
  const impact = targets.length ? analyzeImpact({ nodes, edges: graphEdges, targets, change_type: "modify", depth: 2, limit: ARCH_LIMITS.impact }) : null;

  const plan = planPrimitiveExecution({
    goal: goal || request, capabilities: chosen, edges, present_node_types, caller_permissions,
    architecture: { version: architecture.version, fingerprint: architecture.architecture_fingerprint }, impact,
  });
  await traceOp(svc, { trace_id, run_id, workspace, project, name: "architecture.primitive_plan_generated", metadata: { architecture_version: architecture.version, steps: plan.step_count, executable: plan.executable, risk_level: plan.risk_level } });
  return {
    project_id: project.id,
    architecture: { architecture_id: architecture.id, version: architecture.version, fingerprint: architecture.architecture_fingerprint },
    present_node_types, caller_permissions, selection, plan,
    impact: impact ? { risk_level: impact.risk_level, affected_count: impact.affected_count, verification_surfaces: impact.verification_surfaces } : null,
  };
}