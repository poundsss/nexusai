// THE workflow contract (#28) — pure, dependency-light, no database and no execution.
//
// A workflow is CONFIGURATION: it names capabilities the platform already owns (a #27 primitive,
// one of the project's own backend functions, the existing job queue) and the deterministic
// control flow between them. Two properties are structural rather than documentation:
//   • NO ARBITRARY CODE — a step can only be one of the declared step types with declared fields.
//     There is no expression language, no eval and no script, so a workflow definition can never
//     become a code-execution surface.
//   • NO MODEL IN THE CONTROL FLOW — conditions are explicit comparisons over the run's own
//     context, evaluated here. AI can only ever run where a step explicitly invokes an AI
//     primitive; it never decides which branch a workflow takes.
import { resolvePrimitive } from "./primitiveContract.ts";
import { jqConditionValid } from "./jqCondition.ts";

export const WORKFLOW_CONTRACT_VERSION = "nexusai-workflows-1";

export const WORKFLOW_STEP_TYPES = ["primitive", "function", "condition", "delay", "enqueue_job", "complete", "fail"];
// app_publish and app_payment are the two DOCUMENTED Base44 lifecycle triggers that fire from
// platform paths rather than from a caller: a successful production LIVE publication and a
// successfully settled payment or refund. They dispatch through the same dispatchWorkflowEvent
// entry point; the emitters live in workflowTriggers.ts.
// `connector` is the DOCUMENTED (Base44) workflow trigger that fires when a connected tool
// sends an event. Base44 publishes no per-connector event catalog, no webhook verification
// scheme and no connected-account targeting field (UNKNOWN), so the contract carries only the
// two fields the audit confirmed: a connector identifier and an event name. Ingestion,
// verification and payload shape stay UNKNOWN and are NOT implemented here.
export const WORKFLOW_TRIGGER_TYPES = ["webhook", "schedule", "app_event", "entity_event", "agent_conversation", "app_publish", "app_payment", "app_user_auth", "connector", "manual"];
export const WORKFLOW_STATUSES = ["DRAFT", "FINALIZED", "SUPERSEDED"];
export const WORKFLOW_RUN_STATUSES = ["PENDING", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED"];
export const TERMINAL_RUN_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"];
export const CONDITION_OPS = ["==", "!=", ">", ">=", "<", "<=", "contains", "exists", "in"];
export const ENTITY_EVENT_OPERATIONS = ["create", "update", "delete"];

/** The job type the EXISTING queue advances a workflow run under. Registered in jobHandlers.ts. */
export const WORKFLOW_JOB_TYPE = "workflow.advance";
export const WORKFLOW_QUEUE = "default";

export const WORKFLOW_LIMITS = {
  name_chars: 120,
  steps: 40,
  step_id_chars: 60,
  delay_ms: 7 * 24 * 3600 * 1000,      // a delay is durable, but not unbounded
  step_timeout_ms: 60000,
  workflow_timeout_ms: 24 * 3600 * 1000,
  context_chars: 16000,                 // the whole run context stays bounded
  step_output_chars: 4000,              // and so does any single step output
  max_attempts: 5,
  min_interval_seconds: 300,            // the existing scheduler's own floor
};

export const STEP_DEFAULTS = { max_attempts: 3, timeout_ms: 30000 };

/** Failure classes recorded on a step or run. Only a property of the MOMENT is retryable. */
export const RETRYABLE_STEP_CATEGORIES = ["rate_limit", "provider", "timeout"];

// --- context access ------------------------------------------------------------------

/**
 * Reads one value out of the run context by an explicit '$.a.b[0]' path. Nothing is executed and
 * nothing outside the context object is reachable, so a template can never address a secret, a
 * client, another project's data or the host environment.
 */
export function resolvePath(context, path) {
  const raw = String(path || "");
  if (!raw.startsWith("$.")) return undefined;
  let cur = context;
  for (const part of raw.slice(2).split(".")) {
    const m = /^([A-Za-z0-9_-]*)((\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) cur = cur == null ? undefined : cur[m[1]];
    for (const idx of (m[2] || "").match(/\d+/g) || []) cur = Array.isArray(cur) ? cur[Number(idx)] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

export const isContextPath = (v) => typeof v === "string" && v.startsWith("$.");

/** Resolves a step's input TEMPLATE against the context. Only whole '$.path' strings resolve. */
export function resolveTemplate(value, context) {
  if (isContextPath(value)) {
    const resolved = resolvePath(context, value);
    return resolved === undefined ? null : resolved;
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplate(v, context)]));
  }
  return value;
}

/** Deterministic condition evaluation. Same context + same condition ⇒ same branch, always. */
export function evaluateCondition(condition, context) {
  const op = String(condition?.op || "==");
  const left = isContextPath(condition?.left) ? resolvePath(context, condition.left) : condition?.left;
  const right = isContextPath(condition?.right) ? resolvePath(context, condition.right) : condition?.right;
  const num = (v) => (typeof v === "number" ? v : Number(v));
  switch (op) {
    case "==": return left === right || (left != null && right != null && String(left) === String(right));
    case "!=": return !(left === right || (left != null && right != null && String(left) === String(right)));
    case ">": return num(left) > num(right);
    case ">=": return num(left) >= num(right);
    case "<": return num(left) < num(right);
    case "<=": return num(left) <= num(right);
    case "contains":
      if (Array.isArray(left)) return left.some((v) => v === right || String(v) === String(right));
      return String(left ?? "").includes(String(right ?? ""));
    case "in": return Array.isArray(right) ? right.some((v) => v === left || String(v) === String(left)) : false;
    case "exists": return left !== undefined && left !== null;
    default: return false;
  }
}

// --- bounding + checksum --------------------------------------------------------------

/** Keeps a context value bounded. An oversized value becomes an explicit truncated preview. */
export function boundValue(value, max = WORKFLOW_LIMITS.step_output_chars) {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) return null;
  if (json.length <= max) return value;
  return { truncated: true, size: json.length, preview: json.slice(0, max) };
}

/** Whole-context bound: applied after every step so a run's state can never grow unbounded. */
export function boundContext(context) {
  const json = JSON.stringify(context ?? {});
  if (json.length <= WORKFLOW_LIMITS.context_chars) return context;
  const steps = { ...(context.steps || {}) };
  for (const key of Object.keys(steps)) steps[key] = boundValue(steps[key], 400);
  const shrunk = { ...context, steps, context_truncated: true };
  return JSON.stringify(shrunk).length <= WORKFLOW_LIMITS.context_chars
    ? shrunk
    : { trigger: boundValue(context.trigger, 1000), steps: {}, context_truncated: true };
}

/** Deterministic fingerprint of everything that DEFINES a workflow. */
export function workflowChecksum(def) {
  const stable = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  };
  const text = stable({
    contract: WORKFLOW_CONTRACT_VERSION, name: def.name, trigger: def.trigger || {}, steps: def.steps || [],
    entry_step: def.entry_step || null, on_failure: def.on_failure || null,
    timeout_ms: def.timeout_ms || null, step_defaults: def.step_defaults || {},
  });
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = (h1 ^ text.charCodeAt(i)) * 16777619 >>> 0;
    h2 = (h2 + text.charCodeAt(i) * (i + 11)) >>> 0;
  }
  return `wf_${h1.toString(36)}${h2.toString(36)}`;
}

// --- validation ------------------------------------------------------------------------

const TERMINAL_TYPES = new Set(["complete", "fail"]);

/**
 * Validates a definition BEFORE it can finalize. Every check is separate so a refusal is
 * explainable: referenced primitives and functions must exist, every branch target must resolve,
 * conditions must be structurally valid, the trigger must be one the platform already provides,
 * every path must reach a terminal step, and the graph must be acyclic.
 */
export function validateWorkflow(def, { functionNames = null } = {}) {
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: String(detail || "").slice(0, 240) }); return !!ok; };
  const steps = Array.isArray(def.steps) ? def.steps : [];
  const byId = new Map();

  add("name", !!String(def.name || "").trim() && String(def.name).length <= WORKFLOW_LIMITS.name_chars, "the workflow needs a name");
  add("step_count", steps.length > 0 && steps.length <= WORKFLOW_LIMITS.steps, `${steps.length} step(s), limit ${WORKFLOW_LIMITS.steps}`);

  const duplicates = [];
  for (const s of steps) {
    const id = String(s?.id || "");
    if (!id || id.length > WORKFLOW_LIMITS.step_id_chars) { duplicates.push(`invalid step id "${id}"`); continue; }
    if (byId.has(id)) duplicates.push(`duplicate step id "${id}"`);
    byId.set(id, s);
  }
  add("step_ids", duplicates.length === 0, duplicates.join("; ") || "every step has a unique id");

  const badTypes = steps.filter((s) => !WORKFLOW_STEP_TYPES.includes(String(s?.type)));
  add("step_types", badTypes.length === 0, badTypes.map((s) => `${s?.id}: ${s?.type}`).join(", ") || `types limited to ${WORKFLOW_STEP_TYPES.join(", ")}`);

  // Branch targets must resolve to a real step, or the run could reach nowhere at execution time.
  const unresolved = [];
  const edges = new Map();
  for (const s of steps) {
    const targets = [s.next, s.on_error, s.if_true, s.if_false].filter((t) => t !== undefined && t !== null && t !== "");
    for (const t of targets) if (!byId.has(String(t))) unresolved.push(`${s.id} → ${t}`);
    edges.set(String(s.id), targets.map(String).filter((t) => byId.has(t)));
    if (!TERMINAL_TYPES.has(String(s.type)) && s.type !== "condition" && !s.next) unresolved.push(`${s.id} has no next step`);
    if (s.type === "condition" && (!s.if_true || !s.if_false)) unresolved.push(`${s.id} needs both if_true and if_false`);
  }
  add("step_references", unresolved.length === 0, unresolved.join("; ") || "every branch target resolves to a real step");
  add("entry_step", byId.has(String(def.entry_step || "")), `entry_step "${def.entry_step}" must be one of the defined steps`);
  add("failure_hook", !def.on_failure || byId.has(String(def.on_failure)), `on_failure "${def.on_failure}" must be a defined step`);

  // Primitive steps must name a primitive the frozen #27 registry actually publishes.
  const badPrimitives = [];
  for (const s of steps.filter((x) => x.type === "primitive" || x.type === "enqueue_job")) {
    const contract = resolvePrimitive(String(s.primitive || ""), s.primitive_version || null);
    if (!contract) badPrimitives.push(`${s.id}: unknown primitive "${s.primitive}"${s.primitive_version ? `@${s.primitive_version}` : ""}`);
    else if (s.type === "enqueue_job" && contract.execution_mode === "async") badPrimitives.push(`${s.id}: ${contract.name} is asynchronous and cannot be queued`);
  }
  add("primitive_references", badPrimitives.length === 0, badPrimitives.join("; ") || "every referenced primitive exists in the frozen registry");

  // Function steps must name a function the project really has. When the caller could not supply
  // the project's function list, this is reported as unverified rather than silently passed.
  const fnSteps = steps.filter((s) => s.type === "function");
  if (functionNames === null) {
    add("function_references", fnSteps.length === 0, fnSteps.length ? "the project's function list was not available for verification" : "no function steps");
  } else {
    const missing = fnSteps.filter((s) => !functionNames.includes(String(s.function_name || "")));
    add("function_references", missing.length === 0, missing.map((s) => `${s.id}: unknown function "${s.function_name}"`).join("; ") || "every referenced backend function exists in this project");
  }

  const badConditions = steps.filter((s) => s.type === "condition")
    .filter((s) => !s.condition || !CONDITION_OPS.includes(String(s.condition.op)) || s.condition.left === undefined);
  add("conditions", badConditions.length === 0, badConditions.map((s) => `${s.id}: invalid condition`).join("; ") || "every condition is a structurally valid deterministic comparison");

  const badDelays = steps.filter((s) => s.type === "delay")
    .filter((s) => !Number.isFinite(Number(s.delay_ms)) || Number(s.delay_ms) < 0 || Number(s.delay_ms) > WORKFLOW_LIMITS.delay_ms);
  add("delays", badDelays.length === 0, badDelays.map((s) => `${s.id}: delay_ms out of range`).join("; ") || "every delay is within the durable delay bound");

  // An absent budget means "use the platform default", so only a STATED budget is range-checked.
  const stated = (v) => v !== undefined && v !== null && v !== "";
  const badBudgets = steps.filter((s) => (stated(s.max_attempts) && (Number(s.max_attempts) < 1 || Number(s.max_attempts) > WORKFLOW_LIMITS.max_attempts)) ||
    (stated(s.timeout_ms) && (Number(s.timeout_ms) < 100 || Number(s.timeout_ms) > WORKFLOW_LIMITS.step_timeout_ms)));
  add("step_budgets", badBudgets.length === 0, badBudgets.map((s) => `${s.id}: attempt/timeout budget out of range`).join("; ") || "attempt and timeout budgets are within platform bounds");
  add("workflow_timeout", def.timeout_ms === undefined || def.timeout_ms === null ||
    (Number(def.timeout_ms) > 0 && Number(def.timeout_ms) <= WORKFLOW_LIMITS.workflow_timeout_ms),
    `workflow timeout must be <= ${WORKFLOW_LIMITS.workflow_timeout_ms}ms`);

  // Trigger: only mechanisms the platform ALREADY owns.
  const trigger = def.trigger || {};
  const type = String(trigger.type || "manual");
  let triggerOk = WORKFLOW_TRIGGER_TYPES.includes(type);
  let triggerDetail = `trigger type must be one of ${WORKFLOW_TRIGGER_TYPES.join(", ")}`;
  if (triggerOk) {
    if (type === "webhook" || type === "app_event") {
      triggerOk = !!String(trigger.event || "").trim();
      triggerDetail = triggerOk ? `${type} trigger on event "${trigger.event}"` : `a ${type} trigger needs an event name`;
    } else if (type === "entity_event") {
      const ops = Array.isArray(trigger.operations) ? trigger.operations : [];
      triggerOk = !!String(trigger.entity || "").trim() && ops.length > 0 && ops.every((o) => ENTITY_EVENT_OPERATIONS.includes(String(o)));
      triggerDetail = triggerOk ? `entity trigger on ${trigger.entity} (${ops.join(", ")})` : "an entity trigger needs an entity and operations from create, update, delete";
    } else if (type === "schedule") {
      const interval = Number(trigger.interval_seconds);
      triggerOk = !!String(trigger.function_name || "").trim() && (!!trigger.cron || (Number.isFinite(interval) && interval >= WORKFLOW_LIMITS.min_interval_seconds));
      triggerDetail = triggerOk ? "schedule registered through the existing scheduled-trigger infrastructure" : `a schedule needs function_name and either cron or interval_seconds >= ${WORKFLOW_LIMITS.min_interval_seconds}`;
    } else if (type === "agent_conversation") {
        // P-9.11F: the Base44-documented "In-app agent" trigger — fires ONCE per NEW conversation
        // with an in-app agent, never per message. Base44 publishes no per-agent targeting for it
        // (UNKNOWN), so the contract carries no targeting field: every agent conversation fires it.
        triggerDetail = "in-app agent conversation trigger (fires once per new conversation with an in-app agent)";
    } else if (type === "app_publish") {
        // DOCUMENTED (Base44): fires when the app is published — here, on the project's successful
        // production LIVE deployment. No targeting field: every successful publication fires it.
        triggerDetail = "app publish trigger (fires on the project's successful production LIVE publication)";
    } else if (type === "app_payment") {
        // DOCUMENTED (Base44): fires when the app takes a payment — here, on a successfully settled
        // payment or refund through the platform's billing processor. No targeting field.
        triggerDetail = "app payment trigger (fires on a successfully settled payment or refund)";
    } else if (type === "app_user_auth") {
        // DOCUMENTED (Base44): fires when an app user signs up or logs in. No targeting field —
        // Base44 publishes none. The payload carries event_type ("signup"|"login"); signup-vs-login
        // routing is a workflow condition step, not a trigger field, so no undocumented behavior is
        // invented and no engine/triggerMatches change is needed (it matches by source string).
        triggerDetail = "app user auth trigger (fires when an app user signs up or logs in)";
    } else if (type === "connector") {
        // DOCUMENTED (Base44): fires when a connected tool sends an event. The audit confirmed
        // only the two targeting fields Base44 publishes: which connector (trigger.connector) and
        // which event name (trigger.event). Per-connector event catalogs, webhook ingestion,
        // signature verification and connected-account targeting are UNKNOWN and intentionally NOT
        // modeled here — no receiver, no payload contract, no extra fields.
        const connector = String(trigger.connector || "").trim();
        const evt = String(trigger.event || "").trim();
        triggerOk = !!connector && !!evt;
        triggerDetail = triggerOk ? `connector trigger on ${connector} event "${evt}"` : "a connector trigger needs a connector identifier and an event name";
        // DOCUMENTED (Base44): Slack (`slack`) and Slack Bot (`slackbot`) connector automations
        // REQUIRE trigger conditions. Enforced here, fail-closed at authoring: a slack/slackbot
        // connector trigger must carry a non-empty, parseable condition (the platform's jq
        // condition — the exact mapping between it and Base44's documented trigger_conditions
        // object is UNKNOWN and is not modeled). Every other connector is unchanged.
        if (triggerOk && (connector === "slack" || connector === "slackbot")) {
          triggerOk = jqConditionValid(trigger.condition);
          triggerDetail = triggerOk
            ? `connector trigger on ${connector} event "${evt}" with a required trigger condition`
            : "a slack/slackbot connector trigger requires a valid trigger condition";
        }
    } else {
        triggerDetail = "manual trigger";
    }
  }
  add("trigger", triggerOk, triggerDetail);

  // Reachability + acyclicity. A cycle is refused outright: looping execution is not a supported
  // workflow shape, and accepting one would let a definition run forever.
  const reachable = new Set();
  const stack = [String(def.entry_step || "")];
  while (stack.length) {
    const id = stack.pop();
    if (!byId.has(id) || reachable.has(id)) continue;
    reachable.add(id);
    for (const t of edges.get(id) || []) stack.push(t);
  }
  if (def.on_failure && byId.has(String(def.on_failure))) {
    const hook = [String(def.on_failure)];
    while (hook.length) {
      const id = hook.pop();
      if (!byId.has(id) || reachable.has(id)) continue;
      reachable.add(id);
      for (const t of edges.get(id) || []) hook.push(t);
    }
  }
  const unreachable = [...byId.keys()].filter((id) => !reachable.has(id));
  add("reachability", unreachable.length === 0, unreachable.length ? `unreachable step(s): ${unreachable.join(", ")}` : "every step is reachable from the entry step");

  const state = new Map();
  const cycles = [];
  const walk = (id, path) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") { cycles.push(`${path.join(" → ")} → ${id}`); return; }
    state.set(id, "open");
    for (const t of edges.get(id) || []) walk(t, [...path, id]);
    state.set(id, "done");
  };
  for (const id of byId.keys()) walk(id, []);
  add("acyclic", cycles.length === 0, cycles.slice(0, 3).join(" | ") || "the execution graph is acyclic");

  // Every path must end at a terminal step, so a run can never "finish" in an undefined state.
  const terminating = steps.some((s) => TERMINAL_TYPES.has(String(s.type)));
  add("terminal_steps", terminating, terminating ? "the workflow declares a terminal outcome" : "add a complete or fail step");

  const failed = checks.filter((c) => !c.ok);
  return { ok: failed.length === 0, contract_version: WORKFLOW_CONTRACT_VERSION, checks, failed_checks: failed.map((c) => c.name), errors: failed.map((c) => `${c.name}: ${c.detail}`) };
}

/** Whether a dispatched event matches a finalized definition's trigger. */
export function triggerMatches(def, { source, event = null, entity = null, operation = null }) {
  const t = def.trigger || {};
  if (String(t.type) !== String(source)) return false;
  if (source === "entity_event") {
    return String(t.entity) === String(entity) && (Array.isArray(t.operations) ? t.operations : []).map(String).includes(String(operation));
  }
  if (source === "webhook" || source === "app_event") return String(t.event) === String(event);
  // A connector trigger matches the connector identifier AND the event name; both are required
  // by validation, so a definition without them never finalizes and can never match a dispatch.
  if (source === "connector") return String(t.connector) === String(entity) && String(t.event) === String(event);
  return true;
}

/** The public, credential-free description of the workflow contract. */
export const describeWorkflowContract = () => ({
  contract_version: WORKFLOW_CONTRACT_VERSION,
  step_types: WORKFLOW_STEP_TYPES,
  trigger_types: WORKFLOW_TRIGGER_TYPES,
  run_statuses: WORKFLOW_RUN_STATUSES,
  condition_operators: CONDITION_OPS,
  limits: WORKFLOW_LIMITS,
  step_defaults: STEP_DEFAULTS,
  guarantees: {
    durable: "run state is persisted after every transition and resumed by the existing job queue",
    delays: "a delay parks the run in WAITING and holds no worker",
    idempotency: "every side-effecting step carries a deterministic operation key and is never executed twice",
    retries: "bounded per-step retries; authorization, validation and policy failures are never retried",
    versioning: "a run executes the exact finalized version that started it",
    reuse: "primitives (#27), the job queue, the scheduler, webhooks, tracing, audit and billing are the platform's existing systems",
    no_llm_control_flow: "conditions are deterministic; AI runs only where a step explicitly invokes an AI primitive",
  },
});