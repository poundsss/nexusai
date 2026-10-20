// E2E certification for #27 AI App Primitives — PHASE 2 (capability layer → existing SDK surfaces).
//
// Phase 1 proved the capability layer reasons correctly. Phase 2 proves it RESOLVES to the systems
// that already exist: the generated-app SDK's actors / agents / connectors surfaces, the existing
// app runtime, the existing authorization model and the existing architecture graph.
//
// Everything below runs against real modules over a real project with real declared resources:
//   capability layer .... shared/appPrimitives.ts            (unchanged by Phase 2)
//   sdk adapter ......... shared/appPrimitiveSdk.ts          (the ONLY Phase 2 addition)
//   architecture ........ shared/architecture.ts             (unchanged)
//   actors runtime ...... shared/realtimeRuntime + actorRuntime (the production + builder halves)
//   agents/connectors ... shared/sdkDiscovery.ts             (the deployed discovery surface)
//   resources ........... actor/agent/connector resource contracts
// No mock, no second runtime, no second planner, no second permission system.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  APP_PRIMITIVE_NAMES, APP_PRIMITIVE_MODEL_VERSION, resolveCapability,
  dependencyClosure, selectPrimitives, validateComposition, planPrimitiveExecution,
} from "../../shared/appPrimitives.ts";
import {
  APP_PRIMITIVE_SDK_ADAPTER_VERSION, SDK_SURFACES, EXECUTED_BY,
  describeSdkBindings, resolveSdkBinding, sdkSurfacesFor, bindPlanToSdk,
} from "../../shared/appPrimitiveSdk.ts";
import {
  reconcileArchitecture, retrieveArchitectureContext,
  validatePrimitiveComposition, createPrimitiveExecutionPlan,
} from "../../shared/architecture.ts";
import { handleRealtimeRuntime, REALTIME_OPS } from "../../shared/realtimeRuntime.ts";
import { handleAgentsRuntime, handleConnectorsRuntime, AGENT_OPS, CONNECTOR_OPS } from "../../shared/sdkDiscovery.ts";
import { invokeActor, roomSnapshot } from "../../shared/actorRuntime.ts";
import { collectActors } from "../../shared/actorResource.ts";
import { collectAgents } from "../../shared/agentResource.ts";
import { collectConnectors } from "../../shared/connectorResource.ts";

const AGENT_INSTRUCTIONS = "Answer support questions using only the customer records of this app.";

const FILES = [
  { path: "src/App.js", content: `import Customers from './pages/Customers.js';\nexport default function App(){ return Customers(); }\nexport const routes = ['/', '/customers'];` },
  { path: "src/pages/Customers.js", content: `export default async function Customers() {\n  const rows = await db.Customer.list();\n  await server.syncCustomers({});\n  return rows;\n}` },
  { path: "functions/syncCustomers.js", content: `export default async function handler(ctx) {\n  const rows = await db.Customer.list();\n  const now = await integrations.weather.current({});\n  return { count: rows.length, now };\n}` },
  {
    path: "base44/actors/ChatRoom/entry.ts",
    content: `export const config = { access: "write", persist: true, events: true, description: "Support chat room" };
export default async function (ctx) {
  const count = (ctx.state.count || 0) + 1;
  return { state: { count }, reply: { count }, broadcast: { type: "chat.message", data: { count } } };
}`,
  },
  {
    path: "base44/agents/support.jsonc",
    content: `{\n  "name": "support",\n  "description": "Customer support assistant",\n  "instructions": ${JSON.stringify(AGENT_INSTRUCTIONS)},\n  "tools": []\n}\n`,
  },
  {
    path: "base44/connectors/weather.jsonc",
    content: `{\n  "name": "weather",\n  "description": "Weather lookups",\n  "base_url": "https://api.example.com",\n  "auth": { "type": "api_key", "secret": "WEATHER_KEY", "in": "header", "header_name": "X-Key" },\n  "operations": [{ "name": "current", "method": "GET", "path": "/now" }]\n}\n`,
  },
  {
    path: "integrations/weather.json",
    content: JSON.stringify({
      name: "weather", type: "http", base_url: "https://api.example.com",
      auth: { type: "api_key", secret: "WEATHER_KEY", in: "header", header_name: "X-Key" },
      operations: [{ name: "current", method: "GET", path: "/now" }],
    }, null, 2),
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
    const ws = await svc.entities.Workspace.create({ name: `p2-cert-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    // rls_enabled: the app enforces end-user identity, which is what makes the realtime/discovery
    // identity gate a REAL gate in this certification rather than a dormant branch.
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "p2-owner", framework: "preact-htm", status: "draft", version_count: 1, last_build_status: "success", rls_enabled: true });
    created.projects.push(project.id);
    await svc.entities.ProjectFile.bulkCreate(FILES.map((f) => ({ project_id: project.id, path: f.path, content: f.content, frozen: false })));
    const entities = [{ name: "Customer", fields: { name: { type: "string" }, email: { type: "string" } } }];
    await svc.entities.AppEntity.create({ project_id: project.id, ...entities[0] });
    await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "fixture", changed_files: FILES.map((f) => ({ path: f.path, change: "added" })), snapshot: { files: FILES, entities } });

    const wsForeign = await svc.entities.Workspace.create({ name: `p2-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "p2-foreign", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreignProject.id);

    const filesBefore = JSON.stringify((await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).map((f) => [f.path, f.content.length]));
    const versionsBefore = (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 20)).length;

    // The DEPLOYED artifact payload, built from the project's OWN declared resources through their
    // own resource contracts — the same documents the build validates and ships.
    const actors = collectActors(FILES).actors.map((a) => ({ ...a, source: FILES.find((f) => f.path === a.path).content }));
    const agents = collectAgents(FILES).agents;
    const connectors = collectConnectors(FILES).connectors;
    const payload = { entities, actors, agents, connectors, functions: [], integrations: [] };
    const endUser = { id: `appuser_${Date.now()}`, email: "member@example.com" };

    const traceId = `tr_p2_${Date.now()}`;
    const rec = await reconcileArchitecture(base44, user, { project_id: project.id, trace_id: traceId });
    const arch = rec.architecture;
    const presentTypes = Object.keys((arch.counts || {}).node_types || {});

    // ------------------------------------------------------- 1. adapter covers the catalog exactly
    const adapter = describeSdkBindings();
    h.check("1 the SDK adapter binds every capability and invents no vocabulary",
      adapter.adapter_version === APP_PRIMITIVE_SDK_ADAPTER_VERSION &&
      adapter.model_version === APP_PRIMITIVE_MODEL_VERSION &&
      adapter.binding_count === APP_PRIMITIVE_NAMES.length && adapter.bindings.length === APP_PRIMITIVE_NAMES.length &&
      JSON.stringify(adapter.bindings.map((b) => b.capability)) === JSON.stringify([...APP_PRIMITIVE_NAMES]) &&
      adapter.bindings.every((b) => b.sdk_surface === null || SDK_SURFACES.includes(b.sdk_surface)) &&
      adapter.bindings.every((b) => EXECUTED_BY.includes(b.executed_by)) &&
      // permissions and node types are COPIED from the capability layer, never redefined here
      adapter.bindings.every((b) => JSON.stringify(b.permissions) === JSON.stringify(resolveCapability(b.capability).permissions)) &&
      adapter.bindings.every((b) => b.node_type === resolveCapability(b.capability).node_type),
      `${adapter.binding_count} bindings across ${new Set(adapter.bindings.map((b) => b.sdk_surface)).size} surfaces, permissions inherited from the capability layer`);

    // ------------------------------------------------------- 2. sdk.actors binding
    const actorBinding = resolveSdkBinding("realtime.actor");
    const channelBinding = resolveSdkBinding("realtime.channel");
    h.check("2 realtime capabilities resolve to sdk.actors and the existing realtime contract",
      actorBinding.sdk_surface === "sdk.actors" && actorBinding.runtime_action === "realtime" &&
      JSON.stringify(actorBinding.operations) === JSON.stringify([...REALTIME_OPS]) &&
      actorBinding.executed_by === "app_runtime" && actorBinding.reachable === true &&
      channelBinding.sdk_surface === "sdk.actors" && JSON.stringify(channelBinding.operations) === JSON.stringify([...REALTIME_OPS]),
      `sdk.actors → runtime action 'realtime' with ops ${actorBinding.operations.join(", ")} (imported from the runtime, not restated)`);

    // ------------------------------------------------------- 3. sdk.agents binding
    const agentBindings = ["ai.agent", "ai.skill", "ai.tool"].map(resolveSdkBinding);
    h.check("3 agent capabilities resolve to sdk.agents as discovery over the existing run pipeline",
      agentBindings.every((b) => b.sdk_surface === "sdk.agents" && b.runtime_action === "agents") &&
      agentBindings.every((b) => JSON.stringify(b.operations) === JSON.stringify([...AGENT_OPS])) &&
      agentBindings.every((b) => b.discovery_only === true && b.executed_by === "run_pipeline") &&
      agentBindings.every((b) => b.server_only === true),
      "an agent is discoverable from the app but executed by the existing run pipeline — the adapter never claims the browser runs it");

    // ------------------------------------------------------- 4. sdk.connectors binding
    const connectorBinding = resolveSdkBinding("integration.connector");
    h.check("4 connector capability resolves to sdk.connectors with server-side execution",
      connectorBinding.sdk_surface === "sdk.connectors" && connectorBinding.runtime_action === "connectors" &&
      JSON.stringify(connectorBinding.operations) === JSON.stringify([...CONNECTOR_OPS]) &&
      connectorBinding.discovery_only === true && connectorBinding.server_only === true &&
      resolveSdkBinding("integration.http").sdk_surface === "sdk.functions",
      "discovery on sdk.connectors; the call itself stays in the backend-function runtime where credentials resolve");

    // ------------------------------------------------------- 5. unreachable capabilities are stated
    const unreachable = adapter.bindings.filter((b) => !b.reachable).map((b) => b.capability);
    h.check("5 capabilities a deployed app cannot perform are stated, never mapped to a surface",
      unreachable.includes("logic.workflow") && unreachable.includes("data.migration") && unreachable.includes("integration.secret") &&
      adapter.bindings.filter((b) => !b.reachable).every((b) => b.sdk_surface === null && !!b.executed_by && !!b.note) &&
      resolveSdkBinding("logic.workflow").executed_by === "builder_control_plane",
      `unreachable from the app SDK: ${unreachable.join(", ")} — each naming the system that does execute it`);

    // ------------------------------------------------------- 6. realistic request → SDK surfaces
    const request = "add a realtime chat room for customers, an ai assistant with tools, and a weather connector that uses our api key";
    const selection = selectPrimitives({ request, present_node_types: presentTypes, caller_permissions: ["project.read", "project.write"] });
    const selected = selection.selected.map((s) => s.capability);
    const surfaces = sdkSurfacesFor(selected);
    h.check("6 a realistic generated-app request selects capabilities that resolve to real SDK surfaces",
      selection.unmatched_request === false &&
      selected.includes("realtime.actor") && selected.includes("realtime.channel") &&
      selected.includes("ai.agent") && selected.includes("ai.tool") && selected.includes("integration.connector") &&
      surfaces.includes("sdk.actors") && surfaces.includes("sdk.agents") && surfaces.includes("sdk.connectors") &&
      selection.unpermitted.length === 0,
      `${selected.length} capabilities → ${surfaces.join(", ")}`);

    // ------------------------------------------------------- 7. dependency closure
    const closure = dependencyClosure(["realtime.channel", "ai.tool", "integration.connector"]);
    const at = (n) => closure.order.indexOf(n);
    h.check("7 dependency closure resolves the SDK-backed capabilities in order",
      closure.complete === true &&
      at("realtime.actor") < at("realtime.channel") &&
      at("logic.function") < at("ai.llm") && at("ai.llm") < at("ai.agent") && at("ai.agent") < at("ai.tool") &&
      at("integration.secret") < at("integration.connector") &&
      JSON.stringify(closure) === JSON.stringify(dependencyClosure(["integration.connector", "ai.tool", "realtime.channel"])),
      `${closure.resolved.length} capabilities, prerequisites first, stable under input ordering`);

    // ------------------------------------------------------- 8. valid / invalid composition
    const validComposition = validateComposition({
      capabilities: ["realtime.actor", "realtime.channel", "integration.secret", "integration.connector", "observability.analytics"],
      edges: [
        { from: "realtime.actor", to: "realtime.channel", relationship: "publishes" },
        { from: "integration.secret", to: "integration.connector", relationship: "depends_on" },
        { from: "realtime.channel", to: "observability.analytics", relationship: "publishes" },
      ],
      present_node_types: presentTypes, caller_permissions: ["project.read", "project.write"],
    });
    const invalidClientToServer = validateComposition({ capabilities: ["ui.page", "ui.route", "integration.connector", "integration.secret"], edges: [{ from: "ui.page", to: "integration.connector", relationship: "calls" }] });
    const invalidMissingDep = validateComposition({ capabilities: ["realtime.channel"] });
    h.check("8 a coherent SDK-backed composition validates and an incoherent one is refused",
      validComposition.valid === true && validComposition.error_count === 0 && validComposition.edges.length === 3 &&
      validComposition.existing_capabilities.includes("realtime.actor") &&
      invalidClientToServer.valid === false && invalidClientToServer.errors.some((e) => e.code === "RUNTIME_SURFACE_VIOLATION") &&
      invalidMissingDep.valid === false && invalidMissingDep.errors.some((e) => e.code === "UNSATISFIED_DEPENDENCY" && e.capability === "realtime.actor"),
      "a page may not call a connector directly, and a realtime surface without its actor is refused");

    // ------------------------------------------------------- 9. permission-aware composition
    const readOnly = validateComposition({ capabilities: ["realtime.actor", "integration.secret", "integration.connector"], caller_permissions: ["project.read"] });
    const writer = validateComposition({ capabilities: ["realtime.actor"], caller_permissions: ["project.read", "project.write"] });
    h.check("9 composition is permission-aware using the existing authz capability strings",
      readOnly.valid === false &&
      readOnly.errors.filter((e) => e.code === "PERMISSION_DENIED").length === 3 &&
      readOnly.errors.every((e) => e.code !== "PERMISSION_DENIED" || e.missing_permissions.includes("project.write")) &&
      writer.valid === true &&
      resolveSdkBinding("realtime.actor").permissions.includes("project.write"),
      "a read-only caller cannot compose write capabilities; the adapter reports the same permissions the capability layer declares");

    // ------------------------------------------------------- 10. execution plan → SDK binding
    const plan = planPrimitiveExecution({
      goal: "Add a realtime chat room, a support agent and a weather connector to the existing app",
      capabilities: ["data.entity", "logic.function", "ai.llm", "ai.agent", "realtime.actor", "realtime.channel", "integration.secret", "integration.connector", "ui.route", "ui.page"],
      present_node_types: presentTypes, caller_permissions: ["project.read", "project.write"],
      architecture: { version: arch.version, fingerprint: arch.architecture_fingerprint },
      impact: { risk_level: "medium", verification_surfaces: ["build"] },
    });
    const bound = bindPlanToSdk(plan);
    const refusedBinding = bindPlanToSdk(planPrimitiveExecution({ goal: "x", capabilities: ["realtime.channel"] }));
    h.check("10 an execution plan binds step-by-step to the existing SDK surfaces",
      plan.executable === true && bound.executable === true &&
      bound.step_count === plan.step_count &&
      JSON.stringify(bound.steps.map((s) => s.capability)) === JSON.stringify(plan.steps.map((s) => s.capability)) &&
      bound.steps.every((s) => !!s.sdk && s.sdk.capability === s.capability) &&
      bound.sdk_surfaces.includes("sdk.actors") && bound.sdk_surfaces.includes("sdk.agents") && bound.sdk_surfaces.includes("sdk.connectors") &&
      bound.runtime_actions.includes("realtime") && bound.runtime_actions.includes("agents") && bound.runtime_actions.includes("connectors") &&
      bound.client_steps.includes("ui.page") && bound.server_steps.includes("realtime.actor") &&
      bound.builder_only.some((b) => b.capability === "integration.secret" && b.executed_by === "app_runtime") &&
      // A refused composition binds to nothing at all — never a partial SDK plan.
      refusedBinding.executable === false && refusedBinding.step_count === 0 && refusedBinding.sdk_surfaces.length === 0,
      `${bound.step_count} steps bound to ${bound.sdk_surfaces.join(", ")} via runtime actions ${bound.runtime_actions.join(", ")}`);

    // ------------------------------------------------------- 11. architecture integration
    const context = await retrieveArchitectureContext(base44, user, { project_id: project.id, query: request, trace_id: traceId });
    const archPlan = await createPrimitiveExecutionPlan(base44, user, { project_id: project.id, goal: "add a chat room and a support agent", request, trace_id: traceId });
    const archBound = bindPlanToSdk(archPlan.plan);
    h.check("11 architecture intelligence drives the same capability + SDK resolution",
      !!context.primitives && context.primitives.selected.some((s) => s.capability === "realtime.actor") &&
      archPlan.plan.executable === true && archPlan.architecture.version === arch.version &&
      archPlan.caller_permissions.includes("project.write") &&
      archPlan.present_node_types.includes("actor") && archPlan.present_node_types.includes("agent") && archPlan.present_node_types.includes("connector") &&
      archBound.sdk_surfaces.includes("sdk.actors") &&
      // the project's EXISTING resources are planned as modifications, not as new creations
      archPlan.plan.steps.find((s) => s.capability === "realtime.actor")?.action === "modify" &&
      archPlan.plan.steps.find((s) => s.capability === "ai.agent")?.action === "modify",
      `architecture v${arch.version} exposes ${archPlan.present_node_types.length} node types; the plan binds to ${archBound.sdk_surfaces.join(", ")}`);

    // ------------------------------------------------------- 12. sdk.actors over the real runtime
    const rtList = await handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "list", args: {} });
    const connect = await handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "connect", args: { actor: "ChatRoom", room: "support-1" } });
    const send1 = await handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "send", args: { actor: "ChatRoom", room: "support-1", message: { type: "chat.say", data: { text: "hello" } } } });
    const send2 = await handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "send", args: { actor: "ChatRoom", room: "support-1", message: { type: "chat.say", data: { text: "again" } } } });
    const state = await handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "state", args: { actor: "ChatRoom", room: "support-1" } });
    const events = await handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "events", args: { actor: "ChatRoom", room: "support-1", since: 0 } });
    h.check("12 sdk.actors executes through the existing actor runtime",
      rtList.count === 1 && rtList.actors[0].name === "ChatRoom" &&
      connect.joined === true && send1.ok === true && send2.ok === true &&
      send1.state.count === 1 && send2.state.count === 2 && state.state.count === 2 &&
      send2.seq > send1.seq && state.seq === send2.seq &&
      events.events.length >= 3 && events.events.some((e) => e.type === "chat.message") &&
      state.connections.some((c) => c.participant === `user:${endUser.id}`),
      `room state advanced to ${state.state.count} over ${events.events.length} sequenced events, participant derived from the session`);

    // ------------------------------------------------------- 13. sdk.agents over the real runtime
    const agentList = await handleAgentsRuntime(svc, { project, payload, user: endUser, op: "list", args: {} });
    const agentOne = await handleAgentsRuntime(svc, { project, payload, user: endUser, op: "describe", args: { name: "support" } });
    h.check("13 sdk.agents lists and describes the project's declared agents",
      agentList.count === 1 && agentList.agents[0].name === "support" &&
      agentOne.name === "support" && agentOne.description === "Customer support assistant" &&
      Array.isArray(agentOne.tools) && Array.isArray(agentOne.skills) &&
      // instructions are the agent's server-side behaviour and must never reach the app
      !("instructions" in agentOne) && !JSON.stringify([agentList, agentOne]).includes(AGENT_INSTRUCTIONS),
      "declared agents are discoverable; their instructions never leave the server");

    // ------------------------------------------------------- 14. sdk.connectors over the real runtime
    const connList = await handleConnectorsRuntime(svc, { project, payload, user: endUser, op: "list", args: {} });
    const connOne = await handleConnectorsRuntime(svc, { project, payload, user: endUser, op: "describe", args: { name: "weather" } });
    h.check("14 sdk.connectors lists and describes the project's declared connectors",
      connList.count === 1 && connList.connectors[0].name === "weather" &&
      connOne.name === "weather" && connOne.operations.length === 1 &&
      connOne.operations[0].name === "current" && connOne.operations[0].method === "GET" &&
      !("auth" in connOne) && !("base_url" in connOne),
      "operations are discoverable; the auth block and base URL stay server-side");

    // ------------------------------------------------------- 15. actor/agent/connector authorization
    await h.expectThrow("15 unauthenticated realtime send is refused", () => handleRealtimeRuntime(svc, { project, payload, user: null, op: "send", args: { actor: "ChatRoom", room: "support-1", message: {} } }), "REALTIME_AUTH_REQUIRED");
    await h.expectThrow("15b unauthenticated agent describe is refused", () => handleAgentsRuntime(svc, { project, payload, user: null, op: "describe", args: { name: "support" } }), "AGENT_AUTH_REQUIRED");
    await h.expectThrow("15c unauthenticated connector describe is refused", () => handleConnectorsRuntime(svc, { project, payload, user: null, op: "describe", args: { name: "weather" } }), "CONNECTOR_AUTH_REQUIRED");
    await h.expectThrow("15d an undeclared actor is refused", () => handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "send", args: { actor: "Ghost", room: "r1", message: {} } }), "ACTOR_NOT_FOUND");
    await h.expectThrow("15e an undeclared agent is refused", () => handleAgentsRuntime(svc, { project, payload, user: endUser, op: "describe", args: { name: "ghost" } }), "AGENT_NOT_FOUND");
    await h.expectThrow("15f an undeclared connector is refused", () => handleConnectorsRuntime(svc, { project, payload, user: endUser, op: "describe", args: { name: "ghost" } }), "CONNECTOR_NOT_FOUND");
    await h.expectThrow("15g an operation outside the runtime's vocabulary is refused", () => handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "execute", args: {} }), "REALTIME_BAD_OPERATION");
    await h.expectThrow("15h agents cannot be executed from the discovery surface", () => handleAgentsRuntime(svc, { project, payload, user: endUser, op: "run", args: { name: "support" } }), "AGENTS_BAD_OPERATION");
    await h.expectThrow("15i connectors cannot be called from the discovery surface", () => handleConnectorsRuntime(svc, { project, payload, user: endUser, op: "call", args: { name: "weather" } }), "CONNECTORS_BAD_OPERATION");

    // ------------------------------------------------------- 16. project isolation
    const emptyPayload = { entities: [], actors: [], agents: [], connectors: [] };
    await h.expectThrow("16 another deployment cannot reach this project's actor", () => handleRealtimeRuntime(svc, { project: { ...foreignProject, rls_enabled: true }, payload: emptyPayload, user: endUser, op: "state", args: { actor: "ChatRoom", room: "support-1" } }), "ACTOR_NOT_FOUND");
    await h.expectThrow("16b another deployment cannot reach this project's agent", () => handleAgentsRuntime(svc, { project: foreignProject, payload: emptyPayload, user: endUser, op: "describe", args: { name: "support" } }), "AGENT_NOT_FOUND");
    await h.expectThrow("16c cross-project primitive validation is rejected", () => validatePrimitiveComposition(base44, user, { project_id: foreignProject.id, capabilities: ["realtime.actor"] }), "NOT_A_MEMBER");
    await h.expectThrow("16d cross-project primitive planning is rejected", () => createPrimitiveExecutionPlan(base44, user, { project_id: foreignProject.id, goal: "x", capabilities: ["realtime.actor"] }), "NOT_A_MEMBER");
    const foreignRoom = await roomSnapshot(svc, foreignProject.id, "ChatRoom", "support-1");
    h.check("16e one project's room state is invisible from another project",
      foreignRoom.exists === false && foreignRoom.seq === 0 && JSON.stringify(foreignRoom.state) === "{}" &&
      (await roomSnapshot(svc, project.id, "ChatRoom", "support-1")).state.count === 2,
      "room identity is scoped by project id, so the same actor + room name resolves to nothing in another project");

    // ------------------------------------------------------- 17. credential / secret isolation
    const everythingReturned = JSON.stringify([adapter, selection, plan, bound, archPlan, context.primitives, rtList, agentList, agentOne, connList, connOne, state, events]);
    h.check("17 no credential, secret value or agent instruction is exposed anywhere",
      !everythingReturned.includes(AGENT_INSTRUCTIONS) &&
      !/"secret"\s*:\s*"[^"]/.test(everythingReturned) &&
      !/WEATHER_KEY|X-Key|api\.example\.com/.test(everythingReturned) &&
      // the connector's credential is a NAME in the project's own document and nothing more
      connectors[0].auth.type === "api_key" && connectors[0].auth.secret === "WEATHER_KEY" &&
      !("value" in connectors[0].auth) && !("token" in connectors[0].auth),
      "the capability layer, the adapter and the discovery surfaces are credential-free; a secret exists only as a NAME in the server-side document");

    // ------------------------------------------------------- 18. preview / production parity
    const builderSend = await invokeActor(svc, {
      project, entities, actor: actors[0], source: actors[0].source,
      room: "support-1", message: { type: "chat.say", data: { text: "from the builder" } },
      user: endUser, participant: `user:${endUser.id}`,
    });
    const afterBuilder = await handleRealtimeRuntime(svc, { project, payload, user: endUser, op: "state", args: { actor: "ChatRoom", room: "support-1" } });
    h.check("18 preview and production describe the SAME room through the same contract",
      builderSend.ok === true && builderSend.state.count === 3 &&
      builderSend.room === "support-1" && builderSend.session_id === `ChatRoom:support-1#user:${endUser.id}` &&
      builderSend.session_id === connect.session_id &&
      afterBuilder.state.count === 3 && afterBuilder.seq >= builderSend.seq &&
      // the SDK binding both surfaces resolve through is one binding, not two
      resolveSdkBinding("realtime.actor").runtime_action === "realtime",
      "a builder-side invocation and a production-side invocation continue one room's state, sequence and session identity");

    // ------------------------------------------------------- 19. existing-app change planning
    const changePlan = await createPrimitiveExecutionPlan(base44, user, {
      project_id: project.id, goal: "add a component and analytics to the existing app",
      capabilities: ["ui.route", "ui.page", "ui.component", "observability.analytics"], trace_id: traceId,
    });
    const changeBound = bindPlanToSdk(changePlan.plan);
    h.check("19 planning a change to an EXISTING app distinguishes what is already there",
      changePlan.plan.executable === true &&
      changePlan.plan.steps.find((s) => s.capability === "ui.page").action === "modify" &&
      changePlan.plan.steps.find((s) => s.capability === "ui.component").action === "create" &&
      changePlan.plan.creates.includes("ui.component") && changePlan.plan.modifies.includes("ui.page") &&
      changeBound.client_steps.includes("ui.component") && changeBound.sdk_surfaces.includes("sdk.analytics") &&
      changePlan.impact !== null && !!changePlan.impact.risk_level,
      `existing surfaces are modified and missing ones created; impact risk ${changePlan.impact?.risk_level}`);

    // ------------------------------------------------------- 20. composition → SDK execution
    const realtimeStep = bound.steps.find((s) => s.capability === "realtime.actor");
    h.check("20 a planned capability executes through exactly the contract it was bound to",
      realtimeStep.sdk.runtime_action === "realtime" &&
      realtimeStep.sdk.operations.includes("send") && realtimeStep.sdk.operations.includes("state") &&
      REALTIME_OPS.includes("send") && send2.ok === true && state.state.count === 2 &&
      realtimeStep.verification === "function_execution" &&
      resolveSdkBinding("ai.agent").operations.every((o) => AGENT_OPS.includes(o)) &&
      resolveSdkBinding("integration.connector").operations.every((o) => CONNECTOR_OPS.includes(o)),
      "the op the plan named is the op the existing runtime accepted and executed");

    // ------------------------------------------------------- 21. no side effects on project state
    const filesAfter = JSON.stringify((await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 50)).map((f) => [f.path, f.content.length]));
    h.check("21 capability reasoning and SDK binding mutate no project state",
      filesAfter === filesBefore &&
      (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "number", 20)).length === versionsBefore &&
      (await svc.entities.AIRun.filter({ project_id: project.id }, "created_date", 20)).length === 0 &&
      (await svc.entities.AgentRun.filter({ project_id: project.id }, "created_date", 20)).length === 0 &&
      (await svc.entities.Build.filter({ project_id: project.id }, "created_date", 20)).length === 0 &&
      (await svc.entities.ImplementationPlan.filter({ project_id: project.id }, "-created_date", 20)).length === 0 &&
      (await svc.entities.Architecture.filter({ project_id: project.id }, "-version", 10)).length === 1,
      "no file, version, build, run or stored plan was created — only the actor runtime's own room state changed");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      for (const entity of ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "TraceEvent", "ProjectVersion", "ProjectFile", "AppEntity", "AppRelation", "ProjectIndexEntry", "AppRecord", "Build"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["ArchitectureEdge", "ArchitectureNode", "Architecture", "ImplementationPlan", "AuditLog", "Project"]);
    }
  }
}