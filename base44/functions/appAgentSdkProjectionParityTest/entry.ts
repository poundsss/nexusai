// P-9.11I certification suite: deployed-app Agents SDK projection parity (AgentConversation /
// AgentMessage).
//
// Base44 documents the response fields (docs.base44.com SDK reference `agents`):
//   AgentConversation: id, app_id, agent_name, created_by_id, created_date, updated_date,
//                      messages, metadata;
//   AgentMessage:      id, role, created_date, updated_date, content, file_urls, tool_calls
//                      [{ id, name, arguments_string, status, results }], usage, model, ... .
// This suite certifies ONLY what is sourced from existing authoritative records:
//   • conversation id / app_id (the row's own project stamp) / created_by_id (its owner stamp)
//     / created_date / updated_date / metadata / messages-where-already-loaded (the get read);
//   • message id / created_date / updated_date beside every legacy field;
//   • tool_calls name + status, deterministically projected from the STORED outcome.
// The deliberately-omitted documented fields (reasoning, hidden, checkpoint_id, custom_context,
// additional_message_params, prompt_tokens/completion_tokens, per-message model, message
// metadata, tool-call id/arguments_string/results) have NO authoritative stored value —
// exposing them would fabricate data or change a certified contract, so the suite asserts they
// are ABSENT, and that no instructions, observations or credentials leak.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
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
  const client = {
    asServiceRole: {
      entities: db.entities,
      integrations: { Core: { GenerateImage: async () => { calls.image++; return { url: `https://cdn.test/p911i-${calls.image}.png` }; } } },
    },
  };
  const opts = { providerOverrides };
  const pace = appAgentPace;
  const run = async (project, user, op, args, anonUser = null) => {
    await pace();
    return handleAppAgent(client, { project, payload, user, anonymous: anonUser ? { user: anonUser } : null, op, args, options: opts });
  };

  // app_tools is a METADATA key (read from agent.metadata.app_tools), while
  // allow_anonymous_access is an OWNED top-level key — the fixture builds each in its place.
  const agentDoc = (name, metadata = {}, owned = {}) => ({ ...appAgentDoc(name, metadata, "Answer briefly. SECRET-INSTRUCTION-MARKER"), ...owned });
  const payload = {
    agents: [agentDoc("helper"), agentDoc("artist", { app_tools: ["GenerateImage"] }), agentDoc("open_helper", {}, { allow_anonymous_access: true })],
    entities: [],
  };
  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911i");

  try {
    const plan = await makeBillingPlan(db, created, `p911i${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911i${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);

    const projA = await makeAgentProject(db, projectIds, A, stamp, "p911i");
    const projB = await makeAgentProject(db, projectIds, A, stamp, "p911i"); // project-isolation probe
    const userA1 = { id: `p911i_userA1_${stamp}`, email: "a1@p911i.test" };
    const userA2 = { id: `p911i_userA2_${stamp}`, email: "a2@p911i.test" };
    const anonUser = { id: `p911i_anon_${stamp}`, email: "anon@p911i.test" };

    const URL = "https://files.test/report.pdf";
    const conv = await run(projA, userA1, "create", { agent_name: "helper", metadata: { category: "docs" } });
    const convId = conv.conversation.conversation_id;
    script = [{ action: "reply", content: "hello there" }];
    await run(projA, userA1, "invoke", { conversation_id: convId, message: "first question", file_urls: [URL] });

    // ---- conversation projection -----------------------------------------------------------
    const got = await run(projA, userA1, "get", { conversation_id: convId });
    const c = got.conversation;
    harness.check("conversation: documented fields (id/app_id/agent_name/created_by_id/created_date/updated_date/metadata)",
      c.id === convId && c.conversation_id === convId && c.app_id === projA.id && c.agent_name === "helper"
        && c.created_by_id === userA1.id && typeof c.created_date === "string" && typeof c.updated_date === "string"
        && (c.metadata || {}).category === "docs",
      JSON.stringify({ id_ok: c.id === convId, app_id: c.app_id, created_by_id: c.created_by_id, category: (c.metadata || {}).category }));
    harness.check("conversation: messages embedded where already loaded (the get read)",
      Array.isArray(c.messages) && c.messages.length === got.count && got.count === 2
        && c.messages.map((m) => m.role).join(",") === "user,assistant"
        && (c.messages[1] || {}).content === "hello there",
      JSON.stringify({ count: got.count, embedded: (c.messages || []).length }));
    harness.check("conversation: legacy fields preserved (conversation_id/title/created_at)",
      c.conversation_id === convId && typeof c.title === "string" && typeof c.created_at === "string",
      JSON.stringify({ conversation_id: c.conversation_id, title: c.title, created_at: c.created_at }));

    const list = await run(projA, userA1, "conversations", {});
    const item = list.conversations.find((x) => x.conversation_id === convId);
    harness.check("list items carry the documented fields, always the caller's OWN app and id",
      !!item && item.id === convId && item.app_id === projA.id && item.created_by_id === userA1.id
        && typeof item.created_date === "string" && typeof item.updated_date === "string"
        && list.conversations.every((x) => x.app_id === projA.id && x.created_by_id === userA1.id),
      JSON.stringify({ count: list.count, sample: item && { id: item.id, app_id: item.app_id, created_by_id: item.created_by_id } }));
    harness.check("list items do NOT embed messages (no invented per-conversation fetches)",
      list.conversations.every((x) => !("messages" in x)), JSON.stringify({ count: list.count }));

    // ---- message projection -----------------------------------------------------------------
    const userMsg = got.messages.find((m) => m.role === "user");
    const assistantMsg = got.messages.find((m) => m.role === "assistant");
    harness.check("message: documented fields (id/role/created_date/updated_date/content) with legacy message_id preserved",
      !!userMsg && userMsg.id === userMsg.message_id && userMsg.role === "user" && userMsg.content === "first question"
        && typeof userMsg.created_date === "string" && typeof userMsg.updated_date === "string",
      JSON.stringify(userMsg && { id_ok: userMsg.id === userMsg.message_id, role: userMsg.role, content: userMsg.content }));
    harness.check("message: file_urls exposed exactly as persisted",
      !!userMsg && Array.isArray(userMsg.file_urls) && userMsg.file_urls[0] === URL, JSON.stringify(userMsg && userMsg.file_urls));
    harness.check("message: legacy usage preserved; token fields and per-message model/metadata NOT invented",
      !!assistantMsg && (assistantMsg.usage || {}).integration_credits >= 1
        && !("prompt_tokens" in (assistantMsg.usage || {})) && !("completion_tokens" in (assistantMsg.usage || {}))
        && !("model" in assistantMsg) && !("metadata" in assistantMsg),
      JSON.stringify(assistantMsg && assistantMsg.usage));

    // ---- tool_calls: the documented shape, sourced only from the stored outcome -------------
    const convArtist = await run(projA, userA1, "create", { agent_name: "artist" });
    script = [
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "a cat" } } },
      { action: "reply", content: "I drew it." },
    ];
    await run(projA, userA1, "invoke", { conversation_id: convArtist.conversation.conversation_id, message: "draw a cat" });
    const gotTool = await run(projA, userA1, "get", { conversation_id: convArtist.conversation.conversation_id });
    const tc = ((gotTool.messages.find((m) => m.role === "assistant") || {}).tool_calls || [])[0];
    harness.check("tool_calls: documented name + status projected from the stored outcome (success)",
      !!tc && tc.name === "GenerateImage" && tc.status === "success" && tc.primitive === "GenerateImage" && tc.ok === true,
      JSON.stringify(tc));
    harness.check("tool_calls: id/arguments_string/results have no stored value and are omitted, never fabricated",
      !!tc && !("id" in tc) && !("arguments_string" in tc) && !("results" in tc), JSON.stringify(tc));

    // An ERRORED tool call: the memory save of an empty statement fails deterministically, so
    // the stored { tool, ok: false, code } entry projects status 'error' with its stored code.
    script = [
      { action: "memory", memory: { statement: "   " } },
      { action: "reply", content: "noted anyway" },
    ];
    await run(projA, userA1, "invoke", { conversation_id: convId, message: "remember nothing" });
    const gotMem = await run(projA, userA1, "get", { conversation_id: convId });
    const memTc = (([...gotMem.messages].reverse().find((m) => m.role === "assistant") || {}).tool_calls || [])[0];
    harness.check("tool_calls: an errored tool call projects status 'error' with its stored code",
      !!memTc && memTc.name === "memory" && memTc.status === "error" && memTc.ok === false && memTc.code === "AGENT_MEMORY_EMPTY",
      JSON.stringify(memTc));

    // ---- UNKNOWN documented fields are absent; nothing internal leaks ------------------------
    const everything = JSON.stringify(got) + JSON.stringify(gotTool) + JSON.stringify(gotMem) + JSON.stringify(list);
    const forbidden = ["\"reasoning\"", "\"hidden\"", "\"checkpoint_id\"", "\"custom_context\"", "\"additional_message_params\"", "\"prompt_tokens\"", "\"completion_tokens\"", "\"model\""];
    harness.check("projection: no UNKNOWN documented field is invented (fail-closed omissions)",
      !forbidden.some((k) => everything.includes(k)), JSON.stringify(forbidden.filter((k) => everything.includes(k))));
    harness.check("projection: no instructions, internal observations or credentials leak",
      !everything.includes("SECRET-INSTRUCTION-MARKER") && !everything.includes("[tool ") && !everything.includes("cdn.test/p911i-"),
      JSON.stringify({ instruction: everything.includes("SECRET-INSTRUCTION-MARKER"), observation: everything.includes("[tool ") }));

    // ---- isolation is unchanged --------------------------------------------------------------
    const crossUser = await captureCall(() => run(projA, userA2, "get", { conversation_id: convId }));
    harness.check("isolation: another app user's read is a 404 (indistinguishable from missing)",
      crossUser.threw && crossUser.code === "CONVERSATION_NOT_FOUND" && crossUser.status === 404, JSON.stringify(crossUser));
    const crossProject = await captureCall(() => run(projB, userA1, "get", { conversation_id: convId }));
    harness.check("isolation: the same user in ANOTHER project gets a 404",
      crossProject.threw && crossProject.code === "CONVERSATION_NOT_FOUND" && crossProject.status === 404, JSON.stringify(crossProject));
    const theirList = await run(projA, userA2, "conversations", {});
    harness.check("isolation: another user's list never contains userA1's conversations",
      !theirList.conversations.some((x) => x.conversation_id === convId), JSON.stringify({ count: theirList.count }));
    const anonConv = await run(projA, null, "create", { agent_name: "open_helper" }, anonUser);
    const anonGet = await run(projA, null, "get", { conversation_id: anonConv.conversation.conversation_id }, anonUser);
    harness.check("anonymous: the projection exposes the anonymous caller's OWN record only",
      anonGet.conversation.created_by_id === anonUser.id && anonGet.conversation.app_id === projA.id,
      JSON.stringify({ created_by_id: anonGet.conversation.created_by_id, app_id: anonGet.conversation.app_id }));

    // ---- billing shape is unchanged ------------------------------------------------------------
    harness.check("billing: the message pool is never moved by agent turns (P-9.11E unchanged)",
      (await msgOf(A.ws.id)) === 200, JSON.stringify({ msg: await msgOf(A.ws.id) }));

    // ---- final ledger integrity -----------------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after the projection surface usage", integrity.ok, JSON.stringify(integrity));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911i-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911i" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911i_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911i[0-9]+$" } }).catch(() => {});
  }
}