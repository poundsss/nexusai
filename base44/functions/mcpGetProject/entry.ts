// MCP tool: get_project (read-only)
import { mcpTool, getProject } from "../../shared/platformApi.ts";

export default async function (req) {
  return mcpTool(req, "get_project", ({ base44, user, body }) => getProject(base44, user, body.project_id));
}
