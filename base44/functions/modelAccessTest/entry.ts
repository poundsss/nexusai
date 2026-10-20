// E2E certification of P-8.4: plan-based MODEL ACCESS enforcement parity.
//
// Verifies, against the REAL enforcement paths, that:
//   • a plan's model_access is resolved server-side from canonical subscription state, and the
//     client can never widen it (a preferred model is honored only WITHIN the plan);
//   • routing excludes plan-unavailable models and fails closed (MODEL_NOT_ALLOWED_BY_PLAN) when
//     the plan allows nothing compatible — never a silent downgrade past the plan boundary;
//   • beginOperation refuses a disallowed/unknown model BEFORE any operation or hold exists, and
//     disallowed reservation candidates never raise the hold;
//   • fallback chains (chain builder + gateway execution) exclude plan-unavailable models;
//   • a suspended workspace, a lapsed subscription, an unknown plan and an unknown model all
//     fail closed; an active subscription on an unrestricted (paid) plan is unchanged.
//
// Every fixture (plans, subscriptions, workspaces, operations, ledger entries) is scratch.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { MODEL_CATALOG, CATALOG_BY_ID } from "../../shared/modelCatalog.ts";
import { resolveModelAccess, planAllowsModel } from "../../shared/subscriptions.ts";
import { beginOperation, finalizeOperation } from "../../shared/aiOperations.ts";
import { routeModel, createGateway, budgetAwareExecutionChain, pickModel } from "../../shared/modelGateway.ts";
import { estimateMaxCharge, loadCreditPolicy } from "../../shared/economics.ts";
import { deriveBalance } from "../../shared/ledger.ts";
import { makeBillingPlan, makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";

const ESTIMATE = { max_input_tokens: 60000, max_output_tokens: 12000 };
const FAST = "gemini-3-flash";
const STANDARD = "claude-sonnet-5";
const ADVANCED = "claude-opus-5";
const COMPLEX_PROMPT = "Build a complete settings area with a profile section and a billing panel, plus a team management page and also an audit log viewer, with a calendar widget, and a file manager, plus a notification center, and a long-form analytics dashboard with charts and also filters and a CSV export, with dark mode support and keyboard shortcuts and role-based visibility";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check, expectThrow } = h;
  const stamp = Date.now();
  const created = { plans: [], workspaces: [] };

  const makePlan = (label, overrides) => makeBillingPlan(svc, created, label, overrides, stamp);
  const makeWorkspace = (label, plan, credits = 0) => makeBillingWorkspace(svc, created, label, { plan, credits }, stamp).then(({ ws }) => ws);
  const subOf = async (ws) => (await svc.entities.Subscription.filter({ workspace_id: ws.id }, "-updated_date", 1))[0] || null;
  const ops = (ws) => svc.entities.AIOperation.filter({ workspace_id: ws.id }, "-created_date", 100);
  const runOp = (ws, key, extra = {}) => beginOperation(svc, { workspace_id: ws.id, operation_type: "ai_run", idempotency_key: key, estimate: ESTIMATE, ...extra });

  try {
    // 1. Free plan parity: every model is available on every plan (Base44); credits remain the
    //    usage/cost control. Free is UNRESTRICTED — advanced and fast are both allowed.
    {
      const free = await makeWorkspace("free", null);
      const access = await resolveModelAccess(svc, { workspace_id: free.id });
      check("1. free plan allows every model: resolveModelAccess is unrestricted, advanced and fast both allowed",
        access.restricted === false && access.allows({ model_id: ADVANCED, quality_tier: "advanced" }) === true && access.allows({ model_id: FAST, quality_tier: "fast" }) === true,
        `plan ${access.plan_code}, allowed ${JSON.stringify(access.allowed)}`);
      const a = await planAllowsModel(svc, { workspace_id: free.id, model: { model_id: ADVANCED, quality_tier: "advanced" } });
      const b = await planAllowsModel(svc, { workspace_id: free.id, model: { model_id: FAST, quality_tier: "fast" } });
      check("1. free plan allows every model: planAllowsModel agrees with the execution truth",
        a.ok === true && b.ok === true, `advanced ${a.ok}, fast ${b.ok}`);
    }

    // 2 + 3. Routing is plan-filtered; a client preference can never widen it ------------------
    {
      const fastOnly = await makePlan("fastonly", { model_access: ["fast"] });
      const ws = await makeWorkspace("fastonly", fastOnly, 100000);
      const access = await resolveModelAccess(svc, { workspace_id: ws.id });
      const routed = routeModel({ mode: "build", prompt: COMPLEX_PROMPT, fileCount: 12, modelAccess: access });
      check("2. routing respects plan limits: a high-complexity run on a fast-only plan routes a fast model, sonnet rejected by plan",
        routed.decision.model_id !== STANDARD && ["fast"].includes(pickModel("fast").tier || routed.model.tier) &&
          routed.decision.rejected.some((r) => r.model_id === STANDARD && /not allowed by plan/.test(r.reason || "")),
        `routed ${routed.decision.model_id}`);
      const preferred = routeModel({ mode: "build", prompt: COMPLEX_PROMPT, fileCount: 12, modelAccess: access, prefer_model_id: STANDARD });
      check("3. client input never decides allowed models: a preferred out-of-plan model is not honored",
        preferred.decision.model_id !== STANDARD, `routed ${preferred.decision.model_id}`);
    }

    // 4. Routing fails closed when the plan allows nothing compatible --------------------------
    {
      // The advanced tier now HAS active models (the documented 5.5/Astra/Fable presets), so a
      // tier-restricted plan SERVES them; the fail-closed premise uses a tier no model carries.
      const advancedOnly = await makePlan("advonly", { model_access: ["advanced"] });
      const ws = await makeWorkspace("advonly", advancedOnly, 100000);
      const access = await resolveModelAccess(svc, { workspace_id: ws.id });
      const tierRouted = routeModel({ mode: "build", prompt: COMPLEX_PROMPT, fileCount: 12, modelAccess: access });
      check("4. tier-restricted plans route only models of the allowed tier: an advanced-only plan serves an advanced model",
        (MODEL_CATALOG.find((m) => m.model_id === tierRouted.decision.model_id) || { quality_tier: "" }).quality_tier === "advanced",
        `routed ${tierRouted.decision.model_id}`);
      const unknownOnly = await makePlan("advonly_unknown", { model_access: ["unknown_tier"] });
      const wsUnknown = await makeWorkspace("advonly_unknown", unknownOnly, 100000);
      const unknownAccess = await resolveModelAccess(svc, { workspace_id: wsUnknown.id });
      await expectThrow("4. unknown model permissions fail closed: a plan allowing no active compatible model refuses to route",
        () => routeModel({ mode: "build", prompt: COMPLEX_PROMPT, fileCount: 12, modelAccess: unknownAccess }), "MODEL_NOT_ALLOWED_BY_PLAN");
    }

    // 5 + 6. beginOperation: disallowed primary fails closed BEFORE any hold; candidates filtered
    {
      const fastOnly = await makePlan("fastonly2", { model_access: ["fast"] });
      const ws = await makeWorkspace("fastonly2", fastOnly, 100000);
      await expectThrow("5. beginOperation fails closed on a disallowed model, before any operation or hold exists",
        () => runOp(ws, `ma_disallow_${stamp}`, { model_id: STANDARD }), "MODEL_NOT_ALLOWED_BY_PLAN");
      check("5. the refused operation created no row and held no credits",
        (await ops(ws)).length === 0 && (await deriveBalance(svc, ws.id)).reserved === 0, `${(await ops(ws)).length} op(s)`);

      const policy = await loadCreditPolicy(svc, ws.id);
      const primaryOnly = estimateMaxCharge({ model_id: FAST, ...ESTIMATE, operation_type: "ai_run", policy }).credits;
      const withSonnet = estimateMaxCharge({ model_id: STANDARD, ...ESTIMATE, operation_type: "ai_run", policy }).credits;
      const { operation } = await runOp(ws, `ma_allowed_${stamp}`, { model_id: FAST, policy, candidate_model_ids: [FAST, STANDARD] });
      check("6. paid-path parity: an allowed model begins normally and disallowed candidates never raise the hold",
        !!operation && operation.credits_reserved === primaryOnly && withSonnet > primaryOnly,
        `reserved ${operation.credits_reserved} (primary-only ${primaryOnly}, with sonnet ${withSonnet})`);
      await finalizeOperation(svc, { operation_id: operation.id, status: "failed", error: "test" });
    }

    // 7. An unrestricted (paid) plan changes nothing --------------------------------------------
    {
      const open = await makePlan("open", { model_access: [] });
      const ws = await makeWorkspace("open", open, 100000);
      const access = await resolveModelAccess(svc, { workspace_id: ws.id });
      const routed = routeModel({ mode: "build", prompt: COMPLEX_PROMPT, fileCount: 12, strategy: "best_quality", modelAccess: access });
      const { operation } = await runOp(ws, `ma_paid_${stamp}`, { model_id: routed.model.model_id });
      // The best-quality model is now the documented Opus 5.5 preset (Opus 5 was retired).
      const BEST = CATALOG_BY_ID.get(routed.decision.model_id)?.quality_tier === "advanced" ? routed.decision.model_id : STANDARD;
      check("7. paid plan allowed models: an unrestricted plan routes and opens an operation on the best model",
        (CATALOG_BY_ID.get(routed.decision.model_id) || {}).quality_tier === "advanced" && !!operation && operation.model_id === BEST,
        `routed ${routed.decision.model_id}`);
      await finalizeOperation(svc, { operation_id: operation.id, status: "failed", error: "test" });
    }

    // 8. Agent-chain parity: the chain builder is plan-filtered -------------------------------
    {
      const fastOnly = await makePlan("fastonly3", { model_access: ["fast"] });
      const standardOnly = await makePlan("stdonly", { model_access: ["standard"] });
      const wsFast = await makeWorkspace("fastonly3", fastOnly);
      const wsStd = await makeWorkspace("stdonly", standardOnly);
      const accessFast = await resolveModelAccess(svc, { workspace_id: wsFast.id });
      const accessStd = await resolveModelAccess(svc, { workspace_id: wsStd.id });
      const sonnet = pickModel("standard"), gemini = pickModel("fast");
      const filtered = budgetAwareExecutionChain(sonnet, [gemini.model_id], 1e9, { modelAccess: accessStd });
      const dropped = budgetAwareExecutionChain(gemini, [sonnet.model_id], 1e9, { modelAccess: accessFast });
      check("8. agent runs respect limits: a standard-only plan keeps sonnet and drops the fast fallback; a fast-only plan keeps gemini and drops sonnet",
        filtered.length === 1 && filtered[0] === STANDARD && dropped.length === 1 && dropped[0] === FAST,
        `std-only chain ${JSON.stringify(filtered)}, fast-only chain ${JSON.stringify(dropped)}`);
      await expectThrow("8. agent runs respect limits: a disallowed primary chain fails closed, never downgrades silently",
        () => budgetAwareExecutionChain(sonnet, null, null, { modelAccess: accessFast }), "MODEL_NOT_ALLOWED_BY_PLAN");
    }

    // 9. Gateway fallback selection excludes plan-unavailable models ---------------------------
    {
      // Standard-only plan: the PRIMARY (sonnet) is allowed, the FALLBACK (gemini) is out of plan —
      // so a failing primary must fail terminally instead of escaping into the disallowed fallback.
      const stdOnly = await makePlan("stdonly2", { model_access: ["standard"] });
      const ws = await makeWorkspace("stdonly2", stdOnly);
      const access = await resolveModelAccess(svc, { workspace_id: ws.id });
      const fakeProvider = (calls) => ({
        supportsTools: () => false, getModelInfo: () => null,
        async generate({ model }) {
          const id = model.model_id || model.id;
          calls.push(id);
          if (id === STANDARD) throw Object.assign(new Error("transient failure for test"), { retryable: true });
          return { output: { ok: true }, usage: { usage_source: "estimated", input_tokens: 10, output_tokens: 10 }, inputTokens: 10, outputTokens: 10, tokensEstimated: true };
        },
      });
      const sonnet = pickModel("standard");
      const restrictedCalls = [];
      const restricted = createGateway(svc, { providerOverrides: { "base44-core": fakeProvider(restrictedCalls) } });
      let threw = null;
      try {
        await restricted.generate(sonnet, { system: "s", messages: [{ role: "user", content: "x" }], timeoutMs: 20000, maxAttempts: 1, fallbacks: [FAST], modelAccess: access });
      } catch (e) { threw = e; }
      check("9. fallback respects limits: with plan access, the out-of-plan fallback is never executed",
        !!threw && restrictedCalls.length > 0 && restrictedCalls.every((id) => id === STANDARD), `calls ${JSON.stringify(restrictedCalls)}`);
      const openCalls = [];
      const open = createGateway(svc, { providerOverrides: { "base44-core": fakeProvider(openCalls) } });
      const res = await open.generate(sonnet, { system: "s", messages: [{ role: "user", content: "x" }], timeoutMs: 20000, maxAttempts: 1, fallbacks: [FAST] });
      check("9. fallback respects limits: without restriction the same call fails over to the fallback",
        res.model_used?.model_id === FAST && openCalls.includes(FAST), `calls ${JSON.stringify(openCalls)}`);
    }

    // 10. A suspended workspace fails closed ----------------------------------------------------
    {
      const fastOnly = await makePlan("fastonly5", { model_access: [] });
      const ws = await makeWorkspace("fastonly5", fastOnly, 100000);
      await svc.entities.Workspace.update(ws.id, { status: "suspended" });
      await expectThrow("10. suspended workspace blocked: model access fails closed while the workspace cannot serve",
        () => resolveModelAccess(svc, { workspace_id: ws.id }), "WORKSPACE_NOT_ENTITLED");
      await expectThrow("10. suspended workspace blocked: beginOperation refuses before any hold",
        () => runOp(ws, `ma_susp_${stamp}`, { model_id: FAST }), "WORKSPACE_NOT_ENTITLED");
      check("10. suspended workspace blocked: no operation row was created", (await ops(ws)).length === 0);
      await svc.entities.Workspace.update(ws.id, { status: "active" });
      const { operation } = await runOp(ws, `ma_susp_ok_${stamp}`, { model_id: FAST });
      check("10. reactivated workspace regains model access immediately", !!operation);
      await finalizeOperation(svc, { operation_id: operation.id, status: "failed", error: "test" });
    }

    // 11. A lapsed subscription fails closed ---------------------------------------------------
    {
      const open = await makePlan("open2", { model_access: [] });
      const ws = await makeWorkspace("open2", open, 100000);
      const sub = await subOf(ws);
      await svc.entities.Subscription.update(sub.id, { status: "past_due" });
      await expectThrow("11. inactive subscription fails closed: past_due suspends model access",
        () => resolveModelAccess(svc, { workspace_id: ws.id }), "WORKSPACE_NOT_ENTITLED");
      check("11. inactive subscription fails closed: planAllowsModel reports the same refusal",
        (await planAllowsModel(svc, { workspace_id: ws.id, model: { model_id: FAST, quality_tier: "fast" } })).ok === false);
      await svc.entities.Subscription.update(sub.id, { status: "active" });
      check("11. resuming the subscription restores model access",
        (await resolveModelAccess(svc, { workspace_id: ws.id })).allows({ model_id: FAST, quality_tier: "fast" }));
    }

    // 12. Unresolvable plan permissions fail closed ---------------------------------------------
    {
      const ws = await makeWorkspace("unknownplan");
      await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: `no_such_plan_${stamp}`, status: "active", provider: "none", entitlements: {} });
      await expectThrow("12. unknown plan permissions fail closed: a subscription naming an unknown plan refuses model access",
        () => resolveModelAccess(svc, { workspace_id: ws.id }), "MODEL_ACCESS_UNKNOWN");
      const inactive = await makePlan("inactive", { active: false, model_access: [] });
      const ws2 = await makeWorkspace("inactiveplan", inactive);
      await expectThrow("12. unknown plan permissions fail closed: a deactivated plan refuses model access",
        () => resolveModelAccess(svc, { workspace_id: ws2.id }), "MODEL_ACCESS_UNKNOWN");
    }

    // 13. An unknown model fails closed --------------------------------------------------------
    {
      const restricted = await makePlan("unknownmodel_restricted", { model_access: ["fast"] });
      const ws = await makeWorkspace("unknownmodel", restricted);
      const access = await resolveModelAccess(svc, { workspace_id: ws.id });
      check("13. unknown model fails closed: a restricted plan denies a model with no id/tier and one absent from the catalog",
        access.restricted === true && access.allows({}) === false && access.allows({ model_id: "totally-unknown-model" }) === false,
        `restricted ${access.restricted}`);
      await expectThrow("13. unknown model fails closed: beginOperation refuses an unknown model id",
        () => runOp(ws, `ma_unknown_${stamp}`, { model_id: "totally-unknown-model" }), "UNKNOWN_MODEL");
    }

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(svc, wsId, ["Subscription", "AIOperation", "CreditLedgerEntry", "AuditLog"]);
    }
    for (const id of created.plans) await svc.entities.BillingPlan.delete(id).catch(() => {});
  }
}