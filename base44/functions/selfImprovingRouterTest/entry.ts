// Focused certification for #41 — the self-improving router.
//
// Drives the REAL evidence reader, the REAL immutable policy lifecycle and the REAL deterministic
// scorer against purpose-built #38/#39 records in an isolated scratch workspace. Nothing here
// fabricates a quality number: every measured dimension comes from a record this suite persisted,
// and a model with no evidence must be visibly unmeasured.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { gatherRoutingEvidence } from "../../shared/routingEvidence.ts";
import { proposePolicyFromEvidence, activatePolicy, rollbackPolicy, listPolicies, getActivePolicy, resolveEffectivePolicy, defaultPolicy, routingPolicyContract } from "../../shared/routingPolicy.ts";
import { selectModel, recordFallback, routerContract } from "../../shared/selfImprovingRouter.ts";
import { resetProviderHealth, markProviderUnhealthy } from "../../shared/providerHealth.ts";
import { NEXUS_MODEL_ID } from "../../shared/nexusProvider.ts";

const STRONG = "gemini-3-flash";   // measured well by an evaluation (#39)
const WEAK = "claude-sonnet-5";    // measured poorly by benchmarks (#38)
const UNMEASURED = "gpt-5-mini";   // deliberately has no evidence at all
const SECRET = "sk_live_ROUTERLEAK0987654321";

const codeFor = (decision, model_id) => (decision.rejected.find((r) => r.model_id === model_id) || {}).reason_code || null;
const cand = (decision, model_id) => (decision.candidates || []).find((c) => c.model_id === model_id) || null;

export default async function (request) {
  const base44 = createClientFromRequest(request);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let workspace = null, project = null;
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    resetProviderHealth();

    workspace = await svc.entities.Workspace.create({ name: `router41-${Date.now()}`, owner_id: user.id, status: "active", credits_balance: 500 });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: "router41", framework: "preact-htm", status: "draft" });
    const scope = { scope: "project", project_id: project.id };

    // ---------------------------------------------------------------- #38 / #39 evidence fixtures
    const benchmark_id = `bench_${project.id}`;
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push({ benchmark_id, workspace_id: workspace.id, task_id: `t${i}`, candidate_id: `c_${WEAK}`, model_id: WEAK, provider: "anthropic", run_key: `rk_weak_${project.id}_${i}`, status: "COMPLETED", scored: true, failure_class: "none", metrics: { task_success: 0, latency_ms: 40000, extended: { tool_call_success: 0.4 } }, usage: { provider_cost: 0.2 } });
      results.push({ benchmark_id, workspace_id: workspace.id, task_id: `t${i}`, candidate_id: `c_${STRONG}`, model_id: STRONG, provider: "google", run_key: `rk_strong_${project.id}_${i}`, status: "COMPLETED", scored: true, failure_class: "none", metrics: { task_success: 1, latency_ms: 8000, extended: { tool_call_success: 0.9 } }, usage: { provider_cost: 0.01 } });
    }
    // Infrastructure noise: a provider failure that is recorded but NOT scored, so it may lower
    // reliability without ever becoming a quality signal.
    results.push({ benchmark_id, workspace_id: workspace.id, task_id: "t9", candidate_id: `c_${STRONG}`, model_id: STRONG, provider: "google", run_key: `rk_strong_${project.id}_fail`, status: "FAILED", scored: false, failure_class: "model_provider_failure", metrics: {} });
    await svc.entities.BenchmarkResult.bulkCreate(results);
    const evaluation = await svc.entities.CandidateEvaluation.create({
      harness_version: "1.0.0", name: "router evidence", dataset_id: `ds_${project.id}`, dataset_version: 1, dataset_checksum: "chk",
      scope: "project", project_id: project.id, workspace_id: workspace.id,
      candidate_id: `cand_${STRONG}`, candidate: { model_id: STRONG, provider: "google", model_version: "1" },
      evaluation_key: `ek_${project.id}`, status: "FINALIZED", finalized: true,
      metrics: { task_success_rate: 0.95, runtime_success_rate: 0.98, tool_call_success_rate: 0.92, avg_latency_ms: 9000, provider_cost_per_success: 0.012 },
      coverage: { items_considered: 20, items_scored: 20 },
    });

    // ---------------------------------------------------------------- 1. evidence gathering
    const evidence = await gatherRoutingEvidence(svc, { scope: "project", project_id: project.id, workspace_id: workspace.id });
    h.check("1 benchmark evidence is read from SCORED #38 results only",
      evidence.models[WEAK]?.quality.value === 0 && evidence.models[WEAK].quality.basis === "benchmark_result" && evidence.models[WEAK].quality.samples === 4 && evidence.models[WEAK].latency_ms.value === 40000,
      `weak quality ${JSON.stringify(evidence.models[WEAK]?.quality)}`);
    h.check("1b an unscored provider failure is recorded but never becomes a quality signal",
      evidence.models[STRONG].reliability.value != null && evidence.snapshot.benchmark_results === 9 && evidence.snapshot.scored_benchmark_results === 8 && evidence.models[STRONG].quality.samples === 1,
      `${evidence.snapshot.scored_benchmark_results}/${evidence.snapshot.benchmark_results} scored`);
    h.check("2 evaluation evidence (#39) takes precedence per dimension",
      evidence.models[STRONG].quality.value === 0.95 && evidence.models[STRONG].quality.basis === "candidate_evaluation" && evidence.models[STRONG].reliability.basis === "candidate_evaluation" && evidence.models[STRONG].latency_ms.value === 9000,
      JSON.stringify(evidence.models[STRONG].sources));
    h.check("3 no fabricated quality: a model with no evidence stays null, not defaulted",
      !evidence.models[UNMEASURED] && !evidence.models[NEXUS_MODEL_ID] && !evidence.snapshot.models_with_quality_evidence.includes(UNMEASURED),
      `covered: ${evidence.snapshot.models_covered.join(",")}`);
    await h.expectThrow("3b raw production telemetry is inadmissible as routing evidence",
      () => gatherRoutingEvidence(svc, { scope: "project", project_id: project.id, sources: ["production_telemetry"] }), "INADMISSIBLE_EVIDENCE_SOURCE");

    // ---------------------------------------------------------------- 4. policy versioning
    const proposed = await proposePolicyFromEvidence(base44, user, { ...scope, notes: `first policy ${SECRET}` });
    const again = await proposePolicyFromEvidence(base44, user, scope);
    h.check("4 a policy version is created from persisted evidence and is idempotent",
      proposed.created === true && proposed.policy.status === "DRAFT" && proposed.policy.version === 1 && proposed.policy.model_priors[STRONG]?.quality.value === 0.95 && again.created === false && again.policy.policy_version === proposed.policy.policy_version,
      `${proposed.policy.policy_version} v${proposed.policy.version}`);
    h.check("4b the policy records its evidence sources, snapshot and checksum, and redacts notes",
      proposed.policy.evidence_sources.join(",") === "benchmark_result,candidate_evaluation" && !!proposed.policy.evidence_checksum && !!proposed.policy.checksum && !JSON.stringify(proposed.policy).includes(SECRET),
      proposed.policy.evidence_checksum);
    const activated = await activatePolicy(base44, user, { policy_version: proposed.policy.policy_version });
    const v2 = await proposePolicyFromEvidence(base44, user, { ...scope, weights: { cost: 0.4 } });
    const activated2 = await activatePolicy(base44, user, { policy_version: v2.policy.policy_version });
    const superseded = (await listPolicies(base44, user, scope)).policies.find((p) => p.policy_version === proposed.policy.policy_version);
    h.check("4c activation supersedes the previous version instead of editing it; one ACTIVE per scope",
      activated.policy.status === "ACTIVE" && activated2.policy.status === "ACTIVE" && activated2.policy.version === 2 && superseded.status === "SUPERSEDED" && superseded.superseded_by === v2.policy.policy_version && superseded.weights.cost === proposed.policy.weights.cost && v2.policy.parent_policy_version === proposed.policy.policy_version,
      `v1 → ${superseded.status}, v2 → ACTIVE`);
    const rolled = await rollbackPolicy(base44, user, scope);
    const activeNow = await getActivePolicy(svc, scope);
    h.check("4d rollback re-activates the previous immutable version and marks the newer one rolled back",
      rolled.policy.policy_version === proposed.policy.policy_version && rolled.policy.rollback_of === v2.policy.policy_version && activeNow.policy_version === proposed.policy.policy_version && rolled.rolled_back_from.status === "ROLLED_BACK",
      `active → v${activeNow.version}`);
    const effective = await resolveEffectivePolicy(svc, { project_id: project.id });
    h.check("4e routing resolves the project's own active policy, and an unpolicied scope falls back to the named default contract",
      effective.resolved_from === "project" && effective.policy.policy_version === proposed.policy.policy_version && defaultPolicy().policy_version === routingPolicyContract().default_policy_version,
      effective.resolved_from);
    const policy = activeNow;

    // ---------------------------------------------------------------- 5. automatic selection
    const auto = await selectModel(base44, { project_id: project.id, workspace_id: workspace.id, policy, inputs: { mode: "build", prompt: "add a notes page", fileCount: 3 } });
    h.check("5 the evidence-backed model wins automatic selection, with explainable components",
      auto.decision.selected_model_id === STRONG && auto.decision.mode === "automatic" && auto.decision.score_components.quality.value === 0.95 && auto.decision.score_components.quality.basis === "candidate_evaluation" && auto.decision.score_components.quality.measured === true && auto.decision.selected_score > (cand(auto.decision, WEAK)?.score || 1),
      `${auto.decision.selected_model_id} @ ${auto.decision.selected_score} vs ${WEAK} @ ${cand(auto.decision, WEAK)?.score}`);
    h.check("5b an unmeasured model scores from a NAMED prior that is never presented as a measurement",
      cand(auto.decision, UNMEASURED)?.components.quality.basis === "catalog_tier_prior" && cand(auto.decision, UNMEASURED).components.quality.measured === false && cand(auto.decision, UNMEASURED).components.quality.samples === 0,
      JSON.stringify(cand(auto.decision, UNMEASURED)?.components.quality));
    h.check("5c every component carries a normalized weight and contribution",
      Math.abs(Object.values(auto.decision.score_components).reduce((a, c) => a + (c.weight || 0), 0) - 1) < 1e-6 && auto.decision.score_components.health.basis === "provider_health",
      `weights sum ${Object.values(auto.decision.score_components).reduce((a, c) => a + (c.weight || 0), 0)}`);

    // ---------------------------------------------------------------- 6. capability matching + Nexus
    const bigContext = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x", context_tokens: 400000 } });
    h.check("6 capability matching gates on real catalog limits before any scoring",
      bigContext.decision.selected_model_id === STRONG && codeFor(bigContext.decision, WEAK) === "CAPABILITY_MISMATCH" && /context window/.test(bigContext.decision.rejected.find((r) => r.model_id === WEAK).reason),
      bigContext.decision.rejected.find((r) => r.model_id === WEAK)?.reason);
    await h.expectThrow("6b a request no eligible model can satisfy is refused explicitly, never approximated",
      () => selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x", context_tokens: 5000000 } }), "NO_ELIGIBLE_MODEL");
    // Beyond every catalog context window, so no model is eligible (tool support is now common in the catalog).
    const toolReq = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x", context_tokens: 5000000 } }).catch((e) => e);
    const nexusReason = (toolReq.detail?.rejected || []).find((r) => r.model_id === NEXUS_MODEL_ID);
    h.check("7 inactive Nexus is suppressed with a stated reason and can never win",
      nexusReason?.reason_code === "MODEL_INACTIVE" && !auto.decision.candidates.some((c) => c.model_id === NEXUS_MODEL_ID) && !bigContext.decision.candidates.some((c) => c.model_id === NEXUS_MODEL_ID),
      `${NEXUS_MODEL_ID} → ${nexusReason?.reason_code}`);

    // ---------------------------------------------------------------- 8. explicit override
    const explicit = await selectModel(base44, { project_id: project.id, workspace_id: workspace.id, policy, inputs: { mode: "build", prompt: "x" }, explicit_model_id: WEAK });
    h.check("8 an explicit user choice is honoured verbatim and never silently substituted",
      explicit.decision.mode === "explicit" && explicit.decision.selected_model_id === WEAK && explicit.decision.selected_score === null && /explicit_user_selection/.test(explicit.decision.override_reason) && explicit.model.model_id === WEAK,
      explicit.decision.override_reason);
    await h.expectThrow("8b an explicit choice that cannot serve the request is refused, not swapped",
      () => selectModel(base44, { project_id: project.id, policy, persist: false, explicit_model_id: UNMEASURED, inputs: { mode: "build", prompt: "x", context_tokens: 400000 } }), "EXPLICIT_MODEL_UNAVAILABLE");

    // ---------------------------------------------------------------- 9. budgets
    const strongCredits = cand(auto.decision, STRONG).expected_credits;
    const weakCredits = cand(auto.decision, WEAK).expected_credits;
    const budgeted = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x" }, budget_credits: strongCredits });
    h.check("9 the credit budget is a hard gate with the numbers stated",
      budgeted.decision.selected_model_id === STRONG && codeFor(budgeted.decision, WEAK) === "CREDIT_BUDGET_EXCEEDED" && weakCredits > strongCredits && budgeted.decision.budgets.budget_credits === strongCredits,
      `${STRONG} ${strongCredits} credits vs ${WEAK} ${weakCredits}`);
    await h.expectThrow("9b a budget no model fits refuses the request rather than overspending",
      () => selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x" }, budget_credits: 0 }), "NO_ELIGIBLE_MODEL");
    const latencyBudget = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x" }, latency_budget_ms: 12000 });
    h.check("10 the latency budget is enforced from MEASURED latency where evidence exists",
      latencyBudget.decision.selected_model_id === STRONG && codeFor(latencyBudget.decision, WEAK) === "LATENCY_BUDGET_EXCEEDED" && cand(latencyBudget.decision, STRONG).expected_latency_ms === 9000 && cand(latencyBudget.decision, UNMEASURED).components.latency.basis === "catalog_declared",
      `${WEAK} → ${latencyBudget.decision.rejected.find((r) => r.model_id === WEAK)?.reason}`);
    const costBudget = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x" }, cost_budget_usd: cand(auto.decision, STRONG).expected_provider_cost });
    h.check("10b the provider-cost budget is enforced separately from credits",
      costBudget.decision.selected_model_id === STRONG && codeFor(costBudget.decision, WEAK) === "COST_BUDGET_EXCEEDED",
      `${WEAK} → ${codeFor(costBudget.decision, WEAK)}`);

    // ---------------------------------------------------------------- 11. unhealthy suppression
    markProviderUnhealthy("google", "forced for certification");
    const gated = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x" } });
    resetProviderHealth();
    const healthy = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "x" } });
    h.check("11 an unhealthy provider's models are suppressed and the choice moves to a healthy one",
      gated.decision.selected_model_id !== STRONG && codeFor(gated.decision, STRONG) === "PROVIDER_UNHEALTHY" && healthy.decision.selected_model_id === STRONG,
      `gated → ${gated.decision.selected_model_id}; recovered → ${healthy.decision.selected_model_id}`);

    // ---------------------------------------------------------------- 12. fallback chain
    h.check("12 fallbacks are the gateway's existing chain, ranked by this policy and free of rejected models",
      auto.decision.fallbacks.length >= 1 && !auto.decision.fallbacks.includes(STRONG) && !auto.decision.fallbacks.includes(NEXUS_MODEL_ID) && !latencyBudget.decision.fallbacks.includes(WEAK) && explicit.decision.fallbacks.includes(STRONG),
      `auto → ${auto.decision.fallbacks.join(",")}`);
    await recordFallback(svc, { decision_id: auto.decision_id, fallback_model_id: auto.decision.fallbacks[0], from_model_id: STRONG, error_code: "PROVIDER_TIMEOUT", retryable: true });
    const withFallback = await svc.entities.RoutingDecision.get(auto.decision_id);
    h.check("12b a gateway fallback is recorded against the decision it deviated from",
      withFallback.fallback_model_id === auto.decision.fallbacks[0] && /PROVIDER_TIMEOUT/.test(withFallback.fallback_reason) && withFallback.selected_model_id === STRONG,
      withFallback.fallback_reason);

    // ---------------------------------------------------------------- 13. determinism
    const again1 = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "add a notes page", fileCount: 3 } });
    const again2 = await selectModel(base44, { project_id: project.id, policy, persist: false, inputs: { mode: "build", prompt: "add a notes page", fileCount: 3 } });
    h.check("13 the same inputs under the same policy reproduce the same ranking exactly",
      again1.decision.deterministic_key === again2.decision.deterministic_key && again1.decision.deterministic_key === auto.decision.deterministic_key && JSON.stringify(again1.decision.candidates.map((c) => [c.model_id, c.score])) === JSON.stringify(again2.decision.candidates.map((c) => [c.model_id, c.score])),
      again1.decision.deterministic_key);
    const flat = { ...policy, weights: { health: 1 }, policy_version: `${policy.policy_version}_flat` };
    const tied = await selectModel(base44, { project_id: project.id, policy: flat, persist: false, inputs: { mode: "build", prompt: "x" } });
    const scores = tied.decision.candidates.map((c) => c.score);
    const expectedOrder = [...tied.decision.candidates].sort((a, b) => a.expected_credits - b.expected_credits || a.expected_latency_ms - b.expected_latency_ms || a.model_id.localeCompare(b.model_id)).map((c) => c.model_id);
    h.check("13b tied scores are broken deterministically: cheaper, then faster, then model id",
      new Set(scores).size === 1 && JSON.stringify(tied.decision.candidates.map((c) => c.model_id)) === JSON.stringify(expectedOrder),
      `${scores[0]} → ${expectedOrder.join(",")}`);

    // ---------------------------------------------------------------- 14. decision metadata
    const stored = await svc.entities.RoutingDecision.filter({ project_id: project.id }, "-created_date", 10);
    const rec = stored.find((d) => d.id === auto.decision_id);
    h.check("14 the decision record carries the full explainability trail",
      stored.length === 2 && rec.policy_version === policy.policy_version && rec.contract_version === policy.contract_version && rec.candidates.length === auto.decision.candidates.length && rec.rejected.every((r) => !!r.reason_code && !!r.reason) && !!rec.requirements.task_type && !!rec.deterministic_key && rec.evidence_basis.models_with_quality_evidence.includes(STRONG),
      `${stored.length} decisions; policy ${rec.policy_version}`);
    h.check("14b the reserved (model + skill strategy) slot is present and explicitly empty",
      rec.skill_strategy.strategy_id === null && rec.skill_strategy.source === "none" && routerContract().score_dimensions.length === 7 && routerContract().rejection_codes.includes("PROVIDER_UNHEALTHY"),
      JSON.stringify(rec.skill_strategy));
    h.check("14c the record names the evidence layers it was derived from and leaks nothing",
      rec.evidence_basis.sources.includes("candidate_evaluation") && rec.evidence_basis.sources.includes("benchmark_result") && !JSON.stringify(stored).includes(SECRET),
      rec.evidence_basis.sources.join(","));

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    resetProviderHealth();
    if (project) {
      for (const name of ["RoutingDecision", "RoutingPolicy", "CandidateEvaluation"]) await purgeBy(svc, name, { project_id: project.id });
      await svc.entities.Project.delete(project.id).catch(() => {});
    }
    if (workspace) await cleanupWorkspace(svc, workspace.id, ["BenchmarkResult", "CandidateEvaluation", "AuditLog"]);
  }
}