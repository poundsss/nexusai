// MCP tool: get_build_result (read-only; authorized through the build's own project)
import { mcpTool } from "../../shared/platformApi.ts";
import { getBuildResult } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "get_build_result", ({ base44, user, body }) => getBuildResult(base44, user, body));
}
