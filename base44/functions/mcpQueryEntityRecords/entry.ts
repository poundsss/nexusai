// MCP tool: query_entity_records (read-only; bounded, project-scoped)
import { mcpTool } from "../../shared/platformApi.ts";
import { queryEntityRecords } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "query_entity_records", ({ base44, user, body }) => queryEntityRecords(base44, user, body));
}
