// Read-only background context for brief generation from the project's EXISTING MarketingPlan.
// Scoped strictly by the authorized project's id; nothing here is ever persisted on AdsBrief.
const cut = (v, n) => String(v || "").trim().slice(0, n);

export function buildPlanContext(plan) {
  if (!plan) return null;
  const google = (plan.channels || []).filter((c) => /google/i.test(String(c?.name || "")));
  const competitors = (plan.competitors || []).slice(0, 5)
    .map((c) => ({ name: cut(c?.name, 120), description: cut(c?.description, 300), market_gap: cut(c?.market_gap, 300) }))
    .filter((c) => c.name);
  const ctx = {
    strategy: cut(plan.strategy, 1500),
    market_gaps: competitors.map((c) => c.market_gap).filter(Boolean),
    google_tactics: google.map((c) => cut(c.tactics, 500)).filter(Boolean),
    competitors,
  };
  return ctx.strategy || ctx.google_tactics.length || ctx.competitors.length ? ctx : null;
}

export async function loadPlanContext(svc, projectId) {
  const rows = await svc.entities.MarketingPlan.filter({ project_id: projectId }, "-created_date", 1);
  return buildPlanContext(rows[0] || null);
}