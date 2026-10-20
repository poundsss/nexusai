// E2E certification for #27 AI App Primitives — PHASE 1.
//
// Runs against the REAL capability layer (shared/appPrimitives.ts), the REAL Architecture
// Intelligence layer (shared/architecture.ts) and the REAL HTTP endpoint (functions/architecture),
// over a REAL project with real files, entities and a reconciled architecture version.
//
// It proves the capability layer is a reasoning surface over what already exists: the catalog agrees
// with the architecture graph's node vocabulary and the platform's primitive contract, compositions
// are validated rather than assumed, planning refuses an invalid composition instead of emitting a
// partial plan, authorization is the platform's existing project path, and results are deterministic.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  APP_PRIMITIVES, APP_PRIMITIVE_NAMES, APP_PRIMITIVE_MODEL_VERSION, LIFECYCLE_STAGES, RUNTIME_SURFACES,
  PRIMITIVE_OPERATIONS, describeAppPrimitives, resolveCapability, capabilityExists, capabilitiesForNodeType,
  dependencyClosure, selectPrimitives, validateComposition, planPrimitiveExecution, primitiveCapabilityBlock,
} from "../../shared/appPrimitives.ts";
import {
  reconcileArchitecture, retrieveArchitectureContext, architectureContextBlock,
  getPrimitiveCapabilities, validatePrimitiveComposition, createPrimitiveExecutionPlan,
} from "../../shared/architecture.ts";
import { NODE_TYPES, RELATIONSHIP_TYPES } from "../../shared/architectureGraph.ts";
import { PRIMITIVE_NAMES } from "../../shared/primitiveContract.ts";

const FILES = [
  {
    path: "src/App.js",
    content: `import Customers from './pages/Customers.js';
export default function App(){ return Customers(); }
export const routes = ['/', '/customers'];`,
  },
  {
    path: "src/pages/Customers.js",
    content: `export default async function Customers() {
  const rows = await db.Customer.list();
  await server.syncCustomers({});
  return rows;
}`,
  },
  {
    path: "functions/syncCustomers.js",
    content: `export default async function handler(ctx) {
  const rows = await db.Customer.list();
  return { count: rows.length };
}`,
  },
];

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [] };

  // The endpoint is exercised over its REAL HTTP surface with THIS caller's own credentials, so it
  // is certified under exactly the authorization the platform applies in production.
  const callEndpoint = async (body) => {
    try {
      const res = await base44.functions.invoke("architecture", body);
      return { status: res.status || 200, body: res.data ?? res };
    } catch (e) {
      return { status: e.response?.status || e.status || 500, body: e.response?.data || { error: e.message, code: e.code || "ERROR" } };
    }
  };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `prim-cert-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "prim-owner", framework: "preact-htm", status: "draft", version_count: 1, last_build_status: "success" });
    created.projects.push(project.id);
    await svc.entities.ProjectFile.bulkCreate(FILES.map((f) => ({ project_id: project.id, path: f.path, content: f.content, frozen: false })));
    await svc.entities.AppEntity.create({ project_id: project.id, name: "Customer", fields: { name: { type: "string" }, email: { type: "string" } } });
    await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "fixture", changed_files: FILES.map((f) => ({ path: f.path, change: "added" })), snapshot: { files: FILES, entities: [] } });

    // A foreign workspace/project this caller is NOT a member of.
    const wsForeign = await svc.entities.Workspace.create({ name: `prim-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreignProject.id);

    const filesBefore = JSON.stringify((await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).map((f) => [f.path, f.content.length]));
    const versionsBefore = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 20)).length;
    const runsBefore = (await svc.entities.AIRun.filter({ project_id: project.id }, "created_date", 20)).length;

    const traceId = `tr_prim_${Date.now()}`;
    const rec = await reconcileArchitecture(base44, user, { project_id: project.id, trace_id: traceId });
    const arch = rec.architecture;

    // ------------------------------------------------------- 1. catalog integrity
    const model = describeAppPrimitives();
    const stageCoverage = new Set(APP_PRIMITIVES.map((c) => c.stage));
    h.check("1 capability catalog exposes exactly 26 capabilities",
      APP_PRIMITIVES.length === 26 && APP_PRIMITIVE_NAMES.length === 26 &&
      model.capability_count === 26 && model.capabilities.length === 26 &&
      new Set(APP_PRIMITIVE_NAMES).size === 26 &&
      model.model_version === APP_PRIMITIVE_MODEL_VERSION &&
      stageCoverage.size === LIFECYCLE_STAGES.length &&
      APP_PRIMITIVES.every((c) => !!c.title && !!c.summary && c.operations.length > 0) &&
      JSON.stringify(APP_PRIMITIVE_NAMES) === JSON.stringify([...APP_PRIMITIVE_NAMES].sort()),
      `26 capabilities across ${stageCoverage.size} lifecycle stages, deterministically ordered`);

    // ------------------------------------------------------- 2. contract validity
    const knownPermissions = ["project.read", "project.write", "deploy.manage"];
    h.check("2 every capability maps to a real node type and a real platform contract",
      APP_PRIMITIVES.every((c) => NODE_TYPES.includes(c.node_type)) &&
      APP_PRIMITIVES.every((c) => c.platform_primitives.every((p) => PRIMITIVE_NAMES.includes(p))) &&
      APP_PRIMITIVES.every((c) => c.accepts_from.every((r) => RELATIONSHIP_TYPES.includes(r))) &&
      APP_PRIMITIVES.every((c) => c.permissions.every((p) => knownPermissions.includes(p))) &&
      APP_PRIMITIVES.every((c) => RUNTIME_SURFACES.includes(c.surface) && LIFECYCLE_STAGES.includes(c.stage)) &&
      APP_PRIMITIVES.every((c) => c.operations.every((o) => PRIMITIVE_OPERATIONS.includes(o))) &&
      APP_PRIMITIVES.every((c) => c.depends_on.every((d) => APP_PRIMITIVE_NAMES.includes(d))) &&
      capabilitiesForNodeType("entity").includes("data.entity") && capabilityExists("ai.agent") && !capabilityExists("ai.nope") &&
      APP_PRIMITIVES.some((c) => c.platform_primitives.length > 0),
      "node types come from the architecture graph, primitive names from the platform primitive contract, permissions from authz — no new vocabulary");

    // ------------------------------------------------------- 3. dependency closure
    const closure = dependencyClosure(["ai.skill", "data.rls"]);
    const orderOf = (n) => closure.order.indexOf(n);
    h.check("3 dependency closure resolves transitively in deterministic order",
      closure.complete === true && closure.resolved.includes("ai.agent") && closure.resolved.includes("ai.llm") &&
      closure.resolved.includes("logic.function") && closure.resolved.includes("auth.users") && closure.resolved.includes("data.entity") &&
      closure.transitive.includes("ai.llm") && closure.transitive.includes("data.entity") &&
      orderOf("logic.function") < orderOf("ai.llm") && orderOf("ai.llm") < orderOf("ai.agent") && orderOf("ai.agent") < orderOf("ai.skill") &&
      orderOf("data.entity") < orderOf("data.rls") && orderOf("auth.users") < orderOf("data.rls") &&
      JSON.stringify(closure) === JSON.stringify(dependencyClosure(["data.rls", "ai.skill"])),
      `${closure.resolved.length} capabilities, prerequisites always before their dependents, stable under input ordering`);

    // ------------------------------------------------------- 4. unresolved dependencies
    const unresolved = dependencyClosure(["data.entity", "not.a.capability", "ai.ghost"]);
    h.check("4 unresolved capabilities are reported, never silently dropped",
      unresolved.complete === false && unresolved.unresolved.length === 2 &&
      unresolved.unresolved.includes("not.a.capability") && unresolved.unresolved.includes("ai.ghost") &&
      unresolved.resolved.includes("data.entity") && !unresolved.resolved.includes("ai.ghost"),
      `unresolved: ${unresolved.unresolved.join(", ")} — the known capability still resolves`);

    // ------------------------------------------------------- 5. cycle detection
    const acyclic = APP_PRIMITIVE_NAMES.every((n) => dependencyClosure([n]).cycles.length === 0);
    const fullClosure = dependencyClosure(APP_PRIMITIVE_NAMES);
    const selfEdge = validateComposition({ capabilities: ["data.entity"], edges: [{ from: "data.entity", to: "data.entity", relationship: "depends_on" }] });
    h.check("5 cycles are detected and reported explicitly",
      acyclic && Array.isArray(fullClosure.cycles) && fullClosure.cycles.length === 0 &&
      fullClosure.order.length === 26 && fullClosure.complete === true &&
      selfEdge.valid === false && selfEdge.errors.some((e) => e.code === "SELF_REFERENCE"),
      "the real catalog is provably acyclic (cycles reported as an empty set, not assumed), and a self-referencing composition is refused");

    // ------------------------------------------------------- 6. primitive selection
    const presentTypes = Object.keys((arch.counts || {}).node_types || {});
    const selection = selectPrimitives({ request: "add an ai agent that summarizes customer records on a schedule", present_node_types: presentTypes, caller_permissions: ["project.read", "project.write"] });
    const names = selection.selected.map((s) => s.capability);
    h.check("6 primitive selection maps a request to capabilities",
      names.includes("ai.agent") && names.includes("ai.llm") && names.includes("logic.function") &&
      names.includes("logic.scheduled") && names.includes("data.entity") &&
      selection.selected.find((s) => s.capability === "ai.agent").reason === "requested" &&
      selection.selected.find((s) => s.capability === "logic.function").reason === "dependency" &&
      selection.selected.find((s) => s.capability === "data.entity").exists_in_project === true &&
      selection.selected.find((s) => s.capability === "ai.agent").exists_in_project === false &&
      selection.new_capabilities.includes("ai.agent") && selection.existing_capabilities.includes("data.entity") &&
      selection.unmatched_request === false && selection.unpermitted.length === 0 &&
      selectPrimitives({ request: "xyzzy nothing here" }).unmatched_request === true,
      `${names.length} capabilities selected and marked against the project's real ${presentTypes.length} node types; an unmatched request selects nothing`);

    // ------------------------------------------------------- 7. valid composition
    // Every edge is IO-compatible under the capability layer's OWN data-flow contract, so this is a
    // genuinely coherent composition rather than a relaxed one: schema→schema into the entity,
    // record→record into the page, and reference-carrying interface edges.
    const valid = validateComposition({
      capabilities: ["data.entity", "data.migration", "ui.route", "ui.page", "ui.component"],
      edges: [
        { from: "data.migration", to: "data.entity", relationship: "writes" },
        { from: "data.entity", to: "ui.page", relationship: "reads" },
        { from: "ui.component", to: "ui.page", relationship: "renders" },
        { from: "ui.page", to: "ui.route", relationship: "depends_on" },
      ],
      present_node_types: presentTypes, caller_permissions: ["project.read", "project.write"],
    });
    h.check("7 a coherent composition validates",
      valid.valid === true && valid.error_count === 0 && valid.edges.length === 4 &&
      valid.closure.complete === true && valid.required_permissions.includes("project.write") &&
      // Capabilities the fixture project really has are reported as existing; one it does not have
      // (no component file) is reported as new — the existing/new split is real, not assumed.
      valid.existing_capabilities.includes("data.entity") && valid.existing_capabilities.includes("ui.page") &&
      valid.existing_capabilities.includes("ui.route") && valid.new_capabilities.includes("ui.component") &&
      presentTypes.includes("entity") && presentTypes.includes("page") && !presentTypes.includes("component"),
      `5 capabilities + 4 relationships accepted with ${valid.warning_count} warning(s); existing ${valid.existing_capabilities.length}, new ${valid.new_capabilities.length}`);

    // ------------------------------------------------------- 8. invalid composition
    const invalidUnknown = validateComposition({ capabilities: ["data.entity", "made.up"] });
    const invalidDep = validateComposition({ capabilities: ["ai.skill"] });
    const invalidRel = validateComposition({ capabilities: ["data.entity", "logic.function"], edges: [{ from: "logic.function", to: "data.entity", relationship: "teleports_to" }] });
    const invalidShape = validateComposition({ capabilities: ["data.entity", "auth.roles", "auth.users"], edges: [{ from: "data.entity", to: "auth.roles", relationship: "renders" }] });
    const invalidSurface = validateComposition({ capabilities: ["ui.page", "ui.route", "integration.http", "logic.function"], edges: [{ from: "ui.page", to: "integration.http", relationship: "calls" }] });
    const invalidOutside = validateComposition({ capabilities: ["data.entity"], edges: [{ from: "data.entity", to: "ai.agent", relationship: "calls" }] });
    h.check("8 an invalid composition is refused with a stated reason",
      invalidUnknown.valid === false && invalidUnknown.errors.some((e) => e.code === "UNKNOWN_CAPABILITY") &&
      invalidDep.valid === false && invalidDep.errors.some((e) => e.code === "UNSATISFIED_DEPENDENCY" && e.capability === "ai.agent") &&
      invalidRel.valid === false && invalidRel.errors.some((e) => e.code === "INVALID_RELATIONSHIP") &&
      invalidShape.valid === false && invalidShape.errors.some((e) => e.code === "INCOMPATIBLE_COMPOSITION") &&
      invalidSurface.valid === false && invalidSurface.errors.some((e) => e.code === "RUNTIME_SURFACE_VIOLATION") &&
      invalidOutside.valid === false && invalidOutside.errors.some((e) => e.code === "EDGE_OUTSIDE_COMPOSITION") &&
      validateComposition({ capabilities: [] }).errors.some((e) => e.code === "EMPTY_COMPOSITION"),
      "unknown capability, unsatisfied prerequisite, invalid relationship, incompatible composition, client→server violation, edge outside the composition, empty composition");

    // ------------------------------------------------------- 9. permission rejection
    const readOnly = validateComposition({ capabilities: ["data.entity", "logic.function"], caller_permissions: ["project.read"] });
    const readOnlySelection = selectPrimitives({ request: "add an entity", caller_permissions: ["project.read"] });
    const permitted = validateComposition({ capabilities: ["data.entity"], caller_permissions: ["project.read", "project.write"] });
    h.check("9 a capability the caller may not use is rejected",
      readOnly.valid === false &&
      readOnly.errors.filter((e) => e.code === "PERMISSION_DENIED").length === 2 &&
      readOnly.errors.every((e) => e.code !== "PERMISSION_DENIED" || e.missing_permissions.includes("project.write")) &&
      readOnlySelection.unpermitted.some((u) => u.capability === "data.entity") &&
      permitted.valid === true,
      "project.write capabilities are refused for a read-only caller and accepted for a writer — the check uses the existing authz capability strings");

    // ------------------------------------------------------- 10. execution-plan ordering
    const plan = planPrimitiveExecution({
      goal: "Add an AI agent over customers with a page to view results",
      capabilities: ["data.entity", "logic.function", "ai.llm", "ai.agent", "ui.route", "ui.page", "auth.users", "data.rls"],
      present_node_types: presentTypes, caller_permissions: ["project.read", "project.write"],
      architecture: { version: arch.version, fingerprint: arch.architecture_fingerprint },
      impact: { risk_level: "medium", verification_surfaces: ["build"] },
    });
    const stepAt = (n) => plan.steps.findIndex((s) => s.capability === n);
    h.check("10 execution planning orders steps by dependency and lifecycle",
      plan.executable === true && plan.step_count === 8 &&
      plan.steps.every((s, i) => s.order === i + 1) &&
      stepAt("data.entity") < stepAt("data.rls") && stepAt("auth.users") < stepAt("data.rls") &&
      stepAt("logic.function") < stepAt("ai.llm") && stepAt("ai.llm") < stepAt("ai.agent") &&
      stepAt("ai.agent") < stepAt("ui.page") && stepAt("ui.route") < stepAt("ui.page") &&
      plan.steps.find((s) => s.capability === "data.entity").action === "modify" &&
      plan.steps.find((s) => s.capability === "ai.agent").action === "create" &&
      plan.steps.every((s) => !!s.implemented_by && !!s.verification && s.permissions.length > 0) &&
      plan.risk_level === "medium" && plan.verification_surfaces.includes("build") &&
      plan.architecture.fingerprint === arch.architecture_fingerprint,
      `${plan.step_count} ordered steps (${plan.steps.map((s) => s.capability).join(" → ")}), each naming the existing system that implements it`);

    // ------------------------------------------------------- 11. invalid composition refuses planning
    const refusedPlan = planPrimitiveExecution({ goal: "impossible", capabilities: ["ai.skill", "made.up"], caller_permissions: ["project.read"] });
    h.check("11 an invalid composition produces no plan at all",
      refusedPlan.executable === false && refusedPlan.composition_valid === false &&
      refusedPlan.steps.length === 0 && refusedPlan.step_count === 0 &&
      refusedPlan.errors.length > 0 && refusedPlan.errors.some((e) => e.code === "UNKNOWN_CAPABILITY"),
      "planning refuses rather than emitting a partial or speculative plan");

    // ------------------------------------------------------- 12. architecture context
    const context = await retrieveArchitectureContext(base44, user, { project_id: project.id, query: "add a page that lists customers and an ai summary", trace_id: traceId });
    const block = architectureContextBlock(context);
    h.check("12 architecture context exposes the selected primitives",
      !!context.primitives && context.primitives.selected.length > 0 &&
      context.primitives.model_version === APP_PRIMITIVE_MODEL_VERSION &&
      context.primitives.selected.some((s) => s.capability === "ui.page") &&
      context.primitives.selected.some((s) => s.capability === "ai.llm") &&
      context.primitives.selected.some((s) => s.exists_in_project === true) &&
      context.primitives.closure.order.length === context.primitives.selected.length &&
      block.includes("PLATFORM CAPABILITIES RELEVANT TO THIS REQUEST") &&
      block.includes("reference data only") && block.includes("DEPENDENCY ORDER") &&
      block.includes("RELEVANT ARCHITECTURE") &&
      primitiveCapabilityBlock({ selected: [] }) === "",
      `context carries ${context.primitives.selected.length} capabilities and renders them as reference data beside the subgraph`);

    // ------------------------------------------------------- 13. endpoint catalog
    const epCatalog = await callEndpoint({ action: "primitive_capabilities" });
    const epOne = await callEndpoint({ action: "primitive_capabilities", capability: "ai.agent" });
    const epBad = await callEndpoint({ action: "primitive_capabilities", capability: "nope" });
    const epGraph = await callEndpoint({ action: "capabilities" });
    h.check("13 endpoint publishes the primitive catalog",
      epCatalog.status === 200 && epCatalog.body.capability_count === 26 && epCatalog.body.capabilities.length === 26 &&
      epOne.status === 200 && epOne.body.capability.name === "ai.agent" && epOne.body.closure.resolved.includes("ai.llm") &&
      epBad.status === 404 && epBad.body.code === "CAPABILITY_NOT_FOUND" &&
      epGraph.status === 200 && epGraph.body.node_types.length === NODE_TYPES.length &&
      JSON.stringify(epCatalog.body) === JSON.stringify(getPrimitiveCapabilities({})) &&
      // Contract metadata only: capability names may mention secrets as a CAPABILITY, but no
      // credential value, token shape or authorization header may appear in the published catalog.
      !/sk_live|sk_test|Bearer\s|authorization|"value"/i.test(JSON.stringify(epCatalog.body)),
      "contract metadata only, an unknown capability is a 404, and the pre-existing graph capabilities action still answers unchanged");

    // ------------------------------------------------------- 14. endpoint validation
    const epValid = await callEndpoint({ action: "validate_primitives", project_id: project.id, capabilities: ["data.entity", "data.migration"], edges: [{ from: "data.migration", to: "data.entity", relationship: "writes" }] });
    const epInvalid = await callEndpoint({ action: "validate_primitives", project_id: project.id, capabilities: ["ai.skill"] });
    h.check("14 endpoint validates a composition against the real project",
      epValid.status === 200 && epValid.body.composition.valid === true &&
      epValid.body.project_id === project.id && epValid.body.architecture.version === arch.version &&
      epValid.body.caller_permissions.includes("project.write") &&
      epValid.body.present_node_types.includes("entity") && epValid.body.selection.selected.length >= 1 &&
      epValid.body.composition.existing_capabilities.includes("data.entity") &&
      epInvalid.status === 200 && epInvalid.body.composition.valid === false &&
      epInvalid.body.composition.errors.some((e) => e.code === "UNSATISFIED_DEPENDENCY"),
      "validation runs against the project's stored architecture and the caller's real authz capabilities");

    // ------------------------------------------------------- 15. endpoint planning
    const epPlan = await callEndpoint({ action: "plan_primitives", project_id: project.id, goal: "add an ai summary of customers", capabilities: ["data.entity", "logic.function", "ai.llm"] });
    const epPlanRequest = await callEndpoint({ action: "plan_primitives", project_id: project.id, request: "add an entity and a page for it" });
    const epUnknown = await callEndpoint({ action: "plan_primitives_v2", project_id: project.id });
    h.check("15 endpoint generates a primitive execution plan",
      epPlan.status === 200 && epPlan.body.plan.executable === true && epPlan.body.plan.step_count === 3 &&
      epPlan.body.plan.steps[0].order === 1 && epPlan.body.plan.dependency_order.length === 3 &&
      epPlan.body.architecture.fingerprint === arch.architecture_fingerprint &&
      epPlanRequest.status === 200 && epPlanRequest.body.plan.executable === true &&
      epPlanRequest.body.selection.selected.some((s) => s.capability === "ui.page") &&
      epUnknown.status === 400 && epUnknown.body.code === "UNKNOWN_ACTION",
      `${epPlan.body.plan.step_count} steps from an explicit capability set and a plan derived from a plain request; unknown actions still rejected`);

    // ------------------------------------------------------- 16. authorization isolation
    await h.expectThrow("16 cross-project validation is rejected", () => validatePrimitiveComposition(base44, user, { project_id: foreignProject.id, capabilities: ["data.entity"] }), "NOT_A_MEMBER");
    await h.expectThrow("16b cross-project planning is rejected", () => createPrimitiveExecutionPlan(base44, user, { project_id: foreignProject.id, goal: "x", capabilities: ["data.entity"] }), "NOT_A_MEMBER");
    await h.expectThrow("16c unauthenticated validation is rejected", () => validatePrimitiveComposition(base44, null, { project_id: project.id, capabilities: ["data.entity"] }), "AUTH_REQUIRED");
    await h.expectThrow("16d unauthenticated planning is rejected", () => createPrimitiveExecutionPlan(base44, { id: null }, { project_id: project.id, goal: "x" }), "AUTH_REQUIRED");
    const epForeign = await callEndpoint({ action: "validate_primitives", project_id: foreignProject.id, capabilities: ["data.entity"] });
    const epForeignPlan = await callEndpoint({ action: "plan_primitives", project_id: foreignProject.id, goal: "x", capabilities: ["data.entity"] });
    h.check("16e endpoint enforces the same project isolation",
      epForeign.status === 403 && epForeign.body.code === "NOT_A_MEMBER" &&
      epForeignPlan.status === 403 && epForeignPlan.body.code === "NOT_A_MEMBER" &&
      !JSON.stringify([epForeign.body, epForeignPlan.body]).includes(foreignProject.name),
      "another workspace's project is refused over HTTP with no project data leaked");

    // ------------------------------------------------------- 17. determinism
    const selA = selectPrimitives({ request: "add an ai agent with tools over entities", present_node_types: presentTypes, caller_permissions: ["project.read", "project.write"] });
    const selB = selectPrimitives({ request: "add an ai agent with tools over entities", present_node_types: [...presentTypes].reverse(), caller_permissions: ["project.write", "project.read"] });
    const planA = planPrimitiveExecution({ goal: "g", capabilities: ["ai.tool", "data.entity", "ui.page"], present_node_types: presentTypes });
    const planB = planPrimitiveExecution({ goal: "g", capabilities: ["ui.page", "data.entity", "ai.tool"], present_node_types: presentTypes });
    const epAgain = await callEndpoint({ action: "primitive_capabilities" });
    h.check("17 selection, validation and planning are deterministic",
      JSON.stringify(selA.selected) === JSON.stringify(selB.selected) &&
      JSON.stringify(selA.closure.order) === JSON.stringify(selB.closure.order) &&
      JSON.stringify(planA.steps) === JSON.stringify(planB.steps) &&
      JSON.stringify(planA.dependency_order) === JSON.stringify(planB.dependency_order) &&
      JSON.stringify(validateComposition({ capabilities: ["data.entity", "logic.function"] })) === JSON.stringify(validateComposition({ capabilities: ["logic.function", "data.entity"] })) &&
      JSON.stringify(epAgain.body) === JSON.stringify(epCatalog.body),
      "identical inputs in any order produce byte-identical selections, verdicts, plans and catalog output");

    // ------------------------------------------------------- 18. no side effects
    const filesAfter = JSON.stringify((await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).map((f) => [f.path, f.content.length]));
    h.check("18 the capability layer mutates nothing",
      filesAfter === filesBefore &&
      (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 20)).length === versionsBefore &&
      (await svc.entities.AIRun.filter({ project_id: project.id }, "created_date", 20)).length === runsBefore &&
      (await svc.entities.AgentRun.filter({ project_id: project.id }, "created_date", 20)).length === 0 &&
      (await svc.entities.Build.filter({ project_id: project.id }, "created_date", 20)).length === 0 &&
      (await svc.entities.ImplementationPlan.filter({ project_id: project.id }, "-created_date", 20)).length === 0 &&
      (await svc.entities.Architecture.filter({ project_id: project.id }, "-version", 10)).length === 1,
      "no file, version, build, AI/agent run or stored plan was created — capability reasoning is read-only");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "TraceEvent", "ProjectVersion", "ProjectFile", "AppEntity", "AppRelation", "ProjectIndexEntry", "Build"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "AuditLog", "Project"]);
    }
  }
}