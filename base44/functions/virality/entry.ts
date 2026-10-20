// The member-authorized HTTP surface over the Virality Engine (shared/virality.ts),
// mirroring the documented Base44 Apps API virality section — WITHOUT the Base44 API/PAT
// dependency: the flow runs against NexusAI's own projects through loadAuthorizedProject
// (project authorization + the G-2 workspace lifecycle gate), and every action is audited.
//   • "state" reads with project.read; every mutating action requires project.write;
//   • a refused credit hold surfaces as the documented 402 INSUFFICIENT_CREDITS;
//   • generation conflicts surface as 409, validation as 400/422.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { viralitySurface } from "../../shared/virality.ts";
import { calendarSurface, CALENDAR_ACTIONS } from "../../shared/socialCalendar.ts";
import { tikTokSurface, TIKTOK_ACTIONS } from "../../shared/tiktokSurface.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json().catch(() => ({}));
    const action = String(body.action || "state");
    // Calendar reads (list, scheduling-job polling) are project.read; every mutating
    // calendar action and every Phase 1 mutation requires project.write.
    const scope = action === "state" || action === "calendar_list" || action === "calendar_schedule_job" || action === "tiktok_readiness"
      ? "project.read" : "project.write";
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, scope);
    const svc = base44.asServiceRole;
    // Phase 1 actions stay on the UNTOUCHED viralitySurface; calendar actions dispatch here.
    const result = TIKTOK_ACTIONS.has(action)
      ? await tikTokSurface(svc, project, { id: user.id }, body)
      : CALENDAR_ACTIONS.has(action)
        ? await calendarSurface(svc, project, workspace, { id: user.id }, body)
        : await viralitySurface(svc, project, workspace, { id: user.id }, body);
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `virality.${action}`, resource: "ViralityState", resource_id: project.id,
      metadata: { action, ...(action === "generate" ? { platforms: body.platforms || null } : {}) },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error.message, code: error.code || null },
      { status: error.status || 500 },
    );
  }
}