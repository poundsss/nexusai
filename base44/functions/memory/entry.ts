// Authorized surface for the Memory layer (user / project / platform knowledge).
//
// Minimal by design: create, retrieve, supersede (correct), archive, history. Every action resolves
// its scope ids server-side from the authenticated caller and the project it authorizes — a client
// cannot supply user_id, workspace_id, project_id, role or scope — and platform knowledge is
// writable only through the controlled platform-admin path. Retrieval is read-only and bounded.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createMemory, retrieveMemory, supersedeMemory, archiveMemory, restoreMemory, getMemoryHistory, MEMORY_LIMITS, MEMORY_TYPES, MEMORY_SCOPES } from "../../shared/memory.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "retrieve";

    if (action === "create") return Response.json(await createMemory(base44, user, body));
    if (action === "retrieve") return Response.json(await retrieveMemory(base44, user, body));
    if (action === "supersede") return Response.json(await supersedeMemory(base44, user, body));
    if (action === "archive") return Response.json(await archiveMemory(base44, user, body));
    if (action === "restore") return Response.json(await restoreMemory(base44, user, body));
    if (action === "history") return Response.json(await getMemoryHistory(base44, user, body));
    if (action === "contract") return Response.json({ scopes: MEMORY_SCOPES, memory_types: MEMORY_TYPES, limits: MEMORY_LIMITS });
    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}