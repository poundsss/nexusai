// Agent control plane: start and cancel durable agent runs.
// Starting an agent persists an AgentRun as QUEUED and returns immediately — the
// "Agent Executor" workflow drives the loop in the background, so closing the browser
// cannot interrupt it.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { AGENT_TERMINAL } from "../../shared/agentLoop.ts";
import { loadProjectState } from "../../shared/authz.ts";
import { resolveAgent } from "../../shared/agentResource.ts";
import { RESOURCE_NAME_RE } from "../../shared/base44Layout.ts";
// THE shared reference-image contract, identical to the AI run enqueue path: stored http(s) file
// URLs only, capped and de-duplicated server-side — never a client-declared payload shape.
import { normalizeImageUrls } from "../../shared/attachments.ts";

const MAX_STEPS_CEILING = 20;

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id);

    // Cancellation is cooperative and durable: the flag is persisted and the loop stops at
    // its next checkpoint. The worker is never killed mid-mutation.
    if (body.action === "cancel") {
      const run = await base44.entities.AgentRun.get(body.agent_run_id).catch(() => null);
      if (!run || run.project_id !== project.id) return Response.json({ error: "Agent run not found" }, { status: 404 });
      if (AGENT_TERMINAL.includes(run.status)) return Response.json({ agent_run_id: run.id, status: run.status, already_terminal: true });
      await base44.entities.AgentRun.update(run.id, { cancel_requested: true, current_phase: "cancelling" });
      // Sub-agent stop propagation (the documented stop icon): the parent's non-terminal
      // background tasks are stopped at their next safe checkpoint; any work they already
      // finished is kept — their terminal rows are never touched.
      const children = (await base44.entities.AgentRun.filter({ parent_agent_run_id: run.id }, "-created_date", 10).catch(() => []));
      for (const child of (children || [])) {
        if (!AGENT_TERMINAL.includes(child.status)) {
          await base44.entities.AgentRun.update(child.id, { cancel_requested: true, current_phase: "cancelling" }).catch(() => null);
        }
      }
      await audit(base44.asServiceRole || base44, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "agent.run.cancel_requested", resource: "AgentRun", resource_id: run.id, metadata: { steps: run.current_step, subagents_stopped: (children || []).length } });
      return Response.json({ agent_run_id: run.id, cancel_requested: true, status: run.status });
    }

    const goal = String(body.goal || "").trim();
    if (!goal) return Response.json({ error: "goal is required" }, { status: 400 });
    if (goal.length > 4000) return Response.json({ error: "goal too long (max 4000 characters)" }, { status: 400 });

    // Reuse the project's concurrency posture: one agent per project at a time, so two
    // agents cannot race each other's versions.
    const active = (await base44.entities.AgentRun.filter({ project_id: project.id }, "-created_date", 10)).find((r) => !AGENT_TERMINAL.includes(r.status));
    if (active) return Response.json({ error: "An agent is already running on this project", code: "AGENT_ALREADY_RUNNING", agent_run_id: active.id }, { status: 409 });

    // E9: an optional declared agent. Validated against the project's OWN files at enqueue time so a
    // bad name is refused here (and re-resolved at every iteration, where it fails closed).
    let agent = null;
    if (body.agent_name != null && body.agent_name !== "") {
      const name = String(body.agent_name);
      if (!RESOURCE_NAME_RE.test(name)) return Response.json({ error: `invalid agent name '${name}'`, code: "AGENT_INVALID_NAME" }, { status: 400 });
      const state = await loadProjectState(base44, project.id);
      agent = resolveAgent(state.files, name);
      if (!agent) return Response.json({ error: `The project declares no agent named '${name}'`, code: "AGENT_NOT_FOUND" }, { status: 404 });
    }
    const ceiling = agent?.max_steps ? Math.min(agent.max_steps, MAX_STEPS_CEILING) : MAX_STEPS_CEILING;

    // Reference images the user attached to the goal. Normalized here so the agent loop and every
    // builder run it delegates see the SAME validated list; omitted entirely for a text-only goal.
    const images = normalizeImageUrls(body.image_urls);

    const now = new Date().toISOString();
    const run = await base44.entities.AgentRun.create({
      project_id: project.id, workspace_id: workspace.id, user_id: user.id, goal,
      ...(images.length ? { image_urls: images } : {}),
      ...(agent ? { agent_name: agent.name } : {}),
      status: "QUEUED", current_phase: "queued", current_step: 0,
      max_steps: Math.min(Number(body.max_steps) || ceiling, ceiling),
      cancel_requested: false, started_at: now, heartbeat_at: now,
    });
    // The audit trail is the platform's, not the caller's: written with the service role so a caller
    // who may start an agent but holds no direct AuditLog write still gets an audited run.
    await audit(base44.asServiceRole || base44, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "agent.run.started", resource: "AgentRun", resource_id: run.id, metadata: { goal: goal.slice(0, 200), max_steps: run.max_steps } });
    return Response.json({ agent_run_id: run.id, status: "QUEUED" }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}