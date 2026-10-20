// MCP tool: list_projects (read-only)
import { mcpTool, listProjects } from "../../shared/platformApi.ts";

export default async function (req) {
  return mcpTool(req, "list_projects", ({ base44, user }) => listProjects(base44, user));
}
