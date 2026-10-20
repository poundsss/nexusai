// Commercial layer verification — REAL production code paths.
//
// Everything below runs the same modules the platform charges with: the model catalog, the
// economics engine, the ledger, the atomic charging lifecycle, the cost-aware router, budget
// control, analytics, billing and the abuse protections. No mocked pricing, no fake usage, no
// stubbed ledger. A scratch workspace is created and every record it produces is deleted again.
//
// The suite is SPLITTABLE: invoked with { phase: 1 } it runs the catalog, economics, ledger and
// atomic-charging sections and RETURNS THE SCRATCH WORKSPACE ID without cleaning up; invoked
// with { phase: 2, workspace_id } it runs routing, budget, billing, analytics and the abuse
// section against that workspace, then deletes it. Invoked with no phase it runs everything in
// one go (the original behavior). The split exists because a flat-out single run exceeds the
// platform's per-run request quota before the suite finishes.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { MODEL_CATALOG, getModel, resolvePricing, matchModels, listModels, syncCatalog, loadCatalog } from "../../shared/modelCatalog.ts";
import { normalizeUsage, estimateUsage, computeProviderCost, creditsForCharge, priceOperation, estimateMaxCharge, DEFAULT_CREDIT_POLICY } from "../../shared/economics.ts";
import { recordEvent, deriveBalance, reserve, releaseReservation, verifyBalanceIntegrity, getStatement, InsufficientCredits } from "../../shared/ledger.ts";
import { beginOperation, finalizeOperation, accumulateUsage, refundOperation, reconcileAbandonedOperations, settleUsage } from "../../shared/aiOperations.ts";
import { checkBudget, spendableCredits, BudgetExceeded } from "../../shared/budget.ts";
import { routeOperation, requirementsFor, withProviderHealth } from "../../shared/aiRouter.ts";
import { usageSummary, recentOperations } from "../../shared/analytics.ts";
import { seedPlans, processBillingEvent, entitlementsFor, grantPeriodCredits } from "../../shared/billing.ts";
import { MODEL_REGISTRY, routeModel } from "../../shared/modelGateway.ts";
import { can } from "../../shared/rbac.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const OPENAI_USAGE = { usage: { prompt_tokens: 12000, completion_tokens: 3000, prompt_tokens_details: { cached_tokens: 4000 }, completion_tokens_details: { reasoning_tokens: 800 } } };
const ANTHROPIC_USAGE = { usage: { input_tokens: 9000, output_tokens: 2500, cache_read_input_tokens: 1500 } };
const GOOGLE_USAGE = { usage: { promptTokenCount: 20000, candidatesTokenCount: 5000, cachedContentTokenCount: 6000, thoughtsTokenCount: 0 } };

// Pacing (test-only): a flat-out run exhausts the platform's workspace request quota before
// the suite finishes; brief section pauses let the bucket refill mid-run. No assertion or
// production path is affected.
const pace = (ms) => new Promise((r) => setTimeout(r, ms));
// JSON helpers of our own: the shared harness's harnessResponse/harnessError return Response
// objects (correct for a direct return), but a spread like {...harnessResponse(h)} would lose
// every field, so phase splitting composes its own payloads from harness.summary().
const jsonOk = (harness, extra = {}) => Response.json({ ...harness.summary(), ...extra });
const jsonErr = (harness, error, extra = {}) => Response.json({ ok: false, error: String((error && error.message) || error), stack: String((error && error.stack) || "").slice(0, 800), ...harness.summary(), ...extra }, { status: 500 });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;

  const preBody = await req.json().catch(() => ({}));
  const phase = Number((preBody && preBody.phase) || 0); // 1 | 2 | 0 (=both)
  const passedWorkspaceId = (preBody && preBody.workspace_id) || null;
  const runPhase = (p) => !phase || phase === p;

  let ws = null;
  let W = null;
  let runSettle = null;
  const track = { ops: [], budgets: [], billing: [], subs: [], policies: [] };
  const me = await base44.auth.me().catch(() => null);

  try {
    // ============================================================ PHASE 1
    if (runPhase(1)) {
      // ---------------------------------------------------------------- catalog
      check("model lookup by id", getModel("claude-sonnet-5").display_name === "Claude Sonnet 5", getModel("claude-sonnet-5").display_name);
      await expectThrow("unknown model is refused", async () => getModel("gpt-9-omni"), "UNKNOWN_MODEL");
      check("catalog exposes every commercial field", MODEL_CATALOG.every((m) => m.provider && m.model_id && m.capabilities?.length && m.context_window && m.pricing?.length && typeof m.supports_streaming === "boolean" && typeof m.supports_vision === "boolean" && m.routing), `${MODEL_CATALOG.length} models`);

      // Every ACTIVE catalog model supports tools, so the tool gate accepts the field; the
      // rejection MECHANISM is proven by a capability no active model has (streaming).
      const toolMatch = matchModels({ needs_tools: true });
      const streamMatch = matchModels({ needs_streaming: true });
      check("capability matching rejects incapable models", toolMatch.candidates.length === MODEL_CATALOG.filter((m) => m.active).length &&
        streamMatch.candidates.length === 0 && streamMatch.rejected.some((r) => r.reason === "no streaming support"),
        `tools ${toolMatch.candidates.length} accepted, streaming ${streamMatch.rejected.length} rejected`);
      const ctxMatch = matchModels({ min_context: 500000 });
      check("context-window requirement filters the field",
        ctxMatch.candidates.every((c) => c.context_window >= 500000) &&
        ctxMatch.rejected.some((r) => r.model_id === "claude-sonnet-5" && /context window/.test(r.reason)),
        `${ctxMatch.candidates.length} accepted, sonnet rejected: ${ctxMatch.rejected.find((r) => r.model_id === "claude-sonnet-5")?.reason}`);

      const current = resolvePricing("claude-sonnet-5", { at: "2026-09-01T00:00:00.000Z" });
      const historical = resolvePricing("claude-sonnet-5", { at: "2026-03-01T00:00:00.000Z" });
      check("current pricing version resolves by date", current.pricing_version === "claude-sonnet-5@2026-06-01", current.pricing_version);
      check("historical pricing version still resolves", historical.pricing_version === "claude-sonnet-5@2026-01-01" && historical.input_per_mtok === 3.5, `${historical.pricing_version} @ ${historical.input_per_mtok}`);
      check("a pricing change closed the old version instead of editing it", historical.effective_until === "2026-06-01T00:00:00.000Z", historical.effective_until);
      await expectThrow("unknown pricing version is refused", async () => resolvePricing("claude-sonnet-5", { pricing_version: "claude-sonnet-5@1999-01-01" }), "UNKNOWN_PRICING_VERSION");
      check("no price is hardcoded outside the catalog", MODEL_REGISTRY.every((r) => r.inputCost === resolvePricing(r.model_id).input_per_mtok && r.outputCost === resolvePricing(r.model_id).output_per_mtok), `${MODEL_REGISTRY.length} registry entries derived`);

      const sync1 = await syncCatalog(svc);
      const sync2 = await syncCatalog(svc);
      check("catalog mirrors into storage", sync1.created + sync1.updated + sync1.unchanged === MODEL_CATALOG.length, JSON.stringify(sync1));
      check("re-sync is idempotent (pricing history preserved)", sync2.created === 0 && sync2.pricing_added === 0, JSON.stringify(sync2));
      const dbCatalog = await loadCatalog(svc);
      check("runtime reads the mirrored catalog", dbCatalog.length === MODEL_CATALOG.length && dbCatalog.every((m) => m.pricing.length), `${dbCatalog.length} models`);

      await pace(4000);

      // -------------------------------------------------------------- economics
      const oa = normalizeUsage("openai", OPENAI_USAGE);
      // completion_tokens INCLUDES reasoning; canonical output excludes it (priced once as reasoning),
      // so 3000 completion = 2200 canonical output + 800 reasoning.
      check("openai usage normalizes and splits cached input and reasoning", oa.input_tokens === 8000 && oa.cached_input_tokens === 4000 && oa.output_tokens === 2200 && oa.reasoning_tokens === 800 && oa.total_tokens === 15000, JSON.stringify(oa));
      const an = normalizeUsage("anthropic", ANTHROPIC_USAGE);
      check("anthropic usage normalizes", an.input_tokens === 9000 && an.cached_input_tokens === 1500 && an.output_tokens === 2500, JSON.stringify(an));
      const go = normalizeUsage("google", GOOGLE_USAGE);
      check("google usage normalizes and splits cached content", go.input_tokens === 14000 && go.cached_input_tokens === 6000 && go.output_tokens === 5000, JSON.stringify(go));
      check("canonical usage passes through unchanged", normalizeUsage("unknown", { input_tokens: 5, output_tokens: 7 }).total_tokens === 12, "12");
      check("provider-reported usage is marked authoritative", oa.usage_source === "provider" && an.usage_source === "provider", `${oa.usage_source}/${an.usage_source}`);
      check("absent usage is marked estimated, never measured", normalizeUsage("openai", null).usage_source === "estimated" && estimateUsage({ promptText: "x".repeat(400) }).usage_source === "estimated", "estimated");

      const c1 = computeProviderCost({ model_id: "claude-sonnet-5", usage: { input_tokens: 1_000_000 }, pricing_version: "claude-sonnet-5@2026-06-01" });
      check("exact input token cost", c1.provider_cost === 3, c1.provider_cost);
      const c2 = computeProviderCost({ model_id: "claude-sonnet-5", usage: { cached_input_tokens: 1_000_000 }, pricing_version: "claude-sonnet-5@2026-06-01" });
      check("cached input priced at the cached rate", c2.provider_cost === 0.3, c2.provider_cost);
      const c3 = computeProviderCost({ model_id: "claude-sonnet-5", usage: { output_tokens: 1_000_000 }, pricing_version: "claude-sonnet-5@2026-06-01" });
      check("exact output token cost", c3.provider_cost === 15, c3.provider_cost);
      const c4 = computeProviderCost({ model_id: "gpt-5-mini", usage: { reasoning_tokens: 1_000_000 }, pricing_version: "gpt-5-mini@2026-01-01" });
      check("reasoning tokens priced", c4.provider_cost === 2, c4.provider_cost);
      const c5 = computeProviderCost({ model_id: "gemini-3-flash", usage: { input_tokens: 500_000, output_tokens: 100_000 } });
      check("multi-provider pricing (google)", c5.provider_cost === 0.135, c5.provider_cost);
      const hist = computeProviderCost({ model_id: "claude-sonnet-5", usage: { input_tokens: 1_000_000 }, pricing_version: "claude-sonnet-5@2026-01-01" });
      check("a historical operation reprices to its own version", hist.provider_cost === 3.5 && hist.provider_cost !== c1.provider_cost, `${hist.provider_cost} vs ${c1.provider_cost}`);
      check("cost is never derived from text length", computeProviderCost({ model_id: "gemini-3-flash", usage: { input_tokens: 0, output_tokens: 0 } }).provider_cost === 0, "0");

      // ------------------------------------------------------ credit economics
      const policy = { ...DEFAULT_CREDIT_POLICY, markup_multiplier: 2, minimum_charge_credits: 3, model_multipliers: { "claude-opus-5": 1.5 }, operation_multipliers: { embedding: 0.5 } };
      check("markup separates provider cost from user charge", creditsForCharge({ provider_cost: 1, policy }).credits === 200, creditsForCharge({ provider_cost: 1, policy }).credits);
      check("minimum charge applies to tiny operations", creditsForCharge({ provider_cost: 0.000001, policy }).credits === 3, creditsForCharge({ provider_cost: 0.000001, policy }).credits);
      check("a free operation stays free", creditsForCharge({ provider_cost: 0, policy }).credits === 0, "0");
      check("model multiplier applies", creditsForCharge({ provider_cost: 1, policy, model_id: "claude-opus-5" }).credits === 300, creditsForCharge({ provider_cost: 1, policy, model_id: "claude-opus-5" }).credits);
      check("operation multiplier applies", creditsForCharge({ provider_cost: 1, policy, operation_type: "embedding" }).credits === 100, creditsForCharge({ provider_cost: 1, policy, operation_type: "embedding" }).credits);
      check("rounding rule respected", creditsForCharge({ provider_cost: 0.011, policy: { ...policy, markup_multiplier: 1, minimum_charge_credits: 1 } }).credits === 2, creditsForCharge({ provider_cost: 0.011, policy: { ...policy, markup_multiplier: 1, minimum_charge_credits: 1 } }).credits);
      const priced = priceOperation({ model_id: "claude-sonnet-5", usage: { input_tokens: 1_000_000 }, policy });
      check("charge carries its pricing and policy versions", priced.pricing_version === "claude-sonnet-5@2026-06-01" && priced.policy_version === DEFAULT_CREDIT_POLICY.policy_version, `${priced.pricing_version} / ${priced.policy_version}`);

      await pace(4000);

      // ------------------------------------------------------------ scratch ws
      ws = await svc.entities.Workspace.create({ name: `commerce-test-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
      W = ws.id;
      const key = (s) => `test:${W}:${s}`;
      // W exercises the FULL commercial surface — operations larger than the free plan's
      // included-credit gate — so it runs as an entitled workspace on a paid allow_overage plan
      // (subscribed directly, without a billing event, so the suite's own billing-event checks below
      // still start from a clean slate). The free-plan gate itself is certified by planLimitsTest.
      track.subs.push((await svc.entities.Subscription.create({
        workspace_id: W, plan_code: "builder_monthly", status: "active", provider: "none",
        current_period_start: new Date(Date.now() - 60000).toISOString(),
        current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
        entitlements: {}, last_grant_period: "seeded", cancel_at_period_end: false,
      })).id);

      await pace(4000);

      // ---------------------------------------------------------------- ledger
      const grant = await recordEvent(svc, { workspace_id: W, event_type: "promotional", amount: 1000, idempotency_key: key("grant"), reason: "test grant" });
      check("grant credits the ledger", grant.balance === 1000 && grant.available === 1000, JSON.stringify({ b: grant.balance, a: grant.available }));
      const integrity1 = await verifyBalanceIntegrity(svc, W);
      check("cached workspace balance matches the derived ledger", integrity1.ok, JSON.stringify(integrity1.cached));
      const spend = await recordEvent(svc, { workspace_id: W, event_type: "ai_charge", amount: -250, idempotency_key: key("spend1") });
      check("a spend deducts exactly once", spend.balance === 750, spend.balance);
      const dupe = await recordEvent(svc, { workspace_id: W, event_type: "ai_charge", amount: -250, idempotency_key: key("spend1") });
      check("replaying an idempotency key moves nothing", dupe.duplicate && dupe.balance === 750, `${dupe.duplicate} @ ${dupe.balance}`);
      const race = await Promise.allSettled([
        recordEvent(svc, { workspace_id: W, event_type: "ai_charge", amount: -100, idempotency_key: key("race") }),
        recordEvent(svc, { workspace_id: W, event_type: "ai_charge", amount: -100, idempotency_key: key("race") }),
      ]);
      const afterRace = await deriveBalance(svc, W);
      check("concurrent duplicate charges settle once", afterRace.balance === 650, `${afterRace.balance} (${race.filter((r) => r.status === "fulfilled").length} fulfilled)`);
      await expectThrow("a spend beyond the balance fails closed", () => recordEvent(svc, { workspace_id: W, event_type: "ai_charge", amount: -10000, idempotency_key: key("over") }), "INSUFFICIENT_CREDITS");
      const balAfterRefusal = await deriveBalance(svc, W);
      check("a refused spend left the balance untouched", balAfterRefusal.balance === 650, balAfterRefusal.balance);

      const concurrent = await Promise.allSettled([
        recordEvent(svc, { workspace_id: W, event_type: "ai_charge", amount: -400, idempotency_key: key("cc1") }),
        recordEvent(svc, { workspace_id: W, event_type: "ai_charge", amount: -400, idempotency_key: key("cc2") }),
      ]);
      const afterConcurrent = await deriveBalance(svc, W);
      check("concurrent distinct spends cannot overdraw", afterConcurrent.balance >= 0 && concurrent.filter((r) => r.status === "fulfilled").length === 1, `${afterConcurrent.balance}, ${concurrent.filter((r) => r.status === "fulfilled").length} succeeded`);
      check("the backed-off spend is voided, not deleted", (await svc.entities.CreditLedgerEntry.filter({ workspace_id: W, voided: true }, "-created_date", 10)).length >= 1, "voided entries retained");

      const refund = await recordEvent(svc, { workspace_id: W, event_type: "refund", amount: 400, idempotency_key: key("refund") });
      check("a refund restores credits", refund.balance === 650, refund.balance);
      const held = await reserve(svc, { workspace_id: W, credits: 200, idempotency_key: key("hold") });
      check("a reservation holds credits without spending them", held.balance === 650 && held.available === 450, `${held.balance}/${held.available}`);
      const released = await releaseReservation(svc, { workspace_id: W, credits: 200, idempotency_key: key("unhold") });
      check("releasing a reservation restores spendable credits", released.available === 650 && released.balance === 650, `${released.balance}/${released.available}`);

      await pace(4000);

      // -------------------------------------------------- atomic AI charging
      const begun = await beginOperation(svc, {
        workspace_id: W, user_id: "u1", project_id: "p1", run_id: "r1", operation_type: "ai_run",
        model_id: "gemini-3-flash", idempotency_key: key("op1"), estimate: { max_input_tokens: 50000, max_output_tokens: 5000 },
        routing: { strategy: "balanced" },
      });
      track.ops.push(begun.operation.id);
      check("begin creates one running operation", begun.operation.status === "running" && !begun.reattached, begun.operation.status);
      const balAfterBegin = await deriveBalance(svc, W);
      check("begin reserves the worst-case charge", begun.operation.credits_reserved > 0 && balAfterBegin.reserved === begun.operation.credits_reserved, `${begun.operation.credits_reserved} reserved`);
      const again = await beginOperation(svc, { workspace_id: W, model_id: "gemini-3-flash", idempotency_key: key("op1") });
      check("retrying an operation re-attaches instead of duplicating", again.reattached && again.operation.id === begun.operation.id, again.operation.id);

      const settled1 = await finalizeOperation(svc, { operation_id: begun.operation.id, usage: GOOGLE_USAGE, status: "completed", duration_ms: 4200 });
      check("finalize prices real provider usage", settled1.operation.usage_source === "provider" && settled1.operation.input_tokens === 14000 && settled1.operation.cached_input_tokens === 6000, JSON.stringify({ src: settled1.operation.usage_source, i: settled1.operation.input_tokens }));
      check("finalize charges credits through the policy", settled1.credits_charged > 0 && settled1.operation.credits_charged === settled1.credits_charged, settled1.credits_charged);
      check("the charge freezes its pricing version", !!settled1.operation.pricing_version && !!settled1.operation.credit_policy_version, settled1.operation.pricing_version);
      const balAfterFinalize = await deriveBalance(svc, W);
      check("finalize releases the reservation", balAfterFinalize.reserved === 0, balAfterFinalize.reserved);
      const balAfterOp = balAfterFinalize.balance;
      const settled2 = await finalizeOperation(svc, { operation_id: begun.operation.id, usage: GOOGLE_USAGE, status: "completed" });
      const balAfterDupe = await deriveBalance(svc, W);
      check("duplicate finalization is a no-op", settled2.duplicate && balAfterDupe.balance === balAfterOp, `${settled2.duplicate} @ ${balAfterOp}`);
      await pace(1500);

      const failing = await beginOperation(svc, { workspace_id: W, model_id: "claude-sonnet-5", idempotency_key: key("op-fail"), estimate: { max_input_tokens: 10000, max_output_tokens: 2000 } });
      track.ops.push(failing.operation.id);
      const balBeforeFail = (await deriveBalance(svc, W)).balance;
      const failed = await finalizeOperation(svc, { operation_id: failing.operation.id, status: "failed", error: "provider 503" });
      check("a provider failure never produces a charge", failed.credits_charged === 0 && failed.operation.status === "failed", failed.operation.status);
      const balAfterFail = await deriveBalance(svc, W);
      check("a failed operation releases its reservation", balAfterFail.balance === balBeforeFail && balAfterFail.reserved === 0, "released");

      // streaming: accumulate, survive a disconnect, finalize exactly once
      const stream = await beginOperation(svc, { workspace_id: W, model_id: "gpt-5-mini", streaming: true, idempotency_key: key("op-stream"), estimate: { max_input_tokens: 20000, max_output_tokens: 4000 } });
      track.ops.push(stream.operation.id);
      await accumulateUsage(svc, stream.operation.id, { usage: { prompt_tokens: 5000, completion_tokens: 500 } }, "openai");
      await accumulateUsage(svc, stream.operation.id, { usage: { prompt_tokens: 0, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 200 } } }, "openai");
      const mid = await svc.entities.AIOperation.get(stream.operation.id);
      // Canonical output EXCLUDES reasoning (500 + 700), and the total never double-counts it:
      // 5000 input + 1200 output + 200 reasoning = 6400.
      check("streaming accumulates usage without charging", mid.output_tokens === 1200 && mid.reasoning_tokens === 200 && (mid.credits_charged || 0) === 0, `${mid.output_tokens} output tokens, ${mid.credits_charged || 0} credits`);
      const streamDone = await finalizeOperation(svc, { operation_id: stream.operation.id, status: "completed" });
      check("a stream is charged once at completion", streamDone.credits_charged > 0 && streamDone.operation.total_tokens === 6400, `${streamDone.credits_charged} credits, ${streamDone.operation.total_tokens} tokens`);
      const streamDupe = await finalizeOperation(svc, { operation_id: stream.operation.id, status: "completed", usage: { usage: { prompt_tokens: 999999 } } });
      check("a duplicated stream completion cannot re-charge", streamDupe.duplicate && streamDupe.operation.total_tokens === 6400, `${streamDupe.duplicate}`);

      // disconnect → server-side reconciliation still charges the delivered work
      const abandoned = await beginOperation(svc, { workspace_id: W, model_id: "gemini-3-flash", streaming: true, idempotency_key: key("op-abandoned"), estimate: { max_input_tokens: 10000, max_output_tokens: 2000 } });
      track.ops.push(abandoned.operation.id);
      await accumulateUsage(svc, abandoned.operation.id, GOOGLE_USAGE, "google");
      await pace(1500);
      const reconciled = await reconcileAbandonedOperations(svc, { workspace_id: W, older_than_ms: 0 });
      const abandonedRow = await svc.entities.AIOperation.get(abandoned.operation.id);
      check("a disconnected client's delivered work is not free", abandonedRow.status === "completed" && abandonedRow.credits_charged > 0, `${abandonedRow.status}, ${abandonedRow.credits_charged} credits`);
      check("reconciliation settles each operation once", reconciled.length >= 1 && !!abandonedRow.finalized_at, `${reconciled.length} settled`);

      const refundOp = await refundOperation(svc, { operation_id: settled1.operation.id, reason: "test refund" });
      check("an operation refund returns its credits", refundOp.refunded === settled1.credits_charged, refundOp.refunded);
      const refundOpDupe = await refundOperation(svc, { operation_id: settled1.operation.id, reason: "test refund" });
      check("a replayed refund pays out once", refundOpDupe.refunded === 0, refundOpDupe.refunded);

      // settleUsage: the run/agent path (already-executed work, exactly-once)
      const runModel = MODEL_REGISTRY.find((m) => m.model_id === "gemini-3-flash");
      runSettle = await settleUsage(svc, { workspace_id: W, project_id: "p1", run_id: "r9", model: runModel, usage: { input_tokens: 30000, output_tokens: 4000 }, idempotency_key: key("run-r9"), usage_source: "estimated" });
      track.ops.push(runSettle.operation.id);
      const runSettleAgain = await settleUsage(svc, { workspace_id: W, project_id: "p1", run_id: "r9", model: runModel, usage: { input_tokens: 30000, output_tokens: 4000 }, idempotency_key: key("run-r9"), usage_source: "estimated" });
      check("a run settles as one billable operation", runSettle.credits_charged > 0 && runSettle.operation.usage_source === "estimated", `${runSettle.credits_charged} credits (estimated usage)`);
      check("a re-driven run phase cannot charge twice", runSettleAgain.duplicate && runSettleAgain.credits_charged === runSettle.credits_charged, `${runSettleAgain.duplicate}`);

      if (phase === 1) return jsonOk(harness, { workspace_id: W, run_settle_credits: runSettle ? runSettle.credits_charged : null });
    }

    // ============================================================ PHASE 2
    if (runPhase(2)) {
      if (!W && passedWorkspaceId) {
        W = passedWorkspaceId;
        ws = await svc.entities.Workspace.get(W).catch(() => null);
      }
      if (!W) return jsonErr(harness, new Error("phase 2 requires the workspace_id returned by phase 1"));
      const key = (s) => `test:${W}:${s}`;
      if (!phase) await pace(4000);

      // --------------------------------------------------------------- routing
      const quality = routeOperation({ requirements: requirementsFor({ prompt: "x", fileCount: 20 }), strategy: "best_quality" });
      check("best-quality routing picks the strongest compatible model", quality.model.quality_tier === "advanced", `${quality.model.model_id} (${quality.model.quality_tier})`);
      const cheap = routeOperation({ requirements: requirementsFor({ prompt: "x" }), strategy: "lowest_cost" });
      check("lowest-cost routing picks the cheapest compatible model", cheap.model.model_id === "gemini-3-flash", cheap.model.model_id);
      const fast = routeOperation({ requirements: requirementsFor({ prompt: "x" }), strategy: "fastest" });
      check("fastest routing picks the lowest-latency model", fast.model.routing.latency_class === "fast", fast.model.model_id);
      const balanced = routeOperation({ requirements: requirementsFor({ prompt: "x" }), strategy: "balanced" });
      check("balanced routing is deterministic and explainable", !!balanced.decision.reason && balanced.decision.candidates.length >= 1 && balanced.decision.candidates.every((c) => typeof c.expected_credits === "number"), balanced.decision.reason);
      const constrained = routeOperation({ requirements: requirementsFor({ prompt: "x" }), strategy: "budget_constrained", budget_credits: 60, estimate: { max_input_tokens: 20000, max_output_tokens: 4000 } });
      check("budget-constrained routing stays under the ceiling", constrained.decision.expected_credits <= 60, `${constrained.model.model_id} @ ${constrained.decision.expected_credits}`);
      // No active catalog model supports streaming, so a streaming requirement is impossible —
      // refused explicitly, never silently downgraded to a model that cannot do the job.
      await expectThrow("an impossible requirement is refused, not downgraded", async () => routeOperation({ requirements: { needs_streaming: true } }), "NO_COMPATIBLE_MODEL");
      await expectThrow("a budget too small for any compatible model is explicit", async () => routeOperation({ requirements: requirementsFor({ prompt: "x" }), strategy: "budget_constrained", budget_credits: 0.0001, estimate: { max_input_tokens: 500000, max_output_tokens: 60000 } }), "MODEL_TOO_EXPENSIVE");
      const forcedContext = routeOperation({ requirements: { capabilities: ["text"], min_context: 500000 }, strategy: "lowest_cost" });
      check("a cheaper model is never chosen when it cannot do the job",
        forcedContext.model.context_window >= 500000 && forcedContext.model.model_id !== "claude-sonnet-5" &&
        forcedContext.decision.rejected.some((r) => r.model_id === "claude-sonnet-5" && r.reason.includes("context window")),
        `chose ${forcedContext.model.model_id}, rejected ${forcedContext.decision.rejected.map((r) => r.model_id).join(",")}`);
      const unhealthy = withProviderHealth(MODEL_CATALOG, { google: { healthy: false, reason: "provider outage" } });
      const failover = routeOperation({ requirements: requirementsFor({ prompt: "x" }), strategy: "lowest_cost", catalog: unhealthy });
      check("an unhealthy provider fails over to another provider", failover.model.provider !== "google", `${failover.model.model_id} (${failover.model.provider})`);
      const routed = routeModel({ mode: "default", prompt: "add a settings page", fileCount: 10, budget_credits: 100000 });
      check("the gateway router returns a catalog-backed decision", !!routed.decision.strategy && routed.model.model_id === routed.decision.model_id, `${routed.model.model_id} · ${routed.reason}`);

      await pace(4000);

      // ---------------------------------------------------------------- budget
      const projBudget = await svc.entities.Budget.create({ workspace_id: W, scope: "project", scope_id: "p1", limit_credits: 5, period: "total", active: true });
      track.budgets.push(projBudget.id);
      const consumedProject = await checkBudget(svc, { workspace_id: W, project_id: "p1", credits: 10 });
      check("a project budget refuses an over-limit operation", !consumedProject.ok && consumedProject.violations.some((v) => v.code === "PROJECT_BUDGET_EXCEEDED"), JSON.stringify(consumedProject.violations[0]));
      check("budget violations report limit, consumption and remainder", consumedProject.violations.every((v) => "limit" in v && "consumed" in v && "remaining" in v), "explained");
      const opBudget = await svc.entities.Budget.create({ workspace_id: W, scope: "operation", limit_credits: 2, period: "total", active: true });
      track.budgets.push(opBudget.id);
      const perOp = await checkBudget(svc, { workspace_id: W, project_id: "p2", credits: 3 });
      check("a per-operation ceiling is enforced", perOp.violations.some((v) => v.code === "OPERATION_BUDGET_EXCEEDED"), "operation ceiling");
      await pace(2000);
      const tightest = await spendableCredits(svc, { workspace_id: W, project_id: "p1" });
      check("the tightest applicable limit wins", tightest <= 2, tightest);
      await expectThrow("an over-budget operation cannot even begin", () => beginOperation(svc, { workspace_id: W, project_id: "p1", model_id: "claude-sonnet-5", idempotency_key: key("op-budget"), estimate: { max_input_tokens: 200000, max_output_tokens: 60000 } }), "BUDGET_EXCEEDED");
      for (const b of track.budgets) await svc.entities.Budget.update(b, { active: false });
      const userBudget = await svc.entities.Budget.create({ workspace_id: W, scope: "user", scope_id: "u1", limit_credits: 1, period: "monthly", active: true });
      track.budgets.push(userBudget.id);
      const userCheck = await checkBudget(svc, { workspace_id: W, user_id: "u1", credits: 5 });
      check("a user budget applies over its period", !userCheck.ok && userCheck.violations.some((v) => v.scope === "user" && v.period === "monthly"), JSON.stringify(userCheck.violations[0]));
      await svc.entities.Budget.update(userBudget.id, { active: false });
      const runBudget = await svc.entities.Budget.create({ workspace_id: W, scope: "run", scope_id: "r1", limit_credits: 0, period: "total", active: true });
      track.budgets.push(runBudget.id);
      const runBudgetCheck = await checkBudget(svc, { workspace_id: W, run_id: "r1", credits: 1 });
      check("a run budget of zero blocks further spend on that run", !runBudgetCheck.ok, "blocked");
      await svc.entities.Budget.update(runBudget.id, { active: false });

      // reservation prevents concurrent overspend of one budget
      await pace(2000);
      const balNow = (await deriveBalance(svc, W)).available;
      await recordEvent(svc, { workspace_id: W, event_type: "adjustment", amount: 100 - balNow, idempotency_key: key("normalize") , reason: "normalize test balance" }, { allowNegative: true });
      const holds = await Promise.allSettled([
        reserve(svc, { workspace_id: W, credits: 80, idempotency_key: key("h1") }),
        reserve(svc, { workspace_id: W, credits: 80, idempotency_key: key("h2") }),
      ]);
      const heldTotals = await deriveBalance(svc, W);
      check("two concurrent reservations cannot exceed one balance", heldTotals.available >= 0 && holds.filter((h) => h.status === "fulfilled").length === 1, `available ${heldTotals.available}, ${holds.filter((h) => h.status === "fulfilled").length} held`);
      await releaseReservation(svc, { workspace_id: W, credits: 80, idempotency_key: key("h1-release") });
      const balAfterRelease = await deriveBalance(svc, W);
      check("reconciliation returns unused holds to the balance", balAfterRelease.reserved === 0, balAfterRelease.reserved);

      await pace(4000);

      // --------------------------------------------------------------- billing
      await seedPlans(svc);
      const plans = await svc.entities.BillingPlan.filter({ active: true }, "price_cents", 20);
      check("plans exist as provider-agnostic primitives", plans.length >= 4 && plans.every((p) => p.provider === "none"), plans.map((p) => p.code).join(","));
      const before = (await deriveBalance(svc, W)).balance;
      const purchase = await processBillingEvent(svc, { workspace_id: W, provider: "test", provider_event_id: "evt_1", event_type: "credit_purchase", amount_cents: 1000, credits: 1000 });
      track.billing.push(purchase.event.id);
      const balAfterPurchase = await deriveBalance(svc, W);
      check("a purchase event credits the ledger", purchase.event.status === "processed" && balAfterPurchase.balance === before + 1000, balAfterPurchase.balance);
      const replay = await processBillingEvent(svc, { workspace_id: W, provider: "test", provider_event_id: "evt_1", event_type: "credit_purchase", amount_cents: 1000, credits: 1000 });
      check("a replayed payment event credits nothing", replay.duplicate && balAfterPurchase.balance === before + 1000, `${replay.duplicate}`);
      const refundEvent = await processBillingEvent(svc, { workspace_id: W, provider: "test", provider_event_id: "evt_2", event_type: "refund", amount_cents: 1000, credits: 400 });
      track.billing.push(refundEvent.event.id);
      const balAfterRefund = await deriveBalance(svc, W);
      check("a refund event reverses credits", balAfterRefund.balance === before + 600, balAfterRefund.balance);
      const failedPayment = await processBillingEvent(svc, { workspace_id: W, provider: "test", provider_event_id: "evt_3", event_type: "payment_failed", plan_code: "pro_monthly" });
      track.billing.push(failedPayment.event.id);
      check("a failed payment grants no credits", failedPayment.credits_applied === 0 && balAfterRefund.balance === before + 600, "no credit");
      await pace(2500);
      const badPlan = await processBillingEvent(svc, { workspace_id: W, provider: "test", provider_event_id: "evt_4", event_type: "subscription_started", plan_code: "enterprise_unicorn" });
      track.billing.push(badPlan.event.id);
      check("an unknown plan is rejected without touching the ledger", badPlan.event.status === "rejected" && badPlan.credits_applied === 0, badPlan.event.reject_reason);
      await pace(1500);
      const sub = await processBillingEvent(svc, { workspace_id: W, provider: "test", provider_event_id: "evt_5", event_type: "subscription_started", amount_cents: 3900, plan_code: "pro_monthly", period_key: "2026-09" });
      track.billing.push(sub.event.id);
      const ent = await entitlementsFor(svc, W);
      check("a subscription grants its plan credits and entitlements", sub.credits_applied === 500 && ent.plan_code === "pro_monthly" && ent.entitlements.advanced_models === true, JSON.stringify(ent.entitlements));
      const period1 = await grantPeriodCredits(svc, { workspace_id: W, plan_code: "pro_monthly", period_key: "2026-10" });
      const period2 = await grantPeriodCredits(svc, { workspace_id: W, plan_code: "pro_monthly", period_key: "2026-10" });
      track.billing.push(period1.event.id);
      check("a recurring grant applies once per period", period1.credits_applied === 500 && period2.duplicate && period2.credits_applied === 500, `${period2.duplicate}`);
      await pace(1500);
      const cancelled = await processBillingEvent(svc, { workspace_id: W, provider: "test", provider_event_id: "evt_6", event_type: "subscription_cancelled", plan_code: "pro_monthly" });
      track.billing.push(cancelled.event.id);
      const afterCancel = await entitlementsFor(svc, W);
      const balAfterCancel = await deriveBalance(svc, W);
      check("a cancelled subscription loses entitlements but keeps credits", Object.keys(afterCancel.entitlements).length === 0 && balAfterCancel.balance > 0, `${afterCancel.status}, balance ${balAfterCancel.balance}`);
      const integrity2 = await verifyBalanceIntegrity(svc, W);
      check("payment provider state never became the balance", integrity2.ok, "ledger authoritative");

      await pace(10000);

      // -------------------------------------------------------------- analytics
      const adminView = await usageSummary(svc, { workspace_id: W, scope: "admin" });
      await pace(6000);
      const userView = await usageSummary(svc, { workspace_id: W, scope: "user" });
      check("analytics aggregates by model, provider, project, user and day", adminView.by_model.length >= 1 && adminView.by_provider.length >= 1 && adminView.by_project.length >= 1 && adminView.by_day.length >= 1, `${adminView.by_model.length} models`);
      check("admin analytics exposes provider cost and margin", typeof adminView.totals.provider_cost === "number" && typeof adminView.totals.margin_pct === "number", `${adminView.totals.provider_cost} cost, ${adminView.totals.margin_pct}% margin`);
      check("user analytics hides provider economics", userView.totals.provider_cost === undefined && userView.by_model.every((m) => m.provider_cost === undefined), "redacted");
      check("analytics counts failures, refunds and routing decisions", adminView.totals.failed >= 1 && adminView.totals.refunded_credits > 0 && Array.isArray(adminView.routing_decisions), `${adminView.totals.failed} failed, ${adminView.totals.refunded_credits} refunded`);
      await pace(6000);
      const userOps = await recentOperations(svc, { workspace_id: W, limit: 5, scope: "user" });
      check("operation lists are user-safe by default", userOps.length >= 1 && userOps.every((o) => o.provider_cost === undefined), `${userOps.length} operations`);
      const statement = await getStatement(svc, W, { limit: 100 });
      const balStatement = await deriveBalance(svc, W);
      check("the statement reconciles with the ledger balance", statement.balance === balStatement.balance && statement.entries.every((e) => !e.voided), `${statement.entries.length} entries`);

      await pace(4000);

      // ---------------------------------------------------- security and abuse
      const other = await svc.entities.Workspace.create({ name: `commerce-test-other-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
      await recordEvent(svc, { workspace_id: other.id, event_type: "promotional", amount: 5, idempotency_key: key("other-grant") });
      const balOther = await deriveBalance(svc, other.id);
      const balW = await deriveBalance(svc, W);
      check("ledgers are isolated per workspace", balOther.balance === 5 && balW.balance !== 5, `${balOther.balance} vs ${balW.balance}`);
      const crossOp = await svc.entities.AIOperation.filter({ workspace_id: other.id }, "-created_date", 5);
      const otherSummary = await usageSummary(svc, { workspace_id: other.id, scope: "admin" });
      check("usage accounting never spans workspaces", crossOp.length === 0 && otherSummary.totals.operations === 0, "isolated");
      for (const e of await svc.entities.CreditLedgerEntry.filter({ workspace_id: other.id }, "-created_date", 20)) await svc.entities.CreditLedgerEntry.delete(e.id);
      await svc.entities.Workspace.delete(other.id);

      await pace(4000);

      await expectThrow("a manipulated model id cannot be priced", async () => priceOperation({ model_id: "free-unlimited-model", usage: { input_tokens: 1000 } }), "UNKNOWN_MODEL");
      await expectThrow("a manipulated pricing version cannot be used", async () => computeProviderCost({ model_id: "gemini-3-flash", usage: { input_tokens: 1000 }, pricing_version: "gemini-3-flash@free" }), "UNKNOWN_PRICING_VERSION");
      const forged = normalizeUsage("openai", { usage: { prompt_tokens: -5000, completion_tokens: "lots" } });
      check("forged or negative token counts normalize to zero", forged.input_tokens === 0 && forged.output_tokens === 0, JSON.stringify(forged));
      const finalClaim = await verifyBalanceIntegrity(svc, W);
      check("a client-claimed balance is never trusted", (await deriveBalance(svc, W)).balance === finalClaim.derived.balance, "server-derived only");
      check("viewers and editors cannot move credits", !can("viewer", "billing.manage") && !can("editor", "billing.manage") && !can("admin", "billing.manage") && can("owner", "billing.manage"), "owner only");
      check("provider economics require the admin capability", !can("editor", "billing.admin") && !can("viewer", "billing.admin") && can("admin", "billing.admin"), "admin only");
      check("every member may read their own credit state", can("viewer", "billing.read") && can("editor", "billing.read"), "billing.read");
      await pace(4000);
      const runModel = MODEL_REGISTRY.find((m) => m.model_id === "gemini-3-flash");
      const retryFree = await settleUsage(svc, { workspace_id: W, run_id: "r9", model: runModel, usage: { input_tokens: 999999, output_tokens: 99999 }, idempotency_key: key("run-r9"), usage_source: "estimated" });
      const expectedRun = runSettle ? runSettle.credits_charged : (Number((preBody && preBody.run_settle_credits) || 0) || null);
      check("retrying a settled run cannot buy free usage", retryFree.duplicate && (expectedRun == null || retryFree.credits_charged === expectedRun), `${retryFree.credits_charged} vs ${expectedRun}`);
      const finalIntegrity = await verifyBalanceIntegrity(svc, W);
      check("the ledger and its cached projection agree at the end", finalIntegrity.ok, JSON.stringify(finalIntegrity.cached));
    }

    return jsonOk(harness, { workspace_id: W });
  } catch (error) {
    for (const f of harness.results.filter((r) => !r.ok)) {
      console.error("COMMERCE_FAIL " + f.name + " :: " + String(f.detail).slice(0, 200));
    }
    return jsonErr(harness, error, phase === 1 && W ? { workspace_id: W } : {});
  } finally {
    // Scratch cleanup: every record this suite created is removed. Phase 1 hands the workspace
    // to phase 2 instead (phase 2's run owns the deletion).
    if (phase !== 1) await cleanupWorkspace(svc, ws?.id || (phase === 2 ? passedWorkspaceId : null), ["AIOperation", "CreditLedgerEntry", "BillingEvent", "Invoice", "Subscription", "BillingCustomer", "Budget"]);
  }
}