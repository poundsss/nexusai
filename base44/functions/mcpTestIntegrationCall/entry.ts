// MCP tool: test_integration_call (WRITE-ish; runs one declared operation through the #31
// authorized integration path, so quota, rate limits, breaker, tracing and audit all apply)
import { mcpTool } from "../../shared/platformApi.ts";
import { testIntegrationCall } from "../../shared/mcpServerTools.ts";

export default async function (req) {
  return mcpTool(req, "test_integration_call", ({ base44, user, body }) => testIntegrationCall(base44, user, body));
}
