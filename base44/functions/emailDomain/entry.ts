// Custom email-domain control plane over the DOCUMENTED Base44 management API
// (docs.base44.com/api-reference — enable/list/replace/configure/disable email domains).
//
// Authorization is the existing project authorization path: reads require project.read,
// every mutation requires domain.manage, and the workspace lifecycle gate applies. The
// management PAT lives ONLY in the app's backend secrets (BASE44_MANAGEMENT_PAT) — it is
// read here, handed to the shared surface, and never returned, logged or mixed with the
// NexusAI nxpat_ token system.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { secrets } from "base44:runtime";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { emailDomainSurface } from "../../shared/emailDomainApi.ts";

function readSecret(name) {
  try { return secrets.get(name) || null; } catch { return null; }
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, body.project_id,
      action === "list" ? "project.read" : "domain.manage",
    );
    const result = await emailDomainSurface(base44.asServiceRole, {
      token: readSecret("BASE44_MANAGEMENT_PAT"),
      app_id: readSecret("BASE44_APP_ID"),
      action,
      domain: body.domain ?? null,
      sender_name: body.sender_name ?? null,
      from_email: body.from_email ?? null,
      project_id: project.id,
      workspace_id: workspace.id,
    });
    await audit(base44.asServiceRole, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `emailDomain.${action}`, resource: "EmailDomain", resource_id: project.id,
      metadata: { domain: body.domain || null },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: String(error?.message || error), code: error?.code || null },
      { status: Number(error?.status) || 500 },
    );
  }
}