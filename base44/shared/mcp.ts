// MCP control plane: account-level connections to external MCP servers, used by the AI
// Builder only. This is deliberately SEPARATE from the app-integration layer
// (project → integrations/<name>.json → generated backend → deployed app): an MCP
// connection is builder infrastructure and never becomes an application runtime dependency.
//
// Transport: MCP Streamable HTTP only (JSON-RPC 2.0 over POST, JSON or SSE response body).
import { assertAllowedUrl } from "./externalTools.ts";
import { readWorkspaceSecret } from "./workspaceSecrets.ts";
// Lifecycle + capability checks share the SAME rbac facts every other surface uses.
import { requireActiveWorkspace, resolveRole, requireCapability } from "./rbac.ts";
// Correlation only — the MCPInvocation row stays the authoritative record of the call.
import { recordSpan } from "./tracing.ts";
import { createMcpBreaker, breakerConfig } from "./integrationBreaker.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_TRANSPORT = "http";
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESULT_CHARS = 60000;
const PREVIEW_CHARS = 800;

export const MCP_ERROR_CODES = [
  "MCP_CONNECTION_NOT_FOUND", "MCP_DISABLED", "MCP_AUTH_FAILURE", "MCP_CONNECTION_FAILURE",
  "MCP_INITIALIZATION_FAILURE", "MCP_TOOL_NOT_FOUND", "MCP_INVALID_INPUT",
  "MCP_TOOL_EXECUTION_FAILURE", "MCP_TIMEOUT", "MCP_NOT_ALLOWED", "MCP_CIRCUIT_OPEN",
];

export function mcpError(code, message, details) {
  return Object.assign(new Error(message), { name: "McpError", code, details: details || {} });
}

// Centralized redaction: every string that leaves this module (errors, previews, status)
// passes through it, so a credential cannot reach logs, audit rows, prompts or the UI.
export function redactSecrets(text, values) {
  let out = String(text ?? "");
  for (const v of values || []) if (v && String(v).length >= 4) out = out.split(String(v)).join("[REDACTED]");
  return out;
}

// Maps an MCP error onto the integration breaker's failure vocabulary so the SHARED
// countsAsBreakerFailure classification decides whether the upstream is unhealthy. Only 5xx,
// timeouts, connection/DNS failures count; auth, validation, 4xx, 429, tool errors and policy
// refusals are excluded exactly as they are for project integrations.
function mcpBreakerOutcome(e) {
  const kind = e?.details?.kind || null;
  const status = Number(e?.details?.status) || 0;
  if (status === 429) return { ok: false, code: "UPSTREAM_FAILURE", status: 429, failure_kind: "rate_limited" };
  if (e?.code === "MCP_TIMEOUT") return { ok: false, code: "TIMEOUT", status: 0, failure_kind: "timeout" };
  if (e?.code === "MCP_CONNECTION_FAILURE") {
    if (kind === "network" || kind === "bad_stream" || kind === "bad_payload") return { ok: false, code: "UPSTREAM_FAILURE", status: 0, failure_kind: "network" };
    // http_error with a status: count only 5xx / transport (status 0); a 4xx is a client error.
    return { ok: false, code: "UPSTREAM_FAILURE", status, failure_kind: status >= 500 ? null : "client_error" };
  }
  if (e?.code === "MCP_AUTH_FAILURE") return { ok: false, code: "UPSTREAM_FAILURE", status, failure_kind: "client_error" };
  // tool errors, validation, not-found, init, policy: never upstream-health signals.
  return { ok: false, code: "UPSTREAM_FAILURE", status, failure_kind: kind === "tool_error" ? "tool_error" : "client_error" };
}

// --- protocol client ---------------------------------------------------------

function parseRpcPayload(text, contentType) {
  if ((contentType || "").includes("text/event-stream")) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim());
        if (msg && (msg.result !== undefined || msg.error !== undefined)) return msg;
      } catch { /* keep scanning the stream */ }
    }
    throw mcpError("MCP_CONNECTION_FAILURE", "the MCP server's event stream contained no JSON-RPC response", { kind: "bad_stream" });
  }
  try { return JSON.parse(text); } catch { throw mcpError("MCP_CONNECTION_FAILURE", "the MCP server returned a non-JSON response", { kind: "bad_payload" }); }
}

export function authHeaders(conn, secretValue) {
  const type = conn.auth_type || "none";
  if (type === "none") return {};
  if (!secretValue) {
    throw mcpError("MCP_AUTH_FAILURE", `account secret ${conn.secret_name || "(unnamed)"} is not set — add its value in MCP Connections before using this server`, { kind: "secret_not_set", secret: conn.secret_name || null });
  }
  if (type === "bearer") return { Authorization: `Bearer ${secretValue}` };
  const header = conn.auth_header_name;
  if (!header) throw mcpError("MCP_AUTH_FAILURE", "this connection uses header authentication but no header name is configured", { kind: "missing_header_name" });
  return { [header]: secretValue };
}

export function createMcpClient(conn, secretValue, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let url;
  try { url = assertAllowedUrl(conn.server_url); } catch (e) { throw mcpError("MCP_CONNECTION_FAILURE", e.message.replace(/^http: /, ""), { kind: "invalid_url" }); }
  const secrets = secretValue ? [secretValue] : [];
  const safe = (t) => redactSecrets(t, secrets);
  const base = authHeaders(conn, secretValue);
  let sessionId = null;
  let nextId = 1;

  const send = async (body, { notification = false } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url.toString(), {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_PROTOCOL_VERSION, ...base, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.name === "AbortError") throw mcpError("MCP_TIMEOUT", `${url.hostname} did not respond within ${timeoutMs}ms`, { host: url.hostname, kind: "timeout" });
      throw mcpError("MCP_CONNECTION_FAILURE", `could not reach ${url.hostname} (${safe(e.message)})`, { host: url.hostname, kind: "network" });
    } finally { clearTimeout(timer); }

    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw mcpError("MCP_AUTH_FAILURE", `${url.hostname} rejected the credentials (HTTP ${res.status})`, { host: url.hostname, status: res.status, kind: "unauthorized", upstream: safe(text).slice(0, 200) });
    }
    if (notification) return null;
    if (!res.ok && !text) throw mcpError("MCP_CONNECTION_FAILURE", `${url.hostname} responded ${res.status}`, { host: url.hostname, status: res.status, kind: "http_error" });
    const msg = parseRpcPayload(safe(text), res.headers.get("content-type"));
    if (msg.error) {
      const rpc = msg.error;
      const code = rpc.code === -32602 ? "MCP_INVALID_INPUT" : rpc.code === -32601 ? "MCP_TOOL_NOT_FOUND" : "MCP_TOOL_EXECUTION_FAILURE";
      throw mcpError(code, safe(rpc.message || "the MCP server returned an error"), { host: url.hostname, rpc_code: rpc.code, kind: "rpc_error" });
    }
    return msg.result;
  };

  return {
    host: url.hostname,
    safe,
    get sessionId() { return sessionId; },
    async initialize() {
      let result;
      try {
        result = await send({ jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, clientInfo: { name: "nexus-ai-builder", version: "1.0" } } });
      } catch (e) {
        if (e.code === "MCP_TOOL_EXECUTION_FAILURE" || e.code === "MCP_INVALID_INPUT" || e.code === "MCP_TOOL_NOT_FOUND") throw mcpError("MCP_INITIALIZATION_FAILURE", `initialization was refused: ${e.message}`, e.details);
        throw e;
      }
      if (!result || !result.protocolVersion || !result.serverInfo) {
        throw mcpError("MCP_INITIALIZATION_FAILURE", `${url.hostname} did not return a valid MCP initialize result (protocolVersion/serverInfo missing) — it may not be an MCP endpoint`, { host: url.hostname, kind: "invalid_handshake" });
      }
      await send({ jsonrpc: "2.0", method: "notifications/initialized" }, { notification: true }).catch(() => {});
      return result;
    },
    async listTools() {
      const result = await send({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} });
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    async callTool(name, args) {
      return send({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args && typeof args === "object" ? args : {} } });
    },
  };
}

export function normalizeTool(t) {
  return {
    name: String(t.name || ""),
    description: String(t.description || "").slice(0, 600),
    input_schema: JSON.stringify(t.inputSchema || t.input_schema || { type: "object" }).slice(0, 8000),
    read_only: t?.annotations?.readOnlyHint === true,
  };
}

// Full initialization + discovery sequence against a real server.
export async function connectAndDiscover(conn, secretValue, opts) {
  const client = createMcpClient(conn, secretValue, opts);
  const init = await client.initialize();
  const tools = (await client.listTools()).map(normalizeTool).filter((t) => t.name);
  return {
    server_name: String(init.serverInfo?.name || "").slice(0, 120),
    server_version: String(init.serverInfo?.version || "").slice(0, 60),
    protocol_version: String(init.protocolVersion || "").slice(0, 40),
    capabilities: JSON.stringify(init.capabilities || {}).slice(0, 4000),
    instructions: String(init.instructions || "").slice(0, 1000),
    tools,
  };
}

export function normalizeToolResult(raw, safe) {
  const content = Array.isArray(raw?.content) ? raw.content : [];
  const text = content.filter((c) => c?.type === "text").map((c) => safe(String(c.text ?? ""))).join("\n").slice(0, MAX_RESULT_CHARS);
  // MCP structured output is preserved as-is (minus redaction) rather than flattened to text.
  const structured = raw?.structuredContent !== undefined ? JSON.parse(safe(JSON.stringify(raw.structuredContent)).slice(0, MAX_RESULT_CHARS) || "null") : null;
  return { is_error: raw?.isError === true, text, structured, content_types: content.map((c) => c?.type).filter(Boolean) };
}

// --- registry / metadata (never carries secret values) -----------------------

export function connectionMetadata(c) {
  return {
    id: c.id, name: c.name, server_url: c.server_url, transport: c.transport || MCP_TRANSPORT,
    auth_type: c.auth_type || "none", auth_header_name: c.auth_header_name || null, secret_name: c.secret_name || null,
    enabled: c.enabled !== false, status: c.enabled === false ? "disabled" : (c.status || "never_connected"),
    last_connected_at: c.last_connected_at || null, last_error: c.last_error || null, last_error_code: c.last_error_code || null,
    server_name: c.server_name || null, server_version: c.server_version || null, protocol_version: c.protocol_version || null,
    instructions: c.instructions || "", tool_count: c.tool_count || (c.tools || []).length,
    tools: (c.tools || []).map((t) => ({ name: t.name, description: t.description || "", input_schema: t.input_schema || "{}", read_only: !!t.read_only })),
  };
}

export async function loadWorkspaceConnections(base44, workspaceId) {
  const rows = await base44.asServiceRole.entities.MCPConnection.filter({ workspace_id: workspaceId }, "name", 50);
  return rows.map(connectionMetadata);
}

// G-5: connection MANAGEMENT follows the SAME capability matrix as every other control-plane
// surface (integration.manage = owner/admin/editor), resolved from the workspace's own
// server-side facts. The workspace is addressed EXPLICITLY by id — never an implicit
// rows[0] selection — and a caller who is not a member of that workspace is refused BEFORE
// any connection data is read, so cross-workspace isolation is unchanged.
export async function authorizedManageWorkspace(base44, user, workspaceId) {
  const id = String(workspaceId || "").trim();
  if (!id) throw Object.assign(new Error("workspace_id is required"), { status: 400, code: "WORKSPACE_REQUIRED" });
  const ws = await base44.asServiceRole.entities.Workspace.get(id).catch(() => null);
  if (!ws) throw Object.assign(new Error("Workspace not found"), { status: 404, code: "WORKSPACE_NOT_FOUND" });
  requireCapability(await resolveRole(base44, ws, user), "integration.manage");
  return ws;
}

// How long discovered tool metadata is trusted before a run re-discovers it.
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 12000;

function discoveryIsStale(row) {
  if (row.status !== "connected" || !(row.tools || []).length) return true;
  const at = Date.parse(row.last_connected_at || "");
  return !Number.isFinite(at) || Date.now() - at > DISCOVERY_TTL_MS;
}

// Pre-run tool discovery. Called once at the start of a Builder run: every ENABLED connection
// of the caller's own account has its tool list refreshed from the real server (initialize +
// tools/list) when the stored metadata is missing or stale, so the agent plans against the
// tools the server actually offers right now rather than a snapshot from an old manual test.
//
// Disabled connections are excluded here and refused again at call time, so disabling one
// removes its tools from the run immediately. Discovery is best-effort per connection: an
// unreachable or unauthorized server yields a connection with no callable tools and a
// redacted error the model can report, never a failed run.
export async function prepareRunConnections(base44, workspaceId) {
  const svc = base44.asServiceRole;
  const rows = await svc.entities.MCPConnection.filter({ workspace_id: workspaceId }, "name", 50);
  const enabled = rows.filter((r) => r.enabled !== false);
  const failures = [];
  let discovered = 0;

  const refreshed = await Promise.all(enabled.map(async (row) => {
    if (!discoveryIsStale(row)) return row;
    let secretValue = null;
    try { secretValue = await resolveWorkspaceSecret(base44, workspaceId, row.secret_name); } catch { secretValue = null; }
    try {
      const info = await connectAndDiscover(connectionMetadata(row), secretValue, { timeoutMs: DISCOVERY_TIMEOUT_MS });
      discovered++;
      return await svc.entities.MCPConnection.update(row.id, {
        status: "connected", last_connected_at: new Date().toISOString(), last_error: "", last_error_code: "",
        server_name: info.server_name, server_version: info.server_version, protocol_version: info.protocol_version,
        capabilities: info.capabilities, instructions: info.instructions, tools: info.tools, tool_count: info.tools.length,
      });
    } catch (e) {
      const message = redactSecrets(e.message, secretValue ? [secretValue] : []).slice(0, 500);
      const code = e.code || "MCP_CONNECTION_FAILURE";
      failures.push({ connection: row.name, code, message });
      // Tools are cleared: a server we cannot reach must not advertise callable tools.
      return await svc.entities.MCPConnection.update(row.id, { status: "error", last_error: message, last_error_code: code, tools: [], tool_count: 0 }).catch(() => ({ ...row, status: "error", last_error: message, last_error_code: code, tools: [], tool_count: 0 }));
    }
  }));

  const connections = refreshed.map(connectionMetadata);
  return { connections, discovered, failures, tool_count: connections.reduce((n, c) => n + c.tools.length, 0) };
}

// The AI-facing tool registry entry: source-tagged so the model knows a tool is MCP-backed.
export function mcpToolsView(connections) {
  return (connections || []).filter((c) => c.enabled).flatMap((c) => c.tools.map((t) => ({
    source: "mcp", connection_id: c.id, connection_name: c.name, tool_name: t.name,
    description: t.description, input_schema: t.input_schema, read_only: t.read_only,
    server_name: c.server_name, server_version: c.server_version,
  })));
}

// The credential for a connection, decrypted at the point of use. The lookup is scoped to
// the connection's own workspace and the ciphertext is bound to it, so a credential can only
// ever be opened by the account that owns it. The plaintext stays inside this module's
// callers (the HTTP client's auth header) and is added to the redaction set, so it cannot
// reach a tool result, an error, an audit row or the UI.
export async function resolveWorkspaceSecret(base44, workspaceId, name) {
  if (!name) return null;
  return readWorkspaceSecret(base44, workspaceId, name);
}

function requiredMissing(schemaText, args) {
  let schema; try { schema = JSON.parse(schemaText || "{}"); } catch { return []; }
  return (Array.isArray(schema.required) ? schema.required : []).filter((k) => args?.[k] === undefined || args?.[k] === null || args?.[k] === "");
}

// Persist a durable audit row for every attempt, successful or not. The row remains the
// authoritative record; when the caller supplied a trace, a correlation span is added that POINTS
// at it, so an external MCP failure is attributable to the operation that caused it. Both the
// preview strings and the span go through the same redaction, so no credential is ever recorded.
async function recordInvocation(base44, ctx, row) {
  const invocation = await base44.asServiceRole.entities.MCPInvocation.create({
    workspace_id: ctx.workspace_id, project_id: ctx.project_id || null, run_id: ctx.run_id || null, user_id: ctx.user_id || null,
    trigger: ctx.trigger || "builder_run", mode: ctx.mode || null, trace_id: ctx.trace_id || null, ...row,
  }).catch(() => null);
  if (ctx.trace_id) {
    await recordSpan(base44, {
      trace_id: ctx.trace_id, parent_span_id: ctx.parent_span_id || null, workspace_id: ctx.workspace_id,
      project_id: ctx.project_id || null, run_id: ctx.run_id || null, event_type: "mcp_call",
      name: `${row.connection_name}.${row.tool_name}`, status: row.ok ? "ok" : "error",
      error_code: row.error_code || null, error: row.error_message || null,
      duration_ms: row.duration_ms ?? null, reference_id: invocation?.id || null,
      metadata: { trigger: ctx.trigger || "builder_run", mode: ctx.mode || null, result_bytes: row.result_bytes ?? null },
    });
  }
  return invocation;
}

// THE single MCP invocation path. Authorization is resolved from server-side records only:
// the connection is looked up inside the caller's own workspace, so a client-supplied name
// or id can never reach another account's connection.
export async function invokeMcpTool(base44, ctx, { connection_name, tool_name, args }) {
  const started = Date.now();
  const workspaceId = ctx.workspace_id;
  const rows = await base44.asServiceRole.entities.MCPConnection.filter({ workspace_id: workspaceId }, "name", 50);
  const known = rows.map((r) => r.name);
  const fail = async (code, message, details, conn) => {
    await recordInvocation(base44, ctx, { connection_id: conn?.id || null, connection_name: String(connection_name || ""), tool_name: String(tool_name || ""), ok: false, error_code: code, error_message: String(message).slice(0, 500), duration_ms: Date.now() - started, arguments_preview: JSON.stringify(args ?? null).slice(0, PREVIEW_CHARS) });
    throw mcpError(code, message, details);
  };

  const row = rows.find((r) => r.name === connection_name);
  if (!row) await fail("MCP_CONNECTION_NOT_FOUND", `no MCP connection named '${connection_name}' is available to this account (available: ${known.join(", ") || "none"})`, { known_connections: known });
  if (row.enabled === false) await fail("MCP_DISABLED", `the MCP connection '${row.name}' is disabled — enable it in MCP Connections before using its tools`, { connection: row.name }, row);

  const tool = (row.tools || []).find((t) => t.name === tool_name);
  if (!tool) await fail("MCP_TOOL_NOT_FOUND", `connection '${row.name}' has no discovered tool '${tool_name}' (tools: ${(row.tools || []).map((t) => t.name).join(", ") || "none — run Test/Refresh on the connection"})`, { connection: row.name, known_tools: (row.tools || []).map((t) => t.name) }, row);
  // Discuss mode must never cause an external side effect: only server-declared
  // read-only tools may be invoked there.
  if (ctx.mode === "discuss" && !tool.read_only) {
    await fail("MCP_NOT_ALLOWED", `tool '${tool_name}' is not declared read-only by ${row.name}, so it cannot be invoked in discuss mode (read-only mode). Answer from connection metadata instead.`, { connection: row.name, tool: tool_name, mode: "discuss" }, row);
  }
  // G-2 lifecycle parity for the run path: only a MUTATING external tool can carry a side
  // effect out of a suspended/terminated workspace — an in-flight run must not produce
  // external changes while the account is frozen. Read-only tools, and every discuss-mode
  // path (already restricted to read-only tools above), are unchanged: reads stay available.
  if (tool.read_only !== true) {
    const workspace = await base44.asServiceRole.entities.Workspace.get(workspaceId).catch(() => null);
    if (!workspace) await fail("MCP_CONNECTION_NOT_FOUND", `the workspace owning connection '${row.name}' is no longer available`, { connection: row.name }, row);
    try { requireActiveWorkspace(workspace, null); }
    catch (e) { await fail(e.code || "MCP_NOT_ALLOWED", e.message, { connection: row.name, tool: tool_name, workspace_status: e.workspace_status || null }, row); }
  }
  const missing = requiredMissing(tool.input_schema, args);
  if (missing.length) await fail("MCP_INVALID_INPUT", `missing required argument(s) for ${row.name}.${tool_name}: ${missing.join(", ")}. Input schema: ${tool.input_schema}`, { connection: row.name, tool: tool_name, missing }, row);

  // Bounded, workspace+connection+host circuit breaker over the LOGICAL upstream call. Reuses the
  // SAME state machine and failure classification as project integrations; OPEN refuses before the
  // upstream is contacted. Only upstream-unhealthy signals count (5xx, timeout, connection/DNS);
  // auth, validation, 4xx business errors, 429, tool errors and policy refusals never do.
  let breakerHost = null;
  try { breakerHost = new URL(row.server_url).hostname || null; } catch { breakerHost = null; }
  const breakerConf = breakerConfig({});
  const breaker = breakerHost ? createMcpBreaker(base44, { workspace_id: workspaceId, trace_id: ctx.trace_id || null }) : null;
  const gate = breaker && breakerHost ? await breaker.check({ integration: row.name, host: breakerHost, config: breakerConf }).catch(() => null) : null;
  if (gate && !gate.allow) {
    await fail("MCP_CIRCUIT_OPEN", `the circuit breaker for ${breakerHost} is ${gate.breaker_state?.state || "OPEN"} after repeated upstream failures; the request was not sent`, { connection: row.name, tool: tool_name, host: breakerHost, kind: "circuit_open", breaker: gate.breaker_state }, row);
  }

  let secretValue = null;
  try { secretValue = await resolveWorkspaceSecret(base44, workspaceId, row.secret_name); } catch { secretValue = null; }
  const safe = (t) => redactSecrets(t, secretValue ? [secretValue] : []);

  let normalized;
  try {
    const client = createMcpClient(connectionMetadata(row), secretValue, { timeoutMs: ctx.timeout_ms });
    await client.initialize();
    const raw = await client.callTool(tool_name, args);
    normalized = normalizeToolResult(raw, client.safe);
    if (normalized.is_error) throw mcpError("MCP_TOOL_EXECUTION_FAILURE", `${row.name}.${tool_name} reported a tool error: ${normalized.text.slice(0, 300)}`, { connection: row.name, tool: tool_name, kind: "tool_error" });
    // Settle the breaker ONCE for the logical call: a success closes a half-open probe / clears the window.
    if (breaker && breakerHost) await breaker.record({ integration: row.name, host: breakerHost, config: breakerConf, probe_token: gate?.probe_token || null, ok: true }).catch(() => null);
  } catch (e) {
    const code = MCP_ERROR_CODES.includes(e.code) ? e.code : "MCP_TOOL_EXECUTION_FAILURE";
    // Settle the breaker ONCE for the logical call: only upstream-unhealthy signals count.
    if (breaker && breakerHost) await breaker.record({ integration: row.name, host: breakerHost, config: breakerConf, probe_token: gate?.probe_token || null, ...mcpBreakerOutcome(e) }).catch(() => null);
    await fail(code, safe(e.message), { connection: row.name, tool: tool_name, ...(e.details || {}) }, row);
  }

  const resultText = JSON.stringify({ text: normalized.text, structured: normalized.structured });
  await recordInvocation(base44, ctx, {
    connection_id: row.id, connection_name: row.name, tool_name, ok: true, duration_ms: Date.now() - started,
    arguments_preview: safe(JSON.stringify(args ?? null)).slice(0, PREVIEW_CHARS),
    result_preview: normalized.text.slice(0, PREVIEW_CHARS), result_bytes: resultText.length,
  });
  return { connection: row.name, tool: tool_name, server: row.server_name || null, duration_ms: Date.now() - started, ...normalized };
}