// Certification: the builder preview's data surface applies the SAME end-user access rules as
// the published runtime when the preview is signed in as an app user; without an app session
// the builder's open preview view is unchanged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { makeAgentProject } from "../../shared/appAgentTestFixtures.ts";
import { handlePreviewData } from "../../shared/previewData.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  try {
    const plan = await makeBillingPlan(db, created, `pds${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `pds${stamp}`, { plan });
    const P = await makeAgentProject(db, projectIds, A, stamp, "pds");
    await db.entities.Project.update(P.id, { rls_enabled: true });
    await db.entities.AppEntity.create({ project_id: P.id, name: "Task", fields: { title: { type: "string" } } });
    const u1 = await signUpWithSession(db, P.id, { email: `p1-${stamp}@pds.test`, password: "Passw0rd!x9", full_name: "P1" }, {});
    const u2 = await signUpWithSession(db, P.id, { email: `p2-${stamp}@pds.test`, password: "Passw0rd!x9", full_name: "P2" }, {});
    const pd = (token, op, args) => handlePreviewData(base44, A.user, { project_id: P.id, op, args, ...(token ? { session_token: token } : {}) }).then((v) => ({ v }), (e) => ({ e }));

    const t1 = await pd(u1.token, "create", { entity: "Task", data: { title: "mine-1" } });
    const t2 = await pd(u2.token, "create", { entity: "Task", data: { title: "mine-2" } });
    h.check("p1 signed-in preview writes succeed", !!t1.v?.id && !!t2.v?.id, JSON.stringify({ e1: t1.e?.message, e2: t2.e?.message }));
    const rec = t1.v?.id ? await db.entities.AppRecord.get(t1.v.id) : null;
    h.check("p2 preview write is owned by the signed-in app user", rec?.owner_id === String(u1.user.id), String(rec?.owner_id));
    const l1 = await pd(u1.token, "filter", { entity: "Task" });
    h.check("p3 app user 1 sees only their own rows in preview", Array.isArray(l1.v) && l1.v.length === 1 && l1.v[0].title === "mine-1", JSON.stringify(l1.v || l1.e?.message));
    const g = await pd(u1.token, "get", { id: t2.v?.id });
    h.check("p4 app user 1 cannot read user 2's row by id", !!g.e || !g.v, JSON.stringify(g.v || g.e?.code));
    const c = await pd(u2.token, "count", { entity: "Task" });
    h.check("p5 count is scoped to the signed-in app user", c.v === 1 || c.v?.count === 1, JSON.stringify(c.v));
    const ev = await pd(u1.token, "events", { entity: "Task" });
    const evIds = JSON.stringify(ev.v || {});
    h.check("p6 subscribe events exclude another user's rows", !evIds.includes(String(t2.v?.id)) && evIds.includes(String(t1.v?.id)), evIds.slice(0, 300));
    const builder = await pd(null, "filter", { entity: "Task" });
    h.check("p7 builder without app session keeps the open preview view", Array.isArray(builder.v) && builder.v.length === 2, JSON.stringify(builder.v?.length));
    const forged = await pd("not-a-real-token", "filter", { entity: "Task" });
    h.check("p8 an invalid session token grants nothing beyond the builder view", Array.isArray(forged.v) && forged.v.length === 2, JSON.stringify(forged.v?.length));
    return harnessResponse(h);
  } catch (error) {
    return Response.json({ ...h.summary(), ok: false, error: error.message }, { status: 500 });
  } finally {
    for (const pid of projectIds) {
      for (const e of ["AppRecord", "AppEntity", "AppUser", "AppSession", "TraceEvent", "AuditLog"]) await purgeBy(db, e, { project_id: pid });
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) await cleanupWorkspace(db, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "Project", "UsageEvent"]);
    for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
  }
}