// MCP tool: create_project (WRITE). Creates the project + initial scaffold version, and
// when a build prompt is given enqueues the EXISTING background AI run — it never builds
// synchronously and never runs its own AI pipeline. The handler lives in a shared module so
// it can be certified directly; identity, workspace selection, audit and errors stay in mcpTool.
import { mcpTool } from "../../shared/platformApi.ts";
import { mcpCreateProjectHandler } from "../../shared/mcpCreateProject.ts";

export default async function (req) {
  return mcpTool(req, "create_project", mcpCreateProjectHandler);
}