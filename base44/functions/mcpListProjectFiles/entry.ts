// MCP tool: list_project_files (read-only; content only when explicitly requested)
import { mcpTool, listProjectFiles } from "../../shared/platformApi.ts";

export default async function (req) {
  return mcpTool(req, "list_project_files", ({ base44, user, body }) =>
    listProjectFiles(base44, user, body.project_id, { include_content: body.include_content === true, path_prefix: body.path_prefix ? String(body.path_prefix) : "" }));
}
