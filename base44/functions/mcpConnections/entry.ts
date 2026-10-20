// Account-level MCP connection control plane.
//
// Authorization is resolved server-side from the authenticated identity: the caller's role
// in the EXPLICITLY addressed workspace is resolved from workspace facts and held to the
// capability matrix (integration.manage), and every connection is then addressed INSIDE
// that workspace. A client-supplied connection id belonging to another account simply does
// not resolve, so cross-account access is impossible by construction.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { audit } from "../../shared/authz.ts";
import { authorizedManageWorkspace, connectAndDiscover, connectionMetadata, invokeMcpTool, mcpError, MCP_TRANSPORT, redactSecrets, resolveWorkspaceSecret } from "../../shared/mcp.ts";
import { writeWorkspaceSecret } from "../../shared/workspaceSecrets.ts";
import { requireActiveWorkspace } from "../../shared/rbac.ts";

const AUTH_TYPES = ["none", "bearer", "header"];

// Runs initialize + tools/list against the real server and persists the outcome.
async function testConnection(base44, ws, row) {
  const svc = base44.asServiceRole;
  if (row.enabled === false) {
    return { connection: connectionMetadata(row), error: { code: "MCP_DISABLED", message: `'${row.name}' is disabled — enable it before testing.` } };
  }
  const secretValue = await resolveWorkspaceSecret(base44, ws.id, row.secret_name);
  try {
    const info = await connectAndDiscover(connectionMetadata(row), secretValue);
    const saved = await svc.entities.MCPConnection.update(row.id, {
      status: "connected", last_connected_at: new Date().toISOString(), last_error: "", last_error_code: "",
      server_name: info.server_name, server_version: info.server_version, protocol_version: info.protocol_version,
      capabilities: info.capabilities, instructions: info.instructions, tools: info.tools, tool_count: info.tools.length,
    });
    return { connection: connectionMetadata(saved) };
  } catch (e) {
    // The message is redacted before it is stored or returned.
    const message = redactSecrets(e.message, secretValue ? [secretValue] : []).slice(0, 500);
    const code = e.code || "MCP_CONNECTION_FAILURE";
    const saved = await svc.entities.MCPConnection.update(row.id, { status: "error", last_error: message, last_error_code: code });
    return { connection: connectionMetadata(saved), error: { code, message } };
  }
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const action = String(body.action || "list");
    const ws = await authorizedManageWorkspace(base44, user, body.workspace_id);
    // G-2 lifecycle: reads (list / invocations) stay available on a suspended or terminated
    // workspace; every change, credential or tool invocation fails closed.
    if (!["list", "invocations"].includes(action)) requireActiveWorkspace(ws);
    const svc = base44.asServiceRole;
    const rows = await svc.entities.MCPConnection.filter({ workspace_id: ws.id }, "name", 50);
    const find = () => {
      const row = rows.find((r) => r.id === String(body.connection_id || "")) || rows.find((r) => r.name === String(body.name || ""));
      if (!row) throw mcpError("MCP_CONNECTION_NOT_FOUND", "MCP connection not found for this account");
      return row;
    };
    const listOut = async () => Response.json({ connections: (await svc.entities.MCPConnection.filter({ workspace_id: ws.id }, "name", 50)).map(connectionMetadata) });

    if (action === "list") return listOut();

    if (action === "create") {
      const name = String(body.name || "").trim();
      if (!name) return Response.json({ error: "name is required" }, { status: 400 });
      if (rows.some((r) => r.name === name)) return Response.json({ error: `a connection named '${name}' already exists` }, { status: 400 });
      const auth_type = AUTH_TYPES.includes(body.auth_type) ? body.auth_type : "none";
      if (auth_type === "header" && !String(body.auth_header_name || "").trim()) return Response.json({ error: "auth_header_name is required for header authentication" }, { status: 400 });
      const secret_name = auth_type === "none" ? "" : String(body.secret_name || "").trim();
      if (auth_type !== "none" && !/^[A-Z][A-Z0-9_]*$/.test(secret_name)) return Response.json({ error: "secret_name must be UPPER_SNAKE_CASE, e.g. GITHUB_MCP_TOKEN" }, { status: 400 });
      if (body.transport && body.transport !== MCP_TRANSPORT) return Response.json({ error: "only the 'http' (Streamable HTTP) MCP transport is supported" }, { status: 400 });

      const created = await svc.entities.MCPConnection.create({
        workspace_id: ws.id, name, server_url: String(body.server_url || "").trim(), transport: MCP_TRANSPORT,
        auth_type, auth_header_name: String(body.auth_header_name || "").trim(), secret_name, enabled: true, status: "never_connected", tools: [], tool_count: 0,
      });
      // The credential value goes in here — encrypted at rest, bound to this workspace —
      // and is never read back out.
      if (secret_name && body.secret_value) {
        await writeWorkspaceSecret(svc, ws.id, secret_name, String(body.secret_value), { description: `Credential for MCP connection ${name}` });
      }
      await audit(base44, { workspace_id: ws.id, user_id: user.id, action: "mcp.connection.created", resource: "MCPConnection", resource_id: created.id, metadata: { name, server_url: created.server_url, auth_type, secret_name: secret_name || null } });
      const out = await testConnection(base44, ws, created);
      return Response.json({ ...out, connections: (await svc.entities.MCPConnection.filter({ workspace_id: ws.id }, "name", 50)).map(connectionMetadata) });
    }

    if (action === "set_secret") {
      const row = find();
      if (!row.secret_name) return Response.json({ error: "this connection does not use authentication" }, { status: 400 });
      const value = String(body.secret_value ?? "");
      if (!value) return Response.json({ error: "secret_value is required" }, { status: 400 });
      await writeWorkspaceSecret(svc, ws.id, row.secret_name, value, { description: `Credential for MCP connection ${row.name}` });
      await audit(base44, { workspace_id: ws.id, user_id: user.id, action: "mcp.secret.set", resource: "WorkspaceSecret", resource_id: row.id, metadata: { name: row.secret_name } });
      return listOut();
    }

    if (action === "set_enabled") {
      const row = find();
      const enabled = body.enabled !== false;
      const saved = await svc.entities.MCPConnection.update(row.id, { enabled, status: enabled ? (row.status === "disabled" ? "never_connected" : row.status) : "disabled" });
      await audit(base44, { workspace_id: ws.id, user_id: user.id, action: enabled ? "mcp.connection.enabled" : "mcp.connection.disabled", resource: "MCPConnection", resource_id: row.id, metadata: { name: row.name } });
      return Response.json({ connection: connectionMetadata(saved), connections: (await svc.entities.MCPConnection.filter({ workspace_id: ws.id }, "name", 50)).map(connectionMetadata) });
    }

    if (action === "test" || action === "refresh") {
      const out = await testConnection(base44, ws, find());
      return Response.json({ ...out, connections: (await svc.entities.MCPConnection.filter({ workspace_id: ws.id }, "name", 50)).map(connectionMetadata) });
    }

    if (action === "delete") {
      const row = find();
      await svc.entities.MCPConnection.delete(row.id);
      await audit(base44, { workspace_id: ws.id, user_id: user.id, action: "mcp.connection.deleted", resource: "MCPConnection", resource_id: row.id, metadata: { name: row.name } });
      return listOut();
    }

    // Manual invocation from the UI ("try this tool"). Same single invocation path the
    // Builder uses, so authorization, redaction and audit behave identically.
    if (action === "invoke") {
      const row = find();
      try {
        const result = await invokeMcpTool(base44, { workspace_id: ws.id, user_id: user.id, trigger: "manual_test", mode: "manual" }, { connection_name: row.name, tool_name: String(body.tool_name || ""), args: body.arguments || {} });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: { code: e.code || "MCP_TOOL_EXECUTION_FAILURE", message: e.message, details: e.details || {} } }, { status: 400 });
      }
    }

    if (action === "invocations") {
      const invs = await svc.entities.MCPInvocation.filter({ workspace_id: ws.id }, "-created_date", Math.min(Number(body.limit) || 20, 50));
      return Response.json({ invocations: invs });
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || (error.code ? 400 : 500) });
  }
}