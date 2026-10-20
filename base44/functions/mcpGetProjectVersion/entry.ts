// MCP tool: get_project_version (read-only; bounded inspection, no file contents, no secret values)
import { mcpTool } from "../../shared/platformApi.ts";
import { inspectProjectVersion } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "get_project_version", ({ base44, user, body }) => inspectProjectVersion(base44, user, body));
}
