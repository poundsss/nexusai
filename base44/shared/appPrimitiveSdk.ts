// #27 Phase 2 — THE SDK ADAPTER for AI App Primitives.
//
// One job, and nothing else: say WHICH already-existing generated-app SDK surface and runtime
// contract each capability of the #27 catalog resolves to, so an AI execution plan can be handed to
// the platform's EXISTING execution systems instead of to something new.
//
//   capability (shared/appPrimitives.ts)
//     → sdk surface (sdk.entities / sdk.auth / sdk.files / sdk.functions / sdk.analytics /
//                    sdk.actors / sdk.agents / sdk.connectors / the client bundle)
//     → the EXISTING appRuntime action + the EXISTING runtime's own operation vocabulary
//
// WHAT THIS IS NOT. It is not a runtime, a planner, a validator, an SDK or a permission system, and
// it owns no state. Every operation list below is IMPORTED from the runtime that already defines it,
// so this file cannot drift into a second contract:
//   rooms / state / events / presence .. shared/realtimeRuntime.ts (REALTIME_OPS)
//   agent + connector discovery ....... shared/sdkDiscovery.ts (AGENT_OPS / CONNECTOR_OPS)
//   data / auth / files / functions ... the appRuntime actions those surfaces already answer on
//   authorization ..................... shared/authz + shared/rbac, unchanged — nothing here grants
//                                      anything, and no capability's permissions are redefined
//
// Pure and synchronous: no I/O, no credentials, no secrets. A capability that is NOT reachable from a
// deployed app's SDK says so explicitly (`reachable: false` plus the system that does execute it)
// rather than being mapped to a surface it does not have.
import { APP_PRIMITIVE_NAMES, APP_PRIMITIVE_MODEL_VERSION, resolveCapability } from "./appPrimitives.ts";
import { REALTIME_OPS } from "./realtimeRuntime.ts";
import { AGENT_OPS, CONNECTOR_OPS } from "./sdkDiscovery.ts";

export const APP_PRIMITIVE_SDK_ADAPTER_VERSION = "1.0.0";

/** The generated-app SDK surfaces. `app.client` is the shipped bundle, not a server namespace. */
export const SDK_SURFACES = [
  "sdk.entities", "sdk.auth", "sdk.files", "sdk.functions", "sdk.analytics",
  "sdk.actors", "sdk.agents", "sdk.connectors", "app.client",
];

/** Who actually executes a capability. Each value names a system that ALREADY exists. */
export const EXECUTED_BY = ["app_runtime", "client_bundle", "run_pipeline", "builder_control_plane"];

const deepFreeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
};
const uniq = (a) => [...new Set(a)].sort();
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }); };

// Data / auth / file / function / analytics surfaces answer on the appRuntime actions they already
// own; their operation vocabularies live in that runtime and are referenced, never restated here.
const DATA = { surface: "sdk.entities", runtime_action: "db", executed_by: "app_runtime" };
const AUTH = { surface: "sdk.auth", runtime_action: "auth", executed_by: "app_runtime" };
const FN = { surface: "sdk.functions", runtime_action: "fn", executed_by: "app_runtime" };
const CLIENT = { surface: "app.client", runtime_action: null, executed_by: "client_bundle" };

const BINDINGS = {
  // --- data
  "data.entity": { ...DATA },
  "data.relationship": { ...DATA },
  "data.rls": { ...DATA, note: "enforced inside the existing server data accessor, never by the app" },
  "data.migration": { surface: null, runtime_action: null, executed_by: "builder_control_plane", note: "a schema change is a builder mutation; a deployed app never migrates itself" },
  "data.storage": { surface: "sdk.files", runtime_action: "files", executed_by: "app_runtime" },
  // --- auth
  "auth.users": { ...AUTH },
  "auth.roles": { ...AUTH, note: "permission evaluation stays server-side (auth 'can')" },
  "auth.session": { ...AUTH },
  // --- logic
  "logic.function": { ...FN },
  "logic.webhook": { surface: "sdk.functions", runtime_action: "fn", executed_by: "app_runtime", note: "inbound delivery arrives through the existing webhook endpoint" },
  "logic.scheduled": { surface: "sdk.functions", runtime_action: "fn", executed_by: "app_runtime", note: "fired by the existing scheduler, not by the app" },
  "logic.workflow": { surface: null, runtime_action: null, executed_by: "builder_control_plane", note: "orchestrated by the existing workflow engine" },
  // --- intelligence
  "ai.llm": { ...FN, note: "reached from server code through the existing primitive contract" },
  "ai.image": { ...FN, note: "reached from server code through the existing primitive contract" },
  "ai.agent": { surface: "sdk.agents", runtime_action: "agents", operations: AGENT_OPS, executed_by: "run_pipeline", discovery_only: true },
  "ai.skill": { surface: "sdk.agents", runtime_action: "agents", operations: AGENT_OPS, executed_by: "run_pipeline", discovery_only: true, note: "declared skills are listed on the agent projection" },
  "ai.tool": { surface: "sdk.agents", runtime_action: "agents", operations: AGENT_OPS, executed_by: "run_pipeline", discovery_only: true, note: "granted tool names only; the E10 gate still decides" },
  // --- integration
  "integration.connector": { surface: "sdk.connectors", runtime_action: "connectors", operations: CONNECTOR_OPS, executed_by: "app_runtime", discovery_only: true, note: "callable only from the existing backend-function runtime, where credentials resolve server-side" },
  "integration.http": { ...FN, note: "called from server code through the existing integration runtime" },
  "integration.secret": { surface: null, runtime_action: null, executed_by: "app_runtime", note: "a NAME reference resolved inside the server executor; never reachable from a client" },
  // --- realtime
  "realtime.actor": { surface: "sdk.actors", runtime_action: "realtime", operations: REALTIME_OPS, executed_by: "app_runtime" },
  "realtime.channel": { surface: "sdk.actors", runtime_action: "realtime", operations: REALTIME_OPS, executed_by: "app_runtime" },
  // --- interface
  "ui.route": { ...CLIENT },
  "ui.page": { ...CLIENT },
  "ui.component": { ...CLIENT },
  // --- observability
  "observability.analytics": { surface: "sdk.analytics", runtime_action: "analytics", executed_by: "app_runtime" },
};

// Integrity: the adapter must cover the catalog EXACTLY — no capability left unmapped, no binding
// for a capability that does not exist, no surface or executor outside the declared vocabularies.
for (const name of APP_PRIMITIVE_NAMES) {
  if (!BINDINGS[name]) throw new Error(`appPrimitiveSdk: capability '${name}' has no SDK binding`);
}
for (const [name, b] of Object.entries(BINDINGS)) {
  if (!APP_PRIMITIVE_NAMES.includes(name)) throw new Error(`appPrimitiveSdk: binding for unknown capability '${name}'`);
  if (b.surface !== null && !SDK_SURFACES.includes(b.surface)) throw new Error(`appPrimitiveSdk: '${name}' names unknown SDK surface '${b.surface}'`);
  if (!EXECUTED_BY.includes(b.executed_by)) throw new Error(`appPrimitiveSdk: '${name}' names unknown executor '${b.executed_by}'`);
}

/** One capability's binding, as reference data. `reachable` is never assumed — it is stated. */
const view = (name) => {
  const c = resolveCapability(name);
  const b = BINDINGS[name];
  return deepFreeze({
    capability: name,
    sdk_surface: b.surface,
    runtime_action: b.runtime_action,
    operations: b.operations ? [...b.operations] : [],
    executed_by: b.executed_by,
    // Reachable = a deployed app's SDK can address this surface at all. A builder-only capability is
    // false, so a plan can never claim the app itself will perform it.
    reachable: b.surface !== null,
    discovery_only: !!b.discovery_only,
    server_only: c.surface === "server",
    runtime_surface: c.surface,
    node_type: c.node_type,
    permissions: [...c.permissions],
    platform_primitives: [...c.platform_primitives],
    note: b.note || null,
  });
};

const VIEWS = deepFreeze(Object.fromEntries(APP_PRIMITIVE_NAMES.map((n) => [n, view(n)])));

export function resolveSdkBinding(name) {
  const found = VIEWS[String(name)];
  if (!found) fail("SDK_BINDING_NOT_FOUND", `No SDK binding for capability '${name}'`, 404);
  return found;
}

/** Credential-free description of the whole adapter. */
export const describeSdkBindings = () => ({
  adapter_version: APP_PRIMITIVE_SDK_ADAPTER_VERSION,
  model_version: APP_PRIMITIVE_MODEL_VERSION,
  surfaces: [...SDK_SURFACES],
  executors: [...EXECUTED_BY],
  binding_count: APP_PRIMITIVE_NAMES.length,
  bindings: APP_PRIMITIVE_NAMES.map((n) => VIEWS[n]),
});

/** The SDK surfaces a capability set touches, deterministically ordered. */
export const sdkSurfacesFor = (capabilities = []) =>
  uniq((capabilities || []).filter((c) => VIEWS[String(c)]).map((c) => VIEWS[String(c)].sdk_surface).filter(Boolean));

/**
 * Annotates an EXISTING execution plan (from appPrimitives.planPrimitiveExecution) with the SDK
 * surface each step resolves to. It returns a NEW object: the plan's own steps, order, verdicts and
 * errors are copied through untouched, because this adapter does not plan — it only binds.
 *
 * An unexecutable plan is bound to nothing at all, so a refused composition can never be presented
 * as something the SDK is about to run.
 */
export function bindPlanToSdk(plan) {
  const steps = plan?.executable ? (plan.steps || []) : [];
  const bound = steps.map((s) => ({ ...s, sdk: resolveSdkBinding(s.capability) }));
  return {
    adapter_version: APP_PRIMITIVE_SDK_ADAPTER_VERSION,
    executable: !!plan?.executable,
    step_count: bound.length,
    steps: bound,
    sdk_surfaces: uniq(bound.map((s) => s.sdk.sdk_surface).filter(Boolean)),
    runtime_actions: uniq(bound.map((s) => s.sdk.runtime_action).filter(Boolean)),
    // Steps the deployed app cannot perform itself, each naming the system that does.
    builder_only: bound.filter((s) => !s.sdk.reachable).map((s) => ({ capability: s.capability, executed_by: s.sdk.executed_by })),
    client_steps: bound.filter((s) => s.sdk.sdk_surface === "app.client").map((s) => s.capability),
    server_steps: bound.filter((s) => s.sdk.server_only).map((s) => s.capability),
    required_permissions: uniq(bound.flatMap((s) => s.sdk.permissions)),
    verification_surfaces: [...(plan?.verification_surfaces || [])],
  };
}