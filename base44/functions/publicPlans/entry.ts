// Public price list for the marketing pricing page.
// No session, no body and no workspace context: it returns only publicly visible
// plan metadata (name, price, included credits, limits, entitlements).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { seedPlans, listPlans } from "../../shared/billing.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    await seedPlans(svc);
    const plans = await listPlans(svc, { includeHidden: false });
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
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}