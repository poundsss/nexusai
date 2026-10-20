// Model gateway: catalog-backed registry + cost-aware router + provider adapters.
//
// The registry is DERIVED from the Model Catalog — no price is written here, so a pricing
// change is a catalog change and nothing else. Routing delegates to the cost-aware router
// (aiRouter.ts) while keeping this module's original call signatures, so every existing caller
// (run pipeline, agent loop) gains economics-aware routing without changing.

import { MODEL_CATALOG, resolvePricing, listModels, getModel, loadCatalog } from "./modelCatalog.ts";
import { routeOperation, requirementsFor, withProviderHealth } from "./aiRouter.ts";
import { computeProviderCost, normalizeUsage, estimateUsage, priceOperation, DEFAULT_CREDIT_POLICY } from "./economics.ts";
// The health SIGNAL the existing routing gate consumes. Fed by this gateway's own call outcomes.
import { providerHealth, recordProviderResult, isProviderHealthy } from "./providerHealth.ts";
// Correlation only — a fallback or retry stays part of the operation that requested it.
import { recordSpan } from "./tracing.ts";
import { NexusProvider, NEXUS_PROVIDER } from "./nexusProvider.ts";
// The native tool-calling adapter over the platform's AI Gateway (OpenAI-compatible wire).
import { Base44GatewayProvider, GATEWAY_PROVIDER_ID } from "./gatewayProvider.ts";

// Adapter to the shape the existing pipeline persists in staging and reads back later.
function toRegistryEntry(m) {
  const p = resolvePricing(m.model_id);
  return {
    id: m.model_id, model_id: m.model_id,
    // `provider` is the gateway adapter (what executes); `upstream_provider` is who bills.
    provider: m.gateway_provider, upstream_provider: m.provider,
    name: m.provider_model_name, display_name: m.display_name, tier: m.quality_tier,
    capabilities: m.capabilities, contextWindow: m.context_window, maxOutputTokens: m.max_output_tokens,
    supportsTools: m.supports_tools, supportsVision: m.supports_vision, supportsReasoning: m.supports_reasoning, supportsCode: true,
    supportsStructuredOutput: m.supports_structured_output !== false, supportsStreaming: !!m.supports_streaming,
    inputCost: p.input_per_mtok, outputCost: p.output_per_mtok, pricing_version: p.pricing_version,
    model_version: m.model_version || null, availability: m.availability || "ga",
    enabled: m.active,
  };
}

export const MODEL_REGISTRY = MODEL_CATALOG.map(toRegistryEntry);

const TIER_FALLBACK = { fast: ["fast", "standard"], standard: ["standard", "fast"], advanced: ["advanced", "standard", "fast"] };

export function pickModel(tier) {
  for (const t of TIER_FALLBACK[tier] || ["standard"]) {
    const m = MODEL_REGISTRY.find((x) => x.tier === t && x.enabled);
    if (m) return m;
  }
  throw new Error("No enabled model in registry");
}

// The registry entry for an explicitly pinned model id (Superagent parity: the AUTOMATIONS
// model pin). Returns null for an unknown or disabled model — callers fall through to routing
// instead of failing a background run on a stale pin.
export function pinnedModel(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return null;
  const m = MODEL_REGISTRY.find((x) => x.model_id === id || x.id === id);
  return m && m.enabled ? m : null;
}

/**
 * Routes a task to a model. Same signature as before, now economics-aware:
 *
 * @param budget_credits optional ceiling from the budget layer. When the cheapest compatible
 *   model does not fit it, the error is explicit (MODEL_TOO_EXPENSIVE) instead of a silent
 *   downgrade to a model that cannot do the job.
 * @param strategy best_quality | lowest_cost | balanced | fastest | budget_constrained
 */
export function routeModel({ mode, prompt, fileCount = 0, isRepair = false, needs_vision = false, budget_credits = null, strategy = null, catalog = undefined, policy = undefined, estimate = null, prefer_model_id = null, health = undefined, modelAccess = null }) {
  const requirements = requirementsFor({ mode, prompt, fileCount, isRepair, needs_vision });
  // Provider health participates in routing through the EXISTING gate: an unhealthy provider's
  // models are marked unavailable, so capability matching skips them and a compatible model on a
  // healthy provider is chosen instead. When every provider is healthy the catalog is untouched.
  const healthState = health === undefined ? providerHealth() : (health || {});
  const unhealthy = Object.keys(healthState).filter((p) => healthState[p]?.healthy === false);
  const gatedCatalog = unhealthy.length ? withProviderHealth(catalog || MODEL_CATALOG, healthState) : catalog;
  // Latency is a first-class input: runs execute inside a 120s window, so short/repair/discuss
  // work stays on the fast tier unless the caller asks for something else.
  const chosenStrategy = strategy || (requirements.complexity === "high" ? "best_quality" : requirements.latency_sensitive ? "fastest" : "balanced");
  const { model, decision } = routeOperation({
    requirements, strategy: chosenStrategy, budget_credits, estimate, prefer_model_id, modelAccess,
    ...(gatedCatalog ? { catalog: gatedCatalog } : {}), ...(policy ? { policy } : {}),
  });
  if (unhealthy.length) decision.unhealthy_providers = unhealthy.map((p) => ({ provider: p, reason: healthState[p]?.reason || "provider unhealthy" }));
  return { model: toRegistryEntry(model), reason: `${decision.reason} (${chosenStrategy})`, decision };
}

// P-16C1 (documented Base44): Discuss "uses its own AI model regardless of the model selected
// in your app", so a run's model preference is honored only outside Discuss. Build behavior
// (preference honored when compatible and affordable) is unchanged.
export const preferredModelIdFor = ({ mode, preferred_model_id = null }) =>
  mode === "discuss" ? null : (preferred_model_id || null);

class Base44CoreProvider {
  constructor(base44) { this.base44 = base44; this.id = "base44-core"; }
  supportsTools() { return false; }
  getModelInfo(id) { return MODEL_REGISTRY.find((m) => m.id === id || m.name === id) || null; }
  // `fileUrls` are stored file URLs attached to the request (e.g. reference images); they travel
  // with the prompt on the same provider call and are omitted entirely when there are none.
  async generate({ model, system, messages, jsonSchema, fileUrls = null }) {
    const transcript = messages.map((m) => `### ${m.role.toUpperCase()}\n${m.content}`).join("\n\n");
    const prompt = `${system}\n\n${transcript}`;
    const raw = await this.base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      model: model.name,
      response_json_schema: jsonSchema || null,
      ...(fileUrls?.length ? { file_urls: fileUrls } : {}),
    });
    // The gateway returns content only. When a usage block IS present it is authoritative and
    // normalized; otherwise counts are locally derived and explicitly marked `estimated`, and
    // the economics engine records them as such rather than as measured usage.
    // Only the wrapped model-response shape { output, usage: {...} } carries token usage. A plain
    // structured result that merely has a field named `usage` is content, never token counts.
    const wrapped = !!raw && typeof raw === "object" && !Array.isArray(raw)
      && Object.prototype.hasOwnProperty.call(raw, "output")
      && !!raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage);
    const output = wrapped ? raw.output : raw;
    const reported = wrapped ? normalizeUsage(model.upstream_provider, raw) : null;
    const usage = reported && reported.usage_source === "provider"
      ? reported
      : estimateUsage({ promptText: prompt, outputText: typeof output === "string" ? output : JSON.stringify(output) });
    return {
      output, usage,
      rawUsage: reported ? raw.usage : null,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      tokensEstimated: usage.usage_source !== "provider",
    };
  }
  async stream() { throw new Error("Streaming is not supported by this provider; progress is streamed via run steps."); }
}

// Provider failure classification. Only a failure that is a property of the MOMENT (timeout,
// upstream unavailability, rate limiting, transport) may be retried or failed over; an
// authorization, validation or policy error is deterministic, so retrying it or moving it to
// another model would burn credits to reach the identical outcome.
const PROVIDER_RETRYABLE_RE = /(timed out|timeout|temporarily|unavailable|overloaded|rate limit|429|50[0234]|econnreset|socket hang up|network|fetch failed)/i;
const PROVIDER_TERMINAL_RE = /(unauthorized|forbidden|not authorized|invalid api key|invalid request|invalid schema|content policy|safety|unsupported|quota exceeded for this key)/i;

export function classifyProviderError(error) {
  const message = String(error?.message || error || "");
  const explicit = error?.code || null;
  if (explicit === "PROVIDER_UNAVAILABLE") return { code: explicit, retryable: true };
  if (error?.retryable === true) return { code: explicit || "PROVIDER_TRANSIENT", retryable: true };
  if (error?.retryable === false) return { code: explicit || "PROVIDER_ERROR", retryable: false };
  if (PROVIDER_TERMINAL_RE.test(message)) return { code: explicit || "PROVIDER_REJECTED", retryable: false };
  if (/timed out|timeout/i.test(message)) return { code: "PROVIDER_TIMEOUT", retryable: true };
  if (PROVIDER_RETRYABLE_RE.test(message)) return { code: explicit || "PROVIDER_UNAVAILABLE", retryable: true };
  return { code: explicit || "PROVIDER_ERROR", retryable: false };
}

// The ordered execution chain: the routed model first, then the router's own compatible,
// affordable fallbacks (or the catalog's declared ones), resolved through the SAME catalog rules
// so a fallback can never be a model the request's requirements or budget already rejected.
function resolveChain(model, fallbacks, catalog = MODEL_CATALOG) {
  const ids = (fallbacks && fallbacks.length ? fallbacks : (() => {
    try { return getModel(model.model_id || model.id, catalog).routing?.fallback_model_ids || []; } catch { return []; }
  })()).filter((id) => id && id !== (model.model_id || model.id));
  const chain = [model];
  for (const id of ids.slice(0, 3)) {
    try {
      const entry = toRegistryEntry(getModel(id, catalog));
      if (entry.enabled && !chain.some((c) => (c.model_id || c.id) === entry.model_id)) chain.push(entry);
    } catch { /* unknown or unpriced model is simply not a fallback */ }
  }
  return chain;
}

/** The ordered model_ids gateway.generate() may execute for (model, fallbacks) — the SAME resolveChain(). */
export function executionChainIds(model, fallbacks = null, catalog = MODEL_CATALOG) {
  return resolveChain(model, fallbacks, catalog).map((m) => m.model_id || m.id);
}

// Estimate-only allowance per attached image, added to a call's input worst case.
export const WORST_CASE_IMAGE_INPUT_TOKENS = 1600;

/**
 * Worst-case credits of ONE call on `model_id`: input (+ image allowance), output, and the reasoning
 * allowance when the model reasons — priced with the existing priceOperation(). null = unknown model.
 */
export function worstCaseCallCredits(model_id, estimate: any = {}, { operation_type = "ai_run", policy = DEFAULT_CREDIT_POLICY, catalog = MODEL_CATALOG } = {}) {
  let m;
  try { m = getModel(model_id, catalog); } catch { return null; }
  const input = (estimate.max_input_tokens || 0) + (Number(estimate.image_count) || 0) * WORST_CASE_IMAGE_INPUT_TOKENS;
  const output = estimate.max_output_tokens || m.max_output_tokens || 0;
  const reasoning = m.supports_reasoning ? (estimate.max_reasoning_tokens || 0) : 0;
  return priceOperation({
    model_id, operation_type, policy, catalog,
    usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0, reasoning_tokens: reasoning, total_tokens: input + output + reasoning },
  }).credits;
}

/**
 * The execution chain restricted to models whose worst-case call fits `availableCredits`, in the
 * original order. [] when the primary itself does not fit. Unknown credits (null) = unfiltered.
 * Callers hand the result to gateway.generate() as `fallbacks` (the gateway drops the primary from
 * it), so a filtered chain is never widened back to the catalog default.
 */
export function budgetAwareExecutionChain(model, fallbacks, availableCredits, opts: any = {}) {
  const chain = executionChainIds(model, fallbacks);
  // P-8.4: plan access is applied BEFORE affordability, so budget math can never admit a model the
  // caller's plan does not include. A disallowed PRIMARY fails closed (MODEL_NOT_ALLOWED_BY_PLAN);
  // disallowed fallbacks are dropped, and a model unknown to the catalog reads as not allowed.
  let planChain = chain;
  if (opts.modelAccess) {
    const planAllowsId = (id) => { try { return opts.modelAccess.allows(getModel(id, opts.catalog || MODEL_CATALOG)); } catch { return false; } };
    if (!planAllowsId(chain[0])) {
      throw Object.assign(new Error(`Plan "${opts.modelAccess.plan_code}" does not include model ${chain[0]}`), { code: "MODEL_NOT_ALLOWED_BY_PLAN", status: 403 });
    }
    planChain = [chain[0], ...chain.slice(1).filter(planAllowsId)];
  }
  const available = availableCredits == null ? NaN : Number(availableCredits);
  if (!Number.isFinite(available)) return planChain;
  // opts.catalog, when given, is the ONLY catalog the estimate is priced from; absent → built-in default.
  const priceOpts = { operation_type: opts.operation_type, policy: opts.policy, ...(opts.catalog ? { catalog: opts.catalog } : {}) };
  const fits = (id) => { const c = worstCaseCallCredits(id, opts.estimate || {}, priceOpts); return c != null && c <= available; };
  if (!fits(planChain[0])) return [];
  return planChain.filter(fits);
}

// `providerOverrides` exists so the verification suite can drive real fallback, retry and timeout
// behaviour against deterministic adapters. Production callers pass nothing and get the real one.
export function createGateway(base44, { providerOverrides = null } = {}) {
  // Nexus (#40) is a peer adapter under the identical contract — same retry, timeout, health and
  // fallback loop below; nothing special-cases it.
  const gatewayProvider = new Base44GatewayProvider(base44);
  const providers = { "base44-core": new Base44CoreProvider(base44), [NEXUS_PROVIDER]: new NexusProvider(base44), [GATEWAY_PROVIDER_ID]: gatewayProvider, ...(providerOverrides || {}) };
  // F-2 (P-3): the runtime catalog mirror, loaded once per gateway (per phase) — a failed load
  // falls back to the code catalog, so behavior is unchanged when the mirror is unavailable.
  let catalogPromise = null;
  const runtimeCatalog = () => (catalogPromise ||= loadCatalog(base44).catch(() => MODEL_CATALOG));

  // One bounded provider call: per-attempt timeout, transient-only retries, health recorded.
  const callWithRetry = async (model, req, { maxAttempts, perAttemptMs, deadline = null, trace }, providerOverride = null) => {
    const provider = providerOverride || providers[model.provider];
    if (!provider) throw Object.assign(new Error(`Provider unavailable: ${model.provider}`), { code: "PROVIDER_UNAVAILABLE", retryable: true });
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`Model ${model.name} timed out after ${perAttemptMs}ms (attempt ${attempt}/${maxAttempts})`), { code: "PROVIDER_TIMEOUT", retryable: true })), perAttemptMs); });
      try {
        const res = await Promise.race([provider.generate({ model, ...req, timeoutMs: perAttemptMs }), timeout]);
        recordProviderResult(model.upstream_provider, { ok: true });
        if (trace?.trace_id) {
          await recordSpan(base44, {
            trace_id: trace.trace_id, parent_span_id: trace.parent_span_id || null, run_id: trace.run_id || null,
            project_id: trace.project_id || null, workspace_id: trace.workspace_id || null,
            event_type: "tool_call", name: `model ${model.model_id || model.id}`, status: "ok",
            attempt, duration_ms: Date.now() - started,
            metadata: { provider: model.upstream_provider, gateway: model.provider, usage_source: res.usage?.usage_source || null },
          });
        }
        return res;
      } catch (e) {
        lastError = e;
        const { code, retryable } = classifyProviderError(e);
        recordProviderResult(model.upstream_provider, { ok: false, code, error: e });
        if (trace?.trace_id) {
          await recordSpan(base44, {
            trace_id: trace.trace_id, parent_span_id: trace.parent_span_id || null, run_id: trace.run_id || null,
            project_id: trace.project_id || null, workspace_id: trace.workspace_id || null,
            event_type: "tool_call", name: `model ${model.model_id || model.id}`, status: "error",
            error: e, error_code: code, attempt, duration_ms: Date.now() - started,
            metadata: { provider: model.upstream_provider, retryable },
          });
        }
        // A deterministic provider error is final, the last attempt has no successor, and an
        // exhausted time budget must not buy another attempt.
        if (!retryable || attempt === maxAttempts || (deadline && Date.now() >= deadline)) throw Object.assign(e, { code, retryable });
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  };

  // The shared chain-execution loop behind BOTH surfaces: `generate` (InvokeLLM-backed,
  // JSON-schema decisions — unchanged for Builder runs and every other existing caller) and
  // `generateTools` (the AI Gateway adapter, native tool calls). The surfaces differ ONLY in
  // which adapter serves each chain member; retry, timeout, health, plan and fallback behavior
  // are identical.
  const runChain = async (model, req, providerFor) => {
    // One slow request must never stall the run past the platform's HTTP window, so every
    // provider call is bounded: the caller's total budget is split evenly across attempts, and
    // only transient failures (timeout, upstream unavailability, rate limiting, transport) are
    // retried. When the primary model's provider keeps failing transiently, execution FAILS OVER
    // to the router's next compatible, affordable candidate; an authorization, validation or
    // policy error never triggers a retry or a fallback.
    //
    // Usage is recorded by the caller only on the attempt that actually returned, so an
    // abandoned attempt, a retry and a fallback can never charge the run twice.
    // F-2 (P-3): the execution chain is resolved against the RUNTIME catalog mirror, so a model an
    // admin deactivated through ModelCatalogEntry is removed from fallback execution too, not
    // just from routing.
    let chain = resolveChain(model, req.fallbacks, await runtimeCatalog());
    // P-8.4: fallback selection is plan-filtered. A disallowed PRIMARY fails closed before any
    // provider call; disallowed fallbacks — including catalog-declared defaults — are dropped,
    // so the plan boundary holds even when the caller passes no explicit fallback chain.
    if (req.modelAccess) {
      req.modelAccess.check(chain[0]);
      chain = [chain[0], ...chain.slice(1).filter((c) => req.modelAccess.allows(c))];
    }
    const totalMs = req.timeoutMs || 90000;
    const maxAttempts = req.maxAttempts && req.maxAttempts > 1 ? Math.min(req.maxAttempts, 3) : 1;
    const perAttemptMs = Math.max(5000, Math.floor(totalMs / (maxAttempts * Math.min(chain.length, 2))));
    const attempted = [];
    let lastError;
    // The caller's budget bounds the WHOLE call, not each candidate: once it is spent, the
    // remaining fallbacks are abandoned rather than multiplying the wait by the chain length.
    const deadline = Date.now() + totalMs;

    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i];
      const remaining = deadline - Date.now();
      if (i > 0 && remaining <= 0) {
        attempted.push({ model_id: candidate.model_id, skipped: "time budget exhausted" });
        continue;
      }
      // The health gate applies to fallbacks too: an already-tripped provider is skipped
      // rather than being handed the same request to fail again.
      if (i > 0 && !isProviderHealthy(candidate.upstream_provider)) {
        attempted.push({ model_id: candidate.model_id, skipped: "provider unhealthy" });
        continue;
      }
      try {
        const res = await callWithRetry(candidate, req, { maxAttempts, perAttemptMs: i === 0 ? perAttemptMs : Math.max(5000, Math.min(perAttemptMs, remaining)), deadline, trace: req.trace }, providerFor(candidate));
        return {
          ...res,
          model_used: candidate,
          // Recorded so the run's routing decision shows what actually executed.
          fallback_from: i > 0 ? (model.model_id || model.id) : null,
          provider_attempts: attempted,
        };
      } catch (e) {
        lastError = e;
        const { code, retryable } = classifyProviderError(e);
        attempted.push({ model_id: candidate.model_id, error_code: code, retryable });
        if (!retryable) throw e;
      }
    }
    throw Object.assign(lastError || new Error("No provider could serve the request"), { provider_attempts: attempted });
  };

  return {
    registry: MODEL_REGISTRY,
    classifyProviderError,
    async generate(model, req) {
      return runChain(model, req, (candidate) => providers[candidate.provider]);
    },

    // Native tool-calling surface for the Agent decision loop. InvokeLLM is a single call with
    // no tools BY CONTRACT, so a tools request must never be handed to an adapter that would
    // silently drop it; the AI Gateway is the SAME metered model surface with an
    // OpenAI-compatible wire that carries tool definitions and returns tool calls.
    async generateTools(model, req) {
      return runChain(model, req, () => gatewayProvider);
    },
    async generateUnbounded(model, req) {
      const provider = providers[model.provider];
      if (!provider) throw new Error(`Provider unavailable: ${model.provider}`);
      return provider.generate({ model, ...req });
    },
    // Real provider cost, priced by the economics engine against the model's catalog pricing
    // version. Kept for existing callers that only track input/output tokens.
    estimateCost(model, inputTokens, outputTokens) {
      return computeProviderCost({
        model_id: model.model_id || model.id,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        pricing_version: model.pricing_version || null,
      }).provider_cost;
    },
  };
}

export { listModels };