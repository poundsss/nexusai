// The member-authorized HTTP surface over cold-email outreach (shared/outreach.ts).
// Authorization mirrors the certified support surface: loadAuthorizedProject (project.read for
// reads, project.write for mutations), an audit row per call, and the module's own fail-closed
// refusals (CUSTOMER_REQUIRED, CUSTOMER_NOT_FOUND, EMAIL_REQUIRED, EMAIL_INVALID, SELF_SEND,
// CONTENT_REQUIRED, TOO_MANY_FOLLOW_UPS) BEFORE anything is scheduled. NO send happens here:
// scheduling enqueues idempotent steps into the EXISTING job queue (the certified jobHandlers
// registry owns execution); the surface never touches SendEmail itself.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { scheduleOutreach, OUTREACH_JOB_TYPE } from "../../shared/outreach.ts";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET" ? Object.fromEntries(new URL(req.url).searchParams) : await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    const READ_ACTIONS = new Set(["list"]);
    if (!["schedule"].includes(action) && !READ_ACTIONS.has(action)) {
      return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, READ_ACTIONS.has(action) ? "project.read" : "project.write");
    const svc = base44.asServiceRole;
    let result;
    if (action === "schedule") {
      result = await scheduleOutreach(svc, project, workspace, { ...body, operator_email: user.email });
    } else {
      const jobs = (await svc.entities.BackgroundJob.filter(
        { project_id: project.id, job_type: OUTREACH_JOB_TYPE },
        "-created_date",
        Math.min(Math.max(Number(body.limit) || 50, 1), 100),
      ).catch(() => [])) || [];
      result = {
        count: jobs.length,
        jobs: jobs.map((j) => ({
          id: j.id,
          status: j.status,
          attempts: j.attempts ?? null,
          available_at: j.available_at || null,
          step_index: j.payload?.step_index ?? null,
          customer_id: j.payload?.customer_id || null,
          last_error: j.last_error || null,
          created_date: j.created_date,
        })),
      };
    }
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `outreach.${action}`, resource: "Customer", resource_id: project.id,
      metadata: { action },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}