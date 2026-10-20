// AI Economics engine: REAL provider cost, and the separate question of what the user is
// charged in credits.
//
// Two invariants:
//   * provider cost is computed from provider-reported token usage against a catalog pricing
//     version. Never from character counts, message length or a frontend estimate. When a
//     provider returns no usage block the counts are marked `estimated` and travel through
//     the system labelled as such — they are never presented as measured usage.
//   * provider cost is NOT the user's charge. The credit pricing policy (markup, multipliers,
//     rounding, minimum) converts cost into credits, and only credits are user-facing.

import { resolvePricing } from "./modelCatalog.ts";

export const CANONICAL_USAGE = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };

const int = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

// Normalizes every provider's usage shape into one canonical model. Providers disagree on
// names (prompt_tokens vs input_tokens vs promptTokenCount) and on whether cached and
// reasoning tokens are included in the headline count; this is the only place that knows.
export function normalizeUsage(provider, raw) {
  if (!raw || typeof raw !== "object") return { ...CANONICAL_USAGE, usage_source: "estimated" };
  const u = raw.usage && typeof raw.usage === "object" ? raw.usage : raw;
  let input = 0, cached = 0, output = 0, reasoning = 0;

  if (provider === "openai") {
    input = int(u.prompt_tokens ?? u.input_tokens);
    cached = int(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
    output = int(u.completion_tokens ?? u.output_tokens);
    reasoning = int(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens);
    // OpenAI's prompt_tokens INCLUDES cached tokens; price them apart.
    input = Math.max(0, input - cached);
    // completion_tokens INCLUDES reasoning tokens; canonical output excludes them, so they are
    // priced once (as reasoning) instead of twice.
    output = Math.max(0, output - reasoning);
  } else if (provider === "anthropic") {
    input = int(u.input_tokens);
    cached = int(u.cache_read_input_tokens);
    output = int(u.output_tokens);
    reasoning = int(u.thinking_tokens ?? u.reasoning_tokens);
    // When a thinking/reasoning count is reported it is part of output_tokens; split it out.
    output = Math.max(0, output - reasoning);
  } else if (provider === "google") {
    const prompt = int(u.promptTokenCount ?? u.prompt_token_count ?? u.input_tokens);
    cached = int(u.cachedContentTokenCount ?? u.cached_content_token_count);
    output = int(u.candidatesTokenCount ?? u.candidates_token_count ?? u.output_tokens);
    reasoning = int(u.thoughtsTokenCount ?? u.thoughts_token_count);
    input = Math.max(0, prompt - cached);
  } else {
    // Canonical/unknown provider: accept the canonical names directly.
    input = int(u.input_tokens);
    cached = int(u.cached_input_tokens ?? u.cached_tokens);
    output = int(u.output_tokens);
    reasoning = int(u.reasoning_tokens);
  }

  const total = int(u.total_tokens ?? u.totalTokenCount) || input + cached + output + reasoning;
  const measured = input + cached + output + reasoning > 0;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: total,
    usage_source: measured ? "provider" : "estimated",
  };
}

// Fallback ONLY for providers that report no usage at all. Explicitly labelled estimated so
// nothing downstream can mistake it for measured usage.
export function estimateUsage({ promptText = "", outputText = "" }) {
  const t = (s) => Math.ceil(String(s || "").length / 4);
  const input_tokens = t(promptText), output_tokens = t(outputText);
  return { input_tokens, cached_input_tokens: 0, output_tokens, reasoning_tokens: 0, total_tokens: input_tokens + output_tokens, usage_source: "estimated" };
}

const perMillion = (tokens, rate) => (tokens > 0 && Number.isFinite(rate) && rate != null ? (tokens * rate) / 1_000_000 : 0);
const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Real provider cost for one operation, priced against an explicit pricing version.
export function computeProviderCost({ model_id, usage, pricing_version = null, at = null, catalog = undefined }) {
  const pricing = resolvePricing(model_id, { pricing_version, at, ...(catalog ? { catalog } : {}) });
  const u = { ...CANONICAL_USAGE, ...usage };
  // A model without a cached-input rate prices cached tokens at the normal input rate, so a
  // provider reporting cache hits can never make an operation accidentally free.
  const cachedRate = pricing.cached_input_per_mtok ?? pricing.input_per_mtok;
  const reasoningRate = pricing.reasoning_per_mtok ?? pricing.output_per_mtok;
  const breakdown = {
    input: round6(perMillion(u.input_tokens, pricing.input_per_mtok)),
    cached_input: round6(perMillion(u.cached_input_tokens, cachedRate)),
    output: round6(perMillion(u.output_tokens, pricing.output_per_mtok)),
    reasoning: round6(perMillion(u.reasoning_tokens, reasoningRate)),
  };
  const provider_cost = round6(breakdown.input + breakdown.cached_input + breakdown.output + breakdown.reasoning);
  return { provider_cost, currency: pricing.currency || "USD", pricing_version: pricing.pricing_version, breakdown };
}

// --- credit pricing policy ----------------------------------------------------

export const DEFAULT_CREDIT_POLICY = {
  policy_version: "credit-policy-v1",
  credits_per_usd: 100,
  markup_multiplier: 1.4,
  minimum_charge_credits: 1,
  rounding: "ceil",
  model_multipliers: {},
  operation_multipliers: { embedding: 0.5 },
  active: true,
};

export async function loadCreditPolicy(base44, workspace_id) {
  const scoped = workspace_id ? await base44.entities.CreditPolicy.filter({ workspace_id, active: true }, "-updated_date", 1).catch(() => []) : [];
  if (scoped.length) return { ...DEFAULT_CREDIT_POLICY, ...scoped[0] };
  const platform = await base44.entities.CreditPolicy.filter({ active: true }, "-updated_date", 5).catch(() => []);
  const global = platform.find((p) => !p.workspace_id);
  return global ? { ...DEFAULT_CREDIT_POLICY, ...global } : { ...DEFAULT_CREDIT_POLICY };
}

const applyRounding = (n, mode) => (mode === "floor" ? Math.floor(n) : mode === "round" ? Math.round(n) : Math.ceil(n));

// provider cost → policy → user credit charge. The only conversion in the platform.
export function creditsForCharge({ provider_cost, policy = DEFAULT_CREDIT_POLICY, model_id = null, operation_type = null }) {
  const p = { ...DEFAULT_CREDIT_POLICY, ...policy };
  const modelMult = Number(p.model_multipliers?.[model_id]) || 1;
  const opMult = Number(p.operation_multipliers?.[operation_type]) || 1;
  const multiplier = (Number(p.markup_multiplier) || 1) * modelMult * opMult;
  const raw = Math.max(0, Number(provider_cost) || 0) * multiplier * (Number(p.credits_per_usd) || 100);
  const rounded = applyRounding(raw, p.rounding);
  // A billable operation always costs at least the minimum; a zero-cost operation stays free.
  const credits = raw > 0 ? Math.max(p.minimum_charge_credits ?? 1, rounded) : 0;
  return { credits, multiplier: round6(multiplier), policy_version: p.policy_version, raw_credits: round6(raw) };
}

// One call: real usage → real cost → user charge. Used by the charging path and by estimates.
export function priceOperation({ model_id, usage, operation_type = "ai_run", policy = DEFAULT_CREDIT_POLICY, pricing_version = null, at = null, catalog = undefined }) {
  const cost = computeProviderCost({ model_id, usage, pricing_version, at, catalog });
  const charge = creditsForCharge({ provider_cost: cost.provider_cost, policy, model_id, operation_type });
  return { ...cost, ...charge, usage: { ...CANONICAL_USAGE, ...usage } };
}

// Mixed-model operation: each model's tokens are priced at THAT model's catalog rates and
// weighted by THAT model's multiplier; markup, operation multiplier, rounding and the minimum
// charge are then applied ONCE to the sum. For a single model this equals priceOperation().
export function priceUsageByModel({ usage_by_model, operation_type = "ai_run", policy = DEFAULT_CREDIT_POLICY, at = null, catalog = undefined }) {
  const p = { ...DEFAULT_CREDIT_POLICY, ...policy };
  const baseMult = (Number(p.markup_multiplier) || 1) * (Number(p.operation_multipliers?.[operation_type]) || 1);
  const usage = { ...CANONICAL_USAGE };
  const models = {};
  const versions = new Set();
  let provider_cost = 0, weighted_cost = 0, currency = null;
  for (const [model_id, u] of Object.entries(usage_by_model || {})) {
    const cost = computeProviderCost({ model_id, usage: u, at, catalog });
    const model_multiplier = Number(p.model_multipliers?.[model_id]) || 1;
    provider_cost += cost.provider_cost;
    weighted_cost += cost.provider_cost * model_multiplier;
    currency = currency || cost.currency;
    versions.add(cost.pricing_version);
    models[model_id] = { provider_cost: cost.provider_cost, pricing_version: cost.pricing_version, model_multiplier, breakdown: cost.breakdown };
    for (const f of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens"]) usage[f] += int(u?.[f]);
  }
  usage.total_tokens = usage.input_tokens + usage.cached_input_tokens + usage.output_tokens + usage.reasoning_tokens;
  const raw = Math.max(0, weighted_cost) * baseMult * (Number(p.credits_per_usd) || 100);
  const credits = raw > 0 ? Math.max(p.minimum_charge_credits ?? 1, applyRounding(raw, p.rounding)) : 0;
  return {
    provider_cost: round6(provider_cost), currency: currency || "USD",
    pricing_version: [...versions].filter(Boolean).join("+") || null,
    breakdown: models, credits,
    multiplier: round6(provider_cost > 0 ? (weighted_cost / provider_cost) * baseMult : baseMult),
    policy_version: p.policy_version, raw_credits: round6(raw), usage,
  };
}

// Worst-case charge for a request that has not run yet, used for budget reservation.
export function estimateMaxCharge({ model_id, max_input_tokens = 0, max_output_tokens = 0, max_reasoning_tokens = 0, operation_type = "ai_run", policy = DEFAULT_CREDIT_POLICY, catalog = undefined }) {
  return priceOperation({
    model_id, operation_type, policy, catalog,
    usage: { input_tokens: max_input_tokens, output_tokens: max_output_tokens, cached_input_tokens: 0, reasoning_tokens: max_reasoning_tokens, total_tokens: max_input_tokens + max_output_tokens + max_reasoning_tokens },
  });
}