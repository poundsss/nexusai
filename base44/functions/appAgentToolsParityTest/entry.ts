// P-9.11A certification — deployed in-app agents' tool_configs (Base44 parity).
//
// Drives the REAL shipping modules (agentResource / appAgentRuntime / appData / functionRuntime
// / appAuth / the canonical ledger paths) — only the model provider is scripted. Certifies the
// Base44-documented contract:
//   tool_configs: [ { entity_name, allowed_operations: ["create","read","update","delete"] },
//                    { function_name, description } ]
// across: contract validation, entity execution (grants, isolation, server-side identity),
// backend-function execution (declared-only, bounded, audited through the EXISTING path),
// security (no leakage, bounded observations), idempotency (no duplicate side effects or
// charges) and billing (existing paths only — no invented function-tool tariff).
// The runtime paths burn a dozen-plus platform requests per agent turn, so the suite paces
// between turns and exercises several tools per turn — one request budget, many assertions.
// Every fixture is scratch and removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import {
  parseAgentDocument, agentDocumentContent, validateAgentReferences, TOOL_CONFIG_OPERATIONS,
} from "../../shared/agentResource.ts";
import { handleAppAgent, APP_AGENT_LIMITS, TOOL_INPUT_MAX_CHARS } from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, lastMessageText, findKeyedReplyRow } from "../../shared/appAgentSuiteHelpers.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";

const INSTRUCTIONS = "Instructions-marker-911: manage tasks with the tools.";

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = []; // every JSON handed to the caller — leakage is asserted over all of it

  // ---- model provider stub: records every message batch, replays a scripted decision ----
  const calls = { llm: 0 };
  const seen = []; // per-generate message arrays (observation evidence)
  let script = [];
  const fakeProvider = {
    async generate({ messages, jsonSchema }) {
      calls.llm++;
      if (Array.isArray(messages)) seen.push(messages);
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const opts = { providerOverrides };

  const TASK = { name: "task", fields: { title: { type: "string", required: true }, done: { type: "boolean" } } };
  const NOTE = { name: "note", fields: { text: { type: "string", required: true } } };
  const FN_SOURCE = [
    "export const config = {};",
    "export default async function (ctx) {",
    "  const rows = await ctx.db.task.filter({}, \"-created_date\", 50);",
    "  return { status: 200, body: { ok: true, seen_tasks: rows.length, user_id: ctx.user ? ctx.user.id : null } };",
    "};",
  ].join("\n");
  const BIG_BLOB = "y".repeat(3000);
  const BIGFN_SOURCE = [
    "export const config = {};",
    "export default async function () {",
    `  return { status: 200, body: { ok: true, blob: ${JSON.stringify(BIG_BLOB)} } };`,
    "};",
  ].join("\n");
  const FUNCTIONS = [
    { name: "add_note", path: "functions/add_note.js", source: FN_SOURCE },
    { name: "big_reply", path: "functions/big_reply.js", source: BIGFN_SOURCE },
  ];

  // The canonical helper document exactly as the artifact carries it (parsed through the REAL
  // parser, so the runtime is exercised against the exact object a deployment ships).
  const docText = (overrides = {}) => JSON.stringify({
    name: "helper", display_name: "Helper", description: "test agent",
    instructions: INSTRUCTIONS, tools: [], skills: [], model_tier: "fast", max_steps: 6,
    tool_configs: [
      { entity_name: "task", allowed_operations: ["create", "read", "update"] },
      { function_name: "add_note", description: "Record a note" },
      { function_name: "big_reply", description: "Verbose reply" },
    ],
    ...overrides,
  }, null, 2);
  const parsedHelper = parseAgentDocument(agentFilePath("helper"), docText());
  const parsedHelperB = parseAgentDocument(agentFilePath("helper"), docText({
    tool_configs: [
      { entity_name: "task", allowed_operations: ["create", "read", "update", "delete"] },
      { function_name: "add_note", description: "Record a note" },
    ],
  }));

  const pace = appAgentPace;
  // Retry-wrapped service-role db (test-only): every SDK call is a read, an idempotent
  // ledger/claim write or a scratch fixture, so waiting out the per-window request limit is safe.
  const db = makeAgentSuiteDb(rawDb, pace);
  const pools = makeAgentPoolTools(db, stamp, "p911");
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };
  const lastMsg = (needle) => lastMessageText(seen, needle);
  const invokeAgent = makeAgentInvoke({ handleAppAgent, client, options: opts, pace, responses });
  const invoke = (project, payload, user, message, extra = {}) => invokeAgent({ project, payload, user, name: "helper", message, extra });

  try {
    // --- fixtures: two funded RLS workspaces, one project each ------------------------------
    const plan = await makeBillingPlan(db, created, `p911t${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911a${stamp}`, { plan });
    const B = await makeBillingWorkspace(db, created, `p911b${stamp}`, { plan });
    for (const f of [A, B]) wsIds.push(f.ws.id);
    await pace(1500);
    await pools.grant(A.ws.id, "message", 300);
    await pools.grant(A.ws.id, "integration", 60);
    await pools.grant(B.ws.id, "message", 300);
    await pools.grant(B.ws.id, "integration", 60);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911-proj-${A.user.id}-${stamp}`, slug: `p911a-${stamp}`, rls_enabled: true });
    const projB = await db.entities.Project.create({ workspace_id: B.ws.id, name: `p911-proj-${B.user.id}-${stamp}`, slug: `p911b-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id, projB.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p911.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p911.test", display_name: "A2", email_verified: true });
    const userB1 = await createPasswordlessUser(db, projB, { email: "b1@p911.test", display_name: "B1", email_verified: true });

    const payloadA = { agents: [parsedHelper.agent], entities: [TASK, NOTE], functions: FUNCTIONS, integrations: [] };
    const payloadB = { agents: [parsedHelperB.agent], entities: [TASK, NOTE], functions: FUNCTIONS, integrations: [] };
    const int0 = await pools.intOf(A.ws.id);
    const msg0 = await pools.msgOf(A.ws.id);
    // The runtime paths below consume the platform's per-window request budget: pause so the
    // fixtures' calls roll out of the window before the turn sequence starts.
    await pace(15000);

    // --- A. Contract (pure parsing — no platform requests) ------------------------------------
    const ap = (doc) => parseAgentDocument(agentFilePath("helper"), JSON.stringify(doc));
    harness.check("1a. TOOL_CONFIG_OPERATIONS is exactly Base44's documented CRUD set",
      TOOL_CONFIG_OPERATIONS.join(",") === "create,read,update,delete", TOOL_CONFIG_OPERATIONS.join(","));
    const t1 = ap({ instructions: "x", tool_configs: [{ entity_name: "task", allowed_operations: ["create", "read", "update", "create"] }] });
    harness.check("1b. a valid entity tool parses with normalized, deduplicated operations",
      t1.ok && t1.agent.tool_configs.length === 1 && t1.agent.tool_configs[0].allowed_operations.join(",") === "create,read,update",
      t1.error || JSON.stringify(t1.agent && t1.agent.tool_configs));
    const t2 = ap({ instructions: "x", tool_configs: [{ function_name: "add_note", description: "Record a note" }] });
    harness.check("1c. a valid function tool parses with its bounded description",
      t2.ok && t2.agent.tool_configs[0].function_name === "add_note" && t2.agent.tool_configs[0].description === "Record a note", t2.error || "");
    const t3 = ap({ instructions: "x", tool_configs: [{ entity_name: "task", allowed_operations: ["upsert"] }] });
    harness.check("1d. an unknown operation is refused", !t3.ok && /unknown operation 'upsert'/.test(t3.error || ""), t3.error || "");
    const t4 = ap({ instructions: "x", tool_configs: [{ entity_name: "task", allowed_operations: [42] }] });
    harness.check("1e. a non-string operation is refused", !t4.ok && /unknown operation '42'/.test(t4.error || ""), t4.error || "");
    const t5 = ap({ instructions: "x", tool_configs: [{ entity_name: "task", allowed_operations: [] }] });
    harness.check("1f. an empty allowed_operations grant is refused", !t5.ok && /non-empty 'allowed_operations'/.test(t5.error || ""), t5.error || "");
    const t6 = ap({ instructions: "x", tool_configs: [{ description: "nope" }] });
    harness.check("1g. an entry declaring neither entity nor function is refused",
      !t6.ok && /exactly one of 'entity_name' or 'function_name'/.test(t6.error || ""), t6.error || "");
    const t7 = ap({ instructions: "x", tool_configs: [{ entity_name: "task", function_name: "f", allowed_operations: ["read"] }] });
    harness.check("1h. an entry declaring both entity and function is refused", !t7.ok && /exactly one of/.test(t7.error || ""), t7.error || "");
    const t8 = ap({ instructions: "x", tool_configs: [{ entity_name: "task", allowed_operations: ["read"] }, { entity_name: "task", allowed_operations: ["create"] }] });
    harness.check("1i. a duplicate entity declaration is refused", !t8.ok && /more than once/.test(t8.error || ""), t8.error || "");
    const t9 = ap({ instructions: "x", tool_configs: "yes" });
    harness.check("1j. a malformed tool_configs value is refused", !t9.ok && /must be an array/.test(t9.error || ""), t9.error || "");
    const t10 = ap({ instructions: "x", tool_configs: Array.from({ length: 26 }, (_, i) => ({ entity_name: `e${i}`, allowed_operations: ["read"] })) });
    harness.check("1k. an oversized tool_configs list is refused (bounded grant surface)",
      !t10.ok && /at most 25/.test(t10.error || ""), t10.error || "");
    const t11 = ap({ instructions: "x", tool_configs: [{ entity_name: "__agent_messages", allowed_operations: ["read"] }] });
    harness.check("1l. a reserved runtime entity name cannot be granted as a tool",
      !t11.ok && /invalid entity name/.test(t11.error || ""), t11.error || "");
    const t12 = ap({ instructions: "x", tools: [], app_tools: ["SendEmail"], tool_configs: [{ entity_name: "task", allowed_operations: ["read"] }] });
    harness.check("1m. the existing app_tools contract is untouched beside tool_configs",
      t12.ok && JSON.stringify(t12.agent.metadata.app_tools) === '["SendEmail"]' && t12.agent.tool_configs.length === 1,
      t12.error || JSON.stringify(t12.agent && t12.agent.metadata));
    const rt = parseAgentDocument(agentFilePath("helper"), agentDocumentContent(parsedHelper.agent));
    harness.check("1n. the canonical document round-trips tool_configs",
      rt.ok && JSON.stringify(rt.agent.tool_configs) === JSON.stringify(parsedHelper.agent.tool_configs),
      rt.error || JSON.stringify(rt.agent && rt.agent.tool_configs));
    harness.check("1o. tool_configs does not leak into loose metadata",
      parsedHelper.ok && parsedHelper.agent.metadata?.tool_configs === undefined, JSON.stringify(parsedHelper.agent && parsedHelper.agent.metadata));
    const fnFiles = [
      { path: agentFilePath("helper"), content: docText() },
      { path: "functions/add_note.js", content: FN_SOURCE },
      { path: "functions/big_reply.js", content: BIGFN_SOURCE },
    ];
    const refsOk = validateAgentReferences(fnFiles, { entityNames: ["task", "note"] });
    harness.check("1p. validateAgentReferences accepts a fully-declared agent", refsOk.ok, JSON.stringify(refsOk.errors));
    const refsBad = validateAgentReferences([{
      path: agentFilePath("helper"),
      content: JSON.stringify({ instructions: "x", tool_configs: [{ entity_name: "ghost", allowed_operations: ["read"] }, { function_name: "missing_fn" }] }),
    }], { entityNames: ["task"] });
    harness.check("1q. validateAgentReferences refuses an unknown entity and an unknown function",
      !refsBad.ok && refsBad.errors.some((e) => /entity tool 'ghost'/.test(e.error)) && refsBad.errors.some((e) => /function tool 'missing_fn'/.test(e.error)),
      JSON.stringify(refsBad.errors.map((e) => e.error)));

    // --- B. Entity execution (several tools per turn: one request budget, many assertions) ----
    const poolBefore = await pools.intOf(A.ws.id);
    script = [
      { action: "tool", tool: { name: "entity_task_create", input: { data: { title: "T1", owner_id: "forged-owner-911" } } } },
      { action: "tool", tool: { name: "entity_task_read", input: {} } },
      { action: "reply", content: "done" },
    ];
    const rB1 = await invoke(projA, payloadA, userA1, "create and list my task");
    harness.check("2a. a granted entity create works through the app's own db contract", rB1.reply === "done", JSON.stringify(rB1).slice(0, 140));
    const rowsA = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "task" }, "-created_date", 50).catch(() => []);
    const t1row = rowsA[0] || null;
    harness.check("2b. the record is project-scoped and schema-validated", !!t1row && (t1row.data || {}).title === "T1", JSON.stringify(t1row && t1row.data));
    harness.check("2c. identity is server-side: a forged owner_id is stripped and the conversation owner stamps the record",
      !!t1row && t1row.owner_id === userA1.id, String(t1row && t1row.owner_id));
    const poolAfterT1 = await pools.intOf(A.ws.id);
    harness.check("2d. the per-message INTEGRATION charge is applied through the EXISTING path (no new tariff for entity tools)",
      poolAfterT1 < poolBefore, `${poolBefore} → ${poolAfterT1}`);
    const readMsg = lastMsg("[tool entity_task_read result]");
    harness.check("2e. a granted read returns the records to the model", readMsg.includes("T1"), readMsg.slice(0, 100));
    script = [
      { action: "tool", tool: { name: "entity_task_update", input: { id: t1row.id, data: { done: true } } } },
      { action: "tool", tool: { name: "entity_task_delete", input: { id: t1row.id } } },
      { action: "tool", tool: { name: "entity_note_create", input: { data: { text: "x" } } } },
      { action: "reply", content: "ok" },
    ];
    await invoke(projA, payloadA, userA1, "update, then try to delete and make a note");
    const rowsA2 = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "task" }, "-created_date", 50).catch(() => []);
    const t1upd = rowsA2.find((r) => r.id === t1row.id);
    harness.check("2f. a granted update works", t1upd && (t1upd.data || {}).done === true, JSON.stringify(t1upd && t1upd.data));
    harness.check("2g. an ungranted operation is refused BEFORE execution (record untouched)",
      !!t1upd && lastMsg("entity_task_delete").includes("not granted"), lastMsg("entity_task_delete").slice(0, 100));
    harness.check("2h. an ungranted entity is refused (no record created)",
      (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "note" }, "-created_date", 10).catch(() => [])).length === 0
        && lastMsg("entity_note_create").includes("not granted"), lastMsg("entity_note_create").slice(0, 100));
    script = [
      { action: "tool", tool: { name: "entity_task_read", input: {} } },
      { action: "tool", tool: { name: "entity_task_update", input: { id: t1row.id, data: { title: "hacked" } } } },
      { action: "reply", content: "a2 done" },
    ];
    await invoke(projA, payloadA, userA2, "list and update tasks");
    const a2Read = lastMsg("[tool entity_task_read result]");
    const a2Upd = lastMsg("[tool entity_task_update result]");
    const t1after = await db.entities.AppRecord.get(t1row.id).catch(() => null);
    harness.check("2i. owner isolation: user A2 sees none of A1's records", a2Read.includes("[]"), a2Read.slice(0, 100));
    harness.check("2j. cross-user mutation is refused (NOT_FOUND) and the record is unchanged",
      a2Upd.includes("DATABASE_RECORD_NOT_FOUND") && t1after && (t1after.data || {}).title === "T1", a2Upd.slice(0, 100));
    const aCountBefore = rowsA2.length;
    script = [
      { action: "tool", tool: { name: "entity_task_create", input: { data: { title: "B-ONLY" } } } },
      { action: "tool", tool: { name: "function_add_note", input: { note: "b" } } },
      { action: "reply", content: "b done" },
    ];
    const rB4 = await invoke(projB, payloadB, userB1, "create and count");
    const rowsB = await db.entities.AppRecord.filter({ project_id: projB.id, entity_name: "task" }, "-created_date", 50).catch(() => []);
    const bSeen = (lastMsg("[tool function_add_note result]").match(/"seen_tasks":(\d+)/) || [])[1];
    harness.check("2k. cross-project isolation: B's turn created B's record under B's project and owner",
      rB4.reply === "b done" && rowsB.length === 1 && rowsB[0].project_id === projB.id && rowsB[0].owner_id === userB1.id && (rowsB[0].data || {}).title === "B-ONLY",
      JSON.stringify(rowsB.map((r) => ({ project_id: r.project_id, owner_id: r.owner_id }))));
    const rowsA3 = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "task" }, "-created_date", 50).catch(() => []);
    harness.check("2l. A's data is untouched by B's turn", rowsA3.length === aCountBefore, `${aCountBefore} → ${rowsA3.length}`);

    // --- C. Backend function ---------------------------------------------------------------------
    const invBefore = (await db.entities.FunctionInvocation.filter({ project_id: projA.id, function_name: "add_note" }, "-created_date", 50)).length;
    script = [
      { action: "tool", tool: { name: "function_add_note", input: { note: "hello" } } },
      { action: "tool", tool: { name: "function_add_note", input: { blob: "x".repeat(TOOL_INPUT_MAX_CHARS + 100) } } },
      { action: "tool", tool: { name: "function_summarize", input: {} } },
      { action: "reply", content: "function done" },
    ];
    await invoke(projA, payloadA, userA1, "run the function, then two bad ones");
    const invRows = await db.entities.FunctionInvocation.filter({ project_id: projA.id, function_name: "add_note" }, "-created_date", 10);
    const fnMsg = lastMsg("[tool function_add_note result]");
    const oversizedIn = seen.flat().map((m) => String((m || {}).content || "")).find((c) => c.includes("AGENT_TOOL_INPUT_TOO_LARGE")) || "";
    harness.check("3a. a declared function tool executes through the EXISTING runtime (one audited invocation)",
      invRows.length === invBefore + 1 && invRows[0].status === 200 && invRows[0].trigger === "frontend",
      JSON.stringify(invRows[0] && { status: invRows[0].status, trigger: invRows[0].trigger }));
    harness.check("3b. the FunctionInvocation audit row records the server-resolved app user",
      invRows[0] && invRows[0].identity?.kind === "app_user" && invRows[0].identity?.app_user_id === userA1.id,
      JSON.stringify(invRows[0] && invRows[0].identity));
    harness.check("3c. the function runs with the conversation owner's identity (ctx.user)",
      fnMsg.includes(`"user_id":"${userA1.id}"`), fnMsg.slice(0, 120));
    harness.check("3d. project scope holds inside the function: it saw only A's tasks",
      (fnMsg.match(/"seen_tasks":(\d+)/) || [])[1] === String(aCountBefore), fnMsg.slice(0, 80));
    harness.check("3e. an oversized tool input is refused BEFORE the function runs (no new invocation)",
      oversizedIn.length > 0 && invRows.length === invBefore + 1, oversizedIn.slice(0, 100));
    harness.check("3f. an undeclared function is refused with no invocation recorded",
      lastMsg("function_summarize").includes("not granted") && invRows.length === invBefore + 1,
      lastMsg("function_summarize").slice(0, 100));
    const llm0 = calls.llm;
    const badFn = await captureCall(() => invoke(projA, {
      agents: [{ ...parsedHelper.agent, tool_configs: [{ function_name: "missing_fn", description: "x" }] }],
      entities: [TASK, NOTE], functions: FUNCTIONS, integrations: [],
    }, userA1, "hello"));
    harness.check("3g. a declared function missing from the deployment refuses the invoke fail-closed (no model step)",
      badFn.threw && badFn.code === "AGENT_FUNCTION_NOT_DECLARED" && calls.llm === llm0, JSON.stringify(badFn));
    const badEnt = await captureCall(() => invoke(projA, {
      agents: [{ ...parsedHelper.agent, tool_configs: [{ entity_name: "ghost", allowed_operations: ["read"] }] }],
      entities: [TASK, NOTE], functions: FUNCTIONS, integrations: [],
    }, userA1, "hello"));
    harness.check("3h. a declared entity missing from the deployment refuses the invoke fail-closed (no model step)",
      badEnt.threw && badEnt.code === "AGENT_ENTITY_NOT_DECLARED" && calls.llm === llm0, JSON.stringify(badEnt));

    // --- D. Security ------------------------------------------------------------------------------
    await pace(15000); // request-window rollover before the remaining turns
    script = [
      { action: "tool", tool: { name: "function_big_reply", input: {} } },
      { action: "reply", content: "big" },
    ];
    await invoke(projA, payloadA, userA1, "get a big reply");
    const bigObs = lastMsg("[tool function_big_reply result]");
    harness.check("4a. observations are bounded to the existing runtime cap",
      bigObs.length > 0 && bigObs.length <= APP_AGENT_LIMITS.MAX_OBSERVATION_CHARS, String(bigObs.length));
    const allJson = JSON.stringify(responses);
    harness.check("4b. no agent instructions, function source or credential marker in any response",
      !allJson.includes(INSTRUCTIONS) && !allJson.includes("export default") && !allJson.includes("SECRET"), `responses scanned: ${responses.length}`);
    const tcRows = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 200).catch(() => []);
    const entry = tcRows.flatMap((r) => (r.data || {}).tool_calls || []).find((c) => c && c.tool);
    harness.check("4c. persisted tool_calls entries carry only bounded safe fields (tool, ok, code)",
      !!entry && Object.keys(entry).sort().join(",") === "code,ok,tool", JSON.stringify(entry));
    harness.check("4d. a tool result cannot escape project scope (B's function saw only B's data)", bSeen === "1", String(bSeen));

    // --- E. Idempotency -----------------------------------------------------------------------------
    const k1 = `p911-key-1-${stamp}`;
    script = [
      { action: "tool", tool: { name: "entity_task_create", input: { data: { title: "K1" } } } },
      { action: "reply", content: "keyed done" },
    ];
    await invoke(projA, payloadA, userA1, "keyed create", { idempotency_key: k1 });
    const llmA = calls.llm;
    const rowsK1 = (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "task" }, "-created_date", 50).catch(() => []))
      .filter((r) => (r.data || {}).title === "K1").length;
    script = [{ action: "reply", content: "SHOULD-NOT-RUN" }];
    const replay = await invoke(projA, payloadA, userA1, "keyed create", { idempotency_key: k1 });
    harness.check("5a. a completed keyed turn replays its reply — no duplicate mutation, no new model step",
      replay.idempotent_replay === true && calls.llm === llmA
        && (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "task" }, "-created_date", 50).catch(() => []))
          .filter((r) => (r.data || {}).title === "K1").length === rowsK1 && rowsK1 === 1,
      JSON.stringify({ replayed: replay.idempotent_replay, llm_delta: calls.llm - llmA }));
    const k2 = `p911-key-2-${stamp}`;
    script = [
      { action: "tool", tool: { name: "function_add_note", input: { note: "once" } } },
      { action: "reply", content: "fn done" },
    ];
    await invoke(projA, payloadA, userA1, "keyed function", { idempotency_key: k2 });
    const invK2 = (await db.entities.FunctionInvocation.filter({ project_id: projA.id, function_name: "add_note" }, "-created_date", 50)).length;
    const replyRow = await findKeyedReplyRow(db, projA.id, k2);
    await db.entities.AppRecord.delete(replyRow.id);
    script = [
      { action: "tool", tool: { name: "function_add_note", input: { note: "twice" } } },
      { action: "reply", content: "fn done again" },
    ];
    const retry = await invoke(projA, payloadA, userA1, "keyed function", { idempotency_key: k2 });
    const invK2after = (await db.entities.FunctionInvocation.filter({ project_id: projA.id, function_name: "add_note" }, "-created_date", 50)).length;
    harness.check("5b. a crash-retried turn replays the first tool result — the side effect ran exactly once",
      retry.reply === "fn done again" && invK2after === invK2, JSON.stringify({ reply: retry.reply, invocations: invK2after, expected: invK2 }));
    const ledger = await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "-created_date", 500).catch(() => []);
    const keys = ledger.map((r) => r.idempotency_key).filter(Boolean);
    const dups = keys.filter((k, i) => keys.indexOf(k) !== i);
    harness.check("5c. no duplicate ledger idempotency keys across the suite (no double charge)",
      dups.length === 0, JSON.stringify(dups.slice(0, 3)));

    // --- F. Billing ---------------------------------------------------------------------------------
    harness.check("6a. the per-message integration charge applies to tool_configs turns through the existing path",
      poolAfterT1 < poolBefore, `${poolBefore} → ${poolAfterT1}`);
    const offPath = ledger.filter((r) => r.idempotency_key
      && !String(r.idempotency_key).includes("appagent:")
      && !String(r.idempotency_key).startsWith("p911:"));
    harness.check("6b. no second ledger path: every movement is a model-step charge or the test grant",
      offPath.length === 0, JSON.stringify(offPath.slice(0, 2).map((r) => r.idempotency_key)));
    harness.check("6c. entity and function tool execution invented no tariff (message pool untouched; only the per-message charge moved)",
      (await pools.msgOf(A.ws.id)) === msg0, `${msg0} → ${await pools.msgOf(A.ws.id)}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by name pattern, including residue from earlier runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911[a-b]" } }, "created_date", 200).catch(() => []);
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
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911t[0-9]+$" } }).catch(() => {});
  }
}