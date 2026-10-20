// Self-improving router (#41): evidence-driven, deterministic, explainable model selection.
//
// This layer sits ON TOP of what already exists and replaces none of it: the Model Catalog still
// declares capabilities, `matchModels` still does capability matching, the provider-health breaker
// still gates availability, the economics engine still prices, and the Model Gateway still owns
// retries, timeouts and the fallback chain. What this adds is the CHOICE: which eligible model wins,
// scored from persisted #38/#39 evidence under an immutable policy version, with every component,
// candidate and rejection recorded.
//
// Hard rules kept:
//   * eligibility before scoring — capability, active state, provider health, plan restriction and
//     budgets are GATES; a model is never chosen because it scored well despite failing one.
//   * explicit user choice is honoured, never silently substituted. An explicitly chosen model that
//     is ineligible produces an explicit refusal; only the gateway's existing failure fallback may
//     move the work elsewhere, and that is recorded as a fallback.
//   * nothing is fabricated — a dimension with no measured evidence scores from a NAMED prior and
//     says so, so a prior can never be read as a measurement.
//   * deterministic — same inputs + same policy ⇒ same ranking, down to the tie-breaks.
import { MODEL_CATALOG, matchModels } from "./modelCatalog.ts";
import { MODEL_REGISTRY } from "./modelGateway.ts";
import { requirementsFor } from "./aiRouter.ts";
import { estimateMaxCharge, computeProviderCost, DEFAULT_CREDIT_POLICY } from "./economics.ts";
import { isProviderHealthy, providerHealth } from "./providerHealth.ts";
import { resolveNexusConfig, NEXUS_PROVIDER } from "./nexusProvider.ts";
import { resolveEffectivePolicy, defaultPolicy, hash, ROUTING_CONTRACT_VERSION } from "./routingPolicy.ts";
import { scrub, scrubText } from "./tracing.ts";
// Skills (#44) occupy the slot this layer already reserved: they may TIGHTEN the routing inputs and
// they name themselves on the decision. They never relax a requirement and never score a model.
import { skillRoutingHints, skillStrategyRecord, NO_SKILL_STRATEGY } from "./skills.ts";

export const SCORE_DIMENSIONS = ["quality", "reliability", "tool_call_success", "latency", "cost", "capability_match", "health"];
/** Providers whose models are first-party and therefore require real evidence before winning. */
export const FIRST_PARTY_PROVIDERS = [NEXUS_PROVIDER];

const svcOf = (b) => b.asServiceRole || b;
const round = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const fail = (status, code, message, detail = {}) => { throw Object.assign(new Error(message), { status, code, detail }); };

const registryEntry = (model_id) => MODEL_REGISTRY.find((m) => m.model_id === model_id) || null;

// --- routing inputs ------------------------------------------------------------

/**
 * The full routing input set, derived once and recorded verbatim on the decision: task type and
 * complexity, project/context size, tool and structured-output needs, and the caller's budgets.
 */
export function routingInputs({
  mode = "build", task_type = null, prompt = "", fileCount = 0, context_tokens = 0, isRepair = false,
  needs_tools = false, needs_vision = false, needs_streaming = false, needs_structured_output = true, min_context = 0,
} = {}) {
  const base = requirementsFor({ mode, prompt, fileCount, isRepair, needs_vision, needs_tools, needs_streaming, min_context });
  return {
    ...base,
    needs_structured_output: needs_structured_output !== false,
    task_type: task_type || (isRepair ? "repair" : mode),
    mode, project_file_count: fileCount, context_tokens: Number(context_tokens) || 0,
    // Context size is a real requirement, not a hint: a request that will not fit is a capability
    // mismatch, so it is folded into min_context with headroom for the response.
    min_context: Math.max(base.min_context, Math.ceil((Number(context_tokens) || 0) * 1.2)),
  };
}

// --- evidence lookup -----------------------------------------------------------

const priorFor = (policy, model_id) => (policy.model_priors || {})[model_id] || null;

/** One dimension's value from the policy priors, honouring the minimum-sample threshold. */
function measured(policy, model_id, dimension) {
  const prior = priorFor(policy, model_id);
  const d = prior?.[dimension];
  const min = policy.thresholds?.min_evidence_samples ?? 1;
  if (!d || d.value == null || (d.samples || 0) < min) return { value: null, basis: null, samples: d?.samples || 0 };
  return { value: d.value, basis: d.basis || "persisted_evidence", samples: d.samples || 0 };
}

const hasQualityEvidence = (policy, model_id) => measured(policy, model_id, "quality").value != null;

// --- eligibility gates ---------------------------------------------------------

/**
 * Evaluates the gates for ONE model, in a fixed order. Returns null when eligible, or the concrete
 * rejection — every exclusion carries a machine-readable code AND a human reason.
 */
function gate(model, { requirements, policy, budgets, health, allowed_model_ids, nexusConfig }) {
  const id = model.model_id;
  if (allowed_model_ids && allowed_model_ids.length && !allowed_model_ids.includes(id)) {
    return { reason_code: "PLAN_RESTRICTED", reason: "the workspace's plan does not grant access to this model" };
  }
  if (!model.active) return { reason_code: "MODEL_INACTIVE", reason: `model is not active in the catalog (availability: ${model.availability || "unknown"})` };
  if (["unavailable", "deprecated"].includes(model.availability)) return { reason_code: "MODEL_UNAVAILABLE", reason: `catalog availability is ${model.availability}` };
  const state = health[model.provider];
  if (state?.healthy === false || !isProviderHealthy(model.provider)) {
    return { reason_code: "PROVIDER_UNHEALTHY", reason: scrubText(state?.reason || `provider ${model.provider} is unhealthy`, 200) };
  }
  // includeInactive: the active/availability gates above already ran, so this call is purely a
  // capability check and can never silently drop a model without stating a reason.
  const { rejected } = matchModels(requirements, { catalog: [model], includeInactive: true });
  if (rejected.length) return { reason_code: "CAPABILITY_MISMATCH", reason: scrubText(rejected[0].reason || "capabilities do not satisfy the request", 200) };
  // A first-party model must be genuinely reachable AND genuinely measured. No provisioning, no
  // health, or no evidence ⇒ it cannot win automatic routing, whatever its declared tier says.
  if (FIRST_PARTY_PROVIDERS.includes(model.provider)) {
    if (!nexusConfig.provisioned) return { reason_code: "FIRST_PARTY_NOT_PROVISIONED", reason: "first-party inference endpoint is not provisioned" };
    if (policy.thresholds?.require_evidence_for_first_party !== false && !hasQualityEvidence(policy, id)) {
      return { reason_code: "NO_EVIDENCE", reason: "no persisted benchmark or evaluation evidence exists for this first-party model" };
    }
  }
  const reliability = measured(policy, id, "reliability");
  const minReliability = policy.thresholds?.min_reliability;
  if (reliability.value != null && minReliability != null && reliability.value < minReliability) {
    return { reason_code: "RELIABILITY_BELOW_THRESHOLD", reason: `measured reliability ${reliability.value} is below the policy minimum ${minReliability}`, measured_reliability: reliability.value };
  }
  return null;
}

function expectedLatency(model, policy, model_id) {
  const m = measured(policy, model_id, "latency_ms");
  if (m.value != null) return { value: m.value, basis: m.basis, samples: m.samples };
  const declared = model.routing?.expected_latency_ms;
  if (declared != null) return { value: declared, basis: "catalog_declared", samples: 0 };
  const prior = (policy.thresholds?.latency_class_prior_ms || {})[model.routing?.latency_class || "standard"];
  return { value: prior ?? 35000, basis: "latency_class_prior", samples: 0 };
}

function expectedCost(model, { estimate, credit_policy }) {
  const max_input_tokens = estimate?.max_input_tokens || 20000;
  const max_output_tokens = estimate?.max_output_tokens || 4000;
  const credits = estimateMaxCharge({ model_id: model.model_id, max_input_tokens, max_output_tokens, operation_type: estimate?.operation_type || "ai_run", policy: credit_policy }).credits;
  const provider_cost = computeProviderCost({ model_id: model.model_id, usage: { input_tokens: max_input_tokens, output_tokens: max_output_tokens } }).provider_cost;
  return { credits: round(credits), provider_cost: round(provider_cost) };
}

// --- deterministic scoring -----------------------------------------------------

/**
 * Scores one eligible model. Every component records its own evidence basis, and a dimension the
 * request does not care about (tool-call success for a request needing no tools) is EXCLUDED and its
 * weight redistributed — never scored as a zero.
 */
function scoreModel(model, { policy, requirements, cost, latency, maxCredits }) {
  const id = model.model_id;
  const weights = { ...policy.weights };
  const skill = (policy.skill_profiles || {})[id] || null;
  // Reserved skill hook: a future skill profile may bias weights for one model without any change
  // to the decision shape. Absent today, so it changes nothing.
  if (skill?.weight_overrides) for (const [k, v] of Object.entries(skill.weight_overrides)) if (k in weights && Number.isFinite(Number(v))) weights[k] = Number(v);

  const quality = measured(policy, id, "quality");
  const tierPrior = (policy.thresholds?.tier_quality_prior || {})[model.quality_tier] ?? 0.6;
  const reliability = measured(policy, id, "reliability");
  const tools = measured(policy, id, "tool_call_success");
  const components = {
    quality: quality.value != null
      ? { value: clamp01(quality.value), basis: quality.basis, samples: quality.samples, measured: true }
      : { value: clamp01(tierPrior), basis: "catalog_tier_prior", samples: 0, measured: false },
    reliability: reliability.value != null
      ? { value: clamp01(reliability.value), basis: reliability.basis, samples: reliability.samples, measured: true }
      : { value: 0.7, basis: "no_evidence_prior", samples: 0, measured: false },
    latency: { value: clamp01(1 - latency.value / (policy.thresholds?.latency_reference_ms || 90000)), basis: latency.basis, samples: latency.samples, measured: latency.basis === "benchmark_result" || latency.basis === "candidate_evaluation", expected_latency_ms: latency.value },
    cost: { value: clamp01(1 - (maxCredits > 0 ? cost.credits / maxCredits : 0)), basis: "economics_estimate", samples: 0, measured: false, expected_credits: cost.credits },
    capability_match: { value: clamp01(0.5 + 0.5 * Math.min(1, (model.context_window || 0) / 200000)), basis: "catalog_capabilities", samples: 0, measured: true },
    health: { value: 1, basis: "provider_health", samples: 0, measured: true },
  };
  if (requirements.needs_tools) {
    components.tool_call_success = tools.value != null
      ? { value: clamp01(tools.value), basis: tools.basis, samples: tools.samples, measured: true }
      : { value: 0.7, basis: "no_evidence_prior", samples: 0, measured: false };
  } else {
    delete weights.tool_call_success;
  }

  const used = Object.keys(components).filter((k) => weights[k] != null && weights[k] > 0);
  const totalWeight = used.reduce((a, k) => a + weights[k], 0) || 1;
  let score = 0;
  for (const k of used) {
    const contribution = (weights[k] / totalWeight) * components[k].value;
    components[k].weight = round(weights[k] / totalWeight);
    components[k].contribution = round(contribution);
    score += contribution;
  }
  return { score: round(score), components, skill_profile: skill ? { strategy_id: skill.skill_strategy_id || null, source: "policy" } : null };
}

// --- selection -----------------------------------------------------------------

/**
 * Selects a model.
 *
 * @param explicit_model_id the user's own choice. Validated through the SAME gates; if it passes it
 *   is used verbatim with an override reason, and if it fails the caller gets an explicit refusal
 *   instead of a quiet substitution.
 */
export async function selectModel(base44, {
  project_id = null, workspace_id = null, run_id = null, trace_id = null,
  inputs = {}, explicit_model_id = null, budget_credits = null, cost_budget_usd = null, latency_budget_ms = null,
  allowed_model_ids = null, estimate = null, credit_policy = DEFAULT_CREDIT_POLICY,
  policy = null, health = undefined, nexus_config = null, persist = true, skill_strategy = null,
} = {}) {
  const svc = svcOf(base44);
  const resolved = policy ? { policy, resolved_from: "explicit" } : await resolveEffectivePolicy(svc, { project_id });
  const activePolicy = resolved.policy || defaultPolicy();
  // Tighten-only: with no strategy the inputs are exactly the caller's.
  const requirements = routingInputs(skill_strategy ? skillRoutingHints(skill_strategy, inputs) : inputs);
  const healthState = health === undefined ? providerHealth() : (health || {});
  const nexusConfig = resolveNexusConfig(nexus_config);
  const budgets = { budget_credits, cost_budget_usd, latency_budget_ms: latency_budget_ms ?? (activePolicy.thresholds?.latency_reference_ms || null), allowed_model_ids: allowed_model_ids || null };

  const rejected = [];
  const eligible = [];
  for (const model of [...MODEL_CATALOG].sort((a, b) => a.model_id.localeCompare(b.model_id))) {
    const blocked = gate(model, { requirements, policy: activePolicy, budgets, health: healthState, allowed_model_ids, nexusConfig });
    if (blocked) { rejected.push({ model_id: model.model_id, ...blocked }); continue; }
    const cost = expectedCost(model, { estimate, credit_policy });
    const latency = expectedLatency(model, activePolicy, model.model_id);
    if (budget_credits != null && cost.credits > budget_credits) {
      rejected.push({ model_id: model.model_id, reason_code: "CREDIT_BUDGET_EXCEEDED", reason: `expected ${cost.credits} credits exceeds the remaining budget of ${budget_credits}`, expected_credits: cost.credits });
      continue;
    }
    if (cost_budget_usd != null && cost.provider_cost > cost_budget_usd) {
      rejected.push({ model_id: model.model_id, reason_code: "COST_BUDGET_EXCEEDED", reason: `expected provider cost ${cost.provider_cost} exceeds the budget of ${cost_budget_usd}`, expected_provider_cost: cost.provider_cost });
      continue;
    }
    if (budgets.latency_budget_ms != null && latency.value > budgets.latency_budget_ms) {
      rejected.push({ model_id: model.model_id, reason_code: "LATENCY_BUDGET_EXCEEDED", reason: `expected ${latency.value}ms exceeds the latency budget of ${budgets.latency_budget_ms}ms`, expected_latency_ms: latency.value });
      continue;
    }
    eligible.push({ model, cost, latency });
  }

  const decisionBase = {
    policy_version: activePolicy.policy_version, contract_version: activePolicy.contract_version || ROUTING_CONTRACT_VERSION,
    policy_resolved_from: resolved.resolved_from, requirements, budgets,
    // The (model + skill strategy) pair. Filled by the Skills layer when the caller selected skills
    // for this request; otherwise the same explicitly empty slot as before.
    skill_strategy: skill_strategy ? skillStrategyRecord(skill_strategy) : { ...NO_SKILL_STRATEGY },
    evidence_basis: {
      sources: activePolicy.evidence_sources || [],
      models_with_quality_evidence: Object.keys(activePolicy.model_priors || {}).filter((id) => hasQualityEvidence(activePolicy, id)).sort(),
      snapshot: activePolicy.evidence_snapshot || {},
    },
  };

  // ---- explicit user selection
  if (explicit_model_id) {
    const model = MODEL_CATALOG.find((m) => m.model_id === explicit_model_id);
    if (!model) fail(400, "UNKNOWN_MODEL", `Unknown model id: ${explicit_model_id}`);
    const chosen = eligible.find((e) => e.model.model_id === explicit_model_id);
    if (!chosen) {
      const why = rejected.find((r) => r.model_id === explicit_model_id);
      fail(409, "EXPLICIT_MODEL_UNAVAILABLE", `The selected model ${explicit_model_id} cannot serve this request: ${why?.reason || "it is not eligible"}`, { model_id: explicit_model_id, reason_code: why?.reason_code || "INELIGIBLE", rejected });
    }
    const decision = {
      ...decisionBase, mode: "explicit", selected_model_id: explicit_model_id, selected_provider: model.provider,
      selected_score: null, score_components: {},
      override_reason: "explicit_user_selection: the user chose this model, so automatic scoring was not applied",
      candidates: [{ model_id: explicit_model_id, score: null, expected_credits: chosen.cost.credits, expected_latency_ms: chosen.latency.value, selected: true }],
      rejected,
      // Fallbacks remain the gateway's EXISTING chain, ordered by this policy's own scoring, so a
      // failure never lands on a model this request already rejected.
      fallbacks: rankEligible(eligible.filter((e) => e.model.model_id !== explicit_model_id), activePolicy, requirements).map((c) => c.model_id).slice(0, 3),
      deterministic_key: hash("rdec", { policy: activePolicy.policy_version, requirements, budgets, explicit_model_id, eligible: eligible.map((e) => e.model.model_id) }),
    };
    const persisted = persist ? await persistRoutingDecision(svc, { decision, project_id, workspace_id, run_id, trace_id }) : null;
    return { model: registryEntry(explicit_model_id), decision, decision_id: persisted?.id || null, fallbacks: decision.fallbacks };
  }

  // ---- automatic selection
  if (!eligible.length) {
    fail(422, "NO_ELIGIBLE_MODEL", "No model satisfies this request's capabilities, health, plan and budget constraints", { rejected });
  }
  const ranked = rankEligible(eligible, activePolicy, requirements);
  const winner = ranked[0];
  const decision = {
    ...decisionBase, mode: "automatic", selected_model_id: winner.model_id, selected_provider: winner.provider,
    selected_score: winner.score, score_components: winner.components,
    override_reason: null, candidates: ranked, rejected,
    fallbacks: ranked.slice(1, 4).map((c) => c.model_id),
    deterministic_key: hash("rdec", { policy: activePolicy.policy_version, requirements, budgets, eligible: eligible.map((e) => e.model.model_id) }),
  };
  const persisted = persist ? await persistRoutingDecision(svc, { decision, project_id, workspace_id, run_id, trace_id }) : null;
  return { model: registryEntry(winner.model_id), decision, decision_id: persisted?.id || null, fallbacks: decision.fallbacks };
}

/** Deterministic ranking: score desc, then cheaper, then faster, then model_id — no ties left open. */
function rankEligible(eligible, policy, requirements) {
  const maxCredits = Math.max(0, ...eligible.map((e) => e.cost.credits || 0));
  return eligible
    .map(({ model, cost, latency }) => {
      const { score, components, skill_profile } = scoreModel(model, { policy, requirements, cost, latency, maxCredits });
      return {
        model_id: model.model_id, provider: model.provider, gateway_provider: model.gateway_provider,
        quality_tier: model.quality_tier, score, components, skill_profile,
        expected_credits: cost.credits, expected_provider_cost: cost.provider_cost, expected_latency_ms: latency.value,
        evidence_measured_dimensions: Object.values(components).filter((c) => c.measured).length,
      };
    })
    .sort((a, b) => b.score - a.score || a.expected_credits - b.expected_credits || a.expected_latency_ms - b.expected_latency_ms || a.model_id.localeCompare(b.model_id));
}

// --- explainability persistence -----------------------------------------------

/** Writes the decision record. Best-effort by construction: explainability must never fail routing. */
export async function persistRoutingDecision(svc, { decision, project_id = null, workspace_id = null, run_id = null, trace_id = null }) {
  try {
    return await svcOf(svc).entities.RoutingDecision.create(scrub({
      project_id: project_id || undefined, workspace_id: workspace_id || undefined,
      run_id: run_id || undefined, trace_id: trace_id || undefined,
      policy_version: decision.policy_version, contract_version: decision.contract_version,
      mode: decision.mode, selected_model_id: decision.selected_model_id, selected_provider: decision.selected_provider,
      selected_score: decision.selected_score, score_components: decision.score_components,
      candidates: decision.candidates, rejected: decision.rejected, requirements: decision.requirements,
      budgets: decision.budgets, override_reason: decision.override_reason || undefined,
      skill_strategy: decision.skill_strategy, evidence_basis: decision.evidence_basis,
      deterministic_key: decision.deterministic_key, created_at: new Date().toISOString(),
    }));
  } catch {
    return null;
  }
}

/**
 * Records that the gateway's EXISTING fallback chain moved the work to another model. Called after
 * execution with what the gateway itself reported — this layer performs no fallback of its own.
 */
export async function recordFallback(svc, { decision_id, fallback_model_id, from_model_id, error_code = null, retryable = null }) {
  if (!decision_id || !fallback_model_id) return null;
  return svcOf(svc).entities.RoutingDecision.update(decision_id, {
    fallback_model_id, fallback_reason: scrubText(`${from_model_id} failed with ${error_code || "a retryable provider error"}${retryable === false ? " (terminal)" : ""}; the gateway's fallback chain served the request with ${fallback_model_id}`, 300),
  }).catch(() => null);
}

export const routerContract = () => ({
  contract_version: ROUTING_CONTRACT_VERSION, score_dimensions: SCORE_DIMENSIONS,
  first_party_providers: FIRST_PARTY_PROVIDERS,
  rejection_codes: ["PLAN_RESTRICTED", "MODEL_INACTIVE", "MODEL_UNAVAILABLE", "PROVIDER_UNHEALTHY", "CAPABILITY_MISMATCH", "FIRST_PARTY_NOT_PROVISIONED", "NO_EVIDENCE", "RELIABILITY_BELOW_THRESHOLD", "CREDIT_BUDGET_EXCEEDED", "COST_BUDGET_EXCEEDED", "LATENCY_BUDGET_EXCEEDED"],
});