// MCP tool: get_project_versions (read-only)
import { mcpTool, getProjectVersions } from "../../shared/platformApi.ts";

export default async function (req) {
  return mcpTool(req, "get_project_versions", ({ base44, user, body }) => getProjectVersions(base44, user, body.project_id));
}
