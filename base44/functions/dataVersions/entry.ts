// Data Version History control plane — the audited Backup & Restore surface.
//
// DOCUMENTED (Enterprise/data-version-history): viewing, downloading and restoring backups
// need editor access to the app. Reads authorize with project.read; restore/undo mutate data
// and authorize with project.write. Both re-check the workspace role and lifecycle server-side
// through the one authorized-project choke point.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { dataVersionsSurface } from "../../shared/dataHistory.ts";

const WRITE_ACTIONS = new Set(["restore", "undo"]);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const action = String(body.action || "info");
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, body.project_id,
      WRITE_ACTIONS.has(action) ? "project.write" : "project.read",
    );
    const svc = base44.asServiceRole;
    const result = await dataVersionsSurface(svc, {
      ...body, project_id: project.id, workspace_id: workspace.id, user: { id: user.id },
    });
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `data_history.${action}`, resource: "DataCheckpoint",
      resource_id: String(body.checkpoint_id || body.batch_id || ""), metadata: { action },
    });
    return Response.json(result, { status: WRITE_ACTIONS.has(action) ? 202 : 200 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}