// Member-authorized HTTP surface for the workspace "All Agents" view: a thin READ-ONLY
// projection over the EXISTING project-file agent model (shared/workspaceAgents.ts →
// certified agentResource.collectAgents). The gate is the EXISTING rbac.resolveRole — a
// non-member is refused before anything is listed (fail closed); no lifecycle write is
// possible here because the surface performs none.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { listWorkspaceAgents } from "../../shared/workspaceAgents.ts";
import { resolveRole } from "../../shared/rbac.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json().catch(() => ({}));
    const svc = base44.asServiceRole || base44;
    const workspace = await svc.entities.Workspace.get(String(body.workspace_id || "")).catch(() => null);
    if (!workspace) return Response.json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" }, { status: 404 });
    const role = await resolveRole(svc, workspace, user);
    if (!role) return Response.json({ error: "You do not have access to this workspace", code: "FORBIDDEN" }, { status: 403 });
    return Response.json(await listWorkspaceAgents(svc, workspace, user));
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "AGENTS_LIST_ERROR" }, { status: error.status || 500 });
  }
}