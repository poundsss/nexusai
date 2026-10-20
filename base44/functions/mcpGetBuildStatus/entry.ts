// MCP tool: get_build_status (read-only) — reads the build records the existing build
// engine already writes. It never triggers a build.
import { mcpTool, getBuildStatus } from "../../shared/platformApi.ts";

export default async function (req) {
  return mcpTool(req, "get_build_status", ({ base44, user, body }) => getBuildStatus(base44, user, body.project_id));
}
