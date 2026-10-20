// Shared billing certification fixtures.
//
// One definition of the scratch billing world every billing-related suite needs: a hidden test
// plan, an active workspace (optionally subscribed, optionally credit-granted through the real
// ledger) — so no two suites drift apart on how fixtures are built.
import { recordEvent } from "./ledger.ts";

/**
 * Creates a scratch hidden BillingPlan. `created.plans` collects its id for the suite's cleanup.
 */
export async function makeBillingPlan(svc, created, label, overrides = {}, stamp = Date.now()) {
  const plan = await svc.entities.BillingPlan.create({
    code: `test_${label}_${stamp}`, name: `Test ${label}`, price_cents: 0, interval: "monthly", tier_rank: 1, visibility: "hidden", active: true,
    included_credits: 100000, overage_policy: "allow_overage", limits: {}, usage_limits: {}, model_access: [], entitlements: {}, provider: "none",
    ...overrides,
  });
  if (created) created.plans.push(plan.id);
  return plan;
}

/**
 * Creates a scratch active Workspace, optionally with a subscription to `plan` (pass plan: null
 * for a subscription-less/free workspace) and a promotional credit grant through the real ledger.
 * `created.workspaces` collects its id for the suite's cleanup.
 */
export async function makeBillingWorkspace(svc, created, label, { plan = null, credits = 0, subscription = true } = {}, stamp = Date.now()) {
  const ownerId = `billing_owner_${label}_${stamp}`;
  const ws = await svc.entities.Workspace.create({ name: `billing-test ${label} ${stamp}`, owner_id: ownerId, status: "active" });
  if (created) created.workspaces.push(ws.id);
  if (plan && subscription) await svc.entities.Subscription.create({ workspace_id: ws.id, plan_code: plan.code, status: "active", provider: "none", current_period_start: new Date(stamp - 60000).toISOString(), entitlements: {} });
  if (credits > 0) await grantTestCredits(svc, ws, credits);
  return { ws, user: { id: ownerId, email: `${ownerId}@example.com` } };
}

/** Ledger-backed promotional credit grant for an existing scratch workspace. */
export async function grantTestCredits(svc, ws, amount) {
  return recordEvent(svc, { workspace_id: ws.id, event_type: "promotional", amount, idempotency_key: `test-grant:${ws.id}`, reason: "Test credit grant" });
}