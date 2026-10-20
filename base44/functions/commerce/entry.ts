// Commercial control plane: credits, usage, budgets, plans and billing.
//
// SECURITY MODEL:
//   • the caller's workspace role is resolved SERVER-SIDE on every request; the client never
//     states its own role, balance, price or charge;
//   • real provider cost and margin require billing.admin — a normal member's responses carry
//     credits and tokens only;
//   • moving credits (grant, adjust, purchase, refund) or changing limits requires
//     billing.manage (owner), and every movement goes through the ledger's idempotency;
//   • balances are always DERIVED from the ledger, never read from a client value.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { audit } from "../../shared/authz.ts";
import { resolveRole, requireCapability, capabilitiesFor, requireActiveWorkspace } from "../../shared/rbac.ts";
import { deriveBalance, getStatement, recordEvent, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { usageSummary, recentOperations } from "../../shared/analytics.ts";
import { loadCreditPolicy, estimateMaxCharge } from "../../shared/economics.ts";
import { loadCatalog, syncCatalog, listModels } from "../../shared/modelCatalog.ts";
import { spendableCredits, refundOperation, reconcileAbandonedOperations } from "../../shared/aiOperations.ts";
import { resolveModelSelection, MODEL_SELECTION_MIN_TIER_RANK } from "../../shared/subscriptions.ts";
import { checkBudget } from "../../shared/budget.ts";
import { seedPlans, listPlans, processBillingEvent, entitlementsFor, grantPeriodCredits, getPlan } from "../../shared/billing.ts";
import { ensureCustomer, customerFor, invoicesFor } from "../../shared/billingAccounts.ts";
import { startSubscription, changePlan, cancelSubscription, resumeSubscription, applyScheduledChanges, billingOverview, subscriptionFor } from "../../shared/subscriptions.ts";
import { getProvider, defaultProvider, providerStatus, periodKeyFor } from "../../shared/paymentProviders.ts";
import { enforceLimit, identityFor } from "../../shared/apiLimits.ts";

// Actions that move credits or change entitlements. Rate-limited so a compromised or looping
// client cannot hammer the billing layer, while read surfaces stay responsive.
const BILLING_WRITES = ["ensure_customer", "checkout", "billing_portal", "subscribe", "change_plan", "cancel_subscription", "resume_subscription", "settle_manual_purchase", "set_budget", "adjust", "purchase", "grant_period", "refund_operation", "reconcile", "sync_catalog"];

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const preBody = await req.json().catch(() => ({}));

    // Public price list: the marketing pricing page is unauthenticated, so plan
    // metadata (name, price, included credits, limits) is served without a session.
    // Only publicly visible plans are exposed — no workspace or provider data.
    if (String(preBody.action || "") === "public_plans") {
      const pub = base44.asServiceRole;
      await seedPlans(pub);
      const plans = await listPlans(pub, { includeHidden: false });
      return Response.json({
        plans: plans
          .filter((p) => p.visibility === "public")
          .map((p) => ({
            code: p.code, name: p.name, description: p.description,
            price_cents: p.price_cents, currency: p.currency, interval: p.interval,
            included_credits: p.included_credits, included_integration_credits: p.included_integration_credits, trial_days: p.trial_days,
            credit_options: p.credit_options || null,
            tier_rank: p.tier_rank, visibility: p.visibility,
            limits: p.limits || {}, entitlements: p.entitlements || {},
          })),
      });
    }

    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = preBody;
    const action = String(body.action || "summary");
    const workspaceId = String(body.workspace_id || "");
    if (!workspaceId) return Response.json({ error: "workspace_id is required" }, { status: 400 });

    const workspace = await svc.entities.Workspace.get(workspaceId).catch(() => null);
    if (!workspace) return Response.json({ error: "Workspace not found" }, { status: 404 });
    const role = await resolveRole(base44, workspace, user);
    if (!role) return Response.json({ error: "Forbidden", code: "NOT_A_MEMBER" }, { status: 403 });

    // G-2 lifecycle: purchases, plan changes and credit movements are refused while the
    // workspace is suspended/terminated; reads (summary, usage, invoices) stay available.
    if (BILLING_WRITES.includes(action)) requireActiveWorkspace(workspace);

    if (BILLING_WRITES.includes(action)) {
      await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspaceId }), action: "billing_write", workspace_id: workspaceId });
    }

    const isAdmin = ["owner", "admin"].includes(role);
    const scope = isAdmin ? "admin" : "user";

    // --- read surfaces ------------------------------------------------------
    if (action === "summary") {
      requireCapability(role, "billing.read");
      const [balance, entitlements, policy] = await Promise.all([
        deriveBalance(svc, workspaceId),
        entitlementsFor(svc, workspaceId),
        loadCreditPolicy(svc, workspaceId),
      ]);
      const usage = await usageSummary(svc, { workspace_id: workspaceId, project_id: body.project_id || null, scope: "user", limit: 500 });
      const operations = await recentOperations(svc, { workspace_id: workspaceId, project_id: body.project_id || null, limit: num(body.limit, 15), scope });
      const spendable = await spendableCredits(svc, { workspace_id: workspaceId, user_id: user.id, project_id: body.project_id || null });
      return Response.json({
        role, capabilities: capabilitiesFor(role),
        balance, spendable, entitlements,
        // Only the credit unit is user-facing; the markup and provider rates are not.
        credits_per_usd: policy.credits_per_usd,
        usage: usage.totals, by_model: usage.by_model, by_day: usage.by_day, by_project: usage.by_project,
        operations,
      });
    }

    if (action === "models") {
      requireCapability(role, "billing.read");
      const catalog = await loadCatalog(svc);
      // DOCUMENTED (Base44): the Builder chat picker offers Auto mode + the current documented
      // model list. Retired models (Base44 model retirement: calls naming them keep working,
      // routed to a close current model) and preset-only models are NOT in the picker.
      const models = listModels({ includeInactive: false, catalog })
        .filter((m) => !m.retired && m.builder_picker !== false)
        .map((m) => ({
        model_id: m.model_id, display_name: m.display_name, quality_tier: m.quality_tier,
        provider: m.provider, capabilities: m.capabilities,
        context_window: m.context_window, max_output_tokens: m.max_output_tokens,
      }));
      // P-16C1 (documented): the Builder+ entitlement gate for manual model selection, exposed
      // so the UI can disable the selector for lower plans. Enforcement stays server-side at enqueue.
      const selection = await resolveModelSelection(svc, { workspace_id: workspaceId });
      return Response.json({
        models,
        model_selection: { min_tier_rank: MODEL_SELECTION_MIN_TIER_RANK, allowed: selection.ok, plan_code: selection.plan_code, tier_rank: selection.tier_rank },
      });
    }

    if (action === "statement") {
      requireCapability(role, "billing.read");
      return Response.json(await getStatement(svc, workspaceId, { limit: num(body.limit, 50) }));
    }

    if (action === "admin_summary") {
      // Provider economics and margin: admin only.
      requireCapability(role, "billing.admin");
      const usage = await usageSummary(svc, { workspace_id: workspaceId, project_id: body.project_id || null, user_id: body.user_id || null, since: body.since || null, until: body.until || null, scope: "admin", limit: 2000 });
      const integrity = await verifyBalanceIntegrity(svc, workspaceId);
      return Response.json({ role, ...usage, integrity });
    }

    if (action === "catalog") {
      requireCapability(role, "billing.read");
      const catalog = await loadCatalog(svc);
      return Response.json({
        models: listModels({ includeInactive: isAdmin, catalog }).map((m) => ({
          model_id: m.model_id, display_name: m.display_name, family: m.model_family, tier: m.quality_tier,
          capabilities: m.capabilities, context_window: m.context_window, max_output_tokens: m.max_output_tokens,
          availability: m.availability, active: m.active,
          // Raw provider rates are admin-only; a member sees what a call would cost in credits.
          // Retirement provenance is admin-visible: which presets were retired and what replaced them.
          ...(isAdmin ? { provider: m.provider, pricing: m.pricing, retired: !!m.retired, replaced_by: m.replaced_by || null } : {}),
        })),
      });
    }

    if (action === "estimate") {
      requireCapability(role, "billing.read");
      const catalog = await loadCatalog(svc);
      const policy = await loadCreditPolicy(svc, workspaceId);
      const estimate = estimateMaxCharge({
        model_id: String(body.model_id || "gemini-3-flash"),
        max_input_tokens: num(body.max_input_tokens, 20000),
        max_output_tokens: num(body.max_output_tokens, 4000),
        operation_type: String(body.operation_type || "ai_run"),
        policy, catalog,
      });
      const budget = await checkBudget(svc, { workspace_id: workspaceId, user_id: user.id, project_id: body.project_id || null, credits: estimate.credits });
      return Response.json({
        // The user-facing estimate is credits; provider cost is withheld unless admin.
        estimated_credits: estimate.credits, affordable: budget.ok, violations: budget.violations,
        available: budget.available, ...(isAdmin ? { provider_cost: estimate.provider_cost, pricing_version: estimate.pricing_version } : {}),
      });
    }

    if (action === "plans") {
      requireCapability(role, "billing.read");
      await seedPlans(svc);
      const plans = await listPlans(svc, { includeHidden: isAdmin });
      return Response.json({ plans: plans.map((p) => ({ code: p.code, name: p.name, description: p.description, price_cents: p.price_cents, currency: p.currency, interval: p.interval, included_credits: p.included_credits, included_integration_credits: p.included_integration_credits, credit_options: p.credit_options || null, trial_days: p.trial_days, tier_rank: p.tier_rank, visibility: p.visibility, limits: p.limits || {}, usage_limits: p.usage_limits || {}, model_access: p.model_access || [], overage_policy: p.overage_policy, entitlements: p.entitlements })) });
    }

    // --- billing account -----------------------------------------------------
    if (action === "billing_overview") {
      requireCapability(role, "billing.read");
      // Reading the page is also when a due period change is applied, so an expired plan is
      // never shown (or honoured) as active.
      await applyScheduledChanges(svc, { workspace_id: workspaceId }).catch(() => {});
      const [overview, balance, customer, invoices, entitlements] = await Promise.all([
        billingOverview(svc, workspaceId),
        deriveBalance(svc, workspaceId),
        customerFor(svc, workspaceId),
        invoicesFor(svc, workspaceId, 20),
        entitlementsFor(svc, workspaceId),
      ]);
      const events = await svc.entities.BillingEvent.filter({ workspace_id: workspaceId }, "-created_date", 20);
      return Response.json({
        role, capabilities: capabilitiesFor(role), ...overview, balance, entitlements,
        // Provider identity is intentionally not returned to non-admins, and no provider secret
        // is ever included for anyone.
        customer: customer ? { billing_state: customer.billing_state, payment_status: customer.payment_status, card_brand: customer.card_brand || null, card_last4: customer.card_last4 || null, last_payment_at: customer.last_payment_at || null, last_failure_reason: customer.last_failure_reason || null, provider: customer.provider, ...(isAdmin ? { provider_customer_id: customer.provider_customer_id || null } : {}) } : null,
        invoices: invoices.map((i) => ({ id: i.id, number: i.number, status: i.status, amount_cents: i.amount_cents, amount_refunded_cents: i.amount_refunded_cents || 0, currency: i.currency, plan_code: i.plan_code, period_key: i.period_key, credits_granted: i.credits_granted, hosted_invoice_url: i.hosted_invoice_url || null, issued_at: i.issued_at, paid_at: i.paid_at })),
        events: events.map((e) => ({ id: e.id, event_type: e.event_type, status: e.status, credits: e.credits, amount_cents: e.amount_cents, plan_code: e.plan_code, period_key: e.period_key, reject_reason: e.reject_reason || null, created_date: e.created_date })),
        providers: isAdmin ? providerStatus() : undefined,
        payment_provider: defaultProvider(),
      });
    }

    if (action === "ensure_customer") {
      requireCapability(role, "billing.manage");
      const providerName = String(body.provider || defaultProvider());
      const provider = getProvider(providerName);
      const customer = await ensureCustomer(svc, {
        workspace_id: workspaceId, provider: providerName, email: user.email, name: workspace.name, user_id: user.id,
        // The remote customer is only created when the provider is actually configured.
        createRemote: provider.configured() ? () => provider.createCustomer({ workspace_id: workspaceId, email: user.email, name: workspace.name }) : null,
      });
      return Response.json({ customer: { id: customer.id, provider: customer.provider, billing_state: customer.billing_state, payment_status: customer.payment_status } });
    }

    if (action === "checkout") {
      requireCapability(role, "billing.manage");
      const plan = await getPlan(svc, String(body.plan_code || ""));
      if (!plan) return Response.json({ error: `Unknown plan "${body.plan_code}"` }, { status: 400 });
      const providerName = String(body.provider || defaultProvider());
      const provider = getProvider(providerName);
      if (!provider.configured()) return Response.json({ error: `Payment provider "${providerName}" is not configured for this app`, code: "PROVIDER_NOT_CONFIGURED" }, { status: 501 });
      const customer = await ensureCustomer(svc, { workspace_id: workspaceId, provider: providerName, email: user.email, name: workspace.name, user_id: user.id, createRemote: () => provider.createCustomer({ workspace_id: workspaceId, email: user.email, name: workspace.name }) });
      const session = await provider.createCheckout({ plan, workspace_id: workspaceId, user_id: user.id, customer, success_url: String(body.success_url || ""), cancel_url: String(body.cancel_url || "") });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.checkout.started", resource: "BillingPlan", resource_id: plan.id, metadata: { plan: plan.code, provider: providerName } });
      // Only the hosted URL crosses back to the client — never a provider key.
      return Response.json({ checkout: { url: session.url || null, mode: session.mode || null, requires_manual_settlement: !!session.requires_manual_settlement } });
    }

    if (action === "billing_portal") {
      requireCapability(role, "billing.manage");
      const providerName = String(body.provider || defaultProvider());
      const provider = getProvider(providerName);
      const customer = await customerFor(svc, workspaceId, providerName);
      const session = await provider.createPortalSession({ customer, return_url: String(body.return_url || "") });
      return Response.json({ portal: { url: session.url } });
    }

    // --- subscription lifecycle ---------------------------------------------
    if (action === "subscribe") {
      requireCapability(role, "billing.manage");
      const res = await startSubscription(svc, { workspace_id: workspaceId, plan_code: String(body.plan_code || ""), provider: String(body.provider || "manual"), user_id: user.id, trial: body.trial === undefined ? null : !!body.trial, ...(body.credit_option_code ? { credit_option_code: String(body.credit_option_code) } : {}) });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.subscription.started", resource: "Subscription", resource_id: res.subscription?.id || null, metadata: { plan: body.plan_code, trial: res.trial, credits: res.credits_applied } });
      return Response.json(res);
    }

    if (action === "change_plan") {
      requireCapability(role, "billing.manage");
      const res = await changePlan(svc, { workspace_id: workspaceId, plan_code: String(body.plan_code || ""), user_id: user.id, ...(body.credit_option_code ? { credit_option_code: String(body.credit_option_code) } : {}) });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: `billing.subscription.${res.direction}`, resource: "Subscription", resource_id: res.subscription?.id || null, metadata: { plan: body.plan_code, direction: res.direction, scheduled_for: res.scheduled_for || null } });
      return Response.json(res);
    }

    if (action === "cancel_subscription") {
      requireCapability(role, "billing.manage");
      const res = await cancelSubscription(svc, { workspace_id: workspaceId, user_id: user.id, immediate: !!body.immediate, reason: body.reason || null });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.subscription.cancelled", resource: "Subscription", resource_id: res.subscription?.id || null, metadata: { immediate: !!body.immediate } });
      return Response.json(res);
    }

    if (action === "resume_subscription") {
      requireCapability(role, "billing.manage");
      const res = await resumeSubscription(svc, { workspace_id: workspaceId, user_id: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.subscription.resumed", resource: "Subscription", resource_id: res.subscription?.id || null, metadata: {} });
      return Response.json(res);
    }

    if (action === "settle_manual_purchase") {
      // Manual settlement: an owner records an out-of-band payment. It is a validated billing
      // event like any other, so it is idempotent and fully audited — never a direct balance write.
      requireCapability(role, "billing.manage");
      const plan = body.plan_code ? await getPlan(svc, String(body.plan_code)) : null;
      if (body.plan_code && !plan) return Response.json({ error: `Unknown plan "${body.plan_code}"` }, { status: 400 });
      const period_key = body.period_key || periodKeyFor(plan?.interval || "one_time");
      const res = await processBillingEvent(svc, {
        workspace_id: workspaceId, user_id: user.id, provider: "manual",
        event_type: plan && plan.interval !== "one_time" ? "subscription_started" : "credit_purchase",
        amount_cents: num(body.amount_cents, plan?.price_cents || 0), credits: num(body.credits, 0),
        plan_code: plan?.code || null, period_key,
        invoice: { provider_invoice_id: `manual_${workspaceId}_${period_key}_${num(body.amount_cents, plan?.price_cents || 0)}`, number: body.reference ? String(body.reference).slice(0, 60) : null, status: "paid" },
        idempotency_key: String(body.idempotency_key || `manual:${workspaceId}:${plan?.code || "credits"}:${period_key}`),
      });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.manual_settlement", resource: "BillingEvent", resource_id: res.event.id, metadata: { credits: res.credits_applied, duplicate: res.duplicate } });
      return Response.json({ event: res.event, duplicate: res.duplicate, credits_applied: res.credits_applied, balance: await deriveBalance(svc, workspaceId) });
    }

    if (action === "invoices") {
      requireCapability(role, "billing.read");
      const invoices = await invoicesFor(svc, workspaceId, num(body.limit, 50));
      return Response.json({ invoices });
    }

    if (action === "budgets") {
      requireCapability(role, "billing.read");
      const budgets = await svc.entities.Budget.filter({ workspace_id: workspaceId }, "-updated_date", 100);
      return Response.json({ budgets });
    }

    // --- write surfaces (owner only) ---------------------------------------
    if (action === "set_budget") {
      requireCapability(role, "billing.manage");
      const scopeName = String(body.scope || "");
      if (!["workspace", "user", "project", "run", "operation"].includes(scopeName)) return Response.json({ error: "Invalid budget scope" }, { status: 400 });
      const limit = num(body.limit_credits, -1);
      if (limit < 0) return Response.json({ error: "limit_credits must be >= 0" }, { status: 400 });
      const existing = (await svc.entities.Budget.filter({ workspace_id: workspaceId, scope: scopeName, scope_id: body.scope_id || null }, "-updated_date", 1))[0];
      const saved = existing
        ? await svc.entities.Budget.update(existing.id, { limit_credits: limit, period: body.period || "total", active: body.active !== false })
        : await svc.entities.Budget.create({ workspace_id: workspaceId, scope: scopeName, scope_id: body.scope_id || null, limit_credits: limit, period: body.period || "total", active: true, created_by: user.id });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.budget.set", resource: "Budget", resource_id: saved.id, metadata: { scope: scopeName, limit } });
      return Response.json({ budget: saved });
    }

    if (action === "adjust") {
      requireCapability(role, "billing.manage");
      const amount = num(body.amount, 0);
      if (!amount) return Response.json({ error: "amount is required" }, { status: 400 });
      // Optional pool; omitted means message, as for every adjustment recorded before the split.
      const credit_type = body.credit_type == null || body.credit_type === "" ? "message" : String(body.credit_type);
      if (!["message", "integration"].includes(credit_type)) return Response.json({ error: "credit_type must be message or integration" }, { status: 400 });
      // An explicit key is REQUIRED: a defaulted timestamp key would let a retried request
      // double-apply the movement, defeating the ledger's replay protection.
      if (!body.idempotency_key) return Response.json({ error: "idempotency_key is required" }, { status: 400 });
      const res = await recordEvent(svc, {
        workspace_id: workspaceId, user_id: user.id, event_type: "admin_adjustment", amount, credit_type,
        // The caller supplies the key, so a retried adjustment cannot double-apply.
        idempotency_key: String(body.idempotency_key),
        reason: String(body.reason || "Administrative adjustment"),
      }, { allowNegative: amount < 0 });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.adjustment", resource: "CreditLedgerEntry", resource_id: res.entry.id, metadata: { amount, credit_type, duplicate: res.duplicate } });
      return Response.json({ entry: res.entry, duplicate: res.duplicate, balance: res.balance, available: res.available });
    }

    if (action === "purchase") {
      requireCapability(role, "billing.manage");
      // Provider-agnostic purchase path: a validated billing event is what credits the ledger,
      // never a payment provider's own state.
      // An explicit key is REQUIRED: a defaulted timestamp key would let a retried purchase
      // double-credit the account, defeating the ledger's replay protection.
      if (!body.idempotency_key) return Response.json({ error: "idempotency_key is required" }, { status: 400 });
      const res = await processBillingEvent(svc, {
        workspace_id: workspaceId, user_id: user.id, provider: String(body.provider || "none"),
        event_type: body.plan_code && body.plan_code !== "credits_topup" ? "subscription_started" : "credit_purchase",
        amount_cents: num(body.amount_cents, 0), credits: num(body.credits, 0),
        plan_code: body.plan_code || null, period_key: body.period_key || null,
        idempotency_key: String(body.idempotency_key),
      });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.purchase", resource: "BillingEvent", resource_id: res.event.id, metadata: { credits: res.credits_applied, duplicate: res.duplicate, status: res.event.status } });
      return Response.json({ event: res.event, duplicate: res.duplicate, credits_applied: res.credits_applied, balance: await deriveBalance(svc, workspaceId) });
    }

    if (action === "grant_period") {
      requireCapability(role, "billing.manage");
      const res = await grantPeriodCredits(svc, { workspace_id: workspaceId, plan_code: String(body.plan_code || ""), period_key: String(body.period_key || ""), user_id: user.id });
      return Response.json({ event: res.event, duplicate: res.duplicate, credits_applied: res.credits_applied });
    }

    if (action === "refund_operation") {
      requireCapability(role, "billing.manage");
      const op = await svc.entities.AIOperation.get(String(body.operation_id || "")).catch(() => null);
      // Cross-workspace refunds are impossible: the operation must belong to this workspace.
      if (!op || op.workspace_id !== workspaceId) return Response.json({ error: "Operation not found in this workspace" }, { status: 404 });
      const res = await refundOperation(svc, { operation_id: op.id, reason: String(body.reason || "Refunded by workspace owner") });
      await audit(svc, { workspace_id: workspaceId, user_id: user.id, action: "billing.refund", resource: "AIOperation", resource_id: op.id, metadata: { refunded: res.refunded } });
      return Response.json({ refunded: res.refunded, duplicate: res.duplicate, balance: await deriveBalance(svc, workspaceId) });
    }

    if (action === "reconcile") {
      requireCapability(role, "billing.manage");
      const settled = await reconcileAbandonedOperations(svc, { workspace_id: workspaceId, older_than_ms: num(body.older_than_ms, 15 * 60 * 1000) });
      return Response.json({ settled, integrity: await verifyBalanceIntegrity(svc, workspaceId) });
    }

    if (action === "sync_catalog") {
      requireCapability(role, "billing.admin");
      return Response.json(await syncCatalog(svc));
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null, detail: error.detail || null }, { status: error.status || 500 });
  }
}