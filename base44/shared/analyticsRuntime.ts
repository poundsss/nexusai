// The PUBLIC runtime surface for generated-app analytics (#30).
//
// One dispatcher, shared by the public runtime endpoint and its focused tests, so the browser path
// and the tested path are literally the same code. It adds no capability of its own:
//   • ownership (project, workspace, environment, app_user, session) is passed in ALREADY RESOLVED
//     by the runtime — a submitted body can never claim any of it;
//   • validation, credential policy, redaction, idempotency, sessions and identity linking are the
//     ingestion contract's;
//   • an unknown op is refused rather than silently accepted.
import {
  ingestEvent, ingestBatch, enqueueIngestion, startSession, endSession, getCurrentSession, linkIdentity,
} from "./analyticsIngest.ts";
import { describeAnalyticsContract, assertEnvironment, ANALYTICS_LIMITS } from "./analyticsContract.ts";

export const ANALYTICS_RUNTIME_OPS = Object.freeze([
  "track", "track_batch", "track_async", "session_start", "session_end", "session_current", "link_identity", "contract",
  // DOCUMENTED (Base44 appLogs.logUserInApp, SDK 0.8.52): the single non-internal method of the
  // AppLogsModule, served as one alias over the SAME dispatcher — nothing new is enforced here.
  "log_user_in_app",
]);

/**
 * Executes ONE analytics operation for a deployed application.
 *
 * `user` / `session` are the verified #29 end-user and session (or null for an anonymous visitor);
 * an authenticated event is attributed to that user and nothing else. `environment` is the
 * environment the runtime resolved for the addressed app, so production analytics cannot be written
 * from a staging deployment.
 */
export async function handleAnalyticsRuntime(svc, { project, environment, user = null, session = null, op, args = {}, trace_id = null }) {
  const operation = String(op || "");
  if (!ANALYTICS_RUNTIME_OPS.includes(operation)) {
    throw Object.assign(new Error(`Unsupported analytics operation ${operation}`), { status: 400, code: "ANALYTICS_OP_UNSUPPORTED" });
  }
  if (operation === "contract") return { contract: describeAnalyticsContract(), limits: ANALYTICS_LIMITS };

  const context = {
    environment: assertEnvironment(environment),
    source: "client",
    app_user_id: user?.id || null,
    session_key: args.session_key ? String(args.session_key).slice(0, 120) : (session?.session_key || null),
    team_id: args.team_id || null,
    trace_id: trace_id || null,
  };

  switch (operation) {
    case "track":
      return ingestEvent(svc, project, args.event || args, context);
    case "track_batch":
      return ingestBatch(svc, project, args.events || [], context);
    case "track_async":
      return enqueueIngestion(svc, project, args.events || [args.event || args], { ...context, idempotency_key: args.idempotency_key || null });
    case "session_start":
      return startSession(svc, project, { ...args, environment: context.environment }, context);
    case "session_end":
      return endSession(svc, project, { session_key: context.session_key });
    case "session_current":
      return { session: await getCurrentSession(svc, project, { session_key: context.session_key }) };
    // DOCUMENTED (Base44 appLogs.logUserInApp(pageName)): POST /app-logs/{appId}/log-user-in-app/
    // {pageName} — no body, pageName is a URL path segment, available in ALL auth modes (anonymous
    // included). The mapping onto the #30 event contract — a page_view event named for the page —
    // is NEXUSAI-DERIVED (Base44 publishes no storage/dashboard projection). Validation, redaction,
    // limits, idempotency, attribution and auth behavior are entirely the existing ingestion
    // path's (ingestEvent); the pageName is bounded by the existing event/page identifiers.
    case "log_user_in_app": {
      const pageName = String(args.page_name ?? args.page ?? "").trim();
      if (!pageName) {
        throw Object.assign(new Error("pageName is required"), { status: 400, code: "APP_LOGS_PAGE_NAME_REQUIRED" });
      }
      return ingestEvent(svc, project, { event_name: pageName, event_type: "page_view", page: pageName }, context);
    }
    default: // link_identity — the app user must be the VERIFIED caller of this request.
      if (!user?.id) throw Object.assign(new Error("Sign in required"), { status: 401, code: "AUTH_REQUIRED" });
      return linkIdentity(svc, project, { session_key: context.session_key, app_user_id: user.id }, context);
  }
}