// The public runtime's "notifications" action, shared so appRuntime and certification run the
// SAME code: session-bound, owner-scoped to the verified end user, independent of RLS.
import { handleAppNotifications } from "./appNotifications.ts";
import { resolveSession, readSessionToken } from "./appAuth.ts";

export async function runtimeNotificationsRoute(svc, { project, req = null, body = {} }) {
  const user = await resolveSession(svc, project.id, readSessionToken(req, body)).catch(() => null);
  try {
    const result = await handleAppNotifications(svc, { projectId: project.id, user, op: String(body.op || ""), args: body.args || {} });
    return { status: 200, body: { result } };
  } catch (e) {
    return { status: e.status || 400, body: { error: e.message, code: e.code || null } };
  }
}