// Backend Connector Automations (Base44 parity gap closure): a generated backend function can
// subscribe to a managed connector event through its OWN `export const config` —
//   automations: [{ type: "connector", name, integration_type, events, trigger_conditions, is_active }]
// — and the SAME verified, already-deduplicated connector delivery that drives Workflow dispatch
// also invokes every matching, active function automation.
//
// Contract implemented (DOCUMENTED Base44 — developers/backend/resources/backend-functions/automations):
//   • matching invokes the generated function with trigger_conditions as field/operator/value
//     pairs, `logic` "and" (default) or "or", fields addressing dot-paths into payload.data;
//   • the documented 16 operators: equals, not_equals, contains, not_contains, starts_with,
//     ends_with, gt, gte, lt, lte, in_list, not_in_list, exists, not_exists, is_empty, is_not_empty;
//   • the handler's request body carries { payload: { event: { type, integration_type }, data,
//     payload_too_large }, args: {} } — the function reads body.payload.data / body.payload.event.*;
//   • a delivery whose serialized payload exceeds PAYLOAD_TOO_LARGE_BYTES (~200 KB per the docs;
//     exactly 200,000 here) projects payload.data = null + payload_too_large = true;
//   • Slack and Slack Bot automations REQUIRE trigger conditions (fail closed without them).
//
// Deliberately NOT here: a second connector ingestion system (this rides the ONE post-verification
// choke point in managedConnectorIngest), a second idempotency system (the ingest's replay claim
// already covers both targets; the job adds its own key), jq conditions (evalJqCondition is a
// DIFFERENT, workflow-only contract), any handler-input surface beyond the documented envelope,
// and any change to Workflow dispatch, connector receivers or the function executor core.
import { loadProjectFunction, readFunctionConfig, executeProjectFunction } from "./functionRuntime.ts";
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";
import { unpackFileContent } from "./blobStore.ts";
import { loadProjectIntegrations } from "./integrations.ts";
import { enqueue, queueConfig } from "./jobQueue.ts";
import { log } from "./observability.ts";

// The implementation threshold (docs say "about 200 KB"): serialized payload characters.
export const PAYLOAD_TOO_LARGE_BYTES = 200000;
export const AUTOMATION_QUEUE = "webhooks";
export const AUTOMATION_JOB_TYPE = "automation.deliver";
export const AUTOMATION_TRIGGER = "automation";

// Connectors whose function automations REQUIRE trigger conditions (DOCUMENTED Base44).
const CONDITIONS_REQUIRED = new Set(["slack", "slackbot"]);

/**
 * Projects the automation-side delivery from the dispatched connector payload.
 * `payload.data` is the provider's raw data as the receiver delivered it; for the gmail/mailbox
 * enrichment the platform lives under `trigger.data` (the shape jq conditions reference), so the
 * enriched trigger data IS the automation's payload.data — that is exactly how the documented
 * `has_new_messages` condition becomes addressable. Workflow payloads are untouched (their own
 * engine bound applies inside emitConnector, unchanged).
 */
export function automationDeliveryFromPayload(dispatchedPayload) {
  let serialized = "";
  try { serialized = JSON.stringify(dispatchedPayload ?? null) || ""; } catch { serialized = ""; }
  const payload_too_large = serialized.length > PAYLOAD_TOO_LARGE_BYTES;
  const triggerData = dispatchedPayload && typeof dispatchedPayload === "object" && !Array.isArray(dispatchedPayload)
    && dispatchedPayload.trigger && typeof dispatchedPayload.trigger === "object" && dispatchedPayload.trigger.data
    ? dispatchedPayload.trigger.data
    : dispatchedPayload;
  return {
    data: payload_too_large ? null : (triggerData === undefined ? null : triggerData),
    payload_too_large,
    serialized_bytes: serialized.length,
  };
}

// Dot-separated path lookup (undefined for a missing path — never throws).
function dotGet(obj, path) {
  let acc = obj;
  for (const k of String(path || "").split(".").filter(Boolean)) {
    if (acc === null || typeof acc !== "object") return undefined;
    acc = acc[k];
  }
  return acc;
}

function isEmptyValue(v) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** ONE documented condition: field (dot-path into payload.data), operator, value. Fails closed. */
export function evalAutomationCondition(cond, data) {
  const op = String(cond && cond.operator || "");
  const actual = dotGet(data, cond && cond.field);
  const value = cond ? cond.value : undefined;
  switch (op) {
    case "equals": return actual === value;
    case "not_equals": return actual !== value;
    case "contains": return actual != null && String(actual).includes(String(value));
    case "not_contains": return actual != null && !String(actual).includes(String(value));
    case "starts_with": return typeof actual === "string" && actual.startsWith(String(value));
    case "ends_with": return typeof actual === "string" && actual.endsWith(String(value));
    case "gt": case "gte": case "lt": case "lte": {
      const a = Number(actual), b = Number(value);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    case "in_list": return Array.isArray(value) && value.includes(actual);
    case "not_in_list": return Array.isArray(value) && !value.includes(actual);
    case "exists": return actual !== undefined;
    case "not_exists": return actual === undefined;
    case "is_empty": return isEmptyValue(actual);
    case "is_not_empty": return !isEmptyValue(actual);
    default: return false; // an unknown/malformed condition never matches (fail closed)
  }
}

/** The documented trigger_conditions object: { logic: "and"|"or", conditions: [...] }. Absent matches. */
export function automationConditionsMatch(trigger_conditions, data) {
  if (!trigger_conditions || typeof trigger_conditions !== "object" || Array.isArray(trigger_conditions)) return true;
  const list = Array.isArray(trigger_conditions.conditions) ? trigger_conditions.conditions : [];
  if (!list.length) return true;
  const logic = trigger_conditions.logic === "or" ? "or" : "and";
  return logic === "or"
    ? list.some((c) => evalAutomationCondition(c, data))
    : list.every((c) => evalAutomationCondition(c, data));
}

/** One config.automations entry against the delivered connector/event. Fails closed. */
function automationMatches(a, { connector, event }) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  if (a.type !== "connector") return false;
  if (a.is_active === false) return false;
  if (String(a.integration_type || "") !== String(connector)) return false;
  if (!Array.isArray(a.events) || !a.events.map(String).includes(String(event))) return false;
  if (CONDITIONS_REQUIRED.has(String(connector)) && !(a.trigger_conditions
    && typeof a.trigger_conditions === "object" && Array.isArray(a.trigger_conditions.conditions)
    && a.trigger_conditions.conditions.length)) return false;
  return true;
}

/**
 * Dispatches ONE verified connector delivery to every matching, active function automation of
 * THIS project, enqueuing one durable job per (function, automation, delivery). Workflow dispatch
 * is untouched; a failure here never affects the workflow result. Idempotency: the ingest's
 * replay claim covers the delivery; the job's idempotency key additionally protects the enqueue.
 */
export async function dispatchConnectorAutomations(svc, {
  project, connector, event, delivery = null, delivery_id = null, trace_id = null,
} = {}) {
  if (!project || !connector || !event) return { matched: 0, dispatched: 0, functions_scanned: 0 };
  const files = await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 500).catch(() => []);
  const fnRows = files.filter((r) => isFunctionPath(r.path));
  if (!fnRows.length) return { matched: 0, dispatched: 0, functions_scanned: 0 };
  const cfg = queueConfig(AUTOMATION_QUEUE);
  let matched = 0, dispatched = 0;
  for (const row of fnRows) {
    let config = null;
    try {
      const source = await unpackFileContent(row);
      config = (await readFunctionConfig(source, { timeoutMs: 5000 })).config || {};
    } catch { continue; } // an unreadable/broken function never blocks the delivery
    const name = functionNameFromPath(row.path);
    const automations = Array.isArray(config.automations) ? config.automations : [];
    for (const a of automations) {
      if (!automationMatches(a, { connector, event })) continue;
      // Conditions address fields under payload.data (the projected automation delivery).
      if (!automationConditionsMatch(a.trigger_conditions, delivery ? delivery.data : null)) continue;
      matched += 1;
      const automationName = String(a.name || "unnamed");
      const { job, duplicate } = await enqueue(svc, {
        queue: AUTOMATION_QUEUE, job_type: AUTOMATION_JOB_TYPE,
        payload: {
          project_id: project.id, workspace_id: project.workspace_id, function_name: name,
          automation_name: automationName, connector, event,
          data: delivery ? delivery.data : null, payload_too_large: !!(delivery && delivery.payload_too_large),
          delivery_id: delivery_id || null, trace_id: trace_id || null,
        },
        idempotency_key: `${AUTOMATION_JOB_TYPE}:${project.id}:${name}:${automationName}:${delivery_id || ""}`,
        workspace_id: project.workspace_id, project_id: project.id,
        max_attempts: cfg.max_attempts, delay_ms: 0, trace_id,
      });
      if (!duplicate) dispatched += 1;
    }
  }
  if (matched) log("info", "connector_automations.dispatched", {
    project_id: project.id, connector, event, matched, dispatched, trace_id: trace_id || null,
  });
  return { matched, dispatched, functions_scanned: fnRows.length };
}

/**
 * The queue handler's work (registered as AUTOMATION_JOB_TYPE in jobHandlers): executes the
 * generated function through the EXISTING executor with the documented envelope as the request
 * body. Project isolation is by construction (the payload's project row is re-resolved and the
 * executor is project-scoped); the trigger is recorded as AUTOMATION_TRIGGER on the invocation.
 * A 5xx (thrown handler) retries with the queue's backoff, then dead-letters — the same
 * machinery as webhook.deliver. A 4xx is the function's own considered answer: delivered.
 */
export async function deliverConnectorAutomation(base44, payload) {
  const svc = base44.asServiceRole || base44;
  const pid = String((payload && payload.project_id) || "");
  const name = String((payload && payload.function_name) || "");
  if (!pid || !name) {
    throw Object.assign(new Error("Automation delivery payload requires project_id and function_name"),
      { retryable: false, code: "INVALID_PAYLOAD" });
  }
  const project = await svc.entities.Project.get(pid).catch(() => null);
  if (!project) {
    throw Object.assign(new Error("Automation target project no longer exists"),
      { retryable: false, code: "PROJECT_NOT_FOUND" });
  }
  const request = {
    method: "POST", query: {}, headers: {},
    body: {
      payload: {
        event: { type: String((payload && payload.event) || ""), integration_type: String((payload && payload.connector) || "") },
        data: payload && payload.data !== undefined ? payload.data : null,
        payload_too_large: !!(payload && payload.payload_too_large),
      },
      args: {},
    },
  };
  const { source } = await loadProjectFunction(svc, project.id, name);
  const entities = (await svc.entities.AppEntity.filter({ project_id: project.id }, "name", 200))
    .map((e) => ({ id: e.id, name: e.name, fields: e.fields || {} }));
  const integrations = await loadProjectIntegrations(svc, project.id);
  const result = await executeProjectFunction(svc, {
    project, entities, integrations, name, source,
    trigger: AUTOMATION_TRIGGER, requestId: crypto.randomUUID(), request,
    user: null, session: null, trace_id: (payload && payload.trace_id) || null,
  });
  if (result.status >= 500) {
    throw Object.assign(new Error(`Automation function "${name}" failed with status ${result.status}`),
      { code: "AUTOMATION_DELIVERY_FAILED" });
  }
  return { project_id: project.id, name, status: result.status, body: result.body === undefined ? null : result.body };
}