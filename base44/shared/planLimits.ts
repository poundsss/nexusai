// Server-authoritative BillingPlan enforcement.
//
// The plan a workspace is on (its ACTIVE subscription's plan, or the free plan when it has none
// or the subscription lapsed) is the single source of every limit here. Nothing is cached, so a
// change to a BillingPlan row or a subscription takes effect on the very next request, and no
// limit value is ever taken from a client.
//
// Two kinds of limits are enforced:
//   • resource limits (limits.seats / projects / custom_domains) — counted against the
//     authenticated workspace and claimed through `createWithinLimit`, which is safe under
//     concurrency: a pre-check refuses the obvious case, and after the row is written the count
//     is re-derived; if racing writers pushed it past the limit the NEWEST rows back themselves
//     out, so every racer reaches the same verdict and the final count never exceeds the limit.
//   • usage limits (usage_limits.daily_credits / monthly_credits / credits_per_run / concurrent_runs) and the
//     overage policy — derived from the EXISTING AIOperation accounting (charged + reserved), so
//     there is no second ledger; the budget gate consults them before any reservation.
//
// Unlimited: a missing/null limit, or a negative number, means "no limit". Zero is a real limit.
import { getPlan, DEFAULT_PLANS } from "./billing.ts";
import { subscriptionFor } from "./subscriptions.ts";
import { creditTypeOf } from "./ledger.ts";

// Plan keys per credit pool. Message keeps the original key names, so existing plans and callers
// that pass no pool behave exactly as before; integration has its own, independent keys.
const POOL_KEYS = {
  message: { daily: "daily_credits", monthly: "monthly_credits", perRun: "credits_per_run", concurrent: "concurrent_runs", included: "included_credits" },
  integration: { daily: "daily_integration_credits", monthly: "monthly_integration_credits", perRun: "integration_credits_per_run", concurrent: "concurrent_integration_runs", included: "included_integration_credits" },
};

const svcOf = (base44) => base44.asServiceRole || base44;
const order = (a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id));
const sum = (xs) => Math.round(xs.reduce((n, v) => n + (Number(v) || 0), 0) * 1e6) / 1e6;

export class PlanLimitExceeded extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.code = "PLAN_LIMIT_REACHED";
    this.status = 402;
    this.detail = detail;
  }
}

export const limitValue = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
};

/** The plan whose limits govern this workspace right now. */
export async function effectivePlan(base44, workspace_id) {
  const svc = svcOf(base44);
  const subscription = await subscriptionFor(svc, workspace_id);
  const active = !!subscription && ["active", "trialing"].includes(subscription.status);
  const code = active ? subscription.plan_code : "free";
  const plan = (await getPlan(svc, code)) || (code !== "free" ? await getPlan(svc, "free") : null) || DEFAULT_PLANS.find((p) => p.code === "free");
  return { plan, subscription, active, source: active ? "subscription" : subscription ? "lapsed" : "default" };
}

export const resourceLimit = (plan, key) => limitValue(plan?.limits?.[key]);
export const usageLimit = (plan, key) => limitValue(plan?.usage_limits?.[key]);

/**
 * Concurrency-safe slot claim. `list` must return every row currently occupying the limited
 * resource (with created_date + id); `create` writes the new row; `undo` removes it.
 */
export async function createWithinLimit({ resource, plan, limit, list, create, undo }) {
  const refuse = (used) => new PlanLimitExceeded(
    `Plan "${plan.code}" allows ${limit} ${resource}; ${used} in use`,
    { resource, limit, used, plan_code: plan.code },
  );
  if (limit === null) return create();
  const before = await list();
  if (before.length >= limit) throw refuse(before.length);
  const row = await create();
  const after = await list();
  if (after.length > limit) {
    const losers = new Set([...after].sort(order).slice(limit).map((r) => r.id));
    if (losers.has(row.id)) {
      await undo(row);
      throw refuse(after.length - losers.size);
    }
  }
  return row;
}

// --- resource limits ---------------------------------------------------------

// Seats = the owner plus every member row that still claims a seat (active OR invited — a
// pending invitation reserves the seat it will occupy, so accepting it needs no re-check).
export async function createMemberWithinSeats(base44, workspace, data) {
  const svc = svcOf(base44);
  const { plan } = await effectivePlan(svc, workspace.id);
  const seats = resourceLimit(plan, "seats");
  return createWithinLimit({
    resource: "seats", plan, limit: seats === null ? null : Math.max(0, seats - 1),
    list: async () => (await svc.entities.WorkspaceMember.filter({ workspace_id: workspace.id }, "-created_date", 500)).filter((m) => m.status !== "removed"),
    create: () => svc.entities.WorkspaceMember.create({ ...data, workspace_id: workspace.id }),
    undo: (row) => svc.entities.WorkspaceMember.delete(row.id),
  });
}

export async function createProjectWithinLimit(base44, workspace, data) {
  const svc = svcOf(base44);
  const { plan } = await effectivePlan(svc, workspace.id);
  return createWithinLimit({
    resource: "projects", plan, limit: resourceLimit(plan, "projects"),
    list: () => svc.entities.Project.filter({ workspace_id: workspace.id }, "-created_date", 1000),
    create: () => svc.entities.Project.create({ ...data, workspace_id: workspace.id }),
    undo: (row) => svc.entities.Project.delete(row.id),
  });
}

export async function createDomainWithinLimit(base44, workspace, data) {
  const svc = svcOf(base44);
  const { plan } = await effectivePlan(svc, workspace.id);
  return createWithinLimit({
    resource: "custom domains", plan, limit: resourceLimit(plan, "custom_domains"),
    list: async () => (await svc.entities.CustomDomain.filter({ workspace_id: workspace.id }, "-created_date", 500)).filter((d) => d.status !== "removed"),
    create: () => svc.entities.CustomDomain.create({ ...data, workspace_id: workspace.id }),
    undo: (row) => svc.entities.CustomDomain.delete(row.id),
  });
}

// Virality social publishing entitlement (DOCUMENTED Base44: "Publishing requires a paid workspace
// plan"). The smallest ADAPT: a workspace is entitled when its effective plan is NOT the free plan
// and its subscription is active/trialing. No specific paid tier is invented — any non-free active
// plan qualifies. Resolved server-side from effectivePlan; a client-supplied plan/entitlement is
// never consulted. Free/non-entitled scheduling fails closed with 402 PLAN_PUBLISHING_NOT_INCLUDED
// at the start-scheduling choke point; create/approve/list stay ungated.
export async function assertViralityPublishEntitlement(base44, workspace) {
  const svc = svcOf(base44);
  const { plan, active } = await effectivePlan(svc, workspace.id);
  const entitled = !!(active && plan && plan.code !== "free");
  if (!entitled) {
    throw Object.assign(new Error("Publishing social posts requires a paid workspace plan."), { status: 402, code: "PLAN_PUBLISHING_NOT_INCLUDED" });
  }
}

// Security Scan code-vulnerability entitlement (DOCUMENTED Base44: "Code vulnerability scanning
// requires Builder or higher"). A non-throwing boolean resolved server-side from effectivePlan:
// the scan itself stays available on every plan, but static_code_findings is gated to Builder+.
// Builder is tier_rank 6 (builder_monthly/builder_yearly); any active plan at tier_rank >= 6
// qualifies, so Pro/Elite/Enterprise pass and Free(0)/Starter(3) do not. A lapsed subscription
// loses the entitlement. No client-supplied plan/flag is ever consulted.
// Platform Badge removal entitlement (DOCUMENTED Base44: "removing the badge is Starter+ gated").
// Starter is tier_rank 3 (starter_monthly/starter_yearly); any active plan at tier_rank >= 3
// qualifies, so Builder/Pro/Elite/Enterprise pass and Free(0) does not. A lapsed subscription
// loses the entitlement. Resolved server-side from effectivePlan; a client-supplied plan/flag is
// never consulted, and the published runtime re-checks it so a downgraded plan re-shows the badge.
export async function badgeRemovalEntitled(base44, workspace) {
  const { plan, active } = await effectivePlan(svcOf(base44), workspace.id);
  return !!(active && plan && Number(plan.tier_rank || 0) >= 3);
}

export async function staticCodeScanEntitled(base44, workspace) {
  const svc = svcOf(base44);
  const { plan, active } = await effectivePlan(svc, workspace.id);
  return !!(active && plan && Number(plan.tier_rank || 0) >= 6);
}

// Path-level 301 redirects are available on the same plans as custom domains (Starter+). The
// gate is the custom_domains entitlement: a plan with custom_domains = 0 does not include it.
// Listing redirects stays available without this gate; only writes (create/update/delete)
// require it. Resolved against the authorized workspace's effective plan, never a client claim.
export async function assertCustomDomainsEntitlement(base44, workspace) {
  const svc = svcOf(base44);
  const { plan } = await effectivePlan(svc, workspace.id);
  const limit = resourceLimit(plan, "custom_domains");
  if (limit === 0) {
    throw Object.assign(new Error("Page redirects require a plan that includes custom domains."), { status: 402, code: "PLAN_REDIRECTS_NOT_INCLUDED" });
  }
}

// Workspace SSO entitlement (DOCUMENTED Base44: workspace SSO is an Enterprise feature). Resolved
// SERVER-side from the EXISTING plan.entitlements.sso flag via effectivePlan — a client-supplied
// plan/entitlement is never consulted, and a lapsed subscription (active=false) loses the
// entitlement. Non-entitled workspaces fail closed with 402 PLAN_SSO_NOT_INCLUDED.
export async function assertSsoEntitlement(base44, workspace) {
  const svc = svcOf(base44);
  const { plan, active } = await effectivePlan(svc, workspace.id);
  const entitled = !!(active && plan && plan.entitlements && plan.entitlements.sso);
  if (!entitled) {
    throw Object.assign(new Error("Workspace SSO requires an Enterprise plan."), { status: 402, code: "PLAN_SSO_NOT_INCLUDED" });
  }
}

// SCIM provisioning entitlement (DOCUMENTED Base44: SCIM is an Enterprise feature). Resolved
// SERVER-side from the EXISTING plan.entitlements.scim flag. Non-entitled workspaces fail closed
// with 402 PLAN_SCIM_NOT_INCLUDED.
export async function assertScimEntitlement(base44, workspace) {
  const svc = svcOf(base44);
  const { plan, active } = await effectivePlan(svc, workspace.id);
  const entitled = !!(active && plan && plan.entitlements && plan.entitlements.scim);
  if (!entitled) {
    throw Object.assign(new Error("SCIM provisioning requires an Enterprise plan."), { status: 402, code: "PLAN_SCIM_NOT_INCLUDED" });
  }
}

// Workspace audit-log export entitlement (DOCUMENTED Base44: workspace audit logs are an
// Enterprise feature). Resolved SERVER-side from the EXISTING plan.entitlements.audit_export flag.
// Non-entitled workspaces fail closed with 402 PLAN_AUDIT_LOGS_NOT_INCLUDED. Applied to the
// audit-log read action only — DSR, abuse, breach, retention and general compliance stay ungated.
export async function assertAuditExportEntitlement(base44, workspace) {
  const svc = svcOf(base44);
  const { plan, active } = await effectivePlan(svc, workspace.id);
  const entitled = !!(active && plan && plan.entitlements && plan.entitlements.audit_export);
  if (!entitled) {
    throw Object.assign(new Error("Workspace audit logs require an Enterprise plan."), { status: 402, code: "PLAN_AUDIT_LOGS_NOT_INCLUDED" });
  }
}

// Mobile store-file generation/download entitlement (DOCUMENTED Base44: "to download the files for
// app submission you must be on the Builder plan or higher"). Builder is tier_rank 6; any active
// plan at tier_rank >= 6 qualifies, so Pro/Elite/Enterprise pass and Free(0)/Starter(3) do not. A
// lapsed subscription loses the entitlement. Resolved server-side from effectivePlan; no mobile
// daily quota is invented — the existing assertMobileBuildQuota handles per-day ceilings.
export async function assertMobileStoreFilesEntitlement(base44, workspace) {
  const svc = svcOf(base44);
  const { plan, active } = await effectivePlan(svc, workspace.id);
  const entitled = !!(active && plan && Number(plan.tier_rank || 0) >= 6);
  if (!entitled) {
    throw Object.assign(new Error("Mobile store-file generation requires a Builder plan or higher."), { status: 402, code: "PLAN_MOBILE_STORE_FILES_NOT_INCLUDED" });
  }
}

// --- deployments per day --------------------------------------------------------

// The plan's daily deployment window: the UTC day, the same clock the budget engine's daily
// period uses. A deployment request occupies a slot the moment its row exists — the
// deployment's eventual outcome (live, failed, cancelled) never frees the slot.
export const dayStartUtc = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString(); };

// Every deployment row this workspace created today, walking newest-first pages until the first
// row older than the window.
async function listTodaysDeployments(svc, workspace_id) {
  const since = dayStartUtc();
  const rows = [];
  for (let skip = 0; ; skip += 500) {
    const page = await svc.entities.Deployment.filter({ workspace_id }, "-created_date", 500, skip);
    const today = page.filter((d) => String(d.created_date) >= since);
    rows.push(...today);
    if (page.length < 500 || today.length < page.length) break;
  }
  return rows;
}

/** Early refusal for the daily deployment ceiling, before any request state is read or written. */
export async function assertDeploymentQuota(base44, workspace) {
  const svc = svcOf(base44);
  const { plan } = await effectivePlan(svc, workspace.id);
  const limit = resourceLimit(plan, "deployments_per_day");
  if (limit === null) return;
  const used = (await listTodaysDeployments(svc, workspace.id)).length;
  if (used >= limit) throw new PlanLimitExceeded(`Plan "${plan.code}" allows ${limit} deployments per day; ${used} already requested today`, { resource: "deployments per day", limit, used, plan_code: plan.code });
}

/** Concurrency-safe deployment create: the count is re-derived after the row exists, and racing
 *  requests that pushed it past the ceiling back the newest rows out (see createWithinLimit). */
export async function createDeploymentWithinLimit(base44, workspace, data) {
  const svc = svcOf(base44);
  const { plan } = await effectivePlan(svc, workspace.id);
  return createWithinLimit({
    resource: "deployments per day", plan, limit: resourceLimit(plan, "deployments_per_day"),
    list: () => listTodaysDeployments(svc, workspace.id),
    create: () => svc.entities.Deployment.create({ ...data, workspace_id: workspace.id }),
    undo: (row) => svc.entities.Deployment.delete(row.id),
  });
}

// --- mobile builds per day (P-10.3 phase 1) ------------------------------------

// The plan's daily mobile-build window: the same UTC day the deployment ceiling uses. A build
// request occupies a slot the moment its row exists — the build's eventual outcome (ready,
// failed, cancelled) never frees the slot.
async function listTodaysMobileBuilds(svc, workspace_id) {
  const since = dayStartUtc();
  const rows = [];
  for (let skip = 0; ; skip += 500) {
    const page = await svc.entities.MobileBuild.filter({ workspace_id }, "-created_date", 500, skip);
    const today = page.filter((b) => String(b.created_date) >= since);
    rows.push(...today);
    if (page.length < 500 || today.length < page.length) break;
  }
  return rows;
}

/** Early refusal for the daily mobile-build ceiling, before any request state is read or written. */
export async function assertMobileBuildQuota(base44, workspace) {
  const svc = svcOf(base44);
  const { plan } = await effectivePlan(svc, workspace.id);
  const limit = resourceLimit(plan, "mobile_builds_per_day");
  if (limit === null) return;
  const used = (await listTodaysMobileBuilds(svc, workspace.id)).length;
  if (used >= limit) throw new PlanLimitExceeded(`Plan "${plan.code}" allows ${limit} mobile builds per day; ${used} already requested today`, { resource: "mobile builds per day", limit, used, plan_code: plan.code });
}

/** Concurrency-safe mobile-build create: the count is re-derived after the row exists, and
 *  racing requests that pushed it past the ceiling back the newest rows out (see createWithinLimit). */
export async function createMobileBuildWithinLimit(base44, workspace, data) {
  const svc = svcOf(base44);
  const { plan } = await effectivePlan(svc, workspace.id);
  return createWithinLimit({
    resource: "mobile builds per day", plan, limit: resourceLimit(plan, "mobile_builds_per_day"),
    list: () => listTodaysMobileBuilds(svc, workspace.id),
    create: () => svc.entities.MobileBuild.create({ ...data, workspace_id: workspace.id }),
    undo: (row) => svc.entities.MobileBuild.delete(row.id),
  });
}

// --- usage limits & overage policy -------------------------------------------

const monthStart = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString(); };
export const isRunningOp = (o) => o.status === "running" && !o.finalized_at;
const settledSince = (ops, since) => sum(ops
  .filter((o) => ["completed", "refunded"].includes(o.status) && (!since || String(o.finalized_at || o.created_date) >= since))
  .map((o) => (Number(o.credits_charged) || 0) - (Number(o.credits_refunded) || 0)));
const heldBy = (o) => (isRunningOp(o) ? Number(o.credits_reserved) || 0 : ["completed", "refunded"].includes(o.status) ? (Number(o.credits_charged) || 0) - (Number(o.credits_refunded) || 0) : 0);

/** Plan usage as the EXISTING operation accounting sees it: settled charges plus in-flight holds. */
export async function planUsageState(base44, { workspace_id, run_id = null, credit_type = null }) {
  const svc = svcOf(base44);
  const { plan, subscription, active } = await effectivePlan(svc, workspace_id);
  // Pool-scoped: only operations of the same credit pool count against that pool's limits.
  const pool = creditTypeOf(credit_type);
  const keys = POOL_KEYS[pool];
  const ops = (await svc.entities.AIOperation.filter({ workspace_id }, "-created_date", 1000).catch(() => []))
    .filter((o) => creditTypeOf(o.credit_type) === pool);
  const running = ops.filter(isRunningOp);
  const reserved = sum(running.map((o) => o.credits_reserved));
  const month = monthStart();
  const periodStart = active && subscription?.current_period_start ? subscription.current_period_start : month;
  const policy = plan.overage_policy || "block";
  return {
    plan, running, credit_type: pool,
    // Daily window: the same UTC day the deployment ceiling and the budget engine's daily period
    // use. An absent daily limit (every paid plan) is unlimited.
    daily: { limit: usageLimit(plan, keys.daily), consumed: settledSince(ops, dayStartUtc()) + reserved },
    monthly: { limit: usageLimit(plan, keys.monthly), consumed: settledSince(ops, month) + reserved },
    perRun: { limit: usageLimit(plan, keys.perRun), consumed: run_id ? sum(ops.filter((o) => o.run_id === run_id).map(heldBy)) : 0 },
    concurrent: { limit: usageLimit(plan, keys.concurrent), running: running.length },
    // Overage = spending past the plan's included credits for the current period. `block` makes
    // that a hard ceiling; allow_overage / auto_topup leave the ledger balance as the only ceiling.
    included: { policy, limit: policy === "block" ? (limitValue(plan[keys.included]) ?? 0) : null, consumed: settledSince(ops, periodStart) + reserved },
  };
}

export function planUsageViolations(state, credits = 0) {
  const v = [];
  const over = (dim) => dim.limit !== null && dim.consumed + credits > dim.limit;
  if (over(state.perRun)) v.push({ scope: "plan_run", code: "PLAN_RUN_CREDITS_EXCEEDED", limit: state.perRun.limit, consumed: state.perRun.consumed, remaining: Math.max(0, state.perRun.limit - state.perRun.consumed), required: credits, plan_code: state.plan.code });
  if (over(state.daily)) v.push({ scope: "plan_daily", code: "PLAN_DAILY_CREDITS_EXCEEDED", limit: state.daily.limit, consumed: state.daily.consumed, remaining: Math.max(0, state.daily.limit - state.daily.consumed), required: credits, plan_code: state.plan.code });
  if (over(state.monthly)) v.push({ scope: "plan_monthly", code: "PLAN_MONTHLY_CREDITS_EXCEEDED", limit: state.monthly.limit, consumed: state.monthly.consumed, remaining: Math.max(0, state.monthly.limit - state.monthly.consumed), required: credits, plan_code: state.plan.code });
  if (state.concurrent.limit !== null && state.concurrent.running >= state.concurrent.limit) v.push({ scope: "plan_concurrency", code: "PLAN_CONCURRENT_RUNS_EXCEEDED", limit: state.concurrent.limit, consumed: state.concurrent.running, remaining: 0, required: 1, plan_code: state.plan.code });
  if (over(state.included)) v.push({ scope: "plan_included_credits", code: "OVERAGE_BLOCKED", limit: state.included.limit, consumed: state.included.consumed, remaining: Math.max(0, state.included.limit - state.included.consumed), required: credits, plan_code: state.plan.code, overage_policy: state.included.policy });
  return v;
}

// The strictest credit amount the plan still permits (null when the plan imposes none).
export function planSpendCeiling(state) {
  let ceiling = null;
  for (const dim of [state.perRun, state.daily, state.monthly, state.included]) {
    if (dim.limit === null) continue;
    const remaining = Math.max(0, dim.limit - dim.consumed);
    ceiling = ceiling === null ? remaining : Math.min(ceiling, remaining);
  }
  return ceiling;
}

/**
 * Post-create backstop for usage limits: racing operations can all pass the pre-check, so once
 * this operation's row exists the plan's ceilings are re-derived over every running operation
 * and the NEWEST excess ones are identified. Returns true when `operation` must back out.
 */
export async function operationExceedsPlanAfterCreate(base44, operation) {
  const state = await planUsageState(base44, { workspace_id: operation.workspace_id, run_id: operation.run_id || null, credit_type: operation.credit_type });
  const ordered = [...state.running].sort(order);
  if (!ordered.some((o) => o.id === operation.id)) return { exceeds: false, violations: [] };
  const losers = new Set();
  const violations = [];
  if (state.concurrent.limit !== null && ordered.length > state.concurrent.limit) {
    ordered.slice(state.concurrent.limit).forEach((o) => losers.add(o.id));
    violations.push({ scope: "plan_concurrency", code: "PLAN_CONCURRENT_RUNS_EXCEEDED", limit: state.concurrent.limit, consumed: ordered.length, required: 1, plan_code: state.plan.code });
  }
  const shed = (dim, rows, code, scope) => {
    if (dim.limit === null) return;
    let consumed = dim.consumed - sum(rows.filter((o) => losers.has(o.id)).map((o) => o.credits_reserved));
    for (let i = rows.length - 1; i >= 0 && consumed > dim.limit; i--) {
      if (losers.has(rows[i].id)) continue;
      losers.add(rows[i].id);
      consumed -= Number(rows[i].credits_reserved) || 0;
      violations.push({ scope, code, limit: dim.limit, consumed: dim.consumed, required: Number(rows[i].credits_reserved) || 0, plan_code: state.plan.code });
    }
  };
  shed(state.daily, ordered, "PLAN_DAILY_CREDITS_EXCEEDED", "plan_daily");
  shed(state.monthly, ordered, "PLAN_MONTHLY_CREDITS_EXCEEDED", "plan_monthly");
  shed(state.included, ordered, "OVERAGE_BLOCKED", "plan_included_credits");
  shed(state.perRun, ordered.filter((o) => (o.run_id || null) === (operation.run_id || null)), "PLAN_RUN_CREDITS_EXCEEDED", "plan_run");
  return { exceeds: losers.has(operation.id), violations };
}