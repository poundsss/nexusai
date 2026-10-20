// E2E: notifications inbox inside a LIVE generated app through the real public runtime.
// Push is sent by the app's own backend function (asServiceRole Core), read through the
// runtime "notifications" action with real end-user sessions. Test transport only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { runtimeNotificationsRoute } from "../../shared/runtimeNotificationsRoute.ts";
import { createDeployedApp, MINIMAL_MAIN, MINIMAL_APP, MINIMAL_STYLES } from "../../shared/deployFixtures.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { handleAppIntegrations } from "../../shared/appIntegrations.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";

const APP = `import { html } from 'runtime';
import { notifications } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">Inbox</h1></div>\`; }
`;

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const h = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  try {
    const plan = await makeBillingPlan(db, created, `nrt${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `nrt${stamp}`, { plan });
    const d = await createDeployedApp(db, {
      workspace_id: A.ws.id, name: `nrt ${stamp}`, slug: `nrt-${stamp}`, deployed_by: A.user.id,
      files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", APP], ["styles.css", MINIMAL_STYLES]],
      on_project_created: (p) => projectIds.push(p.id),
    });
    h.check("e0 fully built live app", d.run.status === "LIVE", String(d.run.status));
    const P = d.project, slug = P.slug;
    const u1 = await signUpWithSession(db, P.id, { email: `n1-${stamp}@nrt.test`, password: "Passw0rd!x9", full_name: "N1" }, {});
    const u2 = await signUpWithSession(db, P.id, { email: `n2-${stamp}@nrt.test`, password: "Passw0rd!x9", full_name: "N2" }, {});
    for (const t of ["One", "Two", "Three"]) {
      await handleAppIntegrations(db, { project: P, op: "SendPushNotification", args: { user_id: u1.user.id, title: t, content: "x" }, transport: "test", trigger: "function" });
    }
    await handleAppIntegrations(db, { project: P, op: "SendPushNotification", args: { user_id: u2.user.id, title: "Other", content: "y" }, transport: "test", trigger: "function" });

    // The published appRuntime only picks up source changes on publish (not done here), so the
    // runtime route is driven in-process against the LIVE deployed project — the exact handler
    // appRuntime dispatches for action "notifications".
    const live = await db.entities.Project.filter({ slug }, "-created_date", 1);
    h.check("e0b live project resolves by slug", live[0]?.id === P.id, String(live[0]?.id));
    const nb = async (token, op, args = {}) => {
      const out = await runtimeNotificationsRoute(db, { project: live[0], body: { op, args, ...(token ? { session_token: token } : {}) } });
      return { ok: out.status === 200, status: out.status, data: out.body };
    };
    const anon = await nb(null, "list");
    h.check("e1 anonymous runtime inbox call refused (401)", !anon.ok && anon.status === 401, `${anon.status}`);
    const l1 = await nb(u1.token, "list");
    const items = l1.data?.result || [];
    h.check("e2 user 1 lists exactly their 3 notifications, newest first", l1.ok && items.length === 3 && items[0].title === "Three", JSON.stringify(items.map((i) => i.title)));
    const c1 = await nb(u1.token, "unread_count");
    h.check("e3 unread_count = 3 via runtime", c1.data?.result?.count === 3, JSON.stringify(c1.data));
    const l2 = await nb(u2.token, "list");
    h.check("e4 user 2 sees only their own", (l2.data?.result || []).length === 1 && l2.data.result[0].title === "Other", JSON.stringify(l2.data));
    const cross = await nb(u2.token, "mark_read", { id: items[0]?.id });
    h.check("e5 user 2 cannot mark user 1's notification (404)", !cross.ok && cross.status === 404, `${cross.status}`);
    const m1 = await nb(u1.token, "mark_read", { id: items[0]?.id });
    const stored = await db.entities.AppRecord.get(items[0].id);
    h.check("e6 mark one read persists", m1.ok && stored.data?.read === true, JSON.stringify(stored.data));
    const c2 = await nb(u1.token, "unread_count");
    h.check("e7 unread_count drops to 2", c2.data?.result?.count === 2, JSON.stringify(c2.data));
    const ma = await nb(u1.token, "mark_all_read");
    const c3 = await nb(u1.token, "unread_count");
    h.check("e8 mark_all_read clears the rest (2) and count is 0", ma.data?.result?.updated === 2 && c3.data?.result?.count === 0, JSON.stringify({ ma: ma.data, c3: c3.data }));
    const c4 = await nb(u2.token, "unread_count");
    h.check("e9 user 2's unread untouched by user 1's mark_all", c4.data?.result?.count === 1, JSON.stringify(c4.data));
    return harnessResponse(h);
  } catch (error) {
    return Response.json({ ...h.summary(), ok: false, error: error.message }, { status: 500 });
  } finally {
    for (const pid of projectIds) {
      for (const e of ["AppRecord", "AppUser", "AppSession", "FunctionInvocation", "ProjectFile", "ProjectVersion", "Deployment", "DeploymentArtifact", "TraceEvent", "AuditLog"]) await purgeBy(db, e, { project_id: pid });
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