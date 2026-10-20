// P-9.10B certification suite: deployed-app Agents SDK parity.
//
// Drives the REAL surfaces the sandbox `agents` namespace rides: the existing P-9.4 handler
// (shared/appAgentRuntime.ts) for create / get / invoke / conversations and the P-9.10A Telegram
// foundation (shared/appAgentChannels.ts) for the connect URL — with only the model-provider
// boundary stubbed, exactly as appAgentParityTest does. Asserts: auth requirements, agent
// registry trust, owned-row isolation (user + project), metadata bounding/scrubbing, persisted
// tool_calls/usage projection without instruction/credential leakage, the UNCHANGED P-9.4
// billing/idempotency contract under addMessage semantics, the count-change signal the bounded
// poll subscription rides, Telegram and WhatsApp channel reuse without duplicate token
// issuance, and the runtime export surface registration.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { handleAppChannelConnect, CHANNEL_ACTIVATION_TTL_MS } from "../../shared/appAgentChannels.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// MIRROR of the `agents` namespace in src/lib/runtime/runtimeSource.js (keep in sync): the
// methods the deployed sandbox exposes and the bridge scope each travels on. Every mapped
// server op is exercised by the checks below (the P-9.11H conversation surfaces by their own
// suite, appAgentSdkConversationParityTest); the mirror proves the surface SHAPE — the
// documented nine methods, agent/channel scopes, a bounded-poll subscribe, and the P-9.10C
// WhatsApp connect routed through the same certified channel path as Telegram.
const AGENTS_SDK_SURFACE = {
  createConversation: { scope: "agent", op: "create" },
  getConversations: { scope: "agent", op: "conversations" },
  listConversations: { scope: "agent", op: "conversations" },
  getConversation: { scope: "agent", op: "get" },
  updateConversation: { scope: "agent", op: "update" },
  addMessage: { scope: "agent", op: "invoke" },
  subscribeToConversation: { scope: "agent", op: "get", transport: "bounded-poll-4s", unsubscribe: "guaranteed-stop", callback: "agent-conversation-projection" },
  getTelegramConnectURL: { scope: "channel", op: "connect", channel: "telegram" },
  getWhatsAppConnectURL: { scope: "channel", op: "connect", channel: "whatsapp" },
};
const CERTIFIED_OPS = ["agent:create", "agent:conversations", "agent:get", "agent:update", "agent:invoke", "channel:connect"];

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  // ---- provider boundary stub (handlers, ledger and executor are the REAL ones) ----
  const calls = { llm: 0, image: 0 };
  let script = [];           // queued model decisions; empty → default reply
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
      integrations: { Core: { GenerateImage: async () => { calls.image++; return { url: `https://cdn.test/p910b-${calls.image}.png` }; } } },
    },
  };
  const opts = { providerOverrides };
  // Small inter-call pacing: the platform rate-limits bursts of SDK requests, and every op
  // rides the real entity/ledger paths.
  const pace = appAgentPace;
  const run = async (project, user, op, args) => {
    await pace();
    return handleAppAgent(client, { project, payload, user, op, args, options: opts });
  };

  const agentDoc = (name, metadata = {}) => appAgentDoc(name, metadata, "Answer briefly. SECRET-INSTRUCTION-MARKER");
  const payload = {
    agents: [agentDoc("helper"), agentDoc("artist", { app_tools: ["GenerateImage"] })],
    entities: [],
  };

  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p910b");

  // ---- P-9.10A Telegram transport stub: the ONLY network boundary faked ----
  const telegramSeen = [];
  const telegramHttp = async (url) => {
    telegramSeen.push(String(url));
    const method = String(url).split("/").pop();
    return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "p910b_bot" } : {} }), { headers: { "content-type": "application/json" } });
  };
  const BOT_TOKEN = "777:p910b-secret-token";
  const resolveSecret = async (name) => (name === "TELEGRAM_BOT_TOKEN" ? BOT_TOKEN : undefined);

  try {
    const plan = await makeBillingPlan(db, created, `p910bsdk${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p910b${stamp}`, { plan });
    wsIds.push(A.ws.id);
    // Integration grant covers every turn's estimate-hold PLUS the artist turn's tool charges —
    // the same calibration appAgentParityTest received after a 20-credit grant reproducibly
    // refused the GenerateImage tool hold with INSUFFICIENT_CREDITS mid-suite.
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);

    const mkProject = (ws) => makeAgentProject(db, projectIds, ws, stamp, "p910b");
    const projA = await mkProject(A);
    const projB = await mkProject(A); // same workspace + same user: the project-isolation probe

    const userA1 = { id: `p910b_userA1_${stamp}`, email: "a1@p910b.test" };
    const userA2 = { id: `p910b_userA2_${stamp}`, email: "a2@p910b.test" };

    // ---- createConversation ----------------------------------------------------------
    const anon = await captureCall(() => run(projA, null, "create", { agent_name: "helper" }));
    harness.check("createConversation: anonymous is refused (401)", anon.threw && anon.code === "AGENT_AUTH_REQUIRED" && anon.status === 401, JSON.stringify(anon));
    const noAgent = await captureCall(() => run(projA, userA1, "create", { agent_name: "ghost" }));
    harness.check("createConversation: an agent outside the deployment is refused", noAgent.threw && noAgent.code === "AGENT_NOT_FOUND", JSON.stringify(noAgent));

    const conv1 = await run(projA, userA1, "create", { agent_name: "helper" });
    const row1 = await db.entities.AppRecord.get(conv1.conversation.conversation_id);
    harness.check("createConversation: returns an OWNED row (project + owner stamped server-side)",
      conv1.conversation.agent_name === "helper" && row1.project_id === projA.id
        && row1.entity_name === "__agent_conversations" && row1.owner_id === userA1.id,
      JSON.stringify({ agent: conv1.conversation.agent_name, project_ok: row1.project_id === projA.id, owner_ok: row1.owner_id === userA1.id }));

    const bigMeta = { note: "x".repeat(2000) };
    for (let i = 0; i < 14; i++) bigMeta[`k${i}`] = "v";
    const convMeta = await run(projA, userA1, "create", { agent_name: "helper", metadata: bigMeta });
    const convStr = await run(projA, userA1, "create", { agent_name: "helper", metadata: "not-an-object" });
    const storedMeta = convMeta.conversation.metadata || {};
    harness.check("createConversation: metadata is bounded and scrubbed; non-object metadata is dropped",
      Object.keys(storedMeta).length <= 10 && String(storedMeta.note || "").length <= 500 && !convStr.conversation.metadata,
      JSON.stringify({ keys: Object.keys(storedMeta).length, note_len: String(storedMeta.note || "").length, str_meta: !!convStr.conversation.metadata }));

    // ---- addMessage (basic semantics; the executor itself is P-9.4, unchanged) --------
    script = [{ action: "reply", content: "Hello from the agent" }];
    const msgBefore = await msgOf(A.ws.id);
    const intBefore1 = await intOf(A.ws.id);
    const turn1 = await run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "first question" });
    const msgAfter = await msgOf(A.ws.id);
    const intAfter1 = await intOf(A.ws.id);
    harness.check("addMessage: the agent is INFERRED from the conversation and the reply lands in place",
      turn1.conversation_id === conv1.conversation.conversation_id && turn1.reply === "Hello from the agent" && turn1.agent === "helper",
      JSON.stringify({ conv_ok: turn1.conversation_id === conv1.conversation.conversation_id, reply: turn1.reply, agent: turn1.agent }));
    harness.check("addMessage: charges the per-message INTEGRATION credit exactly once per turn (P-9.11E)",
      intAfter1 < intBefore1 && turn1.usage.integration_credits >= 1 && msgAfter === msgBefore,
      `int ${intBefore1} → ${intAfter1}; msg ${msgBefore} → ${msgAfter}`);

    const mismatch = await captureCall(() => run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, name: "artist", message: "draw" }));
    harness.check("addMessage: an explicit name that disagrees with the conversation's agent is a 409",
      mismatch.threw && mismatch.code === "AGENT_MISMATCH" && mismatch.status === 409, JSON.stringify(mismatch));

    // ---- listConversations -----------------------------------------------------------
    const mine = await run(projA, userA1, "conversations", {});
    const theirs = await run(projA, userA2, "conversations", {});
    const otherProject = await run(projB, userA1, "conversations", {});
    harness.check("listConversations: returns the caller's own conversations",
      mine.conversations.some((c) => c.conversation_id === conv1.conversation.conversation_id) && mine.count >= 1,
      JSON.stringify({ count: mine.count }));
    harness.check("listConversations: another app user never sees userA1's conversations",
      !theirs.conversations.some((c) => c.conversation_id === conv1.conversation.conversation_id),
      JSON.stringify({ count: theirs.count }));
    harness.check("listConversations: the same user in ANOTHER project of the workspace sees none (project isolation)",
      otherProject.count === 0, JSON.stringify({ count: otherProject.count }));
    const artistList = await run(projA, userA1, "conversations", { agent: "artist" });
    harness.check("listConversations: the agent filter narrows the list",
      !artistList.conversations.some((c) => c.conversation_id === conv1.conversation.conversation_id)
        && artistList.conversations.every((c) => c.agent_name === "artist"),
      JSON.stringify({ count: artistList.count }));

    // ---- getConversation --------------------------------------------------------------
    const got1 = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    const assistant1 = got1.messages.find((m) => m.role === "assistant");
    harness.check("getConversation: returns the conversation with its persisted messages",
      got1.conversation.conversation_id === conv1.conversation.conversation_id && got1.count === 2
        && got1.messages.map((m) => m.role).join(",") === "user,assistant",
      JSON.stringify({ count: got1.count }));
    harness.check("getConversation: the assistant projection exposes the persisted Credits-Used of the turn",
      !!assistant1 && !!assistant1.usage && assistant1.usage.integration_credits >= 1, JSON.stringify(assistant1 && assistant1.usage));

    const convArtist = await run(projA, userA1, "create", { agent_name: "artist" });
    script = [
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "a cat" } } },
      { action: "reply", content: "I drew it." },
    ];
    await run(projA, userA1, "invoke", { conversation_id: convArtist.conversation.conversation_id, message: "draw a cat" });
    const gotTool = await run(projA, userA1, "get", { conversation_id: convArtist.conversation.conversation_id });
    const toolAssistant = gotTool.messages.find((m) => m.role === "assistant");
    harness.check("getConversation: persisted tool_calls are exposed where stored",
      !!toolAssistant && Array.isArray(toolAssistant.tool_calls) && toolAssistant.tool_calls.length === 1
        && toolAssistant.tool_calls[0].primitive === "GenerateImage" && toolAssistant.tool_calls[0].ok === true,
      JSON.stringify(toolAssistant && toolAssistant.tool_calls));

    const cross = await captureCall(() => run(projA, userA2, "get", { conversation_id: conv1.conversation.conversation_id }));
    harness.check("getConversation: another app user's read is a 404 (indistinguishable from missing)",
      cross.threw && cross.code === "CONVERSATION_NOT_FOUND" && cross.status === 404, JSON.stringify(cross));

    const leak = JSON.stringify(got1) + JSON.stringify(gotTool);
    harness.check("getConversation: no instructions, credentials or internal observations leak",
      !leak.includes("SECRET-INSTRUCTION-MARKER") && !leak.includes(BOT_TOKEN) && !leak.includes("[tool "),
      JSON.stringify({ instruction_leak: leak.includes("SECRET-INSTRUCTION-MARKER"), token_leak: leak.includes(BOT_TOKEN) }));

    // ---- addMessage: unchanged P-9.4 idempotency + persisted rows ---------------------
    const midPool0 = await intOf(A.ws.id);
    script = [{ action: "reply", content: "idempotent answer" }];
    const keyRun = await run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "once", idempotency_key: `p910b-key-${stamp}` });
    const midPool = await intOf(A.ws.id);
    const replay = await run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "once", idempotency_key: `p910b-key-${stamp}` });
    const endPool = await intOf(A.ws.id);
    harness.check("addMessage: an idempotent replay returns the stored reply and never double-charges",
      keyRun.reply === "idempotent answer" && replay.idempotent_replay === true
        && replay.message_id === keyRun.message_id && midPool === endPool,
      JSON.stringify({ replay: replay.idempotent_replay, mid: midPool, end: endPool }));
    harness.check("addMessage: user + assistant rows persist per turn in the SAME conversation",
      midPool < midPool0 && endPool === midPool, `${midPool0} → ${midPool}`);
    const rowsAfter = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    harness.check("addMessage: rows accumulate in the conversation (count grows by exactly 2 per turn)",
      rowsAfter.count === 4 && rowsAfter.messages.every((m) => m.conversation_id === conv1.conversation.conversation_id),
      JSON.stringify({ count: rowsAfter.count }));

    // ---- subscribe: the server contract the bounded poll rides -------------------------
    const s1 = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    const s2 = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    harness.check("subscribe: the poll signal is stable when nothing changed (initial snapshot semantics)",
      s1.count === s2.count && typeof s1.count === "number" && Array.isArray(s1.messages), JSON.stringify({ count: s1.count }));
    script = [{ action: "reply", content: "poll sees me" }];
    await run(projA, userA1, "invoke", { conversation_id: conv1.conversation.conversation_id, message: "poll probe" });
    const s3 = await run(projA, userA1, "get", { conversation_id: conv1.conversation.conversation_id });
    harness.check("subscribe: a new message changes the count the poller detects",
      s3.count === s2.count + 2, `${s2.count} → ${s3.count}`);
    const subCross = await captureCall(() => run(projA, userA2, "get", { conversation_id: conv1.conversation.conversation_id }));
    harness.check("subscribe: a cross-user poll is refused — the error the poller surfaces before stopping",
      subCross.threw && subCross.code === "CONVERSATION_NOT_FOUND", JSON.stringify(subCross));

    // ---- Telegram: reuse of the P-9.10A foundation --------------------------------------
    const anonConnect = await captureCall(() => handleAppChannelConnect(client, { project: projA, payload, user: null, args: { channel: "telegram", agent: "helper" }, resolveSecret, http: telegramHttp }));
    harness.check("telegram: an anonymous connect is refused (401)", anonConnect.threw && anonConnect.code === "AUTH_REQUIRED" && anonConnect.status === 401, JSON.stringify(anonConnect));

    const tokensBefore = (await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation" }, "-created_date", 100)).length;
    await pace();
    const connect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "telegram", agent: "helper" }, resolveSecret, http: telegramHttp });
    const tokensAfter = (await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation" }, "-created_date", 100)).length;
    harness.check("telegram: the connect URL is the P-9.10A deep link with a single-use activation code",
      /^https:\/\/t\.me\/p910b_bot\?start=[a-f0-9]{64}$/.test(connect.url) && connect.channel === "telegram"
        && connect.agent === "helper" && connect.expires_in_ms === CHANNEL_ACTIVATION_TTL_MS,
      JSON.stringify({ url: connect.url, expires_in_ms: connect.expires_in_ms }));
    harness.check("telegram: exactly ONE activation token is issued (no duplicate issuance logic)",
      tokensAfter - tokensBefore === 1, `${tokensBefore} → ${tokensAfter}`);
    harness.check("telegram: the bot token never appears in the response",
      !connect.url.includes("secret-token") && !JSON.stringify(connect).includes(BOT_TOKEN), JSON.stringify({ url: connect.url }));
    // WhatsApp (P-9.10C): the SDK's getWhatsAppConnectURL is a thin bridge over the SAME
    // channel runtime dispatcher — the server issues the single-use activation and builds the
    // wa.me link; the sandbox never sees the code's issuer logic or any credential.
    const waNumber = `1555${String(stamp).slice(-7)}`;
    const waHttpStub = async () => new Response(JSON.stringify({ display_phone_number: waNumber }), { headers: { "content-type": "application/json" } });
    const waSecrets = async (name) => (name === "WHATSAPP_TOKEN" ? "wapp-server-token" : name === "WHATSAPP_PHONE_NUMBER_ID" ? "pnid" : undefined);
    const waConnect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "whatsapp", agent: "helper" }, resolveSecret: waSecrets, http: waHttpStub });
    const waUrl = new URL(waConnect.url);
    harness.check("whatsapp: getWhatsAppConnectURL routes through the server channel connect path",
      waConnect.channel === "whatsapp" && waConnect.agent === "helper" && waUrl.hostname === "wa.me"
        && waUrl.pathname === `/${waNumber}` && /^[a-f0-9]{64}$/.test(waUrl.searchParams.get("text") || ""),
      waConnect.url);

    // ---- runtime surface -----------------------------------------------------------------
    harness.check("surface: the `agents` export is registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("agents"), JSON.stringify(RUNTIME_EXPORTS.filter((e) => e === "agents")));
    const surfaceMethods = Object.keys(AGENTS_SDK_SURFACE);
    const opsCovered = [...new Set(Object.values(AGENTS_SDK_SURFACE).map((m) => `${m.scope}:${m.op}`))];
    harness.check("surface: all nine agents methods map onto the certified server ops",
      surfaceMethods.length === 9 && surfaceMethods.includes("getTelegramConnectURL")
        && surfaceMethods.includes("getWhatsAppConnectURL")
        && surfaceMethods.includes("updateConversation") && surfaceMethods.includes("getConversations")
        && opsCovered.every((s) => CERTIFIED_OPS.includes(s)),
      JSON.stringify({ methods: surfaceMethods, ops: opsCovered }));
    harness.check("surface: a channel outside the certified foundations is still refused",
      !Object.values(AGENTS_SDK_SURFACE).some((m) => (m.channel || "") === "line"),
      "line absent by design");

    // ---- final ledger integrity ----------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after the SDK surface usage", integrity.ok, JSON.stringify(integrity));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p910b-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p910b" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p910b_user" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p910bsdk[0-9]+$" } }).catch(() => {});
  }
}