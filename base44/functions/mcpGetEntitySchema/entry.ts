// MCP tool: get_entity_schema (read-only)
import { mcpTool } from "../../shared/platformApi.ts";
import { getEntitySchema } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "get_entity_schema", ({ base44, user, body }) => getEntitySchema(base44, user, body));
}
