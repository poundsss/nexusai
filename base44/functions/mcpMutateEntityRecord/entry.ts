// MCP tool: mutate_entity_record (WRITE; project.write, schema-validated, idempotent by key)
import { mcpTool } from "../../shared/platformApi.ts";
import { mutateEntityRecord } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "mutate_entity_record", ({ base44, user, body }) => mutateEntityRecord(base44, user, body));
}
