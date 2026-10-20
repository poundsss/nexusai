// THE canonical primitive contract registry (#27).
//
// A primitive is a reusable PLATFORM capability a generated application may invoke without ever
// touching provider credentials, network policy or runtime internals. This module is the single
// declaration of what those capabilities are; it holds no execution logic, no provider handle and
// no credential, so the contract can be read, published and versioned on its own.
//
// Two properties matter most and are structural, not documentation:
//   • VERSIONED + IMMUTABLE — every entry is deep-frozen. A contract change is a NEW version
//     under the same name, so an existing generated app pinned to 1.0.0 cannot silently change
//     behaviour when 1.1.0 lands beside it.
//   • COST-HONEST — each primitive states its cost class and whether it can consume AI credits.
//     Search, email, notification, background jobs and schedules are explicitly NOT AI usage and
//     are governed by the platform's existing plan/usage rules instead.
export const PRIMITIVE_CONTRACT_VERSION = "nexusai-primitives-1";

/** Error categories every primitive failure is classified into. */
export const ERROR_CATEGORIES = ["validation", "authorization", "not_found", "rate_limit", "provider", "timeout", "conflict", "internal"];
/** Only a failure that is a property of the MOMENT is retryable. */
export const RETRYABLE_CATEGORIES = ["rate_limit", "provider", "timeout"];
export const COST_CLASSES = ["ai", "platform", "external"];
export const EXECUTION_MODES = ["sync", "async"];

export const PRIMITIVE_LIMITS = {
  prompt_chars: 20000,
  text_chars: 60000,
  output_chars: 200000,
  search_limit: 100,
  search_fields: 10,
  idempotency_key_chars: 200,
};

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

// --- schema validation -------------------------------------------------------------
// A deliberately small, explicit validator: object/string/number/boolean/array/any, with
// required fields, enums, bounds and `additionalProperties: false`. Validation runs BEFORE any
// execution, so an invalid call never reaches a provider, a queue or the database.
export function validateAgainstSchema(schema, value, path = "input") {
  const errors = [];
  const walk = (s, v, p) => {
    if (!s || s.type === "any") return;
    if (v === undefined || v === null) {
      if (s.default !== undefined || s.nullable) return;
      errors.push(`${p} is required`);
      return;
    }
    switch (s.type) {
      case "object": {
        if (typeof v !== "object" || Array.isArray(v)) { errors.push(`${p} must be an object`); return; }
        const props = s.properties || {};
        for (const key of s.required || []) {
          if (v[key] === undefined || v[key] === null || v[key] === "") errors.push(`${p}.${key} is required`);
        }
        if (s.additionalProperties === false) {
          for (const key of Object.keys(v)) if (!props[key]) errors.push(`${p}.${key} is not an accepted field`);
        }
        for (const [key, sub] of Object.entries(props)) {
          if (v[key] === undefined || v[key] === null) continue;
          walk(sub, v[key], `${p}.${key}`);
        }
        return;
      }
      case "array": {
        if (!Array.isArray(v)) { errors.push(`${p} must be an array`); return; }
        if (s.minItems && v.length < s.minItems) errors.push(`${p} needs at least ${s.minItems} item(s)`);
        if (s.maxItems && v.length > s.maxItems) errors.push(`${p} accepts at most ${s.maxItems} item(s)`);
        if (s.items) v.forEach((item, i) => walk(s.items, item, `${p}[${i}]`));
        return;
      }
      case "string": {
        if (typeof v !== "string") { errors.push(`${p} must be a string`); return; }
        if (s.enum && !s.enum.includes(v)) errors.push(`${p} must be one of ${s.enum.join(", ")}`);
        if (s.minLength && v.length < s.minLength) errors.push(`${p} must be at least ${s.minLength} character(s)`);
        if (s.maxLength && v.length > s.maxLength) errors.push(`${p} exceeds ${s.maxLength} characters`);
        return;
      }
      case "number": {
        if (typeof v !== "number" || !Number.isFinite(v)) { errors.push(`${p} must be a number`); return; }
        if (s.integer && !Number.isInteger(v)) errors.push(`${p} must be an integer`);
        if (s.minimum !== undefined && v < s.minimum) errors.push(`${p} must be >= ${s.minimum}`);
        if (s.maximum !== undefined && v > s.maximum) errors.push(`${p} must be <= ${s.maximum}`);
        return;
      }
      case "boolean":
        if (typeof v !== "boolean") errors.push(`${p} must be true or false`);
        return;
      default:
        return;
    }
  };
  walk(schema, value, path);
  return { ok: errors.length === 0, errors: errors.slice(0, 12) };
}

/** Applies a schema's declared defaults, so a primitive never has to guess an omitted value. */
export function applyDefaults(schema, value) {
  if (!schema || schema.type !== "object") return value;
  const out = { ...(value || {}) };
  for (const [key, sub] of Object.entries(schema.properties || {})) {
    if (out[key] === undefined && sub && sub.default !== undefined) out[key] = sub.default;
  }
  return out;
}

// --- the registry ------------------------------------------------------------------

const OK_ENVELOPE = { type: "object", properties: {}, additionalProperties: true };

const AI_ERRORS = ["PRIMITIVE_INPUT_INVALID", "PRIMITIVE_FORBIDDEN", "MODEL_UNAVAILABLE", "PROVIDER_TIMEOUT", "INSUFFICIENT_CREDITS", "BUDGET_EXCEEDED"];

const RAW_PRIMITIVES = [
  {
    name: "InvokeAI",
    version: "1.0.0",
    description: "Runs a bounded language-model call through the platform's existing Model Gateway. Provider-neutral: the caller asks for a quality tier, the gateway's router picks a compatible, affordable model and applies the existing retry/fallback policy.",
    capability: "project.write",
    cost_class: "ai",
    consumes_ai_credits: true,
    ai_charge_path: "ai_operation",
    external_provider: "model_gateway",
    execution_mode: "sync",
    side_effect: false,
    timeout_ms: 60000,
    retry: { max_attempts: 2, policy: "model_gateway", retryable_error_codes: ["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"] },
    idempotency: { supported: true, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: PRIMITIVE_LIMITS.prompt_chars },
        system: { type: "string", maxLength: 4000 },
        quality: { type: "string", enum: ["fast", "standard", "advanced"], default: "standard" },
        max_output_tokens: { type: "number", integer: true, minimum: 1, maximum: 8000, default: 1200 },
      },
    },
    output_schema: {
      type: "object", additionalProperties: true, required: ["text"],
      properties: { text: { type: "string" }, model_id: { type: "string" }, provider: { type: "string" }, truncated: { type: "boolean" } },
    },
    error_codes: AI_ERRORS,
  },
  {
    // 1.1.0 ADDS structured JSON output. A new capability is a new version, never an edit of 1.0.0.
    name: "InvokeAI",
    version: "1.1.0",
    description: "InvokeAI with optional structured JSON output. Adds `response_schema`; 1.0.0 behaviour is unchanged and still available.",
    capability: "project.write",
    cost_class: "ai",
    consumes_ai_credits: true,
    ai_charge_path: "ai_operation",
    external_provider: "model_gateway",
    execution_mode: "sync",
    side_effect: false,
    timeout_ms: 60000,
    retry: { max_attempts: 2, policy: "model_gateway", retryable_error_codes: ["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"] },
    idempotency: { supported: true, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: PRIMITIVE_LIMITS.prompt_chars },
        system: { type: "string", maxLength: 4000 },
        quality: { type: "string", enum: ["fast", "standard", "advanced"], default: "standard" },
        max_output_tokens: { type: "number", integer: true, minimum: 1, maximum: 8000, default: 1200 },
        response_schema: { type: "object", additionalProperties: true },
      },
    },
    output_schema: {
      type: "object", additionalProperties: true,
      properties: { text: { type: "string" }, data: { type: "object", additionalProperties: true }, model_id: { type: "string" }, provider: { type: "string" } },
    },
    error_codes: AI_ERRORS,
  },
  {
    name: "GenerateImage",
    version: "1.0.0",
    description: "Generates an image through the platform's existing image provider. The prompt is validated and bounded server-side and only a stored image URL crosses back to the app.",
    capability: "project.write",
    cost_class: "ai",
    consumes_ai_credits: true,
    // Charged by the platform integration itself — this primitive opens no second billable operation.
    ai_charge_path: "platform_integration_credits",
    external_provider: "platform_image",
    execution_mode: "sync",
    side_effect: false,
    timeout_ms: 60000,
    retry: { max_attempts: 1, policy: "none", retryable_error_codes: ["PROVIDER_TIMEOUT"] },
    idempotency: { supported: true, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 3, maxLength: 4000 },
        reference_urls: { type: "array", maxItems: 3, items: { type: "string", maxLength: 2000 } },
      },
    },
    output_schema: { type: "object", additionalProperties: true, required: ["url"], properties: { url: { type: "string" }, provider: { type: "string" } } },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "PRIMITIVE_FORBIDDEN", "PROVIDER_ERROR", "PROVIDER_TIMEOUT"],
  },
  {
    name: "ExtractStructuredData",
    version: "1.0.0",
    description: "Extracts a DECLARED schema from text or from a project file. The extracted object is validated against the caller's own schema, so an incomplete or malformed extraction fails explicitly instead of returning a plausible-looking partial result.",
    capability: "project.write",
    cost_class: "ai",
    consumes_ai_credits: true,
    ai_charge_path: "ai_operation",
    external_provider: "model_gateway",
    execution_mode: "sync",
    side_effect: false,
    timeout_ms: 60000,
    retry: { max_attempts: 2, policy: "model_gateway", retryable_error_codes: ["PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"] },
    idempotency: { supported: true, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["schema"],
      properties: {
        text: { type: "string", maxLength: PRIMITIVE_LIMITS.text_chars },
        file_id: { type: "string", maxLength: 120 },
        schema: { type: "object", additionalProperties: true },
        instructions: { type: "string", maxLength: 2000 },
      },
    },
    output_schema: { type: "object", additionalProperties: true, required: ["data"], properties: { data: { type: "object", additionalProperties: true }, source: { type: "string" } } },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "EXTRACTION_INVALID", "PRIMITIVE_FORBIDDEN", "FILE_NOT_FOUND", "PROVIDER_TIMEOUT"],
  },
  {
    name: "FileProcess",
    version: "1.0.0",
    description: "Reads metadata, mints a short-lived signed URL, or extracts text from ONE file that belongs to the invoking project. There is no filesystem path input and no way to address a file outside the project's own storage.",
    capability: "project.read",
    cost_class: "platform",
    consumes_ai_credits: false,
    ai_charge_path: null,
    external_provider: null,
    execution_mode: "sync",
    side_effect: false,
    timeout_ms: 20000,
    retry: { max_attempts: 1, policy: "none", retryable_error_codes: [] },
    idempotency: { supported: false, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["file_id", "operation"],
      properties: {
        file_id: { type: "string", minLength: 1, maxLength: 120 },
        operation: { type: "string", enum: ["metadata", "signed_url", "extract_text"] },
        max_chars: { type: "number", integer: true, minimum: 1, maximum: PRIMITIVE_LIMITS.text_chars, default: 20000 },
      },
    },
    output_schema: { type: "object", additionalProperties: true, required: ["file"], properties: { file: { type: "object", additionalProperties: true }, url: { type: "string" }, text: { type: "string" }, truncated: { type: "boolean" } } },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "FILE_NOT_FOUND", "FILE_TYPE_UNSUPPORTED", "PRIMITIVE_FORBIDDEN"],
  },
  {
    name: "Search",
    version: "1.0.0",
    description: "Searches the invoking project's own application data. Results are bounded and paginated deterministically (stable order + offset), the entity must be one the project declares, and no other project's records are reachable. This primitive performs no web access.",
    capability: "project.read",
    cost_class: "platform",
    consumes_ai_credits: false,
    ai_charge_path: null,
    external_provider: null,
    execution_mode: "sync",
    side_effect: false,
    timeout_ms: 20000,
    retry: { max_attempts: 1, policy: "none", retryable_error_codes: [] },
    idempotency: { supported: false, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["entity"],
      properties: {
        source: { type: "string", enum: ["app_data"], default: "app_data" },
        entity: { type: "string", minLength: 1, maxLength: 80 },
        query: { type: "string", maxLength: 500 },
        fields: { type: "array", maxItems: PRIMITIVE_LIMITS.search_fields, items: { type: "string", maxLength: 80 } },
        limit: { type: "number", integer: true, minimum: 1, maximum: PRIMITIVE_LIMITS.search_limit, default: 25 },
        offset: { type: "number", integer: true, minimum: 0, default: 0 },
      },
    },
    output_schema: {
      type: "object", additionalProperties: true, required: ["items", "source"],
      properties: { items: { type: "array", items: { type: "any" } }, count: { type: "number" }, next_offset: { type: "number", nullable: true }, source: { type: "object", additionalProperties: true } },
    },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "SEARCH_SOURCE_UNKNOWN", "PRIMITIVE_FORBIDDEN"],
  },
  {
    name: "SendEmail",
    version: "1.0.0",
    description: "Sends email through the platform's existing messaging transport with the project's configured sender. Recipients, subject and body are validated and quota-checked server-side; no SMTP or provider credential is reachable from the app.",
    capability: "project.write",
    cost_class: "external",
    consumes_ai_credits: false,
    ai_charge_path: null,
    external_provider: "platform_email",
    execution_mode: "sync",
    side_effect: true,
    timeout_ms: 30000,
    retry: { max_attempts: 3, policy: "background_queue", retryable_error_codes: ["PROVIDER_ERROR", "PROVIDER_TIMEOUT", "RATE_LIMITED"] },
    idempotency: { supported: true, required: true, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["to", "subject"],
      properties: {
        to: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 320 } },
        subject: { type: "string", minLength: 1, maxLength: 200 },
        text: { type: "string", maxLength: 100000 },
        html: { type: "string", maxLength: 100000 },
        from_name: { type: "string", maxLength: 80 },
      },
    },
    output_schema: { type: "object", additionalProperties: true, required: ["message_id"], properties: { message_id: { type: "string" }, recipients: { type: "number" }, delivered: { type: "number" } } },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "EMAIL_INVALID_RECIPIENT", "RATE_LIMITED", "PROVIDER_ERROR", "PRIMITIVE_FORBIDDEN"],
  },
  {
    name: "SendNotification",
    version: "1.0.0",
    description: "Notifies one of the project's own end-users through a currently supported channel. 'push' delivers to a device when the end-user has a device mapping and is ALWAYS recorded as an in-app notification, so the app has a delivery surface either way.",
    capability: "project.write",
    cost_class: "external",
    consumes_ai_credits: false,
    ai_charge_path: null,
    external_provider: "platform_push",
    execution_mode: "sync",
    side_effect: true,
    timeout_ms: 30000,
    retry: { max_attempts: 3, policy: "background_queue", retryable_error_codes: ["PROVIDER_ERROR", "PROVIDER_TIMEOUT", "RATE_LIMITED"] },
    idempotency: { supported: true, required: true, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["user_id", "title", "content"],
      properties: {
        channel: { type: "string", enum: ["push"], default: "push" },
        user_id: { type: "string", minLength: 1, maxLength: 120 },
        title: { type: "string", minLength: 1, maxLength: 100 },
        content: { type: "string", minLength: 1, maxLength: 1000 },
        action_label: { type: "string", maxLength: 60 },
        action_url: { type: "string", maxLength: 2000 },
      },
    },
    output_schema: { type: "object", additionalProperties: true, required: ["notification_id"], properties: { notification_id: { type: "string" }, channel: { type: "string" }, delivered: { type: "boolean" } } },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "RECIPIENT_NOT_FOUND", "RATE_LIMITED", "PROVIDER_ERROR", "PRIMITIVE_FORBIDDEN"],
  },
  {
    name: "BackgroundJob",
    version: "1.0.0",
    description: "Runs another primitive asynchronously on the platform's EXISTING durable job queue, or reports one job's status. Retries, backoff and dead-lettering are the queue's, not a second worker system's.",
    capability: "project.write",
    cost_class: "platform",
    consumes_ai_credits: false,
    ai_charge_path: null,
    external_provider: null,
    execution_mode: "async",
    side_effect: true,
    timeout_ms: 20000,
    retry: { max_attempts: 5, policy: "existing_job_queue", retryable_error_codes: ["PROVIDER_ERROR", "PROVIDER_TIMEOUT", "RATE_LIMITED"] },
    idempotency: { supported: true, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["enqueue", "status"] },
        primitive: { type: "string", maxLength: 60 },
        primitive_version: { type: "string", maxLength: 20 },
        input: { type: "object", additionalProperties: true },
        delay_ms: { type: "number", integer: true, minimum: 0, maximum: 86400000, default: 0 },
        job_id: { type: "string", maxLength: 120 },
      },
    },
    output_schema: { type: "object", additionalProperties: true, properties: { job_id: { type: "string" }, status: { type: "string" }, queue: { type: "string" }, duplicate: { type: "boolean" }, attempts: { type: "number" }, result: { type: "object", additionalProperties: true } } },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "PRIMITIVE_NOT_FOUND", "JOB_NOT_FOUND", "PRIMITIVE_FORBIDDEN"],
  },
  {
    name: "ScheduleTask",
    version: "1.0.0",
    description: "Creates, updates, disables or inspects a schedule for one of the project's own backend functions, using the platform's EXISTING scheduled-trigger infrastructure. It introduces no second scheduler and executes nothing itself.",
    capability: "project.write",
    cost_class: "platform",
    consumes_ai_credits: false,
    ai_charge_path: null,
    external_provider: null,
    execution_mode: "async",
    side_effect: true,
    timeout_ms: 20000,
    retry: { max_attempts: 1, policy: "existing_scheduler", retryable_error_codes: [] },
    idempotency: { supported: true, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["create", "update", "disable", "status"] },
        function_name: { type: "string", maxLength: 80 },
        cron: { type: "string", maxLength: 120 },
        interval_seconds: { type: "number", integer: true, minimum: 300, maximum: 2592000 },
        payload: { type: "object", additionalProperties: true },
        trigger_id: { type: "string", maxLength: 120 },
        enabled: { type: "boolean" },
      },
    },
    output_schema: {
      type: "object", additionalProperties: true, required: ["trigger_id"],
      properties: { trigger_id: { type: "string" }, function_name: { type: "string" }, enabled: { type: "boolean" }, next_run_at: { type: "string", nullable: true }, created: { type: "boolean" }, last_status: { type: "string", nullable: true } },
    },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "SCHEDULE_INVALID", "TRIGGER_NOT_FOUND", "PRIMITIVE_FORBIDDEN"],
  },
  // ScheduleTask@1.1.0: adds the DOCUMENTED schedule-lifecycle inputs — a one-time fire date,
  // end conditions (ends_type on/after with their dates/counts) and the user timezone. A
  // contract change is a new version, never an edit of 1.0.0 (whose schedules stay valid;
  // unversioned callers resolve to the LATEST version).
  {
    name: "ScheduleTask",
    version: "1.1.0",
    description: "Creates, updates, disables or inspects a schedule for one of the project's own backend functions, using the platform's EXISTING scheduled-trigger infrastructure. It introduces no second scheduler and executes nothing itself.",
    capability: "project.write",
    cost_class: "platform",
    consumes_ai_credits: false,
    ai_charge_path: null,
    external_provider: null,
    execution_mode: "async",
    side_effect: true,
    timeout_ms: 20000,
    retry: { max_attempts: 1, policy: "existing_scheduler", retryable_error_codes: [] },
    idempotency: { supported: true, required: false, scope: "project" },
    input_schema: {
      type: "object", additionalProperties: false, required: ["operation"],
      properties: {
        operation: { type: "string", enum: ["create", "update", "disable", "status"] },
        function_name: { type: "string", maxLength: 80 },
        cron: { type: "string", maxLength: 120 },
        interval_seconds: { type: "number", integer: true, minimum: 300, maximum: 2592000 },
        one_time_at: { type: "string", maxLength: 40 },
        ends_type: { type: "string", enum: ["never", "on", "after"] },
        ends_on_date: { type: "string", maxLength: 40 },
        ends_after_count: { type: "number", integer: true, minimum: 1, maximum: 1000000 },
        timezone: { type: "string", maxLength: 60 },
        payload: { type: "object", additionalProperties: true },
        trigger_id: { type: "string", maxLength: 120 },
        enabled: { type: "boolean" },
      },
    },
    output_schema: {
      type: "object", additionalProperties: true, required: ["trigger_id"],
      properties: { trigger_id: { type: "string" }, function_name: { type: "string" }, enabled: { type: "boolean" }, next_run_at: { type: "string", nullable: true }, created: { type: "boolean" }, last_status: { type: "string", nullable: true } },
    },
    error_codes: ["PRIMITIVE_INPUT_INVALID", "SCHEDULE_INVALID", "TRIGGER_NOT_FOUND", "PRIMITIVE_FORBIDDEN"],
  },
];

/** The frozen registry. Every entry is immutable: a change is a new version, never an edit. */
export const PRIMITIVES = deepFreeze(RAW_PRIMITIVES.map((p) => ({
  ...p,
  permission: `primitive.${p.name}`,
  contract_version: PRIMITIVE_CONTRACT_VERSION,
  // Every listed primitive is invokable by a generated app's server-side code; nothing here is
  // reachable from generated FRONTEND code, which never receives a credential or a provider handle.
  app_invokable: true,
  output_envelope: OK_ENVELOPE,
})));

export const PRIMITIVE_NAMES = deepFreeze([...new Set(PRIMITIVES.map((p) => p.name))]);

const compareVersion = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

export const versionsOf = (name) => PRIMITIVES.filter((p) => p.name === name).map((p) => p.version).sort(compareVersion);
export const latestVersion = (name) => versionsOf(name).slice(-1)[0] || null;

/**
 * Resolves ONE immutable contract. An omitted version resolves to the latest, and a pinned
 * version always resolves to exactly that contract — which is what stops a generated app from
 * silently inheriting new behaviour.
 */
export function resolvePrimitive(name, version = null) {
  const wanted = version ? String(version) : latestVersion(name);
  if (!wanted) return null;
  return PRIMITIVES.find((p) => p.name === name && p.version === wanted) || null;
}

/** The public, credential-free description of the platform's primitive surface. */
export const describePrimitives = () => ({
  contract_version: PRIMITIVE_CONTRACT_VERSION,
  limits: PRIMITIVE_LIMITS,
  error_categories: ERROR_CATEGORIES,
  retryable_categories: RETRYABLE_CATEGORIES,
  primitives: PRIMITIVES.map((p) => ({
    name: p.name, version: p.version, latest: p.version === latestVersion(p.name),
    versions: versionsOf(p.name), description: p.description,
    permission: p.permission, capability: p.capability,
    cost_class: p.cost_class, consumes_ai_credits: p.consumes_ai_credits,
    ai_charge_path: p.ai_charge_path, external_provider: p.external_provider,
    execution_mode: p.execution_mode, side_effect: p.side_effect, timeout_ms: p.timeout_ms,
    retry: p.retry, idempotency: p.idempotency,
    input_schema: p.input_schema, output_schema: p.output_schema, error_codes: p.error_codes,
  })),
});