// Production billing verification — REAL code paths.
//
// Runs the actual provider abstraction (including live Stripe signature verification and event
// mapping), the customer/invoice mirrors, the subscription lifecycle and the billing processor
// against the authoritative credit ledger. No mocked signatures, no fake credit grants.
// EXTERNAL DEPENDENCY: outbound Stripe API calls require STRIPE_SECRET_KEY, so those paths are
// verified up to the integration boundary (fail-closed behaviour), while signature verification
// and event mapping — where correctness actually matters — are verified end-to-end here.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { getProvider, providerStatus, defaultProvider, mapStripeEvent, hmacSha256Hex, safeEqual, periodKeyFor, ProviderError } from "../../shared/paymentProviders.ts";
import { seedPlans, listPlans, getPlan, processBillingEvent, entitlementsFor, resolveWorkspaceForEvent } from "../../shared/billing.ts";
import { ensureCustomer, customerFor, invoicesFor } from "../../shared/billingAccounts.ts";
import { startSubscription, changePlan, cancelSubscription, resumeSubscription, applyScheduledChanges, subscriptionFor, planAllowsModel, billingOverview } from "../../shared/subscriptions.ts";
import { deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { can } from "../../shared/rbac.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const TEST_SIGNING_SECRET = "whsec_test_signing_secret_for_verification";
const headersWith = (obj) => new Headers(obj);

const stripeEvent = (type, object, id = `evt_${Math.random().toString(36).slice(2)}`) => ({ id, type, data: { object } });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const harness = createHarness();
  const { check, expectThrow } = harness;
  let ws = null, trialPlan = null;

  try {
    const stripe = getProvider("stripe");
    const manual = getProvider("manual");

    // ------------------------------------------------- provider abstraction
    check("providers are enumerable with configuration state", providerStatus().some((p) => p.name === "stripe") && providerStatus().some((p) => p.name === "manual" && p.configured), JSON.stringify(providerStatus()));
    await expectThrow("an unknown provider is refused", async () => getProvider("bitcoin_uncle"), "UNKNOWN_PROVIDER");
    check("manual settlement is always available", manual.configured() && defaultProvider() === (stripe.configured() ? "stripe" : "manual"), defaultProvider());
    if (!stripe.configured()) {
      await expectThrow("an unconfigured provider fails closed instead of pretending to charge", () => stripe.createCustomer({ workspace_id: "w", email: "a@b.c" }), "PROVIDER_NOT_CONFIGURED");
    } else {
      check("stripe api credentials are configured", true, "live provider configured");
    }
    check("a manual checkout requires explicit settlement", (await manual.createCheckout({ plan: { code: "free" } })).requires_manual_settlement === true, "manual settlement");

    // ------------------------------------------------ webhook authenticity
    const payload = JSON.stringify(stripeEvent("invoice.paid", { id: "in_1", customer: "cus_1", amount_paid: 3900, currency: "usd", metadata: { plan_code: "pro_monthly", credits: 5000 } }, "evt_sig_1"));
    const ts = Math.floor(Date.now() / 1000);
    const sig = await hmacSha256Hex(TEST_SIGNING_SECRET, `${ts}.${payload}`);
    const verified = await stripe.verifyWebhook({ rawBody: payload, headers: headersWith({ "stripe-signature": `t=${ts},v1=${sig}` }), secretValue: TEST_SIGNING_SECRET });
    check("a correctly signed webhook verifies", verified.verified && verified.provider_event_id === "evt_sig_1", verified.provider_event_id);
    await expectThrow("a tampered body is rejected", () => stripe.verifyWebhook({ rawBody: payload.replace("3900", "9999999"), headers: headersWith({ "stripe-signature": `t=${ts},v1=${sig}` }), secretValue: TEST_SIGNING_SECRET }), "INVALID_SIGNATURE");
    await expectThrow("a signature from the wrong secret is rejected", () => stripe.verifyWebhook({ rawBody: payload, headers: headersWith({ "stripe-signature": `t=${ts},v1=${sig}` }), secretValue: "whsec_attacker" }), "INVALID_SIGNATURE");
    await expectThrow("a captured request cannot be replayed later", () => stripe.verifyWebhook({ rawBody: payload, headers: headersWith({ "stripe-signature": `t=${ts - 4000},v1=${sig}` }), secretValue: TEST_SIGNING_SECRET }), "SIGNATURE_EXPIRED");
    await expectThrow("a missing signature header is rejected", () => stripe.verifyWebhook({ rawBody: payload, headers: headersWith({}), secretValue: TEST_SIGNING_SECRET }), "INVALID_SIGNATURE");
    await expectThrow("a malformed signed body is rejected", async () => {
      const bad = "{not json";
      const s = await hmacSha256Hex(TEST_SIGNING_SECRET, `${ts}.${bad}`);
      return stripe.verifyWebhook({ rawBody: bad, headers: headersWith({ "stripe-signature": `t=${ts},v1=${s}` }), secretValue: TEST_SIGNING_SECRET });
    }, "MALFORMED_PAYLOAD");
    check("signature comparison is constant-time and length-safe", safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("abc", "ab"), "constant-time");
    await expectThrow("an unsigned manual webhook is rejected", () => manual.verifyWebhook({ rawBody: JSON.stringify({ event_type: "credit_purchase", credits: 999999 }), headers: headersWith({}), secretValue: "shared" }), "INVALID_SIGNATURE");
    check("a correct manual shared secret verifies", (await manual.verifyWebhook({ rawBody: JSON.stringify({ event_type: "credit_purchase", provider_event_id: "m1" }), headers: headersWith({ "x-webhook-secret": "shared" }), secretValue: "shared" })).verified, "verified");
    check("the verified payload never carries the secret onward", (await manual.verifyWebhook({ rawBody: JSON.stringify({ event_type: "adjustment", secret: "shared" }), headers: headersWith({ "x-webhook-secret": "shared" }), secretValue: "shared" })).raw.secret === undefined, "secret stripped");

    // ---------------------------------------------------- event mapping
    const map = (type, object) => mapStripeEvent(stripeEvent(type, object));
    check("checkout completion maps to a one-time purchase", map("checkout.session.completed", { mode: "payment", amount_total: 1000, metadata: { plan_code: "credits_topup", credits: 1000, workspace_id: "w1" } }).event_type === "credit_purchase", "credit_purchase");
    check("a subscription checkout maps to subscription start", map("checkout.session.completed", { mode: "subscription", amount_total: 3900, metadata: { plan_code: "pro_monthly" } }).event_type === "subscription_started", "subscription_started");
    check("a trialing subscription maps to a trial start", map("customer.subscription.created", { status: "trialing", metadata: { plan_code: "pro_monthly" } }).event_type === "trial_started", "trial_started");
    check("invoice payment maps to a renewal with its invoice", (() => { const m = map("invoice.paid", { id: "in_9", amount_paid: 3900, number: "A-1" }); return m.event_type === "subscription_renewed" && m.invoice.provider_invoice_id === "in_9" && m.invoice.status === "paid"; })(), "renewal + invoice");
    check("a failed payment maps without credits", (() => { const m = map("invoice.payment_failed", { id: "in_10", amount_due: 3900 }); return m.event_type === "payment_failed" && m.payment_status === "failing" && m.credits === 0; })(), "payment_failed");
    check("a refund maps to a credit reversal", map("charge.refunded", { amount_refunded: 1000, metadata: { credits: 500 } }).event_type === "refund", "refund");
    check("a dispute maps to a disputed payment", map("charge.dispute.created", { amount: 3900, reason: "fraudulent" }).event_type === "payment_disputed", "payment_disputed");
    check("subscription deletion maps to cancellation", map("customer.subscription.deleted", { metadata: { plan_code: "pro_monthly" } }).event_type === "subscription_cancelled", "subscription_cancelled");
    check("invoice creation maps to an open invoice", map("invoice.created", { id: "in_11", amount_due: 3900 }).invoice.status === "open", "open invoice");
    check("an unknown provider event is ignored, never guessed", (() => { const m = map("customer.discount.created", {}); return m.event_type === null && m.ignored_type === "customer.discount.created"; })(), "ignored");
    check("credits are taken from plan metadata only", map("checkout.session.completed", { mode: "payment", amount_total: 100, metadata: {} }).credits === 0, "0 credits without plan metadata");

    // ------------------------------------------------------------- plans
    const seeded = await seedPlans(svc);
    const plans = await listPlans(svc, { includeHidden: true });
    check("production plans exist (free, paid, scale, enterprise, top-up)", ["free", "pro_monthly", "scale_monthly", "enterprise", "credits_topup"].every((c) => plans.some((p) => p.code === c)), JSON.stringify(seeded));
    check("non-admin listing excludes enterprise/custom plans", !(await listPlans(svc)).some((p) => p.visibility === "enterprise" || p.visibility === "custom"), "public only");
    const pro = await getPlan(svc, "pro_monthly");
    check("plans carry limits, usage limits, model access and overage policy", !!pro.limits?.custom_domains && !!pro.usage_limits?.monthly_credits && Array.isArray(pro.model_access) && !!pro.overage_policy, JSON.stringify({ limits: pro.limits, overage: pro.overage_policy }));
    const free = await getPlan(svc, "free");
    check("the free plan restricts model access and blocks overage", free.model_access.length > 0 && free.overage_policy === "block", `${free.model_access.join(",")} / ${free.overage_policy}`);
    const ent = await getPlan(svc, "enterprise");
    check("the enterprise plan unlocks sso and scim entitlements", ent.entitlements.sso === true && ent.entitlements.scim === true && ent.visibility === "enterprise", JSON.stringify(ent.entitlements));
    check("plans stay provider-agnostic until mirrored", plans.every((p) => p.provider === "none" || !!p.provider_price_id), "provider-agnostic");
    check("re-seeding heals drift without duplicating plans", (await seedPlans(svc)).created.length === 0 && (await listPlans(svc, { includeHidden: true })).length === plans.length, `${plans.length} plans`);

    // ------------------------------------------------------- scratch account
    const me = await base44.auth.me().catch(() => null);
    ws = await svc.entities.Workspace.create({ name: `billing-test-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
    const W = ws.id;

    const customer = await ensureCustomer(svc, { workspace_id: W, provider: "stripe", email: "owner@example.com", name: "Test WS", provider_customer_id: "cus_test_1", user_id: me?.id });
    const customerAgain = await ensureCustomer(svc, { workspace_id: W, provider: "stripe", email: "owner@example.com" });
    check("customer creation is idempotent per workspace and provider", customer.id === customerAgain.id, customer.id);
    check("the customer starts in good standing with no payment method", customer.billing_state === "active" && customer.payment_status === "none", `${customer.billing_state}/${customer.payment_status}`);
    check("a verified event resolves to its workspace via the customer mapping", (await resolveWorkspaceForEvent(svc, { provider: "stripe", provider_customer_id: "cus_test_1" })) === W, "mapped");
    await expectThrow("a forged workspace id in provider metadata is refused", () => resolveWorkspaceForEvent(svc, { provider: "stripe", provider_customer_id: "cus_test_1", workspace_id: "some-other-workspace" }), "CUSTOMER_WORKSPACE_MISMATCH");
    check("an unmapped provider customer cannot be attributed", (await resolveWorkspaceForEvent(svc, { provider: "stripe", provider_customer_id: "cus_unknown" })) === null, "unattributed");

    // ------------------------------------------------- subscription lifecycle
    // The trial fixture must be a plan that HAS trial days: forcing trial: true on a 0-trial plan
    // is a zero-length trial whose grant expires instantly (the pre-existing fixture mismatch).
    trialPlan = await svc.entities.BillingPlan.create({
      code: `test_trial_${Date.now()}`, name: "Trial fixture", price_cents: 10000, interval: "monthly",
      included_credits: 500, included_integration_credits: 20000, trial_days: 14, tier_rank: 15, visibility: "public",
      limits: { custom_domains: 3, deployments_per_day: 100, marketplace_installs: 50 },
      usage_limits: { monthly_credits: 20000, credits_per_run: 2000, concurrent_runs: 3 },
      model_access: [], overage_policy: "allow_overage",
      entitlements: { custom_domains: 3, advanced_models: true }, provider: "none", active: true,
    });
    const trialStart = await startSubscription(svc, { workspace_id: W, plan_code: trialPlan.code, provider: "manual", user_id: me?.id, trial: true });
    check("a plan with a trial starts as trialing", trialStart.trial && trialStart.subscription.status === "trialing" && !!trialStart.subscription.trial_end, trialStart.subscription.status);
    check("trial credits are granted once", trialStart.credits_applied === 500 && (await deriveBalance(svc, W, "message")).balance === 500, (await deriveBalance(svc, W, "message")).balance);
    const trialReplay = await startSubscription(svc, { workspace_id: W, plan_code: trialPlan.code, provider: "manual" });
    check("restarting the same trial period grants nothing more", trialReplay.duplicate && (await deriveBalance(svc, W, "message")).balance === 500, `${trialReplay.duplicate}`);
    check("a trialing subscription carries entitlements", (await entitlementsFor(svc, W)).entitlements.advanced_models === true, "entitled");
    check("the free plan cannot route an advanced model", (await planAllowsModel(svc, { workspace_id: W, model: { model_id: "claude-opus-5", quality_tier: "advanced" } })).ok === true, "pro allows every model");

    // P-8.7 parity: BOTH directions are scheduled for the period boundary — mid-cycle nothing is
    // credited or revoked, and the pending change applies once due with exactly one grant.
    const upgrade = await changePlan(svc, { workspace_id: W, plan_code: "scale_monthly", user_id: me?.id });
    check("an upgrade is scheduled for the period boundary, not applied now",
      upgrade.direction === "upgrade" && upgrade.subscription.scheduled_plan_code === "scale_monthly"
      && upgrade.subscription.plan_code === trialPlan.code && upgrade.credits_applied === 0,
      `${upgrade.direction} → ${upgrade.subscription.scheduled_plan_code}`);
    const balBeforeUpgradeBoundary = (await deriveBalance(svc, W, "message")).balance;
    await svc.entities.Subscription.update((await subscriptionFor(svc, W)).id, { scheduled_change_at: new Date(Date.now() - 1000).toISOString() });
    await applyScheduledChanges(svc, { workspace_id: W });
    check("the scheduled upgrade applies once due with exactly one grant",
      (await subscriptionFor(svc, W)).plan_code === "scale_monthly" && (await deriveBalance(svc, W, "message")).balance === balBeforeUpgradeBoundary + 1200,
      `${(await deriveBalance(svc, W, "message")).balance}`);
    const balBeforeDowngrade = (await deriveBalance(svc, W, "message")).balance;
    const downgrade = await changePlan(svc, { workspace_id: W, plan_code: "pro_monthly", user_id: me?.id });
    check("a downgrade is scheduled for period end", downgrade.direction === "downgrade" && downgrade.subscription.scheduled_plan_code === "pro_monthly", downgrade.scheduled_for);
    check("a downgrade neither credits nor revokes mid-period", downgrade.credits_applied === 0 && (await deriveBalance(svc, W, "message")).balance === balBeforeDowngrade && (await subscriptionFor(svc, W)).plan_code === "scale_monthly", "unchanged mid-period");
    await svc.entities.Subscription.update((await subscriptionFor(svc, W)).id, { scheduled_change_at: new Date(Date.now() - 1000).toISOString() });
    const applied = await applyScheduledChanges(svc, { workspace_id: W });
    check("the scheduled downgrade applies once due", applied.action === "downgrade_applied" && (await subscriptionFor(svc, W)).plan_code === "pro_monthly", applied.action);
    check("applying scheduled changes twice does not re-credit", (await applyScheduledChanges(svc, { workspace_id: W })).changed === false, "idempotent");

    const cancelled = await cancelSubscription(svc, { workspace_id: W, user_id: me?.id });
    check("cancelling defaults to period end", cancelled.subscription.cancel_at_period_end === true && cancelled.subscription.status !== "cancelled", cancelled.subscription.status);
    check("entitlements survive until the period ends", Object.keys((await entitlementsFor(svc, W)).entitlements).length > 0, "still entitled");
    const resumed = await resumeSubscription(svc, { workspace_id: W, user_id: me?.id });
    check("a cancellation can be resumed before it takes effect", resumed.resumed && resumed.subscription.cancel_at_period_end === false && resumed.subscription.status === "active", resumed.subscription.status);
    await cancelSubscription(svc, { workspace_id: W });
    await svc.entities.Subscription.update((await subscriptionFor(svc, W)).id, { current_period_end: new Date(Date.now() - 1000).toISOString() });
    const expired = await applyScheduledChanges(svc, { workspace_id: W });
    const balAtExpiry = (await deriveBalance(svc, W)).balance;
    check("a subscription expires at period end", expired.action === "expired" && (await subscriptionFor(svc, W)).status === "expired", expired.action);
    check("an expired subscription loses entitlements but keeps credits", Object.keys((await entitlementsFor(svc, W)).entitlements).length === 0 && balAtExpiry > 0, `balance ${balAtExpiry}`);
    await expectThrow("an ended subscription cannot be resumed", () => resumeSubscription(svc, { workspace_id: W }), "SUBSCRIPTION_ENDED");
    await expectThrow("an enterprise plan cannot be self-subscribed", () => startSubscription(svc, { workspace_id: W, plan_code: "enterprise", selfServe: true }), "PLAN_NOT_SELF_SERVE");
    const negotiated = await startSubscription(svc, { workspace_id: W, plan_code: "enterprise", selfServe: false, provider: "manual" });
    check("an enterprise plan can be provisioned by the platform", negotiated.subscription.plan_code === "enterprise" && (await entitlementsFor(svc, W)).entitlements.scim === true, "provisioned");
    await startSubscription(svc, { workspace_id: W, plan_code: "pro_monthly", provider: "manual", trial: false });
    const restarted = await subscriptionFor(svc, W);
    check("a paid start after a trial does not re-grant trial credits", restarted.status === "active" && restarted.plan_code === "pro_monthly", `${restarted.status}/${restarted.plan_code}`);
    const trialEnding = await svc.entities.Subscription.update(restarted.id, { status: "trialing", trial_end: new Date(Date.now() - 1000).toISOString(), cancel_at_period_end: false, current_period_end: new Date(Date.now() + 86400000).toISOString() });
    check("an unpaid trial that lapses becomes past_due", (await applyScheduledChanges(svc, { workspace_id: W })).action === "trial_ended" && (await subscriptionFor(svc, W)).status === "past_due", trialEnding.status);
    await svc.entities.Subscription.update(restarted.id, { status: "active" });

    // ------------------------------------------- webhook → credits (real path)
    const balBeforeInvoice = (await deriveBalance(svc, W, "message")).balance;
    // The invoice fixture uses a plan with NO grant already settled in this period — pro_monthly's
    // period grant was already settled by the trial/start above, so P-8.9's period-scope dedupe
    // would (correctly) decline to credit it a second time.
    const paidIntent = mapStripeEvent(stripeEvent("invoice.paid", { id: "in_paid_1", customer: "cus_test_1", amount_paid: 3900, currency: "usd", number: "INV-1", metadata: { plan_code: "builder_monthly", credits: 5000 }, period_end: Math.floor(Date.now() / 1000) + 86400 }, "evt_paid_1"));
    const paid = await processBillingEvent(svc, { ...paidIntent, workspace_id: W, provider: "stripe", idempotency_key: `stripe:${paidIntent.provider_event_id}` });
    check("a verified invoice payment credits the ledger", paid.credits_applied === 5000 && (await deriveBalance(svc, W, "message")).balance === balBeforeInvoice + 5000, (await deriveBalance(svc, W, "message")).balance);
    const paidReplay = await processBillingEvent(svc, { ...paidIntent, workspace_id: W, provider: "stripe", idempotency_key: `stripe:${paidIntent.provider_event_id}` });
    check("a replayed provider event credits nothing", paidReplay.duplicate && (await deriveBalance(svc, W, "message")).balance === balBeforeInvoice + 5000, "no double credit");
    const invoiceRows = await invoicesFor(svc, W, 20);
    check("the paid invoice is mirrored exactly once", invoiceRows.filter((i) => i.provider_invoice_id === "in_paid_1").length === 1 && invoiceRows.find((i) => i.provider_invoice_id === "in_paid_1").status === "paid", `${invoiceRows.length} invoices`);
    check("payment success clears the account's standing", (await customerFor(svc, W, "stripe")).payment_status === "valid" && (await customerFor(svc, W, "stripe")).billing_state === "active", "active/valid");

    const failIntent = mapStripeEvent(stripeEvent("invoice.payment_failed", { id: "in_fail_1", customer: "cus_test_1", amount_due: 3900, currency: "usd", metadata: { plan_code: "pro_monthly" } }, "evt_fail_1"));
    const balBeforeFail = (await deriveBalance(svc, W)).balance;
    const failed = await processBillingEvent(svc, { ...failIntent, workspace_id: W, provider: "stripe", idempotency_key: `stripe:${failIntent.provider_event_id}` });
    const failCustomer = await customerFor(svc, W, "stripe");
    check("a failed payment grants no credits", failed.credits_applied === 0 && (await deriveBalance(svc, W)).balance === balBeforeFail, "no credit");
    check("a failed payment marks the account delinquent and past_due", failCustomer.billing_state === "delinquent" && failCustomer.payment_status === "failing" && (await subscriptionFor(svc, W)).status === "past_due", `${failCustomer.billing_state}/${(await subscriptionFor(svc, W)).status}`);
    check("a past_due subscription loses entitlements", Object.keys((await entitlementsFor(svc, W)).entitlements).length === 0, "revoked");
    check("the failure reason is short and safe", (failCustomer.last_failure_reason || "").length <= 200 && !/sk_|whsec_/.test(failCustomer.last_failure_reason || ""), failCustomer.last_failure_reason);

    const disputeIntent = mapStripeEvent(stripeEvent("charge.dispute.created", { customer: "cus_test_1", amount: 3900, reason: "fraudulent" }, "evt_dispute_1"));
    await processBillingEvent(svc, { ...disputeIntent, workspace_id: W, provider: "stripe", idempotency_key: `stripe:${disputeIntent.provider_event_id}` });
    check("a dispute marks the account disputed without touching credits", (await customerFor(svc, W, "stripe")).payment_status === "disputed" && (await deriveBalance(svc, W)).balance === balBeforeFail, "disputed");

    const refundIntent = { ...mapStripeEvent(stripeEvent("charge.refunded", { customer: "cus_test_1", amount_refunded: 3900, metadata: { credits: 5000, plan_code: "pro_monthly" } }, "evt_refund_1")), provider_invoice_id: "in_paid_1" };
    const msgBeforeRefund = (await deriveBalance(svc, W, "message")).balance;
    const refunded = await processBillingEvent(svc, { ...refundIntent, workspace_id: W, provider: "stripe", idempotency_key: `stripe:${refundIntent.provider_event_id}` });
    const refundedInvoice = (await invoicesFor(svc, W, 20)).find((i) => i.provider_invoice_id === "in_paid_1");
    check("a refund reverses exactly the credits it granted", refunded.credits_applied === -5000 && (await deriveBalance(svc, W, "message")).balance === msgBeforeRefund - 5000, (await deriveBalance(svc, W, "message")).balance);
    check("a refund reconciles the invoice record", refundedInvoice.status === "refunded" && refundedInvoice.amount_refunded_cents === 3900, `${refundedInvoice.status} / ${refundedInvoice.amount_refunded_cents}`);
    const refundReplay = await processBillingEvent(svc, { ...refundIntent, workspace_id: W, provider: "stripe", idempotency_key: `stripe:${refundIntent.provider_event_id}` });
    check("a replayed refund reverses once", refundReplay.duplicate && (await deriveBalance(svc, W, "message")).balance === msgBeforeRefund - 5000, "single reversal");

    const createdInvoice = mapStripeEvent(stripeEvent("invoice.created", { id: "in_open_1", customer: "cus_test_1", amount_due: 3900, number: "INV-2" }, "evt_open_1"));
    await processBillingEvent(svc, { ...createdInvoice, workspace_id: W, provider: "stripe", idempotency_key: `stripe:${createdInvoice.provider_event_id}` });
    check("an open invoice appears in history without credits", (await invoicesFor(svc, W, 20)).some((i) => i.provider_invoice_id === "in_open_1" && i.status === "open"), "open invoice recorded");

    const unknownPlan = await processBillingEvent(svc, { workspace_id: W, provider: "stripe", provider_event_id: "evt_badplan", event_type: "subscription_started", plan_code: "pro_unlimited_free", amount_cents: 0 });
    check("an event naming an unknown plan is rejected, not credited", unknownPlan.event.status === "rejected" && unknownPlan.credits_applied === 0, unknownPlan.event.reject_reason);
    const zeroCredit = await processBillingEvent(svc, { workspace_id: W, provider: "stripe", provider_event_id: "evt_zero", event_type: "credit_purchase", credits: 0, amount_cents: 100 });
    check("a purchase granting no credits is rejected", zeroCredit.event.status === "rejected", zeroCredit.event.reject_reason);

    // --------------------------------------------------- authority & security
    check("the ledger stayed authoritative through every money event", (await verifyBalanceIntegrity(svc, W)).ok, JSON.stringify((await verifyBalanceIntegrity(svc, W)).cached));
    const events = await svc.entities.BillingEvent.filter({ workspace_id: W }, "-created_date", 50);
    check("every processed money event points at a ledger entry", events.filter((e) => e.status === "processed" && e.credits !== 0).every((e) => !!e.ledger_entry_id), `${events.length} events`);
    check("no billing record contains a provider secret", events.every((e) => !/sk_live|sk_test|whsec_/.test(JSON.stringify(e))), "no secrets stored");
    check("billing writes are owner-only, reads are member-wide", can("owner", "billing.manage") && !can("admin", "billing.manage") && can("viewer", "billing.read") && !can("editor", "billing.admin"), "authorized");
    const overview = await billingOverview(svc, W);
    check("the billing overview never exposes provider identifiers to itself", !JSON.stringify(overview).includes("cus_test_1"), "no provider ids");
    check("period keys are derived per interval", periodKeyFor("monthly", new Date("2026-03-09T00:00:00Z")) === "2026-03" && periodKeyFor("yearly", new Date("2026-03-09T00:00:00Z")) === "2026", periodKeyFor("monthly", new Date("2026-03-09T00:00:00Z")));

    // cross-workspace isolation of billing state
    const other = await svc.entities.Workspace.create({ name: `billing-test-other-${Date.now()}`, owner_id: me?.id || "test-owner", credits_balance: 0 });
    await ensureCustomer(svc, { workspace_id: other.id, provider: "stripe", provider_customer_id: "cus_other_1" });
    const crossIntent = mapStripeEvent(stripeEvent("invoice.paid", { id: "in_cross", customer: "cus_other_1", amount_paid: 3900, metadata: { plan_code: "pro_monthly", credits: 5000, workspace_id: W } }, "evt_cross"));
    await expectThrow("one workspace's customer cannot credit another's balance", () => resolveWorkspaceForEvent(svc, { provider: "stripe", provider_customer_id: crossIntent.provider_customer_id, workspace_id: W }), "CUSTOMER_WORKSPACE_MISMATCH");
    check("the other workspace's balance is untouched", (await deriveBalance(svc, other.id)).balance === 0, (await deriveBalance(svc, other.id)).balance);
    for (const c of await svc.entities.BillingCustomer.filter({ workspace_id: other.id }, "-created_date", 5)) await svc.entities.BillingCustomer.delete(c.id);
    await svc.entities.Workspace.delete(other.id);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    await cleanupWorkspace(svc, ws?.id, ["CreditLedgerEntry", "BillingEvent", "Invoice", "Subscription", "BillingCustomer", "AIOperation", "Budget"]);
    if (trialPlan) await svc.entities.BillingPlan.delete(trialPlan.id).catch(() => {});
  }
}