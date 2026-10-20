// MCP tool: get_run_status (read-only) — the polling counterpart of edit_project.
import { mcpTool, getRunStatus } from "../../shared/platformApi.ts";

export default async function (req) {
  return mcpTool(req, "get_run_status", ({ base44, user, body }) => getRunStatus(base44, user, String(body.run_id || "")));
}
