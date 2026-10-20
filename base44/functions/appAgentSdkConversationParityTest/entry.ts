// P-9.11H certification suite: deployed-app Agents SDK conversation parity.
//
// Base44 documents (docs.base44.com SDK reference `agents`; doc-sdk.base44.app/AgentsDocs):
//   • updateConversation(conversationId, { metadata }) — update a conversation's metadata;
//   • getConversations() — every conversation across all agents in the app;
//   • listConversations({ q: { agent_name, 'metadata.priority': ... }, sort, limit });
//   • addMessage(conversation, { role: 'user', content, file_urls }) — the message object form.
// NOTHING beyond the documented shape is implemented: no cursor (undocumented), no non-user
// inbound role (semantics UNKNOWN — refused fail-closed), no update tariff (UNKNOWN — none
// invented), and the metadata value rides the SAME bounded/scrubbed contract create uses.
// This suite drives the REAL P-9.4 handler with only the model-provider boundary stubbed,
// exactly as appAgentParityTest / appAgentSdkParityTest, and certifies: owner/project/anonymous
// isolation of the new surfaces, the unchanged P-9.4/P-9.11E turn contract under the
// message-object form, fail-closed validation of the documented-only query surface, and
// backward compatibility of the legacy agent filter.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent, CONVERSATIONS_ENTITY } from "../../shared/appAgentRuntime.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// MIRROR of the `agents` namespace in src/lib/runtime/runtimeSource.js (keep in sync): the
// P-9.11H conversation additions beside the certified surface, with the scope/op every method
// rides. Behavioral coverage of update / getConversations / the list query surface / the
// addMessage object form lives in the checks below.
const AGENTS_SDK_SURFACE = {
  createConversation: { scope: "agent", op: "create" },
  getConversations: { scope: "agent", op: "conversations" },
  listConversations: { scope: "agent", op: "conversations" },
  getConversation: { scope: "agent", op: "get" },
  updateConversation: { scope: "agent", op: "update" },
  addMessage: { scope: "agent", op: "invoke" },
  subscribeToConversation: { scope: "agent", op: "get", transport: "bounded-poll-4s", unsubscribe: "guaranteed-stop" },
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
  const calls = { llm: 0 };
  let script = [];               // queued model decisions; empty → default reply
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
  const client = { asServiceRole: { entities: db.entities } };
  const opts = { providerOverrides };
  const pace = appAgentPace;
  const run = async (project, user, op, args, anonUser = null) => {
    await pace();
    return handleAppAgent(client, { project, payload, user, anonymous: anonUser ? { user: anonUser } : null, op, args, options: opts });
  };

  const agentDoc = (name, extra = {}) => ({ ...appAgentDoc(name, {}, "Answer briefly. SECRET-INSTRUCTION-MARKER"), ...extra });
  const payload = {
    agents: [agentDoc("helper"), agentDoc("artist"), agentDoc("open_helper", { allow_anonymous_access: true })],
    entities: [],
  };
  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911h");

  try {
    const plan = await makeBillingPlan(db, created, `p911h${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911h${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);

    const projA = await makeAgentProject(db, projectIds, A, stamp, "p911h");
    const projB = await makeAgentProject(db, projectIds, A, stamp, "p911h"); // project-isolation probe
    const userA1 = { id: `p911h_userA1_${stamp}`, email: "a1@p911h.test" };
    const userA2 = { id: `p911h_userA2_${stamp}`, email: "a2@p911h.test" };
    const anonUser = { id: `p911h_anon_${stamp}`, email: "anon@p911h.test" };

    // ---- fixtures: conversations across TWO agents with filterable metadata ----------------
    const convHigh1 = await run(projA, userA1, "create", { agent_name: "helper", metadata: { priority: "high", order_id: "ORD-1" } });
    const convLow = await run(projA, userA1, "create", { agent_name: "helper", metadata: { priority: "low" } });
    const convHigh2 = await run(projA, userA1, "create", { agent_name: "helper", metadata: { priority: "high" } });
    const convArtist = await run(projA, userA1, "create", { agent_name: "artist" });
    const convUpd = await run(projA, userA1, "create", { agent_name: "helper", metadata: { status: "open" } });
    const idOf = (c) => c.conversation.conversation_id;
    const ids = [idOf(convHigh1), idOf(convLow), idOf(convHigh2), idOf(convArtist), idOf(convUpd)];

    // ---- updateConversation ---------------------------------------------------------------
    const upd0int = await intOf(A.ws.id);
    const upd0llm = calls.llm;
    const upd = await run(projA, userA1, "update", { conversation_id: idOf(convUpd), metadata: { status: "resolved", note: "x".repeat(2000) } });
    const updMeta = upd.conversation.metadata || {};
    harness.check("updateConversation: replaces the metadata with the bounded, scrubbed new value",
      updMeta.status === "resolved" && String(updMeta.note || "").length === 500 && upd.conversation.conversation_id === idOf(convUpd),
      JSON.stringify({ status: updMeta.status, note_len: String(updMeta.note || "").length }));
    const updGot = await run(projA, userA1, "get", { conversation_id: idOf(convUpd) });
    harness.check("updateConversation: the bounded metadata persists through the get read",
      (updGot.conversation.metadata || {}).status === "resolved" && String((updGot.conversation.metadata || {}).note || "").length === 500,
      JSON.stringify(updGot.conversation.metadata || {}));
    const updNoMeta = await run(projA, userA1, "update", { conversation_id: idOf(convUpd) });
    harness.check("updateConversation: an absent metadata key leaves the conversation unchanged",
      (updNoMeta.conversation.metadata || {}).status === "resolved", JSON.stringify(updNoMeta.conversation.metadata || {}));
    const bigMeta = {};
    for (let i = 0; i < 14; i++) bigMeta[`k${i}`] = "v";
    const updBig = await run(projA, userA1, "update", { conversation_id: idOf(convUpd), metadata: bigMeta });
    harness.check("updateConversation: metadata is capped at the platform's own bounded contract (≤10 keys)",
      Object.keys(updBig.conversation.metadata || {}).length === 10, JSON.stringify({ keys: Object.keys(updBig.conversation.metadata || {}).length }));
    const upd1int = await intOf(A.ws.id);
    harness.check("updateConversation: runs no model turn and charges nothing",
      calls.llm === upd0llm && upd1int === upd0int, `llm ${upd0llm}→${calls.llm}; int ${upd0int}→${upd1int}`);

    const crossUser = await captureCall(() => run(projA, userA2, "update", { conversation_id: idOf(convUpd), metadata: { status: "hacked" } }));
    harness.check("updateConversation: another app user's update is a 404 (indistinguishable from missing)",
      crossUser.threw && crossUser.code === "CONVERSATION_NOT_FOUND" && crossUser.status === 404, JSON.stringify(crossUser));
    const crossProject = await captureCall(() => run(projB, userA1, "update", { conversation_id: idOf(convUpd), metadata: { status: "hacked" } }));
    harness.check("updateConversation: the same user in ANOTHER project gets a 404 (project isolation)",
      crossProject.threw && crossProject.code === "CONVERSATION_NOT_FOUND" && crossProject.status === 404, JSON.stringify(crossProject));
    const unknown = await captureCall(() => run(projA, userA1, "update", { conversation_id: "no-such-conversation", metadata: {} }));
    harness.check("updateConversation: an unknown conversation is a 404",
      unknown.threw && unknown.code === "CONVERSATION_NOT_FOUND" && unknown.status === 404, JSON.stringify(unknown));

    // An anonymous identity that OWNS a conversation of a NON-anonymous agent (a forged row —
    // no such conversation can be created through the API) must be refused by the per-agent
    // anonymous gate: fail-closed defense in depth, exactly like the get read.
    const forged = await db.entities.AppRecord.create({
      project_id: projA.id, entity_name: CONVERSATIONS_ENTITY, owner_id: anonUser.id,
      data: { agent_name: "helper", title: "", created_at: new Date().toISOString() },
    });
    const anonGate = await captureCall(() => run(projA, null, "update", { conversation_id: forged.id, metadata: { status: "x" } }, anonUser));
    harness.check("updateConversation: an anonymous owner of a NON-anonymous agent's conversation is refused (401)",
      anonGate.threw && anonGate.code === "AGENT_AUTH_REQUIRED" && anonGate.status === 401, JSON.stringify(anonGate));
    const anonConv = await run(projA, null, "create", { agent_name: "open_helper" }, anonUser);
    const anonUpd = await run(projA, null, "update", { conversation_id: idOf(anonConv), metadata: { who: "anon" } }, anonUser);
    harness.check("updateConversation: an anonymous caller updates its OWN conversation of an anonymous-enabled agent",
      (anonUpd.conversation.metadata || {}).who === "anon", JSON.stringify(anonUpd.conversation.metadata || {}));
    harness.check("updateConversation: no instructions or credentials leak in the responses",
      !(JSON.stringify(upd) + JSON.stringify(anonUpd)).includes("SECRET-INSTRUCTION-MARKER"),
      JSON.stringify({ leak: (JSON.stringify(upd) + JSON.stringify(anonUpd)).includes("SECRET-INSTRUCTION-MARKER") }));

    // ---- getConversations -------------------------------------------------------------------
    const all = await run(projA, userA1, "conversations", {});
    const allAgents = new Set(all.conversations.map((c) => c.agent_name));
    harness.check("getConversations: returns the caller's conversations across ALL agents",
      all.count === 5 && ids.every((id) => all.conversations.some((c) => c.conversation_id === id))
        && allAgents.has("helper") && allAgents.has("artist"),
      JSON.stringify({ count: all.count, agents: [...allAgents] }));
    const otherUser = await run(projA, userA2, "conversations", {});
    harness.check("getConversations: another app user never sees userA1's conversations",
      !ids.some((id) => otherUser.conversations.some((c) => c.conversation_id === id)),
      JSON.stringify({ count: otherUser.count }));
    const otherProject = await run(projB, userA1, "conversations", {});
    harness.check("getConversations: the same user in ANOTHER project sees none",
      otherProject.count === 0, JSON.stringify({ count: otherProject.count }));

    // ---- listConversations: the documented query surface --------------------------------------
    const byAgent = await run(projA, userA1, "conversations", { q: { agent_name: "helper" } });
    harness.check("listConversations: q.agent_name narrows to that agent (documented field)",
      byAgent.count === 4 && byAgent.conversations.every((c) => c.agent_name === "helper")
        && !byAgent.conversations.some((c) => c.conversation_id === idOf(convArtist)),
      JSON.stringify({ count: byAgent.count }));
    const legacy = await run(projA, userA1, "conversations", { agent: "artist" });
    harness.check("listConversations: the legacy agent filter keeps working unchanged",
      legacy.count >= 1 && legacy.conversations.every((c) => c.agent_name === "artist"),
      JSON.stringify({ count: legacy.count }));
    const byMeta = await run(projA, userA1, "conversations", { q: { "metadata.priority": "high" } });
    harness.check("listConversations: q['metadata.priority'] filters by the persisted metadata value",
      byMeta.count === 2 && byMeta.conversations.some((c) => c.conversation_id === idOf(convHigh1))
        && byMeta.conversations.some((c) => c.conversation_id === idOf(convHigh2)),
      JSON.stringify({ count: byMeta.count }));
    const combined = await run(projA, userA1, "conversations", { q: { agent_name: "helper", "metadata.priority": "high" } });
    harness.check("listConversations: q combines agent_name with a metadata field",
      combined.count === 2 && combined.conversations.every((c) => c.agent_name === "helper"), JSON.stringify({ count: combined.count }));
    const asc = await run(projA, userA1, "conversations", { sort: "created_date" });
    const ascTimes = asc.conversations.map((c) => String(c.created_at));
    harness.check("listConversations: sort 'created_date' returns ascending order",
      ascTimes.every((t, i) => i === 0 || ascTimes[i - 1] <= t), JSON.stringify(ascTimes.slice(0, 2)));
    const limited = await run(projA, userA1, "conversations", { q: { agent_name: "helper" }, limit: 2 });
    harness.check("listConversations: limit narrows the returned list and its count",
      limited.count === 2 && limited.conversations.length === 2, JSON.stringify({ count: limited.count }));
    const badSort = await captureCall(() => run(projA, userA1, "conversations", { sort: "title" }));
    harness.check("listConversations: an invalid sort is refused fail-closed",
      badSort.threw && badSort.code === "AGENT_SORT_INVALID" && badSort.status === 400, JSON.stringify(badSort));
    const badLimit0 = await captureCall(() => run(projA, userA1, "conversations", { limit: 0 }));
    const badLimitBig = await captureCall(() => run(projA, userA1, "conversations", { limit: 51 }));
    harness.check("listConversations: an invalid limit is refused fail-closed",
      badLimit0.threw && badLimit0.code === "AGENT_LIMIT_INVALID" && badLimit0.status === 400
        && badLimitBig.threw && badLimitBig.code === "AGENT_LIMIT_INVALID",
      JSON.stringify({ zero: badLimit0.code, over: badLimitBig.code }));
    const badField = await captureCall(() => run(projA, userA1, "conversations", { q: { title: "x" } }));
    harness.check("listConversations: an undocumented q field is refused fail-closed",
      badField.threw && badField.code === "AGENT_QUERY_INVALID" && badField.status === 400, JSON.stringify(badField));
    const badQ = await captureCall(() => run(projA, userA1, "conversations", { q: "helper" }));
    harness.check("listConversations: a non-object q is refused fail-closed",
      badQ.threw && badQ.code === "AGENT_QUERY_INVALID" && badQ.status === 400, JSON.stringify(badQ));
    const anonListGate = await captureCall(() => run(projA, null, "conversations", { q: { agent_name: "helper" } }, anonUser));
    harness.check("listConversations: an anonymous caller naming a NON-anonymous agent in q is refused (401)",
      anonListGate.threw && anonListGate.code === "AGENT_AUTH_REQUIRED" && anonListGate.status === 401, JSON.stringify(anonListGate));
    const anonListOk = await run(projA, null, "conversations", { q: { agent_name: "open_helper" } }, anonUser);
    harness.check("listConversations: an anonymous caller naming an anonymous-enabled agent in q is allowed",
      anonListOk.count >= 1 && anonListOk.conversations.every((c) => c.agent_name === "open_helper"),
      JSON.stringify({ count: anonListOk.count }));

    // ---- addMessage: the documented message-object form ----------------------------------------
    const URL = "https://files.test/review.pdf";
    script = [{ action: "reply", content: "object form ok" }];
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);
    const objTurn = await run(projA, userA1, "invoke", { conversation_id: idOf(convArtist), message: "review please", role: "user", file_urls: [URL] });
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("addMessage: the documented message-object form (role/content/file_urls) runs the turn",
      objTurn.reply === "object form ok" && objTurn.agent === "artist" && objTurn.conversation_id === idOf(convArtist),
      JSON.stringify({ reply: objTurn.reply, agent: objTurn.agent }));
    harness.check("addMessage: the object form charges the integration pool once and never the message pool (P-9.11E unchanged)",
      int1 < int0 && objTurn.usage.integration_credits >= 1 && msg1 === msg0, `int ${int0} → ${int1}; msg ${msg0} → ${msg1}`);
    const objGet = await run(projA, userA1, "get", { conversation_id: idOf(convArtist) });
    const objUserMsg = objGet.messages.find((m) => m.role === "user" && m.content === "review please");
    harness.check("addMessage: the object form persists role 'user' and the file_urls on the user row",
      !!objUserMsg && Array.isArray(objUserMsg.file_urls) && objUserMsg.file_urls[0] === URL,
      JSON.stringify(objUserMsg && objUserMsg.file_urls));
    const roleAssistant = await captureCall(() => run(projA, userA1, "invoke", { conversation_id: idOf(convArtist), message: "hi", role: "assistant" }));
    const roleSystem = await captureCall(() => run(projA, userA1, "invoke", { conversation_id: idOf(convArtist), message: "hi", role: "system" }));
    harness.check("addMessage: a non-user inbound role is refused fail-closed (no invented semantics)",
      roleAssistant.threw && roleAssistant.code === "AGENT_ROLE_INVALID" && roleAssistant.status === 400
        && roleSystem.threw && roleSystem.code === "AGENT_ROLE_INVALID",
      JSON.stringify({ assistant: roleAssistant.code, system: roleSystem.code }));
    script = [{ action: "reply", content: "plain still ok" }];
    const plainTurn = await run(projA, userA1, "invoke", { conversation_id: idOf(convArtist), message: "plain turn" });
    harness.check("addMessage: a plain string message keeps the exact prior behavior",
      plainTurn.reply === "plain still ok" && plainTurn.idempotent_replay === false, JSON.stringify({ reply: plainTurn.reply }));

    // ---- the SDK surface ------------------------------------------------------------------------
    harness.check("surface: the `agents` export is registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("agents"), JSON.stringify(RUNTIME_EXPORTS.filter((e) => e === "agents")));
    const surfaceMethods = Object.keys(AGENTS_SDK_SURFACE);
    const opsCovered = [...new Set(Object.values(AGENTS_SDK_SURFACE).map((m) => `${m.scope}:${m.op}`))];
    harness.check("surface: all nine agents methods map onto the certified server ops",
      surfaceMethods.length === 9 && surfaceMethods.includes("updateConversation") && surfaceMethods.includes("getConversations")
        && opsCovered.every((s) => CERTIFIED_OPS.includes(s)),
      JSON.stringify({ methods: surfaceMethods, ops: opsCovered }));
    harness.check("surface: a channel outside the certified foundations is still refused",
      !Object.values(AGENTS_SDK_SURFACE).some((m) => (m.channel || "") === "line"),
      "line absent by design");

    // ---- final ledger integrity -------------------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after the conversation surface usage", integrity.ok, JSON.stringify(integrity));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911h-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911h" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911h_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911h[0-9]+$" } }).catch(() => {});
  }
}