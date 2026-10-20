// Round 8 focused certification: runs the REAL handlers in-process against a scratch workspace
// owned by the caller (no real customer data, no paid calls), then deletes every row it created.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
// The DEPLOYED functions are invoked over the platform with the caller's own token.
const reportSummary = "reportSummary";
const customerLookup = "customerLookup";
const sweepLiveConfirmation = "sweepLiveConfirmation";
const handleDelegatedOAuth = "delegatedOAuth";

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const me = await base44.auth.me().catch(() => null);
  if (!me) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (me.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
  const svc = base44.asServiceRole.entities;
  const checks: any[] = [];
  const check = (name: string, ok: boolean, detail: any) => checks.push({ name, ok, detail });
  const call = async (fn: string, payload: any) => {
    try {
      const r: any = await base44.functions.invoke(fn, payload);
      return { status: r.status, body: r.data };
    } catch (e: any) {
      return { status: e?.response?.status || e?.status || 0, body: e?.response?.data ?? e?.data ?? String(e?.message || e) };
    }
  };
  const stamp = Date.now();
  const made = { ws: [] as string[], proj: [] as string[], cust: [] as string[], act: [] as string[] };
  try {
    const ws = await svc.Workspace.create({ name: `round8-cert ${stamp}`, owner_id: me.id, status: "active", credits_balance: 0 });
    made.ws.push(ws.id);
    const foreignWs = await svc.Workspace.create({ name: `round8-cert-foreign ${stamp}`, owner_id: `round8_nobody_${stamp}`, status: "active" });
    made.ws.push(foreignWs.id);
    const p = await svc.Project.create({ workspace_id: ws.id, name: "r8", slug: `r8-cert-${stamp}` });
    const fp = await svc.Project.create({ workspace_id: foreignWs.id, name: "r8f", slug: `r8f-cert-${stamp}` });
    made.proj.push(p.id, fp.id);
    const custs = await svc.Customer.bulkCreate([
      { project_id: p.id, name: "A", status: "Lead", email: "r8a@example.com", deal_value: 100 },
      { project_id: p.id, name: "B", status: "Customer", deal_value: 250 },
      { project_id: fp.id, name: "F", status: "Lead", email: "r8f@example.com", deal_value: 999 },
    ]);
    made.cust.push(...custs.map((c: any) => c.id));
    const acts = await svc.Activity.bulkCreate([
      { customerId: custs[0].id, type: "Note", notes: "x" },
      { customerId: custs[1].id, type: "Call", notes: "y" },
      { customerId: custs[2].id, type: "Note", notes: "foreign" },
    ]);
    made.act.push(...acts.map((a: any) => a.id));

    // reportSummary
    let r = await call(reportSummary, { project_id: p.id });
    check("reportSummary own project totals", r.status === 200 && r.body.totalCustomers === 2 && r.body.totalActivities === 2 && r.body.totalPipelineValue === 350 && r.body.statusCounts.Lead === 1 && r.body.statusCounts.Customer === 1, r);
    r = await call(reportSummary, { project_id: fp.id });
    check("reportSummary foreign project refused", r.status === 403, r.status);
    r = await call(reportSummary, { project_id: p.id, customerId: custs[2].id });
    check("reportSummary foreign customer → 404, no activity", r.status === 404 && (await svc.Activity.count({ customerId: custs[2].id })) === 1, r.status);

    // customerLookup
    r = await call(customerLookup, { email: "r8a@example.com", project_id: p.id });
    check("customerLookup own match", r.status === 200 && r.body.customer?.id === custs[0].id, r.status);
    r = await call(customerLookup, { email: "r8f@example.com", project_id: p.id });
    check("customerLookup other project's email → 404", r.status === 404, r.status);
    r = await call(customerLookup, { email: "r8f@example.com", project_id: fp.id });
    check("customerLookup foreign project refused", r.status === 403, r.status);
    r = await call(customerLookup, { email: "r8a@example.com" });
    check("customerLookup missing project_id → 400", r.status === 400, r.status);

    // sweepLiveConfirmation: non-fixture ids refused before any read/delete
    r = await call(sweepLiveConfirmation, { op: "verify", project_id: p.id, trigger_id: "x" });
    check("sweep verify non-fixture → 403", r.status === 403, r.status);
    r = await call(sweepLiveConfirmation, { op: "cleanup", project_id: p.id, workspace_id: ws.id });
    check("sweep cleanup non-fixture → 403, project kept", r.status === 403 && !!(await svc.Project.get(p.id).catch(() => null)), r.status);

    // delegatedOAuth builder branch
    r = await call(handleDelegatedOAuth, { action: "list", project_id: p.id });
    check("oauth list member active → 200", r.status === 200 && Array.isArray(r.body.credentials), r.status);
    r = await call(handleDelegatedOAuth, { action: "list", project_id: fp.id });
    check("oauth list non-member → 403", r.status === 403, r.status);
    r = await call(handleDelegatedOAuth, { action: "begin", project_id: fp.id, provider_id: "none" });
    check("oauth begin non-member → 403", r.status === 403, r.status);
    r = await call(handleDelegatedOAuth, { action: "refresh", project_id: p.id, credential_id: "nonexistent" });
    check("oauth refresh unknown credential refused (not 200)", r.status >= 400 && r.status < 500, r);
    await svc.Workspace.update(ws.id, { status: "suspended" });
    for (const action of ["begin", "callback", "refresh", "revoke"]) {
      r = await call(handleDelegatedOAuth, { action, project_id: p.id, provider_id: "none", credential_id: "x", state: "x", code: "x" });
      check(`oauth ${action} suspended → 403 WORKSPACE_INACTIVE`, r.status === 403 && r.body?.code === "WORKSPACE_INACTIVE", r);
    }
    r = await call(handleDelegatedOAuth, { action: "list", project_id: p.id });
    check("oauth list suspended → 200 (read)", r.status === 200, r.status);
  } catch (e: any) {
    check("fatal", false, String(e?.message || e));
  } finally {
    for (const id of made.act) await svc.Activity.delete(id).catch(() => {});
    for (const id of made.cust) await svc.Customer.delete(id).catch(() => {});
    for (const id of made.proj) await svc.Project.delete(id).catch(() => {});
    for (const id of made.ws) await svc.Workspace.delete(id).catch(() => {});
  }
  const left = (await svc.Workspace.filter({ name: { $regex: `^round8-cert.* ${stamp}$` } }).catch(() => [])).length
    + (await svc.Customer.filter({ project_id: { $in: made.proj } }).catch(() => [])).length;
  check("cleanup verified (0 rows left)", left === 0, left);
  const passed = checks.filter((c) => c.ok).length;
  return Response.json({ ok: passed === checks.length, passed, total: checks.length, checks });
}