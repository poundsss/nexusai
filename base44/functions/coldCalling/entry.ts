// The member-authorized HTTP surface over NexusAI-native cold calling (shared/coldCalling.ts).
// Authorization mirrors the certified leadGen/listen surfaces: loadAuthorizedProject
// (project.read for reads, project.write for mutations), and an audit row per call.
// `status` needs no project: it answers with the certified telephony blocker as data.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { coldCallStatus, generateCallScript, scheduleCall, listCalls, getCall, projectCall, cancelCall, retryCall, callReport } from "../../shared/coldCalling.ts";
import { createTelephonyBoundary } from "../../shared/telephonyBoundary.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => ({}));
    const action = String(body.action || "status");

    if (action === "status") {
      return Response.json(coldCallStatus());
    }
    if (!["script", "schedule", "list", "get", "cancel", "retry", "report", "configuration", "provision"].includes(action)) {
      return Response.json({ error: `Unknown action "${action}" — use "status", "script", "schedule" or "list"`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, ["list", "get", "report", "configuration"].includes(action) ? "project.read" : "project.write");
    const svc = base44.asServiceRole;
    let result;
    if (action === "script") result = await generateCallScript(svc, project, workspace, { id: user.id }, body);
    else if (action === "schedule") result = await scheduleCall(svc, project, workspace, { id: user.id }, body);
    else if (action === "get") result = { call: projectCall(await getCall(svc, project, body.call_id)) };
    else if (action === "cancel") result = await cancelCall(svc, project, body.call_id);
    else if (action === "retry") result = await retryCall(svc, project, body.call_id);
    else if (action === "report") result = await callReport(svc, project);
    else if (action === "configuration") result = await createTelephonyBoundary().configuration();
    else if (action === "provision") result = await createTelephonyBoundary().provision();
    else result = await listCalls(svc, project, { limit: body.limit });
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `cold_calling.${action}`, resource: "ColdCall", resource_id: project.id,
      metadata: { action },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}