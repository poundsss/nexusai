// P-9.11G certification suite: deployed-app Agents SDK addMessage file_urls parity.
//
// Base44 documents addMessage's optional `file_urls: string[]` ("URLs to files attached to the
// message") and NOTHING beyond that for it. This suite drives the REAL surfaces the sandbox
// `agents` namespace rides — the existing P-9.4 handler (shared/appAgentRuntime.ts) with only
// the model-provider boundary stubbed, exactly as appAgentParityTest / appAgentSdkParityTest —
// and certifies the narrow P-9.11G additions against the documented contract:
//   • documented-shape validation (array of URL strings), fail-closed before persistence/charge;
//   • scrubbing through the EXISTING tracing contract (no invented count/length bounds — Base44
//     publishes none, UNKNOWN);
//   • persistence on the USER message row and exposure through the EXISTING message projection
//     (get / messages reads);
//   • NO injection into the model context (Base44 semantics UNKNOWN — deliberately not invented);
//   • NO attachment tariff — P-9.11E per-turn billing, idempotent replay and message-pool
//     isolation are UNCHANGED;
//   • the SDK surface: addMessage's widening changes the MESSAGE OBJECT only; the P-9.11H
//     conversation additions (updateConversation, getConversations) are documented Base44
//     surfaces certified by their own suite, appAgentSdkConversationParityTest.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent, MESSAGES_ENTITY } from "../../shared/appAgentRuntime.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// MIRROR of the `agents` namespace method list in src/lib/runtime/runtimeSource.js (keep in
// sync). P-9.11G widens addMessage's MESSAGE OBJECT only; P-9.11H adds the documented
// conversation methods updateConversation and getConversations to the surface.
const AGENTS_SDK_SURFACE = [
  "createConversation", "getConversations", "listConversations", "getConversation",
  "updateConversation", "addMessage", "subscribeToConversation", "getTelegramConnectURL",
  "getWhatsAppConnectURL",
];

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
  let lastModelMessages = null; // the exact messages the model received — the no-injection probe
  const fakeProvider = {
    async generate({ messages, jsonSchema }) {
      calls.llm++;
      lastModelMessages = JSON.stringify(messages);
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
  const run = async (project, user, op, args) => {
    await pace();
    return handleAppAgent(client, { project, payload, user, op, args, options: opts });
  };

  const payload = { agents: [appAgentDoc("helper")], entities: [] };
  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911g");

  try {
    const plan = await makeBillingPlan(db, created, `p911g${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911g${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);

    const projA = await makeAgentProject(db, projectIds, A, stamp, "p911g");
    const userA1 = { id: `p911g_userA1_${stamp}`, email: "a1@p911g.test" };
    const userA2 = { id: `p911g_userA2_${stamp}`, email: "a2@p911g.test" };

    const conv = await run(projA, userA1, "create", { agent_name: "helper" });
    const convId = conv.conversation.conversation_id;

    // ---- invalid shape: fail-closed BEFORE any persistence or charge --------------------
    const pool0 = await intOf(A.ws.id);
    const badString = await captureCall(() => run(projA, userA1, "invoke", { conversation_id: convId, message: "hi", file_urls: "https://not-an-array.test/a.pdf" }));
    harness.check("addMessage: a non-array file_urls is refused with the documented-shape error",
      badString.threw && badString.code === "AGENT_FILE_URLS_INVALID" && badString.status === 400, JSON.stringify(badString));
    const badElement = await captureCall(() => run(projA, userA1, "invoke", { conversation_id: convId, message: "hi", file_urls: ["https://ok.test/a.pdf", 42] }));
    harness.check("addMessage: a non-string file_urls element is refused",
      badElement.threw && badElement.code === "AGENT_FILE_URLS_INVALID" && badElement.status === 400, JSON.stringify(badElement));
    const badEmpty = await captureCall(() => run(projA, userA1, "invoke", { conversation_id: convId, message: "hi", file_urls: [""] }));
    harness.check("addMessage: an empty-string file_urls element is refused",
      badEmpty.threw && badEmpty.code === "AGENT_FILE_URLS_INVALID" && badEmpty.status === 400, JSON.stringify(badEmpty));
    const poolAfterBad = await intOf(A.ws.id);
    const emptyConv = await run(projA, userA1, "get", { conversation_id: convId });
    harness.check("addMessage: an invalid shape persists nothing and charges nothing",
      poolAfterBad === pool0 && emptyConv.count === 0, `int ${pool0} → ${poolAfterBad}; count ${emptyConv.count}`);

    // ---- valid file_urls: the turn runs, persists and projects them ---------------------
    const URLS = ["https://files.test/uploads/report.pdf", "https://files.test/uploads/chart.png"];
    script = [{ action: "reply", content: "I see two attachments" }];
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);
    const turn = await run(projA, userA1, "invoke", { conversation_id: convId, message: "please review", file_urls: URLS });
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("addMessage: valid file_urls run the turn and answer normally",
      turn.reply === "I see two attachments" && turn.agent === "helper", JSON.stringify({ reply: turn.reply, agent: turn.agent }));
    harness.check("addMessage: attachments add NO tariff — integration pool moves only the per-turn charge, message pool untouched (P-9.11E)",
      int1 < int0 && turn.usage.integration_credits >= 1 && msg1 === msg0,
      `int ${int0} → ${int1}; msg ${msg0} → ${msg1}`);

    const stored = await run(projA, userA1, "get", { conversation_id: convId });
    const userMsg = stored.messages.find((m) => m.role === "user");
    const assistantMsg = stored.messages.find((m) => m.role === "assistant");
    harness.check("projection (get): the user message exposes file_urls exactly as persisted",
      Array.isArray(userMsg.file_urls) && userMsg.file_urls.join("|") === URLS.join("|"),
      JSON.stringify(userMsg.file_urls));
    harness.check("projection (get): the assistant message carries no file_urls",
      !assistantMsg.file_urls, JSON.stringify({ has: !!assistantMsg.file_urls }));
    const viaMessages = await run(projA, userA1, "messages", { conversation_id: convId });
    const userMsgViaList = viaMessages.messages.find((m) => m.role === "user");
    harness.check("projection (messages): the messages read exposes the same file_urls",
      Array.isArray(userMsgViaList.file_urls) && userMsgViaList.file_urls.join("|") === URLS.join("|"),
      JSON.stringify(userMsgViaList.file_urls));

    // The raw server-side rows: file_urls live on the USER turn only, never the reply.
    const rows = await db.entities.AppRecord.filter(
      { project_id: projA.id, entity_name: MESSAGES_ENTITY, owner_id: userA1.id }, "created_date", 50,
    ).catch(() => []);
    const userRow = rows.find((r) => (r.data || {}).role === "user");
    const assistantRow = rows.find((r) => (r.data || {}).role === "assistant");
    harness.check("persistence: file_urls live on the USER message row",
      JSON.stringify((userRow.data || {}).file_urls) === JSON.stringify(URLS), JSON.stringify((userRow.data || {}).file_urls));
    harness.check("persistence: the assistant row and reply stay free of file_urls",
      !(assistantRow.data || {}).file_urls && !JSON.stringify(assistantRow.data || {}).includes("files.test"),
      JSON.stringify({ has: !!(assistantRow.data || {}).file_urls }));

    // Base44 publishes no injection semantics for file_urls (UNKNOWN) — none implemented: the
    // URLs must never reach the model context.
    harness.check("no injection: the attachment URLs never reach the model context",
      !String(lastModelMessages || "").includes("files.test"), String(lastModelMessages || "").slice(0, 200));

    // ---- scrubbing rides the EXISTING tracing contract -----------------------------------
    script = [{ action: "reply", content: "stored" }];
    await run(projA, userA1, "invoke", { conversation_id: convId, message: "another one", file_urls: ["https://files.test/att.pdf?k=sk_live_abcdef0123456789"] });
    const scrubbed = await run(projA, userA1, "get", { conversation_id: convId });
    const lastUser = [...scrubbed.messages].filter((m) => m.role === "user").pop();
    harness.check("scrubbing: a credential-shaped attachment URL is redacted through the existing platform contract",
      String((lastUser.file_urls || [])[0]).includes("[REDACTED]") && !String((lastUser.file_urls || [])[0]).includes("sk_live_abcdef0123456789"),
      JSON.stringify(lastUser.file_urls));

    // ---- idempotent replay: the SAME turn, the stored reply, no second charge -----------
    const intBefore = await intOf(A.ws.id);
    script = [{ action: "reply", content: "keyed answer" }];
    const keyed = await run(projA, userA1, "invoke", { conversation_id: convId, message: "once", idempotency_key: `p911g-key-${stamp}`, file_urls: ["https://files.test/only.pdf"] });
    const intMid = await intOf(A.ws.id);
    const replay = await run(projA, userA1, "invoke", { conversation_id: convId, message: "once", idempotency_key: `p911g-key-${stamp}`, file_urls: ["https://files.test/only.pdf"] });
    const intEnd = await intOf(A.ws.id);
    harness.check("idempotency: a keyed replay returns the stored reply without a second charge",
      keyed.reply === "keyed answer" && replay.idempotent_replay === true && replay.message_id === keyed.message_id && intMid === intEnd,
      JSON.stringify({ mid: intMid, end: intEnd }));
    const replayed = await run(projA, userA1, "get", { conversation_id: convId });
    const keyedUser = replayed.messages.find((m) => m.role === "user" && m.content === "once");
    harness.check("idempotency: the keyed turn's file_urls persist and replay unchanged",
      !!keyedUser && Array.isArray(keyedUser.file_urls) && keyedUser.file_urls[0] === "https://files.test/only.pdf",
      JSON.stringify(keyedUser && keyedUser.file_urls));
    harness.check("idempotency: the keyed turn charged the integration pool exactly once",
      intMid < intBefore && intEnd === intMid, `${intBefore} → ${intMid} → ${intEnd}`);

    // ---- a plain message keeps the exact prior projection shape --------------------------
    script = [{ action: "reply", content: "plain" }];
    await run(projA, userA1, "invoke", { conversation_id: convId, message: "no attachments" });
    const plain = await run(projA, userA1, "get", { conversation_id: convId });
    const plainUser = plain.messages.find((m) => m.role === "user" && m.content === "no attachments");
    harness.check("shape: a message without file_urls exposes no file_urls field",
      !!plainUser && !("file_urls" in plainUser), JSON.stringify(plainUser));

    // ---- isolation is unchanged -----------------------------------------------------------
    const cross = await captureCall(() => run(projA, userA2, "get", { conversation_id: convId }));
    harness.check("isolation: another app user's read of the conversation is a 404",
      cross.threw && cross.code === "CONVERSATION_NOT_FOUND" && cross.status === 404, JSON.stringify(cross));

    // ---- the SDK surface: P-9.11G widened the MESSAGE OBJECT only; the P-9.11H conversation
    // methods are documented additions certified by appAgentSdkConversationParityTest.
    harness.check("surface: the `agents` export is registered and the method list is the documented surface",
      RUNTIME_EXPORTS.includes("agents") && AGENTS_SDK_SURFACE.length === 9
        && AGENTS_SDK_SURFACE.includes("updateConversation") && AGENTS_SDK_SURFACE.includes("getConversations")
        && AGENTS_SDK_SURFACE.includes("addMessage"),
      JSON.stringify(AGENTS_SDK_SURFACE));

    // ---- final ledger integrity -----------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after the file_urls surface usage", integrity.ok, JSON.stringify(integrity));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911g-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911g" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911g_user" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911g[0-9]+$" } }).catch(() => {});
  }
}