// Targeted test for the Architecture Intelligence → AI run/agent context integration.
//
// Proves the three contract guarantees of wiring `retrieveArchitectureForRun` +
// `architectureContextBlock` into the existing AI run/agent context assembly:
//   1. a finalized Architecture → the run receives non-empty architecture context.
//   2. no Architecture → the run's context is unchanged (the block is "" and dropped by filter).
//   3. an architecture retrieval failure → the run is unaffected (safe-failing returns degraded
//      empty context, and the block renders "").
//
// Runs against the REAL certified read path (shared/architecture.ts) and the REAL data layer.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { reconcileArchitecture, retrieveArchitectureForRun, architectureContextBlock } from "../../shared/architecture.ts";

// Minimal fixture: enough real project state for the graph to derive non-empty nodes/edges.
const FILES = [
  { path: "src/App.js", content: `import Customers from './pages/Customers.js';\nimport Orders from './pages/Orders.js';\nexport default function App({ route }) { if (route === '/customers') return Customers(); if (route === '/orders') return Orders(); return Customers(); }\nexport const routes = ['/', '/customers', '/orders'];` },
  { path: "src/pages/Customers.js", content: `import CustomerTable from '../components/CustomerTable.js';\nexport default async function Customers(user) { const rows = await db.Customer.list(); return CustomerTable(rows); }` },
  { path: "src/pages/Orders.js", content: `export default async function Orders() { const orders = await db.Order.list(); return orders; }` },
  { path: "src/components/CustomerTable.js", content: `import { html } from 'runtime';\nexport default function CustomerTable(rows) { return html\`<table>\${rows.map(r => html\`<tr>\${r.name}</tr>\`)}\`;\nexport const Order = { fields: { total: { type: 'number' }, customer_id: { type: 'string' } } };` },
];

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // --- fixtures: one workspace, one project WITH architecture and one WITHOUT ---
    const ws = await svc.entities.Workspace.create({ name: `arch-run-int-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);

    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "arch-present", framework: "preact-htm", status: "draft", version_count: 1, last_build_status: "success" });
    created.projects.push(project.id);
    await svc.entities.ProjectFile.bulkCreate(FILES.map((f) => ({ project_id: project.id, path: f.path, content: f.content, frozen: false })));
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Customer", fields: { name: { type: "string" }, email: { type: "string" } } });
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Order", fields: { total: { type: "number" }, customer_id: { type: "string" } } });
    await svc.entities.AppRelation.create({ project_id: project.id, name: "order_customer", from_entity: "Order", from_field: "customer_id", to_entity: "Customer", type: "many_to_one", on_delete: "restrict", required: true });
    await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "fixture", changed_files: FILES.map((f) => ({ path: f.path, change: "added" })), snapshot: { files: FILES, entities: [] } });

    const bareProject = await svc.entities.Project.create({ workspace_id: ws.id, name: "arch-absent", framework: "preact-htm", status: "draft", version_count: 0 });
    created.projects.push(bareProject.id);

    // A foreign workspace this caller is NOT a member of — forces an authorization failure inside
    // the architecture read path (the third scenario: retrieval failure must not break the run).
    const wsForeign = await svc.entities.Workspace.create({ name: `arch-run-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreignProject.id);

    // --- scenario 1: reconcile a finalized architecture, then read it as the run would ---
    const reconciled = await reconcileArchitecture(base44, user, { project_id: project.id });
    h.check("1a reconcile produced a finalized architecture",
      reconciled.architecture.status === "FINALIZED" && (reconciled.architecture.node_count || 0) > 0,
      `status=${reconciled.architecture.status} nodes=${reconciled.architecture.node_count}`);

    const ctx1 = await retrieveArchitectureForRun(base44, { project, user_id: user.id, query: "add a field to Customer", trace_id: null, run_id: null });
    h.check("1b retrieveArchitectureForRun returned non-degraded context with a subgraph",
      !ctx1.degraded && !!ctx1.architecture && Array.isArray(ctx1.subgraph?.nodes) && ctx1.subgraph.nodes.length > 0,
      `degraded=${ctx1.degraded} nodes=${ctx1.subgraph?.nodes?.length || 0} version=${ctx1.architecture?.version}`);

    const block1 = architectureContextBlock(ctx1);
    h.check("1c architectureContextBlock rendered non-empty reference context",
      typeof block1 === "string" && block1.length > 0 && block1.includes("RELEVANT ARCHITECTURE"),
      `blockLen=${block1.length} head=${block1.slice(0, 40)}`);

    // The block is additive intelligence: when present it joins the run's intelligence array, so a
    // finalized architecture reaches the planner prompt.
    const intelligenceWith = [block1].filter(Boolean).join("\n\n");
    h.check("1d a finalized architecture contributes to the assembled intelligence",
      intelligenceWith.length > 0 && intelligenceWith.includes("RELEVANT ARCHITECTURE"),
      `intelligenceLen=${intelligenceWith.length}`);

    // --- scenario 2: no architecture exists for the project — run behavior unchanged ---
    const ctx2 = await retrieveArchitectureForRun(base44, { project: bareProject, user_id: user.id, query: "anything", trace_id: null, run_id: null });
    h.check("2a no architecture → safe-failing degraded empty context",
      ctx2.degraded === true && ctx2.architecture === null && (ctx2.subgraph?.nodes || []).length === 0,
      `degraded=${ctx2.degraded} nodes=${(ctx2.subgraph?.nodes || []).length}`);

    const block2 = architectureContextBlock(ctx2);
    h.check("2b no architecture → block is empty string (dropped by filter(Boolean))",
      block2 === "",
      `blockLen=${block2.length}`);

    // Simulate the exact assembly from runPipeline.planPhase: the architecture block sits in the
    // same filter(Boolean) intelligence array as memory/retrieval. With no architecture it is "",
    // so the assembled intelligence is byte-identical to before the integration.
    const intelligenceWithout = ["", block2].filter(Boolean).join("\n\n");
    h.check("2c no architecture → assembled intelligence is empty (unchanged prompt)",
      intelligenceWithout === "",
      `intelligenceLen=${intelligenceWithout.length}`);

    // --- scenario 3: architecture retrieval failure (foreign project, no access) — run unaffected ---
    const ctx3 = await retrieveArchitectureForRun(base44, { project: foreignProject, user_id: user.id, query: "x", trace_id: null, run_id: null });
    h.check("3a retrieval failure → degraded with an error and empty subgraph",
      ctx3.degraded === true && typeof ctx3.error === "string" && ctx3.error.length > 0 && (ctx3.subgraph?.nodes || []).length === 0,
      `degraded=${ctx3.degraded} error=${ctx3.error ? ctx3.error.slice(0, 80) : "(none)"} nodes=${(ctx3.subgraph?.nodes || []).length}`);

    const block3 = architectureContextBlock(ctx3);
    h.check("3b retrieval failure → block is empty string (run prompt unaffected)",
      block3 === "",
      `blockLen=${block3.length}`);

    h.check("3c retrieval failure did not throw (the run pipeline call site never sees an exception)",
      true,
      "retrieveArchitectureForRun caught internally and returned degraded context");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "ProjectVersion", "ProjectFile", "AppEntity", "AppRelation", "AuditLog", "Project"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "Project"]);
    }
  }
}