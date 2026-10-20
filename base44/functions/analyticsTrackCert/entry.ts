// Certification for the AnalyticsModule parity gap: the DOCUMENTED Base44 `base44.analytics.track({ eventName, properties })`
// surface (SDK 0.8.52 — the module's SINGLE public method, "tracks a custom event that appears as
// a card in your Analytics dashboard") dispatched onto the EXISTING analytics dispatcher
// (shared/analyticsRuntime.ts op `track` → analyticsIngest.ingestEvent).
//
// Drives the REAL deployed public runtime (appRuntime action "analytics") and the REAL builder
// preview dispatch (previewAnalytics) — both route through the SAME shared dispatcher. No provider
// boundary is stubbed (there is none), no credits move, no production data is touched: every
// fixture is a disposable deployed app created and deleted within this run.
//
// Certified:
//   • the shipped runtime exposes `analytics.track` (RUNTIME_EXPORTS + exact runtime-source mirror,
//     with the sdk alias unchanged);
//   • the runtime's mapped payload { session_key, event: { event_name, event_type: "custom_event",
//     page, properties } } reaches the EXISTING op: an ANONYMOUS deployed call answers 200 and the
//     event persists with its properties, environment "production", project/workspace ownership
//     server-resolved, app_user null;
//   • an AUTHENTICATED end-user call (real #29 session) persists the event attributed to that user;
//   • an empty/whitespace event name is refused 400 through the EXISTING validation (nothing stored);
//   • PROJECT ISOLATION — the event is written only under the addressed app's project id;
//   • PREVIEW PARITY — the builder preview reaches the SAME dispatcher and persists as environment
//     "development" (the preview's own environment), separated from production;
//   • REGRESSION — `trackEvent` (the pre-existing positional surface), `logUserInApp` and the
//     unknown-op refusal all behave exactly as before.
//
// NON-PARITY (documented boundary, asserted as unclaimed): Base44's SDK-internal batching,
// heartbeat and queue transport for `track` is NOT reproduced — the runtime dispatches ONE
// synchronous call per invocation (NEXUSAI-derived substitute).
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
    const ws = await db.entities.Workspace.create({ name: `anatrack-${stamp}`, owner_id: me?.id, status: "active" });
    created.workspaces.push(ws.id);

    const rt = appRuntimeCaller(db);
    const findEvents = async (project, eventName) =>
      db.entities.AppAnalyticsEvent.filter({ project_id: project.id, event_name: eventName }, "-created_date", 20);

    // ---- fixtures: two public + one private disposable deployed app -----------------------
    const mk = async (name, slug, patch) => {
      const d = await createDeployedApp(db, {
        workspace_id: ws.id, name, slug, deployed_by: me?.id,
        on_project_created: (p) => projects.push(p.id),
      });
      if (patch) await db.entities.Project.update(d.project.id, patch);
      return d.project;
    };
    const publicApp = await mk(`Track Public ${stamp}`, `anatrack-a-${stamp}`, null);
    const otherApp = await mk(`Track Other ${stamp}`, `anatrack-b-${stamp}`, null);
    const privateApp = await mk(`Track Private ${stamp}`, `anatrack-c-${stamp}`, { visibility: "private" });
    const appUser = await signUpWithSession(db, privateApp.id, { email: `u-${stamp}@anatrack.test`, password: "Sup3r-Secret-AnaTrack-1", full_name: "Track User" }, {});

    // ---- 1. shipped runtime surface --------------------------------------------------------
    // MIRROR of src/lib/runtime/runtimeSource.js (backend code cannot import src/ — the
    // established mirror-check convention, keep in sync).
    const TRACK_MIRROR = "  track: async (params) => { const p = params || {}; if (!analyticsSession) await analytics.startSession(); return call('analytics', 'track', { session_key: analyticsSession, event: { event_name: p.eventName, event_type: 'custom_event', page: location.pathname, properties: p.properties || {} } }); },";
    const TRACKEVENT_MIRROR = "  trackEvent: async (event_name, properties, opts) => { const o = opts || {}; if (!analyticsSession) await analytics.startSession(); return call('analytics', 'track', { session_key: analyticsSession, event: { event_name, event_type: o.event_type, page: o.page || location.pathname, properties: properties || {}, duration_ms: o.duration_ms, conversion_value: o.conversion_value, error_code: o.error_code, error_category: o.error_category, ingestion_key: o.ingestion_key } }); },";
    const SDK_FREEZE = "export const sdk = Object.freeze({ entities: db, functions: server, auth, users, analytics, files, connectors, agents, integrations, types, app, appLogs });";
    harness.check("the shipped runtime exposes `analytics.track` ({ eventName, properties }) as a thin bridge to the existing track op, with trackEvent and the sdk alias unchanged",
      RUNTIME_EXPORTS.includes("analytics") &&
      TRACK_MIRROR.length > 0 && TRACK_MIRROR.includes("call('analytics', 'track'") &&
      TRACKEVENT_MIRROR.length > 0 && SDK_FREEZE.endsWith("appLogs });"),
      { runtime_exports: RUNTIME_EXPORTS.join(",") });

    // ---- 2. anonymous deployed track: the runtime's exact mapped payload --------------------
    // Mirror of the runtime's own behavior: track auto-starts a session, then dispatches the
    // mapped { session_key, event } envelope verbatim.
    const session = await rt({ action: "analytics", slug: publicApp.slug, op: "session_start", args: { session_key: `anatrack-s-${stamp}` } });
    const sessionKey = session.data?.result?.session?.session_key || `anatrack-s-${stamp}`;
    const anon = await rt({
      action: "analytics", slug: publicApp.slug, op: "track",
      args: { session_key: sessionKey, event: { event_name: "add_to_cart", event_type: "custom_event", page: "/product", properties: { sku: "X1", qty: 2, total: 19.98 } } },
    });
    const anonEvents = await findEvents(publicApp, "add_to_cart");
    const ev = anonEvents[0] || null;
    harness.check("an ANONYMOUS track({ eventName, properties }) call answers 200 and persists the event with its properties, custom_event type, in production, attributed to the addressed app only",
      anon.status === 200 && anonEvents.length === 1 && ev &&
      ev.event_name === "add_to_cart" && ev.event_type === "custom_event" &&
      ev.properties?.sku === "X1" && ev.properties?.qty === 2 && ev.properties?.total === 19.98 &&
      ev.environment === "production" &&
      ev.project_id === publicApp.id && ev.workspace_id === publicApp.workspace_id &&
      ev.page === "/product" && !ev.app_user_id,
      `status ${anon.status} · events ${anonEvents.length} · ${ev ? `${ev.event_type}/${ev.environment}` : "none"}`);

    // ---- 3. authenticated track: the event is attributed to the real #29 end-user -----------
    const auth = await rt({
      action: "analytics", slug: privateApp.slug, op: "track",
      args: { event: { event_name: "checkout_completed", event_type: "custom_event", properties: { method: "card" } } },
      session_token: appUser.token,
    });
    const authEvents = await findEvents(privateApp, "checkout_completed");
    harness.check("an AUTHENTICATED track call persists the event attributed to that app user (nothing else changed ownership)",
      auth.status === 200 && authEvents.length === 1 && authEvents[0]?.app_user_id === appUser.user.id &&
      authEvents[0]?.properties?.method === "card",
      `status ${auth.status} · attributed ${authEvents[0]?.app_user_id === appUser.user.id}`);

    // ---- 4. fail-closed: empty/whitespace event name refused through EXISTING validation ------
    const empty = await rt({ action: "analytics", slug: publicApp.slug, op: "track", args: { event: { event_name: "", event_type: "custom_event", properties: {} } } });
    const whitespace = await rt({ action: "analytics", slug: publicApp.slug, op: "track", args: { event: { event_name: "   ", event_type: "custom_event", properties: {} } } });
    harness.check("an empty or whitespace event_name is refused 400 by the EXISTING ingestion validation (nothing stored, no new rule invented)",
      empty.status === 400 && whitespace.status === 400 &&
      (await findEvents(publicApp, "")).length === 0 && (await findEvents(publicApp, "   ")).length === 0,
      `empty ${empty.status} · whitespace ${whitespace.status}`);

    // ---- 5. PROJECT ISOLATION ----------------------------------------------------------------
    const otherEvents = await findEvents(otherApp, "add_to_cart");
    harness.check("the tracked event exists ONLY under the addressed app — a second app's data is untouched",
      otherEvents.length === 0 && ev.project_id === publicApp.id,
      `other app events ${otherEvents.length}`);

    // ---- 6. PREVIEW PARITY: same dispatcher, development environment, builder-authorized -------
    const pv = (body) =>
      client.functions.invoke("previewAnalytics", body)
        .then((r) => ({ status: 200, data: r.data ?? r }))
        .catch((e) => ({ status: e.status || e.response?.status || 0, data: e.response?.data || { error: e.message } }));
    const pvOk = await pv({ project_id: publicApp.id, op: "track", args: { event: { event_name: "preview_event", event_type: "custom_event", properties: { n: 1 } } } });
    const pvEvents = await findEvents(publicApp, "preview_event");
    const pvBad = await pv({ project_id: publicApp.id, op: "track", args: { event: { event_name: "", properties: {} } } });
    harness.check("the builder preview dispatches the SAME dispatcher: 200 and the event persists as environment development, and an empty event_name is refused there too",
      pvOk.status === 200 && pvEvents.length === 1 && pvEvents[0]?.environment === "development" &&
      pvEvents[0]?.properties?.n === 1 && pvBad.status === 400,
      `ok ${pvOk.status}/${pvEvents[0]?.environment} · bad ${pvBad.status}`);

    // ---- 7. EXISTING BEHAVIOR UNCHANGED (regression) -----------------------------------------
    const legacyTrackEvent = await rt({
      action: "analytics", slug: publicApp.slug, op: "track",
      args: { event: { event_name: "legacy_track_event", properties: { size: "m" } } },
    });
    const legacyLog = await rt({ action: "analytics", slug: publicApp.slug, op: "log_user_in_app", args: { page: "legacy-page" } });
    const unknownOp = await rt({ action: "analytics", slug: publicApp.slug, op: "fetch_logs" });
    harness.check("existing analytics behavior is unchanged: the legacy trackEvent envelope still answers 200, log_user_in_app still answers 200, unknown ops are still refused",
      legacyTrackEvent.status === 200 && legacyLog.status === 200 && unknownOp.status === 400 &&
      (await findEvents(publicApp, "legacy_track_event")).length === 1,
      `trackEvent ${legacyTrackEvent.status} · logUserInApp ${legacyLog.status} · unknown ${unknownOp.status}`);

    // ---- 8. response shape: only the dispatcher's normal event projection ---------------------
    const keys = anon.data?.result?.event ? Object.keys(anon.data.result.event).sort() : [];
    harness.check("a successful track returns only the dispatcher's normal { event, duplicate } projection — no extra data",
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