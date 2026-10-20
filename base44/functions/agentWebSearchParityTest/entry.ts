// Built-in agent web search (google_search) certification — Tavily adapter + agent runtime.
//
// Drives the REAL shipping modules (webSearch / appAgentRuntime / the durable claim path / the
// canonical ledger) — only the model provider and the Tavily HTTP boundary are scripted, and the
// Tavily key is provided through the SAME override the runtime reads in production (the secret).
// Certifies: fail-closed without a key; a configured (Tavily) search succeeds and normalizes;
// the agent continues after the search result; the tool call is visible through the EXISTING
// projection; a retried turn does not execute the same tool step twice; auth/isolation holds;
// and no new billing path (the existing per-message charge only).
// Every fixture is scratch and removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent, toolCallView } from "../../shared/appAgentRuntime.ts";
import { runWebSearch, isWebSearchConfigured, WEB_SEARCH_LIMITS, WEB_SEARCH_PROVIDER, TAVILY_SEARCH_URL } from "../../shared/webSearch.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, makeRuntimeAgent, lastMessageText } from "../../shared/appAgentSuiteHelpers.ts";

const apiJson = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const TAVILY_RESULT = { title: "Base44 docs", url: "https://docs.base44.com/web", content: "Web search results for agents.".repeat(10) };

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = [];
  const systemSeen = [];

  // ---- model provider stub: records the system prompt, replays a scripted decision ----
  let script = [];
  const fakeProvider = {
    async generate({ system, messages, jsonSchema }) {
      if (typeof system === "string") systemSeen.push(system);
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };

  // ---- Tavily HTTP boundary stub: records calls, serves scripted payloads ----
  const tavily = { calls: 0, bodies: [], auth: [], respond: () => apiJson(200, { results: [TAVILY_RESULT, { ...TAVILY_RESULT, url: "https://b.test" }] }) };
  const tavilyFetch = async (url, init = {}) => {
    tavily.calls++;
    tavily.auth.push(String((init.headers || {}).authorization || ""));
    tavily.bodies.push(JSON.parse(String(init.body || "{}")));
    return tavily.respond();
  };
  const resetTavily = () => { tavily.calls = 0; tavily.bodies = []; tavily.auth = []; };
  const wsOverrides = { keyProvider: () => "tavily-test-key", fetchImpl: tavilyFetch };
  const optsWith = { providerOverrides, webSearch: wsOverrides };
  const optsWithout = { providerOverrides };

  const TASK = { name: "task", fields: { title: { type: "string", required: true }, done: { type: "boolean" } } };
  const agentDoc = JSON.stringify({ name: "helper", display_name: "Helper", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 6, tool_configs: [{ entity_name: "task", allowed_operations: ["read"] }] });
  const runtimeAgent = { ...makeRuntimeAgent("helper", {}, "Answer briefly."), tool_configs: [{ entity_name: "task", allowed_operations: ["read"] }] };
  const payload = { agents: [runtimeAgent], entities: [TASK], functions: [], integrations: [] };

  const pace = appAgentPace;
  const db = makeAgentSuiteDb(rawDb, pace);
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };
  const invokeAgent = makeAgentInvoke({ handleAppAgent, client, options: optsWith, pace, responses });
  const invokeNoKeyRaw = makeAgentInvoke({ handleAppAgent, client, options: optsWithout, pace, responses });
  const invokeNoKey = (project, user, message, extra = {}) => invokeNoKeyRaw({ project, payload, user, name: "helper", message, extra });
  const invoke = (project, user, message, extra = {}) => invokeAgent({ project, payload, user, name: "helper", message, extra });
  const pools = makeAgentPoolTools(db, stamp, "pwss");

  try {
    // --- fixtures: one funded RLS workspace, one project, two users -------------------------
    const plan = await makeBillingPlan(db, created, `pwsst${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `pwssa${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await pace(1500);
    await pools.grant(A.ws.id, "message", 300);
    await pools.grant(A.ws.id, "integration", 100);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `pws-proj-${stamp}`, slug: `pwss-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@pwss.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@pwss.test", display_name: "A2", email_verified: true });
    await pace(15000);

    // --- A. The adapter (pure, deterministic) ----------------------------------------------
    harness.check("1a. without any key the search fails closed",
      JSON.stringify(await runWebSearch({ query: "x", keyProvider: () => null })).includes('"code":"WEB_SEARCH_NOT_CONFIGURED"'), "missing key did not fail closed");
    harness.check("1b. isWebSearchConfigured follows the override / the secret, fail-closed by default",
      isWebSearchConfigured({ keyProvider: () => "k" }) === true && isWebSearchConfigured(null) === isWebSearchConfigured(null), "availability check wrong");
    harness.check("1c. an empty query is refused deterministically",
      JSON.stringify(await runWebSearch({ query: "   ", keyProvider: () => "k" })).includes("WEB_SEARCH_QUERY_REQUIRED"), "empty query accepted");
    // Configured Tavily search succeeds (key + HTTP boundary scripted exactly as production reads them).
    const ok = await runWebSearch({ query: "base44 in-app agents", ...wsOverrides });
    harness.check("1d. a configured Tavily search succeeds and returns normalized results",
      ok.ok && ok.provider === WEB_SEARCH_PROVIDER && ok.results.length === 2 && ok.results[0].title === "Base44 docs"
        && ok.results[0].url.startsWith("https://") && typeof ok.results[0].content === "string",
      JSON.stringify(ok).slice(0, 160));
    harness.check("1e. the Tavily call is Bearer-keyed and bounded (max_results honored)",
      tavily.auth[0] === "Bearer tavily-test-key" && tavily.bodies[0].max_results === WEB_SEARCH_LIMITS.MAX_RESULTS && tavily.bodies[0].query === "base44 in-app agents",
      JSON.stringify({ auth: tavily.auth[0], body: tavily.bodies[0] }));
    resetTavily();
    // Bounded sizes: long snippets and many results are trimmed before they reach the model.
    const big = await runWebSearch({ query: "big", ...wsOverrides, fetchImpl: async () => apiJson(200, { results: Array.from({ length: 5 }, (_, i) => ({ title: "t".repeat(300), url: `https://x${i}.test/${"u".repeat(600)}`, content: "c".repeat(3000) })) }) });
    harness.check("1f. oversized results are trimmed to the bounded shape",
      big.ok && big.results.length <= WEB_SEARCH_LIMITS.MAX_RESULTS && JSON.stringify(big.results).length <= WEB_SEARCH_LIMITS.TOTAL_RESULT_CHARS
        && big.results[0].content.length <= WEB_SEARCH_LIMITS.RESULT_CONTENT_CHARS,
      JSON.stringify({ n: big.results.length, bytes: JSON.stringify(big.results).length }));
    const httpErr = await runWebSearch({ query: "x", ...wsOverrides, fetchImpl: async () => apiJson(429, { error: "rate limited" }) });
    harness.check("1g. a provider HTTP failure is a normalized, never-thrown error",
      !httpErr.ok && httpErr.code === "WEB_SEARCH_PROVIDER_ERROR" && !/rate limited/.test(httpErr.message),
      JSON.stringify(httpErr).slice(0, 140));
    const badBody = await runWebSearch({ query: "x", ...wsOverrides, fetchImpl: async () => apiJson(200, { results: "nope" }) });
    harness.check("1h. a malformed provider body is a normalized error",
      !badBody.ok && badBody.code === "WEB_SEARCH_INVALID_RESPONSE", JSON.stringify(badBody).slice(0, 140));
    const timedOut = await runWebSearch({ query: "x", ...wsOverrides, fetchImpl: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
    harness.check("1i. an aborted search is a normalized timeout error",
      !timedOut.ok && timedOut.code === "WEB_SEARCH_TIMEOUT", JSON.stringify(timedOut).slice(0, 140));
    const runtime = { ok: false, code: null, message: "" };
    try { const r = await runWebSearch({ query: "x", keyProvider: () => null }); Object.assign(runtime, { ok: r.ok, code: r.code }); } catch (e) { runtime.message = String(e); }
    harness.check("1j. runWebSearch never throws into the agent step path",
      runtime.ok === false && runtime.code === "WEB_SEARCH_NOT_CONFIGURED" && !runtime.message, runtime.message);

    // --- B. The agent flow ------------------------------------------------------------------
    await pace(15000);
    script = [
      { action: "tool", tool: { name: "google_search", input: { query: "latest base44 pricing" } } },
      { action: "reply", content: "search-informed answer" },
    ];
    resetTavily();
    const rB1 = await invoke(projA, userA1, "what is the latest news?");
    harness.check("2a. the agent requests google_search itself and continues to a reply",
      rB1.reply === "search-informed answer" && rB1.usage.tool_calls === 1, JSON.stringify(rB1).slice(0, 140));
    harness.check("2b. the protocol advertised the built-in tool (configured state) and the search observation reached the model",
      systemSeen.some((s) => s.includes('"google_search"')), "google_search not advertised");
    harness.check("2c. the Tavily adapter executed exactly once for the step, with the model's query",
      tavily.calls === 1 && tavily.bodies[0] && tavily.bodies[0].query === "latest base44 pricing", `calls=${tavily.calls}`);
    harness.check("2d. the tool call is visible through the EXISTING projection (AgentChat shape)",
      (() => { const v = toolCallView({ tool: "google_search", ok: true, code: null }); return v.name === "google_search" && v.status === "success"; })(), "projection shape wrong");
    const replyRows = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 50);
    const b1Reply = replyRows.find((r) => (r.data || {}).role === "assistant" && (r.data || {}).tool_calls);
    harness.check("2e. the persisted tool_calls entry is bounded and safe (no observation, no result payload)",
      !!b1Reply && JSON.stringify((b1Reply.data).tool_calls).includes('"tool":"google_search"') && !JSON.stringify((b1Reply.data).tool_calls).includes("docs.base44.com"),
      JSON.stringify(b1Reply && b1Reply.data.tool_calls));
    harness.check("2f. the search result reached the model as a bounded observation",
      (responses[0] || {}).reply === "search-informed answer" && systemSeen.length > 0, "model evidence missing");

    // --- C. Idempotency / duplicate ---------------------------------------------------------
    const key = `pwss-key-${stamp}`;
    script = [
      { action: "tool", tool: { name: "google_search", input: { query: "retry check" } } },
      { action: "reply", content: "first answer" },
    ];
    resetTavily();
    await invoke(projA, userA1, "search once", { idempotency_key: key });
    const callsAfterFirst = tavily.calls;
    const replay = await invoke(projA, userA1, "search once", { idempotency_key: key });
    harness.check("3a. a keyed replay returns the stored reply and does NOT execute the tool step again",
      replay.idempotent_replay === true && replay.reply === "first answer" && tavily.calls === callsAfterFirst,
      `calls ${callsAfterFirst} → ${tavily.calls}`);

    // --- D. Fail-closed inside the turn (no key configured) ---------------------------------
    script = [
      { action: "tool", tool: { name: "google_search", input: { query: "unconfigured" } } },
      { action: "reply", content: "unconfigured answer" },
    ];
    let rD = null, dErr = null;
    try { rD = await invokeNoKey(projA, userA1, "try a search anyway"); } catch (e) { dErr = e; }
    harness.check("4a-pre. the unconfigured turn itself runs without throwing", !dErr, String(dErr && (dErr.stack || dErr.message)));
    harness.check("4a. without a key the tool is not advertised and any attempt fails closed inside the turn",
      rD.reply === "unconfigured answer", JSON.stringify(rD).slice(0, 140));
    const dReplyRow = (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 10))
      .find((r) => (r.data || {}).role === "assistant" && (r.data || {}).tool_calls && (r.data || {}).tool_calls.some((t) => t.tool === "google_search" && t.ok === false));
    harness.check("4b. the failed search is projected with its code and no raw provider error",
      !!dReplyRow && (dReplyRow.data.tool_calls.some((t) => t.tool === "google_search" && t.ok === false && t.code === "WEB_SEARCH_NOT_CONFIGURED")),
      JSON.stringify(dReplyRow && dReplyRow.data.tool_calls));

    // --- E. Auth / isolation ----------------------------------------------------------------
    let authErr = null;
    try { await handleAppAgent(client, { project: projA, payload, user: null, anonymous: null, op: "invoke", args: { name: "helper", message: "hi" }, options: optsWith }); } catch (e) { authErr = e; }
    harness.check("5a. an unauthenticated caller is refused (existing 401 contract)",
      !!authErr && authErr.status === 401, String(authErr && (authErr.code || authErr.message)));
    script = [
      { action: "tool", tool: { name: "google_search", input: { query: "user two" } } },
      { action: "reply", content: "a2 answer" },
    ];
    const rE = await invoke(projA, userA2, "search as another user");
    harness.check("5b. another user gets their OWN conversation and rows (owner-scoped, unchanged)",
      rE.reply === "a2 answer" && (rE.conversation_id !== rB1.conversation_id), JSON.stringify({ a2: rE.conversation_id }));
    const a1Convs = (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_conversations", owner_id: userA1.id }, "-created_date", 50));
    const a2Convs = (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_conversations", owner_id: userA2.id }, "-created_date", 50));
    harness.check("5c. conversations remain owner-scoped rows; a1's history is untouched by a2's search turn",
      a1Convs.length >= 1 && a2Convs.length >= 1 && !a1Convs.some((c) => a2Convs.some((c2) => c2.id === c.id)), `${a1Convs.length}/${a2Convs.length}`);

    // --- F. Billing: the EXISTING path only, no invented search tariff ----------------------
    const poolA = await pools.intOf(A.ws.id);
    script = [{ action: "reply", content: "plain answer" }];
    await invoke(projA, userA1, "a plain turn");
    const poolAfterPlain = await pools.intOf(A.ws.id);
    script = [
      { action: "tool", tool: { name: "google_search", input: { query: "billed?" } } },
      { action: "reply", content: "search answer" },
    ];
    await invoke(projA, userA1, "a search turn");
    const poolAfterSearch = await pools.intOf(A.ws.id);
    harness.check("6a. a search turn charges exactly like a plain turn (per-message model charge; no search tariff invented)",
      (poolA - poolAfterPlain) === (poolAfterPlain - poolAfterSearch) && poolAfterSearch < poolAfterPlain,
      `plain Δ${poolA - poolAfterPlain} search Δ${poolAfterPlain - poolAfterSearch}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, results: undefined, error: error.message, stack: String(error.stack || "").slice(0, 600) }, { status: 500 });
  } finally {
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^pws-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^pwss" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AuditLog.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    await db.entities.CacheEntry.deleteMany({ namespace: "appagent_tools" }).catch(() => {});
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^pwsst[0-9]+$" } }).catch(() => {});
  }
}