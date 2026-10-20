// The member-authorized HTTP surface over the FINAL Grow integration (shared/growStatus.ts).
// A read-only rollup: project.read is enough; an audit row records each call.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { buildGrowStatus } from "../../shared/growStatus.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => ({}));
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");
    const result = await buildGrowStatus(base44.asServiceRole, project);
    await audit(base44.asServiceRole, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: "grow.status", resource: "Project", resource_id: project.id,
      metadata: { action: "status" },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}