// Cost-aware model router.
//
// This EXTENDS the existing rule-based routing rather than replacing it: the task-shape rules
// still decide what the request needs, and this layer decides which catalog model best serves
// those needs under the caller's strategy and budget.
//
// Two hard rules:
//   * capability first — a model is never chosen because it is cheaper if it cannot satisfy the
//     request's requirements;
//   * explainable — every decision returns its strategy, candidates, scores and rejection
//     reasons, so a charge can always be traced back to why that model ran.

import { matchModels, listModels, getModel } from "./modelCatalog.ts";
import { estimateMaxCharge, DEFAULT_CREDIT_POLICY } from "./economics.ts";

export const STRATEGIES = ["best_quality", "lowest_cost", "balanced", "fastest", "budget_constrained"];

const TIER_SCORE = { fast: 1, standard: 2, advanced: 3 };
const LATENCY_SCORE = { fast: 1, standard: 2, slow: 3 };

// Derives the request's hard requirements from the task, then infers a default strategy.
export function requirementsFor({ mode = "build", prompt = "", fileCount = 0, isRepair = false, needs_vision = false, needs_tools = false, needs_streaming = false, min_context = 0 } = {}) {
  const len = String(prompt || "").length;
  const featureWords = (String(prompt).match(/\b(and|with|plus|also|,)\b/g) || []).length;
  const complex = fileCount > 4 && len > 400 && featureWords >= 5;
  return {
    capabilities: ["text", "json", "code"],
    needs_structured_output: true,
    needs_vision, needs_tools, needs_streaming,
    min_context: Math.max(min_context, complex ? 200000 : 0),
    complexity: mode === "discuss" || isRepair ? "low" : complex ? "high" : fileCount <= 4 ? "low" : "medium",
    latency_sensitive: mode === "discuss" || isRepair,
  };
}

function expectedCost(model, { policy, estimate, catalog }) {
  return estimateMaxCharge({
    model_id: model.model_id,
    max_input_tokens: estimate?.max_input_tokens || 20000,
    max_output_tokens: estimate?.max_output_tokens || 4000,
    operation_type: estimate?.operation_type || "ai_run",
    policy, catalog,
  }).credits;
}

/**
 * Chooses a model.
 *
 * @param budget_credits ceiling from the budget layer. Candidates whose expected charge
 *   exceeds it are rejected — and if that empties the field, the caller gets an explicit
 *   MODEL_TOO_EXPENSIVE decision rather than a silent downgrade.
 */
export function routeOperation({
  requirements = {}, strategy = "balanced", budget_credits = null, estimate = null,
  policy = DEFAULT_CREDIT_POLICY, catalog = undefined, allow_inactive = false, prefer_model_id = null,
  modelAccess = null,
} = {}) {
  const strat = STRATEGIES.includes(strategy) ? strategy : "balanced";
  const matched = matchModels(requirements, { includeInactive: allow_inactive, catalog });
  const decision = { strategy: strat, requirements, rejected: [...matched.rejected], candidates: [], budget_credits };
  let candidates = matched.candidates;

  if (!candidates.length) {
    throw Object.assign(new Error("No model satisfies the requested capabilities"), { code: "NO_COMPATIBLE_MODEL", status: 422, decision });
  }

  // P-8.4: plan-based model access, applied BEFORE budget filtering — a model the caller's plan
  // does not include is never a routing candidate, so no strategy, budget or client preference
  // (a preferred model) can admit it. When the plan excludes every compatible model, routing
  // fails closed instead of silently crossing the plan boundary.
  if (modelAccess) {
    const denied = candidates.filter((m) => !modelAccess.allows(m));
    for (const m of denied) decision.rejected.push({ model_id: m.model_id, reason: `not allowed by plan "${modelAccess.plan_code}"` });
    candidates = candidates.filter((m) => modelAccess.allows(m));
    if (!candidates.length) {
      throw Object.assign(new Error(`No model allowed by plan "${modelAccess.plan_code}" satisfies the requested capabilities`), { code: "MODEL_NOT_ALLOWED_BY_PLAN", status: 403, decision });
    }
  }

  const scored = candidates.map((m) => ({
    model: m,
    quality: TIER_SCORE[m.quality_tier] || 2,
    latency: LATENCY_SCORE[m.routing?.latency_class] || 2,
    expected_credits: expectedCost(m, { policy, estimate, catalog }),
  }));

  // Budget filtering happens AFTER capability filtering, never before it.
  let affordable = scored;
  if (budget_credits != null) {
    affordable = scored.filter((s) => s.expected_credits <= budget_credits);
    for (const s of scored.filter((s) => s.expected_credits > budget_credits)) {
      decision.rejected.push({ model_id: s.model.model_id, reason: `expected ${s.expected_credits} credits exceeds remaining budget ${budget_credits}` });
    }
    if (!affordable.length) {
      const cheapest = [...scored].sort((a, b) => a.expected_credits - b.expected_credits)[0];
      throw Object.assign(new Error(`No compatible model fits the remaining budget of ${budget_credits} credits (cheapest compatible: ${cheapest.model.model_id} at ~${cheapest.expected_credits})`), {
        code: "MODEL_TOO_EXPENSIVE", status: 402,
        detail: { budget_credits, cheapest_model_id: cheapest.model.model_id, cheapest_credits: cheapest.expected_credits },
        decision,
      });
    }
  }

  const cmp = {
    best_quality: (a, b) => b.quality - a.quality || a.expected_credits - b.expected_credits,
    lowest_cost: (a, b) => a.expected_credits - b.expected_credits || b.quality - a.quality,
    fastest: (a, b) => a.latency - b.latency || a.expected_credits - b.expected_credits,
    budget_constrained: (a, b) => a.expected_credits - b.expected_credits || b.quality - a.quality,
    // Balanced: quality per credit, with latency as the tie-break. Deterministic.
    balanced: (a, b) => b.quality / (b.expected_credits || 0.01) - a.quality / (a.expected_credits || 0.01) || a.latency - b.latency,
  }[strat];

  // A high-complexity task must not be served by the fast tier when a standard-tier model is
  // compatible and affordable — cost pressure never overrides task fitness.
  const complexity = requirements.complexity || "medium";
  let pool = affordable;
  if (complexity === "high" && strat !== "lowest_cost") {
    const strong = affordable.filter((s) => s.quality >= 2);
    if (strong.length) pool = strong;
  }
  if (requirements.latency_sensitive && strat === "balanced") {
    const quick = pool.filter((s) => s.latency <= 1);
    if (quick.length) pool = quick;
  }
  if (prefer_model_id) {
    const preferred = pool.find((s) => s.model.model_id === prefer_model_id);
    if (preferred) pool = [preferred];
    else decision.rejected.push({ model_id: prefer_model_id, reason: "preferred model is not compatible, affordable or active" });
  }

  const ordered = [...pool].sort(cmp);
  const chosen = ordered[0];
  decision.candidates = ordered.map((s) => ({ model_id: s.model.model_id, quality: s.quality, latency: s.latency, expected_credits: s.expected_credits }));
  decision.model_id = chosen.model.model_id;
  decision.expected_credits = chosen.expected_credits;
  decision.reason = {
    best_quality: "highest quality tier that satisfies the requirements",
    lowest_cost: "cheapest model that satisfies the requirements",
    fastest: "lowest-latency model that satisfies the requirements",
    budget_constrained: "cheapest compatible model within the remaining budget",
    balanced: "best quality per credit among compatible models",
  }[strat];
  // Fallbacks are ordered, compatible and affordable — never an incompatible cheaper model.
  decision.fallbacks = ordered.slice(1, 4).map((s) => s.model_id || s.model.model_id);
  return { model: chosen.model, decision };
}

// Provider health / availability gate: an unhealthy provider's models are excluded, and the
// router falls back to a compatible model on another provider.
export function withProviderHealth(catalog, health = {}) {
  return listModels({ includeInactive: true, catalog }).map((m) => {
    const state = health[m.provider];
    if (state && state.healthy === false) return { ...m, active: false, availability: "unavailable", routing: { ...(m.routing || {}), health: state.reason || "provider unhealthy" } };
    return m;
  });
}

export { getModel };