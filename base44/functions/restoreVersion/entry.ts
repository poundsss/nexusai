// Rollback endpoint: thin HTTP wrapper over the shared restore service.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { restoreProjectVersion } from "../../shared/versionRestore.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "version.restore");
    const out = await restoreProjectVersion(base44, {
      project, workspace, user, versionId: body.version_id,
      // Optimistic concurrency: the client states the version it was looking at.
      baseVersionNumber: body.base_version_number ?? null,
      // Explicit opt-in to a data-losing migration the engine would otherwise refuse.
      force: body.force === true,
    });
    return Response.json(out);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code, build_id: error.build_id, logs: error.logs, blocking: error.blocking }, { status: error.status || 500 });
  }
}