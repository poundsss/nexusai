// Focused certification for the #30 analytics OPERATOR endpoint only.
//
// The real endpoint handler is invoked with real Requests (the incoming request's headers are
// forwarded so the handler builds its own client exactly as in production), against real events in
// a throwaway workspace. Only the operator boundary is exercised here — ingestion, sessions and the
// runtime action are covered by analyticsRuntimeTest.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handleOperatorRequest } from "../../shared/analyticsOperator.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { ensureSystemRoles, defineRole, assignRoles } from "../../shared/appAccess.ts";
import { ingestEvent } from "../../shared/analyticsIngest.ts";
import { ANALYTICS_LIMITS } from "../../shared/analyticsContract.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const PASSWORD = "Op3rator-Pass!";
const ENTITY_NAMES = ["AppAnalyticsEvent", "AppAnalyticsSession", "AppAnalyticsConfig", "AppEventSchema", "AppUser", "AppSession", "AppRole", "AuditLog", "TraceEvent"];

export default async function (req) {
  const client = createClientFromRequest(req);
  const svc = client.asServiceRole;
  const h = createHarness();
  let ws = null, project = null, other = null;
  // Exercises the REAL handler, and maps its thrown failures the way the endpoint does.
  const call = async (body) => {
    try {
      return { status: 200, body: await handleOperatorRequest(client, body) };
    } catch (e) {
      return { status: e.status || 500, body: { error: e.message, code: e.code || "ERROR" } };
    }
  };

  try {
    ws = await svc.entities.Workspace.create({ name: "Analytics Operator #30", owner_id: `ao-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    project = await svc.entities.Project.create({ workspace_id: ws.id, name: "Operator App", slug: `op-${crypto.randomUUID().slice(0, 8)}` });
    other = await svc.entities.Project.create({ workspace_id: ws.id, name: "Other App", slug: `oo-${crypto.randomUUID().slice(0, 8)}` });
    const meta = { ip: "203.0.113.4", user_agent: "cert/1.0" };

    // --- operators + a plain end-user ------------------------------------------------------------
    await ensureSystemRoles(svc, project);
    const adminSeed = await signUpWithSession(svc, project.id, { email: `seed-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }, meta);
    await svc.entities.AppUser.update(adminSeed.user.id, { roles: ["admin"] });
    const adminRow = await svc.entities.AppUser.get(adminSeed.user.id);
    const adminCtx = { user: { id: adminRow.id }, permissions: ["*"] };
    await defineRole(svc, project, adminCtx, { key: "analyst", name: "Analyst", permissions: ["analytics.read"] }, meta);
    await defineRole(svc, project, adminCtx, { key: "exporter", name: "Exporter", permissions: ["analytics.read", "analytics.export"] }, meta);

    const analyst = await signUpWithSession(svc, project.id, { email: `analyst-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }, meta);
    await assignRoles(svc, project, adminCtx, { app_user_id: analyst.user.id, roles: ["analyst"] }, meta);
    const exporter = await signUpWithSession(svc, project.id, { email: `export-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }, meta);
    await assignRoles(svc, project, adminCtx, { app_user_id: exporter.user.id, roles: ["exporter"] }, meta);
    const plain = await signUpWithSession(svc, project.id, { email: `plain-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }, meta);
    const foreign = await signUpWithSession(svc, other.id, { email: `foreign-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }, meta);

    // --- real events in both projects -------------------------------------------------------------
    const ctxFor = (p, u = null) => ({ environment: "production", source: "server", app_user_id: u, session_key: `s-${p.id}` });
    for (const name of ["signup_started", "signup_completed", "checkout"]) {
      await ingestEvent(svc, project, { event_name: name, properties: { plan: "pro" } }, ctxFor(project, adminRow.id));
    }
    await ingestEvent(svc, project, { event_name: "boom", event_type: "error", error_code: "E_FAIL", error_category: "runtime", page: "/checkout" }, ctxFor(project, adminRow.id));
    await ingestEvent(svc, project, { event_name: "render", event_type: "performance", duration_ms: 120 }, ctxFor(project, adminRow.id));
    await ingestEvent(svc, other, { event_name: "other_only" }, ctxFor(other));

    // --- contract + unknown action ----------------------------------------------------------------
    const caps = await call({ action: "capabilities" });
    h.check("capabilities need no authorization", caps.status === 200 && caps.body.actions.includes("funnel") && caps.body.permissions.includes("analytics.read"), caps.body.contract_version);
    const bogus = await call({ action: "drop_everything", project_id: project.id });
    h.check("unknown action refused", bogus.status === 400 && bogus.body.code === "ANALYTICS_OP_UNSUPPORTED", bogus.body.error);
    const noProject = await call({ action: "overview" });
    h.check("project_id required", noProject.status === 400 && noProject.body.code === "ANALYTICS_PROJECT_REQUIRED", noProject.body.code);

    // --- authorization ----------------------------------------------------------------------------
    const anon = await call({ action: "overview", project_id: project.id, app_session_token: "not-a-real-token" });
    h.check("invalid session refused", anon.status === 401 && anon.body.code === "AUTH_REQUIRED", anon.body.code);
    const denied = await call({ action: "overview", project_id: project.id, app_session_token: plain.token });
    h.check("plain end-user cannot read analytics", denied.status === 403 && denied.body.code === "ANALYTICS_FORBIDDEN", denied.body.error);
    const crossProject = await call({ action: "overview", project_id: project.id, app_session_token: foreign.token });
    h.check("foreign project token resolves to nothing", crossProject.status === 401, `${crossProject.status} ${crossProject.body.code}`);
    const exportDenied = await call({ action: "export", project_id: project.id, app_session_token: analyst.token });
    h.check("export requires analytics.export", exportDenied.status === 403 && exportDenied.body.code === "ANALYTICS_FORBIDDEN", exportDenied.body.error);
    const manageDenied = await call({ action: "update_config", project_id: project.id, app_session_token: exporter.token, params: { retention_days: 5 } });
    h.check("config change requires analytics.manage", manageDenied.status === 403, manageDenied.body.code);

    // --- query capabilities -----------------------------------------------------------------------
    const overview = await call({ action: "overview", project_id: project.id, app_session_token: analyst.token });
    const t = overview.body.totals || {};
    h.check("counts + unique users + unique sessions", overview.status === 200 && t.events === 5 && t.unique_users === 1 && t.unique_sessions === 1, JSON.stringify(t));
    h.check("time series returned", Array.isArray(overview.body.time_series) && overview.body.time_series.length >= 1, `${(overview.body.time_series || []).length} bucket(s)`);
    h.check("top events returned", (overview.body.top_events || []).some((e) => e.key === "checkout"), JSON.stringify((overview.body.top_events || []).map((e) => e.key)));
    h.check("results are project-isolated", !(overview.body.top_events || []).some((e) => e.key === "other_only"), "the other project's event never appears");

    const errors = await call({ action: "errors", project_id: project.id, app_session_token: analyst.token });
    h.check("error analytics", errors.status === 200 && errors.body.total_errors === 1 && errors.body.by_code[0].key === "E_FAIL", JSON.stringify(errors.body.by_code));
    const perf = await call({ action: "performance", project_id: project.id, app_session_token: analyst.token });
    h.check("performance analytics", perf.status === 200 && perf.body.by_event.some((g) => g.key === "render" && g.avg_duration_ms === 120), JSON.stringify(perf.body.by_event));

    const fun = await call({ action: "funnel", project_id: project.id, app_session_token: analyst.token, params: { steps: ["signup_started", "signup_completed"] } });
    h.check("funnel computed", fun.status === 200 && fun.body.entered === 1 && fun.body.completed === 1 && fun.body.steps.length === 2, `rate=${fun.body.conversion_rate}`);
    const badFunnel = await call({ action: "funnel", project_id: project.id, app_session_token: analyst.token, params: { steps: ["only_one"] } });
    h.check("funnel needs two steps", badFunnel.status === 400 && badFunnel.body.code === "ANALYTICS_FUNNEL_INVALID", badFunnel.body.code);

    const ret = await call({ action: "retention", project_id: project.id, app_session_token: analyst.token, params: { period_days: 7 } });
    h.check("retention cohorts", ret.status === 200 && ret.body.period_days === 7 && Array.isArray(ret.body.cohorts), `${(ret.body.cohorts || []).length} cohort(s)`);
    const sessions = await call({ action: "sessions", project_id: project.id, app_session_token: analyst.token });
    h.check("sessions listed", sessions.status === 200 && sessions.body.sessions.length === 1, `${sessions.body.returned} session(s)`);

    // --- bounds + pagination ------------------------------------------------------------------------
    const page1 = await call({ action: "events", project_id: project.id, app_session_token: analyst.token, params: { limit: 2, offset: 0 } });
    const page2 = await call({ action: "events", project_id: project.id, app_session_token: analyst.token, params: { limit: 2, offset: 2 } });
    h.check("pagination bounded and stable", page1.body.events.length === 2 && page1.body.has_more === true && page2.body.events.length === 2 && page1.body.events[0].event_id !== page2.body.events[0].event_id, `total=${page1.body.total_matched}`);
    const huge = await call({ action: "events", project_id: project.id, app_session_token: analyst.token, params: { limit: 100000 } });
    h.check("result limit clamped", huge.body.limit === ANALYTICS_LIMITS.max_query_limit, `limit=${huge.body.limit}`);
    const wide = await call({ action: "overview", project_id: project.id, app_session_token: analyst.token, params: { from: "2000-01-01T00:00:00.000Z" } });
    h.check("time range clamped", wide.body.range.days <= ANALYTICS_LIMITS.max_range_days && wide.body.range.truncated === true, `days=${wide.body.range.days}`);
    const badEnv = await call({ action: "overview", project_id: project.id, app_session_token: analyst.token, params: { environment: "wherever" } });
    h.check("environment validated", badEnv.status === 400 && badEnv.body.code === "ANALYTICS_ENVIRONMENT_INVALID", badEnv.body.code);

    // --- export + config/schema management ----------------------------------------------------------
    const exported = await call({ action: "export", project_id: project.id, app_session_token: exporter.token, params: { limit: 10 } });
    h.check("export authorized and bounded", exported.status === 200 && exported.body.rows.length === 5 && exported.body.limit === 10, `returned=${exported.body.returned}`);
    const exportAudit = await svc.entities.AuditLog.filter({ project_id: project.id, action: "app_analytics.exported" }, "-created_date", 5).catch(() => []);
    h.check("export audited", exportAudit.length >= 1, `${exportAudit.length} audit row(s)`);

    const admin = await signUpWithSession(svc, project.id, { email: `mgr-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }, meta);
    await assignRoles(svc, project, adminCtx, { app_user_id: admin.user.id, roles: ["admin"] }, meta);
    const saved = await call({ action: "update_config", project_id: project.id, app_session_token: admin.token, params: { retention_days: 30, suppressed_properties: ["plan"] } });
    h.check("config updated by manager", saved.status === 200 && saved.body.config.retention_days === 30, JSON.stringify(saved.body.config.suppressed_properties));
    const redacted = await call({ action: "export", project_id: project.id, app_session_token: exporter.token, params: { limit: 10 } });
    h.check("export re-applies suppression", redacted.body.rows.every((r) => !("plan" in (r.properties || {}))) && redacted.body.rows.some((r) => (r.redactions || []).includes("plan")), "suppressed property removed on the way out");
    const schema = await call({ action: "register_schema", project_id: project.id, app_session_token: admin.token, params: { event_name: "checkout", property_types: { plan: "string" }, strict: true } });
    h.check("schema registered", schema.status === 200 && schema.body.schema.event_name === "checkout", `v${schema.body.schema.event_version}`);
    const schemas = await call({ action: "schemas", project_id: project.id, app_session_token: analyst.token });
    h.check("schemas readable", schemas.body.schemas.some((s) => s.event_name === "checkout"), `${schemas.body.schemas.length} schema(s)`);

    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  } finally {
    for (const name of ENTITY_NAMES) {
      for (const p of [project?.id, other?.id].filter(Boolean)) {
        for (const r of await svc.entities[name].filter({ project_id: p }, "-created_date", 500).catch(() => [])) {
          await svc.entities[name].delete(r.id).catch(() => {});
        }
      }
    }
    await cleanupWorkspace(svc, ws ? ws.id : null, ["Project", "AuditLog"]).catch(() => {});
  }
}