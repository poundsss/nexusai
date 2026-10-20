// MCP tool: edit_project (WRITE). Enqueues the EXISTING background AI run and returns
// immediately — the MCP request never waits for planning, build, repair or commit, and
// no second AI engine exists here.
import { mcpTool } from "../../shared/platformApi.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { enqueueRun } from "../../shared/runEnqueue.ts";

export default async function (req) {
  return mcpTool(req, "edit_project", async ({ base44, user, body }) => {
    const { project } = await loadAuthorizedProject(base44, user, body.project_id);
    const mode = body.mode === "discuss" ? "discuss" : "default";
    const out = await enqueueRun(base44, { project, prompt: body.prompt, mode });
    return {
      project_id: project.id, run_id: out.run_id, status: out.status, phase: out.phase, mode,
      reused_existing: out.reused_existing,
      next_step: "Poll get_run_status with this run_id until status is COMPLETED or FAILED.",
    };
  });
}
