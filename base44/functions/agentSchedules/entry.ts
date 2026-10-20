// Scheduled Superagent Workflows — the member-authorized HTTP surface over the CERTIFIED
// AgentSchedule lifecycle (shared/agentSchedules.ts). A THIN action dispatch, exactly like the
// workflows endpoint: every mutation is the existing executor (loadAuthorizedProject — project
// authorization + the G-2 workspace lifecycle gate — plus the existing audit primitive); this
// endpoint owns no scheduling, enqueue or validation logic of its own. There is NO delete action:
// archive is the tombstone and restore the only way back (the documented Superagent surface).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createAgentSchedule, updateAgentSchedule, pauseAgentSchedule, resumeAgentSchedule,
  archiveAgentSchedule, restoreAgentSchedule, runNowAgentSchedule,
} from "../../shared/agentSchedules.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";

export const config = { public: true };

const svcOf = (b) => b.asServiceRole || b;

// Safe projection: everything the UI shows, nothing internal (no claim slot, no secrets —
// AgentSchedule carries none).
const publicSchedule = (s) => ({
  schedule_id: s.id, project_id: s.project_id, workspace_id: s.workspace_id,
  goal: s.goal, agent_name: s.agent_name || null,
  cron: s.cron || null, interval_seconds: s.interval_seconds ?? null, one_time_at: s.one_time_at || null,
  timezone: s.timezone || "UTC",
  ends_type: s.ends_type || "never", ends_on_date: s.ends_on_date || null, ends_after_count: s.ends_after_count ?? null,
  enabled: s.enabled !== false, paused_reason: s.paused_reason || null,
  next_run_at: s.next_run_at || null, last_run_at: s.last_run_at || null,
  last_status: s.last_status || "pending", last_error: s.last_error || null,
  run_count: Number(s.run_count) || 0, consecutive_failures: Number(s.consecutive_failures) || 0,
  last_agent_run_id: s.last_agent_run_id || null,
  created_by: s.created_by || null, created_at: s.created_date || null,
});

const OPS = {
  create: createAgentSchedule,
  update: updateAgentSchedule,
  pause: pauseAgentSchedule,
  resume: resumeAgentSchedule,
  archive: archiveAgentSchedule,
  restore: restoreAgentSchedule,
  run_now: runNowAgentSchedule,
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const url = new URL(req.url);
  try {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const svc = svcOf(base44);

    if (action === "list") {
      const { project } = await loadAuthorizedProject(svc, user, body.project_id, "project.read");
      const limit = Math.min(Number(body.limit) || 50, 200);
      const rows = await svc.entities.AgentSchedule.filter({ project_id: project.id }, "-created_date", limit);
      return Response.json({ project_id: project.id, count: rows.length, schedules: rows.map(publicSchedule) });
    }

    const handler = OPS[action];
    if (!handler) {
      return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION", actions: ["list", ...Object.keys(OPS)] }, { status: 400 });
    }
    // The dispatch field itself is not a schedule field — the update validator refuses unknown keys.
    const input = { ...body };
    delete input.action;
    return Response.json(await handler(svc, user, input));
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || "SCHEDULE_ERROR" }, { status: e.status || 500 });
  }
}