// MCP tool: get_workflow_run (read-only; one run's steps and outcome)
import { mcpTool } from "../../shared/platformApi.ts";
import { mcpGetWorkflowRun } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "get_workflow_run", ({ base44, user, body }) => mcpGetWorkflowRun(base44, user, body));
}
