// Focused certification for the 4 confirmed plan-parity gaps from the full plan audit. Drives the
// REAL plan/subscription resolution (effectivePlan) and the REAL BillingPlan rows (seedPlans) with
// DETERMINISTIC scratch workspaces — one per tier — so no real user/org/connection is ever created.
//
// Certified (the 4 assert helpers added to shared/planLimits.ts, which the entry/shared functions
// now call):
//   SSO  — Free/Starter/Builder/Pro/Elite → blocked (402 PLAN_SSO_NOT_INCLUDED);
//           Enterprise                    → unchanged (allowed, sso=true).
//   SCIM — Free/Starter/Builder/Pro/Elite → blocked (402 PLAN_SCIM_NOT_INCLUDED);
//           Enterprise             → unchanged (allowed, scim=true).
//   Audit — Free/Starter/Builder/Pro/Elite → blocked (402 PLAN_AUDIT_LOGS_NOT_INCLUDED);
//           Enterprise             → unchanged (allowed, audit_export=true).
//   Mobile store files — Free/Starter → blocked (402 PLAN_MOBILE_STORE_FILES_NOT_INCLUDED);
//           Builder/Pro/Elite/Enterprise → unchanged (allowed, tier_rank >= 6).
//   The helpers accept only (base44, workspace) — no client plan/entitlement input — so the verdict
//   is resolved SERVER-side only. All fixtures are scratch and removed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, purgeBy } from "../../shared/testHarness.ts";
import { seedPlans } from "../../shared/billing.ts";
import {
  assertSsoEntitlement, assertScimEntitlement, assertAuditExportEntitlement, assertMobileStoreFilesEntitlement,
} from "../../shared/planLimits.ts";

const stamp = Date.now();
const periodStart = new Date(stamp).toISOString();
const periodEnd = new Date(stamp + 30 * 86400000).toISOString();

// One tier per effective-plan code. `sub:false` means no Subscription row → effectivePlan resolves
// to the free plan. The expected verdicts mirror the EXISTING plan entitlement flags/tier_rank.
const TIERS = [
  { code: "free",            sub: false, sso: false, scim: false, audit: false, mobile: false },
  { code: "starter_monthly", sub: true,  sso: false, scim: false, audit: false, mobile: false },
  { code: "builder_monthly", sub: true,  sso: false, scim: false, audit: false, mobile: true },
  { code: "pro_monthly",     sub: true,  sso: false, scim: false, audit: false, mobile: true },
  { code: "scale_monthly",   sub: true,  sso: false, scim: false, audit: false, mobile: true }, // Elite
  { code: "scale_yearly",    sub: true,  sso: false, scim: false, audit: false, mobile: true }, // Elite (yearly)
  { code: "enterprise",     sub: true,  sso: true,  scim: true,  audit: true,  mobile: true },
];

const CODE = { sso: "PLAN_SSO_NOT_INCLUDED", scim: "PLAN_SCIM_NOT_INCLUDED", audit: "PLAN_AUDIT_LOGS_NOT_INCLUDED", mobile: "PLAN_MOBILE_STORE_FILES_NOT_INCLUDED" };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const workspaces = [];

  try {
    // Ensure the REAL BillingPlan rows exist so effectivePlan resolves each tier's real
    // entitlements/tier_rank (idempotent — a no-op when already seeded).
    await seedPlans(svc);

    for (const tier of TIERS) {
      const ws = await svc.entities.Workspace.create({ name: `planparity-${tier.code}-${stamp}`, owner_id: `planparity_${tier.code}_${stamp}` });
      workspaces.push(ws.id);
      if (tier.sub) {
        await svc.entities.Subscription.create({
          workspace_id: ws.id, plan_code: tier.code, status: "active",
          current_period_start: periodStart, current_period_end: periodEnd, provider: "manual",
        });
      }

      const check = async (label, fn, allowed, code) => {
        const r = await captureCall(() => fn(base44, ws));
        h.check(
          `[${tier.code}] ${label} ${allowed ? "allowed" : `blocked with 402 ${code}`}`,
          allowed ? !r.threw : (r.threw && Number(r.status) === 402 && r.code === code),
          JSON.stringify({ threw: r.threw, status: r.status, code: r.code }),
        );
      };

      await check("SSO", assertSsoEntitlement, tier.sso, CODE.sso);
      await check("SCIM", assertScimEntitlement, tier.scim, CODE.scim);
      await check("Audit logs", assertAuditExportEntitlement, tier.audit, CODE.audit);
      await check("Mobile store files", assertMobileStoreFilesEntitlement, tier.mobile, CODE.mobile);
    }

    // The verdict is resolved SERVER-side: each helper takes ONLY (base44, workspace) and reads
    // effectivePlan internally — a client cannot supply a plan/entitlement to authorize itself.
    h.check("server-side resolution: helpers accept no client plan/entitlement input",
      assertSsoEntitlement.length === 2 && assertScimEntitlement.length === 2 &&
      assertAuditExportEntitlement.length === 2 && assertMobileStoreFilesEntitlement.length === 2,
      "all four helpers take only (base44, workspace)");

    const s = h.summary();
    return Response.json({ ok: s.ok, passed: s.passed, failed: s.failed, failures: s.failures, results: s.results });
  } catch (error) {
    const s = h.summary();
    return Response.json({ ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400), passed: s.passed, failed: s.failed, failures: s.failures, results: s.results }, { status: 500 });
  } finally {
    for (const wid of workspaces) {
      await purgeBy(svc, "Subscription", { workspace_id: wid });
      await svc.entities.Workspace.delete(wid).catch(() => {});
    }
  }
}