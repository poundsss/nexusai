// The member-authorized HTTP surface over NexusAI-native lead generation (shared/growLeadGen.ts).
// Authorization mirrors the certified virality surface: loadAuthorizedProject (project.read for
// lists, project.write for generation), the workspace lifecycle gate, and an audit row per call.
// Refused credit holds surface as 402 INSUFFICIENT_CREDITS; validation as 400/422.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { generateProspects, listProspects } from "../../shared/growLeadGen.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    const scope = action === "list" ? "project.read" : action === "generate" ? "project.write" : null;
    if (!scope) return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, scope);
    const svc = base44.asServiceRole;
    const result = action === "generate"
      ? await generateProspects(svc, project, workspace, { id: user.id }, body)
      : await listProspects(svc, project, { status: body.status || null, limit: body.limit });
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `leadgen.${action}`, resource: "Customer", resource_id: project.id,
      metadata: { action, ...(action === "generate" ? { request_key: result.request_key } : {}) },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error.message, code: error.code || null },
      { status: error.status || 500 },
    );
  }
}