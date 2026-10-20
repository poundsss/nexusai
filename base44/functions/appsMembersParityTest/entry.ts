// P-8.4 + P-8.5 — Base44 Plan Limits Parity: unlimited apps on paid plans, unlimited workspace
// members on every plan (Free included). Free keeps its 5-app ceiling with the EXISTING
// enforcement; the "absent limit = unlimited" contract does all the work — no enforcement code
// changed. Prices, credits, usage limits and every other limit are asserted unchanged.
// RBAC/roles/permissions are not touched here — the rbacTest suite covers them.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";
import { seedPlans, getPlan } from "../../shared/billing.ts";
import { createMemberWithinSeats, effectivePlan } from "../../shared/planLimits.ts";
import { createProjectForUser } from "../../shared/projectCreate.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check, expectThrow } = h;
  const stamp = Date.now();
  const created = { plans: [], workspaces: [] };
  const seedProject = (ws, i) => svc.entities.Project.create({ workspace_id: ws.id, name: `seed_${i}_${stamp}`, framework: "preact-htm", status: "draft", version_count: 1 });
  const projectCount = async (ws) => (await svc.entities.Project.filter({ workspace_id: ws.id }, "-created_date", 100)).length;

  try {
    // 0. Catalog parity --------------------------------------------------------------
    await seedPlans(svc);
    const free = await getPlan(svc, "free");
    const starter = await getPlan(svc, "starter_monthly");
    const builder = await getPlan(svc, "builder_monthly");
    const pro = await getPlan(svc, "pro_monthly");
    const scale = await getPlan(svc, "scale_monthly");
    check("0. free plan keeps exactly the 5-app ceiling", free?.limits?.projects === 5, JSON.stringify(free?.limits));
    check("0. seats removed from every plan's limits and entitlements",
      [free, starter, builder, pro, scale].every((p) => p && p.limits?.seats === undefined && p.entitlements?.seats === undefined),
      [free, starter, builder, pro, scale].map((p) => ({ code: p?.code, seats: p?.limits?.seats })));
    check("0. paid plans carry no projects limit (limits or entitlements)",
      [starter, builder, pro, scale].every((p) => p && p.limits?.projects === undefined && p.entitlements?.projects === undefined),
      [starter, builder, pro, scale].map((p) => ({ code: p?.code, projects: p?.limits?.projects })));
    check("0. no side effects: prices, credits, usage limits and other limits unchanged",
      free?.price_cents === 0 && free?.included_credits === 25 && free?.included_integration_credits === 100 &&
      free?.usage_limits?.daily_credits === 5 && free?.usage_limits?.monthly_credits === 25 &&
      starter?.price_cents === 2000 && starter?.included_credits === 100 && starter?.limits?.custom_domains === 1 && starter?.limits?.deployments_per_day === 20 &&
      builder?.price_cents === 5000 && builder?.included_credits === 250 && builder?.limits?.custom_domains === 2 &&
      pro?.price_cents === 10000 && pro?.usage_limits?.monthly_credits === 20000 &&
      scale?.price_cents === 20000 && scale?.limits?.custom_domains === 25,
      { free: free?.usage_limits, starter: starter?.limits, builder: builder?.limits, pro: pro?.usage_limits, scale: scale?.limits });

    // 1. Free: maximum 5 apps, existing enforcement untouched --------------------------
    const freeWs = await makeBillingWorkspace(svc, created, "appsfree", { plan: null }, stamp);
    for (let i = 0; i < 4; i++) await seedProject(freeWs.ws, i);
    const fifth = await createProjectForUser(svc, freeWs.user, { workspace_id: freeWs.ws.id, name: "Fifth" });
    check("1. free plan: the 5th app is allowed", !!fifth.project, fifth.error?.message || "created");
    await expectThrow("1. free plan: the 6th app is refused by the existing enforcement",
      () => createProjectForUser(svc, freeWs.user, { workspace_id: freeWs.ws.id, name: "Sixth" }), "PLAN_LIMIT_REACHED");
    check("1. free plan: exactly 5 projects remain", (await projectCount(freeWs.ws)) === 5, `${await projectCount(freeWs.ws)} project(s)`);

    // 2. Paid: apps are not limited by any plan ceiling --------------------------------
    const starterWs = await makeBillingWorkspace(svc, created, "appspaid", { plan: starter }, stamp);
    for (let i = 0; i < 10; i++) await seedProject(starterWs.ws, i);   // the old Starter ceiling was 10
    const eleventh = await createProjectForUser(svc, starterWs.user, { workspace_id: starterWs.ws.id, name: "Eleventh" });
    check("2. paid plan: the 11th app passes with no plan ceiling",
      !!eleventh.project && (await projectCount(starterWs.ws)) === 11, `${await projectCount(starterWs.ws)} project(s)`);

    // 3. Members unlimited on Free (the old Free seat limit was 1) ---------------------
    const freeMembers = await makeBillingWorkspace(svc, created, "memfree", { plan: null }, stamp);
    const invitedFree = [];
    for (let i = 1; i <= 3; i++) {
      invitedFree.push(await createMemberWithinSeats(svc, freeMembers.ws, { email: `m${i}-${stamp}@example.com`, role: "viewer", status: "invited", invite_token: `t${i}${stamp}` }));
    }
    check("3. free plan: 3 members beyond the old single seat are allowed",
      invitedFree.length === 3 && invitedFree.every(Boolean), `${invitedFree.filter(Boolean).length} member(s)`);

    // 4. Members unlimited on paid (the old Starter seat limit was 1) ------------------
    const paidMembers = await makeBillingWorkspace(svc, created, "mempaid", { plan: starter }, stamp);
    const invitedPaid = [];
    for (let i = 1; i <= 2; i++) {
      invitedPaid.push(await createMemberWithinSeats(svc, paidMembers.ws, { email: `p${i}-${stamp}@example.com`, role: "editor", status: "invited", invite_token: `pt${i}${stamp}` }));
    }
    check("4. paid plan: members beyond the old seat limit are allowed",
      invitedPaid.length === 2 && invitedPaid.every(Boolean), `${invitedPaid.filter(Boolean).length} member(s)`);

    // 5. Workspace isolation -------------------------------------------------------------
    const iso = await makeBillingWorkspace(svc, created, "iso", { plan: null }, stamp);
    const isoProject = await createProjectForUser(svc, iso.user, { workspace_id: iso.ws.id, name: "Iso" });
    const isoMemberRows = (await svc.entities.WorkspaceMember.filter({ workspace_id: iso.ws.id }, "-created_date", 50)).filter((m) => m.status !== "removed");
    check("5. workspace isolation: a fresh workspace is unaffected by another's exhausted app ceiling and member rows never leak",
      !!isoProject.project && (await effectivePlan(svc, iso.ws.id)).plan.code === "free" && isoMemberRows.length === 0,
      { created: !!isoProject.project, members: isoMemberRows.length });

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const wsId of created.workspaces) {
      const projs = await svc.entities.Project.filter({ workspace_id: wsId }, "-created_date", 100).catch(() => []);
      for (const p of projs) {
        for (const name of ["ProjectFile", "ProjectVersion", "CustomDomain"]) {
          for (const r of await svc.entities[name].filter({ project_id: p.id }, "-created_date", 200).catch(() => [])) await svc.entities[name].delete(r.id).catch(() => {});
        }
      }
      await cleanupWorkspace(svc, wsId, ["Project", "WorkspaceMember", "CustomDomain", "Subscription", "AuditLog"]);
    }
    for (const id of created.plans) await svc.entities.BillingPlan.delete(id).catch(() => {});
  }
}