// Enqueue endpoint. Validates, authorizes, persists the run as QUEUED and returns immediately.
// The actual orchestration runs in the background: creating the AIRun record fires the
// "AI Run Executor" workflow, which drives the run's phases via the aiRunStep function.
// This request never waits for model calls, tool execution, build, repair or versioning.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { enqueueRun } from "../../shared/runEnqueue.ts";
import { enforceLimit, identityFor } from "../../shared/apiLimits.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const mode = ["discuss", "edit"].includes(body.mode) ? body.mode : "default";
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id);
    // AI runs are the platform's most expensive action, so the ceiling is enforced per
    // authenticated caller and workspace — server-derived, never taken from the request.
    await enforceLimit(base44, { identity: identityFor({ user, workspace_id: workspace.id }), action: "ai_run", workspace_id: workspace.id });
    const out = await enqueueRun(base44, { project, prompt: body.prompt, mode, conversationId: body.conversation_id, modelId: body.model_id || null, imageUrls: body.image_urls || null });
    return Response.json(out, { status: 202 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}