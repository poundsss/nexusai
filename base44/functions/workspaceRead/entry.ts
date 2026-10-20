// The ONE authorized surface the browser uses for Workspace / WorkspaceMember / Project /
// Deployment / AppRecord reads (and the two scoped mutations: record clear + workspace
// rename) after their direct SDK access is locked by RLS. Thin adapter over
// shared/workspaceRead.ts: authenticate, dispatch, map errors to status codes.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  workspaceProjectsRead, workspaceProjectRead, workspaceMembersRead, workspaceDeploymentsRead,
  workspaceRecordsRead, workspaceRecordsClear, workspaceRename, ownWorkspacesRead,
} from "../../shared/workspaceRead.ts";

export const config = { method: "POST" };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me().catch(() => null);
  if (!user) return Response.json({ error: "Unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const HANDLERS = {
    projects: (b) => workspaceProjectsRead(base44, user, b),
    project: (b) => workspaceProjectRead(base44, user, b.project_id),
    members: (b) => workspaceMembersRead(base44, user, b.workspace_id),
    deployments: (b) => workspaceDeploymentsRead(base44, user, b),
    records: (b) => workspaceRecordsRead(base44, user, b),
    clear_records: (b) => workspaceRecordsClear(base44, user, b),
    rename_workspace: (b) => workspaceRename(base44, user, b),
    own_workspaces: () => ownWorkspacesRead(base44, user),
  };

  const handler = HANDLERS[body?.action];
  if (!handler) return Response.json({ error: "Unknown action" }, { status: 400 });
  try {
    return Response.json(await handler(body));
  } catch (e) {
    const status = Number(e?.status ?? e?.response?.status) || 500;
    const safe = status !== 500;
    return Response.json(
      { error: safe ? e.message : "Request failed", code: e?.code },
      { status },
    );
  }
}