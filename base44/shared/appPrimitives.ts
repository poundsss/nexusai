// AI App Primitives (#27) — the AI-FACING CAPABILITY LAYER.
//
// Purpose: give an AI a single, deterministic, credential-free model of WHAT this platform can do,
// so a request can be turned into a validated composition of EXISTING platform capabilities before
// any code is written. It sits between Architecture Intelligence (#25) and the platform's real
// systems:
//
//   User Request → Architecture Intelligence → AI App Primitives → existing platform primitives
//                → existing execution / build / deploy
//
// WHAT THIS IS NOT. It is not a runtime, a resource model, a dependency system, a planner, a
// permission system or an execution engine. It owns no state and executes nothing:
//   • node types + relationship vocabulary ... shared/architectureGraph.ts (the ONE graph model)
//   • platform primitive contracts ........... shared/primitiveContract.ts (the ONE invoke contract)
//   • resource definitions ................... each resource contract (agent, actor, connector, …)
//   • authorization .......................... shared/authz.ts + shared/rbac.ts capability strings
//   • execution / build / deploy ............. the existing engines, unchanged
//
// Everything below is PURE and synchronous: no imports of runtime modules, no I/O, no secrets. The
// same inputs always produce byte-identical output, which is what lets a selection, a composition
// verdict and an execution plan be checked rather than trusted.
import { NODE_TYPES, RELATIONSHIP_TYPES } from "./architectureGraph.ts";
import { PRIMITIVE_NAMES } from "./primitiveContract.ts";

export const APP_PRIMITIVE_MODEL_VERSION = "1.0.0";

/** Where a capability's work actually runs. Descriptive only — the runtimes are unchanged. */
export const RUNTIME_SURFACES = ["client", "server", "both"];
/** Which lifecycle stage a capability belongs to, used to order an execution plan. */
export const LIFECYCLE_STAGES = ["schema", "security", "logic", "intelligence", "interface", "observability"];
/** The verbs a capability can be asked for. Deliberately coarse: they describe intent, not an API. */
export const PRIMITIVE_OPERATIONS = ["declare", "read", "write", "invoke", "subscribe", "configure"];

const deepFreeze = (v) => {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.values(v).forEach(deepFreeze); Object.freeze(v); }
  return v;
};
const uniq = (a) => [...new Set(a)].sort();
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 400 }); };

// --- the catalog ---------------------------------------------------------------
// 26 capabilities. Each one MAPS to an existing platform system and to the architecture node type
// that already represents it, so a capability can always be checked against the real project graph.
//
//   node_type ........... the architectureGraph node this capability appears as
//   depends_on .......... other capabilities that must exist first (the closure's only input)
//   permissions ......... EXISTING authz capability strings — never a new permission vocabulary
//   platform_primitives . contract names from primitiveContract.ts, when the capability invokes one
//   io .................. what a composition edge may carry into and out of this capability
//   accepts_from ........ relationship types this capability may be the TARGET of
const CAPABILITIES = [
  // --- schema ---------------------------------------------------------------
  {
    name: "data.entity", title: "Entity data model", node_type: "entity", stage: "schema", surface: "server",
    summary: "Declare a stored record type and read or write its records.",
    operations: ["declare", "read", "write"], depends_on: [], permissions: ["project.write"],
    resource_kind: "entity", platform_primitives: [],
    io: { input: "schema", output: "record" }, accepts_from: ["reads", "writes", "belongs_to", "configures"],
  },
  {
    name: "data.relationship", title: "Entity relationship", node_type: "relationship", stage: "schema", surface: "server",
    summary: "Declare a typed link between two entities.",
    operations: ["declare", "read"], depends_on: ["data.entity"], permissions: ["project.write"],
    resource_kind: "relationship", platform_primitives: [],
    io: { input: "schema", output: "record" }, accepts_from: ["belongs_to", "depends_on"],
  },
  {
    name: "data.rls", title: "Row-level security", node_type: "entity", stage: "security", surface: "server",
    summary: "Restrict which app users may read or write each record of an entity.",
    operations: ["declare", "configure"], depends_on: ["data.entity", "auth.users"], permissions: ["project.write"],
    resource_kind: "entity_rls", platform_primitives: [],
    io: { input: "policy", output: "policy" }, accepts_from: ["authorizes", "configures"],
  },
  {
    name: "data.migration", title: "Schema migration", node_type: "entity", stage: "schema", surface: "server",
    summary: "Change an existing entity's shape without losing its records.",
    operations: ["invoke"], depends_on: ["data.entity"], permissions: ["project.write"],
    resource_kind: "migration", platform_primitives: [],
    io: { input: "schema", output: "schema" }, accepts_from: ["transforms", "depends_on"],
  },
  {
    name: "data.storage", title: "File storage", node_type: "storage", stage: "schema", surface: "both",
    summary: "Store and retrieve files, public or private, referenced by URL.",
    operations: ["write", "read"], depends_on: [], permissions: ["project.write"],
    resource_kind: "storage", platform_primitives: ["FileProcess"],
    io: { input: "file", output: "reference" }, accepts_from: ["reads", "writes"],
  },
  // --- security -------------------------------------------------------------
  {
    name: "auth.users", title: "App users", node_type: "auth", stage: "security", surface: "both",
    summary: "Identify the end users of the generated app and their sessions.",
    operations: ["declare", "read"], depends_on: [], permissions: ["project.write"],
    resource_kind: "auth", platform_primitives: [],
    io: { input: "identity", output: "identity" }, accepts_from: ["authorizes", "configures"],
  },
  {
    name: "auth.roles", title: "App roles", node_type: "role", stage: "security", surface: "server",
    summary: "Declare app-level roles and gate behaviour on them.",
    operations: ["declare", "configure"], depends_on: ["auth.users"], permissions: ["project.write"],
    resource_kind: "role", platform_primitives: [],
    io: { input: "policy", output: "policy" }, accepts_from: ["authorizes", "belongs_to"],
  },
  {
    name: "auth.session", title: "Session identity", node_type: "auth", stage: "security", surface: "both",
    summary: "Resolve the acting user on every request, identically on client and server.",
    operations: ["read"], depends_on: ["auth.users"], permissions: ["project.read"],
    resource_kind: "auth", platform_primitives: [],
    io: { input: "identity", output: "identity" }, accepts_from: ["authorizes", "depends_on"],
  },
  // --- logic ----------------------------------------------------------------
  {
    name: "logic.function", title: "Backend function", node_type: "function", stage: "logic", surface: "server",
    summary: "Run server-side code that may hold secrets and call external services.",
    operations: ["declare", "invoke"], depends_on: [], permissions: ["project.write"],
    resource_kind: "function", platform_primitives: [],
    io: { input: "payload", output: "payload" }, accepts_from: ["calls", "triggers", "depends_on"],
  },
  {
    name: "logic.webhook", title: "Inbound webhook", node_type: "function", stage: "logic", surface: "server",
    summary: "Accept a verified request from an external system.",
    operations: ["declare", "invoke"], depends_on: ["logic.function"], permissions: ["project.write"],
    resource_kind: "function", platform_primitives: [],
    io: { input: "event", output: "payload" }, accepts_from: ["triggers", "consumes"],
  },
  {
    name: "logic.scheduled", title: "Scheduled work", node_type: "function", stage: "logic", surface: "server",
    summary: "Run server-side work on a schedule instead of on a request.",
    operations: ["declare", "invoke"], depends_on: ["logic.function"], permissions: ["project.write"],
    resource_kind: "scheduled_trigger", platform_primitives: ["ScheduleTask", "BackgroundJob"],
    io: { input: "schedule", output: "payload" }, accepts_from: ["triggers", "depends_on"],
  },
  {
    name: "logic.workflow", title: "Workflow orchestration", node_type: "workflow", stage: "logic", surface: "server",
    summary: "Coordinate multiple steps, branches and durable waits across time.",
    operations: ["declare", "invoke"], depends_on: ["logic.function"], permissions: ["project.write"],
    resource_kind: "workflow", platform_primitives: [],
    io: { input: "event", output: "payload" }, accepts_from: ["triggers", "calls", "consumes"],
  },
  // --- intelligence ---------------------------------------------------------
  {
    name: "ai.llm", title: "Language model call", node_type: "function", stage: "intelligence", surface: "server",
    summary: "Ask a model for text or structured JSON, optionally over attached files.",
    operations: ["invoke"], depends_on: ["logic.function"], permissions: ["project.write"],
    resource_kind: "platform_primitive", platform_primitives: ["InvokeAI"],
    io: { input: "prompt", output: "payload" }, accepts_from: ["calls", "transforms"],
  },
  {
    name: "ai.image", title: "Media generation", node_type: "function", stage: "intelligence", surface: "server",
    summary: "Generate an image or other media asset from a description.",
    operations: ["invoke"], depends_on: ["logic.function"], permissions: ["project.write"],
    resource_kind: "platform_primitive", platform_primitives: ["GenerateImage"],
    io: { input: "prompt", output: "reference" }, accepts_from: ["calls", "transforms"],
  },
  {
    name: "ai.agent", title: "In-app agent", node_type: "agent", stage: "intelligence", surface: "server",
    summary: "A model that works a task in a loop with granted tools.",
    operations: ["declare", "invoke"], depends_on: ["ai.llm"], permissions: ["project.write"],
    resource_kind: "agent", platform_primitives: [],
    io: { input: "prompt", output: "payload" }, accepts_from: ["calls", "triggers", "grants"],
  },
  {
    name: "ai.skill", title: "Agent skill", node_type: "skill", stage: "intelligence", surface: "server",
    summary: "Reusable instructions an agent can load for a specific job.",
    operations: ["declare", "read"], depends_on: ["ai.agent"], permissions: ["project.write"],
    resource_kind: "agent_skill", platform_primitives: [],
    io: { input: "prompt", output: "prompt" }, accepts_from: ["depends_on", "grants"],
  },
  {
    name: "ai.tool", title: "Agent tool grant", node_type: "tool", stage: "intelligence", surface: "server",
    summary: "An explicitly granted capability an agent is permitted to use.",
    operations: ["declare", "invoke"], depends_on: ["ai.agent"], permissions: ["project.write"],
    resource_kind: "tool", platform_primitives: [],
    io: { input: "payload", output: "payload" }, accepts_from: ["grants", "authorizes"],
  },
  // --- integration ----------------------------------------------------------
  {
    name: "integration.connector", title: "Connector", node_type: "connector", stage: "logic", surface: "server",
    summary: "Reach an external service through a declared, credential-isolated connector.",
    operations: ["declare", "invoke"], depends_on: ["integration.secret"], permissions: ["project.write"],
    resource_kind: "connector", platform_primitives: [],
    io: { input: "payload", output: "payload" }, accepts_from: ["calls", "consumes", "depends_on"],
  },
  {
    name: "integration.http", title: "External HTTP API", node_type: "integration", stage: "logic", surface: "server",
    summary: "Call a declared external HTTP or MCP operation from server code.",
    operations: ["declare", "invoke"], depends_on: ["logic.function"], permissions: ["project.write"],
    resource_kind: "integration", platform_primitives: [],
    io: { input: "payload", output: "payload" }, accepts_from: ["calls", "consumes"],
  },
  {
    name: "integration.secret", title: "Secret reference", node_type: "integration", stage: "security", surface: "server",
    summary: "Reference a credential by NAME; the value is only ever resolved server-side.",
    operations: ["declare", "read"], depends_on: [], permissions: ["project.write"],
    resource_kind: "secret", platform_primitives: [],
    io: { input: "reference", output: "reference" }, accepts_from: ["depends_on", "authorizes"],
  },
  // --- realtime -------------------------------------------------------------
  {
    name: "realtime.actor", title: "Stateful actor", node_type: "actor", stage: "logic", surface: "server",
    summary: "One live server room per id, holding state across connections.",
    operations: ["declare", "invoke"], depends_on: [], permissions: ["project.write"],
    resource_kind: "actor", platform_primitives: [],
    io: { input: "event", output: "event" }, accepts_from: ["calls", "publishes", "consumes"],
  },
  {
    name: "realtime.channel", title: "Realtime surface", node_type: "realtime_surface", stage: "interface", surface: "both",
    summary: "Push live events to connected clients and receive theirs.",
    operations: ["subscribe", "invoke"], depends_on: ["realtime.actor"], permissions: ["project.read"],
    resource_kind: "realtime_surface", platform_primitives: [],
    io: { input: "event", output: "event" }, accepts_from: ["publishes", "consumes", "depends_on"],
  },
  // --- interface ------------------------------------------------------------
  {
    name: "ui.route", title: "Route", node_type: "route", stage: "interface", surface: "client",
    summary: "An address in the app that resolves to a page.",
    operations: ["declare"], depends_on: [], permissions: ["project.write"],
    resource_kind: "route", platform_primitives: [],
    io: { input: "reference", output: "reference" }, accepts_from: ["renders", "depends_on"],
  },
  {
    name: "ui.page", title: "Page", node_type: "page", stage: "interface", surface: "client",
    summary: "A screen the user opens, composed of components and data reads.",
    operations: ["declare", "read"], depends_on: ["ui.route"], permissions: ["project.write"],
    resource_kind: "page", platform_primitives: [],
    io: { input: "record", output: "reference" }, accepts_from: ["renders", "reads", "depends_on"],
  },
  {
    name: "ui.component", title: "Component", node_type: "component", stage: "interface", surface: "client",
    summary: "A reusable piece of interface rendered inside pages.",
    operations: ["declare"], depends_on: [], permissions: ["project.write"],
    resource_kind: "component", platform_primitives: [],
    io: { input: "record", output: "reference" }, accepts_from: ["renders", "depends_on"],
  },
  // --- observability --------------------------------------------------------
  {
    name: "observability.analytics", title: "App analytics", node_type: "analytics", stage: "observability", surface: "both",
    summary: "Record and read product events for the generated app.",
    operations: ["write", "read", "configure"], depends_on: [], permissions: ["project.read"],
    resource_kind: "analytics", platform_primitives: [],
    io: { input: "event", output: "record" }, accepts_from: ["publishes", "consumes", "configures"],
  },
];

// Integrity: every capability must reference a REAL architecture node type and, when it names a
// platform primitive, a REAL contract name. A drift here is a programming error, not a runtime case.
for (const c of CAPABILITIES) {
  if (!NODE_TYPES.includes(c.node_type)) throw new Error(`appPrimitives: '${c.name}' maps to unknown architecture node type '${c.node_type}'`);
  if (!LIFECYCLE_STAGES.includes(c.stage)) throw new Error(`appPrimitives: '${c.name}' has unknown lifecycle stage '${c.stage}'`);
  for (const p of c.platform_primitives) {
    if (!PRIMITIVE_NAMES.includes(p)) throw new Error(`appPrimitives: '${c.name}' references unknown platform primitive '${p}'`);
  }
  for (const r of c.accepts_from) {
    if (!RELATIONSHIP_TYPES.includes(r)) throw new Error(`appPrimitives: '${c.name}' accepts unknown relationship '${r}'`);
  }
}

export const APP_PRIMITIVES = deepFreeze([...CAPABILITIES].sort((a, b) => a.name.localeCompare(b.name)));
export const APP_PRIMITIVE_NAMES = deepFreeze(APP_PRIMITIVES.map((c) => c.name));
const BY_NAME = new Map(APP_PRIMITIVES.map((c) => [c.name, c]));

// Every declared dependency must itself be a capability.
for (const c of APP_PRIMITIVES) {
  for (const d of c.depends_on) if (!BY_NAME.has(d)) throw new Error(`appPrimitives: '${c.name}' depends on unknown capability '${d}'`);
}

// --- identity / resolution ------------------------------------------------------

export const capabilityExists = (name) => BY_NAME.has(String(name));

/** Resolves ONE capability by name. Throws a coded error rather than guessing at a near match. */
export function resolveCapability(name) {
  const found = BY_NAME.get(String(name));
  if (!found) fail("CAPABILITY_NOT_FOUND", `Unknown platform capability '${name}'. Known capabilities: ${APP_PRIMITIVE_NAMES.join(", ")}`);
  return found;
}

/** The capabilities represented by one architecture node type — the bridge to the real graph. */
export const capabilitiesForNodeType = (node_type) =>
  APP_PRIMITIVES.filter((c) => c.node_type === String(node_type)).map((c) => c.name);

/**
 * Request-intent selectors. Deliberately explicit and inspectable: a phrase maps to a capability, so
 * a selection can be explained. An unmatched request selects nothing rather than inventing intent.
 */
export const CAPABILITY_SELECTORS = deepFreeze([
  { capability: "data.entity", terms: ["entity", "record", "table", "database", "store data", "crud", "model"] },
  { capability: "data.relationship", terms: ["relationship", "link records", "foreign key", "related"] },
  { capability: "data.rls", terms: ["rls", "row level", "own data", "private data", "isolate users", "only see their"] },
  { capability: "data.migration", terms: ["migration", "change schema", "add field", "rename field"] },
  { capability: "data.storage", terms: ["upload", "file", "attachment", "image storage", "document"] },
  { capability: "auth.users", terms: ["user", "sign up", "login", "account", "authenticate"] },
  { capability: "auth.roles", terms: ["role", "admin only", "permission", "access level"] },
  { capability: "auth.session", terms: ["session", "current user", "logged in", "who am i"] },
  { capability: "logic.function", terms: ["backend", "server", "function", "api endpoint", "server-side"] },
  { capability: "logic.webhook", terms: ["webhook", "incoming request", "callback url"] },
  { capability: "logic.scheduled", terms: ["schedule", "cron", "every day", "recurring", "daily", "hourly"] },
  { capability: "logic.workflow", terms: ["workflow", "automation", "multi-step", "when this then", "pipeline"] },
  { capability: "ai.llm", terms: ["ai", "llm", "model", "generate text", "summarize", "classify", "prompt"] },
  { capability: "ai.image", terms: ["generate image", "image generation", "picture", "illustration", "media"] },
  { capability: "ai.agent", terms: ["agent", "assistant", "chatbot", "autonomous"] },
  { capability: "ai.skill", terms: ["skill", "agent instructions", "playbook"] },
  { capability: "ai.tool", terms: ["tool", "tool call", "grant tool", "function calling"] },
  { capability: "integration.connector", terms: ["connector", "connect account", "oauth", "third party account"] },
  { capability: "integration.http", terms: ["external api", "http request", "rest api", "mcp", "integration"] },
  { capability: "integration.secret", terms: ["secret", "api key", "credential", "token"] },
  { capability: "realtime.actor", terms: ["actor", "room", "shared session", "multiplayer", "game state"] },
  { capability: "realtime.channel", terms: ["realtime", "live", "presence", "collaborate", "push update", "subscribe"] },
  { capability: "ui.route", terms: ["route", "url", "navigation", "link to"] },
  { capability: "ui.page", terms: ["page", "screen", "view", "dashboard", "form"] },
  { capability: "ui.component", terms: ["component", "widget", "card", "button", "list item"] },
  { capability: "observability.analytics", terms: ["analytics", "track event", "metrics", "funnel", "usage"] },
]);

/** Credential-free public description of the whole capability surface. */
export function describeAppPrimitives() {
  return {
    model_version: APP_PRIMITIVE_MODEL_VERSION,
    capability_count: APP_PRIMITIVES.length,
    runtime_surfaces: [...RUNTIME_SURFACES], lifecycle_stages: [...LIFECYCLE_STAGES],
    operations: [...PRIMITIVE_OPERATIONS],
    capabilities: APP_PRIMITIVES.map((c) => ({
      name: c.name, title: c.title, summary: c.summary, node_type: c.node_type,
      lifecycle_stage: c.stage, runtime_surface: c.surface, resource_kind: c.resource_kind,
      operations: [...c.operations], depends_on: [...c.depends_on], permissions: [...c.permissions],
      platform_primitives: [...c.platform_primitives], io: { ...c.io }, accepts_from: [...c.accepts_from],
    })),
  };
}

// --- dependency closure --------------------------------------------------------

/**
 * The transitive dependency closure of a capability set, in deterministic topological order.
 *
 * This is NOT a second dependency graph: the only edges it walks are the `depends_on` declarations
 * above, which describe capability prerequisites — the project's real dependency graph stays in
 * architectureGraph.ts. An unknown name is REPORTED as unresolved, never silently dropped, and a
 * cycle is reported rather than looped over.
 */
export function dependencyClosure(names = []) {
  const requested = uniq((names || []).map(String));
  const unresolved = requested.filter((n) => !BY_NAME.has(n));
  const known = requested.filter((n) => BY_NAME.has(n));

  const order = [];
  const seen = new Set();
  const cycles = [];
  const visit = (name, stack) => {
    if (seen.has(name)) return;
    if (stack.includes(name)) { cycles.push([...stack.slice(stack.indexOf(name)), name].join(" -> ")); return; }
    for (const d of [...resolveCapability(name).depends_on].sort()) visit(d, [...stack, name]);
    seen.add(name);
    order.push(name);
  };
  for (const n of known) visit(n, []);

  const resolved = [...order];
  const transitive = resolved.filter((n) => !known.includes(n));
  return {
    model_version: APP_PRIMITIVE_MODEL_VERSION,
    requested, direct: known, resolved, transitive,
    unresolved, complete: unresolved.length === 0 && cycles.length === 0,
    cycles: uniq(cycles), order,
  };
}

// --- selection -----------------------------------------------------------------

const matchRequest = (request) => {
  const text = String(request || "").toLowerCase();
  if (!text.trim()) return { matched: [], matches: [] };
  const matches = [];
  for (const sel of CAPABILITY_SELECTORS) {
    const hit = sel.terms.filter((t) => text.includes(t));
    if (hit.length) matches.push({ capability: sel.capability, matched_terms: hit.sort() });
  }
  matches.sort((a, b) => b.matched_terms.length - a.matched_terms.length || a.capability.localeCompare(b.capability));
  return { matched: uniq(matches.map((m) => m.capability)), matches };
};

/**
 * Selects the capabilities a request needs, closed over their prerequisites and marked against what
 * the project ALREADY has (from the architecture's own node types) and what the caller is permitted
 * to do (EXISTING authz capability strings — this layer grants nothing).
 */
export function selectPrimitives({ request = "", capabilities = [], present_node_types = [], caller_permissions = null } = {}) {
  const intent = matchRequest(request);
  const seeds = uniq([...(capabilities || []).map(String), ...intent.matched]);
  const closure = dependencyClosure(seeds);
  const present = new Set((present_node_types || []).map(String));
  const held = caller_permissions === null ? null : new Set((caller_permissions || []).map(String));

  const selected = closure.resolved.map((name) => {
    const c = resolveCapability(name);
    const missing_permissions = held ? c.permissions.filter((p) => !held.has(p)) : [];
    return {
      capability: name, title: c.title, node_type: c.node_type, lifecycle_stage: c.stage,
      runtime_surface: c.surface, resource_kind: c.resource_kind,
      reason: intent.matched.includes(name) ? "requested" : (capabilities || []).includes(name) ? "explicit" : "dependency",
      exists_in_project: present.has(c.node_type),
      depends_on: [...c.depends_on], permissions: [...c.permissions],
      platform_primitives: [...c.platform_primitives],
      permitted: !missing_permissions.length, missing_permissions,
    };
  });

  return {
    model_version: APP_PRIMITIVE_MODEL_VERSION,
    request: String(request || "").slice(0, 2000),
    seeds, matches: intent.matches, closure, selected,
    required_permissions: uniq(selected.flatMap((s) => s.permissions)),
    existing_capabilities: selected.filter((s) => s.exists_in_project).map((s) => s.capability),
    new_capabilities: selected.filter((s) => !s.exists_in_project).map((s) => s.capability),
    unpermitted: selected.filter((s) => !s.permitted).map((s) => ({ capability: s.capability, missing_permissions: s.missing_permissions })),
    unmatched_request: !seeds.length,
  };
}

// --- composition validation ----------------------------------------------------

const issue = (severity, code, message, detail = {}) => ({ severity, code, message, ...detail });

/**
 * Validates that a proposed composition of capabilities is COHERENT before anything is built:
 * unknown capabilities, unsatisfied prerequisites, unsupported cycles, invalid relationships,
 * incompatible data flow, runtime-surface violations and permissions the caller does not hold.
 *
 * It validates a PROPOSAL. It is not the platform's validator for real resources — each resource
 * contract still validates its own document at build time, and authz still decides every request.
 */
export function validateComposition({ capabilities = [], edges = [], present_node_types = [], caller_permissions = null } = {}) {
  const errors = [];
  const warnings = [];
  const requested = uniq((capabilities || []).map(String));
  if (!requested.length) errors.push(issue("error", "EMPTY_COMPOSITION", "A composition must contain at least one capability"));

  const closure = dependencyClosure(requested);
  for (const u of closure.unresolved) errors.push(issue("error", "UNKNOWN_CAPABILITY", `Unknown platform capability '${u}'`, { capability: u }));
  for (const c of closure.cycles) errors.push(issue("error", "UNSUPPORTED_CYCLE", `Capability dependencies form a cycle: ${c}`, { cycle: c }));

  // Unsatisfied prerequisite: required by the composition but not declared in it.
  for (const name of closure.transitive) {
    errors.push(issue("error", "UNSATISFIED_DEPENDENCY", `'${name}' is required by this composition but was not included`, { capability: name, required_by: closure.direct.filter((d) => resolveCapability(d).depends_on.includes(name)) }));
  }

  const present = new Set((present_node_types || []).map(String));
  const held = caller_permissions === null ? null : new Set((caller_permissions || []).map(String));
  const inComposition = new Set(closure.direct);

  for (const name of closure.direct) {
    const c = resolveCapability(name);
    if (held) {
      const missing = c.permissions.filter((p) => !held.has(p));
      if (missing.length) errors.push(issue("error", "PERMISSION_DENIED", `'${name}' requires ${missing.join(", ")}, which the caller does not hold`, { capability: name, missing_permissions: missing }));
    }
    // A capability whose prerequisite is satisfied by the project rather than by the composition is
    // fine; one satisfied by neither is a real gap.
    for (const d of c.depends_on) {
      if (inComposition.has(d) || present.has(resolveCapability(d).node_type)) continue;
      warnings.push(issue("warning", "DEPENDENCY_NOT_PRESENT", `'${name}' depends on '${d}', which is neither in this composition nor already in the project`, { capability: name, depends_on: d }));
    }
  }

  // Edges: a proposed data/control flow between two capabilities in this composition.
  const checked = [];
  for (const e of edges || []) {
    const from = String(e?.from || "");
    const to = String(e?.to || "");
    const relationship = String(e?.relationship || "depends_on");
    const ref = { from, to, relationship };
    if (!BY_NAME.has(from) || !BY_NAME.has(to)) {
      errors.push(issue("error", "UNKNOWN_CAPABILITY", `Edge references an unknown capability: ${from || "(none)"} -> ${to || "(none)"}`, ref));
      continue;
    }
    if (!inComposition.has(from) || !inComposition.has(to)) {
      errors.push(issue("error", "EDGE_OUTSIDE_COMPOSITION", `Edge ${from} --${relationship}--> ${to} references a capability outside this composition`, ref));
      continue;
    }
    if (!RELATIONSHIP_TYPES.includes(relationship)) {
      errors.push(issue("error", "INVALID_RELATIONSHIP", `'${relationship}' is not a platform relationship type (${RELATIONSHIP_TYPES.join(", ")})`, ref));
      continue;
    }
    const target = resolveCapability(to);
    const source = resolveCapability(from);
    if (from === to) errors.push(issue("error", "SELF_REFERENCE", `'${from}' cannot compose with itself`, ref));
    else if (!target.accepts_from.includes(relationship)) {
      errors.push(issue("error", "INCOMPATIBLE_COMPOSITION", `'${to}' does not accept a '${relationship}' relationship (accepts: ${target.accepts_from.join(", ")})`, ref));
    } else if (source.io.output !== target.io.input && target.io.input !== "reference" && source.io.output !== "reference") {
      errors.push(issue("error", "INCOMPATIBLE_IO", `'${from}' produces ${source.io.output} but '${to}' consumes ${target.io.input}`, ref));
    }
    // Runtime boundary: client-surface capabilities can never be the source of server-only work.
    if (source.surface === "client" && target.surface === "server" && ["calls", "writes", "triggers"].includes(relationship)) {
      errors.push(issue("error", "RUNTIME_SURFACE_VIOLATION", `'${from}' runs on the client and cannot ${relationship} the server-only capability '${to}' directly — route it through logic.function`, ref));
    }
    checked.push(ref);
  }

  return {
    model_version: APP_PRIMITIVE_MODEL_VERSION,
    valid: errors.length === 0,
    capabilities: closure.direct, closure, edges: checked,
    errors, warnings, error_count: errors.length, warning_count: warnings.length,
    required_permissions: uniq(closure.direct.map((n) => resolveCapability(n).permissions).flat()),
    existing_capabilities: closure.direct.filter((n) => present.has(resolveCapability(n).node_type)),
    new_capabilities: closure.direct.filter((n) => !present.has(resolveCapability(n).node_type)),
  };
}

// --- execution-plan generation -------------------------------------------------

const STAGE_RANK = new Map(LIFECYCLE_STAGES.map((s, i) => [s, i]));

/**
 * Turns a validated composition into ORDERED STEPS for the platform's EXISTING execution system.
 *
 * It generates no code, mutates nothing and runs nothing: each step names the capability, the
 * platform system that already implements it, the operation and the verification surface the
 * existing engines will use. An INVALID composition yields no steps — a refusal, not a partial plan.
 */
export function planPrimitiveExecution({
  goal = "", capabilities = [], edges = [], present_node_types = [],
  caller_permissions = null, architecture = null, impact = null,
} = {}) {
  const composition = validateComposition({ capabilities, edges, present_node_types, caller_permissions });
  const present = new Set((present_node_types || []).map(String));

  const steps = composition.valid
    ? composition.closure.order
      .map((name) => {
        const c = resolveCapability(name);
        const exists = present.has(c.node_type);
        return {
          capability: name, node_type: c.node_type, lifecycle_stage: c.stage,
          stage_rank: STAGE_RANK.get(c.stage) ?? 99,
          action: exists ? "modify" : "create",
          operation: c.operations[0], runtime_surface: c.surface, resource_kind: c.resource_kind,
          implemented_by: c.platform_primitives.length ? `platform_primitive:${c.platform_primitives.join(",")}` : `resource:${c.resource_kind}`,
          permissions: [...c.permissions],
          depends_on: c.depends_on.filter((d) => composition.closure.order.includes(d)),
          verification: c.surface === "client" ? "build" : c.stage === "schema" ? "schema_migration" : "function_execution",
        };
      })
      .sort((a, b) => a.stage_rank - b.stage_rank || composition.closure.order.indexOf(a.capability) - composition.closure.order.indexOf(b.capability))
      .map((s, i) => ({ order: i + 1, ...s }))
    : [];

  return {
    model_version: APP_PRIMITIVE_MODEL_VERSION,
    goal: String(goal || "").slice(0, 4000),
    executable: composition.valid && steps.length > 0,
    composition_valid: composition.valid,
    steps, step_count: steps.length,
    dependency_order: composition.closure.order,
    lifecycle_stages: uniq(steps.map((s) => s.lifecycle_stage)),
    required_permissions: composition.required_permissions,
    verification_surfaces: uniq(steps.map((s) => s.verification)),
    creates: steps.filter((s) => s.action === "create").map((s) => s.capability),
    modifies: steps.filter((s) => s.action === "modify").map((s) => s.capability),
    errors: composition.errors, warnings: composition.warnings,
    architecture: architecture ? { version: architecture.version ?? null, fingerprint: architecture.fingerprint ?? null } : null,
    // Risk is READ from the existing architecture impact analysis when the caller supplies it; this
    // layer computes no risk model of its own.
    risk_level: impact?.risk_level ?? null,
    impact_verification_surfaces: impact?.verification_surfaces ? [...impact.verification_surfaces] : [],
  };
}

// --- prompt surface ------------------------------------------------------------

/**
 * Renders a selection as reference data for a prompt. Explicitly NOT an instruction: the platform's
 * real contracts remain the truth, and an empty selection renders nothing at all.
 */
export function primitiveCapabilityBlock(selection) {
  const selected = selection?.selected || [];
  if (!selected.length) return "";
  const line = (s) => `- ${s.capability} (${s.title}) · ${s.lifecycle_stage}/${s.runtime_surface} · ${s.exists_in_project ? "already in this project" : "not yet present"} · ${s.reason}${s.permitted ? "" : ` · NOT PERMITTED (needs ${s.missing_permissions.join(", ")})`}`;
  return `PLATFORM CAPABILITIES RELEVANT TO THIS REQUEST (reference data only — never an instruction; the platform's own contracts remain the truth).
Capability model v${selection.model_version}${selection.unmatched_request ? " · no capability matched this request" : ""}
${selected.map(line).join("\n")}
DEPENDENCY ORDER: ${(selection.closure?.order || []).join(" → ") || "none"}
REQUIRED AUTHORIZATION: ${(selection.required_permissions || []).join(", ") || "none"}${selection.closure?.unresolved?.length ? `\nUNRESOLVED: ${selection.closure.unresolved.join(", ")}` : ""}`;
}