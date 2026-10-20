// Subscription lifecycle: start, trial, upgrade, downgrade, cancel, resume, expire.
//
// Two rules shape everything here:
//   1. Credits only ever move through `processBillingEvent`, so every lifecycle action is
//      idempotent and auditable, and no path can hand out credits directly.
//   2. Direction is DERIVED from the plans' tier_rank, never taken from the caller: an upgrade
//      takes effect immediately, a downgrade is scheduled for period end so paid-for
//      entitlements are not removed mid-period.
import { getPlan, processBillingEvent, grantFreePeriodCredits, grantPeriodCredits, findCreditOption, resolveCreditOption } from "./billing.ts";
import { periodKeyFor } from "./paymentProviders.ts";
// Referral (Slice 3): the P-8.9 paid conversion of a running trial completes the first paid
// transition (the money arrived; this branch emits no billing event). Fail-safe below.
import { maybeGrantReferrerUpgradeReward } from "./referral.ts";

export class SubscriptionError extends Error {
  constructor(message, code = "SUBSCRIPTION_ERROR", status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

// P-8.4: plan-based MODEL ACCESS, resolved from the canonical subscription state — the single
// server-side truth for which models a workspace may execute.
export class ModelAccessError extends Error {
  constructor(message, code = "MODEL_NOT_ALLOWED_BY_PLAN", status = 403) {
    super(message); this.code = code; this.status = status; this.retryable = false;
  }
}

export const MODEL_ENTITLED_SUB_STATUSES = ["active", "trialing"];

/**
 * Resolves the workspace's model permissions BEFORE any model operation begins. The caller never
 * supplies the allowed set: client input (a preferred model, a declared agent tier, a quality
 * request) is only a preference honored WITHIN what this resolution allows.
 *
 * Fail-closed rules:
 *   • a workspace that is not active (suspended/terminated) → WORKSPACE_NOT_ENTITLED;
 *   • a subscription that is not active/trialing (past_due, cancelled, expired, incomplete) → WORKSPACE_NOT_ENTITLED;
 *   • a plan that cannot be resolved (unknown or inactive) → MODEL_ACCESS_UNKNOWN — unknown permissions never pass;
 *   • a model that cannot be identified (unknown to the catalog, no id or tier) → not allowed.
 */
export async function resolveModelAccess(base44, { workspace_id }) {
  if (!workspace_id) throw new ModelAccessError("resolveModelAccess: workspace_id is required", "MODEL_ACCESS_UNKNOWN", 400);
  const ws = await base44.entities.Workspace.get(workspace_id).catch(() => null);
  if (!ws || ws.status !== "active") {
    throw new ModelAccessError(`Workspace is ${ws?.status || "unavailable"}; model access is suspended`, "WORKSPACE_NOT_ENTITLED", 402);
  }
  const sub = await subscriptionFor(base44, workspace_id);
  if (sub && !MODEL_ENTITLED_SUB_STATUSES.includes(sub.status)) {
    throw new ModelAccessError(`Subscription is ${sub.status}; model access is suspended`, "WORKSPACE_NOT_ENTITLED", 402);
  }
  const plan = await getPlan(base44, sub?.plan_code || "free");
  if (!plan || plan.active === false) {
    throw new ModelAccessError(`Plan "${sub?.plan_code || "free"}" cannot be resolved; model access fails closed`, "MODEL_ACCESS_UNKNOWN", 403);
  }
  const allowed = (plan.model_access || []).map(String);
  const allows = (model) => {
    if (!allowed.length) return true;
    const id = model?.model_id || model?.id || null;
    const tier = model?.quality_tier || model?.tier || null;
    return Boolean((id && allowed.includes(id)) || (tier && allowed.includes(tier)));
  };
  return {
    plan_code: plan.code, restricted: allowed.length > 0, allowed, allows,
    // Hard fail-closed check for execution entry points (routing, gateway, beginOperation).
    check: (model) => {
      if (allows(model)) return model;
      throw new ModelAccessError(`Plan "${plan.code}" does not include model ${model?.model_id || model?.id || "unknown"}`);
    },
  };
}

export const subscriptionFor = async (base44, workspace_id) =>
  (await base44.entities.Subscription.filter({ workspace_id }, "-updated_date", 1))[0] || null;

const addInterval = (from, interval) => {
  const d = new Date(from);
  if (interval === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (interval === "one_time") return null;
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
};

// P-8.8: an option may only be NAMED by code — its amounts are resolved from the plan's own
// server-owned list, and an unknown name is refused before anything is granted.
function requireCreditOption(plan, code) {
  const option = findCreditOption(plan, code);
  if (!option) throw new SubscriptionError(`Unknown credit option "${code}" for plan "${plan.code}"`, "UNKNOWN_CREDIT_OPTION", 400);
  return option;
}
const optionSnapshot = (option) => ({ code: option.code, message_credits: option.message_credits, integration_credits: option.integration_credits });

async function requirePlan(base44, plan_code, { selfServe = false } = {}) {
  const plan = await getPlan(base44, plan_code);
  if (!plan || plan.active === false) throw new SubscriptionError(`Unknown plan "${plan_code}"`, "UNKNOWN_PLAN", 400);
  // Negotiated plans exist, but nobody can put themselves on one.
  if (selfServe && ["enterprise", "custom", "hidden"].includes(plan.visibility)) {
    throw new SubscriptionError(`Plan "${plan_code}" is not self-serve; contact sales`, "PLAN_NOT_SELF_SERVE", 403);
  }
  return plan;
}

/**
 * Starts (or restarts) a subscription. A plan with trial_days begins as `trialing` and grants its
 * trial credits exactly once — converting to paid later cannot re-grant them.
 */
export async function startSubscription(base44, { workspace_id, plan_code, provider = "manual", user_id = null, provider_subscription_id = null, provider_customer_id = null, trial = null, selfServe = true, credit_option_code = null, now = new Date() }) {
  const plan = await requirePlan(base44, plan_code, { selfServe });
  // P-8.8: a caller may only NAME a credit option; the amounts come from the plan row itself.
  const option = credit_option_code ? requireCreditOption(plan, credit_option_code) : null;
  const existing = await subscriptionFor(base44, workspace_id);
  const useTrial = trial === null ? (plan.trial_days || 0) > 0 && !existing?.trial_credits_granted : !!trial;
  const period_key = periodKeyFor(plan.interval, now);
  // Already entitled to this plan for this period: starting it again must not convert a running
  // trial into a paid period, and must not grant the plan's credits a second time. A newly
  // chosen credit option is still recorded, so it takes effect at the next renewal.
  if (existing && existing.plan_code === plan.code && ["active", "trialing"].includes(existing.status) && (existing.last_grant_period || null) === period_key) {
    // P-8.9: an explicit PAID start of a running trial converts it — the money arrived, so the
    // status flips to active without re-granting the period's already-settled credits.
    const converting = !useTrial && existing.status === "trialing";
    if (option || converting) {
      await base44.entities.Subscription.update(existing.id, {
        ...(option ? { selected_credit_option: optionSnapshot(option) } : {}),
        ...(converting ? { status: "active", trial_end: null } : {}),
      });
    }
    // Referral (Slice 3), fail-safe: the P-8.9 explicit PAID conversion of a running trial
    // completes the first paid transition — the money arrived, and this branch emits no billing
    // event of its own. Never breaks the conversion.
    if (converting) {
      try {
        await maybeGrantReferrerUpgradeReward(base44.asServiceRole || base44, { workspace_id, plan_code: plan.code });
      } catch {}
    }
    return { subscription: await subscriptionFor(base44, workspace_id), event: null, credits_applied: 0, duplicate: true, trial: converting ? false : existing.status === "trialing" };
  }
  const period_start = now.toISOString();
  const period_end = useTrial
    ? new Date(now.getTime() + (plan.trial_days || 0) * 86400000).toISOString()
    : addInterval(now, plan.interval);

  const res = await processBillingEvent(base44, {
    workspace_id, user_id, provider,
    event_type: useTrial ? "trial_started" : "subscription_started",
    amount_cents: useTrial ? 0 : plan.price_cents,
    credits: option ? option.message_credits : plan.included_credits || 0,
    integration_credits: option ? option.integration_credits : plan.included_integration_credits || 0,
    plan_code: plan.code, period_key, period_start, period_end,
    provider_subscription_id, provider_customer_id,
    // Keyed by plan + period, so a retried or duplicated start settles the same event.
    idempotency_key: `sub:${useTrial ? "trial" : "start"}:${workspace_id}:${plan.code}:${period_key}`,
  });
  const sub = await subscriptionFor(base44, workspace_id);
  if (sub && option) await base44.entities.Subscription.update(sub.id, { selected_credit_option: optionSnapshot(option) });
  if (sub && useTrial) await base44.entities.Subscription.update(sub.id, { trial_end: period_end, status: "trialing" });
  // A restart within an already-settled period is a duplicate money event, but the account must
  // still regain its entitlements — otherwise an expired subscription could never be revived
  // until the next period.
  else if (sub && res.duplicate && !["active", "trialing"].includes(sub.status)) {
    await base44.entities.Subscription.update(sub.id, { status: "active", plan_code: plan.code, entitlements: plan.entitlements || {}, cancel_at_period_end: false, cancelled_at: null, current_period_start: period_start, current_period_end: period_end });
  }
  return { subscription: await subscriptionFor(base44, workspace_id), event: res.event, credits_applied: res.credits_applied, duplicate: res.duplicate, trial: useTrial };
}

/**
 * Plan change (P-8.7 parity): BOTH directions take effect at the end of the current billing
 * cycle, through the EXISTING scheduled-plan mechanism — the current period's paid entitlements
 * and its already-granted credits are never touched mid-cycle, and the new plan's credits are
 * granted exactly once, at the cycle boundary, by applyScheduledChanges' period-keyed event. So
 * an upgrade can never stack a second full grant on top of the current cycle's. The direction is
 * still derived from the plans' tier_rank, but only for reporting and the UI. Re-selecting the
 * current plan cancels a pending scheduled change (and records a newly chosen credit option for
 * the next renewal).
 */
export async function changePlan(base44, { workspace_id, plan_code, user_id = null, selfServe = true, credit_option_code = null, now = new Date() }) {
  const sub = await subscriptionFor(base44, workspace_id);
  if (!sub) return { ...(await startSubscription(base44, { workspace_id, plan_code, user_id, selfServe, credit_option_code, now })), direction: "start" };
  const target = await requirePlan(base44, plan_code, { selfServe });
  const currentPlan = await getPlan(base44, sub.plan_code);
  // P-8.8: an option may only be NAMED — its amounts are resolved from the target plan's list.
  const option = credit_option_code ? requireCreditOption(target, credit_option_code) : null;

  if (target.code === sub.plan_code) {
    if (!sub.scheduled_plan_code && !option) return { subscription: sub, direction: "unchanged", credits_applied: 0, duplicate: true };
    const updated = await base44.entities.Subscription.update(sub.id, {
      scheduled_plan_code: null, scheduled_change_at: null,
      ...(option ? { selected_credit_option: optionSnapshot(option) } : {}),
    });
    return { subscription: updated, direction: "unchanged", credits_applied: 0, option_updated: !!option };
  }

  const direction = (target.tier_rank || 0) >= (currentPlan?.tier_rank || 0) ? "upgrade" : "downgrade";
  // Nothing is credited or revoked yet — in EITHER direction: the account keeps exactly what it
  // paid for until the period ends, and the boundary grant lands once, period-keyed.
  const effective = sub.current_period_end || addInterval(now, currentPlan?.interval || "monthly");
  const updated = await base44.entities.Subscription.update(sub.id, {
    scheduled_plan_code: target.code, scheduled_change_at: effective, previous_plan_code: sub.plan_code,
    ...(option ? { selected_credit_option: optionSnapshot(option) } : {}),
  });
  return { subscription: updated, direction, scheduled_for: effective, credits_applied: 0 };
}

/**
 * Cancellation. By default it is scheduled for period end (entitlements continue); `immediate`
 * ends entitlements now. Purchased credits are never taken away by a cancellation.
 */
export async function cancelSubscription(base44, { workspace_id, user_id = null, immediate = false, reason = null }) {
  const sub = await subscriptionFor(base44, workspace_id);
  if (!sub) throw new SubscriptionError("No subscription to cancel", "NO_SUBSCRIPTION", 404);
  if (immediate) {
    const res = await processBillingEvent(base44, {
      workspace_id, user_id, provider: sub.provider || "manual", event_type: "subscription_cancelled",
      plan_code: sub.plan_code, idempotency_key: `sub:cancel:${workspace_id}:${sub.plan_code}:${Date.now()}`,
      payload_preview: reason ? String(reason).slice(0, 200) : null,
    });
    return { subscription: await subscriptionFor(base44, workspace_id), immediate: true, event: res.event };
  }
  const updated = await base44.entities.Subscription.update(sub.id, { cancel_at_period_end: true, cancelled_at: new Date().toISOString() });
  return { subscription: updated, immediate: false, ends_at: sub.current_period_end || null };
}

// Resume: only meaningful while the paid period is still running and the cancellation has not
// taken effect yet. A subscription that already expired must be started again, not resumed.
export async function resumeSubscription(base44, { workspace_id, user_id = null }) {
  const sub = await subscriptionFor(base44, workspace_id);
  if (!sub) throw new SubscriptionError("No subscription to resume", "NO_SUBSCRIPTION", 404);
  if (["expired", "cancelled"].includes(sub.status)) throw new SubscriptionError("This subscription has ended; start a new one", "SUBSCRIPTION_ENDED", 409);
  if (!sub.cancel_at_period_end) return { subscription: sub, resumed: false };
  const res = await processBillingEvent(base44, {
    workspace_id, user_id, provider: sub.provider || "manual", event_type: "subscription_resumed",
    plan_code: sub.plan_code, cancel_at_period_end: false,
    idempotency_key: `sub:resume:${workspace_id}:${sub.plan_code}:${sub.current_period_end || "open"}`,
  });
  return { subscription: await subscriptionFor(base44, workspace_id), resumed: true, event: res.event };
}

/**
 * Period roll-over, safe to run repeatedly (scheduler or on-read):
 *   • a scheduled plan change (downgrade or upgrade — P-8.7) past its date takes effect,
 *   • a cancel-at-period-end past its date expires,
 *   • a finished trial that was never paid becomes past_due rather than silently staying active,
 *   • an ACTIVE subscription whose paid period ended — with no pending cancellation and no
 *     scheduled change — automatically renews into its next cycle (P-9), provider-agnostically.
 * Every credit grant it performs is period-keyed, so running it twice grants once.
 */
export async function applyScheduledChanges(base44, { workspace_id, now = new Date() }) {
  const sub = await subscriptionFor(base44, workspace_id);
  // Free period grant: a workspace with no subscription is on Free. Period-keyed, so this is
  // safe on every read.
  if (!sub) {
    await grantFreePeriodCredits(base44, { workspace_id, period_key: periodKeyFor("monthly", now) });
    return { changed: false };
  }
  const t = now.getTime();
  const due = (iso) => iso && new Date(iso).getTime() <= t;

  if (sub.scheduled_plan_code && due(sub.scheduled_change_at)) {
    const target = await getPlan(base44, sub.scheduled_plan_code);
    if (target) {
      // P-8.8: a stored selection is re-validated against the TARGET plan's own list — an option
      // that does not exactly belong to it grants the target's defaults, never a client value.
      const option = sub.selected_credit_option ? resolveCreditOption(target, sub.selected_credit_option) : null;
      const period_key = periodKeyFor(target.interval, now);
      const res = await processBillingEvent(base44, {
        workspace_id, provider: sub.provider || "manual", event_type: "subscription_renewed",
        amount_cents: target.price_cents, credits: option ? option.message_credits : target.included_credits || 0, integration_credits: option ? option.integration_credits : target.included_integration_credits || 0, plan_code: target.code,
        period_key, period_start: now.toISOString(), period_end: addInterval(now, target.interval),
        idempotency_key: `sub:scheduled:${workspace_id}:${target.code}:${period_key}`,
      });
      await base44.entities.Subscription.update(sub.id, { scheduled_plan_code: null, scheduled_change_at: null, previous_plan_code: sub.plan_code });
      // The billing event anchors downstream audits (scheduled maintenance) exactly like commerce's.
      return { changed: true, action: "downgrade_applied", plan_code: target.code, event: res.event };
    }
  }

  // Status is the lock (like the trial branch): an already-expired subscription stays expired, so
  // a repeated sweep — or one racing the on-read path — reports no transition a second time.
  if (sub.cancel_at_period_end && sub.status !== "expired" && due(sub.current_period_end)) {
    await base44.entities.Subscription.update(sub.id, { status: "expired" });
    return { changed: true, action: "expired" };
  }

  if (sub.status === "trialing" && due(sub.trial_end)) {
    await base44.entities.Subscription.update(sub.id, { status: "past_due" });
    return { changed: true, action: "trial_ended" };
  }

  // Automatic renewal (P-9): an ACTIVE subscription whose paid period has ended — with no pending
  // cancellation and no scheduled plan change — rolls into the next billing cycle on its own
  // anchor, provider-agnostically: the manual provider renews exactly like a paid provider
  // webhook (invoice.paid → subscription_renewed) would, and the grant itself goes through the
  // canonical period path (grantPeriodCredits) — never a parallel credit route.
  if (sub.status === "active" && !sub.cancel_at_period_end && !sub.scheduled_plan_code && due(sub.current_period_end)) {
    const plan = await getPlan(base44, sub.plan_code);
    // Only a resolvable, active, recurring plan can renew. Anything else leaves the state
    // untouched for the operator — renewal never invents a plan it cannot price.
    if (plan && plan.active !== false && plan.interval !== "one_time" && sub.current_period_start) {
      // The new cycle is the one CONTAINING now, derived by forward-stepping the subscription's
      // own anchor with the same interval arithmetic the cycle machinery uses: missed maintenance
      // never grants already-expired cycles, never double-rolls, and the boundary is
      // deterministic from the anchor alone (P-8.2 anchoring preserved).
      let prev = Date.parse(sub.current_period_start);
      let cur = prev;
      let guard = 0;
      while (cur <= t && guard++ < 2400) {
        prev = cur;
        cur = Date.parse(addInterval(cur, plan.interval) || "");
      }
      if (Number.isFinite(cur) && cur > t) {
        const period_start = new Date(prev).toISOString();
        const period_end = new Date(cur).toISOString();
        // Grant first, roll second: if the roll fails, the next sweep recomputes the SAME cycle
        // (same anchor, same period key) and the canonical idempotency settles it as a duplicate
        // instead of granting twice. The period key IS the new cycle's end, so one cycle can never
        // produce two grants however often maintenance re-runs.
        const res = await grantPeriodCredits(base44, {
          workspace_id, plan_code: plan.code, period_key: period_end, period_start,
          provider: sub.provider || "manual",
        });
        await base44.entities.Subscription.update(sub.id, { current_period_start: period_start, current_period_end: period_end });
        return { changed: true, action: "renewed", plan_code: plan.code, event: res.event, duplicate: res.duplicate };
      }
    }
  }
  return { changed: false };
}

// Model access check, enforced server-side from the plan record (never from the UI's selection).
// Now derived from the SAME resolveModelAccess truth every execution entry point uses, so a
// read-side check and a run-time enforcement can never disagree.
export async function planAllowsModel(base44, { workspace_id, model }) {
  try {
    const access = await resolveModelAccess(base44, { workspace_id });
    const ok = access.allows(model);
    return { ok, reason: ok ? null : `Plan "${access.plan_code}" does not include model ${model?.model_id || model?.id || "unknown"}` };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

// P-16C1 (documented Base44): choosing an AI model manually requires a Builder plan or
// higher — below it, Auto only. Derived from the SAME canonical subscription state as model
// access, so the read-side gate and the enqueue-time enforcement can never disagree.
export const MODEL_SELECTION_MIN_TIER_RANK = 6;
export async function resolveModelSelection(base44, { workspace_id }) {
  const ws = await base44.entities.Workspace.get(workspace_id).catch(() => null);
  if (!ws || ws.status !== "active") return { ok: false, tier_rank: 0, plan_code: null };
  const sub = await subscriptionFor(base44, workspace_id);
  const plan = await getPlan(base44, sub?.plan_code || "free");
  const tier_rank = Number(plan?.tier_rank) || 0;
  return { ok: tier_rank >= MODEL_SELECTION_MIN_TIER_RANK, tier_rank, plan_code: plan?.code || "free" };
}

export async function billingOverview(base44, workspace_id) {
  const sub = await subscriptionFor(base44, workspace_id);
  const plan = await getPlan(base44, sub?.plan_code || "free");
  return {
    subscription: sub ? {
      plan_code: sub.plan_code, status: sub.status, provider: sub.provider,
      current_period_start: sub.current_period_start || null, current_period_end: sub.current_period_end || null,
      trial_end: sub.trial_end || null, cancel_at_period_end: !!sub.cancel_at_period_end,
      scheduled_plan_code: sub.scheduled_plan_code || null, scheduled_change_at: sub.scheduled_change_at || null,
      entitlements: ["active", "trialing"].includes(sub.status) ? sub.entitlements || {} : {},
    } : null,
    plan: plan ? { code: plan.code, name: plan.name, price_cents: plan.price_cents, currency: plan.currency, interval: plan.interval, included_credits: plan.included_credits, included_integration_credits: plan.included_integration_credits, limits: plan.limits || {}, usage_limits: plan.usage_limits || {}, overage_policy: plan.overage_policy, model_access: plan.model_access || [], tier_rank: plan.tier_rank, entitlements: plan.entitlements || {} } : null,
  };
}