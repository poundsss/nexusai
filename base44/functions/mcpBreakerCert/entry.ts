// Targeted certification for the MCP upstream circuit breaker.
//
// The MCP breaker REUSES the IntegrationBreaker state machine (createBreakerCore) and the
// countsAsBreakerFailure classification, scoped by workspace + connection + host. This cert
// exercises that state machine directly (deterministic, no network) for trip/open/half-open/
// recovery/isolation, and proves the wiring end-to-end: an OPEN breaker makes invokeMcpTool refuse
// with MCP_CIRCUIT_OPEN BEFORE contacting the upstream, and the MCPInvocation audit row is still
// written. Only the network boundary is scripted (a fetch guard that fails the test if the OPEN
// path contacts the upstream).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createMcpBreaker, breakerConfig, countsAsBreakerFailure, mcpBreakerKeyOf, MCP_BREAKER_NAMESPACE } from "../../shared/integrationBreaker.ts";
import { invokeMcpTool } from "../../shared/mcp.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (req) {
  const client = createClientFromRequest(req);
  const svc = client.asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const TRACE = `t_mcpbrk_${Date.now().toString(36)}`;
  const realFetch = globalThis.fetch;
  let upstreamHit = 0;
  const workspaces = [];
  const connections = [];

  // LONG open window: OPEN persists across the block/refusal assertions. SHORT open window: a probe
  // is admissible after a brief sleep, for the HALF_OPEN recovery scenarios. Each scenario uses a
  // FRESH connection name so state never bleeds between tests.
  const CONF_LONG = breakerConfig({ breaker: { threshold: 2, window_ms: 60_000, open_ms: 30_000, half_open_max_probes: 1 } });
  const CONF_FAST = breakerConfig({ breaker: { threshold: 2, window_ms: 60_000, open_ms: 800, half_open_max_probes: 1 } });
  const HOST = "up.example.com";

  const rowOf = async (workspace_id, connection_name, host) =>
    (await svc.entities.IntegrationBreaker.filter({ workspace_id, project_id: MCP_BREAKER_NAMESPACE, integration_name: connection_name, host }, "-updated_at", 1))[0] || null;
  const fail5xx = (integration, host, config) => ({ integration, host, config, ok: false, code: "UPSTREAM_FAILURE", status: 503, failure_kind: null });

  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname === HOST) { upstreamHit++; return new Response(JSON.stringify({ error: "boom" }), { status: 503, headers: { "content-type": "application/json" } }); }
    return realFetch(url, options);
  };

  try {
    // ---- 0. classification reuse + keying (pure) ----
    check("0a. MCP namespace is a reserved constant, not a project id", MCP_BREAKER_NAMESPACE === "mcp", MCP_BREAKER_NAMESPACE);
    check("0b. mcpBreakerKeyOf is workspace|connection|host", mcpBreakerKeyOf("ws1", "ci", HOST) === "ws1|ci|up.example.com", mcpBreakerKeyOf("ws1", "ci", HOST));
    check("0c. only 5xx/timeout/network count; 4xx/429/auth/tool-error do not",
      countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 503, failure_kind: null })
      && countsAsBreakerFailure({ ok: false, code: "TIMEOUT", status: 0, failure_kind: "timeout" })
      && countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 0, failure_kind: "network" })
      && !countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 422, failure_kind: "client_error" })
      && !countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 429, failure_kind: "rate_limited" })
      && !countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 401, failure_kind: "client_error" })
      && !countsAsBreakerFailure({ ok: false, code: "UPSTREAM_FAILURE", status: 0, failure_kind: "tool_error" }),
      "classification");

    const wsA = await svc.entities.Workspace.create({ name: `MCP Brk A ${Date.now()}`, owner_id: "test-user", status: "active", credits_balance: 0 });
    workspaces.push(wsA);

    // ---- 1. trip after threshold ----
    const bA = createMcpBreaker(svc, { workspace_id: wsA.id, trace_id: TRACE });
    await bA.record(fail5xx("t1", HOST, CONF_LONG));
    const afterOne = await rowOf(wsA.id, "t1", HOST);
    check("1a. one counted failure is remembered but does not open", afterOne?.state === "CLOSED" && afterOne.failure_count === 1, JSON.stringify({ state: afterOne?.state, count: afterOne?.failure_count }));
    await bA.record(fail5xx("t1", HOST, CONF_LONG));
    const opened = await rowOf(wsA.id, "t1", HOST);
    check("1b. reaching the threshold opens the breaker with a bounded open window", opened?.state === "OPEN" && opened.failure_count === 2 && !!opened.open_until && opened.trips === 1, JSON.stringify({ state: opened?.state, count: opened?.failure_count }));

    // ---- 2. OPEN blocks upstream ----
    const gate = await bA.check({ integration: "t1", host: HOST, config: CONF_LONG });
    check("2a. an OPEN breaker refuses before the call", !gate.allow && gate.breaker_state?.reason === "circuit_open", JSON.stringify({ allow: gate.allow, reason: gate.breaker_state?.reason }));
    // The refusals increment is a fire-and-forget write; let it land before re-reading.
    await sleep(200);
    const refusedRow = await rowOf(wsA.id, "t1", HOST);
    check("2b. the refusal is counted and does not inflate the failure window", refusedRow.refusals >= 1 && refusedRow.failure_count === 2, JSON.stringify({ refusals: refusedRow.refusals, count: refusedRow.failure_count }));

    // ---- 3. HALF_OPEN recovery → successful probe closes ----
    await bA.record(fail5xx("t3", HOST, CONF_FAST));
    await bA.record(fail5xx("t3", HOST, CONF_FAST));
    const t3Open = await rowOf(wsA.id, "t3", HOST);
    check("3a. the fast breaker opens at the threshold", t3Open?.state === "OPEN" && t3Open.trips === 1, JSON.stringify({ state: t3Open?.state, trips: t3Open?.trips }));
    await sleep(1000);
    const probe = await bA.check({ integration: "t3", host: HOST, config: CONF_FAST });
    check("3b. after the open duration a bounded probe is admitted", probe.allow && !!probe.probe_token, JSON.stringify({ allow: probe.allow, probe: !!probe.probe_token }));
    await bA.record({ integration: "t3", host: HOST, config: CONF_FAST, ok: true, probe_token: probe.probe_token });
    const closedRow = await rowOf(wsA.id, "t3", HOST);
    check("3c. a successful probe closes the breaker and clears the window", closedRow.state === "CLOSED" && closedRow.failure_count === 0 && !closedRow.probe_token, JSON.stringify({ state: closedRow.state, count: closedRow.failure_count }));

    // ---- 4. failed probe reopens ----
    await bA.record(fail5xx("t4", HOST, CONF_FAST));
    await bA.record(fail5xx("t4", HOST, CONF_FAST));
    const t4Open = await rowOf(wsA.id, "t4", HOST);
    check("4a. the fast breaker opens at the threshold", t4Open?.state === "OPEN" && t4Open.trips === 1, JSON.stringify({ state: t4Open?.state, trips: t4Open?.trips }));
    await sleep(1000);
    const probe2 = await bA.check({ integration: "t4", host: HOST, config: CONF_FAST });
    await bA.record({ integration: "t4", host: HOST, config: CONF_FAST, ok: false, code: "UPSTREAM_FAILURE", status: 503, failure_kind: null, probe_token: probe2.probe_token });
    const backOpen = await rowOf(wsA.id, "t4", HOST);
    check("4b. a FAILED probe returns to OPEN immediately, not on a second threshold", probe2.allow && backOpen.state === "OPEN" && !backOpen.probe_token, JSON.stringify({ allow: probe2.allow, state: backOpen.state }));

    // ---- 5. 4xx / 429 do not trip ----
    for (let i = 0; i < 3; i++) await bA.record({ integration: "t5", host: HOST, config: CONF_LONG, ok: false, code: "UPSTREAM_FAILURE", status: 422, failure_kind: "client_error" });
    for (let i = 0; i < 3; i++) await bA.record({ integration: "t5", host: HOST, config: CONF_LONG, ok: false, code: "UPSTREAM_FAILURE", status: 429, failure_kind: "rate_limited" });
    const t5Row = await rowOf(wsA.id, "t5", HOST);
    check("5a. repeated 4xx business errors never open the breaker", t5Row === null || t5Row.state === "CLOSED", JSON.stringify({ state: t5Row?.state, count: t5Row?.failure_count }));
    check("5b. repeated 429s never open the breaker", t5Row === null || t5Row.state === "CLOSED", JSON.stringify({ state: t5Row?.state }));

    // ---- 6. isolation: workspace, connection, host ----
    const wsB = await svc.entities.Workspace.create({ name: `MCP Brk B ${Date.now()}`, owner_id: "test-user", status: "active", credits_balance: 0 });
    workspaces.push(wsB);
    const bB = createMcpBreaker(svc, { workspace_id: wsB.id, trace_id: TRACE });
    await bB.record(fail5xx("iso", HOST, CONF_LONG));
    await bB.record(fail5xx("iso", HOST, CONF_LONG));
    const bRow = await rowOf(wsB.id, "iso", HOST);
    check("6a. a different workspace with the same connection+host has its own OPEN breaker", bRow?.state === "OPEN" && bRow.breaker_key === mcpBreakerKeyOf(wsB.id, "iso", HOST), JSON.stringify({ state: bRow?.state, key: bRow?.breaker_key }));
    const aIso = await rowOf(wsA.id, "iso", HOST);
    check("6b. workspace B being OPEN never opened workspace A (no row for A)", aIso === null, JSON.stringify({ state: aIso?.state }));
    const gateConnB = await bA.check({ integration: "otherconn", host: HOST, config: CONF_LONG });
    check("6c. a different connection on the same host is NOT blocked by another connection's breaker", gateConnB.allow, JSON.stringify({ allow: gateConnB.allow }));
    const gateHostB = await bA.check({ integration: "iso", host: "other.example.com", config: CONF_LONG });
    check("6d. a different host is NOT blocked by host A's breaker", gateHostB.allow, JSON.stringify({ allow: gateHostB.allow }));

    // ---- 7. wiring: invokeMcpTool refuses with MCP_CIRCUIT_OPEN, no upstream contact ----
    await bA.record(fail5xx("wired", HOST, CONF_LONG));
    await bA.record(fail5xx("wired", HOST, CONF_LONG));
    const wiredRow = await rowOf(wsA.id, "wired", HOST);
    check("7a. the wired connection's breaker is OPEN before the call", wiredRow.state === "OPEN", JSON.stringify({ state: wiredRow.state }));
    const conn2 = await svc.entities.MCPConnection.create({
      workspace_id: wsA.id, name: "wired", server_url: `https://${HOST}/mcp`, transport: "http", auth_type: "none",
      enabled: true, status: "connected", last_connected_at: new Date().toISOString(),
      tools: [{ name: "ping", description: "ping", input_schema: "{}", read_only: true }], tool_count: 1,
    });
    connections.push(conn2);
    upstreamHit = 0;
    let thrown = null;
    try {
      await invokeMcpTool(client, { workspace_id: wsA.id, project_id: null, trigger: "cert", trace_id: TRACE }, { connection_name: "wired", tool_name: "ping", args: {} });
    } catch (e) { thrown = e; }
    check("7b. invokeMcpTool refuses with MCP_CIRCUIT_OPEN when the breaker is OPEN", thrown?.code === "MCP_CIRCUIT_OPEN" && thrown?.details?.kind === "circuit_open", JSON.stringify({ code: thrown?.code, kind: thrown?.details?.kind }));
    check("7c. the upstream was NOT contacted while OPEN", upstreamHit === 0, `upstreamHit=${upstreamHit}`);
    const inv = (await svc.entities.MCPInvocation.filter({ workspace_id: wsA.id, connection_name: "wired" }, "-created_date", 5))[0];
    check("7d. the refusal still writes an MCPInvocation audit row with the circuit-open code", inv?.ok === false && inv?.error_code === "MCP_CIRCUIT_OPEN", JSON.stringify({ ok: inv?.ok, code: inv?.error_code }));
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    globalThis.fetch = realFetch;
    for (const c of connections) await svc.entities.MCPConnection.delete(c.id).catch(() => {});
    for (const ws of workspaces) {
      const brks = await svc.entities.IntegrationBreaker.filter({ workspace_id: ws.id, project_id: MCP_BREAKER_NAMESPACE }, "-created_date", 200).catch(() => []);
      for (const r of brks) await svc.entities.IntegrationBreaker.delete(r.id).catch(() => {});
      const invs = await svc.entities.MCPInvocation.filter({ workspace_id: ws.id }, "-created_date", 200).catch(() => []);
      for (const r of invs) await svc.entities.MCPInvocation.delete(r.id).catch(() => {});
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}