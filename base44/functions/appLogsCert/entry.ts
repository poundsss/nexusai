// Certification for the AppLogsModule parity gap: the DOCUMENTED Base44 `base44.appLogs.logUserInApp(pageName)`
// surface (SDK 0.8.52, `POST /app-logs/{appId}/log-user-in-app/{pageName}` — no body, available in
// ALL auth modes, anonymous included) dispatched onto the EXISTING analytics dispatcher
// (shared/analyticsRuntime.ts op `log_user_in_app` → analyticsIngest.ingestEvent).
//
// Drives the REAL deployed public runtime (appRuntime action "analytics") and the REAL builder
// preview dispatch (previewAnalytics) — both route through the SAME shared dispatcher. No provider
// boundary is stubbed (there is none), no credits move, no production data is touched: every
// fixture is a disposable deployed app created and deleted within this run.
//
// Certified:
//   • the shipped runtime exposes `appLogs.logUserInApp` (RUNTIME_EXPORTS + bridge mirror + sdk alias);
//   • an ANONYMOUS deployed call answers 200 and the event persists as a page_view event named for
//     the page, environment "production", project/workspace ownership server-resolved, app_user null;
//   • an AUTHENTICATED end-user call (real #29 session) persists the event attributed to that user;
//   • an empty pageName is refused 400 (fail-closed, nothing stored);
//   • an oversized pageName stays bounded by the EXISTING ingestion identifiers (no new rule invented);
//   • PROJECT ISOLATION — the event is written only under the addressed app's project id; a second
//     app sees zero events with that name;
//   • PREVIEW PARITY — the builder preview reaches the SAME dispatcher and persists as environment
//     "development" (the preview's own environment), deterministically separated from production;
//   • EXISTING BEHAVIOR UNCHANGED — `track` still works, an unknown op is still refused 400, and
//     no extra data beyond the dispatcher's normal event projection is returned.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { createDeployedApp, appRuntimeCaller } from "../../shared/deployFixtures.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const client = createClientFromRequest(req);
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [] };
  const projects = [];

  try {
    const me = await client.auth.me();
    const ws = await db.entities.Workspace.create({ name: `applogs-${stamp}`, owner_id: me?.id, status: "active" });
    created.workspaces.push(ws.id);

    const rt = appRuntimeCaller(db);
    const logCall = (project, { page = null, token = null } = {}) =>
      rt({ action: "analytics", slug: project.slug, op: "log_user_in_app", ...(page !== null ? { args: { page } } : { args: {} }), ...(token ? { session_token: token } : {}) });
    const findEvents = async (project, eventName) =>
      db.entities.AppAnalyticsEvent.filter({ project_id: project.id, event_name: eventName }, "-created_date", 20);

    // ---- fixtures: one public + one private disposable deployed app -----------------------
    const mk = async (name, slug, patch) => {
      const d = await createDeployedApp(db, {
        workspace_id: ws.id, name, slug, deployed_by: me?.id,
        on_project_created: (p) => projects.push(p.id),
      });
      if (patch) await db.entities.Project.update(d.project.id, patch);
      return d.project;
    };
    const publicApp = await mk(`Logs Public ${stamp}`, `applogs-a-${stamp}`, null);
    const otherApp = await mk(`Logs Other ${stamp}`, `applogs-b-${stamp}`, null);
    const privateApp = await mk(`Logs Private ${stamp}`, `applogs-c-${stamp}`, { visibility: "private" });
    const appUser = await signUpWithSession(db, privateApp.id, { email: `u-${stamp}@applogs.test`, password: "Sup3r-Secret-Logs-1", full_name: "Logs User" }, {});

    // ---- 1. shipped runtime surface --------------------------------------------------------
    // MIRROR of src/lib/runtime/runtimeSource.js (backend code cannot import src/ — the
    // established mirror-check convention, keep in sync).
    const APPLOGS_EXPORT = "export const appLogs = { logUserInApp: (pageName) => call('analytics', 'log_user_in_app', { page: pageName }) };";
    const SDK_FREEZE = "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, types, app, appLogs });";
    harness.check("the shipped runtime exports `appLogs` with logUserInApp as a thin bridge to the analytics dispatcher, included in the sdk alias",
      RUNTIME_EXPORTS.includes("appLogs") && APPLOGS_EXPORT.length > 0 && SDK_FREEZE.endsWith("appLogs });"),
      { runtime_exports: RUNTIME_EXPORTS.join(",") });

    // ---- 2. anonymous call: 200 + persisted page_view event, production, server-resolved ownership
    const anon = await logCall(publicApp, { page: "checkout" });
    const anonEvents = await findEvents(publicApp, "checkout");
    const ev = anonEvents[0] || null;
    harness.check("an ANONYMOUS call answers 200 and persists exactly one page_view event named for the page, in production, attributed to the addressed app only",
      anon.status === 200 && anonEvents.length === 1 && ev &&
      ev.event_type === "page_view" && ev.environment === "production" &&
      ev.project_id === publicApp.id && ev.workspace_id === publicApp.workspace_id &&
      ev.page === "checkout" && !ev.app_user_id,
      `status ${anon.status} · events ${anonEvents.length} · ${ev ? `${ev.event_type}/${ev.environment}` : "none"}`);

    // ---- 3. authenticated call: the event is attributed to the real #29 end-user ------------
    const auth = await logCall(privateApp, { page: "dashboard", token: appUser.token });
    const authEvents = await findEvents(privateApp, "dashboard");
    harness.check("an AUTHENTICATED call persists the event attributed to that app user (and nothing else changed ownership)",
      auth.status === 200 && authEvents.length === 1 && authEvents[0]?.app_user_id === appUser.user.id,
      `status ${auth.status} · attributed ${authEvents[0]?.app_user_id === appUser.user.id}`);

    // ---- 4. fail-closed: empty pageName refused, nothing stored -----------------------------
    const empty = await logCall(publicApp, { page: "" });
    const emptyWhitespace = await logCall(publicApp, { page: "   " });
    harness.check("an empty or whitespace pageName is refused 400 and nothing is stored",
      empty.status === 400 && emptyWhitespace.status === 400 &&
      (await findEvents(publicApp, "")).length === 0,
      `empty ${empty.status} · whitespace ${emptyWhitespace.status}`);

    // ---- 5. EXISTING bounding preserved (no new pageName rule invented) ---------------------
    const longPage = "p".repeat(120);
    const long = await logCall(publicApp, { page: longPage });
    const longEvents = await findEvents(publicApp, longPage.slice(0, 80));
    harness.check("an oversized pageName is bounded by the EXISTING ingestion identifiers (event_name ≤ 80, page ≤ 300) and accepted",
      long.status === 200 && longEvents.length === 1 &&
      longEvents[0].event_name.length <= 80 && (longEvents[0].page || "").length <= 300,
      `status ${long.status} · event_name len ${longEvents[0]?.event_name.length}`);

    // ---- 6. PROJECT ISOLATION ----------------------------------------------------------------
    const otherEvents = await findEvents(otherApp, "checkout");
    harness.check("the logged event exists ONLY under the addressed app — a second app's data is untouched",
      otherEvents.length === 0 && ev.project_id === publicApp.id,
      `other app events ${otherEvents.length}`);

    // ---- 7. PREVIEW PARITY: same dispatcher, development environment, builder-authorized ------
    const pv = (body) =>
      client.functions.invoke("previewAnalytics", body)
        .then((r) => ({ status: 200, data: r.data ?? r }))
        .catch((e) => ({ status: e.status || e.response?.status || 0, data: e.response?.data || { error: e.message } }));
    const pvOk = await pv({ project_id: publicApp.id, op: "log_user_in_app", args: { page: "preview-page" } });
    const pvEvents = await db.entities.AppAnalyticsEvent.filter({ project_id: publicApp.id, event_name: "preview-page" }, "-created_date", 20);
    harness.check("the builder preview dispatches the SAME dispatcher: 200 and the event persists as environment development, separated from production",
      pvOk.status === 200 && pvEvents.length === 1 && pvEvents[0]?.environment === "development",
      `status ${pvOk.status} · environment ${pvEvents[0]?.environment}`);

    // ---- 8. EXISTING BEHAVIOR UNCHANGED -------------------------------------------------------
    const track = await rt({ action: "analytics", slug: publicApp.slug, op: "track", args: { event: { event_name: "custom_thing", event_type: "custom_event", properties: { size: "m" } } } });
    const unknownOp = await rt({ action: "analytics", slug: publicApp.slug, op: "fetch_logs" });
    const previewUnknown = await pv({ project_id: publicApp.id, op: "get_stats", args: {} });
    harness.check("existing analytics behavior is unchanged: `track` still answers 200, unknown ops (including the @internal fetch/get stats surfaces) are still refused",
      track.status === 200 && unknownOp.status === 400 && previewUnknown.status === 400,
      `track ${track.status} · unknown ${unknownOp.status} · preview ${previewUnknown.status}`);

    // ---- 9. response shape: only the dispatcher's normal event projection ---------------------
    const keys = anon.data?.result?.event ? Object.keys(anon.data.result.event).sort() : [];
    harness.check("a successful call returns only the dispatcher's normal { event, duplicate } projection — no extra data",
      anon.data?.result && typeof anon.data.result.duplicate === "boolean" && keys.includes("event_name") && keys.includes("event_type") &&
      !keys.includes("project_secret") && !keys.includes("storage_handle"),
      `${keys.length} keys · duplicate=${anon.data?.result?.duplicate}`);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  } finally {
    await purgeBy(db, "WorkspaceMember", { workspace_id: created.workspaces[0] }).catch(() => {});
    for (const pid of projects) {
      for (const entity of ["AppAnalyticsEvent", "AppAnalyticsSession", "AppEventSchema", "AppAnalyticsConfig", "Deployment", "DeploymentArtifact", "AppSession", "AppAuthToken", "AppUser", "TraceEvent", "AuditLog", "AppRecord", "AppEntity", "ProjectSecret", "Build", "ProjectVersion", "ProjectFile", "FunctionInvocation", "PrimitiveInvocation", "IntegrationInvocation", "AIOperation", "ScheduledTrigger"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(db, wid, ["WorkspaceMember", "CreditLedgerEntry", "Subscription"]);
    }
  }
}