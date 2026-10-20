// P-9.11B+ certification — the DOCUMENTED Base44 agent-memory scan bound (200, no pagination)
// and the UNCHANGED injection cap (20 rows).
//
// DOCUMENTED (Base44): list-agent-memories returns up to 200 memories; no pagination. The scan
// (readAgentMemories) therefore fetches the newest 200 rows per scope before the agent/scope
// filter. The injected model block stays separately capped at MEMORY_MAX_ROWS (20) and the
// block char cap (1500) — UNCHANGED, asserted below against short statements so the char cap
// cannot bind and the row cap is exactly observable.
//
// The scan bound is proven exactly against the REAL runtime read (not a re-implementation):
// 205 user-scoped facts are stored for one (project, agent, owner); the read must return
// EXACTLY 200 — the newest 200 kept (all of chunks 2 and 3 present), exactly the 5 OLDEST
// (from chunk 1) dropped — and no pagination beyond it. Ordering (newest-first), scope
// isolation (no global facts for a different agent leak) and the 20-row injection cap through
// a real agent turn are asserted alongside. No memory tariff exists, so no billing check moves
// here beyond message-pool neutrality on the one scripted turn.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent, readAgentMemories, MEMORY_GLOBAL_OWNER, MEMORIES_ENTITY } from "../../shared/appAgentRuntime.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, makePayloadInvoke } from "../../shared/appAgentSuiteHelpers.ts";
import { makeMemoryAgent, makeMemoryEvidence, makeMemoryLookups } from "../../shared/appAgentMemoryCertHelpers.ts";

const INSTRUCTIONS = "Instructions-marker-memscan: help users of this application.";
const TOTAL_ROWS = 205;
const SCAN_BOUND = 200;
const INJECTION_CAP = 20;
const fact = (i) => `scan-fact-${String(i).padStart(3, "0")}`;

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
  const agent = mkAgent("mem_agent", { enabled: true, scope: "both", include_other_conversation_context: false, instructions: null });
  const payload = { agents: [agent], entities: [], functions: [], integrations: [] };

  const pace = appAgentPace;
  const db = makeAgentSuiteDb(rawDb, pace);
  const pools = makeAgentPoolTools(db, stamp, "p9mas");
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };

  const { lastSystem } = makeMemoryEvidence(systemSeen, seen);
  const invokeAgent = makeAgentInvoke({ handleAppAgent, client, options: opts, pace, responses });
  const invoke = makePayloadInvoke(invokeAgent, payload);

  const memFacts = async (owner, scope) => (await db.entities.AppRecord.filter(
    { project_id: projectRef.id, entity_name: MEMORIES_ENTITY, owner_id: owner }, "-created_date", 400,
  ).catch(() => [])).filter((r) => (r.data || {}).agent_name === "mem_agent" && (r.data || {}).scope === scope)
    .map((r) => (r.data || {}).statement);

  let projectRef = null;

  try {
    const plan = await makeBillingPlan(db, created, `p9mast${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9masa${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await pace(1500);
    await pools.grant(A.ws.id, "message", 100);
    await pools.grant(A.ws.id, "integration", 60);
    await pace(1500);
    projectRef = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p9mas-proj-${A.user.id}-${stamp}`, slug: `p9mas-${stamp}`, rls_enabled: true });
    projectIds.push(projectRef.id);
    const userA1 = await createPasswordlessUser(db, projectRef, { email: "a1@p9mas.test", display_name: "A1", email_verified: true });
    const msg0 = await pools.msgOf(A.ws.id);
    await pace(15000);

    // --- 1. Store 205 user-scoped facts for ONE (project, agent, owner), newest last ----------
    // Same-batch bulk rows share created_date, so the fetch's -created_date order is
    // nondeterministic WITHIN a batch. The fixture therefore anchors both ends with paced
    // single creates (deterministic timestamps) and puts only unordered middle rows in bulk:
    // the anchors make the bound and the newest-first ordering exactly observable regardless
    // of within-batch tie order.
    const anchor = async (start, count) => {
      for (let i = start; i < start + count; i++) {
        await db.entities.AppRecord.create({
          project_id: projectRef.id, entity_name: MEMORIES_ENTITY, owner_id: userA1.id,
          data: { agent_name: "mem_agent", scope: "user", statement: fact(i), created_at: new Date().toISOString() },
        });
        await pace(1200);
      }
    };
    await anchor(0, 10);                     // 10 OLDEST anchors (created first)
    await db.entities.AppRecord.bulkCreate(Array.from({ length: 185 }, (_, k) => ({
      project_id: projectRef.id, entity_name: MEMORIES_ENTITY, owner_id: userA1.id,
      data: { agent_name: "mem_agent", scope: "user", statement: fact(10 + k), created_at: new Date().toISOString() },
    })));
    await pace(1500);
    await anchor(195, 10);                   // 10 NEWEST anchors (created last)
    const stored = await memFacts(userA1.id, "user");
    harness.check("1a. the fixture stores all 205 user-scoped facts (scan input is real)",
      stored.length === TOTAL_ROWS && new Set(stored).size === TOTAL_ROWS,
      `stored=${stored.length}`);

    // --- 2. The DOCUMENTED 200-memory scan bound, no pagination -------------------------------
    const readUser = await readAgentMemories(db, projectRef, agent, userA1, { enabled: true, scope: "user" });
    const userFacts = readUser.filter((f) => f.scope === "user").map((f) => f.statement);
    const factIdx = (s) => Number(String(s).split("-")[2]);
    harness.check("2a. the scan returns EXACTLY 200 memories for 205 stored — the documented bound, no pagination",
      readUser.length === SCAN_BOUND && userFacts.length === SCAN_BOUND,
      `returned=${readUser.length}`);
    const newestAnchors = Array.from({ length: 10 }, (_, k) => fact(195 + k));
    const oldestAnchors = Array.from({ length: 10 }, (_, k) => fact(k));
    harness.check("2b. the scan keeps the NEWEST 200 — all 10 newest anchors present, exactly 5 of the 10 oldest kept",
      newestAnchors.every((s) => userFacts.includes(s))
        && userFacts.filter((s) => oldestAnchors.includes(s)).length === 5,
      `oldest-kept=${userFacts.filter((s) => oldestAnchors.includes(s)).length}/10`);
    harness.check("2c. scan ordering is newest first — every newest anchor precedes every kept oldest anchor",
      (() => {
        const pos = (s) => userFacts.indexOf(s);
        const keptOldest = oldestAnchors.filter((s) => userFacts.includes(s)).map(pos);
        return userFacts.length === SCAN_BOUND && keptOldest.length > 0
          && newestAnchors.map(pos).every((p) => p < Math.max(...keptOldest))
          && pos(fact(204)) < pos(fact(195));
      })(),
      `head-tail=${userFacts.slice(0, 3).map(factIdx).join(",")}`);

    // --- 3. Injection stays capped at 20 rows (UNCHANGED) --------------------------------------
    script = [{ action: "reply", content: "ok" }];
    await invoke(projectRef, userA1, "mem_agent", "what do you remember?");
    const system = lastSystem();
    const blockLines = (system.split("\n").filter((l) => /^- \[(user|global)\] scan-fact-\d+$/.test(l.trim())));
    const injectedIdx = blockLines.map((l) => factIdx(l.trim().replace(/^- \[user\] /, "")));
    harness.check("3a. the injected memory block contains EXACTLY 20 rows (MEMORY_MAX_ROWS unchanged)",
      blockLines.length === INJECTION_CAP, `injected=${blockLines.length}`);
    const injectedStatements = blockLines.map((l) => l.trim().replace(/^- \[user\] /, ""));
    harness.check("3b. the injected 20 include ALL 10 newest anchors and no oldest anchor (newest-first, 20-row cap)",
      injectedStatements.length === INJECTION_CAP
        && newestAnchors.every((s) => injectedStatements.includes(s))
        && !injectedStatements.some((s) => oldestAnchors.includes(s)),
      `injected head/tail=${injectedIdx[0]}/${injectedIdx[19]}`);
    harness.check("3c. no global-scope or other-agent fact leaks into the block (scope/agent isolation unchanged)",
      !system.includes("- [global] scan-fact-") && system.includes("AGENT MEMORY"), "user facts only");

    // --- 4. Global-side bound + read isolation spot-checks -------------------------------------
    const globalFacts = await memFacts(MEMORY_GLOBAL_OWNER, "global");
    harness.check("4a. no global rows exist for this agent and none leak into the user's read",
      globalFacts.length === 0 && readUser.every((f) => f.scope === "user"), `global=${globalFacts.length}`);
    const disabledRead = await readAgentMemories(db, projectRef, agent, userA1, { enabled: false, scope: "user" });
    harness.check("4b. a memory-disabled agent still reads nothing (unchanged behavior)",
      disabledRead.length === 0, `disabled=${disabledRead.length}`);

    // --- 5. Billing neutrality on the scripted turn --------------------------------------------
    harness.check("5a. memory reads/writes move no credits — the message pool is untouched",
      (await pools.msgOf(A.ws.id)) === msg0, `${msg0} → ${await pools.msgOf(A.ws.id)}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p9mas-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p9mas" } }, "created_date", 200).catch(() => []);
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
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p9mast[0-9]+$" } }).catch(() => {});
  }
}