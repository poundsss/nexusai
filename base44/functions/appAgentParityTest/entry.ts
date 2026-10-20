// P-9.4 regression suite: deployed in-app agent execution parity.
//
// Drives the REAL handler (shared/appAgentRuntime.ts) over the REAL canonical billing paths —
// beginOperation/finalizeOperation for message credits, invokePrimitive + the P-9.2 handlers for
// tools — with only the provider boundary stubbed (counters prove fail-closed happens before it).
// Asserts: execution + persisted state, model access, unauthorized access, workspace isolation,
// tool authorization, message-credit charge, integration-credit charge, failed run = no charge,
// replay/idempotency, insufficient credits = fail-closed, cross-user isolation.
// Every fixture is scratch and removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  // ---- provider boundary stub (handlers, ledger and executor are the REAL ones) ----
  const calls = { llm: 0, image: 0 };
  const flags = { llm_fail: false };
  let script = [];           // queued model decisions; empty → default reply
  const seen = [];           // (system, messages) of every model call
  const fakeProvider = {
    async generate({ system, messages, jsonSchema }) {
      calls.llm++;
      // The request reached the provider — record it BEFORE the failure flag, so a failed
      // run still proves what the model was shown (persisted history parity).
      seen.push({ system, messages: JSON.parse(JSON.stringify(messages || [])) });
      if (flags.llm_fail) throw Object.assign(new Error("model provider unavailable"), { code: "PROVIDER_UNAVAILABLE", retryable: true });
      const out = script.length ? script.shift() : { action: "reply", content: "OK, noted." };
      return {
        output: jsonSchema ? out : (out.action === "reply" ? out.content : JSON.stringify(out)),
        usage: { input_tokens: 120, output_tokens: 30, usage_source: "provider" },
      };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  // The stub client: service-role entities are real; only the integration providers are faked.
  const client = {
    asServiceRole: {
      entities: db.entities,
      integrations: { Core: { GenerateImage: async () => { calls.image++; return { url: `https://cdn.test/agent-${calls.image}.png` }; } } },
    },
  };
  const opts = { providerOverrides };
  // Small inter-call pacing: the platform rate-limits bursts of SDK requests, and every invoke
  // rides the real entity/ledger paths (a dozen+ requests per call).
  const pace = appAgentPace;
  const run = async (project, user, op, args) => {
    await pace();
    return handleAppAgent(client, { project, payload, user, op, args, options: opts });
  };

  const agentDoc = appAgentDoc;
  const payload = {
    agents: [agentDoc("helper"), agentDoc("artist", { app_tools: ["GenerateImage"] }), agentDoc("badtool", { app_tools: ["Hack"] })],
    entities: [],
  };

  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p94");

  try {
    const plan = await makeBillingPlan(db, created, `agent${stamp}`, {});                       // unlimited usage, all models
    const planRestricted = await makeBillingPlan(db, created, `agentres${stamp}`, { model_access: ["nonexistent_model_xyz"] });
    const A = await makeBillingWorkspace(db, created, `p94a${stamp}`, { plan });
    const B = await makeBillingWorkspace(db, created, `p94b${stamp}`, { plan });
    const C = await makeBillingWorkspace(db, created, `p94c${stamp}`, { plan });                  // funded plan, zero credits
    const D = await makeBillingWorkspace(db, created, `p94d${stamp}`, { plan: planRestricted });  // plan excludes every routable model
    for (const f of [A, B, C, D]) wsIds.push(f.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);
    await grant(B.ws.id, "message", 200);
    await grant(B.ws.id, "integration", 20);
    await grant(D.ws.id, "message", 200);

    const mkProject = (ws) => makeAgentProject(db, projectIds, ws, stamp, "p94");
    const projA = await mkProject(A);
    const projC = await mkProject(C);
    const projD = await mkProject(D);

    const userA = { id: `p94_userA_${stamp}`, email: "a@p94.test" };
    const userB = { id: `p94_userB_${stamp}`, email: "b@p94.test" };
    const userC = { id: `p94_userC_${stamp}`, email: "c@p94.test" };
    const userD = { id: `p94_userD_${stamp}`, email: "d@p94.test" };

    // ---- unauthorized access, fail-closed -----------------------------------------
    const noAuth = await captureCall(() => run(projA, null, "invoke", { name: "helper", message: "hi" }));
    harness.check("unauthenticated invoke is refused (AUTH_REQUIRED, 401)", noAuth.threw && noAuth.code === "AGENT_AUTH_REQUIRED" && noAuth.status === 401, JSON.stringify(noAuth));
    const noAgent = await captureCall(() => run(projA, userA, "invoke", { name: "ghost", message: "hi" }));
    harness.check("unknown agent is not found", noAgent.threw && noAgent.code === "AGENT_NOT_FOUND", JSON.stringify(noAgent));
    const badTool = await captureCall(() => run(projA, userA, "invoke", { name: "badtool", message: "hi" }));
    harness.check("an app tool outside the fixed allowlist fails closed at validation", badTool.threw && badTool.code === "AGENT_TOOL_NOT_SUPPORTED", JSON.stringify(badTool));

    // ---- execution + persisted conversation state ----------------------------------
    const msgBefore = await msgOf(A.ws.id);
    const intBeforeTurn = await intOf(A.ws.id);
    script = [{ action: "reply", content: "Hello from the agent" }];
    const first = await run(projA, userA, "invoke", { name: "helper", message: "first question" });
    const convId = first.conversation_id;
    const state1 = await run(projA, userA, "messages", { conversation_id: convId });
    harness.check("execution: invoke returns the agent reply and persists user+assistant rows",
      first.reply === "Hello from the agent" && !first.idempotent_replay && state1.count === 2 && state1.messages.map((m) => m.role).join(",") === "user,assistant",
      JSON.stringify({ reply: first.reply, count: state1.count }));

    // ---- integration credits through the canonical path (P-9.11E parity) --------------
    const msgAfter = await msgOf(A.ws.id);
    const intAfterTurn = await intOf(A.ws.id);
    harness.check("the turn is charged from the workspace INTEGRATION pool, message pool untouched",
      intAfterTurn < intBeforeTurn && msgAfter === msgBefore,
      `int ${intBeforeTurn} → ${intAfterTurn}; msg ${msgBefore} → ${msgAfter}`);
    const integrityA = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after agent usage", integrityA.ok, JSON.stringify(integrityA));

    // ---- integration credits (canonical P-9.2 tool path) + tool authorization ---------
    // One invoke, three steps: a GRANTED tool (executes, charges 1), an UNGRANTED tool
    // (refused by the server-side grant gate, never reaches the provider), then the reply.
    const intBefore = await intOf(A.ws.id);
    const imageBefore = calls.image;
    script = [
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "a cat" } } },
      { action: "tool", tool: { name: "Search", input: { entity: "note", query: "secret" } } },
      { action: "reply", content: "I drew it and cannot search." },
    ];
    const toolRun = await run(projA, userA, "invoke", { name: "artist", message: "draw a cat and find my notes" });
    const intAfter = await intOf(A.ws.id);
    harness.check("a granted tool call charges the canonical integration credit beside the turn's own per-message charge (P-9.11E)",
      toolRun.usage.tool_calls === 1 && toolRun.usage.integration_credits === 2 && intBefore - intAfter === 2 && calls.image - imageBefore === 1,
      JSON.stringify({ usage: toolRun.usage, delta: intBefore - intAfter, images: calls.image - imageBefore }));
    harness.check("tool authorization: an ungranted tool is refused and never reaches the provider",
      toolRun.reply === "I drew it and cannot search." && calls.image - imageBefore === 1 && toolRun.usage.tool_calls === 1,
      JSON.stringify({ reply: toolRun.reply, tool_calls: toolRun.usage.tool_calls, images: calls.image - imageBefore }));

    // ---- failed model run: no charge, no stranded hold -------------------------------
    const intBeforeFail = await intOf(A.ws.id);
    const convBeforeFail = (await run(projA, userA, "messages", { conversation_id: convId })).count;
    flags.llm_fail = true;
    const failed = await captureCall(() => run(projA, userA, "invoke", { name: "helper", message: "this will fail", conversation_id: convId }));
    flags.llm_fail = false;
    const intAfterFail = await intOf(A.ws.id);
    const balAfterFail = await deriveBalance(db, A.ws.id);
    const convAfterFail = (await run(projA, userA, "messages", { conversation_id: convId })).count;
    const lastSeen = seen[seen.length - 1] || { messages: [] };
    const sawHistory = JSON.stringify(lastSeen.messages).includes("Hello from the agent");
    harness.check("persisted conversation history feeds the model on the next turn of the same conversation",
      convAfterFail === convBeforeFail + 1 && sawHistory,
      `count=${convAfterFail} history_seen=${sawHistory}`);
    harness.check("a failed model run charges nothing and strands no hold",
      failed.threw && failed.code === "AGENT_MODEL_UNAVAILABLE" && intAfterFail === intBeforeFail && balAfterFail.reserved === 0 && convAfterFail === convBeforeFail + 1,
      JSON.stringify({ threw: failed.threw, code: failed.code, delta: intBeforeFail - intAfterFail, reserved: balAfterFail.reserved }));

    // ---- replay / idempotency ---------------------------------------------------------
    script = [{ action: "reply", content: "idempotent answer" }];
    const keyRun = await run(projA, userA, "invoke", { name: "helper", message: "once", idempotency_key: `p94-key-${stamp}` });
    const llmA = calls.llm;
    const replay = await run(projA, userA, "invoke", { name: "helper", message: "once", idempotency_key: `p94-key-${stamp}` });
    const convRows = (await run(projA, userA, "messages", { conversation_id: keyRun.conversation_id })).count;
    harness.check("replay: the same idempotency key returns the stored reply, charged once, no new rows",
      keyRun.reply === "idempotent answer" && replay.idempotent_replay === true && replay.message_id === keyRun.message_id && calls.llm === llmA && convRows === 2,
      JSON.stringify({ replay: replay.idempotent_replay, llm_delta: calls.llm - llmA, rows: convRows }));

    // ---- workspace isolation -----------------------------------------------------------
    const bMsg = await msgOf(B.ws.id);
    const bInt = await intOf(B.ws.id);
    harness.check("workspace isolation: another workspace's pools never move", bMsg === 200 && bInt === 20,
      JSON.stringify({ bMsg, bInt }));

    // ---- insufficient credits: fail-closed BEFORE the model call ----------------------
    const llmBefore = calls.llm;
    const broke = await captureCall(() => run(projC, userC, "invoke", { name: "helper", message: "hi" }));
    harness.check("insufficient integration credits refuse fail-closed before any model call (P-9.11E)",
      broke.threw && ["INSUFFICIENT_CREDITS", "BUDGET_EXCEEDED"].includes(broke.code) && calls.llm === llmBefore,
      JSON.stringify(broke));

    // ---- model access: a plan-restricted workspace is refused -------------------------
    const dMsgBefore = await msgOf(D.ws.id);
    const restricted = await captureCall(() => run(projD, userD, "invoke", { name: "helper", message: "hi" }));
    const dMsgAfter = await msgOf(D.ws.id);
    harness.check("model access: a plan that excludes the routed model is refused fail-closed",
      restricted.threw && dMsgAfter === dMsgBefore,
      JSON.stringify({ threw: restricted.threw, code: restricted.code, status: restricted.status, delta: dMsgBefore - dMsgAfter }));

    // ---- cross-user isolation -----------------------------------------------------------
    const cross = await captureCall(() => run(projA, userB, "messages", { conversation_id: convId }));
    harness.check("another end-user's conversation is indistinguishable from a missing one",
      cross.threw && cross.code === "CONVERSATION_NOT_FOUND", JSON.stringify(cross));

    return harnessResponse(harness);
  } catch (error) {
    // Summary-first error: failures (with details) are listed before the full results, so the
    // response stays readable even when it is truncated in transit.
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — a per-row purge loop would itself eat
    // the platform's per-invocation request budget. The name-pattern sweep also removes scratch
    // rows left behind by earlier interrupted runs of this suite.
    flags.llm_fail = false;
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p94-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p94[a-d]" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^agent(res)?[0-9]+$" } }).catch(() => {});
  }
}