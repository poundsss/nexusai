// Authorized read surface for per-project integration call quotas (#31D).
//
// A thin, project-scoped list endpoint over the existing `listIntegrationQuotas()` shared
// function — the same authorized-backend-function pattern the breaker and rate-limit read
// surfaces use: authenticate the caller, authorize the project through `loadAuthorizedProject`
// (server-side role resolution, `project.read` capability), then read with the service role.
// The project id is resolved from the authorized project record, never from the client, so a
// caller can never read another project's quota state.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { listIntegrationQuotas } from "../../shared/integrationQuota.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    // Reading quota state is a project read.
    const { project } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");
    const quotas = await listIntegrationQuotas(base44.asServiceRole, { project_id: project.id, limit: 50 });
    return Response.json({ quotas });
  } catch (error) {
    return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status || 500 });
  }
}