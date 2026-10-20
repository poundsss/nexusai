// P-9.11B certification — deployed in-app agents' memory_config (Base44 parity).
//
// Drives the REAL shipping modules (agentResource / appAgentRuntime / appAuth / the canonical
// ledger paths) — only the model provider is scripted. Certifies the Base44-documented contract:
//   memory_config: { enabled (default true), scope: "global" | "user" | "both" (default "both"),
//                    include_other_conversation_context (default false), instructions (string|null) }
// across: contract validation + normalized defaults + round-trip, read injection (scope
// isolation user/global/both, cross-user and cross-project and cross-agent isolation, bounded
// and scrubbed blocks, include_other_conversation_context), the write path (server-side owner
// stamping, dedupe, oversized/scrubbed statements), durable idempotency (no duplicate rows on a
// retried turn), and billing (existing message-credit path only — no invented memory tariff).
// Every fixture is scratch and removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import {
  parseAgentDocument, agentDocumentContent, DEFAULT_MEMORY_CONFIG, MEMORY_CONFIG_INSTRUCTIONS_MAX_CHARS,
} from "../../shared/agentResource.ts";
import {
  handleAppAgent, APP_AGENT_LIMITS, MEMORIES_ENTITY, MEMORY_GLOBAL_OWNER, renderAgentMemoryBlock,
} from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, findKeyedReplyRow, makePayloadInvoke } from "../../shared/appAgentSuiteHelpers.ts";
import { makeMemoryAgent, makeMemoryEvidence, makeMemoryLookups } from "../../shared/appAgentMemoryCertHelpers.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";

const INSTRUCTIONS = "Instructions-marker-911b: help users of this application.";
const MEM_INSTR = "Remember-marker-911b the user's preferred name and timezone.";
const DEPLOY_TOKEN = "ghp_911b_never_store_this_token_000000";
const STMT_A1 = "User prefers dark mode and UTC times.";
const STMT_FU = "The user's preferred name is Alice.";
const STMT_FG = "The team's office hours are 9 to 5 UTC.";
const STMT_KEYED = "Keyed fact about the relay.";

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = []; // every JSON handed to the caller — leakage is asserted over all of it

  // ---- model provider stub: records every system + message batch, replays a scripted decision ----
  const calls = { llm: 0 };
  const systemSeen = [];   // per-generate system prompts (injection evidence)
  const seen = [];         // per-generate message arrays (observation evidence)
  let script = [];
  const fakeProvider = {
    async generate({ messages, jsonSchema, system }) {
      calls.llm++;
      if (typeof system === "string") systemSeen.push(system);
      if (Array.isArray(messages)) seen.push(messages);
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const opts = { providerOverrides };

  // The deployed agents this suite drives. "helper" carries NO memory_config at all — the
  // parity default (enabled / both) must apply purely through read/normalize behavior.
  const mkAgent = makeMemoryAgent(INSTRUCTIONS);
  const AGENTS = [
    mkAgent("helper", undefined),
    mkAgent("mem_user", { enabled: true, scope: "user", include_other_conversation_context: false, instructions: null }),
    mkAgent("mem_global", { enabled: true, scope: "global", include_other_conversation_context: false, instructions: null }),
    // mem_off keeps one app tool so the structured step protocol stays live — the memory
    // action must be REFUSED for it, proving the disabled config is enforced, not skipped.
    mkAgent("mem_off", { enabled: false, scope: "both", include_other_conversation_context: false, instructions: null }, { metadata: { app_tools: ["SendEmail"] } }),
    mkAgent("mem_ctx", { enabled: true, scope: "user", include_other_conversation_context: true, instructions: MEM_INSTR }),
  ];
  const payload = { agents: AGENTS, entities: [], functions: [], integrations: [] };

  const pace = appAgentPace;
  // Retry-wrapped service-role db (test-only): every SDK call is a read, an idempotent
  // ledger/claim write or a scratch fixture, so waiting out the per-window request limit is safe.
  const db = makeAgentSuiteDb(rawDb, pace);
  const pools = makeAgentPoolTools(db, stamp, "p911m");
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };

  const { lastSystem, lastMsg } = makeMemoryEvidence(systemSeen, seen);
  const { memRows, rowsOf } = makeMemoryLookups(db);
  const invokeAgent = makeAgentInvoke({ handleAppAgent, client, options: opts, pace, responses });
  const invoke = makePayloadInvoke(invokeAgent, payload);

  try {
    // --- fixtures: two funded RLS workspaces, one project each ------------------------------
    const plan = await makeBillingPlan(db, created, `p911mt${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911ma${stamp}`, { plan });
    const B = await makeBillingWorkspace(db, created, `p911mb${stamp}`, { plan });
    for (const f of [A, B]) wsIds.push(f.ws.id);
    await pace(1500);
    await pools.grant(A.ws.id, "message", 300);
    await pools.grant(A.ws.id, "integration", 60);
    await pools.grant(B.ws.id, "message", 300);
    await pools.grant(B.ws.id, "integration", 60);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911m-proj-${A.user.id}-${stamp}`, slug: `p911ma-${stamp}`, rls_enabled: true });
    const projB = await db.entities.Project.create({ workspace_id: B.ws.id, name: `p911m-proj-${B.user.id}-${stamp}`, slug: `p911mb-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id, projB.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p911m.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p911m.test", display_name: "A2", email_verified: true });
    const userB1 = await createPasswordlessUser(db, projB, { email: "b1@p911m.test", display_name: "B1", email_verified: true });
    const int0 = await pools.intOf(A.ws.id);
    const msg0 = await pools.msgOf(A.ws.id);
    // The runtime paths below consume the platform's per-window request budget: pause so the
    // fixtures' calls roll out of the window before the turn sequence starts.
    await pace(15000);

    // --- A. Contract (pure parsing — no platform requests) -----------------------------------
    const ap = (over) => parseAgentDocument(agentFilePath("helper"), JSON.stringify({ instructions: INSTRUCTIONS, ...over }, null, 2));
    const d0 = ap({});
    harness.check("1a. an agent with NO memory_config normalizes to the documented default (enabled, both)",
      d0.ok && JSON.stringify(d0.agent.memory_config) === JSON.stringify(DEFAULT_MEMORY_CONFIG)
        && DEFAULT_MEMORY_CONFIG.enabled === true && DEFAULT_MEMORY_CONFIG.scope === "both",
      d0.error || JSON.stringify(d0.agent.memory_config));
    const d1 = ap({ memory_config: { enabled: false, scope: "user", include_other_conversation_context: true, instructions: "  Save the preferred name.  " } });
    harness.check("1b. an explicit memory_config parses with exact values (instructions trimmed)",
      d1.ok && d1.agent.memory_config.enabled === false && d1.agent.memory_config.scope === "user"
        && d1.agent.memory_config.include_other_conversation_context === true && d1.agent.memory_config.instructions === "Save the preferred name.",
      d1.error || JSON.stringify(d1.agent.memory_config));
    const d2 = ap({ memory_config: { enabled: true, scope: "everyone" } });
    harness.check("1c. an unknown scope is refused", !d2.ok && /memory_config\.scope/.test(d2.error || ""), d2.error || "");
    const d3 = ap({ memory_config: { enabled: "yes" } });
    harness.check("1d. a non-boolean enabled is refused", !d3.ok && /memory_config\.enabled/.test(d3.error || ""), d3.error || "");
    const d4 = ap({ memory_config: { include_other_conversation_context: 1 } });
    harness.check("1e. a non-boolean include_other_conversation_context is refused", !d4.ok && /include_other_conversation_context/.test(d4.error || ""), d4.error || "");
    const d5 = ap({ memory_config: { instructions: 42 } });
    harness.check("1f. a non-string instructions value is refused", !d5.ok && /memory_config\.instructions/.test(d5.error || ""), d5.error || "");
    const d6 = ap({ memory_config: { instructions: "x".repeat(MEMORY_CONFIG_INSTRUCTIONS_MAX_CHARS + 1) } });
    harness.check("1g. an oversized instructions string is refused",
      !d6.ok && new RegExp(`at most ${MEMORY_CONFIG_INSTRUCTIONS_MAX_CHARS}`).test(d6.error || ""), d6.error || "");
    const d7 = ap({ memory_config: { instructions: "   " } });
    harness.check("1h. a blank instructions string normalizes to null", d7.ok && d7.agent.memory_config.instructions === null, d7.error || JSON.stringify(d7.agent.memory_config));
    const rt = parseAgentDocument(agentFilePath("helper"), agentDocumentContent(d1.agent));
    harness.check("1i. the canonical document round-trips the normalized memory_config",
      rt.ok && JSON.stringify(rt.agent.memory_config) === JSON.stringify(d1.agent.memory_config),
      rt.error || JSON.stringify(rt.agent && rt.agent.memory_config));
    const d8 = ap({ memory_config: { scope: "user" }, mystery: 1 });
    harness.check("1j. memory_config is an owned key and never leaks into loose metadata",
      d8.ok && d8.agent.metadata?.memory_config === undefined && d8.agent.metadata?.mystery === 1,
      d8.error || JSON.stringify(d8.agent && d8.agent.metadata));
    const d9 = ap({ memory_config: "yes" });
    harness.check("1k. a malformed memory_config value is refused", !d9.ok && /must be an object/.test(d9.error || ""), d9.error || "");
    const block = renderAgentMemoryBlock(Array.from({ length: 30 }, (_, i) => ({ scope: "user", statement: `Fact number ${i} about the workspace conventions and settings that repeat here.` })));
    harness.check("1l. the rendered memory block is bounded by rows AND payload chars",
      block.length > 0 && block.length <= APP_AGENT_LIMITS.MEMORY_CONTEXT_CHARS + 300
        && (block.match(/^- \[/gm) || []).length <= APP_AGENT_LIMITS.MEMORY_MAX_ROWS,
      `block ${block.length} chars, ${(block.match(/^- \[/gm) || []).length} lines, cap ${APP_AGENT_LIMITS.MEMORY_CONTEXT_CHARS}`);
    harness.check("1m. an empty memory set renders no block", renderAgentMemoryBlock([]) === "", "empty → empty");

    // --- B. Write path (default parity, owner stamping, dedupe) -----------------------------
    const poolBefore = await pools.intOf(A.ws.id);
    script = [
      { action: "memory", memory: { statement: STMT_A1 } },
      { action: "reply", content: "noted" },
    ];
    const rB1 = await invoke(projA, userA1, "helper", "remember my preference");
    harness.check("2a. the default-parity agent (NO memory_config) saves memory through the step action",
      rB1.reply === "noted", JSON.stringify(rB1).slice(0, 120));
    const helperRows = await rowsOf(projA, userA1.id, "helper");
    harness.check("2b. the row is stored under the reserved entity with server-stamped identity",
      helperRows.length === 1 && helperRows[0].owner_id === userA1.id && helperRows[0].project_id === projA.id
        && (helperRows[0].data || {}).agent_name === "helper" && (helperRows[0].data || {}).statement === STMT_A1,
      JSON.stringify(helperRows.map((r) => ({ owner: r.owner_id, agent: (r.data || {}).agent_name, scope: (r.data || {}).scope }))));
    harness.check("2c. scope \"both\" writes user-scoped memory (a shared write is never implied)",
      helperRows.length === 1 && (helperRows[0].data || {}).scope === "user" && (await memRows(projA, MEMORY_GLOBAL_OWNER)).length === 0,
      JSON.stringify((helperRows[0] || {}).data || {}));
    harness.check("2d. the per-message INTEGRATION charge is applied through the EXISTING path (no memory tariff)",
      (await pools.intOf(A.ws.id)) < poolBefore, `${poolBefore} → ${await pools.intOf(A.ws.id)}`);
    const replyRow1 = (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 5))
      .find((r) => (r.data || {}).role === "assistant");
    const memEntry = ((replyRow1 || {}).data || {}).tool_calls?.find((c) => c && c.tool === "memory") || null;
    harness.check("2e. the persisted tool_calls entry for memory carries only bounded safe fields",
      !!memEntry && Object.keys(memEntry).sort().join(",") === "code,ok,tool" && memEntry.ok === true && memEntry.code === null,
      JSON.stringify(memEntry));

    // --- C. Read path: default "both" injection + isolation ------------------------------------
    script = [{ action: "reply", content: "ok" }];
    await invoke(projA, userA2, "helper", "what do you know about me?");
    harness.check("3a. the memory protocol is present for a default-parity agent (memory ON by default)",
      lastSystem().includes("MEMORY: you may save"), "protocol marker in system");
    harness.check("3b. user isolation: another user's turn sees none of A1's memory",
      !lastSystem().includes("dark mode"), "A2's system lacks A1's statement");
    // Seed one helper GLOBAL row (service-side fixture — a shared fact for the helper agent).
    await db.entities.AppRecord.create({
      project_id: projA.id, entity_name: MEMORIES_ENTITY, owner_id: MEMORY_GLOBAL_OWNER,
      data: { agent_name: "helper", scope: "global", statement: "The workspace FAQ link is /help.", created_at: new Date().toISOString() },
    });

    script = [
      { action: "memory", memory: { statement: STMT_FU } },
      { action: "memory", memory: { statement: STMT_FU } },   // duplicate within the same turn
      { action: "reply", content: "dedup" },
    ];
    await invoke(projA, userA1, "mem_user", "remember my name");
    const fuRows = await rowsOf(projA, userA1.id, "mem_user");
    harness.check("3c. a duplicate statement within one turn dedupes to a single row",
      fuRows.length === 1 && (fuRows[0].data || {}).statement === STMT_FU && lastMsg("already remember").length > 0,
      `${fuRows.length} row(s); observation: ${lastMsg("already remember").slice(0, 60)}`);
    script = [
      { action: "memory", memory: { statement: STMT_FG } },
      { action: "reply", content: "ok" },
    ];
    await invoke(projA, userA1, "mem_global", "remember the office hours");
    const fgRows = await rowsOf(projA, MEMORY_GLOBAL_OWNER, "mem_global");
    harness.check("3d. a scope-global agent writes to the shared global store",
      fgRows.length === 1 && fgRows[0].owner_id === MEMORY_GLOBAL_OWNER && (fgRows[0].data || {}).scope === "global",
      JSON.stringify(fgRows.map((r) => ({ owner: r.owner_id, scope: (r.data || {}).scope }))));
    script = [{ action: "reply", content: "ok" }];
    await invoke(projA, userA1, "mem_user", "what do you know?");
    harness.check("3e. scope \"user\" injects the user's facts and NOT the global ones",
      lastSystem().includes("Alice") && !lastSystem().includes("office hours"), "user scope strict");
    await invoke(projA, userA1, "mem_global", "what do you know?");
    harness.check("3f. scope \"global\" injects the global facts and NOT the user's own",
      lastSystem().includes("office hours") && !lastSystem().includes("Alice"), "global scope strict");
    await invoke(projA, userA2, "mem_global", "what is shared?");
    harness.check("3g. global memory is shared across all end users of the project",
      lastSystem().includes("office hours"), "A2 sees the global fact");
    await invoke(projB, userB1, "mem_global", "what is shared?");
    harness.check("3h. cross-project isolation: project B's user never sees project A's memory",
      !lastSystem().includes("office hours") && !lastSystem().includes("Alice") && !lastSystem().includes("dark mode"),
      "B1's system empty of A's facts");
    await invoke(projA, userA1, "helper", "fresh conversation");
    harness.check("3i. scope \"both\" injects BOTH the agent's global and the user's own facts",
      lastSystem().includes("dark mode") && lastSystem().includes("/help"), "both scopes rendered");
    harness.check("3j. memory is agent-scoped: another agent's global/user facts never leak",
      !lastSystem().includes("office hours") && !lastSystem().includes("Alice"), "helper's system lacks mem_global/mem_user facts");

    // --- D. Disabled memory ------------------------------------------------------------------------
    script = [
      { action: "memory", memory: { statement: "This fact must never be stored." } },
      { action: "reply", content: "done" },
    ];
    const rOff = await invoke(projA, userA1, "mem_off", "remember something anyway");
    const offRows = (await memRows(projA)).filter((r) => String((r.data || {}).statement || "").includes("never be stored"));
    harness.check("4a. a disabled agent stores nothing",
      rOff.reply === "done" && offRows.length === 0, `${offRows.length} forbidden row(s)`);
    harness.check("4b. a disabled agent gets no memory protocol and no injected block",
      !lastSystem().includes("MEMORY: you may save") && !lastSystem().includes("AGENT MEMORY"), "protocol and block absent");
    harness.check("4c. a hallucinated memory action on a disabled agent is refused before any write",
      lastMsg("[memory refused]").length > 0, lastMsg("[memory refused]").slice(0, 80));

    // --- E. include_other_conversation_context -------------------------------------------------------
    script = [{ action: "reply", content: "nice" }];
    await invoke(projA, userA1, "mem_ctx", "I like tea with oat milk.");
    script = [{ action: "reply", content: "hi" }];
    await invoke(projA, userA1, "mem_ctx", "hello again");
    // Snapshot BEFORE the next invoke replaces lastSystem with another agent's system.
    const ctxSystem = lastSystem();
    harness.check("5a. include_other_conversation_context=true injects the user's other conversation",
      ctxSystem.includes("OTHER CONVERSATIONS") && ctxSystem.includes("I like tea with oat milk"),
      "earlier conversation rendered");
    harness.check("5c. the builder's memory instructions steer the agent without leaking to responses",
      ctxSystem.includes(MEM_INSTR), "guidance present in system, server-side only");
    await invoke(projA, userA1, "helper", "a brand new conversation");
    harness.check("5b. include_other_conversation_context=false (default) injects nothing",
      !lastSystem().includes("OTHER CONVERSATIONS"), "no other-conversation block");

    // --- F. Scrubbing, bounds, durable idempotency ---------------------------------------------------
    script = [
      { action: "memory", memory: { statement: "z".repeat(500) } },
      { action: "memory", memory: { statement: `The deploy token to remember is ${DEPLOY_TOKEN}.` } },
      { action: "reply", content: "ok" },
    ];
    await invoke(projA, userA1, "helper", "save two tricky facts");
    const allRows = await memRows(projA);
    const bigRow = allRows.find((r) => /^z+$/.test(String((r.data || {}).statement || "")));
    const secretRow = allRows.find((r) => String((r.data || {}).statement || "").includes("deploy token"));
    harness.check("6a. an oversized statement is stored truncated to the statement cap",
      !!bigRow && String((bigRow.data || {}).statement).length <= APP_AGENT_LIMITS.MEMORY_STATEMENT_CHARS,
      `${(bigRow && String((bigRow.data || {}).statement).length) || 0} chars, cap ${APP_AGENT_LIMITS.MEMORY_STATEMENT_CHARS}`);
    harness.check("6b. a credential-shaped statement is scrubbed before storage",
      !!secretRow && !JSON.stringify(secretRow).includes(DEPLOY_TOKEN) && String((secretRow.data || {}).statement).includes("[REDACTED]"),
      secretRow ? String((secretRow.data || {}).statement).slice(0, 80) : "row missing");
    harness.check("6c. no credential value anywhere in stored memory rows",
      !JSON.stringify(allRows).includes(DEPLOY_TOKEN), `${allRows.length} row(s) scanned`);
    const k = `p911m-key-${stamp}`;
    script = [
      { action: "memory", memory: { statement: STMT_KEYED } },
      { action: "reply", content: "keyed done" },
    ];
    await invoke(projA, userA1, "helper", "keyed save", { idempotency_key: k });
    const keyedCount = () => rowsOf(projA, userA1.id, "helper").then((rows) => rows.filter((r) => (r.data || {}).statement === STMT_KEYED).length);
    harness.check("6d. a keyed turn saves the fact once", (await keyedCount()) === 1, `${await keyedCount()} row(s)`);
    const replyRow = await findKeyedReplyRow(db, projA.id, k);
    await db.entities.AppRecord.delete(replyRow.id);
    script = [
      { action: "memory", memory: { statement: STMT_KEYED } },
      { action: "reply", content: "replayed" },
    ];
    const retry = await invoke(projA, userA1, "helper", "keyed save", { idempotency_key: k });
    harness.check("6e. a crash-retried keyed turn does not duplicate the memory row (durable claim)",
      retry.reply === "replayed" && (await keyedCount()) === 1,
      JSON.stringify({ reply: retry.reply, rows: await keyedCount() }));

    // --- G. Security & billing -----------------------------------------------------------------------
    const allJson = JSON.stringify(responses);
    harness.check("7a. no agent instructions or memory instructions marker in any response",
      !allJson.includes(INSTRUCTIONS) && !allJson.includes(MEM_INSTR) && !allJson.includes(DEPLOY_TOKEN),
      `responses scanned: ${responses.length}`);
    const ledger = await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "-created_date", 500).catch(() => []);
    const keys = ledger.map((r) => r.idempotency_key).filter(Boolean);
    const dups = keys.filter((kx, i) => keys.indexOf(kx) !== i);
    harness.check("7b. no duplicate ledger idempotency keys (no double charge)", dups.length === 0, JSON.stringify(dups.slice(0, 3)));
    const offPath = ledger.filter((r) => r.idempotency_key
      && !String(r.idempotency_key).includes("appagent:")
      && !String(r.idempotency_key).startsWith("p911m:"));
    harness.check("7c. no second ledger path: every movement is a model-step charge or the test grant",
      offPath.length === 0, JSON.stringify(offPath.slice(0, 2).map((r) => r.idempotency_key)));
    harness.check("7d. memory saves carry no tariff of their own (message pool untouched, no memory-scoped ledger movement)",
      (await pools.msgOf(A.ws.id)) === msg0 && !ledger.some((r) => String(r.idempotency_key || "").includes("memory")),
      `${msg0} → ${await pools.msgOf(A.ws.id)}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by name pattern, including residue from earlier runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911m-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911m[a-b]" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppIdentity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppSession.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.ProjectSecret.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AuditLog.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.FunctionInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    await db.entities.CacheEntry.deleteMany({ namespace: "appagent_memory" }).catch(() => {});
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911mt[0-9]+$" } }).catch(() => {});
  }
}