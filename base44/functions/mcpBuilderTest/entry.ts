// End-to-end proof that the account's MCP connections are reachable BY THE BUILDER:
// connect → test → discover tools → enable → the Builder's tool router calls the tool and gets a
// structured result → disable → the same call is refused. Runs against a real public MCP server.
//
// Every step goes through the SAME production code paths the AI run uses (prepareRunConnections
// for pre-run discovery, executeTool for the agent's tool call), so a pass here is evidence about
// the real pipeline rather than a parallel test implementation.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { prepareRunConnections, connectAndDiscover, connectionMetadata, resolveWorkspaceSecret } from "../../shared/mcp.ts";
import { executeTool, mcpConnectionsView } from "../../shared/tools.ts";
import { invokeMcpTool } from "../../shared/mcp.ts";
import { createFs } from "../../shared/projectFs.ts";

const DEFAULT_SERVER = "https://mcp.deepwiki.com/mcp";
const TEST_NAME = "__mcp_builder_test__";

export default async function (req) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 400) }); return !!ok; };
  let base44, ws, svc, created = null;

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const serverUrl = String(body.server_url || DEFAULT_SERVER);

    ws = (await base44.entities.Workspace.filter({ owner_id: user.id }, "created_date", 1))[0];
    if (!ws) return Response.json({ error: "No workspace for this account" }, { status: 404 });

    // Clean any leftover from a previous run so the test is repeatable.
    for (const old of await svc.entities.MCPConnection.filter({ workspace_id: ws.id, name: TEST_NAME }, "name", 5)) {
      await svc.entities.MCPConnection.delete(old.id).catch(() => {});
    }

    // 1. connect
    created = await svc.entities.MCPConnection.create({
      workspace_id: ws.id, name: TEST_NAME, server_url: serverUrl, transport: "http",
      auth_type: "none", enabled: true, status: "never_connected", tools: [], tool_count: 0,
    });
    check("connection created", !!created.id, created.server_url);

    // 2. test + 3. discover tools
    const secretValue = await resolveWorkspaceSecret(base44, ws.id, created.secret_name);
    const info = await connectAndDiscover(connectionMetadata(created), secretValue);
    await svc.entities.MCPConnection.update(created.id, {
      status: "connected", last_connected_at: new Date().toISOString(), last_error: "", last_error_code: "",
      server_name: info.server_name, server_version: info.server_version, protocol_version: info.protocol_version,
      capabilities: info.capabilities, instructions: info.instructions, tools: info.tools, tool_count: info.tools.length,
    });
    check("handshake succeeded", !!info.protocol_version, `${info.server_name} ${info.server_version} · protocol ${info.protocol_version}`);
    check("tools discovered", info.tools.length > 0, info.tools.map((t) => t.name).join(", "));

    // 4. pre-run discovery: what the Builder loads before planning
    const prepared = await prepareRunConnections(base44, ws.id);
    const mine = prepared.connections.find((c) => c.name === TEST_NAME);
    check("enabled connection present in run tool surface", !!mine, `${prepared.connections.length} connection(s), ${prepared.tool_count} tool(s)`);
    check("no credential in the run tool surface", !JSON.stringify(prepared.connections).includes("value"), "metadata only");

    // 5. the Builder agent's own tool call, through the tool router
    const ctx = {
      fs: createFs([]), entities: [], secrets: [], deletes: 0,
      mcp: {
        connections: prepared.connections,
        call: (a) => invokeMcpTool(base44, { workspace_id: ws.id, user_id: user.id, mode: "default", trigger: "builder_run" }, a),
      },
    };
    const listed = await executeTool(ctx, "list_mcp_connections", {}, "default");
    check("agent can list MCP connections", listed.ok && listed.result.connections.some((c) => c.name === TEST_NAME), `${listed.result?.connections?.length ?? 0} listed`);

    const readTool = info.tools.find((t) => t.read_only) || info.tools[0];
    const args = readTool.name === "read_wiki_structure" || readTool.name === "ask_question" || readTool.name === "read_wiki_contents"
      ? { repoName: "facebook/react", ...(readTool.name === "ask_question" ? { question: "What is this repository?" } : {}) }
      : {};
    const called = await executeTool(ctx, "mcp_call", { connection: TEST_NAME, tool: readTool.name, arguments: args }, "default");
    check("agent called the MCP tool", called.ok, called.ok ? `${readTool.name} → ${called.result.duration_ms}ms` : `${called.code}: ${called.error}`);
    check("structured result returned to the agent", called.ok && (!!called.result.text || called.result.structured !== null), called.ok ? `${(called.result.text || "").length} chars, content types: ${called.result.content_types.join(",") || "none"}` : "no result");

    // 9. audit trail
    const invs = await svc.entities.MCPInvocation.filter({ workspace_id: ws.id, connection_name: TEST_NAME }, "-created_date", 5);
    check("invocation recorded in the audit log", invs.some((i) => i.ok && i.trigger === "builder_run"), `${invs.length} row(s), tool ${invs[0]?.tool_name}, ${invs[0]?.duration_ms}ms`);

    // 6/10. disable → the tool must become uncallable
    await svc.entities.MCPConnection.update(created.id, { enabled: false, status: "disabled" });
    const afterDisable = await executeTool(ctx, "mcp_call", { connection: TEST_NAME, tool: readTool.name, arguments: args }, "default");
    check("disabled connection refuses the call", !afterDisable.ok && afterDisable.code === "MCP_DISABLED", afterDisable.error || "unexpectedly succeeded");

    const preparedAfter = await prepareRunConnections(base44, ws.id);
    check("disabled connection is absent from the run tool surface", !preparedAfter.connections.some((c) => c.name === TEST_NAME), `${preparedAfter.connections.length} connection(s) remain`);

    // 6. cross-account isolation: another workspace's id must not resolve this connection.
    const foreign = await invokeMcpTool(base44, { workspace_id: "another-account", user_id: user.id, trigger: "builder_run" }, { connection_name: TEST_NAME, tool_name: readTool.name, args })
      .then(() => ({ code: null })).catch((e) => e);
    check("another account cannot reach this connection", foreign.code === "MCP_CONNECTION_NOT_FOUND", foreign.message || "unexpectedly succeeded");

    // 10. deleted connection
    await svc.entities.MCPConnection.delete(created.id);
    created = null;
    const afterDelete = await executeTool(ctx, "mcp_call", { connection: TEST_NAME, tool: readTool.name, arguments: args }, "default");
    check("deleted connection refuses the call", !afterDelete.ok && afterDelete.code === "MCP_CONNECTION_NOT_FOUND", afterDelete.error || "unexpectedly succeeded");

    const passed = checks.filter((c) => c.ok).length;
    return Response.json({ ok: passed === checks.length, passed, total: checks.length, checks });
  } catch (error) {
    if (created?.id && svc) await svc.entities.MCPConnection.delete(created.id).catch(() => {});
    return Response.json({ ok: false, error: error.message, code: error.code || null, checks }, { status: 500 });
  }
}