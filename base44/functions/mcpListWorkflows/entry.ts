// MCP tool: list_workflows (read-only; definitions and optionally recent runs. Triggering,
// finalizing, retrying and cancelling a workflow are NOT exposed over MCP.)
import { mcpTool } from "../../shared/platformApi.ts";
import { mcpListWorkflows } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "list_workflows", ({ base44, user, body }) => mcpListWorkflows(base44, user, body));
}
