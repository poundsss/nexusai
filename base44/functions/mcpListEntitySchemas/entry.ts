// MCP tool: list_entity_schemas (read-only)
import { mcpTool } from "../../shared/platformApi.ts";
import { listEntitySchemas } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "list_entity_schemas", ({ base44, user, body }) => listEntitySchemas(base44, user, body));
}
