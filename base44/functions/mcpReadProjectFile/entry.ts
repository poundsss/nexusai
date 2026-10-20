// MCP tool: read_project_file (read-only, size-bounded)
import { mcpTool, readProjectFile } from "../../shared/platformApi.ts";

export default async function (req) {
  return mcpTool(req, "read_project_file", ({ base44, user, body }) => readProjectFile(base44, user, body.project_id, String(body.path || "")));
}
