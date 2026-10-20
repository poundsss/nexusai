// MCP tool: get_workflow (read-only; one workflow definition, its validation and recent runs)
import { mcpTool } from "../../shared/platformApi.ts";
import { mcpGetWorkflow } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "get_workflow", ({ base44, user, body }) => mcpGetWorkflow(base44, user, body));
}
