// Agent file store endpoint (Agent → More → Files). A thin authorized dispatch over the
// shared/agentFileStore.ts contract: the EXISTING rbac.resolveRole gate runs FIRST on every
// action (fail closed — a non-member is refused before anything is listed or changed), and
// file bytes always go through the platform's EXISTING private file storage.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  listFolder, createFolder, registerUpload, saveArtifact, zipFolder, requireWorkspaceMember,
} from "../../shared/agentFileStore.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const svc = base44.asServiceRole || base44;
    const ctx = await requireWorkspaceMember(svc, body.workspace_id, user);
    switch (String(body.action || "")) {
      case "list":
        return Response.json({ entries: await listFolder(svc, ctx, body) });
      case "createFolder":
        return Response.json({ entry: await createFolder(svc, ctx, body) });
      case "registerUpload":
        return Response.json({ entry: await registerUpload(svc, ctx, body) });
      case "saveArtifact":
        return Response.json({ entry: await saveArtifact(svc, ctx, body) });
      case "downloadZip":
        return Response.json(await zipFolder(svc, ctx, body));
      default:
        return Response.json({ error: `Unknown action "${body.action}"`, code: "BAD_ACTION" }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "STORE_ERROR" }, { status: error.status || 500 });
  }
}