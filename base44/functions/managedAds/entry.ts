// The member-authorized HTTP surface over shared/adsOptimization.ts. Reads project.read,
// mutations project.write — the same loadAuthorizedProject/audit pattern as the other surfaces.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { adsOptimizationSurface } from "../../shared/adsOptimization.ts";

export const config = { public: true };

const READ_ACTIONS = new Set(["recommend_list"]);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (!["recommend_generate", "recommend_list", "guardrail_set", "recommendation_accept"].includes(action)) {
      return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, READ_ACTIONS.has(action) ? "project.read" : "project.write");
    const svc = base44.asServiceRole;
    const result = await adsOptimizationSurface(svc, project, workspace, { id: user.id }, body);
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `managed_ads.${action}`, resource: "AdsPerformanceReport", resource_id: project.id,
      metadata: { action, channel: body.channel || "google" },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}