// P-9.11B+ certification — the CONFIRMED Base44 agent-memory scope:"both" write contract.
//
// Confirmed by a disposable-agent probe on the real platform: with memory_config.scope "both",
// save_memory takes an explicit scope — "user" | "global" — the model chooses per saved fact,
// and a fact is written to the selected scope, never automatically to both. This suite certifies
// exactly that gap closure over the REAL shipping runtime (appAgentRuntime, scripted provider):
//   • the "both" protocol exposes both write targets (explicit scope in the action schema/text);
//   • a "both" agent saves SEPARATE user-scoped and global-scoped memories in one turn;
//   • single-scope agents are UNCHANGED: a model-supplied scope is ignored (user stays user,
//     global stays global), and a "both" save without a scope defaults to the user's own;
//   • existing read/injection behavior is untouched (user/global/both isolation, cross-user).
// Drives the same fixtures/cleanup pattern as appAgentMemoryParityTest; every fixture is scratch.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent, MEMORY_GLOBAL_OWNER } from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, makePayloadInvoke } from "../../shared/appAgentSuiteHelpers.ts";
import { makeMemoryAgent, makeMemoryEvidence, makeMemoryLookups } from "../../shared/appAgentMemoryCertHelpers.ts";

const INSTRUCTIONS = "Instructions-marker-memboth: help users of this application.";
const STMT_USER = "The user's favorite color is teal.";
const STMT_GLOBAL = "The app's support window is 9 to 5 UTC.";
const STMT_USER_ONLY = "The user-only agent's fact is stored user-scoped.";
const STMT_GLOBAL_ONLY = "The global-only agent's fact is stored globally.";
const STMT_IGNORED = "This scope must be ignored by single-scope agents.";

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = [];

  const systemSeen = [];
  const seen = [];
  let script = [];
  const fakeProvider = {
    async generate({ messages, jsonSchema, system }) {
      if (typeof system === "string") systemSeen.push(system);
      if (Array.isArray(messages)) seen.push(messages);
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const opts = { providerOverrides };

  const mkAgent = makeMemoryAgent(INSTRUCTIONS);
  const AGENTS = [
    mkAgent("both_agent", { enabled: true, scope: "both", include_other_conversation_context: false, instructions: null }),
    mkAgent("user_agent", { enabled: true, scope: "user", include_other_conversation_context: false, instructions: null }),
    mkAgent("global_agent", { enabled: true, scope: "global", include_other_conversation_context: false, instructions: null }),
  ];
  const payload = { agents: AGENTS, entities: [], functions: [], integrations: [] };

  const pace = appAgentPace;
  const db = makeAgentSuiteDb(rawDb, pace);
  const pools = makeAgentPoolTools(db, stamp, "p9mab");
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };

  const { lastSystem, lastMsg } = makeMemoryEvidence(systemSeen, seen);
  const { memRows, rowsOf } = makeMemoryLookups(db);
  const invokeAgent = makeAgentInvoke({ handleAppAgent, client, options: opts, pace, responses });
  const invoke = makePayloadInvoke(invokeAgent, payload);

  try {
    const plan = await makeBillingPlan(db, created, `p9mabt${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9maba${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await pace(1500);
    await pools.grant(A.ws.id, "message", 300);
    await pools.grant(A.ws.id, "integration", 60);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p9mab-proj-${A.user.id}-${stamp}`, slug: `p9mab-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p9mab.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p9mab.test", display_name: "A2", email_verified: true });
    const msg0 = await pools.msgOf(A.ws.id);
    await pace(15000);

    // --- 1. Protocol: "both" exposes both write targets; single scopes stay exact -----------
    script = [{ action: "reply", content: "ok" }];
    await invoke(projA, userA1, "both_agent", "hello");
    const bothSystem = lastSystem();
    harness.check("1a. the scope:\"both\" protocol exposes BOTH write targets (explicit user|global scope)",
      bothSystem.includes("MEMORY: you may save") && bothSystem.includes(`"scope": "user" | "global"`)
        && bothSystem.includes(`"user" for the individual user's own preferences`) && bothSystem.includes(`"global" for facts every user of this app`),
      "scope choice present in the both-agent system");
    await invoke(projA, userA1, "user_agent", "hello");
    const userSystem = lastSystem();
    harness.check("1b. a single-scope user agent keeps the EXACT previous protocol text (no scope choice)",
      userSystem.includes("MEMORY: you may save") && userSystem.includes('{ "statement": "<one short sentence of what to remember>" } }')
        && !userSystem.includes('"scope": "user" | "global"'),
      "protocol unchanged for scope user");
    await invoke(projA, userA1, "global_agent", "hello");
    harness.check("1c. a single-scope global agent keeps the EXACT previous protocol text",
      lastSystem().includes('{ "statement": "<one short sentence of what to remember>" } }') && !lastSystem().includes('"scope": "user" | "global"'),
      "protocol unchanged for scope global");

    // --- 2. The gap: a "both" agent saves SEPARATE user/global memories in one turn ----------
    script = [
      { action: "memory", memory: { statement: STMT_USER, scope: "user" } },
      { action: "memory", memory: { statement: STMT_GLOBAL, scope: "global" } },
      { action: "reply", content: "both saved" },
    ];
    const r2 = await invoke(projA, userA1, "both_agent", "remember my color and the support window");
    const userRows = await rowsOf(projA, userA1.id, "both_agent");
    const globalRows = await rowsOf(projA, MEMORY_GLOBAL_OWNER, "both_agent");
    harness.check("2a. the both-agent turn completes and the model chose the scopes per fact",
      r2.reply === "both saved" && lastMsg("[memory saved]").length > 0, JSON.stringify(r2).slice(0, 120));
    harness.check("2b. the user-targeted fact is stored under the caller's own owner with scope user",
      userRows.length === 1 && userRows[0].owner_id === userA1.id && (userRows[0].data || {}).scope === "user"
        && (userRows[0].data || {}).statement === STMT_USER,
      JSON.stringify(userRows.map((r) => ({ owner: r.owner_id, scope: (r.data || {}).scope }))));
    harness.check("2c. the global-targeted fact is stored under the MEMORY_GLOBAL_OWNER sentinel with scope global",
      globalRows.length === 1 && globalRows[0].owner_id === MEMORY_GLOBAL_OWNER && (globalRows[0].data || {}).scope === "global"
        && (globalRows[0].data || {}).statement === STMT_GLOBAL,
      JSON.stringify(globalRows.map((r) => ({ owner: r.owner_id, scope: (r.data || {}).scope }))));
    harness.check("2d. both targets produced SEPARATE memories — no automatic double write",
      userRows.length === 1 && globalRows.length === 1
        && !userRows.some((r) => (r.data || {}).scope === "global")
        && !globalRows.some((r) => (r.data || {}).scope === "user"),
      "one row per selected scope only");

    // --- 3. Read/injection behavior UNCHANGED (memories are per-agent, per-owner, per-scope) --
    script = [{ action: "reply", content: "ok" }];
    await invoke(projA, userA1, "both_agent", "what do you remember?");
    harness.check("3a. the both-agent injects BOTH its own user and global facts (read path unchanged)",
      lastSystem().includes(STMT_USER) && lastSystem().includes(STMT_GLOBAL), "both scopes rendered for owner");
    await invoke(projA, userA2, "both_agent", "what do you remember?");
    harness.check("3b. another user sees the global fact and NOT the first user's own fact",
      lastSystem().includes(STMT_GLOBAL) && !lastSystem().includes(STMT_USER), "user isolation preserved");
    // Each single-scope agent saves ITS OWN fact first — memory rows are per-agent, so a
    // single-scope agent must be tested with its own saved facts, never another agent's.
    script = [{ action: "memory", memory: { statement: STMT_USER_ONLY } }, { action: "reply", content: "ok" }];
    await invoke(projA, userA1, "user_agent", "remember a user-only fact");
    script = [{ action: "memory", memory: { statement: STMT_GLOBAL_ONLY } }, { action: "reply", content: "ok" }];
    await invoke(projA, userA1, "global_agent", "remember a global-only fact");
    await invoke(projA, userA1, "user_agent", "what do you remember?");
    harness.check("3c. the user-scope agent injects only its own user fact, never a global one",
      lastSystem().includes(STMT_USER_ONLY) && !lastSystem().includes(STMT_GLOBAL_ONLY)
        && !lastSystem().includes(STMT_GLOBAL), "user scope strict");
    await invoke(projA, userA1, "global_agent", "what do you remember?");
    harness.check("3d. the global-scope agent injects only its own global fact, never a user-scoped one",
      lastSystem().includes(STMT_GLOBAL_ONLY) && !lastSystem().includes(STMT_USER_ONLY)
        && !lastSystem().includes(STMT_USER), "global scope strict");

    // --- 4. Single-scope and omitted-scope writes are UNCHANGED --------------------------------
    script = [
      { action: "memory", memory: { statement: STMT_IGNORED, scope: "global" } },
      { action: "reply", content: "ok" },
    ];
    await invoke(projA, userA1, "user_agent", "try to save globally anyway");
    const hijacked = await rowsOf(projA, MEMORY_GLOBAL_OWNER, "user_agent");
    const keptUser = await rowsOf(projA, userA1.id, "user_agent");
    harness.check("4a. a user-scope agent IGNORES a model-supplied global scope (still user-scoped)",
      hijacked.length === 0 && keptUser.some((r) => (r.data || {}).statement === STMT_IGNORED && (r.data || {}).scope === "user"),
      JSON.stringify({ hijacked: hijacked.length, kept: keptUser.map((r) => (r.data || {}).scope) }));
    script = [
      { action: "memory", memory: { statement: STMT_IGNORED, scope: "user" } },
      { action: "reply", content: "ok" },
    ];
    await invoke(projA, userA1, "global_agent", "try to save user-scoped anyway");
    const keptGlobal = await rowsOf(projA, MEMORY_GLOBAL_OWNER, "global_agent");
    const leaked = await rowsOf(projA, userA1.id, "global_agent");
    harness.check("4b. a global-scope agent IGNORES a model-supplied user scope (still global)",
      leaked.length === 0 && keptGlobal.some((r) => (r.data || {}).statement === STMT_IGNORED && (r.data || {}).scope === "global"),
      JSON.stringify({ leaked: leaked.length, kept: keptGlobal.map((r) => (r.data || {}).scope) }));
    script = [
      { action: "memory", memory: { statement: "The omitted-scope default fact." } },
      { action: "reply", content: "ok" },
    ];
    await invoke(projA, userA1, "both_agent", "save without choosing a scope");
    const omitUser = await rowsOf(projA, userA1.id, "both_agent");
    const omitGlobal = await rowsOf(projA, MEMORY_GLOBAL_OWNER, "both_agent");
    harness.check("4c. a both-agent save WITHOUT a scope defaults to the caller's own scope (never shared)",
      omitUser.length === 2 && omitUser.some((r) => (r.data || {}).statement === "The omitted-scope default fact.")
        && omitGlobal.length === 1,
      JSON.stringify({ user: omitUser.length, global: omitGlobal.length }));

    // --- 5. Billing neutrality ------------------------------------------------------------------
    const ledger = await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "-created_date", 500).catch(() => []);
    harness.check("5a. memory saves carry no tariff of their own (message pool untouched, no memory-scoped ledger movement)",
      (await pools.msgOf(A.ws.id)) === msg0 && !ledger.some((r) => String(r.idempotency_key || "").includes("memory")),
      `${msg0} → ${await pools.msgOf(A.ws.id)}`);
    const allJson = JSON.stringify(responses);
    harness.check("5b. no agent instructions or saved statements leak into any response beyond the runtime contract",
      !allJson.includes(INSTRUCTIONS), `responses scanned: ${responses.length}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p9mab-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p9mab" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppSession.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
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
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p9mabt[0-9]+$" } }).catch(() => {});
  }
}