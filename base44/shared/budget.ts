// Budget control across workspace / user / project / run / operation.
//
// Limits are evaluated server-side BEFORE execution and again at reconciliation. Every scope
// that has a limit applies simultaneously and the tightest one wins, so a generous workspace
// limit can never widen a tight project limit — and retries, reconnects, alternate routes and
// parallel requests all pass through this same gate, which is why none of them can be used to
// bypass a budget.

import { deriveBalance, InsufficientCredits, creditTypeOf, type CreditType } from "./ledger.ts";
// BillingPlan usage ceilings and overage policy join the same gate, derived from the same
// operation accounting — so a plan limit is enforced exactly where credits are.
import { planUsageState, planUsageViolations, planSpendCeiling, operationExceedsPlanAfterCreate } from "./planLimits.ts";

export class BudgetExceeded extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.code = "BUDGET_EXCEEDED";
    this.status = 402;
    this.detail = detail;
  }
}

const periodStart = (period) => {
  const now = new Date();
  if (period === "daily") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  if (period === "monthly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  return null;
};

export async function loadBudgets(base44, { workspace_id, user_id = null, project_id = null, run_id = null }) {
  const rows = await base44.entities.Budget.filter({ workspace_id, active: true }, "-updated_date", 200).catch(() => []);
  return rows.filter((b) => {
    if (b.scope === "workspace") return true;
    if (b.scope === "user") return user_id && b.scope_id === user_id;
    if (b.scope === "project") return project_id && b.scope_id === project_id;
    if (b.scope === "run") return run_id && b.scope_id === run_id;
    if (b.scope === "operation") return true;
    return false;
  });
}

// Credits actually consumed inside a scope. Derived from finalized operations, so it can never
// drift from what was charged.
// With `creditType`, only that pool's operations count; omitted, every pool counts (combined).
export async function consumedInScope(base44, budget, { workspace_id, user_id, project_id, run_id }, creditType?: CreditType) {
  const query = { workspace_id, status: "completed" };
  if (budget.scope === "user") query.user_id = budget.scope_id || user_id;
  if (budget.scope === "project") query.project_id = budget.scope_id || project_id;
  if (budget.scope === "run") query.run_id = budget.scope_id || run_id;
  const ops = await base44.entities.AIOperation.filter(query, "-created_date", 1000).catch(() => []);
  const since = periodStart(budget.period);
  return ops
    .filter((o) => !since || String(o.finalized_at || o.created_date) >= since)
    .filter((o) => !creditType || creditTypeOf(o.credit_type) === creditType)
    .reduce((n, o) => n + (Number(o.credits_charged) || 0), 0);
}

/**
 * Can this scope afford `credits` right now?
 * Returns every violated limit rather than the first, so the caller can explain the refusal
 * and (where policy allows) fall back to a cheaper compatible model.
 */
export async function checkBudget(base44, { workspace_id, user_id = null, project_id = null, run_id = null, credits = 0 }, creditType?: CreditType) {
  const totals = await deriveBalance(base44, workspace_id, creditType);
  const violations = [];
  if (credits > totals.available) {
    violations.push({ scope: "credits", limit: totals.available, consumed: 0, remaining: totals.available, required: credits, code: "INSUFFICIENT_CREDITS" });
  }
  for (const b of await loadBudgets(base44, { workspace_id, user_id, project_id, run_id })) {
    if (b.scope === "operation") {
      if (credits > b.limit_credits) violations.push({ scope: "operation", limit: b.limit_credits, consumed: 0, remaining: b.limit_credits, required: credits, code: "OPERATION_BUDGET_EXCEEDED" });
      continue;
    }
    const consumed = await consumedInScope(base44, b, { workspace_id, user_id, project_id, run_id }, creditType);
    const remaining = b.limit_credits - consumed;
    if (credits > remaining) {
      violations.push({ scope: b.scope, period: b.period, limit: b.limit_credits, consumed, remaining, required: credits, code: `${b.scope.toUpperCase()}_BUDGET_EXCEEDED` });
    }
  }
  // Plan-level ceilings (usage_limits + overage_policy), authoritative and read fresh each call.
  violations.push(...planUsageViolations(await planUsageState(base44, { workspace_id, run_id, credit_type: creditType }), credits));
  return { ok: violations.length === 0, violations, available: totals.available, balance: totals.balance, reserved: totals.reserved };
}

/**
 * Concurrency backstop for plan usage limits, called right after an operation row is written and
 * BEFORE its reservation: racing operations that all passed the pre-check are re-counted, and an
 * operation the plan cannot accommodate is finalized as failed (it never held credits) and refused.
 */
export async function enforcePlanUsageAfterCreate(base44, operation) {
  const { exceeds, violations } = await operationExceedsPlanAfterCreate(base44, operation);
  if (!exceeds) return;
  await base44.entities.AIOperation.update(operation.id, {
    status: "failed", credits_reserved: 0, finalized_at: new Date().toISOString(),
    error: `Refused by plan limit under concurrency: ${violations.map((v) => v.code).join(", ")}`,
  });
  const v = violations[0];
  throw new BudgetExceeded(`${v.scope} limit exceeded under concurrency: ${v.consumed}/${v.limit}`, { violations });
}

// The strictest amount this scope may still spend — the ceiling a cheaper-model fallback has
// to fit under.
export async function spendableCredits(base44, { workspace_id, user_id = null, project_id = null, run_id = null }, creditType?: CreditType) {
  const totals = await deriveBalance(base44, workspace_id, creditType);
  let ceiling = totals.available;
  for (const b of await loadBudgets(base44, { workspace_id, user_id, project_id, run_id })) {
    const remaining = b.scope === "operation" ? b.limit_credits : b.limit_credits - (await consumedInScope(base44, b, { workspace_id, user_id, project_id, run_id }, creditType));
    ceiling = Math.min(ceiling, Math.max(0, remaining));
  }
  const planCeiling = planSpendCeiling(await planUsageState(base44, { workspace_id, run_id, credit_type: creditType }));
  if (planCeiling !== null) ceiling = Math.min(ceiling, planCeiling);
  return Math.max(0, Math.round(ceiling * 1e6) / 1e6);
}

export function assertBudget(result, { credits }) {
  if (result.ok) return;
  const insufficient = result.violations.find((v) => v.code === "INSUFFICIENT_CREDITS");
  if (insufficient) throw new InsufficientCredits(`Insufficient credits: ${result.available} available, ${credits} required`, insufficient);
  const v = result.violations[0];
  throw new BudgetExceeded(`${v.scope} budget exceeded: ${v.consumed}/${v.limit} credits used, ${credits} more required`, { violations: result.violations });
}