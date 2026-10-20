// Billing foundation — provider-agnostic.
//
// A payment provider's state is NEVER the authoritative credit balance. Money events arrive
// here, are validated and persisted as BillingEvent rows, and only then flow into the credit
// ledger. Plugging in Stripe (or anything else) means writing an adapter that calls
// `processBillingEvent` — the economics and credit engines do not change.
//
// Every event is idempotent: a replayed webhook, a retried purchase or a duplicated provider
// event id settles the SAME BillingEvent and moves credits exactly once.

import { recordEvent } from "./ledger.ts";
import { applyPaymentState, upsertInvoice, recordRefundOnInvoice, customerByProviderId } from "./billingAccounts.ts";
import { periodKeyFor } from "./paymentProviders.ts";
// Referral (Slice 3): the PAID subscription start settled here is the first paid-upgrade
// transition of the referrer reward. Detection rides this EXISTING canonical path; fail-safe below.
import { maybeGrantReferrerUpgradeReward } from "./referral.ts";
import { emitAppPayment } from "./workflowTriggers.ts";

// Production plan definitions. Each plan carries its own limits, usage ceilings, model access
// and overage policy, so entitlement decisions never need a hardcoded plan name anywhere else.
// Credit entitlements follow the Base44 model: `included_credits` is the MESSAGE pool (Builder/
// Agent) and `included_integration_credits` the INTEGRATION pool (live-app usage). Usage limits are
// pool-scoped: daily_credits / monthly_credits / credits_per_run / concurrent_runs govern message
// operations (the Free plan caps both windows — 5 credits per UTC day, 25 per monthly cycle), and
// monthly_integration_credits / integration_credits_per_run / concurrent_integration_runs govern
// integration operations. An absent limit is unlimited — no integration limits are set here, so the
// integration pool is bounded only by its own balance and can never exhaust or block the message pool.
export const DEFAULT_PLANS = [
  { code: "free", name: "Free", description: "Explore the builder", price_cents: 0, interval: "monthly", included_credits: 25, included_integration_credits: 100, trial_days: 0, tier_rank: 0, visibility: "public",
    limits: { projects: 5, custom_domains: 0, deployments_per_day: 5, marketplace_installs: 3 },
    usage_limits: { daily_credits: 5, monthly_credits: 25, credits_per_run: 50, concurrent_runs: 1 },
    model_access: [], overage_policy: "block",
    entitlements: { projects: 5, custom_domains: 0, advanced_models: false, sso: false, scim: false, in_app_code_edits: true, core_features: true, published_app_url: true }, provider: "none", active: true },
  { code: "starter_monthly", name: "Starter", description: "For getting your first apps live", price_cents: 2000, interval: "monthly", included_credits: 100, included_integration_credits: 2000, trial_days: 0, tier_rank: 3, visibility: "public",
    limits: { custom_domains: 1, deployments_per_day: 20, marketplace_installs: 10 },
    usage_limits: {},
    model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 1, advanced_models: false, sso: false, scim: false, in_app_code_edits: true }, provider: "none", active: true },
  { code: "builder_monthly", name: "Builder", description: "For builders shipping regularly", price_cents: 5000, interval: "monthly", included_credits: 250, included_integration_credits: 10000, trial_days: 0, tier_rank: 6, visibility: "public",
    limits: { custom_domains: 2, deployments_per_day: 50, marketplace_installs: 25 },
    usage_limits: {},
    model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 2, advanced_models: true, sso: false, scim: false, in_app_code_edits: true, ai_model_selection: true, github_integration: true, early_beta_access: true, referral_credits: 25, free_domain_1yr: true }, provider: "none", active: true },
  { code: "pro_monthly", name: "Pro", description: "For professional builders", price_cents: 10000, interval: "monthly", included_credits: 500, included_integration_credits: 20000, trial_days: 0, tier_rank: 10, visibility: "public",
    limits: { custom_domains: 3, deployments_per_day: 100, marketplace_installs: 50 },
    usage_limits: { monthly_credits: 20000, credits_per_run: 2000, concurrent_runs: 3 },
    model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 3, advanced_models: true, sso: false, scim: false, in_app_code_edits: true, ai_model_selection: true, github_integration: true, early_beta_access: true, referral_credits: 25, free_domain_1yr: true }, provider: "none", active: true },
  { code: "scale_monthly", name: "Elite", description: "Teams shipping continuously", price_cents: 20000, interval: "monthly", included_credits: 1200, included_integration_credits: 50000, trial_days: 0, tier_rank: 20, visibility: "public",
    limits: { custom_domains: 25, deployments_per_day: 1000, marketplace_installs: 500 },
    usage_limits: { monthly_credits: 200000, credits_per_run: 20000, concurrent_runs: 10 },
    model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 25, advanced_models: true, sso: false, scim: false, in_app_code_edits: true, ai_model_selection: true, github_integration: true, early_beta_access: true, referral_credits: 25, free_domain_1yr: true, premium_support: true }, provider: "none", active: true,
    // P-8.8: Base44 publishes that Elite's message/integration credit volumes are chosen on the
    // Plans page, but not the selectable amounts or their prices (UNKNOWN). This server-owned
    // ladder is anchored on the verified default (1200/50,000); the PRICE of a larger volume is
    // UNKNOWN and deliberately not invented — the plan's own price applies until evidence exists.
    credit_options: [
      { code: "elite_base", message_credits: 1200, integration_credits: 50000 },
      { code: "elite_x2", message_credits: 2400, integration_credits: 100000 },
      { code: "elite_x4", message_credits: 4800, integration_credits: 200000 },
      { code: "elite_5400", message_credits: 5400, integration_credits: 200000 },
      { code: "elite_6800", message_credits: 6800, integration_credits: 250000 },
      { code: "elite_8200", message_credits: 8200, integration_credits: 300000 },
    ] },
  // P-8.6 annual plans: the same tiers at a 20% annual discount (monthly × 12 × 0.8). Included
  // credits are per yearly cycle and unchanged from the monthly tiers — paying annually implies no
  // credit change. The interval drives period keys, grant expiry and renewal cadence.
  { code: "starter_yearly", name: "Starter", description: "For getting your first apps live", price_cents: 19200, interval: "yearly", included_credits: 100, included_integration_credits: 2000, trial_days: 0, tier_rank: 3, visibility: "public",
    limits: { custom_domains: 1, deployments_per_day: 20, marketplace_installs: 10 },
    usage_limits: {}, model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 1, advanced_models: false, sso: false, scim: false, in_app_code_edits: true }, provider: "none", active: true },
  { code: "builder_yearly", name: "Builder", description: "For builders shipping regularly", price_cents: 48000, interval: "yearly", included_credits: 250, included_integration_credits: 10000, trial_days: 0, tier_rank: 6, visibility: "public",
    limits: { custom_domains: 2, deployments_per_day: 50, marketplace_installs: 25 },
    usage_limits: {}, model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 2, advanced_models: true, sso: false, scim: false, in_app_code_edits: true, ai_model_selection: true, github_integration: true, early_beta_access: true, referral_credits: 25, free_domain_1yr: true }, provider: "none", active: true },
  { code: "pro_yearly", name: "Pro", description: "For professional builders", price_cents: 96000, interval: "yearly", included_credits: 500, included_integration_credits: 20000, trial_days: 0, tier_rank: 10, visibility: "public",
    limits: { custom_domains: 3, deployments_per_day: 100, marketplace_installs: 50 },
    usage_limits: { monthly_credits: 20000, credits_per_run: 2000, concurrent_runs: 3 },
    model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 3, advanced_models: true, sso: false, scim: false, in_app_code_edits: true, ai_model_selection: true, github_integration: true, early_beta_access: true, referral_credits: 25, free_domain_1yr: true }, provider: "none", active: true },
  { code: "scale_yearly", name: "Elite", description: "Teams shipping continuously", price_cents: 192000, interval: "yearly", included_credits: 1200, included_integration_credits: 50000, trial_days: 0, tier_rank: 20, visibility: "public",
    limits: { custom_domains: 25, deployments_per_day: 1000, marketplace_installs: 500 },
    usage_limits: { monthly_credits: 200000, credits_per_run: 20000, concurrent_runs: 10 },
    model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 25, advanced_models: true, sso: false, scim: false, in_app_code_edits: true, ai_model_selection: true, github_integration: true, early_beta_access: true, referral_credits: 25, free_domain_1yr: true, premium_support: true }, provider: "none", active: true,
    credit_options: [
      { code: "elite_base", message_credits: 1200, integration_credits: 50000 },
      { code: "elite_x2", message_credits: 2400, integration_credits: 100000 },
      { code: "elite_x4", message_credits: 4800, integration_credits: 200000 },
      { code: "elite_5400", message_credits: 5400, integration_credits: 200000 },
      { code: "elite_6800", message_credits: 6800, integration_credits: 250000 },
      { code: "elite_8200", message_credits: 8200, integration_credits: 300000 },
    ] },
  { code: "enterprise", name: "Enterprise", description: "Custom negotiated contract (price and credits set per contract; the 0 values are technical placeholders, not a Base44 entitlement)", price_cents: 0, interval: "yearly", included_credits: 0, included_integration_credits: 0, trial_days: 0, tier_rank: 30, visibility: "enterprise",
    limits: { custom_domains: 1000, deployments_per_day: 10000, marketplace_installs: 10000 },
    usage_limits: {}, model_access: [], overage_policy: "allow_overage",
    entitlements: { custom_domains: 1000, advanced_models: true, sso: true, scim: true, audit_export: true }, provider: "none", active: true },
  { code: "credits_topup", name: "Credit top-up", description: "Internal one-time credit purchase (not a Base44-equivalent product)", price_cents: 1000, interval: "one_time", included_credits: 1000, included_integration_credits: 0, trial_days: 0, tier_rank: 0, visibility: "public",
    limits: {}, usage_limits: {}, model_access: [], overage_policy: "allow_overage", entitlements: {}, provider: "none", active: true },
];

// Seeds missing plans and brings existing rows up to the current definition. Prices and included
// credits are platform-owned, so an out-of-date plan row is corrected rather than left to drift.
export async function seedPlans(base44) {
  const existing = await base44.entities.BillingPlan.list("-updated_date", 200).catch(() => []);
  const byCode = new Map(existing.map((p) => [p.code, p]));
  const created = [];
  const updated = [];
  for (const plan of DEFAULT_PLANS) {
    const row = byCode.get(plan.code);
    if (!row) { await base44.entities.BillingPlan.create(plan); created.push(plan.code); continue; }
    const drifted = Object.entries(plan).some(([k, v]) => (typeof v === "object" ? JSON.stringify(row[k] || (Array.isArray(v) ? [] : {})) !== JSON.stringify(v) : row[k] !== v));
    if (drifted) { await base44.entities.BillingPlan.update(row.id, plan); updated.push(plan.code); }
  }
  return { created, updated, total: byCode.size + created.length };
}

export const listPlans = async (base44, { includeHidden = false } = {}) => {
  const plans = await base44.entities.BillingPlan.filter({ active: true }, "tier_rank", 100);
  // A non-admin caller may only see self-serve public plans. Enterprise and custom plans are
  // negotiated contracts — their pricing and limits are not shown to ordinary members.
  return includeHidden ? plans : plans.filter((p) => p.visibility === "public");
};

export const getPlan = async (base44, code) => (await base44.entities.BillingPlan.filter({ code }, "-updated_date", 1))[0] || null;

// P-8.10: provider price → plan reverse lookup. A verified provider event that carries a price id
// but no plan metadata (a subscription changed through the provider's portal) resolves its plan
// from the plan mirror. An unmapped price resolves to nothing — fail-closed, no invented plan.
export async function planByProviderPrice(base44, provider, provider_price_id) {
  if (!provider_price_id) return null;
  const rows = await base44.entities.BillingPlan.filter({ provider_price_id }, "-updated_date", 5).catch(() => []);
  return rows.find((p) => p.active !== false && (!p.provider || p.provider === "none" || p.provider === provider)) || null;
}

const LEDGER_TYPE_FOR = {
  credit_purchase: "purchase",
  subscription_started: "purchase",
  subscription_renewed: "purchase",
  // A trial grants its plan's credits once; the conversion to paid does not re-grant them.
  trial_started: "promotional",
  promotional_grant: "promotional",
  refund: "refund",
  adjustment: "adjustment",
};

const findEvent = async (base44, workspace_id, idempotency_key) =>
  (await base44.entities.BillingEvent.filter({ workspace_id, idempotency_key }, "created_date", 5))[0] || null;

// P-8.1/P-8.2: recurring plan grants are bound to their billing cycle. Every period grant
// carries its cycle's end as the ledger entry's canonical expiry (metadata.expires_at), so the
// ledger's derivation — never a balance write — drops the UNUSED remainder when the cycle ends.
// DOCUMENTED (Base44, Credits): "bonus credits and top-up credits never carry over" — a
// credit_purchase (top-up) grant also carries the next reset boundary as its canonical expiry,
// so unused top-up credits never roll into the next period. Adjustments and refunds carry no
// expiry: they are permanent movements.
const PERIOD_GRANT_EVENTS = new Set(["subscription_started", "subscription_renewed", "trial_started"]);
// A one-time credit purchase is cycle-bound like a plan grant: it expires at the next credit reset.
const CREDIT_PURCHASE_EVENTS = new Set(["credit_purchase"]);

// P-8.9 — period-scoped grant dedupe. A plan's credits are granted once per PLAN-PERIOD, no
// matter which provider events announce it: a subscription checkout AND the period's first
// invoice both arrive for the same billing cycle with DIFFERENT provider event ids, and both map
// to recurring-grant intents. The period is anchored on the SERVICE-PERIOD START — the event's
// own period bounds when they carry one, else (starts only) the workspace subscription's current
// period, else now — and keyed in the plan's interval granularity. A renewal whose period info
// is absent or opaque carries no cycle scope and is exempt (its idempotency key still guards it).
const RECURRING_GRANT_EVENTS = new Set(["subscription_started", "subscription_renewed", "trial_started"]);

function periodScopeAnchor(sub, { period_start, period_key, period_end }, { ownPeriodInfoOnly = false } = {}) {
  const raw = period_start || period_end || period_key;
  if (raw && Number.isFinite(Date.parse(raw))) return raw;
  if (ownPeriodInfoOnly) return null;
  const subStart = sub?.current_period_start;
  if (subStart && Number.isFinite(Date.parse(subStart))) return subStart;
  return new Date().toISOString();
}

function storedEventScope(event, interval) {
  const raw = event.period_start || event.period_end || event.period_key;
  return raw && Number.isFinite(Date.parse(raw)) ? periodKeyFor(interval, raw) : null;
}

// P-8.9 — the concurrent-duplicate backstop for the event row itself: two racing deliveries of
// the same event both pass findEvent (the TOCTOU window), so AFTER the insert the key is re-read;
// the earliest row is canonical and later rows are stamped `ignored (duplicate of …)`. Credits
// still move exactly once through the ledger's own idempotency; this keeps exactly one event row.
async function reconcileDuplicateEvent(base44, created) {
  const hits = await base44.entities.BillingEvent.filter({ workspace_id: created.workspace_id, idempotency_key: created.idempotency_key }, "created_date", 10);
  if (hits.length <= 1) return created;
  const ordered = [...hits].sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id)));
  const canonical = ordered[0];
  for (const loser of ordered.slice(1)) {
    if (loser.status !== "ignored") {
      await base44.entities.BillingEvent.update(loser.id, { status: "ignored", reject_reason: `duplicate of ${canonical.id}`, processed_at: new Date().toISOString() }).catch(() => {});
    }
  }
  return canonical;
}

// The next cycle boundary strictly after `after`, anchored on `anchor` (P-8.2): the
// subscription's own period start for paid plans, the workspace's start date for the Free
// plan — never the calendar month.
export function nextCycleEnd({ anchor, interval = "monthly", after = Date.now() }) {
  const d = new Date(anchor);
  const step = () => { if (interval === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1); };
  let guard = 0;
  while (d.getTime() <= after && guard++ < 2400) step();
  return d.toISOString();
}

// P-8.8 — configurable credit allowances (Elite parity). A caller may only NAME an option by its
// code; the amounts are always resolved from the plan's own server-owned list. A stored selection
// is re-validated by EXACT match at every grant, so a forged, stale or drifted amount never grants
// anything — it falls back to the plan's defaults.
export const findCreditOption = (plan, code) => (plan?.credit_options || []).find((o) => String(o.code) === String(code || "")) || null;
export const resolveCreditOption = (plan, selected) => {
  if (!selected || !(plan?.credit_options || []).length) return null;
  return plan.credit_options.find((o) => o.code === selected.code && o.message_credits === selected.message_credits && o.integration_credits === selected.integration_credits) || null;
};

// Cycle end for a period grant with no explicit expiry of its own, derived from the canonical
// subscription state — never a second source of truth.
async function cycleEndForGrant(base44, { workspace_id, plan }) {
  const sub = (await base44.entities.Subscription.filter({ workspace_id }, "-updated_date", 1).catch(() => []))[0] || null;
  if (sub?.current_period_start) return nextCycleEnd({ anchor: sub.current_period_start, interval: plan?.interval || "monthly" });
  if (plan && plan.interval !== "one_time") return nextCycleEnd({ anchor: Date.now(), interval: plan.interval });
  const ws = await base44.entities.Workspace.get(workspace_id).catch(() => null);
  return nextCycleEnd({ anchor: ws?.created_date || Date.now(), interval: "monthly" });
}

/**
 * The single entry point for money → credits.
 *
 * Validation happens before anything is credited: an unknown plan, a non-positive credit
 * amount on a granting event, or a failed payment produces a `rejected`/`ignored` event that
 * never touches the ledger.
 */
export async function processBillingEvent(base44, {
  workspace_id, user_id = null, provider = "none", provider_event_id = null, event_type,
  amount_cents = 0, currency = "USD", credits = 0, integration_credits = 0, plan_code = null, period_key = null,
  payload_preview = null, idempotency_key = null,
  // Provider mirrors and period bounds. They never influence how much is credited — only what
  // the account's own records say about where the money came from.
  provider_customer_id = null, provider_subscription_id = null, provider_invoice_id = null,
  period_start = null, period_end = null, invoice = null, payment_status = null, failure_reason = null,
  cancel_at_period_end = null,
  // P-8.1: explicit cycle end for the grant this event produces. Falls back to the event's own
  // period bounds, then to the canonical cycle anchor — see cycleEndForGrant.
  grant_expires_at = null,
}) {
  if (!workspace_id) throw new Error("billing: workspace_id is required");
  if (!event_type) throw new Error("billing: event_type is required");
  const key = idempotency_key || (provider_event_id ? `${provider}:${provider_event_id}` : null);
  if (!key) throw new Error("billing: idempotency_key or provider_event_id is required");

  // Replay protection: the same provider event never credits twice.
  const existing = await findEvent(base44, workspace_id, key);
  // Rows written before the integration split carry no integration fields; they read as 0.
  if (existing) return { event: existing, duplicate: true, credits_applied: existing.status === "processed" ? existing.credits : 0, integration_credits_applied: existing.status === "processed" ? existing.integration_credits || 0 : 0 };

  let plan = null;
  if (plan_code) {
    plan = await getPlan(base44, plan_code);
    if (!plan) {
      const rejected = await base44.entities.BillingEvent.create({
        workspace_id, user_id, provider, provider_event_id, event_type, status: "rejected",
        amount_cents, currency, credits: 0, plan_code, period_key, idempotency_key: key,
        reject_reason: `Unknown plan "${plan_code}"`, payload_preview: payload_preview?.slice(0, 500) || null,
      });
      return { event: rejected, duplicate: false, credits_applied: 0 };
    }
  }

  // P-8.9: the dedupe runs AFTER plan resolution and BEFORE any event row is written. A deduped
  // delivery still applies its ENTITLEMENT state (a paid conversion after a trial must flip the
  // status) but moves no credits and creates no second event row.
  let periodScope = null;
  if (plan && LEDGER_TYPE_FOR[event_type] && RECURRING_GRANT_EVENTS.has(event_type) && plan.interval !== "one_time") {
    const subRow = (await base44.entities.Subscription.filter({ workspace_id }, "-updated_date", 1).catch(() => []))[0] || null;
    const anchor = periodScopeAnchor(subRow, { period_start, period_key, period_end }, { ownPeriodInfoOnly: event_type === "subscription_renewed" });
    periodScope = anchor ? periodKeyFor(plan.interval, anchor) : null;
    if (periodScope) {
      const priorRows = await base44.entities.BillingEvent.filter({ workspace_id, plan_code: plan.code }, "-created_date", 50).catch(() => []);
      const prior = priorRows.find((e) => e.status === "processed" && RECURRING_GRANT_EVENTS.has(e.event_type) && storedEventScope(e, plan.interval) === periodScope);
      if (prior) {
        await applyEntitlementState(base44, { workspace_id, event_type, plan, provider, period_key, period_start, period_end, provider_subscription_id, provider_customer_id, cancel_at_period_end });
        return { event: prior, duplicate: true, credits_applied: 0, integration_credits_applied: 0 };
      }
    }
  }

  const grantsCredits = !!LEDGER_TYPE_FOR[event_type];
  const resolvedCredits = credits || (grantsCredits && plan ? plan.included_credits || 0 : 0);
  // Each pool resolves independently: a refund of a plan grant reverses the plan's integration grant
  // too, and a plan with no message credits can still grant integration credits.
  const resolvedIntegrationCredits = integration_credits || (grantsCredits && plan ? plan.included_integration_credits || 0 : 0);
  const hasGrant = resolvedCredits > 0 || resolvedIntegrationCredits > 0;
  const mirrors = { provider_customer_id, provider_subscription_id, provider_invoice_id, period_start, period_end };

  // Non-crediting events (payment failure, dispute, cancellation, invoice creation) still get
  // recorded — they change entitlement and account standing, not the balance.
  if (!grantsCredits) {
    const createdRow = await base44.entities.BillingEvent.create({
      workspace_id, user_id, provider, provider_event_id, event_type, status: "processed",
      amount_cents, currency, credits: 0, plan_code, period_key, idempotency_key: key, ...mirrors,
      payload_preview: payload_preview?.slice(0, 500) || null, processed_at: new Date().toISOString(),
    });
    const event = await reconcileDuplicateEvent(base44, createdRow);
    if (event.id !== createdRow.id) return { event, duplicate: true, credits_applied: 0 };
    if (invoice || provider_invoice_id) await upsertInvoice(base44, { workspace_id, provider, invoice: invoice || { provider_invoice_id }, plan_code, period_key, billing_event_id: event.id, status: invoice?.status || (event_type === "payment_failed" ? "payment_failed" : null) });
    await applyPaymentState(base44, { workspace_id, provider, payment_status: payment_status || (event_type === "payment_failed" ? "failing" : null), failure_reason, disputed: event_type === "payment_disputed" });
    await applyEntitlementState(base44, { workspace_id, event_type, plan, provider, period_key, period_start, period_end, provider_subscription_id, provider_customer_id, cancel_at_period_end });
    return { event, duplicate: false, credits_applied: 0 };
  }

  // A plan event with no included credits is still a legitimate entitlement change — a
  // negotiated enterprise plan grants access, not credits — so it is processed rather than
  // rejected. Only a pure credit movement is meaningless at zero.
  const PURE_CREDIT_EVENTS = ["credit_purchase", "promotional_grant", "refund", "adjustment"];
  if (!hasGrant && !PURE_CREDIT_EVENTS.includes(event_type)) {
    const event = await base44.entities.BillingEvent.create({
      workspace_id, user_id, provider, provider_event_id, event_type, status: "processed",
      amount_cents, currency, credits: 0, plan_code, period_key, idempotency_key: key, ...mirrors,
      payload_preview: payload_preview?.slice(0, 500) || null, processed_at: new Date().toISOString(),
    });
    await applyEntitlementState(base44, { workspace_id, event_type, plan, provider, period_key, period_start, period_end, provider_subscription_id, provider_customer_id, cancel_at_period_end });
    return { event, duplicate: false, credits_applied: 0 };
  }

  if (!hasGrant) {
    const rejected = await base44.entities.BillingEvent.create({
      workspace_id, user_id, provider, provider_event_id, event_type, status: "rejected",
      amount_cents, currency, credits: 0, plan_code, period_key, idempotency_key: key,
      reject_reason: "Event grants no credits", payload_preview: payload_preview?.slice(0, 500) || null,
    });
    return { event: rejected, duplicate: false, credits_applied: 0 };
  }

  const createdRow = await base44.entities.BillingEvent.create({
    workspace_id, user_id, provider, provider_event_id, event_type, status: "received",
    amount_cents, currency, credits: resolvedCredits, integration_credits: resolvedIntegrationCredits, plan_code,
    // P-8.9: a recurring grant without its own period key stores the derived period scope, so a
    // later delivery of the same cycle (the first invoice.paid after a checkout) matches it.
    period_key: period_key || periodScope || null, idempotency_key: key, ...mirrors,
    payload_preview: payload_preview?.slice(0, 500) || null,
  });
  const event = await reconcileDuplicateEvent(base44, createdRow);
  if (event.id !== createdRow.id) {
    return {
      event, duplicate: true,
      credits_applied: event.status === "processed" ? event.credits : 0,
      integration_credits_applied: event.status === "processed" ? event.integration_credits || 0 : 0,
    };
  }

  // A refund removes credits; every other crediting event adds them. Each pool is its own ledger
  // entry under its own key (message keeps the original key), so even a duplicated processor
  // cannot double-apply either pool.
  const isRefund = event_type === "refund";
  const signOf = (n) => (isRefund ? -Math.abs(n) : Math.abs(n));
  const signed = resolvedCredits > 0 ? signOf(resolvedCredits) : 0;
  const signedIntegration = resolvedIntegrationCredits > 0 ? signOf(resolvedIntegrationCredits) : 0;
  const reason = `${event_type}${plan_code ? ` · ${plan_code}` : ""}`;
  // P-8.1/P-8.2: the grant's canonical expiry. Explicit expiry wins, then the event's own period
  // bounds, then the canonical cycle anchor (subscription period start / workspace start date).
  const grantExpiry = grantsCredits
    ? (grant_expires_at || period_end || ((PERIOD_GRANT_EVENTS.has(event_type) || CREDIT_PURCHASE_EVENTS.has(event_type)) ? await cycleEndForGrant(base44, { workspace_id, plan }) : null))
    : null;
  const metadata = { provider, provider_event_id, amount_cents, currency, period_key, ...(grantExpiry ? { expires_at: grantExpiry } : {}) };
  const res = signed ? await recordEvent(base44, {
    workspace_id, user_id, billing_event_id: event.id,
    event_type: LEDGER_TYPE_FOR[event_type], amount: signed, credit_type: "message",
    idempotency_key: `billing:${key}`, reason, metadata,
  }, { allowNegative: isRefund }) : null;
  const intRes = signedIntegration ? await recordEvent(base44, {
    workspace_id, user_id, billing_event_id: event.id,
    event_type: LEDGER_TYPE_FOR[event_type], amount: signedIntegration, credit_type: "integration",
    idempotency_key: `billing:${key}:integration`, reason: `${reason} · integration`, metadata,
  }, { allowNegative: isRefund }) : null;

  const invoiceRow = invoice || provider_invoice_id ? await upsertInvoice(base44, {
    workspace_id, provider, invoice: invoice || { provider_invoice_id }, plan_code, period_key,
    credits_granted: signed > 0 ? signed : 0, billing_event_id: event.id, amount_cents,
    status: event_type === "refund" ? null : invoice?.status || "paid",
  }) : null;
  if (event_type === "refund") await recordRefundOnInvoice(base44, { workspace_id, provider_invoice_id, amount_cents });

  const processed = await base44.entities.BillingEvent.update(event.id, {
    status: "processed", processed_at: new Date().toISOString(),
    ...(res ? { ledger_entry_id: res.entry.id } : {}),
    ...(intRes ? { integration_ledger_entry_id: intRes.entry.id } : {}),
    ...(invoiceRow ? { invoice_id: invoiceRow.id } : {}),
  });
  await applyPaymentState(base44, { workspace_id, provider, paid: event_type !== "refund" && amount_cents > 0, payment_status });
  await applyEntitlementState(base44, { workspace_id, event_type, plan, provider, period_key, period_start, period_end, provider_subscription_id, provider_customer_id, cancel_at_period_end });
  // Referral (Slice 3), fail-safe: a PAID subscription start with real money, settled
  // non-duplicated through this canonical processor, is the qualifying first paid-upgrade
  // transition. Renewals and scheduled changes arrive as subscription_renewed, trial and free
  // grants as other event types or zero amounts — none reach this hook. Never breaks settlement.
  if (event_type === "subscription_started" && amount_cents > 0) {
    try {
      await maybeGrantReferrerUpgradeReward(base44.asServiceRole || base44, { workspace_id, plan_code });
    } catch {}
  }
  // app_payment (DOCUMENTED Base44 workflow trigger), fail-safe: fires on a successfully settled
  // payment (subscription checkout/renewal, credit purchase) or refund. Only non-duplicated,
  // processed MONEY events reach this hook — a replayed event returns earlier and never re-fires.
  if (amount_cents > 0 || event_type === "refund") {
    await emitAppPayment(base44, { workspace_id, event: processed });
  }
  return { event: processed, duplicate: false, credits_applied: signed, integration_credits_applied: signedIntegration, balance: (intRes || res).balance, invoice: invoiceRow };
}

// Entitlement state derived from validated events, not from provider status strings. A provider
// may say "active"; this platform only becomes active because an event it verified said so.
const STATUS_FOR_EVENT = {
  subscription_started: "active",
  subscription_renewed: "active",
  subscription_resumed: "active",
  trial_started: "trialing",
  subscription_cancelled: "cancelled",
  payment_failed: "past_due",
  payment_disputed: "past_due",
};

async function applyEntitlementState(base44, { workspace_id, event_type, plan, provider, period_key, period_start = null, period_end = null, provider_subscription_id = null, provider_customer_id = null, cancel_at_period_end = null }) {
  const affectsState = !!plan || !!STATUS_FOR_EVENT[event_type] || event_type === "subscription_updated";
  if (!affectsState) return null;
  const current = (await base44.entities.Subscription.filter({ workspace_id }, "-updated_date", 1))[0] || null;
  const patch = {
    ...(plan ? { plan_code: plan.code, entitlements: plan.entitlements || {} } : {}),
    ...(provider && provider !== "none" ? { provider } : {}),
    ...(period_key ? { last_grant_period: period_key } : {}),
    ...(period_start ? { current_period_start: period_start } : {}),
    ...(period_end ? { current_period_end: period_end } : {}),
    ...(provider_subscription_id ? { provider_subscription_id } : {}),
    ...(provider_customer_id ? { provider_customer_id } : {}),
    ...(cancel_at_period_end === null ? {} : { cancel_at_period_end: !!cancel_at_period_end }),
  };
  const status = STATUS_FOR_EVENT[event_type];
  if (status) patch.status = status;
  if (event_type === "trial_started") patch.trial_credits_granted = true;
  if (event_type === "subscription_cancelled") patch.cancelled_at = new Date().toISOString();
  if (event_type === "subscription_resumed") { patch.cancel_at_period_end = false; patch.cancelled_at = null; }
  if (!current) {
    if (!plan) return null;
    return base44.entities.Subscription.create({ workspace_id, plan_code: plan.code, status: status || "active", provider: provider || "none", entitlements: plan.entitlements || {}, last_grant_period: period_key || null, ...patch });
  }
  return base44.entities.Subscription.update(current.id, patch);
}

// Resolve the workspace a verified provider event belongs to. Metadata is only a hint: the
// mapping must exist as a BillingCustomer row, so a forged workspace id in a payload cannot
// credit an account the provider customer does not own.
export async function resolveWorkspaceForEvent(base44, { provider, provider_customer_id, workspace_id = null }) {
  const mapped = await customerByProviderId(base44, provider, provider_customer_id);
  if (mapped) {
    if (workspace_id && workspace_id !== mapped.workspace_id) {
      throw Object.assign(new Error("Provider customer does not belong to the stated workspace"), { code: "CUSTOMER_WORKSPACE_MISMATCH", status: 403 });
    }
    return mapped.workspace_id;
  }
  return workspace_id || null;
}

// Recurring grant for a subscription period. Keyed by period, so a webhook replay for the
// same period is a no-op while a genuine new period grants once.
export async function grantPeriodCredits(base44, { workspace_id, plan_code, period_key, period_start = null, provider = "none", user_id = null }) {
  const plan = await getPlan(base44, plan_code);
  if (!plan) throw Object.assign(new Error(`Unknown plan "${plan_code}"`), { code: "UNKNOWN_PLAN", status: 400 });
  // P-8.8: a stored selected option — exact-match re-validated against THIS plan's list —
  // overrides the default included amounts, so a renewal grants exactly the chosen volume
  // through the same canonical, idempotent, cycle-bound billing event.
  const sub = (await base44.entities.Subscription.filter({ workspace_id }, "-updated_date", 1))[0] || null;
  const option = sub?.selected_credit_option ? resolveCreditOption(plan, sub.selected_credit_option) : null;
  return processBillingEvent(base44, {
    workspace_id, user_id, provider, event_type: "subscription_renewed",
    amount_cents: plan.price_cents,
    credits: option ? option.message_credits : plan.included_credits,
    integration_credits: option ? option.integration_credits : plan.included_integration_credits || 0,
    plan_code, period_key, period_start,
    grant_expires_at: await cycleEndForGrant(base44, { workspace_id, plan }),
    idempotency_key: `period:${workspace_id}:${plan_code}:${period_key}`,
  });
}

// Period grant for the implicit Free plan (a workspace with no subscription row). Same processor
// and same period key shape as grantPeriodCredits, but without plan_code: a plan_code would make
// applyEntitlementState create a Subscription row, and Free must stay "no subscription". The
// BillingEvent key blocks a replayed period; each pool gets its own ledger key
// (`billing:period:…` and `billing:period:…:integration`).
export async function grantFreePeriodCredits(base44, { workspace_id, period_key = null }) {
  const plan = await getPlan(base44, "free");
  if (!plan || plan.active === false) return null;
  // P-8.2: the Free credit cycle anchors on the workspace's own start date — never on the
  // calendar month. One grant per cycle, idempotent by the cycle's end boundary, and its
  // credits expire at that same boundary (P-8.1).
  const ws = await base44.entities.Workspace.get(workspace_id).catch(() => null);
  const cycleEnd = nextCycleEnd({ anchor: ws?.created_date || Date.now(), interval: "monthly" });
  return processBillingEvent(base44, {
    workspace_id, provider: "none", event_type: "subscription_renewed", amount_cents: 0,
    credits: plan.included_credits || 0, integration_credits: plan.included_integration_credits || 0,
    period_key: cycleEnd, grant_expires_at: cycleEnd,
    idempotency_key: `period:${workspace_id}:free:${cycleEnd}`,
    payload_preview: "free plan period grant",
  });
}

export async function entitlementsFor(base44, workspace_id) {
  const sub = (await base44.entities.Subscription.filter({ workspace_id }, "-updated_date", 1))[0] || null;
  if (!sub) {
    const free = await getPlan(base44, "free");
    return { plan_code: free?.code || "free", status: "active", entitlements: free?.entitlements || {}, source: "default" };
  }
  const active = ["active", "trialing"].includes(sub.status);
  return {
    plan_code: sub.plan_code, status: sub.status,
    // A lapsed subscription loses its entitlements without losing already-purchased credits.
    entitlements: active ? sub.entitlements || {} : {},
    current_period_end: sub.current_period_end || null, source: "subscription",
  };
}