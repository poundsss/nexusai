// Product UI verification — the data surfaces the Billing, Settings and Analytics pages render.
//
// These are the REAL read paths the account-level UI depends on: plan listing, entitlement
// resolution, billing overview, usage analytics, cost estimation and budget enforcement. The
// test exercises them against live storage with a scratch workspace, then deletes every record.
// It also confirms the role separation the UI relies on: a viewer sees credits and tokens, never
// provider cost; only an admin's response carries provider economics.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { seedPlans, listPlans, getPlan, entitlementsFor, processBillingEvent } from "../../shared/billing.ts";
import { billingOverview, startSubscription } from "../../shared/subscriptions.ts";
import { usageSummary, recentOperations } from "../../shared/analytics.ts";
import { deriveBalance, recordEvent } from "../../shared/ledger.ts";
import { estimateMaxCharge, loadCreditPolicy } from "../../shared/economics.ts";
import { loadCatalog, listModels } from "../../shared/modelCatalog.ts";
import { checkBudget } from "../../shared/budget.ts";
import { can, CAPABILITIES } from "../../shared/rbac.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;

  let ws = null;
  const cleanup = [];

  try {
    const me = await base44.auth.me().catch(() => null);
    ws = await svc.entities.Workspace.create({ name: "UI Test Workspace", owner_id: me?.id || "test", credits_balance: 0 });
    const wid = ws.id;

    // ----------------------------------------------------------- plan listing
    await seedPlans(svc);
    const plans = await listPlans(svc);
    check("public plans are returned sorted by tier_rank", plans.length > 0 && plans.every((p, i) => i === 0 || (plans[i - 1].tier_rank || 0) <= (p.tier_rank || 0)), `${plans.length} plans`);
    check("hidden plans are excluded from the public list", !plans.some((p) => p.visibility === "hidden"), "no hidden");
    check("every public plan carries the fields the UI card renders", plans.every((p) => p.code && p.name && typeof p.price_cents === "number" && p.interval && typeof p.included_credits === "number" && p.limits && p.usage_limits), "shape ok");
    check("enterprise/custom plans are not self-serve", !plans.some((p) => p.visibility === "enterprise" || p.visibility === "custom"), "no enterprise/custom in public list");
    // An admin caller sees the full catalog including enterprise and custom contracts.
    const adminPlans = await listPlans(svc, { includeHidden: true });
    check("admin list includes enterprise plans hidden from the public list", adminPlans.length > plans.length && adminPlans.some((p) => p.visibility === "enterprise"), `${adminPlans.length} admin vs ${plans.length} public`);

    const free = await getPlan(svc, "free");
    check("free plan resolves", !!free && free.code === "free", free?.code);

    // ------------------------------------------------------ entitlement default
    const def = await entitlementsFor(svc, wid);
    check("a new workspace gets the free default entitlement", def.plan_code === "free" && def.status === "active", `${def.plan_code}/${def.status}`);
    check("default entitlements carry the free plan's feature flags", def.entitlements && typeof def.entitlements.projects === "number", JSON.stringify(def.entitlements));

    // --------------------------------------------------------- billing overview
    const overview = await billingOverview(svc, wid);
    check("overview has no subscription for a new workspace", overview.subscription === null, "null sub");
    check("overview resolves the free plan", overview.plan?.code === "free", overview.plan?.code);

    // ----------------------------------------------- credit purchase + balance
    const purchase = await processBillingEvent(svc, {
      workspace_id: wid, provider: "manual", event_type: "credit_purchase",
      amount_cents: 1000, credits: 1000, plan_code: "credits_topup",
      idempotency_key: `uitest:purchase:${wid}`,
    });
    check("a credit purchase credits the ledger once", purchase.credits_applied === 1000 && !purchase.duplicate, `applied=${purchase.credits_applied}`);
    const balance = await deriveBalance(svc, wid);
    check("balance reflects the purchase", balance.balance === 1000 && balance.available === 1000, `balance=${balance.balance}`);

    // A replayed purchase is a no-op.
    const replay = await processBillingEvent(svc, {
      workspace_id: wid, provider: "manual", event_type: "credit_purchase",
      amount_cents: 1000, credits: 1000, plan_code: "credits_topup",
      idempotency_key: `uitest:purchase:${wid}`,
    });
    check("a replayed purchase is detected as a duplicate", replay.duplicate, `dup=${replay.duplicate}`);
    const balance2 = await deriveBalance(svc, wid);
    check("balance is unchanged after replay (no double-credit)", balance2.balance === 1000, `balance=${balance2.balance}`);

    // --------------------------------------------------- subscription + upgrade
    const sub = await startSubscription(svc, { workspace_id: wid, plan_code: "pro_monthly", provider: "manual", user_id: me?.id || "test", trial: true });
    check("starting a trial subscription grants trial credits once", sub.credits_applied > 0 && sub.trial === true, `credits=${sub.credits_applied}`);
    const ent = await entitlementsFor(svc, wid);
    check("entitlements reflect the pro plan after subscribe", ent.plan_code === "pro_monthly" && ent.status === "trialing", `${ent.plan_code}/${ent.status}`);
    const overview2 = await billingOverview(svc, wid);
    check("overview now carries the subscription", overview2.subscription?.plan_code === "pro_monthly" && overview2.subscription?.status === "trialing", `${overview2.subscription?.plan_code}/${overview2.subscription?.status}`);

    // --------------------------------------------------------- usage analytics
    // Record a completed AI operation so the analytics surfaces have real data.
    const catalog = await loadCatalog(svc);
    const policy = await loadCreditPolicy(svc, wid);
    const est = estimateMaxCharge({ model_id: "gemini-3-flash", max_input_tokens: 10000, max_output_tokens: 2000, operation_type: "ai_run", policy, catalog });
    check("estimate returns a credit charge and a pricing version", est.credits > 0 && !!est.pricing_version, `credits=${est.credits} v=${est.pricing_version}`);

    const op = await svc.entities.AIOperation.create({
      workspace_id: wid, operation_type: "ai_run", provider: "google", gateway_provider: "base44-core",
      model_id: "gemini-3-flash", status: "completed", input_tokens: 10000, output_tokens: 2000, total_tokens: 12000,
      usage_source: "provider", pricing_version: est.pricing_version, provider_cost: est.provider_cost, currency: "USD",
      credit_policy_version: policy.policy_version, credits_charged: est.credits, idempotency_key: `uitest:op:${wid}`,
      finalized_at: new Date().toISOString(), started_at: new Date().toISOString(),
    });
    cleanup.push("AIOperation");
    // Charge it through the ledger so the balance is consistent.
    await recordEvent(svc, { workspace_id: wid, operation_id: op.id, event_type: "ai_charge", amount: -est.credits, idempotency_key: `uitest:charge:${op.id}`, reason: "ai_run" }, { allowNegative: true });

    const usage = await usageSummary(svc, { workspace_id: wid, scope: "user", limit: 500 });
    check("user-scoped usage has totals", usage.totals && typeof usage.totals.credits === "number" && typeof usage.totals.operations === "number", `ops=${usage.totals?.operations} credits=${usage.totals?.credits}`);
    check("user-scoped usage breaks down by model", usage.by_model?.length >= 1 && usage.by_model[0].key === "gemini-3-flash", `${usage.by_model?.length} models`);
    check("user-scoped usage never exposes provider cost", !usage.by_model?.some((m) => "provider_cost" in m) && !("provider_cost" in (usage.totals || {})), "no provider cost");
    const adminUsage = await usageSummary(svc, { workspace_id: wid, scope: "admin", limit: 500 });
    check("admin-scoped usage exposes provider cost", adminUsage.by_model?.some((m) => "provider_cost" in m) || "provider_cost" in (adminUsage.totals || {}), "has provider cost");

    const recent = await recentOperations(svc, { workspace_id: wid, limit: 10, scope: "user" });
    check("recent operations returns the completed op", recent.length >= 1 && recent[0].model_id === "gemini-3-flash", `${recent.length} ops`);

    // --------------------------------------------------------- budget control
    // checkBudget refuses when the requested credits exceed the available balance.
    const hugeBudget = await checkBudget(svc, { workspace_id: wid, credits: 999_999_999 });
    check("a charge exceeding available credits is refused", !hugeBudget.ok && hugeBudget.violations?.some((v) => v.code === "INSUFFICIENT_CREDITS"), `ok=${hugeBudget.ok}`);
    const okBudget = await checkBudget(svc, { workspace_id: wid, credits: 1 });
    check("a tiny charge within budget is allowed", okBudget.ok, `ok=${okBudget.ok}`);
    // A configured workspace budget is also enforced independently of the balance.
    await svc.entities.Budget.create({ workspace_id: wid, scope: "workspace", limit_credits: 10, period: "total", active: true, created_by: me?.id || "test" });
    cleanup.push("Budget");
    const capped = await checkBudget(svc, { workspace_id: wid, credits: 100 });
    check("a charge exceeding a configured workspace budget is refused", !capped.ok && capped.violations?.some((v) => v.code === "WORKSPACE_BUDGET_EXCEEDED"), `ok=${capped.ok}`);

    // ------------------------------------------------------- role separation
    // The UI hides provider economics from non-admins. The RBAC matrix is what the commerce
    // function consults to decide which scope to return.
    check("viewer can read billing but not admin it", can("viewer", "billing.read") && !can("viewer", "billing.admin"), "viewer");
    check("admin can read and admin billing but not manage it", can("admin", "billing.read") && can("admin", "billing.admin") && !can("admin", "billing.manage"), "admin");
    check("owner can manage billing", can("owner", "billing.manage"), "owner");
    check("an unknown capability is denied to everyone", !can("owner", "billing.unknown"), "unknown denied");

    // ---------------------------------------------- catalog surface for the UI
    const uiModels = listModels({ includeInactive: false, catalog });
    check("catalog list carries UI-renderable fields", uiModels.every((m) => m.model_id && m.display_name && m.quality_tier && m.capabilities), `${uiModels.length} models`);
    check("inactive models are hidden from the non-admin list", !uiModels.some((m) => !m.active), "all active");

    await cleanupWorkspace(svc, wid, ["AIOperation", "CreditLedgerEntry", "BillingEvent", "Subscription", "Invoice", "Budget", "BillingCustomer"]);
    return harnessResponse(harness);
  } catch (error) {
    if (ws) await cleanupWorkspace(svc, ws.id, ["AIOperation", "CreditLedgerEntry", "BillingEvent", "Subscription", "Invoice", "Budget", "BillingCustomer"]).catch(() => {});
    return harnessError(harness, error);
  }
}