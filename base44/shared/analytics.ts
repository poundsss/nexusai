// Usage accounting.
//
// One derivation, two audiences. `scope: "user"` returns tokens, credits and counts — what a
// customer is entitled to see. `scope: "admin"` additionally returns real provider cost and
// margin. Provider economics are never included in a user-scoped response, and every query is
// filtered by workspace so no aggregate can span accounts.

import { deriveBalance } from "./ledger.ts";

const PAGE = 500;

async function loadOperations(base44, query, { limit = 2000 } = {}) {
  const out = [];
  for (let skip = 0; skip < limit; skip += PAGE) {
    const page = await base44.entities.AIOperation.filter(query, "-created_date", PAGE, skip);
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const bump = (map, key, op, admin) => {
  const b = map.get(key) || { key, operations: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_tokens: 0, total_tokens: 0, credits: 0, refunded: 0, failed: 0, ...(admin ? { provider_cost: 0 } : {}) };
  b.operations++;
  b.input_tokens += op.input_tokens || 0;
  b.output_tokens += op.output_tokens || 0;
  b.cached_input_tokens += op.cached_input_tokens || 0;
  b.reasoning_tokens += op.reasoning_tokens || 0;
  b.total_tokens += op.total_tokens || 0;
  b.credits += op.credits_charged || 0;
  b.refunded += op.credits_refunded || 0;
  if (op.status === "failed" || op.status === "cancelled") b.failed++;
  if (admin) b.provider_cost = Math.round((b.provider_cost + (op.provider_cost || 0)) * 1e6) / 1e6;
  map.set(key, b);
  return b;
};

const toList = (map) => [...map.values()].sort((a, b) => b.credits - a.credits || b.operations - a.operations);

export async function usageSummary(base44, { workspace_id, project_id = null, user_id = null, since = null, until = null, scope = "user", limit = 2000 } = {}) {
  if (!workspace_id) throw new Error("usageSummary: workspace_id is required");
  const admin = scope === "admin";
  const query = { workspace_id };
  if (project_id) query.project_id = project_id;
  if (user_id) query.user_id = user_id;
  const ops = (await loadOperations(base44, query, { limit })).filter((o) => {
    const t = String(o.finalized_at || o.created_date);
    return (!since || t >= since) && (!until || t <= until);
  });

  const byModel = new Map(), byProvider = new Map(), byProject = new Map(), byUser = new Map(), byType = new Map(), byDay = new Map();
  const totals = { operations: 0, completed: 0, failed: 0, refunded_operations: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, credits: 0, refunded_credits: 0, ...(admin ? { provider_cost: 0, margin: 0, margin_pct: 0 } : {}) };

  for (const op of ops) {
    totals.operations++;
    if (op.status === "completed") totals.completed++;
    if (op.status === "failed" || op.status === "cancelled") totals.failed++;
    if ((op.credits_refunded || 0) > 0) totals.refunded_operations++;
    totals.input_tokens += op.input_tokens || 0;
    totals.cached_input_tokens += op.cached_input_tokens || 0;
    totals.output_tokens += op.output_tokens || 0;
    totals.reasoning_tokens += op.reasoning_tokens || 0;
    totals.total_tokens += op.total_tokens || 0;
    totals.credits += op.credits_charged || 0;
    totals.refunded_credits += op.credits_refunded || 0;
    if (admin) totals.provider_cost = Math.round((totals.provider_cost + (op.provider_cost || 0)) * 1e6) / 1e6;
    bump(byModel, op.model_id || "unknown", op, admin);
    bump(byProvider, op.provider || "unknown", op, admin);
    if (op.project_id) bump(byProject, op.project_id, op, admin);
    if (op.user_id) bump(byUser, op.user_id, op, admin);
    bump(byType, op.operation_type || "other", op, admin);
    bump(byDay, String(op.finalized_at || op.created_date).slice(0, 10), op, admin);
  }

  if (admin) {
    // Credits are a unit, provider cost is money: convert credits back through the platform
    // rate so margin compares like with like.
    const revenue = totals.credits / 100;
    totals.margin = Math.round((revenue - totals.provider_cost) * 1e6) / 1e6;
    totals.margin_pct = revenue > 0 ? Math.round((totals.margin / revenue) * 1000) / 10 : 0;
  }

  const routing_decisions = ops.filter((o) => o.routing?.strategy).map((o) => ({ model_id: o.model_id, strategy: o.routing.strategy, reason: o.routing.reason, credits: admin ? o.credits_charged : undefined }));

  return {
    scope, totals,
    by_model: toList(byModel), by_provider: toList(byProvider), by_project: toList(byProject),
    by_user: toList(byUser), by_operation_type: toList(byType),
    by_day: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    routing_decisions: routing_decisions.slice(0, 100),
    balance: await deriveBalance(base44, workspace_id),
  };
}

// Recent operations for a UI list. User scope never carries provider cost.
export async function recentOperations(base44, { workspace_id, project_id = null, user_id = null, limit = 25, scope = "user" }) {
  const query = { workspace_id };
  if (project_id) query.project_id = project_id;
  if (user_id) query.user_id = user_id;
  const ops = await base44.entities.AIOperation.filter(query, "-created_date", limit);
  return ops.map((o) => ({
    id: o.id, operation_type: o.operation_type, model_id: o.model_id, status: o.status,
    total_tokens: o.total_tokens, credits_charged: o.credits_charged, credits_refunded: o.credits_refunded,
    usage_source: o.usage_source, project_id: o.project_id, run_id: o.run_id,
    created_date: o.created_date, finalized_at: o.finalized_at,
    ...(scope === "admin" ? { provider: o.provider, provider_cost: o.provider_cost, pricing_version: o.pricing_version, routing: o.routing } : {}),
  }));
}