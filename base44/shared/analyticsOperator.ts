// The authorized analytics OPERATOR boundary (#30).
//
// It adds no query logic of its own: every action delegates to the existing analyticsQuery layer (or
// the ingestion module's config / schema registry) AFTER ownership and permission are resolved
// server-side.
//
// Two operator identities, both resolved from facts the caller cannot assert:
//   • Workspace operator — the authenticated platform user, authorized through the platform's
//     EXISTING path (loadAuthorizedProject → workspace role capability): project.read for reads,
//     project.write for configuration.
//   • App operator — a generated-app end-user presenting a #29 session token. The session is
//     resolved against the ADDRESSED project (a token from another project resolves to nothing) and
//     must hold analytics.read / analytics.export / analytics.manage through the project's own roles.
//
// A client-supplied project_id is only a LOOKUP key — membership or a project-scoped session must
// independently prove access to it — and workspace_id is never read from the request. Ranges,
// pagination and result sizes are bounded by the analytics contract. Nothing here mutates auth,
// primitive or workflow state.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { enforceLimit, identityFor } from "./apiLimits.ts";
import { recordSpan, scrub } from "./tracing.ts";
import { describeAnalyticsContract, ANALYTICS_LIMITS } from "./analyticsContract.ts";
import { loadAnalyticsConfig, saveAnalyticsConfig, registerEventSchema, listEventSchemas, assertAnalyticsPermission } from "./analyticsIngest.ts";
import {
  queryEvents, aggregate, funnel, retention, errorAnalytics, performanceAnalytics, querySessions, exportEvents, salesOverview,
} from "./analyticsQuery.ts";
import { resolveSessionRecord, publicUser } from "./appAuth.ts";

// action → { permission (app operator), capability (workspace operator) }
export const OPERATOR_ACTIONS = {
  overview: { permission: "analytics.read", capability: "project.read" },
  sales: { permission: "analytics.read", capability: "project.read" },
  events: { permission: "analytics.read", capability: "project.read" },
  funnel: { permission: "analytics.read", capability: "project.read" },
  retention: { permission: "analytics.read", capability: "project.read" },
  errors: { permission: "analytics.read", capability: "project.read" },
  performance: { permission: "analytics.read", capability: "project.read" },
  sessions: { permission: "analytics.read", capability: "project.read" },
  schemas: { permission: "analytics.read", capability: "project.read" },
  config: { permission: "analytics.read", capability: "project.read" },
  export: { permission: "analytics.export", capability: "project.read" },
  update_config: { permission: "analytics.manage", capability: "project.write" },
  register_schema: { permission: "analytics.manage", capability: "project.write" },
};

export const describeOperatorApi = () => ({ ...describeAnalyticsContract(), actions: Object.keys(OPERATOR_ACTIONS), limits: ANALYTICS_LIMITS });

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

/** Handles ONE operator request. `base44` is the request's client; the service role reads data. */
export async function handleOperatorRequest(base44, body = {}) {
  const svc = base44.asServiceRole || base44;
  const action = String(body.action || "capabilities");
  if (action === "capabilities") return describeOperatorApi();
  const spec = OPERATOR_ACTIONS[action];
  if (!spec) fail(400, "ANALYTICS_OP_UNSUPPORTED", `Unknown action: ${action}`);

  const project_id = String(body.project_id || "");
  if (!project_id) fail(400, "ANALYTICS_PROJECT_REQUIRED", "project_id is required");

  let project, operator, config = null;
  if (body.app_session_token) {
    const resolved = await resolveSessionRecord(svc, project_id, String(body.app_session_token));
    if (!resolved) fail(401, "AUTH_REQUIRED", "Sign in required");
    project = await svc.entities.Project.get(project_id).catch(() => null);
    if (!project) fail(404, "ANALYTICS_PROJECT_NOT_FOUND", "Project not found");
    // The project's configuration is loaded FIRST so its optional permission override is honoured;
    // it is reused below, so this adds no second read.
    config = await loadAnalyticsConfig(svc, project);
    await assertAnalyticsPermission(svc, project, publicUser(resolved.user), spec.permission, { config });
    operator = { kind: "app_user", id: resolved.user.id };
  } else {
    const user = await base44.auth.me().catch(() => null);
    if (!user) fail(401, "AUTH_REQUIRED", "Unauthorized");
    const authorized = await loadAuthorizedProject(base44, user, project_id, spec.capability);
    project = authorized.project;
    operator = { kind: "workspace_user", id: user.id, role: authorized.role };
    // The EXISTING durable control-plane limiter, keyed by the server-derived identity.
    await enforceLimit(base44, { identity: identityFor({ user, workspace_id: project.workspace_id }), action: "default", workspace_id: project.workspace_id });
  }

  const params = body.params || {};
  config = config || await loadAnalyticsConfig(svc, project);
  const trace_id = body.trace_id || null;
  let result;
  switch (action) {
    case "overview": result = await aggregate(svc, project, params); break;
    case "sales": result = await salesOverview(svc, project, params); break;
    case "events": result = await queryEvents(svc, project, params); break;
    case "funnel": result = await funnel(svc, project, params); break;
    case "retention": result = await retention(svc, project, params); break;
    case "errors": result = await errorAnalytics(svc, project, params); break;
    case "performance": result = await performanceAnalytics(svc, project, params); break;
    case "sessions": result = await querySessions(svc, project, params); break;
    case "schemas": result = { schemas: await listEventSchemas(svc, project) }; break;
    case "config": result = { config }; break;
    case "export": result = await exportEvents(svc, project, params, { config }); break;
    case "update_config": result = { config: await saveAnalyticsConfig(svc, project, params, { actor: operator.id, trace_id }) }; break;
    case "register_schema": result = { schema: await registerEventSchema(svc, project, params, { actor: operator.id }) }; break;
  }

  // Exporting analytics is itself an event; every action is traced through the existing span system.
  if (action === "export") {
    await audit(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: operator.kind === "workspace_user" ? operator.id : null,
      action: "app_analytics.exported", resource: "AppAnalyticsEvent", resource_id: null,
      metadata: scrub({ operator: operator.kind, returned: result.returned, range: result.range, environment: result.environment }),
    }).catch(() => {});
  }
  if (trace_id) {
    await recordSpan(svc, {
      trace_id, workspace_id: project.workspace_id, project_id: project.id, event_type: "function_exec",
      name: `app_analytics.${action}`, status: "ok", reference_id: project.id, metadata: { operator: operator.kind },
    }).catch(() => {});
  }
  return { ...result, operator: { kind: operator.kind } };
}