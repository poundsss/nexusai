// Mobile store control plane (P-10.3 phase 4): create/list/cancel store submissions and manage
// the workspace's store connections. Authorization is the EXISTING RBAC model, resolved
// server-side on every request:
//   deploy.manage → create / list / cancel submissions (project-scoped)
//   secret.manage → store connection credentials (workspace-scoped, owner/admin)
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { resolveRole, requireCapability, requireActiveWorkspace } from "../../shared/rbac.ts";
import { putStoreConnection, removeStoreConnection, describeStoreConnections } from "../../shared/mobileStoreConnections.ts";
import { createMobileStoreSubmission, cancelMobileStoreSubmission, listMobileStoreSubmissions } from "../../shared/mobileStorePublishing.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "create_submission");
    const svc = base44.asServiceRole;

    // ---- submissions (project-scoped, deploy.manage) ----
    if (action === "create_submission") {
      try {
        const out = await createMobileStoreSubmission(base44, user, { release_id: body.release_id });
        return Response.json({
          submission_id: out.submission.id, status: out.submission.status,
          store: out.submission.store, platform: out.submission.platform,
          checksum: out.submission.checksum, converged: !!out.converged,
        }, { status: 202 });
      } catch (e) {
        return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
      }
    }
    if (action === "cancel_submission") {
      try {
        const out = await cancelMobileStoreSubmission(base44, user, { submission_id: body.submission_id });
        return Response.json(out);
      } catch (e) {
        return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
      }
    }
    if (action === "list_submissions") {
      try {
        const out = await listMobileStoreSubmissions(base44, user, { project_id: body.project_id, platform: body.platform });
        return Response.json(out);
      } catch (e) {
        return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
      }
    }

    // ---- store connections (workspace-level, secret.manage: owner/admin) ----
    if (["put_store_connection", "delete_store_connection", "list_store_connections"].includes(action)) {
      const workspaceId = String(body.workspace_id || "");
      const workspace = workspaceId ? await svc.entities.Workspace.get(workspaceId).catch(() => null) : null;
      if (!workspace) return Response.json({ error: "Workspace not found" }, { status: 404 });
      const role = await resolveRole(base44, workspace, user);
      if (!role) return Response.json({ error: "Forbidden", code: "NOT_A_MEMBER" }, { status: 403 });
      requireCapability(role, "secret.manage");
      requireActiveWorkspace(workspace, "secret.manage");

      if (action === "put_store_connection") {
        try {
          const out = await putStoreConnection(svc, {
            workspace_id: workspaceId, platform: String(body.platform || ""),
            connection: body.connection, user_id: user.id, description: body.description || "",
          });
          return Response.json(out);
        } catch (e) {
          return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
        }
      }
      if (action === "delete_store_connection") {
        const out = await removeStoreConnection(svc, { workspace_id: workspaceId, platform: String(body.platform || ""), user_id: user.id });
        return Response.json(out);
      }
      const connections = await describeStoreConnections(svc, workspaceId);
      return Response.json({ connections });
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status || 500 });
  }
}