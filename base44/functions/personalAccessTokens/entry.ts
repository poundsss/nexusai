// Personal Access Token control plane (Phase 13A).
//
// DOCUMENTED (Base44): PATs are managed under Workspace Settings → Secrets → Personal access
// tokens. Management is owner/admin (the secret.manage capability), G-2 lifecycle-gated and
// audited. The raw token value is returned exactly once, in the create response, and never
// again — list responses carry identification metadata only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { resolveRole, requireCapability, requireActiveWorkspace } from "../../shared/rbac.ts";
import { issuePersonalAccessToken, revokePersonalAccessToken, listPersonalAccessTokens, tokenView } from "../../shared/pat.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    const workspaceId = String(body.workspace_id || "");
    if (!workspaceId) return Response.json({ error: "workspace_id is required" }, { status: 400 });
    const workspace = await svc.entities.Workspace.get(workspaceId).catch(() => null);
    if (!workspace) return Response.json({ error: "Workspace not found" }, { status: 404 });
    const role = await resolveRole(base44, workspace, user);
    requireCapability(role, "secret.manage");
    if (action === "create" || action === "revoke") requireActiveWorkspace(workspace, "secret.manage");

    if (action === "create") {
      const res = await issuePersonalAccessToken(svc, {
        workspace_id: workspaceId, name: body.name, app_scope: body.app_scope,
        project_id: body.project_id || null, full_access: !!body.full_access,
        expires_at: body.expires_at || null, created_by: user.id,
      });
      return Response.json({ token: res.token, record: res.record });
    }
    if (action === "revoke") {
      const res = await revokePersonalAccessToken(svc, { workspace_id: workspaceId, token_id: body.token_id, revoked_by: user.id });
      return Response.json({ record: res.record, already_revoked: res.already_revoked });
    }
    if (action === "list") {
      return Response.json({ tokens: await listPersonalAccessTokens(svc, { workspace_id: workspaceId }) });
    }
    if (action === "get") {
      const rows = await svc.entities.PersonalAccessToken.filter({ workspace_id: workspaceId }, "-created_date", 100);
      const row = rows.find((r) => r.id === String(body.token_id || ""));
      if (!row) return Response.json({ error: "token not found" }, { status: 404 });
      return Response.json({ record: tokenView(row) });
    }
    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}