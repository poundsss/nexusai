// MCP tool: get_integration (read-only; declared operations + secret references, never values)
import { mcpTool } from "../../shared/platformApi.ts";
import { getIntegration } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "get_integration", ({ base44, user, body }) => getIntegration(base44, user, body));
}
