// Generated-app analytics inside the BUILDER PREVIEW (#30).
//
// The preview runs the same generated code a deployment runs, so `analytics.*` there must mean the
// same thing. This module is deliberately thin and creates NO second analytics architecture: the
// event contract, validation, credential policy, redaction, idempotency, sessions, identity linking
// and storage are all the EXISTING ones (analyticsContract / analyticsIngest via the ONE public
// dispatcher, handleAnalyticsRuntime). Only three things are decided here:
//
//   • AUTHORIZATION — the builder is authorized on the project through the EXISTING authz path
//     (`project.read`), so a preview can only write analytics for a project its caller may read.
//   • OWNERSHIP — the project comes from that authorized record and the end-user from the verified
//     #29 preview session, never from the submitted body.
//   • ENVIRONMENT — a preview is always `development`. Queries default to production, so preview
//     traffic is deterministically separated from a deployed app's real numbers instead of
//     polluting them.
import { loadAuthorizedProject } from "./authz.ts";
import { resolveSessionRecord, publicUser } from "./appAuth.ts";
import { handleAnalyticsRuntime, ANALYTICS_RUNTIME_OPS } from "./analyticsRuntime.ts";

/** A preview is never production or staging traffic. */
export const PREVIEW_ENVIRONMENT = "development";
export const PREVIEW_ANALYTICS_OPS = ANALYTICS_RUNTIME_OPS;

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

/** Handles ONE preview analytics operation. `platformUser` is the signed-in builder. */
export async function handlePreviewAnalytics(base44, platformUser, body = {}) {
  if (!platformUser?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const { project } = await loadAuthorizedProject(base44, platformUser, String(body.project_id || ""), "project.read");
  const svc = base44.asServiceRole || base44;
  // The previewed app's END-USER (#29), when one is signed in: an authenticated preview event is
  // attributed to that generated-app user and to nothing else — never to the builder's platform
  // account, which has no representation in a generated app's analytics.
  const resolved = body.session_token
    ? await resolveSessionRecord(svc, project.id, String(body.session_token)).catch(() => null)
    : null;
  return handleAnalyticsRuntime(svc, {
    project, environment: PREVIEW_ENVIRONMENT,
    user: resolved ? publicUser(resolved.user) : null, session: null,
    op: String(body.op || ""), args: body.args || {}, trace_id: body.trace_id || null,
  });
}