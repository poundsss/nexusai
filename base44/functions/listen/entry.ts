// The member-authorized HTTP surface over NexusAI-native social listening (shared/growListening.ts).
// Authorization mirrors the certified leadGen/virality surfaces: loadAuthorizedProject
// (project.read for reads, project.write for mutations), and an audit row per call.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { addTerm, removeTerm, listTerms, runMonitor, buildReport, scheduleMonitoring } from "../../shared/growListening.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => ({}));
    const action = String(body.action || "term_list");
    const READ_ACTIONS = new Set(["term_list", "report"]);
    if (!["term_add", "term_remove", "run", "schedule"].includes(action) && !READ_ACTIONS.has(action)) {
      return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, READ_ACTIONS.has(action) ? "project.read" : "project.write");
    const svc = base44.asServiceRole;
    let result;
    if (action === "term_add") result = await addTerm(svc, project, workspace, body);
    else if (action === "term_remove") result = await removeTerm(svc, project, body.term_id);
    else if (action === "term_list") result = await listTerms(svc, project);
    else if (action === "run") result = await runMonitor(svc, project, workspace, { trigger: "manual" });
    else if (action === "report") result = await buildReport(svc, project, { since_days: body.since_days });
    else result = await scheduleMonitoring(svc, project, workspace, { interval_minutes: body.interval_minutes });
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `listen.${action}`, resource: "ListenTerm", resource_id: project.id,
      metadata: { action },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}