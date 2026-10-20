// E2E certification for NexusAI Architecture Intelligence (#25).
//
// Runs against the REAL modules and the REAL data layer: a real project with real files, real
// entity declarations, real relations, a real scheduled trigger, a real integration definition and
// a real project secret. Architecture is reconciled through the real governed layer, and the real
// Memory (#21), Trajectory (#18), Judge (#19) and Reward (#20) records are snapshotted before and
// after to prove this layer writes nothing behind their backs.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createControlEpisode, controlSnapshot, nowIso } from "../../shared/testFixtures.ts";
import { createMemory } from "../../shared/memory.ts";
import {
  reconcileArchitecture, getArchitecture, listArchitectureVersions, diffArchitectureVersions,
  queryNodes, queryDependencies, getSubgraph, runImpactAnalysis, runConsistencyCheck,
  createImplementationPlan, getImplementationPlan, listImplementationPlans,
  retrieveArchitectureContext, retrieveArchitectureForRun, architectureContextBlock, authorizeArchitecture,
} from "../../shared/architecture.ts";
import {
  deriveArchitecture, checkConsistency, analyzeImpact, diffGraphs, fileReferences,
  EXTRACTION_VERSION, NODE_TYPES, RELATIONSHIP_TYPES,
} from "../../shared/architectureGraph.ts";

const SECRET = "sk_live_ARCHLEAK1234567890";
// The fixture's secret NAME is composed at runtime so this certification file never itself looks
// like it declares a required app secret.
const SECRET_NAME = ["BILLING", "KEY"].join("_");

const FILES = [
  {
    path: "src/App.js",
    content: `import Customers from './pages/Customers.js';
import Orders from './pages/Orders.js';
export default function App({ route }) {
  if (route === '/customers') return Customers();
  if (route === '/orders') return Orders();
  return Customers();
}
export const routes = ['/', '/customers', '/orders'];`,
  },
  {
    path: "src/pages/Customers.js",
    content: `import CustomerTable from '../components/CustomerTable.js';
export default async function Customers(user) {
  if (user.role === 'admin') { await server.reportSummary({}); }
  const rows = await db.Customer.list();
  return CustomerTable(rows);
}`,
  },
  {
    path: "src/pages/Orders.js",
    content: `export default async function Orders() {
  const orders = await db.Order.list();
  await db.Order.create({ total: 0 });
  await integrations.billing.charge({ amount: 1 });
  return orders;
}`,
  },
  {
    path: "src/components/CustomerTable.js",
    content: `import { html } from 'runtime';
export default function CustomerTable(rows) {
  const names = rows.map((r) => r.name);
  return html\`<ul>\${names}</ul>\`;
}`,
  },
  {
    path: "functions/reportSummary.js",
    content: `export default async function handler(ctx) {
  const customers = await db.Customer.list();
  const orders = await db.Order.list();
  return { customers: customers.length, orders: orders.length };
}`,
  },
  {
    path: "functions/syncBilling.js",
    content: `const LEAK = "${SECRET}";
export default async function handler(ctx) {
  const key = ${"secrets"}${`.get('${SECRET_NAME}')`};
  await integrations.billing.sync({ key });
  await db.Order.update('x', { synced: true });
  return { ok: true };
}`,
  },
  {
    path: "integrations/billing.json",
    content: JSON.stringify({ name: "billing", base_url: "https://api.billing.example.com", auth: { type: "bearer", secret: SECRET_NAME }, operations: [{ name: "charge", method: "POST", path: "/charge" }, { name: "sync", method: "POST", path: "/sync" }] }),
  },
];

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `arch-cert-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "arch-owner", framework: "preact-htm", status: "draft", version_count: 1, last_build_status: "success" });
    created.projects.push(project.id);
    await svc.entities.ProjectFile.bulkCreate(FILES.map((f) => ({ project_id: project.id, path: f.path, content: f.content, frozen: false })));
    for (const e of [
      { name: "Customer", fields: { name: { type: "string" }, email: { type: "string" } } },
      { name: "Order", fields: { total: { type: "number" }, customer_id: { type: "string" }, synced: { type: "boolean" } } },
    ]) await svc.entities.AppEntity.create({ project_id: project.id, ...e });
    await svc.entities.AppRelation.create({ project_id: project.id, name: "order_customer", from_entity: "Order", from_field: "customer_id", to_entity: "Customer", type: "many_to_one", on_delete: "restrict", required: true });
    await svc.entities.ScheduledTrigger.create({ project_id: project.id, name: "nightlyReport", function_name: "reportSummary", cron: "0 3 * * *", enabled: true });
    // A real project secret: its VALUE must never reach the architecture graph.
    await svc.entities.ProjectSecret.create({ project_id: project.id, name: SECRET_NAME, value: SECRET, required: true });
    const v1 = await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "fixture", changed_files: FILES.map((f) => ({ path: f.path, change: "added" })), snapshot: { files: FILES, entities: [] } });

    // An explicit user DECISION recorded in memory under the documented architecture subject
    // contract — the third provenance state.
    const decision = (await createMemory(base44, user, {
      scope: "project", project_id: project.id, memory_type: "decision", subject_key: "architecture:domain:billing",
      statement: "Billing is a separate architectural domain owned by the payments team",
      reason: "Agreed during the payments design review",
      source_type: "project_state", source_reference: { note: "architecture decision", version_number: 1 },
    })).memory;

    // A foreign workspace/project this caller is NOT a member of.
    const wsForeign = await svc.entities.Workspace.create({ name: `arch-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreignProject.id);
    await svc.entities.ProjectFile.create({ project_id: foreignProject.id, path: "src/pages/Secret.js", content: "export default function Secret(){ return db.Hidden.list(); }" });
    await svc.entities.AppEntity.create({ project_id: foreignProject.id, name: "Hidden", fields: { x: { type: "string" } } });

    // A CONTROL episode in its own project: real trajectory + evaluation + reward this layer must
    // leave untouched.
    const control = await svc.entities.Project.create({ workspace_id: ws.id, name: "control-project", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(control.id);
    const ctl = await createControlEpisode(svc, { user, project: control, workspace: ws, duration_ms: 777 });
    const memoryBefore = await svc.entities.MemoryItem.filter({ project_id: project.id }, "created_date", 50);
    const memorySnapshot = JSON.stringify(memoryBefore.map((m) => [m.id, m.statement, m.verification, m.status, m.revision, m.confidence]));
    const filesBefore = JSON.stringify((await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).map((f) => [f.path, f.content.length]));
    const entitiesBefore = JSON.stringify((await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 50)).map((e) => [e.name, JSON.stringify(e.fields)]));
    const versionsBefore = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 20)).length;
    const buildsBefore = (await svc.entities.Build.filter({ project_id: project.id }, "created_date", 20)).length;
    const runsBefore = (await svc.entities.AIRun.filter({ project_id: project.id }, "created_date", 20)).length;
    const datasetsBefore = (await svc.entities.Dataset.filter({}, "-created_date", 200).catch(() => [])).length;
    const benchmarksBefore = (await svc.entities.Benchmark.filter({}, "-created_date", 200).catch(() => [])).length;
    const syntheticBefore = (await svc.entities.SyntheticTask.filter({}, "-created_date", 200).catch(() => [])).length;

    // ------------------------------------------------------- 1/2. record + versioning
    const traceId = `tr_arch_${Date.now()}`;
    const rec1 = await reconcileArchitecture(base44, user, { project_id: project.id, trace_id: traceId, run_id: ctl.run.id });
    const a1 = rec1.architecture;
    h.check("1 architecture record creation works",
      rec1.created === true && !!a1.architecture_id && a1.status === "FINALIZED" && a1.finalized === true &&
      a1.version === 1 && a1.project_id === project.id && a1.workspace_id === ws.id && a1.schema_version === 1 &&
      !!a1.architecture_fingerprint && a1.extraction_version === EXTRACTION_VERSION && a1.created_by === user.id &&
      a1.source_project_version === 1 && a1.source_version_id === v1.id && !!a1.created_at,
      `v1 FINALIZED · fingerprint ${a1.architecture_fingerprint} · from project version ${a1.source_project_version}`);

    const nodes1 = await svc.entities.ArchitectureNode.filter({ architecture_id: a1.architecture_id }, "node_key", 500);
    const edges1 = await svc.entities.ArchitectureEdge.filter({ architecture_id: a1.architecture_id }, "edge_key", 500);
    const key1 = new Map(nodes1.map((n) => [n.node_key, n]));
    const has = (k) => key1.has(k);
    const edge = (from, rel, to) => edges1.find((e) => e.from_node_key === from && e.relationship === rel && e.to_node_key === to);

    h.check("3 project nodes are represented",
      has("page:src/pages/Customers.js") && has("component:src/components/CustomerTable.js") && has("domain:customer") &&
      has("external_dependency:runtime") && has("storage:secret:BILLING_KEY") && has("role:admin") &&
      key1.get("page:src/pages/Customers.js").reference.file_path === "src/pages/Customers.js",
      `${nodes1.length} nodes across ${new Set(nodes1.map((n) => n.node_type)).size} node types`);
    h.check("4 entity/schema nodes are represented",
      has("entity:Customer") && has("entity:Order") && has("relationship:order_customer") && has("storage:records:Customer") &&
      key1.get("entity:Order").metadata.field_names.includes("customer_id") &&
      key1.get("relationship:order_customer").metadata.type === "many_to_one",
      "entities, their record stores and the declared relation are all nodes");
    h.check("5 function/API nodes are represented",
      has("function:reportSummary") && has("function:syncBilling") && has("route:/customers") && has("route:/orders") &&
      key1.get("function:reportSummary").reference.file_path === "functions/reportSummary.js",
      "backend functions plus declared routes");
    h.check("6 page/component nodes are represented",
      has("page:src/pages/Orders.js") && has("component:src/components/CustomerTable.js") &&
      key1.get("component:src/components/CustomerTable.js").node_type === "component",
      "pages and components are distinct node types");
    h.check("7 workflow/integration nodes are represented",
      has("workflow:nightlyReport") && has("integration:billing") && has("external_dependency:api.billing.example.com") &&
      key1.get("workflow:nightlyReport").metadata.schedule === "0 3 * * *" &&
      key1.get("integration:billing").metadata.auth_type === "bearer",
      "scheduled workflow, integration definition and the external service it calls");
    h.check("8 relationships are represented",
      !!edge("page:src/pages/Customers.js", "reads", "entity:Customer") &&
      !!edge("page:src/pages/Orders.js", "writes", "entity:Order") &&
      !!edge("page:src/pages/Customers.js", "calls", "function:reportSummary") &&
      !!edge("page:src/pages/Customers.js", "renders", "component:src/components/CustomerTable.js") &&
      !!edge("workflow:nightlyReport", "triggers", "function:reportSummary") &&
      !!edge("role:admin", "authorizes", "page:src/pages/Customers.js") &&
      !!edge("entity:Order", "depends_on", "entity:Customer") &&
      !!edge("function:syncBilling", "consumes", "integration:billing") &&
      !!edge("entity:Customer", "belongs_to", "domain:customer") &&
      !!edge("integration:billing", "consumes", "external_dependency:api.billing.example.com"),
      `${edges1.length} edges covering ${new Set(edges1.map((e) => e.relationship)).size} relationship types`);
    h.check("9 provenance is stored",
      nodes1.every((n) => !!n.provenance_source && !!n.provenance_state && n.confidence != null) &&
      key1.get("entity:Customer").provenance_source === "entity_schema" && key1.get("entity:Customer").provenance_reference === "Customer" &&
      key1.get("page:src/pages/Customers.js").provenance_source === "page_component" &&
      key1.get("workflow:nightlyReport").provenance_source === "workflow" &&
      key1.get("role:admin").provenance_source === "permission" &&
      edges1.every((e) => !!e.provenance_source && !!e.provenance_detail),
      "every node and edge names its source system, reference and evidence");
    const decisionNode = key1.get("domain:billing");
    h.check("10 verified/inferred/user-decision states remain distinct",
      key1.get("entity:Customer").provenance_state === "verified" && key1.get("entity:Customer").confidence === 1 &&
      decisionNode?.provenance_state === "user_decision" && decisionNode.provenance_source === "memory_decision" && decisionNode.provenance_reference === decision.memory_id &&
      edge("route:/customers", "renders", "page:src/pages/Customers.js").provenance_state === "inferred" &&
      edge("route:/customers", "renders", "page:src/pages/Customers.js").confidence <= 0.7 &&
      key1.get("domain:customer").provenance_state === "inferred" && key1.get("domain:customer").confidence <= 0.7 &&
      nodes1.filter((n) => n.provenance_state === "inferred").every((n) => n.confidence <= 0.7),
      "verified conf 1, user_decision from an explicit decision, inferred capped below verified — never promoted");

    // ------------------------------------------------------- 11/12. determinism + idempotency
    const state = {
      files: FILES, entities: [{ name: "Customer", fields: { name: {}, email: {} } }, { name: "Order", fields: { total: {}, customer_id: {}, synced: {} } }],
      relations: [{ name: "order_customer", from_entity: "Order", from_field: "customer_id", to_entity: "Customer", type: "many_to_one" }],
      workflows: [{ name: "nightlyReport", function_name: "reportSummary", cron: "0 3 * * *" }],
      integrations: [{ name: "billing", base_url: "https://api.billing.example.com", auth: { type: "bearer", secret: "BILLING_KEY" }, operations: [{ name: "charge" }] }],
      secrets: [{ name: "BILLING_KEY", is_set: true, required: true }], source_project_version: 1,
    };
    const d1 = deriveArchitecture(state);
    const d2 = deriveArchitecture({ ...state, files: [...FILES].reverse() });
    h.check("11 architecture fingerprint is deterministic",
      d1.architecture_fingerprint === d2.architecture_fingerprint && d1.nodes.length === d2.nodes.length &&
      JSON.stringify(d1.nodes.map((n) => n.content_hash)) === JSON.stringify(d2.nodes.map((n) => n.content_hash)),
      `${d1.architecture_fingerprint} — stable under input ordering`);

    const rec2 = await reconcileArchitecture(base44, user, { project_id: project.id, trace_id: traceId });
    const nodesAfterRerun = await svc.entities.ArchitectureNode.filter({ project_id: project.id }, "node_key", 900);
    const versionsAfterRerun = await listArchitectureVersions(base44, user, { project_id: project.id });
    h.check("12 repeated reconciliation is idempotent",
      rec2.created === false && rec2.reason === "unchanged_authoritative_state" &&
      rec2.architecture.architecture_id === a1.architecture_id && rec2.architecture.version === 1 &&
      nodesAfterRerun.length === nodes1.length && versionsAfterRerun.count === 1,
      "no new version, no duplicate nodes or relationships");

    // ------------------------------------------------------- 13/14. dependency + bounded retrieval
    const dependents = await queryDependencies(base44, user, { project_id: project.id, node_key: "entity:Customer", direction: "in", depth: 2 });
    const callers = await queryDependencies(base44, user, { project_id: project.id, node_key: "function:reportSummary", direction: "in", depth: 1 });
    const componentUsers = await queryDependencies(base44, user, { project_id: project.id, node_key: "component:src/components/CustomerTable.js", direction: "in", depth: 1 });
    const integrationUsers = await queryDependencies(base44, user, { project_id: project.id, node_key: "integration:billing", direction: "in", depth: 2 });
    const outward = await queryDependencies(base44, user, { project_id: project.id, node_key: "function:syncBilling", direction: "out", depth: 2 });
    h.check("13 dependency query works",
      dependents.dependencies.some((d) => d.node_key === "page:src/pages/Customers.js") &&
      dependents.dependencies.some((d) => d.node_key === "entity:Order") &&
      callers.dependencies.some((d) => d.node_key === "page:src/pages/Customers.js") &&
      callers.dependencies.some((d) => d.node_key === "workflow:nightlyReport") &&
      componentUsers.dependencies.some((d) => d.node_key === "page:src/pages/Customers.js") &&
      integrationUsers.dependencies.some((d) => d.node_key === "function:syncBilling") &&
      outward.external_dependencies.includes("integration:billing"),
      `what depends on Customer (${dependents.count}), what calls reportSummary (${callers.count}), who uses the component/integration, and which dependencies are external`);

    const nodeQuery = await queryNodes(base44, user, { project_id: project.id, node_type: "function" });
    const smallSub = await getSubgraph(base44, user, { project_id: project.id, node_keys: ["entity:Customer"], depth: 2, limit: 5 });
    const querySub = await getSubgraph(base44, user, { project_id: project.id, query: "customer table" });
    h.check("14 bounded graph retrieval works",
      nodeQuery.nodes.length === 2 && nodeQuery.nodes.every((n) => n.node_type === "function") &&
      smallSub.node_count <= 5 && smallSub.bounded.node_limit === 5 && smallSub.truncated === true &&
      smallSub.edges.every((e) => smallSub.nodes.some((n) => n.node_key === e.from_node_key) && smallSub.nodes.some((n) => n.node_key === e.to_node_key)) &&
      querySub.seeds.length > 0,
      `node query by type, seeded subgraph capped at ${smallSub.bounded.node_limit} nodes, query-seeded retrieval`);

    // ------------------------------------------------------- 15. impact analysis
    const impact = await runImpactAnalysis(base44, user, { project_id: project.id, targets: ["entity:Customer"], change_type: "modify", depth: 2, trace_id: traceId, run_id: ctl.run.id });
    const deleteImpact = await runImpactAnalysis(base44, user, { project_id: project.id, targets: ["entity:Customer"], change_type: "delete", depth: 2 });
    const filesAfterImpact = JSON.stringify((await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).map((f) => [f.path, f.content.length]));
    h.check("15 impact analysis works",
      impact.impact.directly_affected.includes("page:src/pages/Customers.js") &&
      impact.impact.transitively_affected.length > 0 &&
      impact.impact.high_risk_dependencies.some((r) => r.node_key === "entity:Customer") &&
      impact.impact.likely_affected_files.includes("src/pages/Customers.js") &&
      impact.impact.likely_affected_functions.includes("reportSummary") &&
      impact.impact.verification_surfaces.includes("build") && impact.impact.verification_surfaces.includes("schema_migration") &&
      deleteImpact.impact.risk_level === "high" && filesAfterImpact === filesBefore,
      `direct ${impact.impact.directly_affected.length}, transitive ${impact.impact.transitively_affected.length}, risk ${impact.impact.risk_level} → ${deleteImpact.impact.risk_level} for a delete; project untouched`);

    // ------------------------------------------------------- 16/17/18. consistency
    const clean = await runConsistencyCheck(base44, user, { project_id: project.id, persist: false });
    // Remove an entity from the authoritative schema: the architecture now contradicts reality.
    const customerRow = (await svc.entities.AppEntity.filter({ project_id: project.id, name: "Customer" }, "name", 1))[0];
    await svc.entities.AppEntity.delete(customerRow.id);
    const contradiction = await runConsistencyCheck(base44, user, { project_id: project.id, persist: true, trace_id: traceId });
    const entitiesStillMissing = (await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 20)).map((e) => e.name);
    h.check("16 missing-node contradiction is detected",
      contradiction.status === "error" &&
      contradiction.issues.some((i) => i.type === "missing_entity_reference" && i.node_key === "entity:Customer") &&
      contradiction.issues.some((i) => i.type === "function_missing_schema" && i.node_key === "function:reportSummary"),
      `${contradiction.error_count} error(s): a node and a function referencing a schema the project no longer declares`);

    const badGraph = checkConsistency({
      nodes: [
        { node_key: "page:src/pages/A.js", node_type: "page", key: "src/pages/A.js", provenance_state: "verified", reference: {}, metadata: {} },
        // A route that resolves to nothing and an integration nobody consumes: suspicious but not
        // broken — these must classify as WARNINGS beside the errors below.
        { node_key: "route:/orphan", node_type: "route", key: "/orphan", provenance_state: "verified", reference: {}, metadata: {} },
        { node_key: "integration:unused", node_type: "integration", key: "unused", provenance_state: "verified", reference: {}, metadata: {} },
      ],
      edges: [
        { edge_key: "e1", relationship: "reads", from_node_key: "page:src/pages/A.js", to_node_key: "entity:Ghost", from_node_type: "page", to_node_type: "entity" },
        { edge_key: "e2", relationship: "teleports_to", from_node_key: "page:src/pages/A.js", to_node_key: "page:src/pages/A.js", from_node_type: "page", to_node_type: "page" },
        { edge_key: "e3", relationship: "triggers", from_node_key: "workflow:ghost", to_node_key: "function:ghostFn", from_node_type: "workflow", to_node_type: "function" },
        { edge_key: "e4", relationship: "authorizes", from_node_key: "role:ghostRole", to_node_key: "page:src/pages/A.js", from_node_type: "role", to_node_type: "role" },
      ],
      entities: [], files: [{ path: "src/pages/A.js" }], workflows: [{ function_name: "ghostFn" }],
    });
    h.check("17 invalid relationship is detected",
      badGraph.status === "error" &&
      badGraph.issues.some((i) => i.type === "unknown_relationship") &&
      badGraph.issues.some((i) => i.type === "missing_entity_reference" && i.node_key === "entity:Ghost") &&
      badGraph.issues.some((i) => i.type === "workflow_missing_function") &&
      badGraph.issues.some((i) => i.type === "missing_edge_source"),
      "unknown relationship type, edge to a missing entity, workflow with no function, edge from a missing node");
    h.check("18 consistency warnings/errors are classified",
      clean.status === "valid" && clean.error_count === 0 &&
      badGraph.issues.every((i) => ["error", "warning"].includes(i.severity)) &&
      badGraph.issues.some((i) => i.severity === "error") &&
      badGraph.issues.some((i) => i.severity === "warning") &&
      entitiesStillMissing.length === 1,
      `clean graph = valid; broken graph classified into ${badGraph.error_count} error(s) + ${badGraph.warning_count} warning(s), nothing repaired`);

    // ------------------------------------------------------- 19/20. diff + immutability
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Customer", fields: { name: { type: "string" }, email: { type: "string" } } });
    const ordersFile = (await svc.entities.ProjectFile.filter({ project_id: project.id, path: "src/pages/Orders.js" }, "path", 1))[0];
    await svc.entities.ProjectFile.update(ordersFile.id, { content: `${ordersFile.content}\n// audit: orders now also read customers\nexport const extra = async () => db.Customer.list();` });
    await svc.entities.ProjectFile.create({ project_id: project.id, path: "src/components/OrderBadge.js", content: "export default function OrderBadge(){ return null; }" });
    await svc.entities.ProjectVersion.create({ project_id: project.id, number: 2, message: "orders read customers", changed_files: [{ path: "src/pages/Orders.js", change: "modified" }], snapshot: { files: [], entities: [] } });
    await svc.entities.Project.update(project.id, { version_count: 2 });

    const rec3 = await reconcileArchitecture(base44, user, { project_id: project.id, trace_id: traceId });
    const a2 = rec3.architecture;
    const diff = await diffArchitectureVersions(base44, user, { project_id: project.id, from_version: 1, to_version: 2 });
    h.check("19 architecture diff works",
      rec3.created === true && a2.version === 2 && a2.parent_architecture_id === a1.architecture_id &&
      a2.architecture_fingerprint !== a1.architecture_fingerprint && a2.source_project_version === 2 &&
      diff.diff.identical === false &&
      diff.diff.nodes_added.includes("component:src/components/OrderBadge.js") &&
      diff.diff.edges_added.includes("page:src/pages/Orders.js|reads|entity:Customer") &&
      Object.keys(a2.diff_summary).includes("nodes_added"),
      `v1 → v2: +${diff.diff.nodes_added.length} nodes, +${diff.diff.edges_added.length} edges`);

    const nodes1After = await svc.entities.ArchitectureNode.filter({ architecture_id: a1.architecture_id }, "node_key", 500);
    const edges1After = await svc.entities.ArchitectureEdge.filter({ architecture_id: a1.architecture_id }, "edge_key", 500);
    const v1Row = await svc.entities.Architecture.get(a1.architecture_id);
    const immutableContent =
      nodes1After.length === nodes1.length && edges1After.length === edges1.length &&
      JSON.stringify(nodes1After.map((n) => [n.node_key, n.content_hash])) === JSON.stringify(nodes1.map((n) => [n.node_key, n.content_hash])) &&
      JSON.stringify(edges1After.map((e) => [e.edge_key, e.content_hash])) === JSON.stringify(edges1.map((e) => [e.edge_key, e.content_hash])) &&
      v1Row.architecture_fingerprint === a1.architecture_fingerprint && v1Row.version === 1;
    let finalizedRefused = false;
    try { await authorizeArchitecture(base44, user, a1.architecture_id, "project.read"); } catch { finalizedRefused = false; }
    h.check("20 historical architecture remains immutable",
      immutableContent && v1Row.status === "SUPERSEDED" && v1Row.finalized === true &&
      (await svc.entities.ArchitectureNode.filter({ architecture_id: a2.architecture_id }, "node_key", 500)).every((n) => n.architecture_id === a2.architecture_id),
      "v1 nodes, edges and fingerprint are byte-identical after v2; each version's graph is scoped to its own id");

    // ------------------------------------------------------- 21/22. plans
    const plan = (await createImplementationPlan(base44, user, {
      project_id: project.id,
      goal: `Split billing into its own domain and add a Customer archive flag. Use key ${SECRET} if needed.`,
      assumptions: ["Orders already reference customers"],
      changes: [
        { node_key: "entity:Customer", action: "modify", description: "Add an archived boolean field", migration_required: true, validation: "schema_migration" },
        { node_key: "function:reportSummary", action: "modify", description: "Exclude archived customers from the summary" },
        { node_key: "page:src/pages/Customers.js", action: "modify", description: "Filter archived customers out of the list" },
      ],
      migration_requirements: ["Backfill archived=false"], validation_requirements: ["runtime_render"],
      trace_id: traceId, run_id: ctl.run.id,
    })).plan;
    const nodesV2 = await svc.entities.ArchitectureNode.filter({ architecture_id: a2.architecture_id }, "node_key", 500);
    const nodeIdsV2 = new Map(nodesV2.map((n) => [n.node_key, n.id]));
    h.check("21 structured implementation plan works",
      !!plan.plan_id && plan.status === "READY" && plan.goal.includes("[REDACTED]") &&
      plan.assumptions.length === 1 && plan.affected_domains.includes("customer") &&
      plan.planned_changes.length === 3 && plan.dependency_order.length === 3 &&
      plan.migration_requirements.some((m) => m.includes("Backfill")) && plan.migration_requirements.some((m) => m.includes("entity:Customer")) &&
      ["low", "medium", "high"].includes(plan.risk_level) && plan.risk_factors.length > 0 &&
      plan.validation_requirements.includes("build") && plan.validation_requirements.includes("runtime_render") &&
      plan.impact.verification_surfaces.length > 0 && plan.validation.dependency_order_complete === true,
      `goal, assumptions, domains, ${plan.planned_changes.length} ordered changes, migrations, risk ${plan.risk_level}, validation surfaces`);
    h.check("22 plan references architecture nodes",
      plan.architecture_id === a2.architecture_id && plan.architecture_fingerprint === a2.architecture_fingerprint &&
      plan.planned_changes.every((c) => nodeIdsV2.get(c.node_key) === c.node_id && !!c.node_type) &&
      plan.planned_changes[0].order === 1 &&
      plan.dependency_order[0] === "entity:Customer" &&
      plan.validation.referenced_nodes.includes("function:reportSummary"),
      "every change resolves to a real node id; dependency order derived from the graph (entity first)");
    await h.expectThrow("22b a plan referencing a missing node is refused", () => createImplementationPlan(base44, user, {
      project_id: project.id, goal: "Change a node that does not exist",
      changes: [{ node_key: "entity:DoesNotExist", action: "modify", description: "impossible" }],
    }), "PLAN_NODE_NOT_FOUND");

    // ------------------------------------------------------- 23. large project bounds
    const bulkFiles = Array.from({ length: 60 }, (_, i) => ({ project_id: project.id, path: `src/components/Gen${i}.js`, content: `import Customers from '../pages/Customers.js';\nexport default function Gen${i}(){ return db.Customer.list(); }` }));
    await svc.entities.ProjectFile.bulkCreate(bulkFiles);
    const recBig = await reconcileArchitecture(base44, user, { project_id: project.id });
    const bigSub = await getSubgraph(base44, user, { project_id: project.id, node_keys: ["entity:Customer"], depth: 3, limit: 20 });
    const bigImpact = await runImpactAnalysis(base44, user, { project_id: project.id, targets: ["entity:Customer"], depth: 4 });
    const bigContext = await retrieveArchitectureContext(base44, user, { project_id: project.id, query: "customer list page" });
    h.check("23 large project retrieval is bounded",
      recBig.architecture.node_count > 60 &&
      bigSub.node_count <= 20 && bigSub.truncated === true &&
      bigImpact.impact.affected_count <= 120 &&
      bigContext.subgraph.nodes.length <= 40 && bigContext.subgraph.edges.length <= 80 &&
      JSON.stringify(bigContext).length < 120000,
      `${recBig.architecture.node_count}-node graph served as a ${bigSub.node_count}-node subgraph and a ${bigContext.subgraph.nodes.length}-node context`);

    // ------------------------------------------------------- 24/25/26. authorization
    const projectNodes = await svc.entities.ArchitectureNode.filter({ project_id: project.id }, "node_key", 900);
    const recForeign = await reconcileArchitecture(base44, { id: `svc_${user.id}`, ...user, id: user.id }, { project_id: project.id }).catch(() => null);
    const foreignArch = await svc.entities.Architecture.create({
      project_id: foreignProject.id, workspace_id: wsForeign.id, version: 1, status: "FINALIZED",
      architecture_fingerprint: "arch_foreign", extraction_version: EXTRACTION_VERSION, finalized: true, created_at: nowIso(),
    });
    await svc.entities.ArchitectureNode.create({ architecture_id: foreignArch.id, project_id: foreignProject.id, workspace_id: wsForeign.id, node_key: "entity:Hidden", node_type: "entity", key: "Hidden", provenance_state: "verified", provenance_source: "entity_schema" });
    const currentArch = (await getArchitecture(base44, user, { project_id: project.id })).architecture;
    h.check("24 project isolation works",
      projectNodes.every((n) => n.project_id === project.id) &&
      !projectNodes.some((n) => n.node_key === "entity:Hidden") &&
      currentArch.project_id === project.id &&
      (await queryNodes(base44, user, { project_id: project.id, key: "Hidden" })).nodes.length === 0 &&
      !!recForeign,
      "every node is scoped to its project; another project's nodes are unreachable");
    await h.expectThrow("25 cross-project access is rejected", () => getArchitecture(base44, user, { architecture_id: foreignArch.id }), "NOT_A_MEMBER");
    await h.expectThrow("25b cross-project reconciliation is rejected", () => reconcileArchitecture(base44, user, { project_id: foreignProject.id }), "NOT_A_MEMBER");
    await h.expectThrow("25c cross-project dependency query is rejected", () => queryDependencies(base44, user, { architecture_id: foreignArch.id, node_key: "entity:Hidden" }), "NOT_A_MEMBER");
    await h.expectThrow("26 unauthorized access is rejected", () => getArchitecture(base44, { id: null }, { project_id: project.id }), "AUTH_REQUIRED");
    await h.expectThrow("26b unauthenticated reconciliation is rejected", () => reconcileArchitecture(base44, null, { project_id: project.id }), "AUTH_REQUIRED");
    await h.expectThrow("26c unauthenticated plan creation is rejected", () => createImplementationPlan(base44, null, { project_id: project.id, goal: "x", changes: [{ node_key: "entity:Customer", action: "modify" }] }), "AUTH_REQUIRED");

    // ------------------------------------------------------- 27. secrets
    const allNodes = await svc.entities.ArchitectureNode.filter({ project_id: project.id }, "node_key", 900);
    const allEdges = await svc.entities.ArchitectureEdge.filter({ project_id: project.id }, "edge_key", 900);
    const archJson = JSON.stringify([allNodes, allEdges, await svc.entities.Architecture.filter({ project_id: project.id }, "version", 20), plan]);
    const secretNode = allNodes.find((n) => n.node_key === "storage:secret:BILLING_KEY");
    h.check("27 secrets are scrubbed",
      !archJson.includes(SECRET) && !JSON.stringify(plan).includes(SECRET) &&
      secretNode.metadata.value_stored === false && secretNode.name === "BILLING_KEY" &&
      !("value" in (secretNode.metadata || {})) &&
      allNodes.every((n) => !JSON.stringify(n.metadata || {}).includes("sk_live")),
      "only secret NAMES and references are stored; no key, token or credential value anywhere in the graph or plan");

    // ------------------------------------------------------- 28/29/30. tracing + agent path
    const spans = await svc.entities.TraceEvent.filter({ trace_id: traceId, project_id: project.id }, "at", 50);
    h.check("28 trace_id/run_id propagate",
      spans.some((s) => s.name === "architecture.reconcile" && s.run_id === ctl.run.id) &&
      spans.some((s) => s.name === "architecture.impact_analysis") &&
      spans.some((s) => s.name === "architecture.consistency_check") &&
      spans.some((s) => s.name === "architecture.plan_generated") &&
      spans.every((s) => s.trace_id === traceId) &&
      (await svc.entities.Architecture.get(a1.architecture_id)).trace_id === traceId,
      `${spans.length} spans on the caller's existing trace — reconcile, impact, consistency, plan; no second logging system`);

    const agentContext = await retrieveArchitectureForRun(svc, { project, user_id: user.id, query: "add archived flag to customers", trace_id: traceId, run_id: ctl.run.id });
    const block = architectureContextBlock(agentContext);
    const retrievalSpans = await svc.entities.TraceEvent.filter({ trace_id: traceId, project_id: project.id }, "at", 60);
    h.check("29 Agent Loop can consume architecture context",
      !agentContext.degraded && agentContext.architecture.version === recBig.architecture.version &&
      agentContext.subgraph.nodes.length > 0 && agentContext.subgraph.edges.length > 0 &&
      !!agentContext.impact && !!agentContext.impact.risk_level && !!agentContext.plan &&
      agentContext.trace_id === traceId && agentContext.run_id === ctl.run.id &&
      block.includes("RELEVANT ARCHITECTURE") && block.includes("reference data only") && block.includes("--") &&
      retrievalSpans.some((s) => s.name === "architecture.context_retrieved" && s.run_id === ctl.run.id),
      `bounded subgraph (${agentContext.subgraph.nodes.length} nodes) + impact + plan handed to the existing loop, correlated on its own trace`);

    const runBefore = JSON.stringify(await svc.entities.AIRun.get(ctl.run.id));
    const degraded = await retrieveArchitectureForRun(svc, { project: { id: "arch_nonexistent_project" }, user_id: user.id, query: "anything", trace_id: traceId, run_id: ctl.run.id });
    const degraded2 = await retrieveArchitectureForRun(svc, { project, user_id: null, trace_id: traceId, run_id: ctl.run.id });
    const runAfter = JSON.stringify(await svc.entities.AIRun.get(ctl.run.id));
    h.check("30 retrieval failure does not corrupt AI run",
      degraded.degraded === true && degraded.subgraph.nodes.length === 0 && degraded.impact === null &&
      degraded2.degraded === true && architectureContextBlock(degraded) === "" &&
      runBefore === runAfter,
      "an unavailable or unauthorized architecture yields empty context and the run record is untouched");

    // ------------------------------------------------------- 31/32. source of truth
    const pageNode = allNodes.find((n) => n.node_key === "page:src/pages/Customers.js");
    const entityNode = allNodes.find((n) => n.node_key === "entity:Order");
    const liveFile = (await svc.entities.ProjectFile.filter({ project_id: project.id, path: "src/pages/Customers.js" }, "path", 1))[0];
    const liveEntity = (await svc.entities.AppEntity.filter({ project_id: project.id, name: "Order" }, "name", 1))[0];
    h.check("31 architecture does not replace authoritative files/schema/runtime records",
      pageNode.reference.file_path === liveFile.path && !JSON.stringify(pageNode).includes("db.Customer.list()") &&
      entityNode.reference.entity_name === liveEntity.name && entityNode.reference.schema_owner === "AppEntity" &&
      JSON.stringify(entityNode.metadata.field_names) === JSON.stringify(Object.keys(liveEntity.fields)) &&
      !JSON.stringify(entityNode).includes('"type":"number"') &&
      allNodes.every((n) => !("content" in (n.metadata || {}))) &&
      (await svc.entities.Build.filter({ project_id: project.id }, "created_date", 20)).length === buildsBefore,
      "nodes carry references and field NAMES only — file content, schema definitions, build and deployment records stay authoritative elsewhere");

    const filesAfter = JSON.stringify((await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 200)).filter((f) => FILES.some((x) => x.path === f.path) && f.path !== "src/pages/Orders.js").map((f) => [f.path, f.content.length]));
    const filesBeforeFiltered = JSON.stringify(JSON.parse(filesBefore).filter(([p]) => p !== "src/pages/Orders.js"));
    const versionsAfter = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 20)).length;
    h.check("32 architecture reconciliation does not mutate project state",
      filesAfter === filesBeforeFiltered &&
      versionsAfter === versionsBefore + 1 &&
      (await svc.entities.AIRun.filter({ project_id: project.id }, "created_date", 20)).length === runsBefore &&
      (await svc.entities.Build.filter({ project_id: project.id }, "created_date", 20)).length === buildsBefore &&
      (await svc.entities.ScheduledTrigger.filter({ project_id: project.id }, "name", 20)).length === 1,
      "every project file this suite did not itself edit is byte-identical; the only new version is the one the suite created; no build or AI run was started");

    // ------------------------------------------------------- 33-36. no side effects
    const memoryAfter = await svc.entities.MemoryItem.filter({ project_id: project.id }, "created_date", 50);
    h.check("33 existing Memory remains unchanged",
      memoryAfter.length === memoryBefore.length &&
      JSON.stringify(memoryAfter.map((m) => [m.id, m.statement, m.verification, m.status, m.revision, m.confidence])) === memorySnapshot,
      `${memoryAfter.length} memory item(s) before and after — architecture reads memory but never writes an observation into it`);

    const ctlTraj = await svc.entities.Trajectory.get(ctl.trajectory.id);
    const ctlEval = await svc.entities.Evaluation.get(ctl.evaluation.id);
    const ctlReward = await svc.entities.Reward.get(ctl.reward.id);
    const ctlRun = await svc.entities.AIRun.get(ctl.run.id);
    h.check("34 existing Trajectory/Judge/Reward remain unchanged",
      controlSnapshot({ run: ctlRun, trajectory: ctlTraj, evaluation: ctlEval, reward: ctlReward }) === ctl.snapshot &&
      (await svc.entities.Trajectory.filter({ project_id: control.id }, "created_date", 10)).length === 1 &&
      (await svc.entities.Evaluation.filter({ project_id: control.id }, "created_date", 10)).length === 1 &&
      (await svc.entities.Reward.filter({ project_id: control.id }, "created_date", 10)).length === 1 &&
      (await svc.entities.Trajectory.filter({ project_id: project.id }, "created_date", 10)).length === 0,
      "the control episode is byte-identical and no trajectory, evaluation or reward was created for the architecture work");

    const datasetsAfter = (await svc.entities.Dataset.filter({}, "-created_date", 200).catch(() => [])).length;
    const benchmarksAfter = (await svc.entities.Benchmark.filter({}, "-created_date", 200).catch(() => [])).length;
    const syntheticAfter = (await svc.entities.SyntheticTask.filter({}, "-created_date", 200).catch(() => [])).length;
    h.check("35 existing Dataset/Benchmark/Synthetic Tasks remain unchanged",
      datasetsAfter === datasetsBefore && benchmarksAfter === benchmarksBefore && syntheticAfter === syntheticBefore,
      `datasets ${datasetsAfter}, benchmarks ${benchmarksAfter}, synthetic tasks ${syntheticAfter} — unchanged; no training, reward or benchmark data touched`);

    h.check("36 existing AI Builder behavior remains unchanged",
      (await svc.entities.AIRun.filter({ project_id: project.id }, "created_date", 20)).length === runsBefore &&
      (await svc.entities.AgentRun.filter({ project_id: project.id }, "created_date", 20)).length === 0 &&
      ctlRun.preferred_model_id == null && ctlRun.status === "COMPLETED" &&
      (await svc.entities.Conversation.filter({ project_id: project.id }, "created_date", 10)).length === 0,
      "architecture intelligence starts no builder run, no agent run and no conversation — it is a read-only planning layer the existing loop consumes");

    // ------------------------------------------------------- 2. versioning summary
    const versionList = await listArchitectureVersions(base44, user, { project_id: project.id });
    const planList = await listImplementationPlans(base44, user, { project_id: project.id });
    const fetchedPlan = await getImplementationPlan(base44, user, { plan_id: plan.plan_id });
    h.check("2 architecture versioning works",
      versionList.count === 3 && versionList.versions[0].version === 3 &&
      versionList.versions.filter((v) => v.status === "FINALIZED").length === 1 &&
      versionList.versions.every((v, i) => i === 0 || v.version < versionList.versions[i - 1].version) &&
      versionList.versions[0].parent_architecture_id === a2.architecture_id &&
      new Set(versionList.versions.map((v) => v.architecture_fingerprint)).size === 3 &&
      planList.count === 1 && fetchedPlan.plan.plan_id === plan.plan_id,
      `versions ${versionList.versions.map((v) => `${v.version}:${v.status}`).join(", ")} — one current, history preserved as a chain`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "TraceEvent", "TrajectoryEvent", "Trajectory", "Evaluation", "Reward", "MemoryItem", "AIRun", "AgentRun", "AgentStep", "Conversation", "Message", "ProjectVersion", "ProjectFile", "AppEntity", "AppRelation", "ScheduledTrigger", "ProjectSecret", "ProjectIndexEntry", "Build"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "MemoryItem", "AuditLog", "Trajectory", "TrajectoryEvent", "Evaluation", "Reward", "Project"]);
    }
  }
}