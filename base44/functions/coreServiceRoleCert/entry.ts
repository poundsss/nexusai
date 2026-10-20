// Certification: the documented backend Core namespace `asServiceRole.integrations.Core.*` in
// generated functions, and SendPushNotification as a SERVER-ONLY Core method. Runs through the
// real executor with the internal "test" messaging transport (no provider, no credits moved).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { makeAgentProject } from "../../shared/appAgentTestFixtures.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { handleAppIntegrations } from "../../shared/appIntegrations.ts";
import { CORE_METHODS } from "../../shared/coreServiceRole.ts";
import { handleAppNotifications } from "../../shared/appNotifications.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const FN = `export const config = { method: 'ANY' };
export default async function (ctx) {
  var b = ctx.request.body || {};
  var core = ctx.asServiceRole && ctx.asServiceRole.integrations && ctx.asServiceRole.integrations.Core;
  var out = { methods: core ? Object.keys(core) : [], results: [] };
  var calls = b.calls || [];
  for (var i = 0; i < calls.length; i++) {
    try { out.results.push({ ok: true, value: await core[calls[i].op](calls[i].args) }); }
    catch (e) { out.results.push({ ok: false, status: e.status || null, code: e.code || null }); }
  }
  return { status: 200, body: out };
}`;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  try {
    const plan = await makeBillingPlan(db, created, `csr${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `csr${stamp}`, { plan });
    const P = await makeAgentProject(db, projectIds, A, stamp, "csr");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "csr2");
    const u1 = await db.entities.AppRecord.create({ project_id: P.id, entity_name: "__users", data: { email: `u1-${stamp}@example.com`, status: "active" } });
    const uOther = await db.entities.AppRecord.create({ project_id: P2.id, entity_name: "__users", data: { email: `u2-${stamp}@example.com`, status: "active" } });

    const run = (calls) => executeProjectFunction(db, {
      project: P, entities: [], name: "csrFn", source: FN, trigger: "frontend", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: { calls } }, user: null, messagingTransport: "test",
    });
    const r = await run([
      { op: "SendPushNotification", args: { user_id: u1.id, title: "Hello", content: "Your order shipped" } },
      { op: "SendPushNotification", args: { user_id: uOther.id, title: "x", content: "y" } },
      { op: "SendPushNotification", args: { user_id: u1.id, title: "", content: "y" } },
      { op: "TranscribeAudio", args: {} },
    ]);
    const B = r.body || {};
    const res = B.results || [];
    h.check("c1 the executing ctx exposes every documented Core method under asServiceRole.integrations.Core",
      r.status === 200 && CORE_METHODS.every((m) => (B.methods || []).includes(m)), JSON.stringify(B.methods));
    h.check("c2 SendPushNotification from a backend function succeeds and returns the notification",
      res[0]?.ok === true && res[0].value?.kind === "push" && !!res[0].value?.notification_id, JSON.stringify(res[0]));
    const notes = await db.entities.AppRecord.filter({ project_id: P.id, entity_name: "__notifications", owner_id: u1.id }, "-created_date", 5);
    h.check("c3 the push is persisted as the recipient's own in-app notification", notes.length === 1 && notes[0].data?.title === "Hello", String(notes.length));
    h.check("c4 test transport reports no native delivery (never fabricated)", res[0]?.value?.delivered === false, JSON.stringify(res[0]?.value));
    h.check("c5 a recipient from another project is refused (404)", res[1]?.ok === false && res[1].status === 404 && res[1].code === "PUSH_RECIPIENT_NOT_FOUND", JSON.stringify(res[1]));
    h.check("c6 invalid push input is refused (400)", res[2]?.ok === false && res[2].status === 400 && res[2].code === "PUSH_NO_TITLE", JSON.stringify(res[2]));
    h.check("c7 other Core methods dispatch to the same handlers (validation error surfaces)", res[3]?.ok === false && res[3].code === "INTEGRATION_PARAM_REQUIRED", JSON.stringify(res[3]));

    const fe = await handleAppIntegrations(db, { project: P, op: "SendPushNotification", args: { user_id: u1.id, title: "FE", content: "x" }, transport: "test", trigger: "frontend" }).then(() => null, (e) => e);
    h.check("c8 the frontend bridge refuses SendPushNotification (server-only, 403)", fe?.status === 403 && fe?.code === "PUSH_SERVER_ONLY", String(fe?.code));
    const after = await db.entities.AppRecord.filter({ project_id: P.id, entity_name: "__notifications" }, "-created_date", 10);
    h.check("c9 the refused frontend push created nothing", after.length === 1, String(after.length));

    // ---- in-app inbox (read side) ----
    const nid = res[0]?.value?.notification_id;
    const me = { id: u1.id }, other = { id: uOther.id };
    const inbox = (user, op, args = {}, projectId = P.id) => handleAppNotifications(db, { projectId, user, op, args }).then((v) => ({ v }), (e) => ({ e }));
    const anon = await inbox(null, "list");
    h.check("n1 the inbox refuses an anonymous caller (401)", anon.e?.status === 401, String(anon.e?.code));
    const l = await inbox(me, "list");
    h.check("n2 the recipient lists their own notification", l.v?.length === 1 && l.v[0].id === nid && l.v[0].read === false, JSON.stringify(l.v));
    const c0 = await inbox(me, "unread_count");
    h.check("n3 unread_count is server-counted", c0.v?.count === 1, JSON.stringify(c0.v));
    const lo = await inbox(other, "list", {}, P2.id);
    h.check("n4 another project's user sees none of it", Array.isArray(lo.v) && lo.v.length === 0, JSON.stringify(lo.v));
    const mo = await inbox(other, "mark_read", { id: nid });
    h.check("n5 a non-owner cannot mark it read (404, indistinguishable)", mo.e?.status === 404 && mo.e?.code === "NOTIFICATION_NOT_FOUND", String(mo.e?.code));
    const m = await inbox(me, "mark_read", { id: nid });
    const stored = await db.entities.AppRecord.get(nid);
    h.check("n6 mark_read persists read=true + read_at", m.v?.read === true && stored.data?.read === true && !!stored.data?.read_at, JSON.stringify(stored.data));
    await handleAppIntegrations(db, { project: P, op: "SendPushNotification", args: { user_id: u1.id, title: "Two", content: "x" }, transport: "test", trigger: "function" });
    const ma = await inbox(me, "mark_all_read");
    const c1 = await inbox(me, "unread_count");
    h.check("n7 mark_all_read clears the rest", ma.v?.updated === 1 && ma.v?.has_more === false && c1.v?.count === 0, JSON.stringify({ ma: ma.v, c1: c1.v }));
    const pushed = await db.entities.AppRecord.filter({ project_id: P.id, entity_name: "__notifications", owner_id: u1.id }, "-created_date", 10);
    h.check("n10 pushes carry the server-side unread marker, cleared on read", pushed.length === 2 && pushed.every((r) => r.unread === false), JSON.stringify(pushed.map((r) => r.unread)));
    const legacy = await db.entities.AppRecord.create({ project_id: P.id, entity_name: "__notifications", owner_id: u1.id, data: { title: "Legacy", content: "x", read: false } });
    await handleAppIntegrations(db, { project: P, op: "SendPushNotification", args: { user_id: u1.id, title: "New", content: "x" }, transport: "test", trigger: "function" });
    const c2 = await inbox(me, "unread_count");
    const lu = await inbox(me, "list", { unread_only: true });
    h.check("n11 unread count/list cover marked rows and legacy rows without the marker", c2.v?.count === 2 && lu.v?.length === 2 && lu.v.some((n) => n.id === legacy.id), JSON.stringify({ c2: c2.v, lu: lu.v?.map((n) => n.title) }));
    const ma2 = await inbox(me, "mark_all_read");
    const leg = await db.entities.AppRecord.get(legacy.id);
    const c3 = await inbox(me, "unread_count");
    h.check("n12 mark_all_read clears both kinds and stamps the marker on legacy rows", ma2.v?.updated === 2 && c3.v?.count === 0 && leg.unread === false && leg.data?.read === true, JSON.stringify({ ma2: ma2.v, c3: c3.v, leg: leg.unread }));
    const bad = await inbox(me, "delete");
    h.check("n8 unsupported ops are refused (400)", bad.e?.status === 400, String(bad.e?.code));
    h.check("n9 the runtime surface exports notifications", RUNTIME_EXPORTS.includes("notifications"), "");

    return harnessResponse(h);
  } catch (error) {
    return Response.json({ ...h.summary(), ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    for (const pid of projectIds) {
      for (const e of ["AppRecord", "FunctionInvocation", "ProjectFile", "TraceEvent"]) await purgeBy(db, e, { project_id: pid });
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) await cleanupWorkspace(db, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "Project", "UsageEvent"]);
    for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
    for (const pid of projectIds) {
      const left = await db.entities.AppRecord.filter({ project_id: pid }, "-created_date", 1).catch(() => []);
      if (left.length) console.error("cleanup leftover AppRecord", pid);
    }
  }
}