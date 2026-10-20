// The member-authorized HTTP surface over outbound-only Customer Support (shared/growSupport.ts).
// Authorization mirrors the certified leadGen/listen/aeo surfaces: loadAuthorizedProject
// (project.read for reads, project.write for mutations), and an audit row per call.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { scheduleSupportMessage, listSupportHistory } from "../../shared/growSupport.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => ({}));
    const action = String(body.action || "history");
    const READ_ACTIONS = new Set(["history"]);
    if (!["send"].includes(action) && !READ_ACTIONS.has(action)) {
      return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, READ_ACTIONS.has(action) ? "project.read" : "project.write");
    const svc = base44.asServiceRole;
    let result;
    if (action === "send") {
      result = await scheduleSupportMessage(svc, project, workspace, { ...body, operator_email: user.email });
    } else {
      result = await listSupportHistory(svc, project, { limit: body.limit });
    }
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `support.${action}`, resource: "Customer", resource_id: project.id,
      metadata: { action },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}