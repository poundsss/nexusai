// MCP tool: list_integrations (read-only; metadata + secret NAMES only)
import { mcpTool } from "../../shared/platformApi.ts";
import { listIntegrations } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "list_integrations", ({ base44, user, body }) => listIntegrations(base44, user, body));
}
