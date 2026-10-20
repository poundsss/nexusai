// MCP tool: write_project_file (WRITE). Delegates to the #36 journalled commit path.
import { mcpTool } from "../../shared/platformApi.ts";
import { writeProjectFile } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "write_project_file", ({ base44, user, body }) => writeProjectFile(base44, user, body));
}
