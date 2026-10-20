// MCP tool: start_project_build (WRITE; validates current state, never changes files or versions)
import { mcpTool } from "../../shared/platformApi.ts";
import { startProjectBuild } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "start_project_build", ({ base44, user, body }) => startProjectBuild(base44, user, body));
}
