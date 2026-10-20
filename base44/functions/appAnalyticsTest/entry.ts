// Focused certification for GENERATED-APP analytics (#30).
//
//   generated app → event → validate → persist → query → API / dashboard
//
// Every layer is exercised through its REAL module: the preview surface (shared/previewAnalytics),
// the deployed public dispatcher (shared/analyticsRuntime), the ingestion contract, the query layer
// and the authorized operator API the dashboard calls. Nothing is stubbed, and the suite asserts the
// boundaries that make the architecture safe: project isolation, generated-app isolation,
// environment separation, malformed-event rejection, authorization, and that NexusAI's own platform
// analytics are untouched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handlePreviewAnalytics, PREVIEW_ENVIRONMENT, PREVIEW_ANALYTICS_OPS } from "../../shared/previewAnalytics.ts";
import { handleAnalyticsRuntime, ANALYTICS_RUNTIME_OPS } from "../../shared/analyticsRuntime.ts";
import { handleOperatorRequest } from "../../shared/analyticsOperator.ts";
import { ingestEvent, registerEventSchema, saveAnalyticsConfig, loadAnalyticsConfig, createAppAnalytics } from "../../shared/analyticsIngest.ts";
import { queryEvents, aggregate, funnel, errorAnalytics, exportEvents, querySessions } from "../../shared/analyticsQuery.ts";
import { ANALYTICS_CONTRACT_VERSION, ANALYTICS_LIMITS, describeAnalyticsContract } from "../../shared/analyticsContract.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { ensureSystemRoles, resolvePermissions, can } from "../../shared/appAccess.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";

const PASSWORD = "An4lytics-End-User!";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let ws = null, foreignWs = null;
  const projects = [];
  try {
    const platformUser = await base44.auth.me();
    if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });

    ws = await svc.entities.Workspace.create({ name: "App Analytics #30", owner_id: platformUser.id, credits_balance: 0 });
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "Analytics App", slug: `an-${crypto.randomUUID().slice(0, 8)}` });
    const neighbour = await svc.entities.Project.create({ workspace_id: ws.id, name: "Neighbour App", slug: `nb-${crypto.randomUUID().slice(0, 8)}` });
    foreignWs = await svc.entities.Workspace.create({ name: "Someone Else", owner_id: `other-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    const foreign = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "Not Mine", slug: `nx-${crypto.randomUUID().slice(0, 8)}` });
    projects.push(project.id, neighbour.id, foreign.id);
    const preview = (op, args = {}, extra = {}) => handlePreviewAnalytics(base44, platformUser, { project_id: project.id, op, args, ...extra });
    const production = (op, args = {}, extra = {}) => handleAnalyticsRuntime(svc, { project, environment: "production", op, args, ...extra });

    // --- 1. deterministic contract ------------------------------------------------------------
    const contract = describeAnalyticsContract();
    h.check("contract_is_deterministic_and_versioned",
      contract.contract_version === ANALYTICS_CONTRACT_VERSION && contract.event_types.includes("page_view") && contract.environments.includes("development"),
      contract.contract_version);
    h.check("preview_reuses_the_one_runtime_dispatcher",
      PREVIEW_ANALYTICS_OPS === ANALYTICS_RUNTIME_OPS && PREVIEW_ENVIRONMENT === "development",
      `ops=${PREVIEW_ANALYTICS_OPS.length} environment=${PREVIEW_ENVIRONMENT}`);

    // --- 2. preview: session + event creation + persistence -------------------------------------
    const sessionKey = `pv-${crypto.randomUUID().slice(0, 10)}`;
    const started = await preview("session_start", { session_key: sessionKey, page: "/home" });
    const tracked = await preview("track", { session_key: sessionKey, event: { event_name: "signup_clicked", event_type: "user_action", page: "/home", properties: { plan: "pro", seats: 3, trial: true } } });
    h.check("preview_session_created", started.created === true && started.session.environment === "development" && started.session.session_key === sessionKey, JSON.stringify(started.session.status));
    h.check("preview_event_created_and_attributed",
      !!tracked.event.event_id && tracked.event.source === "client" && tracked.event.environment === "development" && tracked.event.session_id === started.session.session_id,
      `event=${tracked.event.event_id}`);
    const storedRow = (await svc.entities.AppAnalyticsEvent.filter({ project_id: project.id, event_id: tracked.event.event_id }, "-created_date", 1))[0];
    h.check("event_persisted_with_server_resolved_ownership",
      !!storedRow && storedRow.project_id === project.id && storedRow.workspace_id === ws.id && storedRow.properties.seats === 3 && storedRow.properties.trial === true,
      `row=${storedRow?.id}`);
    const reloaded = await queryEvents(svc, project, { environment: "development" });
    h.check("persisted_event_reloads_from_storage",
      reloaded.events.some((e) => e.event_id === tracked.event.event_id) && reloaded.total_matched >= 1,
      `${reloaded.total_matched} event(s)`);

    // --- 3. deterministic identity + idempotency --------------------------------------------------
    const key = `ingest-${crypto.randomUUID().slice(0, 8)}`;
    const first = await preview("track", { session_key: sessionKey, event: { event_name: "checkout", ingestion_key: key } });
    const repeat = await preview("track", { session_key: sessionKey, event: { event_name: "checkout", ingestion_key: key } });
    h.check("event_identity_is_deterministic",
      repeat.duplicate === true && repeat.event.event_id === first.event.event_id && first.event.event_id !== tracked.event.event_id,
      `duplicate → ${repeat.event.event_id}`);

    // --- 4. generated-app end-user attribution (#29 session) ---------------------------------------
    const endUser = await signUpWithSession(svc, project, { email: `viewer-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PASSWORD }, {});
    const authedKey = `pv-${crypto.randomUUID().slice(0, 10)}`;
    await preview("session_start", { session_key: authedKey }, { session_token: endUser.token });
    const authedEvent = await preview("track", { session_key: authedKey, event: { event_name: "profile_saved" } }, { session_token: endUser.token });
    h.check("authenticated_preview_event_attributed_to_generated_user",
      authedEvent.event.app_user_id === endUser.user.id && authedEvent.event.anonymous_id === null,
      `app_user=${authedEvent.event.app_user_id}`);
    h.check("builder_platform_identity_never_attributed",
      authedEvent.event.app_user_id !== platformUser.id && (await svc.entities.AppAnalyticsEvent.filter({ project_id: project.id, app_user_id: platformUser.id }, "-created_date", 1)).length === 0,
      "no event is ever attributed to the NexusAI platform user");

    // --- 5. malformed events are refused -----------------------------------------------------------
    await h.expectThrow("malformed_missing_event_name", () => preview("track", { session_key: sessionKey, event: { properties: { a: 1 } } }), "ANALYTICS_EVENT_NAME_REQUIRED");
    await h.expectThrow("malformed_non_primitive_property", () => preview("track", { session_key: sessionKey, event: { event_name: "bad", properties: { nested: { a: 1 } } } }), "ANALYTICS_PROPERTY_TYPE");
    await h.expectThrow("malformed_properties_not_an_object", () => preview("track", { session_key: sessionKey, event: { event_name: "bad", properties: [1, 2] } }), "ANALYTICS_PROPERTIES_INVALID");
    await h.expectThrow("credential_property_refused", () => preview("track", { session_key: sessionKey, event: { event_name: "bad", properties: { api_key: "sk_live_abc123" } } }), "ANALYTICS_CREDENTIAL_PROPERTY");
    await h.expectThrow("credential_shaped_value_refused", () => preview("track", { session_key: sessionKey, event: { event_name: "bad", properties: { note: "eyJhbGciOiJIUzI1NiJ9.payload" } } }), "ANALYTICS_CREDENTIAL_PROPERTY");
    await h.expectThrow("too_many_properties_refused", () => preview("track", { session_key: sessionKey, event: { event_name: "bad", properties: Object.fromEntries(Array.from({ length: ANALYTICS_LIMITS.max_properties + 5 }, (_, i) => [`p${i}`, i])) } }), "ANALYTICS_TOO_MANY_PROPERTIES");
    await h.expectThrow("oversized_event_refused", () => preview("track", { session_key: sessionKey, event: { event_name: "bad", properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, "x".repeat(480)])) } }), "ANALYTICS_EVENT_TOO_LARGE");
    await h.expectThrow("unknown_analytics_op_refused", () => preview("delete_everything"), "ANALYTICS_OP_UNSUPPORTED");
    await h.expectThrow("oversized_batch_refused", () => preview("track_batch", { events: Array.from({ length: ANALYTICS_LIMITS.max_batch + 1 }, () => ({ event_name: "x" })) }), "ANALYTICS_BATCH_TOO_LARGE");
    const mixed = await preview("track_batch", { session_key: sessionKey, events: [{ event_name: "ok_one" }, { properties: {} }, { event_name: "ok_two" }] });
    h.check("batch_judges_each_event_independently", mixed.accepted === 2 && mixed.rejected === 1 && mixed.failures[0].index === 1, `accepted=${mixed.accepted} rejected=${mixed.rejected}`);
    const after = await svc.entities.AppAnalyticsEvent.filter({ project_id: project.id, event_name: "bad" }, "-created_date", 5);
    h.check("refused_events_are_never_stored", after.length === 0, `${after.length} rejected event(s) leaked into storage`);

    // --- 6. registered schema validation -----------------------------------------------------------
    await registerEventSchema(svc, project, { event_name: "purchase", required_properties: ["sku"], property_types: { sku: "string", amount: "number" }, strict: true });
    await h.expectThrow("schema_required_property_enforced", () => preview("track", { session_key: sessionKey, event: { event_name: "purchase", properties: { amount: 10 } } }), "ANALYTICS_SCHEMA_VIOLATION");
    await h.expectThrow("schema_strict_mode_enforced", () => preview("track", { session_key: sessionKey, event: { event_name: "purchase", properties: { sku: "A1", surprise: "x" } } }), "ANALYTICS_SCHEMA_VIOLATION");
    const good = await preview("track", { session_key: sessionKey, event: { event_name: "purchase", properties: { sku: "A1", amount: 10 } } });
    h.check("schema_conformant_event_accepted", good.event.event_name === "purchase" && good.event.event_version === 1, `v${good.event.event_version}`);

    // --- 7. production behaviour + environment separation --------------------------------------------
    const prodKey = `pr-${crypto.randomUUID().slice(0, 10)}`;
    await production("session_start", { session_key: prodKey });
    const prodEvent = await production("track", { session_key: prodKey, event: { event_name: "page_view", event_type: "page_view", page: "/pricing" } });
    const prodQuery = await queryEvents(svc, project, {});
    const devQuery = await queryEvents(svc, project, { environment: "development" });
    h.check("production_ingestion_works", prodEvent.event.environment === "production" && prodEvent.event.source === "client", prodEvent.event.event_id);
    h.check("preview_traffic_excluded_from_production_queries",
      prodQuery.events.every((e) => e.environment === "production") && prodQuery.events.some((e) => e.event_id === prodEvent.event.event_id) &&
      !prodQuery.events.some((e) => e.event_id === tracked.event.event_id) && devQuery.events.every((e) => e.environment === "development"),
      `production=${prodQuery.total_matched} development=${devQuery.total_matched}`);
    await h.expectThrow("invalid_environment_refused", () => handleAnalyticsRuntime(svc, { project, environment: "wherever", op: "track", args: { event: { event_name: "x" } } }), "ANALYTICS_ENVIRONMENT_INVALID");

    // --- 8. generated-app server-side surface (ctx.analytics) -----------------------------------------
    const serverAnalytics = createAppAnalytics(svc, { project, user: { id: endUser.user.id } });
    const serverEvent = await serverAnalytics.trackEvent("order_shipped", { carrier: "dhl" });
    h.check("backend_and_frontend_semantics_are_consistent",
      serverEvent.event.source === "server" && serverEvent.event.app_user_id === endUser.user.id &&
      serverAnalytics.contract_version === ANALYTICS_CONTRACT_VERSION && serverEvent.event.environment === "production",
      `source=${serverEvent.event.source}`);

    // --- 9. project + generated-app isolation ----------------------------------------------------------
    await ingestEvent(svc, neighbour, { event_name: "neighbour_only" }, { environment: "production", source: "client" });
    const mine = await queryEvents(svc, project, { limit: 500 });
    const theirs = await queryEvents(svc, neighbour, { limit: 500 });
    h.check("events_never_span_projects",
      !mine.events.some((e) => e.event_name === "neighbour_only") && theirs.events.every((e) => e.event_name === "neighbour_only") && theirs.project_id === neighbour.id,
      `mine=${mine.total_matched} theirs=${theirs.total_matched}`);
    await h.expectThrow("preview_analytics_requires_project_authorization", () => handlePreviewAnalytics(base44, platformUser, { project_id: foreign.id, op: "track", args: { event: { event_name: "x" } } }), null);
    await h.expectThrow("preview_analytics_requires_platform_session", () => handlePreviewAnalytics(base44, null, { project_id: project.id, op: "track", args: { event: { event_name: "x" } } }), "AUTH_REQUIRED");
    await h.expectThrow("cross_project_identity_link_refused",
      () => handleAnalyticsRuntime(svc, { project: neighbour, environment: "production", user: { id: endUser.user.id }, op: "link_identity", args: { session_key: `x-${crypto.randomUUID().slice(0, 6)}` } }), "ANALYTICS_SESSION_NOT_FOUND");

    // --- 10. query + dashboard/API retrieval -------------------------------------------------------------
    const overview = await aggregate(svc, project, { environment: "development" });
    const funnelResult = await funnel(svc, project, { environment: "development", steps: ["signup_clicked", "checkout"] });
    const errorsBefore = await errorAnalytics(svc, project, { environment: "development" });
    await preview("track", { session_key: sessionKey, event: { event_name: "boom", event_type: "error", error_code: "E_RENDER", error_category: "ui" } });
    const errorsAfter = await errorAnalytics(svc, project, { environment: "development" });
    h.check("aggregation_is_arithmetic_and_bounded",
      overview.totals.events >= 4 && overview.top_events.some((t) => t.key === "signup_clicked") && overview.range.days <= ANALYTICS_LIMITS.max_range_days,
      `events=${overview.totals.events} window=${overview.range.days}d`);
    h.check("funnel_is_ordered_and_deterministic", funnelResult.steps.length === 2 && funnelResult.entered >= 1 && funnelResult.steps[1].actors <= funnelResult.steps[0].actors, `entered=${funnelResult.entered} completed=${funnelResult.completed}`);
    h.check("error_analytics_reflects_new_events", errorsAfter.total_errors === errorsBefore.total_errors + 1 && errorsAfter.by_code.some((c) => c.key === "E_RENDER"), `${errorsBefore.total_errors} → ${errorsAfter.total_errors}`);
    const dashOverview = await handleOperatorRequest(base44, { project_id: project.id, action: "overview", params: { environment: "development" } });
    const dashEvents = await handleOperatorRequest(base44, { project_id: project.id, action: "events", params: { environment: "development", limit: 5 } });
    const dashSessions = await handleOperatorRequest(base44, { project_id: project.id, action: "sessions", params: { environment: "development" } });
    const dashExport = await handleOperatorRequest(base44, { project_id: project.id, action: "export", params: { environment: "development", limit: 10 } });
    // Compared against a FRESH aggregate: the dashboard must return exactly what the query layer
    // returns at the same moment (the earlier `overview` predates the error event tracked above).
    const currentOverview = await aggregate(svc, project, { environment: "development" });
    h.check("dashboard_api_serves_the_same_data",
      dashOverview.operator.kind === "workspace_user" && dashOverview.totals.events === currentOverview.totals.events &&
      dashEvents.events.length <= 5 && dashSessions.sessions.some((s) => s.session_key === sessionKey) && dashExport.format === "json" && dashExport.rows.length > 0,
      `overview=${dashOverview.totals.events} sessions=${dashSessions.sessions.length}`);
    h.check("dashboard_api_is_project_scoped",
      (await handleOperatorRequest(base44, { project_id: neighbour.id, action: "overview", params: {} })).totals.events === 1,
      "one project's dashboard reads only its own events");
    await h.expectThrow("dashboard_api_refuses_foreign_project", () => handleOperatorRequest(base44, { project_id: foreign.id, action: "overview", params: {} }), null);
    await h.expectThrow("dashboard_api_refuses_unknown_action", () => handleOperatorRequest(base44, { project_id: project.id, action: "drop_events" }), "ANALYTICS_OP_UNSUPPORTED");

    // --- 11. app-operator authorization --------------------------------------------------------------------
    // The REAL #29 role model: the project's own AppRole rows, resolved server-side. The default
    // end-user role ("user" → profile.*, team.read) grants no analytics permission, so the default
    // answer is no. Access is granted by a project-defined role holding EXACTLY analytics.read —
    // never a wildcard — which proves the permission is what is checked, not the role's name.
    const systemRoles = await ensureSystemRoles(svc, project);
    const { permissions: defaultPerms } = await resolvePermissions(svc, project, { roles: ["user"] });
    h.check("default_end_user_role_grants_no_analytics",
      !can(defaultPerms, "analytics.read") && !can(defaultPerms, "analytics.export") && !can(defaultPerms, "analytics.manage") && systemRoles.some((r) => r.key === "user"),
      `user role → ${defaultPerms.join(", ")}`);
    await h.expectThrow("end_user_cannot_read_analytics", () => handleOperatorRequest(base44, { project_id: project.id, action: "overview", app_session_token: endUser.token, params: {} }), "ANALYTICS_FORBIDDEN");
    await h.expectThrow("foreign_app_session_refused", () => handleOperatorRequest(base44, { project_id: neighbour.id, action: "overview", app_session_token: endUser.token, params: {} }), "AUTH_REQUIRED");

    await svc.entities.AppRole.create({ project_id: project.id, workspace_id: ws.id, key: "analyst", name: "Analyst", permissions: ["analytics.read"], system: false });
    await svc.entities.AppUser.update(endUser.user.id, { roles: ["analyst"] });
    const analystPerms = (await resolvePermissions(svc, project, { roles: ["analyst"] })).permissions;
    h.check("granted_permission_is_exactly_what_was_declared",
      can(analystPerms, "analytics.read") && !can(analystPerms, "analytics.export") && !can(analystPerms, "analytics.manage") && !analystPerms.includes("*"),
      `analyst → ${analystPerms.join(", ")}`);
    const operatorRead = await handleOperatorRequest(base44, { project_id: project.id, action: "overview", app_session_token: endUser.token, params: { environment: "development" } });
    h.check("app_operator_read_requires_project_permission", operatorRead.operator.kind === "app_user" && operatorRead.totals.events >= 1, `kind=${operatorRead.operator.kind}`);
    // analytics.read does NOT imply analytics.export or analytics.manage.
    await h.expectThrow("export_requires_its_own_permission", () => handleOperatorRequest(base44, { project_id: project.id, action: "export", app_session_token: endUser.token, params: {} }), "ANALYTICS_FORBIDDEN");
    await h.expectThrow("configuration_requires_manage_permission", () => handleOperatorRequest(base44, { project_id: project.id, action: "update_config", app_session_token: endUser.token, params: { retention_days: 5 } }), "ANALYTICS_FORBIDDEN");
    await svc.entities.AppUser.update(endUser.user.id, { roles: ["user"] });
    await h.expectThrow("permission_revocation_takes_effect", () => handleOperatorRequest(base44, { project_id: project.id, action: "overview", app_session_token: endUser.token, params: {} }), "ANALYTICS_FORBIDDEN");

    // --- 12. privacy configuration + export redaction --------------------------------------------------------
    await saveAnalyticsConfig(svc, project, { suppressed_properties: ["plan"] }, { actor: platformUser.id });
    const cfg = await loadAnalyticsConfig(svc, project);
    const redacted = await exportEvents(svc, project, { environment: "development", limit: 200 }, { config: cfg });
    const exportedRow = redacted.rows.find((r) => r.event_id === tracked.event.event_id);
    h.check("export_re_redacts_suppressed_properties",
      !!exportedRow && exportedRow.properties.plan === undefined && exportedRow.redactions.includes("plan") && exportedRow.properties.seats === 3,
      JSON.stringify(exportedRow?.properties || {}));
    h.check("config_is_project_scoped", cfg.suppressed_properties.includes("plan") && (await loadAnalyticsConfig(svc, neighbour)).suppressed_properties.length === 0, "a neighbour's privacy configuration is unaffected");

    // --- 13. platform analytics untouched -----------------------------------------------------------------------
    const platformUsage = await svc.entities.UsageEvent.filter({ project_id: project.id }, "-created_date", 5).catch(() => []);
    const platformActivity = await svc.entities.Activity.filter({ project_id: project.id }, "-created_date", 5).catch(() => []);
    h.check("generated_app_analytics_separate_from_platform_analytics",
      platformUsage.length === 0 && platformActivity.length === 0,
      `usage=${platformUsage.length} activity=${platformActivity.length} — app events live only in AppAnalyticsEvent`);
    const legacySessions = await querySessions(svc, project, { environment: "development" });
    h.check("legacy_query_surfaces_unchanged",
      legacySessions.sessions.every((s) => s.project_id === project.id) && ANALYTICS_CONTRACT_VERSION === "nexusai-app-analytics-1",
      `sessions=${legacySessions.sessions.length}`);

    for (const p of projects) {
      for (const name of ["AppAnalyticsEvent", "AppAnalyticsSession", "AppEventSchema", "AppAnalyticsConfig", "AppUser", "AppSession", "AppRole", "AuditLog", "TraceEvent"]) {
        await purgeBy(svc, name, { project_id: p });
      }
    }
    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await cleanupWorkspace(svc, ws ? ws.id : null, ["Project", "AuditLog"]).catch(() => {});
    await cleanupWorkspace(svc, foreignWs ? foreignWs.id : null, ["Project", "AuditLog"]).catch(() => {});
  }
}