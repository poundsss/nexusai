// THE analytics event contract for generated applications (#30).
//
// Dependency-light on purpose: validation, bounding, credential policy and redaction live here, so
// every ingestion path (public runtime, generated server-side code, queued continuation) enforces
// the SAME rules and no caller can widen them. Nothing in this module talks to storage.
import { scrub, scrubText } from "./tracing.ts";

export const ANALYTICS_CONTRACT_VERSION = "nexusai-app-analytics-1";
export const ANALYTICS_QUEUE = "analytics";
export const ANALYTICS_JOB_TYPE = "analytics.ingest";

export const EVENT_TYPES = Object.freeze([
  "page_view", "session_start", "session_end", "user_action", "conversion", "error", "performance", "custom_event",
]);
export const ENVIRONMENTS = Object.freeze(["development", "staging", "production"]);

export const ANALYTICS_LIMITS = Object.freeze({
  event_name_chars: 80,
  page_chars: 300,
  max_properties: 50,
  property_key_chars: 60,
  property_value_chars: 500,
  max_event_bytes: 8192,
  max_batch: 50,
  max_range_days: 90,
  max_query_limit: 500,
  max_scan: 5000,
  scan_page: 500,
  clock_skew_ms: 24 * 60 * 60 * 1000,
});

// Keys that look like a credential. A value under one of these is NEVER stored: the event is
// either refused (default) or the key is redacted, per the project's configured policy.
const CREDENTIAL_KEY_RE = /(pass(word|phrase)?|secret|token|api[_-]?key|apikey|auth(oriz(ation|ed))?|credential|private[_-]?key|bearer|cookie|session[_-]?key|access[_-]?key|client[_-]?secret|signature)/i;
// Values that look like a credential even under an innocent key (JWTs, provider key prefixes).
const CREDENTIAL_VALUE_RE = /^(eyJ[A-Za-z0-9_-]{10,}\.|sk-|sk_live_|sk_test_|whsec_|ghp_|xox[baprs]-|AKIA[0-9A-Z]{12,}|-----BEGIN )/;

export const isCredentialKey = (key) => CREDENTIAL_KEY_RE.test(String(key));
export const looksLikeCredential = (value) => typeof value === "string" && CREDENTIAL_VALUE_RE.test(value.trim());

export class EventRejected extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EventRejected";
    this.code = code;
    this.status = code === "ANALYTICS_FORBIDDEN" ? 403 : 400;
    this.details = details;
  }
}
const reject = (code, message, details) => { throw new EventRejected(code, message, details); };

export const ANALYTICS_DEFAULTS = Object.freeze({
  enabled: true, require_registered_schemas: false, credential_policy: "reject",
  suppressed_properties: [], retention_days: 90, allow_platform_intelligence: false,
});

export const normalizeConfig = (row) => ({
  ...ANALYTICS_DEFAULTS,
  ...(row || {}),
  suppressed_properties: (row?.suppressed_properties || []).map((k) => String(k).toLowerCase()),
  credential_policy: row?.credential_policy === "redact" ? "redact" : "reject",
  retention_days: Number.isFinite(Number(row?.retention_days)) ? Number(row.retention_days) : ANALYTICS_DEFAULTS.retention_days,
});

/**
 * Validates and bounds one event's properties.
 *
 * Primitive values only (string / number / boolean / null): an object or array would be an
 * unbounded payload wearing a property's clothes. Strings are scrubbed through the platform's
 * EXISTING redactor and truncated, credential-like keys and values follow the project's policy,
 * and explicitly suppressed keys are dropped with the omission recorded.
 */
export function sanitizeProperties(input, config, { schema = null } = {}) {
  if (input === null || input === undefined) return { properties: {}, redactions: [] };
  if (typeof input !== "object" || Array.isArray(input)) reject("ANALYTICS_PROPERTIES_INVALID", "Event properties must be an object of primitive values");
  const entries = Object.entries(input);
  if (entries.length > ANALYTICS_LIMITS.max_properties) {
    reject("ANALYTICS_TOO_MANY_PROPERTIES", `An event may carry at most ${ANALYTICS_LIMITS.max_properties} properties (got ${entries.length})`, { count: entries.length });
  }
  const properties = {};
  const redactions = [];
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey).slice(0, ANALYTICS_LIMITS.property_key_chars);
    if (config.suppressed_properties.includes(key.toLowerCase())) { redactions.push(key); continue; }
    if (isCredentialKey(key) || looksLikeCredential(rawValue)) {
      if (config.credential_policy === "reject") {
        reject("ANALYTICS_CREDENTIAL_PROPERTY", `Property "${key}" looks like a credential and is not accepted by analytics`, { property: key });
      }
      redactions.push(key);
      continue;
    }
    if (rawValue === null || rawValue === undefined) { properties[key] = null; continue; }
    if (typeof rawValue === "object") {
      reject("ANALYTICS_PROPERTY_TYPE", `Property "${key}" must be a string, number or boolean`, { property: key, got: Array.isArray(rawValue) ? "array" : "object" });
    }
    if (typeof rawValue === "number") {
      if (!Number.isFinite(rawValue)) reject("ANALYTICS_PROPERTY_TYPE", `Property "${key}" must be a finite number`, { property: key });
      properties[key] = rawValue;
      continue;
    }
    if (typeof rawValue === "boolean") { properties[key] = rawValue; continue; }
    properties[key] = scrubText(String(rawValue), ANALYTICS_LIMITS.property_value_chars);
  }
  // Registered schema: declared types are enforced, and a strict schema refuses undeclared keys.
  if (schema) {
    const types = schema.property_types || {};
    for (const name of schema.required_properties || []) {
      if (properties[name] === undefined || properties[name] === null) {
        reject("ANALYTICS_SCHEMA_VIOLATION", `Event "${schema.event_name}" v${schema.event_version} requires property "${name}"`, { property: name });
      }
    }
    for (const [name, value] of Object.entries(properties)) {
      const expected = types[name];
      if (!expected) {
        if (schema.strict) reject("ANALYTICS_SCHEMA_VIOLATION", `Property "${name}" is not declared by event "${schema.event_name}" v${schema.event_version}`, { property: name });
        continue;
      }
      if (value !== null && typeof value !== expected) {
        reject("ANALYTICS_SCHEMA_VIOLATION", `Property "${name}" must be a ${expected}`, { property: name, expected, got: typeof value });
      }
    }
  }
  return { properties: scrub(properties), redactions: [...new Set(redactions)] };
}

const identifier = (v, max = 120) => {
  const s = String(v || "").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Normalizes one submitted event into the canonical model, refusing anything malformed,
 * oversized, mis-typed or outside a supported schema version.
 *
 * OWNERSHIP IS NOT AN INPUT: project_id, workspace_id, app_user_id, team_id, source and
 * environment are supplied by the resolved server-side context, so a client cannot claim them.
 */
export function buildEvent({ context, input = {}, config, schema = null, now = Date.now() }) {
  if (!config.enabled) reject("ANALYTICS_DISABLED", "Analytics is disabled for this application");
  const event_name = identifier(input.event_name, ANALYTICS_LIMITS.event_name_chars);
  if (!event_name) reject("ANALYTICS_EVENT_NAME_REQUIRED", "event_name is required");
  const event_type = EVENT_TYPES.includes(String(input.event_type)) ? String(input.event_type) : (schema?.event_type || "custom_event");
  const event_version = schema ? schema.event_version : (Number.isFinite(Number(input.event_version)) ? Math.floor(Number(input.event_version)) : 1);
  if (event_version < 1) reject("ANALYTICS_VERSION_INVALID", "event_version must be a positive integer");
  const { properties, redactions } = sanitizeProperties(input.properties, config, { schema });

  // The submitter's clock is accepted only inside a sane window; anything else uses the server's.
  const submitted = Date.parse(input.occurred_at || "");
  const occurred_at = Number.isFinite(submitted) && Math.abs(submitted - now) <= ANALYTICS_LIMITS.clock_skew_ms
    ? new Date(submitted).toISOString()
    : new Date(now).toISOString();

  const event = {
    project_id: context.project_id,
    workspace_id: context.workspace_id || null,
    event_id: crypto.randomUUID(),
    event_name, event_type, event_version,
    schema_id: schema?.id || null,
    environment: context.environment,
    app_user_id: context.app_user_id || null,
    anonymous_id: context.anonymous_id || null,
    session_id: context.session_id || null,
    team_id: context.team_id || null,
    page: identifier(input.page ?? input.screen, ANALYTICS_LIMITS.page_chars),
    source: context.source,
    occurred_at, ingested_at: new Date(now).toISOString(),
    properties, redactions,
    error_code: event_type === "error" ? identifier(input.error_code, 80) : null,
    error_category: event_type === "error" ? identifier(input.error_category, 60) : null,
    duration_ms: Number.isFinite(Number(input.duration_ms)) ? Math.max(0, Math.round(Number(input.duration_ms))) : null,
    conversion_value: event_type === "conversion" && Number.isFinite(Number(input.conversion_value)) ? Number(input.conversion_value) : null,
    trace_id: context.trace_id || identifier(input.trace_id, 80),
    run_id: context.run_id || identifier(input.run_id, 80),
    ingestion_key: identifier(input.ingestion_key ?? input.idempotency_key, 200),
    consent: { project_id: context.project_id, allow_platform_intelligence: !!config.allow_platform_intelligence, contract_version: ANALYTICS_CONTRACT_VERSION },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
  if (bytes > ANALYTICS_LIMITS.max_event_bytes) {
    reject("ANALYTICS_EVENT_TOO_LARGE", `An event may be at most ${ANALYTICS_LIMITS.max_event_bytes} bytes (got ${bytes})`, { bytes });
  }
  return event;
}

/** The caller-safe projection of a stored event. */
export const publicEvent = (e) => ({
  event_id: e.event_id, event_name: e.event_name, event_type: e.event_type, event_version: e.event_version,
  environment: e.environment, app_user_id: e.app_user_id || null, anonymous_id: e.anonymous_id || null,
  session_id: e.session_id || null, team_id: e.team_id || null, page: e.page || null, source: e.source,
  occurred_at: e.occurred_at || e.created_date, ingested_at: e.ingested_at || e.created_date,
  properties: e.properties || {}, redactions: e.redactions || [],
  error_code: e.error_code || null, error_category: e.error_category || null,
  duration_ms: e.duration_ms ?? null, conversion_value: e.conversion_value ?? null,
  trace_id: e.trace_id || null, run_id: e.run_id || null, ingestion_key: e.ingestion_key || null,
});

export const publicSession = (s) => ({
  session_id: s.id, session_key: s.session_key, project_id: s.project_id,
  app_user_id: s.app_user_id || null, anonymous_id: s.anonymous_id || null, team_id: s.team_id || null,
  environment: s.environment, status: s.status, started_at: s.started_at || s.created_date,
  last_seen_at: s.last_seen_at || null, ended_at: s.ended_at || null,
  duration_ms: s.duration_ms ?? null, event_count: s.event_count || 0, entry_page: s.entry_page || null,
  identity_linked_at: s.identity_linked_at || null,
});

/** Normalizes and BOUNDS a query window: no query may scan an unbounded time range. */
export function boundRange({ from = null, to = null, now = Date.now(), max_days = ANALYTICS_LIMITS.max_range_days } = {}) {
  const maxMs = max_days * 86400000;
  const end = Number.isFinite(Date.parse(to || "")) ? Date.parse(to) : now;
  const requested = Number.isFinite(Date.parse(from || "")) ? Date.parse(from) : end - 7 * 86400000;
  const start = Math.max(requested, end - maxMs);
  if (start > end) reject("ANALYTICS_RANGE_INVALID", "The query range ends before it starts");
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), days: Math.round((end - start) / 86400000), truncated: requested < start };
}

export const boundLimit = (v, fallback = 100) => Math.min(Math.max(1, Number(v) || fallback), ANALYTICS_LIMITS.max_query_limit);
export const assertEnvironment = (v) => {
  const env = String(v || "production");
  if (!ENVIRONMENTS.includes(env)) reject("ANALYTICS_ENVIRONMENT_INVALID", `environment must be one of ${ENVIRONMENTS.join(", ")}`);
  return env;
};

export const describeAnalyticsContract = () => Object.freeze({
  contract_version: ANALYTICS_CONTRACT_VERSION,
  event_types: [...EVENT_TYPES], environments: [...ENVIRONMENTS], limits: { ...ANALYTICS_LIMITS },
  client_api: ["trackEvent", "startSession", "endSession", "getCurrentSession", "linkIdentity"],
  operator_api: ["queryEvents", "aggregate", "funnel", "retention", "errors", "export", "config", "schemas"],
  permissions: ["analytics.read", "analytics.export", "analytics.manage"],
  never_stored: ["passwords", "tokens", "api keys", "authorization headers", "platform secrets", "raw stack traces"],
  intelligence_boundary: "events carry project ownership + consent metadata; nothing is fed into Trajectory, Dataset, Memory or training",
});