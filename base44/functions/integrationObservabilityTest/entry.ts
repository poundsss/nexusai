// Focused certification for #31A — Integration Invocation Observability.
//
// Everything runs through the REAL production path (executeProjectFunction →
// createIntegrationsApi → executeExternalTool → adapters → observer), against a throwaway
// project with real ProjectSecret rows. Only the network boundary is scripted, so every line of
// platform code under test is the real one.
//
// Scope: the observability layer only. Adapter behaviour, OAuth2, the retry engine, SSRF guards
// and webhooks are covered by integrationEngineTest and are asserted here only where the new
// records must agree with them.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { normalizeIntegration } from "../../shared/integrations.ts";
import { clearOAuthCache, setDnsLookupForTests } from "../../shared/externalTools.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { listIntegrationInvocations } from "../../shared/integrationObservability.ts";

const FN = (body) => `export const config = { method: 'POST' };\nexport default async function handler(ctx) {\n${body}\n}\n`;
const FN_HTTP = FN(`  const res = await ctx.integrations.widgets.listWidgets({ limit: 5 });\n  return { status: 200, body: { items: res.body.items, attempts: res.attempts } };`);
const FN_OAUTH = FN(`  const res = await ctx.integrations.secure.getProfile({});\n  return { status: 200, body: { user: res.body.user } };`);
const FN_FLAKY = FN(`  const res = await ctx.integrations.flaky.getStatus({});\n  return { status: 200, body: { attempts: res.attempts } };`);
const FN_POST = FN(`  try { await ctx.integrations.flaky.submit({}, { body: { a: 1 } }); return { status: 200, body: {} }; }\n  catch (e) { return { status: 200, body: { code: e.code } }; }`);
const FN_MCP = FN(`  const res = await ctx.integrations.tickets.searchTickets({ query: 'billing' });\n  return { status: 200, body: { text: res.body.text } };`);

const TOKEN_VALUE = "tok_live_9f3a7c2b8e1d4f60";
const API_KEY_VALUE = "wk_live_5b8c1d0a7e2f4936";
const CLIENT_SECRET_VALUE = "cs_live_31d6cfe0d16ae931";
const TEST_HOSTS = ["auth.example.com", "api.example.com", "mcp.example.com"];

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const realFetch = globalThis.fetch;
  const TRACE = `t_obs_${Date.now().toString(36)}`;
  let project = null, other = null;

  let flakyGets = 0;
  setDnsLookupForTests((host) => {
    if (!TEST_HOSTS.includes(host)) throw new Error(`unscripted host ${host}`);
    return [{ address: "93.184.216.34", family: 4 }];
  });
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (!TEST_HOSTS.includes(u.hostname)) return realFetch(url, options);
    const headers = new Headers(options.headers || {});
    const body = typeof options.body === "string" ? options.body : "";
    if (u.hostname === "auth.example.com") {
      const form = new URLSearchParams(body);
      if (form.get("client_secret") !== CLIENT_SECRET_VALUE) return json({ error: "invalid_client" }, 401);
      return json({ access_token: TOKEN_VALUE, token_type: "Bearer", expires_in: 120 });
    }
    if (u.hostname === "api.example.com") {
      if (u.pathname === "/v2/widgets") return headers.get("x-widget-key") === API_KEY_VALUE ? json({ items: [{ id: "w1" }] }) : json({ error: "missing key" }, 401);
      // Deliberately echoes the live token back: it must not reach any observability record.
      if (u.pathname === "/v1/profile") return headers.get("authorization") === `Bearer ${TOKEN_VALUE}` ? json({ user: "ada", echoed_token: TOKEN_VALUE }) : json({ error: "unauthorized" }, 401);
      if (u.pathname === "/v1/status") { flakyGets++; return flakyGets < 3 ? json({ error: "unavailable" }, 503, { "retry-after": "0" }) : json({ state: "ok" }); }
      if (u.pathname === "/v1/submit") return json({ error: "unavailable" }, 503);
      if (u.pathname === "/v1/limited") return json({ error: "slow down" }, 429, { "retry-after": "0" });
    }
    if (u.hostname === "mcp.example.com") {
      const rpc = JSON.parse(body || "{}");
      if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "tickets", version: "1" }, capabilities: { tools: {} } } });
      if (rpc.method === "notifications/initialized") return new Response("", { status: 202 });
      if (rpc.method === "tools/call") return json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "2 tickets" }], structuredContent: { count: 2 } } });
      return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
    }
    return json({ error: "unexpected host" }, 500);
  };

  try {
    const ws = `obs-ws-${Date.now()}`;
    project = await svc.entities.Project.create({ workspace_id: ws, name: `Obs Test ${Date.now()}`, slug: `obs-${Date.now()}` });
    other = await svc.entities.Project.create({ workspace_id: `obs-ws2-${Date.now()}`, name: `Obs Other ${Date.now()}`, slug: `obs-other-${Date.now()}` });
    for (const [name, value] of [["WIDGETS_API_KEY", API_KEY_VALUE], ["SECURE_CLIENT_SECRET", CLIENT_SECRET_VALUE]]) {
      await svc.entities.ProjectSecret.create({ project_id: project.id, name, value, required: true });
    }

    const widgets = normalizeIntegration({ name: "widgets", type: "openapi", base_url: "https://api.example.com/v2", auth: { type: "api_key", secret: "WIDGETS_API_KEY", in: "header", header_name: "X-Widget-Key" }, retry: { max_attempts: 1 }, operations: [{ name: "listWidgets", method: "GET", path: "/widgets", parameters: [{ name: "limit", in: "query" }] }] });
    const secure = normalizeIntegration({ name: "secure", base_url: "https://api.example.com/v1", auth: { type: "oauth2", grant: "client_credentials", token_url: "https://auth.example.com/oauth/token", client_id: "client-abc", secret: "SECURE_CLIENT_SECRET" }, operations: [{ name: "getProfile", method: "GET", path: "/profile" }] });
    const flaky = normalizeIntegration({ name: "flaky", base_url: "https://api.example.com/v1", auth: { type: "none" }, retry: { max_attempts: 3, backoff_ms: 50 }, operations: [{ name: "getStatus", method: "GET", path: "/status" }, { name: "submit", method: "POST", path: "/submit" }, { name: "getLimited", method: "GET", path: "/limited" }] });
    const tickets = normalizeIntegration({ name: "tickets", type: "mcp", server_url: "https://mcp.example.com/rpc", auth: { type: "none" }, operations: [{ name: "searchTickets", tool: "search_tickets", read_only: true, input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] });
    const noSecret = normalizeIntegration({ ...widgets, name: "widgets_unset", auth: { type: "api_key", secret: "NOT_CONFIGURED_KEY", in: "header", header_name: "X-Widget-Key" } });

    const run = (name, source, integrations) => executeProjectFunction(svc, {
      project, entities: [], integrations, name, source, trigger: "test", requestId: crypto.randomUUID(),
      request: { method: "POST", query: {}, headers: {}, body: {} }, messagingTransport: "test", trace_id: TRACE,
    });

    clearOAuthCache();
    const httpRun = await run("callWidgets", FN_HTTP, [widgets]);
    const oauthRun = await run("callSecure", FN_OAUTH, [secure]);
    flakyGets = 0;
    const flakyRun = await run("callFlaky", FN_FLAKY, [flaky]);
    const postRun = await run("callSubmit", FN_POST, [flaky]);
    const mcpRun = await run("callTickets", FN_MCP, [tickets]);
    const authRun = await run("callNoSecret", FN(`  const res = await ctx.integrations.widgets_unset.listWidgets({ limit: 5 });\n  return { status: 200, body: { items: res.body.items } };`), [noSecret]);
    const limitedRun = await run("callLimited", FN(`  try { await ctx.integrations.flaky.getLimited({}); return { status: 200, body: {} }; } catch (e) { return { status: 200, body: { code: e.code } }; }`), [flaky]);

    const rows = await listIntegrationInvocations(svc, { project_id: project.id, limit: 100 });
    const byOp = (integration, operation) => rows.filter((r) => r.integration_name === integration && r.operation === operation);
    const one = (integration, operation) => byOp(integration, operation)[0] || {};

    // 1. successful invocation
    const ok = one("widgets", "listWidgets");
    check("1. a successful call produces one durable invocation record", httpRun.status === 200 && byOp("widgets", "listWidgets").length === 1 && ok.ok === true && ok.status === 200 && ok.attempts === 1 && ok.host === "api.example.com" && ok.method === "GET" && ok.latency_ms >= 0 && !!ok.invocation_id && !!ok.started_at && !!ok.completed_at, JSON.stringify({ id: ok.invocation_id, status: ok.status, attempts: ok.attempts, host: ok.host, latency_ms: ok.latency_ms }));
    check("1b. the record carries no URL, query string or header material", !JSON.stringify(ok).includes("X-Widget-Key") && !JSON.stringify(ok).includes("https://"), `host=${ok.host}`);

    // 2. retry folds into ONE record with the total attempt count
    const retried = byOp("flaky", "getStatus");
    check("2. three HTTP attempts of one logical call produce ONE record with attempts=3", flakyRun.status === 200 && retried.length === 1 && retried[0].attempts === 3 && retried[0].ok === true && retried[0].status === 200 && flakyGets === 3, `records=${retried.length}, attempts=${retried[0]?.attempts}, upstream hits=${flakyGets}`);

    // 3. MCP invocation
    const mcp = one("tickets", "searchTickets");
    check("3. an MCP tool call is recorded through the mcp adapter", mcpRun.status === 200 && mcp.integration_type === "mcp" && mcp.method === "MCP" && mcp.tool === "search_tickets" && mcp.host === "mcp.example.com" && mcp.ok === true, JSON.stringify({ type: mcp.integration_type, method: mcp.method, tool: mcp.tool, host: mcp.host }));

    // 4. OAuth token usage + redaction
    const oauth = one("secure", "getProfile");
    check("4. an oauth2 call records the credential NAME it consumed, never a token", oauthRun.status === 200 && oauth.ok === true && (oauth.secret_names || []).join(",") === "SECURE_CLIENT_SECRET" && !JSON.stringify(oauth).includes(TOKEN_VALUE) && !JSON.stringify(oauth).includes(CLIENT_SECRET_VALUE), JSON.stringify(oauth.secret_names || []));

    // 5. failure classification
    const failedPost = one("flaky", "submit");
    const failedAuth = one("widgets_unset", "listWidgets");
    const limited = one("flaky", "getLimited");
    check("5a. an upstream 503 on a non-idempotent POST: upstream, not retryable, attempts=1", postRun.body.code === "UPSTREAM_FAILURE" && failedPost.ok === false && failedPost.error_code === "UPSTREAM_FAILURE" && failedPost.error_category === "upstream" && failedPost.retryable === false && failedPost.attempts === 1, JSON.stringify({ code: failedPost.error_code, category: failedPost.error_category, retryable: failedPost.retryable, attempts: failedPost.attempts }));
    check("5b. a missing credential classifies as authorization, never as an upstream fault", authRun.status === 502 && !!failedAuth && failedAuth.error_code === "AUTH_FAILURE" && failedAuth.error_category === "authorization" && failedAuth.retryable === false && failedAuth.failure_kind === "secret_not_set", JSON.stringify({ code: failedAuth?.error_code, category: failedAuth?.error_category, kind: failedAuth?.failure_kind }));
    check("5c. a 429 classifies as rate_limit and records the state it actually knows", limitedRun.body.code === "UPSTREAM_FAILURE" && limited.error_category === "rate_limit" && limited.status === 429 && limited.rate_limit_state?.limited === true, JSON.stringify({ category: limited.error_category, status: limited.status, state: limited.rate_limit_state }));
    check("5d. breaker_state records the breaker's own state, never a 'healthy upstream' claim", rows.every((r) => !r.breaker_state || (["CLOSED", "OPEN", "HALF_OPEN"].includes(r.breaker_state.state) && r.breaker_state.healthy === undefined)), "no health claim");

    // 6. trace correlation through the EXISTING tracing system
    const spans = await svc.entities.TraceEvent.filter({ trace_id: TRACE, project_id: project.id }, "at", 100);
    const callSpans = spans.filter((s) => s.event_type === "integration_call");
    const spanFor = callSpans.find((s) => s.name === "flaky.getStatus");
    check("6a. every invocation writes one span in the operation's existing trace", callSpans.length === rows.length && callSpans.every((s) => s.trace_id === TRACE), `${callSpans.length} span(s) for ${rows.length} invocation(s)`);
    check("6b. the span carries integration, operation, host, method, status, latency and attempts", !!spanFor && spanFor.metadata?.integration === "flaky" && spanFor.metadata?.operation === "getStatus" && spanFor.metadata?.host === "api.example.com" && spanFor.metadata?.method === "GET" && spanFor.metadata?.status === 200 && spanFor.attempt === 3 && spanFor.duration_ms >= 0, JSON.stringify(spanFor?.metadata || {}));
    const errSpan = callSpans.find((s) => s.name === "flaky.submit");
    check("6c. a failing span carries the error code and category", errSpan?.status === "error" && errSpan.error_code === "UPSTREAM_FAILURE" && errSpan.metadata?.error_category === "upstream", JSON.stringify({ status: errSpan?.status, code: errSpan?.error_code, category: errSpan?.metadata?.error_category }));
    check("6d. the span references the authoritative invocation record instead of copying it", callSpans.every((s) => !!s.reference_id) && rows.some((r) => r.id === spanFor?.reference_id), `reference_id=${spanFor?.reference_id}`);
    check("6e. no second correlation id is minted", rows.every((r) => r.trace_id === TRACE), "one trace id");

    // 7. credential-use audit
    const audits = (await svc.entities.AuditLog.filter({ project_id: project.id, action: "integration.credential_used" }, "-created_date", 50)) || [];
    const keyAudit = audits.find((a) => a.metadata?.integration === "widgets" && a.metadata?.ok === true);
    check("7a. a credential-consuming call is audited by integration, operation and secret NAME", audits.length >= 2 && !!keyAudit && keyAudit.resource_id === "widgets.listWidgets" && (keyAudit.metadata.secret_names || []).join(",") === "WIDGETS_API_KEY", JSON.stringify({ entries: audits.length, resource: keyAudit?.resource_id, names: keyAudit?.metadata?.secret_names }));
    check("7b. no credential VALUE reaches the audit trail", !JSON.stringify(audits).includes(API_KEY_VALUE) && !JSON.stringify(audits).includes(TOKEN_VALUE) && !JSON.stringify(audits).includes(CLIENT_SECRET_VALUE), "names only");
    check("7c. a call that consumed no secret writes no credential audit", !audits.some((a) => a.metadata?.integration === "flaky"), "no audit for unauthenticated integration");
    const secretRows = await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 10);
    check("7d. existing ProjectSecret.last_used_at stamping still happens", secretRows.filter((s) => !!s.last_used_at).length >= 2, secretRows.map((s) => `${s.name}=${!!s.last_used_at}`).join(","));

    // 8. project isolation
    const foreign = await listIntegrationInvocations(svc, { project_id: other.id, limit: 50 });
    check("8a. another project's invocations resolve to nothing", foreign.length === 0, `${foreign.length} row(s)`);
    check("8b. every record is stamped with the executing project and its workspace", rows.length > 0 && rows.every((r) => r.project_id === project.id && r.workspace_id === ws), `${rows.length} row(s) scoped`);
    let noProject = null;
    try { await listIntegrationInvocations(svc, {}); } catch (e) { noProject = e; }
    check("8c. an unscoped read is refused outright", !!noProject && noProject.code === "INVALID_INPUT", noProject?.message);

    // 9. scrubbing across every new surface
    const surfaces = JSON.stringify({ rows, spans, audits, responses: [httpRun.body, oauthRun.body, flakyRun.body, postRun.body, mcpRun.body, authRun.body] });
    check("9a. no api key, oauth token or client secret appears in any observability surface", !surfaces.includes(API_KEY_VALUE) && !surfaces.includes(TOKEN_VALUE) && !surfaces.includes(CLIENT_SECRET_VALUE), "clean");
    check("9b. no authorization/bearer header material is stored", !/authorization["']?\s*[:=]/i.test(surfaces) && !/Bearer\s+[\w.-]{8,}/.test(surfaces), "no header material");

    // 10. existing telemetry preserved
    const fnRow = await svc.entities.FunctionInvocation.filter({ project_id: project.id, function_name: "callWidgets" }, "-created_date", 1);
    check("10. FunctionInvocation.external_calls telemetry is untouched", (fnRow[0]?.external_calls || []).some((c) => c.host === "api.example.com" && c.status === 200), JSON.stringify(fnRow[0]?.external_calls || []));
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    globalThis.fetch = realFetch;
    setDnsLookupForTests(null);
    clearOAuthCache();
    for (const p of [project, other]) {
      if (!p) continue;
      for (const entity of ["IntegrationInvocation", "TraceEvent", "AuditLog", "ProjectSecret", "FunctionInvocation"]) {
        const rows = await svc.entities[entity].filter({ project_id: p.id }, "-created_date", 200).catch(() => []);
        for (const r of rows) await svc.entities[entity].delete(r.id).catch(() => {});
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}