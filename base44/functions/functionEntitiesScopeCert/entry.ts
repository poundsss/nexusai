// Certification: generated backend functions get Base44's two data clients —
// ctx.entities (caller-scoped: the same owner/RLS rules as the published runtime) and
// ctx.asServiceRole.entities (unrestricted, identical to the legacy ctx.db).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { makeAgentProject } from "../../shared/appAgentTestFixtures.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";

const FN = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var op = (ctx.request.body || {}).op;
  if (op === 'create') return { status: 200, body: await ctx.entities.Task.create({ title: (ctx.request.body || {}).title }) };
  var mine = await ctx.entities.Task.filter({});
  var all = await ctx.asServiceRole.entities.Task.filter({});
  var legacy = await ctx.db.Task.filter({});
  return { status: 200, body: { mine: mine.length, all: all.length, legacy: legacy.length } };
}`;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  try {
    const plan = await makeBillingPlan(db, created, `fes${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `fes${stamp}`, { plan });
    const P0 = await makeAgentProject(db, projectIds, A, stamp, "fes");
    const P = await db.entities.Project.update(P0.id, { rls_enabled: true });
    const entities = [{ name: "Task", fields: { title: { type: "string" } } }];
    const run = (user, body) => executeProjectFunction(db, {
      project: { ...P0, ...P, rls_enabled: true }, entities, name: "fesFn", source: FN, trigger: "frontend",
      requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body }, user, messagingTransport: "test",
    });
    const u1 = { id: `fes-u1-${stamp}`, email: `u1-${stamp}@fes.test` };
    const u2 = { id: `fes-u2-${stamp}`, email: `u2-${stamp}@fes.test` };
    const c1 = await run(u1, { op: "create", title: "a" });
    await run(u2, { op: "create", title: "b" });
    const row = c1.body?.id ? await db.entities.AppRecord.get(c1.body.id) : null;
    h.check("f1 ctx.entities writes are owned by the calling end user", row?.owner_id === u1.id, JSON.stringify({ s: c1.status, o: row?.owner_id }));
    const r1 = await run(u1, { op: "read" });
    h.check("f2 ctx.entities reads only the caller's rows", r1.body?.mine === 1, JSON.stringify(r1.body));
    h.check("f3 ctx.asServiceRole.entities sees every row", r1.body?.all === 2, JSON.stringify(r1.body));
    h.check("f4 legacy ctx.db behavior is unchanged (unrestricted)", r1.body?.legacy === 2, JSON.stringify(r1.body));
    const anon = await run(null, { op: "read" });
    h.check("f5 an anonymous caller sees no owned rows via ctx.entities", anon.status !== 200 || anon.body?.mine === 0, JSON.stringify({ s: anon.status, b: anon.body }));
    return harnessResponse(h);
  } catch (error) {
    return Response.json({ ...h.summary(), ok: false, error: error.message }, { status: 500 });
  } finally {
    for (const pid of projectIds) {
      for (const e of ["AppRecord", "FunctionInvocation", "TraceEvent"]) await purgeBy(db, e, { project_id: pid });
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) await cleanupWorkspace(db, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "Project", "UsageEvent"]);
    for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
  }
}