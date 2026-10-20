// MCP tool: get_project_context (read-only; secret metadata only, never values)
import { mcpTool, getProjectContext } from "../../shared/platformApi.ts";

export default async function (req) {
  return mcpTool(req, "get_project_context", ({ base44, user, body }) => getProjectContext(base44, user, body.project_id));
}
