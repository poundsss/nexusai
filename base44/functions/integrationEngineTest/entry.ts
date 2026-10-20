// Real test for the integration engine: executable MCP integrations, OAuth2 token exchange,
// OpenAPI JSON *and* YAML import, retry/idempotency policy, credential injection and
// redaction — all driven through the REAL production path
// (executeProjectFunction → createIntegrationsApi → adapters), against a throwaway project
// with real ProjectSecret rows.
//
// Only the network boundary is scripted: globalThis.fetch is replaced by a controlled
// upstream/MCP server for the duration of the test, so every line of platform code under
// test is the real one. Nothing about the platform itself is mocked.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { normalizeIntegration, importOpenApi, secretRefs } from "../../shared/integrations.ts";
import { parseYaml } from "../../shared/yaml.ts";
import { clearOAuthCache, isRetryable, setDnsLookupForTests } from "../../shared/externalTools.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { createFs } from "../../shared/projectFs.ts";
import { executeTool } from "../../shared/tools.ts";

const OPENAPI_YAML = `openapi: 3.0.1
info:
  title: Widget API
  description: >
    A widget service
    used for testing.
  version: "1.2.0"
servers:
  - url: https://api.example.com/v2
security:
  - ApiKeyAuth: []
components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-Widget-Key
  schemas:
    Widget:
      type: object
      properties:
        id: { type: string }
        title:
          type: string
paths:
  /widgets:
    get:
      operationId: listWidgets
      summary: List widgets # trailing comment
      parameters:
        - name: limit
          in: query
          required: false
          schema:
            type: integer
        - name: tags
          in: query
          schema:
            type: array
      responses:
        "200":
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Widget'
    post:
      operationId: createWidget
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                title: { type: string }
      responses:
        "201":
          description: created
  /widgets/{id}:
    get:
      operationId: getWidget
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200":
          description: ok
`;

const FN_HTTP = `export const config = { method: 'POST', description: 'calls an api-key integration' };
export default async function handler(ctx) {
  const res = await ctx.integrations.widgets.listWidgets({ limit: 5 });
  return { status: 200, body: { upstream: res.body, attempts: res.attempts } };
}
`;
const FN_OAUTH = `export const config = { method: 'POST', description: 'calls an oauth2 integration twice' };
export default async function handler(ctx) {
  const first = await ctx.integrations.secure.getProfile({});
  const second = await ctx.integrations.secure.getProfile({});
  return { status: 200, body: { first: first.body, second: second.body } };
}
`;
const FN_FLAKY = `export const config = { method: 'POST', description: 'retryable GET' };
export default async function handler(ctx) {
  const res = await ctx.integrations.flaky.getStatus({});
  return { status: 200, body: { body: res.body, attempts: res.attempts } };
}
`;
const FN_UNSAFE_POST = `export const config = { method: 'POST', description: 'non-idempotent POST must not be retried' };
export default async function handler(ctx) {
  try {
    await ctx.integrations.flaky.submit({}, { body: { a: 1 } });
    return { status: 200, body: { retried: 'no error' } };
  } catch (e) {
    return { status: 200, body: { code: e.code, attempts: e.details.attempts } };
  }
}
`;
const FN_MCP = `export const config = { method: 'POST', description: 'calls an MCP server tool' };
export default async function handler(ctx) {
  const res = await ctx.integrations.tickets.searchTickets({ query: 'billing' });
  return { status: 200, body: { text: res.body.text, structured: res.body.structured } };
}
`;
const FN_MCP_MISSING_ARG = `export const config = { method: 'POST', description: 'MCP call with a missing required argument' };
export default async function handler(ctx) {
  try {
    await ctx.integrations.tickets.searchTickets({});
    return { status: 200, body: { validated: false } };
  } catch (e) {
    return { status: 200, body: { code: e.code, message: e.message } };
  }
}
`;
const FN_MCP_TOOL_ERROR = `export const config = { method: 'POST', description: 'MCP tool that reports an error' };
export default async function handler(ctx) {
  try {
    await ctx.integrations.tickets.brokenTool({});
    return { status: 200, body: { threw: false } };
  } catch (e) {
    return { status: 200, body: { code: e.code, message: e.message } };
  }
}
`;

const TOKEN_VALUE = "tok_live_9f3a7c2b8e1d4f60";
const API_KEY_VALUE = "wk_live_5b8c1d0a7e2f4936";
const CLIENT_SECRET_VALUE = "cs_live_31d6cfe0d16ae931";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const realFetch = globalThis.fetch;
  const calls = [];
  let project = null;

  // --- scripted upstream (network boundary only) ------------------------------
  let flakyGetHits = 0, flakyPostHits = 0;
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const TEST_HOSTS = ["auth.example.com", "api.example.com", "mcp.example.com"];
  // DNS is scripted alongside fetch: the platform's DNS-rebinding pre-flight resolves the
  // fixture hosts through this hook (a public address, like a real upstream would), so the
  // scripted fetch below stays the only network path the engine ever takes.
  setDnsLookupForTests((host) => {
    if (!TEST_HOSTS.includes(host)) throw new Error(`unscripted host ${host}`);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    // Anything that is not the scripted upstream (the platform's own API calls) goes to the
    // real network, so the test exercises real persistence.
    if (!TEST_HOSTS.includes(u.hostname)) return realFetch(url, options);
    const headers = new Headers(options.headers || {});
    const body = typeof options.body === "string" ? options.body : "";
    calls.push({ url: u.toString(), method: options.method || "GET", auth: headers.get("authorization") || null, apiKey: headers.get("x-widget-key") || null, body });

    if (u.hostname === "auth.example.com") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "client_credentials") return json({ error: "unsupported_grant_type" }, 400);
      if (form.get("client_id") !== "client-abc" || form.get("client_secret") !== CLIENT_SECRET_VALUE) return json({ error: "invalid_client" }, 401);
      return json({ access_token: TOKEN_VALUE, token_type: "Bearer", expires_in: 120 });
    }
    if (u.hostname === "api.example.com") {
      if (u.pathname === "/v2/widgets") {
        if (headers.get("x-widget-key") !== API_KEY_VALUE) return json({ error: "missing key" }, 401);
        return json({ items: [{ id: "w1", title: "Widget" }], limit: u.searchParams.get("limit") });
      }
      if (u.pathname === "/v1/profile") {
        const bearer = headers.get("authorization") || "";
        if (bearer !== `Bearer ${TOKEN_VALUE}`) return json({ error: "unauthorized" }, 401);
        // Deliberately echoes the live token back: the platform must redact it.
        return json({ user: "ada", echoed_token: TOKEN_VALUE });
      }
      if (u.pathname === "/v1/status") {
        flakyGetHits++;
        if (flakyGetHits < 3) return json({ error: "unavailable" }, 503, { "retry-after": "0" });
        return json({ state: "ok", hits: flakyGetHits });
      }
      if (u.pathname === "/v1/submit") { flakyPostHits++; return json({ error: "unavailable" }, 503); }
    }
    if (u.hostname === "mcp.example.com") {
      const rpc = JSON.parse(body || "{}");
      if (rpc.method === "initialize") {
        if (headers.get("authorization") !== `Bearer ${TOKEN_VALUE}`) return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "unauthorized" } }, 401);
        return json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "tickets-mcp", version: "0.9" }, capabilities: { tools: {} } } });
      }
      if (rpc.method === "notifications/initialized") return new Response("", { status: 202 });
      if (rpc.method === "tools/call") {
        if (rpc.params?.name === "broken_tool") return json({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: "the ticket service is down" }] } });
        if (rpc.params?.name !== "search_tickets") return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `unknown tool ${rpc.params?.name}` } });
        return json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `2 tickets for ${rpc.params.arguments.query}` }], structuredContent: { count: 2, query: rpc.params.arguments.query } } });
      }
      return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
    }
    return json({ error: "unexpected host in test" }, 500);
  };

  try {
    // ===================== OpenAPI: YAML and JSON ==========================
    const doc = parseYaml(OPENAPI_YAML);
    check("YAML parses nested maps, sequences and flow collections", doc.openapi === "3.0.1" && doc.servers[0].url === "https://api.example.com/v2" && doc.components.schemas.Widget.properties.id.type === "string" && Array.isArray(doc.security), JSON.stringify(doc.info || {}).slice(0, 120));
    check("YAML folds block scalars and strips comments", typeof doc.info.description === "string" && doc.info.description.includes("A widget service used for testing.") && doc.paths["/widgets"].get.summary === "List widgets", JSON.stringify(doc.info.description));
    check("YAML keeps quoted scalars as strings", doc.info.version === "1.2.0", typeof doc.info.version);

    const yamlImport = importOpenApi(OPENAPI_YAML, { name: "widgets", secret: "WIDGETS_API_KEY", openapi_url: "https://api.example.com/openapi.yaml" });
    const ops = yamlImport.integration.operations;
    check("a YAML OpenAPI document imports into a real integration", yamlImport.format === "yaml" && yamlImport.imported === 3 && ops.map((o) => o.name).sort().join(",") === "createWidget,getWidget,listWidgets", `${yamlImport.imported} ops: ${ops.map((o) => o.name).join(",")}`);
    check("YAML import resolves base_url, auth and parameters", yamlImport.integration.base_url === "https://api.example.com/v2" && yamlImport.integration.auth.type === "api_key" && yamlImport.integration.auth.header_name === "X-Widget-Key" && ops.find((o) => o.name === "getWidget").parameters.some((p) => p.in === "path" && p.required) && ops.find((o) => o.name === "createWidget").request_body?.content_type === "application/json", JSON.stringify(yamlImport.integration.auth));
    const jsonImport = importOpenApi(JSON.stringify(doc), { name: "widgets", secret: "WIDGETS_API_KEY" });
    check("JSON and YAML imports converge on the same definition", jsonImport.format === "json" && JSON.stringify(jsonImport.integration.operations) === JSON.stringify(ops.map((o) => o)), "same operations");
    let badYaml = null;
    try { importOpenApi("openapi: 3.0.0\npaths:\n  - [broken", {}); } catch (e) { badYaml = e; }
    check("a malformed document fails loudly", !!badYaml && /YAML error|neither valid JSON nor valid YAML|not a valid|paths/.test(badYaml.message), badYaml?.message);

    // ===================== definition-level validation ======================
    const mcpDoc = normalizeIntegration({
      name: "tickets", type: "mcp", server_url: "https://mcp.example.com/rpc",
      auth: { type: "oauth2", grant: "client_credentials", token_url: "https://auth.example.com/oauth/token", client_id: "client-abc", secret: "TICKETS_CLIENT_SECRET" },
      operations: [
        { name: "searchTickets", tool: "search_tickets", read_only: true, input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "brokenTool", tool: "broken_tool" },
      ],
    });
    check("an MCP integration normalizes to tool bindings", mcpDoc.type === "mcp" && mcpDoc.server_url === "https://mcp.example.com/rpc" && mcpDoc.operations[0].tool === "search_tickets" && mcpDoc.operations[0].read_only === true && !mcpDoc.base_url, JSON.stringify(mcpDoc.operations[0]));
    check("oauth2 auth normalizes with its token endpoint", mcpDoc.auth.type === "oauth2" && mcpDoc.auth.grant === "client_credentials" && mcpDoc.auth.token_url === "https://auth.example.com/oauth/token" && secretRefs(mcpDoc).join(",") === "TICKETS_CLIENT_SECRET", JSON.stringify(mcpDoc.auth));
    const rejects = [
      ["a credential value in auth", () => normalizeIntegration({ name: "x", base_url: "https://a.com", auth: { type: "bearer", token: "secret-value" }, operations: [] })],
      ["an oauth2 config without token_url", () => normalizeIntegration({ name: "x", base_url: "https://a.com", auth: { type: "oauth2", client_id: "a", secret: "A_SECRET" }, operations: [] })],
      ["an oauth2 config without client_id", () => normalizeIntegration({ name: "x", base_url: "https://a.com", auth: { type: "oauth2", token_url: "https://a.com/t", secret: "A_SECRET" }, operations: [] })],
      ["a lowercase client_secret reference", () => normalizeIntegration({ name: "x", base_url: "https://a.com", auth: { type: "oauth2", grant: "refresh_token", token_url: "https://a.com/t", client_id: "a", secret: "A_SECRET", client_secret: "not_a_name" }, operations: [] })],
      ["an mcp integration without a server_url", () => normalizeIntegration({ name: "x", type: "mcp", auth: { type: "none" }, operations: [] })],
      ["an mcp integration authenticated by query key", () => normalizeIntegration({ name: "x", type: "mcp", server_url: "https://m.com/rpc", auth: { type: "api_key", secret: "A_KEY", in: "query" }, operations: [] })],
      ["an unknown grant type", () => normalizeIntegration({ name: "x", base_url: "https://a.com", auth: { type: "oauth2", grant: "password", token_url: "https://a.com/t", client_id: "a", secret: "A_SECRET" }, operations: [] })],
    ];
    for (const [label, fn] of rejects) {
      let err = null;
      try { fn(); } catch (e) { err = e; }
      check(`definition validation rejects ${label}`, !!err, err?.message);
    }
    const retryDoc = normalizeIntegration({ name: "flaky", base_url: "https://api.example.com/v1", auth: { type: "none" }, retry: { max_attempts: 9 }, operations: [{ name: "getStatus", method: "GET", path: "/status" }, { name: "submit", method: "POST", path: "/submit" }] });
    check("retry policy is bounded and defaulted", retryDoc.retry.max_attempts === 3 && retryDoc.retry.retry_on_status.includes(503) && retryDoc.retry.backoff_ms >= 50, JSON.stringify(retryDoc.retry));
    check("retry eligibility is idempotency-aware", isRetryable(retryDoc, retryDoc.operations[0], { kind: "status", status: 503 }) && !isRetryable(retryDoc, retryDoc.operations[1], { kind: "status", status: 503 }) && isRetryable(retryDoc, retryDoc.operations[0], { kind: "timeout" }) && !isRetryable(retryDoc, retryDoc.operations[0], { kind: "status", status: 404 }), "GET retried, POST never");

    // The AI tool surface must be able to declare both kinds.
    const toolCtx = {
      fs: createFs([
        { id: "t1", path: "src/main.js", content: "import { html, render } from 'runtime';\nimport App from './App.js';\nrender(html`<${App} />`, document.getElementById('app'));\n" },
        { id: "t2", path: "src/App.js", content: "import { html } from 'runtime';\nexport default function App() {\n  return html`<div class=\"page\">hi</div>`;\n}\n" },
        { id: "t3", path: "styles.css", content: ".page { display: block; }\n" },
      ]),
      entities: [], secrets: [], deletes: 0,
    };
    const mcpTool = await executeTool(toolCtx, "create_integration", { name: "tickets", type: "mcp", server_url: "https://mcp.example.com/rpc", auth: { type: "bearer", secret: "TICKETS_TOKEN" }, operations: [{ name: "searchTickets", tool: "search_tickets" }] }, "default");
    check("create_integration can declare an executable MCP integration", mcpTool.ok && mcpTool.result.integration.type === "mcp" && toolCtx.secrets.some((s) => s.name === "TICKETS_TOKEN"), mcpTool.error);
    const oauthTool = await executeTool(toolCtx, "create_integration", { name: "secure", base_url: "https://api.example.com/v1", auth: { type: "oauth2", grant: "refresh_token", token_url: "https://auth.example.com/oauth/token", client_id: "client-abc", secret: "SECURE_REFRESH_TOKEN", client_secret: "SECURE_CLIENT_SECRET" }, operations: [{ name: "getProfile", method: "GET", path: "/profile" }] }, "default");
    check("both oauth2 secret references become declared secrets", oauthTool.ok && toolCtx.secrets.some((s) => s.name === "SECURE_REFRESH_TOKEN") && toolCtx.secrets.some((s) => s.name === "SECURE_CLIENT_SECRET"), oauthTool.error);
    const build = runBuild(toolCtx.fs, [], toolCtx.secrets);
    check("MCP and OAuth2 integrations pass the build", build.status === "success" && build.integrations.some((i) => i.type === "mcp") && !build.logs.some((l) => l.includes("NOT_IMPLEMENTED")), build.logs.filter((l) => l.startsWith("error")).join(" | "));

    // ===================== real execution path =============================
    project = await svc.entities.Project.create({ workspace_id: `integ-ws-${Date.now()}`, name: `Integration Test ${Date.now()}`, slug: `integ-${Date.now()}` });
    for (const [name, value] of [["WIDGETS_API_KEY", API_KEY_VALUE], ["TICKETS_CLIENT_SECRET", CLIENT_SECRET_VALUE], ["SECURE_CLIENT_SECRET", CLIENT_SECRET_VALUE]]) {
      await svc.entities.ProjectSecret.create({ project_id: project.id, name, value, required: true });
    }
    const httpIntegration = normalizeIntegration({ ...yamlImport.integration, retry: { max_attempts: 1 } });
    const oauthIntegration = normalizeIntegration({
      name: "secure", base_url: "https://api.example.com/v1",
      auth: { type: "oauth2", grant: "client_credentials", token_url: "https://auth.example.com/oauth/token", client_id: "client-abc", secret: "SECURE_CLIENT_SECRET" },
      operations: [{ name: "getProfile", method: "GET", path: "/profile" }],
    });
    const run = (name, source, integrations) => executeProjectFunction(svc, {
      project, entities: [], integrations, name, source, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: {} }, messagingTransport: "test",
    });

    clearOAuthCache();
    const httpRun = await run("callWidgets", FN_HTTP, [httpIntegration]);
    check("an imported integration executes with server-side key injection", httpRun.status === 200 && httpRun.body.upstream?.items?.[0]?.id === "w1" && httpRun.body.upstream.limit === "5" && calls.some((c) => c.apiKey === API_KEY_VALUE), JSON.stringify(httpRun.body).slice(0, 200));
    check("the API key never appears in the function's response", !JSON.stringify(httpRun.body).includes(API_KEY_VALUE), "no key in body");

    const before = calls.filter((c) => c.url.includes("auth.example.com")).length;
    const oauthRun = await run("callSecure", FN_OAUTH, [oauthIntegration]);
    const tokenCalls = calls.filter((c) => c.url.includes("auth.example.com")).length - before;
    check("oauth2 client_credentials mints a token and calls the API with it", oauthRun.status === 200 && oauthRun.body.first?.user === "ada" && calls.some((c) => c.auth === `Bearer ${TOKEN_VALUE}`), JSON.stringify(oauthRun.body).slice(0, 200));
    check("the minted access token is cached for its lifetime", tokenCalls === 1, `${tokenCalls} token request(s) for 2 API calls`);
    check("a minted token is redacted from the response body", !JSON.stringify(oauthRun.body).includes(TOKEN_VALUE) && JSON.stringify(oauthRun.body).includes("[REDACTED]"), JSON.stringify(oauthRun.body).slice(0, 200));
    check("the client secret never leaves the server", !JSON.stringify(oauthRun.body).includes(CLIENT_SECRET_VALUE) && !JSON.stringify(oauthRun.logs || []).includes(CLIENT_SECRET_VALUE), "no client secret");

    flakyGetHits = 0;
    const flakyRun = await run("callFlaky", FN_FLAKY, [retryDoc]);
    check("a transient 503 on an idempotent GET is retried until it succeeds", flakyRun.status === 200 && flakyRun.body.body?.state === "ok" && flakyRun.body.attempts === 3 && flakyGetHits === 3, `attempts=${flakyRun.body.attempts}, upstream hits=${flakyGetHits}`);
    flakyPostHits = 0;
    const postRun = await run("callSubmit", FN_UNSAFE_POST, [retryDoc]);
    check("a non-idempotent POST is never retried", postRun.status === 200 && postRun.body.code === "UPSTREAM_FAILURE" && postRun.body.attempts === 1 && flakyPostHits === 1, `code=${postRun.body.code}, upstream hits=${flakyPostHits}`);

    const mcpRun = await run("callTickets", FN_MCP, [mcpDoc]);
    check("an MCP integration really executes a server tool", mcpRun.status === 200 && mcpRun.body.text === "2 tickets for billing" && mcpRun.body.structured?.count === 2, JSON.stringify(mcpRun.body).slice(0, 200));
    check("MCP calls authenticate with the oauth2 token, server-side", calls.some((c) => c.url.includes("mcp.example.com") && c.auth === `Bearer ${TOKEN_VALUE}`) && !JSON.stringify(mcpRun.body).includes(TOKEN_VALUE), "bearer sent, not returned");
    const mcpBad = await run("callTicketsBad", FN_MCP_MISSING_ARG, [mcpDoc]);
    check("MCP input schemas are enforced before the call", mcpBad.body.code === "INVALID_INPUT" && /query/.test(mcpBad.body.message || ""), JSON.stringify(mcpBad.body).slice(0, 200));
    const mcpErr = await run("callTicketsBroken", FN_MCP_TOOL_ERROR, [mcpDoc]);
    check("an MCP tool error surfaces as an upstream failure", mcpErr.body.code === "UPSTREAM_FAILURE" && /ticket service is down/.test(mcpErr.body.message || ""), JSON.stringify(mcpErr.body).slice(0, 200));

    // Missing credential and disabled integration stay structural, never silent.
    const noSecret = await run("callNoSecret", FN_HTTP, [normalizeIntegration({ ...httpIntegration, auth: { type: "api_key", secret: "NOT_CONFIGURED_KEY", in: "header", header_name: "X-Widget-Key" } })]);
    check("a missing integration credential fails as AUTH_FAILURE (502)", noSecret.status === 502 && noSecret.body.code === "AUTH_FAILURE" && /NOT_CONFIGURED_KEY/.test(noSecret.body.error), JSON.stringify(noSecret.body));
    const disabled = await run("callDisabled", FN_MCP, [normalizeIntegration({ ...mcpDoc, status: "disabled" })]);
    check("a disabled MCP integration refuses to execute", disabled.status === 500 && /disabled/.test(disabled.body.error || ""), JSON.stringify(disabled.body));
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    globalThis.fetch = realFetch;
    setDnsLookupForTests(null);
    clearOAuthCache();
    if (project) {
      for (const entity of ["ProjectSecret", "FunctionInvocation"]) {
        const rows = await svc.entities[entity].filter({ project_id: project.id }, "-created_date", 200).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
      await svc.entities.Project.delete(project.id).catch(() => {});
      const left = await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 5).catch(() => []);
      results.push({ name: "scratch project and secrets cleaned up", ok: left.length === 0, detail: `${left.length} secret rows left` });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}