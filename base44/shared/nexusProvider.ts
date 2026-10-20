// Nexus — the platform's first-party model, registered behind the EXISTING Model Gateway (#40).
//
// Nexus is a first-class provider/model like every external one: it lives in the Model Catalog,
// executes through `createGateway` under the same adapter contract (generate / supportsTools /
// getModelInfo / stream), reports usage in the canonical shape the economics engine prices, feeds
// the same provider-health breaker, and is retried, timed out and failed over by the gateway's own
// bounded loop. Nothing here is a second gateway, a second retry system or a second ledger.
//
// What this module deliberately does NOT do: fabricate a trained model. No proprietary Nexus
// inference infrastructure exists on this platform today, so the adapter is the PRODUCTION-SAFE
// contract to one: when the inference endpoint is provisioned (two secrets) it is called; when it
// is not, every invocation fails with a normalized, retryable PROVIDER_UNAVAILABLE so the gateway
// fails over to a real model and nothing pretends Nexus answered. Quality metrics are READ from the
// benchmark/candidate-evaluation records the platform already writes — and reported as null until
// such evidence exists. The cost profile is explicitly `unpriced`: an internal cost that has not
// been established is recorded as 0 with that basis, never as an invented number.
import { secrets } from "base44:runtime";
import { assertAllowedUrl } from "./externalTools.ts";
import { normalizeUsage, estimateUsage } from "./economics.ts";
import { providerHealth, isProviderHealthy } from "./providerHealth.ts";
import { MODEL_CATALOG, resolvePricing } from "./modelCatalog.ts";
import { scrubText } from "./tracing.ts";

export const NEXUS_PROVIDER = "nexus";
export const NEXUS_MODEL_ID = "nexus-1";
export const NEXUS_CONTRACT_VERSION = "nexus-inference/v1";
export const NEXUS_ENDPOINT_SECRET = "NEXUS_INFERENCE_URL";
export const NEXUS_KEY_SECRET = "NEXUS_INFERENCE_KEY";

const readSecret = (name) => { try { const v = secrets.get(name); return v ? String(v) : null; } catch { return null; } };

/** Resolves where Nexus inference lives. Secrets by default; an explicit override for certification. */
export function resolveNexusConfig(overrides = null) {
  if (overrides) {
    return { endpoint: overrides.endpoint || null, apiKey: overrides.apiKey || null, provisioned: !!(overrides.endpoint && overrides.apiKey), source: "override" };
  }
  const endpoint = readSecret(NEXUS_ENDPOINT_SECRET);
  const apiKey = readSecret(NEXUS_KEY_SECRET);
  return { endpoint, apiKey, provisioned: !!(endpoint && apiKey), source: "secrets" };
}

const nexusError = (code, message, retryable, extra = {}) => Object.assign(new Error(message), { code, retryable, provider: NEXUS_PROVIDER, ...extra });

/** Maps an inference HTTP failure onto the gateway's provider-error vocabulary. */
export function normalizeNexusHttpError(status, bodyText = "") {
  let detail = "";
  try { const parsed = JSON.parse(bodyText || "{}"); detail = parsed.error || parsed.message || ""; } catch { detail = bodyText || ""; }
  detail = detail ? `: ${scrubText(String(detail), 160)}` : "";
  if (status === 401 || status === 403) return nexusError("PROVIDER_REJECTED", `Nexus rejected the request (${status}): unauthorized${detail}`, false, { http_status: status });
  if (status === 400 || status === 413 || status === 422) return nexusError("PROVIDER_REJECTED", `Nexus rejected the request (${status}): invalid request${detail}`, false, { http_status: status });
  if (status === 408 || status === 504) return nexusError("PROVIDER_TIMEOUT", `Nexus timed out upstream (${status})${detail}`, true, { http_status: status });
  if (status === 429) return nexusError("PROVIDER_UNAVAILABLE", `Nexus rate limited the request (429)${detail}`, true, { http_status: status, rate_limited: true });
  if (status >= 500) return nexusError("PROVIDER_UNAVAILABLE", `Nexus inference unavailable (${status})${detail}`, true, { http_status: status });
  return nexusError("PROVIDER_ERROR", `Nexus returned an unexpected status ${status}${detail}`, false, { http_status: status });
}

/** Structured output is a CONTRACT: a schema request that comes back malformed is a terminal provider error, never silently accepted. */
export function validateStructuredOutput(output, jsonSchema) {
  if (!jsonSchema) return output;
  let value = output;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw nexusError("STRUCTURED_OUTPUT_INVALID", "Nexus returned non-JSON output for a structured-output request", false); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw nexusError("STRUCTURED_OUTPUT_INVALID", "Nexus structured output is not a JSON object", false);
  const missing = (jsonSchema.required || []).filter((k) => value[k] === undefined);
  if (missing.length) throw nexusError("STRUCTURED_OUTPUT_INVALID", `Nexus structured output is missing required field(s): ${missing.join(", ")}`, false, { missing });
  return value;
}

const normalizeToolCall = (c, i) => {
  let args = c?.arguments ?? c?.input ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { _raw: scrubText(args, 300) }; } }
  return { id: String(c?.id || `call_${i + 1}`), name: String(c?.name || c?.tool || "unknown").slice(0, 120), arguments: args && typeof args === "object" ? args : {} };
};

/** The gateway adapter. Same contract as Base44CoreProvider; different wire. */
export class NexusProvider {
  constructor(base44, { endpoint = null, apiKey = null, fetchImpl = null } = {}) {
    this.base44 = base44;
    this.id = NEXUS_PROVIDER;
    this.config = resolveNexusConfig(endpoint || apiKey ? { endpoint, apiKey } : null);
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }
  supportsTools() { return true; }
  getModelInfo(id) { return MODEL_CATALOG.find((m) => m.model_id === id || m.provider_model_name === id) || null; }

  async generate({ model, system = "", messages = [], jsonSchema = null, tools = null, timeoutMs = 60000, fileUrls = null }) {
    if (!this.config.provisioned) {
      // Retryable ON PURPOSE: the gateway treats it as "this provider cannot serve right now" and
      // fails over to the next compatible model instead of failing the run or faking an answer.
      throw nexusError("PROVIDER_UNAVAILABLE", `Nexus inference endpoint is not provisioned (set ${NEXUS_ENDPOINT_SECRET} and ${NEXUS_KEY_SECRET})`, true, { reason: "NEXUS_NOT_PROVISIONED" });
    }
    const body = {
      contract_version: NEXUS_CONTRACT_VERSION, model: model.name || model.provider_model_name || NEXUS_MODEL_ID,
      model_version: model.model_version || null, system, messages,
      response_schema: jsonSchema || null, tools: Array.isArray(tools) ? tools : [],
      // Reference images ride along under the contract's snake_case name, and only when present —
      // a text-only request produces the exact same body as before.
      ...(fileUrls?.length ? { file_urls: fileUrls } : {}),
    };
    // F-1 (P-3): the endpoint is an admin-configured URL, validated through the SAME URL guard every
    // other outbound call uses, so a misconfigured or internal address is refused here instead of
    // being fetched. A config error is deterministic: no retry, no fallback burn.
    let endpointUrl;
    try { endpointUrl = assertAllowedUrl(String(this.config.endpoint).replace(/\/$/, "")); }
    catch (e) { throw nexusError("PROVIDER_REJECTED", `Nexus endpoint is not allowed: ${scrubText(String(e?.message || e).replace(/^http: /, ""), 160)}`, false, { reason: "ENDPOINT_NOT_ALLOWED" }); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs || 60000));
    let res;
    try {
      res = await this.fetch(`${endpointUrl.toString()}/v1/generate`, {
        method: "POST", signal: controller.signal,
        headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json", "x-nexus-contract": NEXUS_CONTRACT_VERSION },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e?.name === "AbortError") throw nexusError("PROVIDER_TIMEOUT", `Nexus timed out after ${timeoutMs}ms`, true);
      throw nexusError("PROVIDER_UNAVAILABLE", `Nexus network failure: ${scrubText(e?.message || e, 120)}`, true);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw normalizeNexusHttpError(res.status, await res.text().catch(() => ""));
    let data;
    try { data = await res.json(); } catch { throw nexusError("PROVIDER_ERROR", "Nexus returned a malformed response body", false); }

    const output = validateStructuredOutput(data.output ?? data.content ?? "", jsonSchema);
    // Canonical usage names on the wire → the economics engine's canonical branch. Missing usage is
    // labelled `estimated` exactly like every other provider that reports none.
    const reported = data.usage ? normalizeUsage(NEXUS_PROVIDER, data) : null;
    const usage = reported?.usage_source === "provider"
      ? reported
      : estimateUsage({ promptText: `${system}\n${messages.map((m) => m.content).join("\n")}`, outputText: typeof output === "string" ? output : JSON.stringify(output) });
    return {
      output, usage, rawUsage: data.usage || null,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      tokensEstimated: usage.usage_source !== "provider",
      tool_calls: Array.isArray(data.tool_calls) ? data.tool_calls.slice(0, 50).map(normalizeToolCall) : [],
      model_version: data.model_version || model.model_version || null,
    };
  }
  async stream() {
    throw nexusError("STREAMING_UNSUPPORTED", "Streaming is not part of the Nexus provider contract; progress is streamed via run steps like every other gateway model.", false);
  }
}

// --- health, cost profile, evidence, readiness -----------------------------------

/** Health is the EXISTING breaker keyed by provider, plus whether inference is provisioned at all. */
export function nexusHealth(configOverride = null) {
  const cfg = resolveNexusConfig(configOverride);
  const breaker = providerHealth()[NEXUS_PROVIDER] || null;
  const healthy = cfg.provisioned && isProviderHealthy(NEXUS_PROVIDER);
  return {
    provider: NEXUS_PROVIDER, model_id: NEXUS_MODEL_ID, contract_version: NEXUS_CONTRACT_VERSION,
    provisioned: cfg.provisioned, config_source: cfg.source,
    healthy, state: !cfg.provisioned ? "unprovisioned" : breaker ? "degraded" : "healthy",
    breaker,
  };
}

/** The catalog view of Nexus, including a cost profile that says plainly whether it is priced. */
export function nexusCatalogStatus() {
  const m = MODEL_CATALOG.find((x) => x.model_id === NEXUS_MODEL_ID);
  const pricing = resolvePricing(NEXUS_MODEL_ID);
  return {
    model_id: m.model_id, provider: m.provider, gateway_provider: m.gateway_provider,
    model_version: m.model_version || null, provider_version: m.provider_version || null,
    quality_tier: m.quality_tier, quality_tier_basis: m.quality_tier_basis || "unverified",
    capabilities: m.capabilities, context_window: m.context_window, max_output_tokens: m.max_output_tokens,
    supports_tools: m.supports_tools, supports_structured_output: m.supports_structured_output, supports_streaming: m.supports_streaming,
    active: m.active, availability: m.availability, routing: m.routing,
    cost_profile: {
      pricing_version: pricing.pricing_version, currency: pricing.currency,
      input_per_mtok: pricing.input_per_mtok, output_per_mtok: pricing.output_per_mtok,
      cost_basis: pricing.cost_basis || "provider_list_price", priced: (pricing.cost_basis || "provider_list_price") !== "unpriced_internal",
    },
  };
}

/**
 * Quality evidence for Nexus, READ from the records the benchmark harness (#38) and candidate
 * evaluation (#39) already write. No evidence ⇒ `quality_metrics: null` — never a default score.
 */
export async function nexusEvidence(svc) {
  const [results, candidateEvals, trajectories, operations] = await Promise.all([
    svc.entities.BenchmarkResult.filter({ model_id: NEXUS_MODEL_ID }, "-created_date", 200).catch(() => []),
    svc.entities.CandidateEvaluation.list("-created_date", 200).catch(() => []),
    svc.entities.Trajectory.filter({ model_id: NEXUS_MODEL_ID }, "-created_date", 200).catch(() => []),
    svc.entities.AIOperation.filter({ model_id: NEXUS_MODEL_ID }, "-created_date", 200).catch(() => []),
  ]);
  const nexusEvals = candidateEvals.filter((c) => c.candidate?.model_id === NEXUS_MODEL_ID && ["SCORED", "FINALIZED"].includes(c.status));
  const scored = results.filter((r) => r.scored !== false && ["COMPLETED", "FAILED"].includes(r.status));
  const successes = scored.filter((r) => (r.metrics || {}).task_success === 1).length;
  const measured = scored.filter((r) => (r.metrics || {}).task_success != null).length;
  return {
    benchmark_results: results.length, scored_benchmark_results: scored.length,
    candidate_evaluations: nexusEvals.length, sealed_trajectories: trajectories.filter((t) => t.sealed).length,
    charged_operations: operations.filter((o) => o.status === "completed").length,
    quality_metrics: measured ? { task_success_rate: Math.round((successes / measured) * 1e6) / 1e6, measured_from: measured } : null,
    quality_metrics_reason: measured ? "aggregated from scored benchmark results" : "no scored benchmark or candidate-evaluation evidence exists for nexus-1",
  };
}

/** Full status incl. the activation checklist. Every blocker is a fact read from the system, not a promise. */
export async function nexusStatus(svc, { configOverride = null } = {}) {
  const health = nexusHealth(configOverride);
  const catalog = nexusCatalogStatus();
  const evidence = await nexusEvidence(svc);
  const blockers = [];
  if (!health.provisioned) blockers.push(`inference endpoint not provisioned (${NEXUS_ENDPOINT_SECRET} / ${NEXUS_KEY_SECRET} unset)`);
  if (!catalog.cost_profile.priced) blockers.push("internal cost profile not established; provider cost recorded as unpriced (0) rather than invented");
  if (!evidence.quality_metrics) blockers.push("no benchmark or candidate-evaluation evidence for nexus-1");
  if (!catalog.active) blockers.push("catalog entry inactive: excluded from automatic routing until the blockers above clear (code change, reviewed)");
  return {
    health, catalog, evidence,
    activation: { eligible: blockers.length === 0, blockers },
    limitations: [
      "No proprietary Nexus training or inference infrastructure exists on this platform; the provider is the production-safe contract to one.",
      "Unprovisioned invocations fail with a retryable PROVIDER_UNAVAILABLE and the gateway fails over to a real catalog model.",
      "Quality metrics are read from benchmark/candidate-evaluation records only and stay null until real evidence exists.",
    ],
  };
}