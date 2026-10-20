// Builder/management control plane for Entity Trash (the audited Base44 trash contract).
//
// The audited surface is management-level: editor access, and RLS does not apply to the
// trash listing — so every action here (list included) requires the workspace's project.write
// capability through the EXISTING project authorization path (viewer is refused, matching the
// audited "read-only keys are not accepted"). The runtime db gains no trash operations.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { entityTrashSurface } from "../../shared/entityTrash.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.write");
    const result = await entityTrashSurface(base44.asServiceRole, {
      action: body.action, project_id: project.id, entity_name: body.entity_name,
      query: body.query, limit: body.limit, skip: body.skip, sort: body.sort, fields: body.fields,
      record_id: body.record_id, deleted_by: user.id,
    });
    await audit(base44, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `entityTrash.${body.action || ""}`, resource: "AppRecord",
      resource_id: body.record_id || project.id,
      metadata: { entity_name: body.entity_name || null, restored: result?.restored ?? null },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: Number(error?.status) || 500 });
  }
}