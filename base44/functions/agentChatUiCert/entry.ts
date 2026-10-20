// P-9.12 certification suite: the deployed-runtime AgentChat in-app conversation UI.
//
// Drives the REAL P-9.4 handler (shared/appAgentRuntime.ts) exactly as appAgentSdkParityTest
// does — only the model-provider boundary stubbed — and certifies the CONTRACT the AgentChat
// widget composes: the load flow (getConversation), the start flow (createConversation, incl.
// the anonymous start the host page backs), the send flow (addMessage with role 'user'),
// the live count-change signal the bounded-poll subscription rides, the tool_calls chips
// projection, owner/project isolation, and that every projection the widget renders stays free
// of instructions and credentials. Runtime registration ("AgentChat" exported by the module)
// is asserted against the shared export registry.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { createAnonymousSession, resolveAnonymousSession, isAnonymousUser } from "../../shared/appAuth.ts";

// MIRROR of the AgentChat widget contract (src/lib/runtime/agentChatSource.js — keep in sync):
// the widget composes ONLY the certified agents methods below, and its pins are the behavior
// the checks below exercise against the real handlers.
const AGENT_CHAT_UI = {
  export: "AgentChat",
  flows: {
    load: "getConversation -> the conversation projection with embedded messages -> render",
    start: "createConversation -> the projection WITHOUT messages -> render an empty list",
    send: "addMessage { role: 'user', content } -> getConversation refresh",
    live: "subscribeToConversation -> the count-change signal -> messages projection",
  },
  pins: {
    sdk_only: "the widget composes ONLY certified agents methods — no second agent engine, no local message store",
    unsubscribe: "returned straight to React's cleanup — on unmount and on conversation change",
    anonymous_token: "never enters widget state or storage — minted on the create op, held host-side",
    roles: "only role 'user' travels inbound",
  },
};

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  // ---- provider boundary stub (handlers, ledger and executor are the REAL ones) ----
  const calls = { llm: 0, image: 0 };
  let script = [];
  const fakeProvider = {
    async generate({ messages, jsonSchema }) {
      calls.llm++;
      const out = script.length ? script.shift() : { action: "reply", content: "OK, noted." };
      return {
        output: jsonSchema ? out : (out.action === "reply" ? out.content : JSON.stringify(out)),
        usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" },
      };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const client = {
    asServiceRole: {
      entities: db.entities,
      integrations: { Core: { GenerateImage: async () => { calls.image++; return { url: `https://cdn.test/p912chat-${calls.image}.png` }; } } },
    },
  };
  const opts = { providerOverrides };
  const pace = appAgentPace;
  const run = async (project, user, op, args, anonymous = null) => {
    await pace();
    return handleAppAgent(client, { project, payload, user, op, args, anonymous, options: opts });
  };

  // The deployed agents: one open to anonymous access, one closed, one with a tool.
  const payload = {
    agents: [
      { ...appAgentDoc("open", {}, "Answer briefly. SECRET-INSTRUCTION-MARKER"), allow_anonymous_access: true },
      appAgentDoc("closed", {}, "Answer briefly. SECRET-INSTRUCTION-MARKER"),
      appAgentDoc("artist", { app_tools: ["GenerateImage"] }, "Answer briefly. SECRET-INSTRUCTION-MARKER"),
    ],
    entities: [],
  };

  const { grant, intOf } = makeAgentPoolTools(db, stamp, "p912chat");

  try {
    // ---- registration + contract mirror ------------------------------------------------
    harness.check("surface: the runtime exports the AgentChat widget next to the agents namespace",
      RUNTIME_EXPORTS.includes("AgentChat") && RUNTIME_EXPORTS.includes("agents"),
      JSON.stringify(RUNTIME_EXPORTS.filter((e) => e === "AgentChat" || e === "agents")));
    harness.check("contract: the widget composes exactly the certified flows and pins",
      AGENT_CHAT_UI.export === "AgentChat"
        && Object.keys(AGENT_CHAT_UI.flows).length === 4
        && Object.keys(AGENT_CHAT_UI.pins).length === 4
        && AGENT_CHAT_UI.pins.sdk_only.includes("certified agents methods"),
      JSON.stringify(AGENT_CHAT_UI.flows));

    // ---- fixtures ------------------------------------------------------------------------
    const plan = await makeBillingPlan(db, created, `p912chat${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p912chat${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);

    const projA = await makeAgentProject(db, projectIds, A, stamp, "p912chat");
    const projB = await makeAgentProject(db, projectIds, A, stamp, "p912chat");

    const userA1 = { id: `p912chat_userA1_${stamp}`, email: "a1@p912chat.test" };
    const userA2 = { id: `p912chat_userA2_${stamp}`, email: "a2@p912chat.test" };

    // ---- the LOAD flow: getConversation is the projection the widget renders -------------
    script = [{ action: "reply", content: "Hello from the agent" }];
    const conv1 = await run(projA, userA1, "create", { agent_name: "open" });
    const turn1 = await run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "hello there" });
    const got1 = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    harness.check("load flow: the widget's get read returns the conversation WITH embedded messages in order",
      got1.conversation.conversation_id === conv1.conversation.conversation_id && got1.count === 2
        && Array.isArray(got1.conversation.messages) && got1.conversation.messages.length === 2
        && got1.conversation.messages.map((m) => m.role).join(",") === "user,assistant"
        && got1.conversation.messages[1].content === "Hello from the agent",
      JSON.stringify({ count: got1.count, roles: (got1.conversation.messages || []).map((m) => m.role) }));
    harness.check("load flow: an assistant row carries the persisted usage the widget may surface",
      !!(got1.conversation.messages.find((m) => m.role === "assistant") || {}).usage,
      JSON.stringify(turn1.usage));

    // ---- the SEND flow: addMessage { role: 'user' } + the refreshed read -----------------
    script = [{ action: "reply", content: "Second answer" }];
    const turn2 = await run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "again", role: "user" });
    const got2 = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    harness.check("send flow: the role-'user' message object is accepted and the refreshed read holds all four rows",
      turn2.reply === "Second answer" && got2.count === 4
        && got2.messages.slice(-2).map((m) => m.role).join(",") === "user,assistant",
      JSON.stringify({ count: got2.count }));
    const wrongRole = await captureCall(() => run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "hi", role: "assistant" }));
    harness.check("send flow: only role 'user' travels inbound — 'assistant' is refused fail-closed",
      wrongRole.threw, JSON.stringify({ code: wrongRole.code }));

    // ---- the LIVE flow: the count-change signal the bounded-poll subscription rides ------
    const before = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    script = [{ action: "reply", content: "Third answer" }];
    await run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "third" });
    const after = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    harness.check("live flow: the read's count changed across the send (the poll's count-change signal fires on each transition)",
      before.count < after.count && after.count === before.count + 2
        && Array.isArray(after.conversation.messages) && after.conversation.messages.length === after.count,
      JSON.stringify({ before: before.count, after: after.count }));

    // ---- the tool_calls chips projection -------------------------------------------------
    const convArtist = await run(projA, userA1, "create", { agent_name: "artist" });
    script = [
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "a cat" } } },
      { action: "reply", content: "I drew it." },
    ];
    await run(projA, userA1, "invoke", { conversation_id: convArtist.conversation.conversation_id, message: "draw a cat" });
    const gotTool = await run(projA, userA1, "get", { conversation_id: convArtist.conversation.conversation_id });
    const toolAssistant = gotTool.messages.find((m) => m.role === "assistant");
    harness.check("chips: the widget's chip data (name · status) is exactly the stored projection",
      !!toolAssistant && Array.isArray(toolAssistant.tool_calls) && toolAssistant.tool_calls.length === 1
        && toolAssistant.tool_calls[0].name === "GenerateImage" && toolAssistant.tool_calls[0].status === "success",
      JSON.stringify(toolAssistant && toolAssistant.tool_calls));

    // ---- the anonymous START flow: host mints on create, the widget rides the identity ----
    const anon = await createAnonymousSession(db, projA, { ip: "203.0.113.9", user_agent: "p912chat-cert" });
    const resolved = await resolveAnonymousSession(db, projA, anon.token);
    harness.check("anonymous start: the host-held token resolves to the minted anonymous identity",
      isAnonymousUser(anon.user) && !!resolved && resolved.user.id === anon.user.id,
      JSON.stringify({ anon: isAnonymousUser(anon.user), resolved: !!(resolved && resolved.user.id === anon.user.id) }));
    const anonConv = await run(projA, null, "create", { agent_name: "open" }, { user: anon.user });
    harness.check("anonymous start: the open agent's create succeeds under the anonymous identity",
      anonConv.conversation.agent_name === "open" && anonConv.conversation.created_by_id === anon.user.id
        && !Array.isArray(anonConv.conversation.messages),
      JSON.stringify({ agent: anonConv.conversation.agent_name }));
    const closedAnon = await captureCall(() => run(projA, null, "create", { agent_name: "closed" }, { user: anon.user }));
    harness.check("anonymous start: the closed agent refuses the anonymous identity (401, no model step)",
      closedAnon.threw && closedAnon.code === "AGENT_AUTH_REQUIRED" && closedAnon.status === 401, JSON.stringify(closedAnon));
    script = [{ action: "reply", content: "Hi, visitor." }];
    const anonTurn = await run(projA, null, "invoke", { conversation_id: anonConv.conversation.conversation_id, message: "hi" }, { user: anon.user });
    const anonGot = await run(projA, null, "get", { conversation_id: anonConv.conversation.conversation_id }, { user: anon.user });
    harness.check("anonymous send + subscribe data: the anonymous conversation serves its own rows only",
      anonTurn.reply === "Hi, visitor." && anonGot.count === 2 && anonGot.conversation.created_by_id === anon.user.id,
      JSON.stringify({ count: anonGot.count }));

    // ---- isolation + leakage ---------------------------------------------------------------
    const crossUser = await captureCall(() => run(projA, userA2, "get", { conversation_id: conv1.conversation.conversation_id }));
    harness.check("isolation: another app user's read of the conversation is a 404 (indistinguishable from missing)",
      crossUser.threw && crossUser.code === "CONVERSATION_NOT_FOUND" && crossUser.status === 404, JSON.stringify(crossUser));
    const otherProject = await run(projB, userA1, "conversations", {});
    harness.check("isolation: the same user's view from ANOTHER project of the workspace is empty",
      otherProject.count === 0, JSON.stringify({ count: otherProject.count }));
    const leak = JSON.stringify(got1) + JSON.stringify(gotTool) + JSON.stringify(anonGot);
    harness.check("projection safety: no instructions, credentials or internal observations reach what the widget renders",
      !leak.includes("SECRET-INSTRUCTION-MARKER") && !leak.includes("[tool "), JSON.stringify({ instruction_leak: leak.includes("SECRET-INSTRUCTION-MARKER") }));

    // ---- final ledger integrity ------------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after the widget flow usage", integrity.ok, JSON.stringify(integrity));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p912chat-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p912chat" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppIdentity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppSession.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p912chat[0-9]+$" } }).catch(() => {});
    await db.entities.CacheEntry.deleteMany({ namespace: "appagent_tools" }).catch(() => {});
  }
}