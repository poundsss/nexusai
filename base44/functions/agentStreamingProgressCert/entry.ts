// Certification suite for AGENT RESPONSE STREAMING (additive, non-parity): the ephemeral
// agent progress draft, observable through the EXISTING `agents.subscribeToConversation`
// bounded-poll projection.
//
// Certified here (and ONLY here — every other agent contract stays pinned by its own suite):
//   1. progressively growing assistant content is observable mid-turn;
//   2. the draft's message_id is STABLE across the whole turn (the turn id);
//   3. tool-call status updates ride the draft (documented "running" → "success");
//   4. the final persisted Message replaces the draft (no projection shows both);
//   5. NO partial Message rows persist during or after generation;
//   6. billing/credits are UNCHANGED (reads move nothing; the turn's own settled charge is the
//      only integration movement; the message pool is untouched);
//   7. `invoke_key` idempotency is UNCHANGED (a keyed replay returns the persisted reply and
//      emits no draft);
//   8. a FAILED turn leaves no ephemeral draft behind;
//   9. unsubscribe stops all polling (the new draft-aware signal included).
// Items 10/11 (the existing subscribe parity suite and the agent runtime suites stay green)
// are re-run as their own deployed functions after this suite passes.
//
// UNCHANGED and re-driven through the REAL paths: addMessage contract, getConversation
// contract (`count` and top-level `messages` stay persisted-only), Message/AgentStep schemas,
// settleTurn exactly-once settlement, the durable (turn, step) tool claim, and the bounded
// poll transport (NO WebSocket/socket.io — token-level streaming stays UNKNOWN, not claimed).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { appAgentPace, makeAgentProject, appAgentDoc, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";
import { AGENT_PROGRESS_NAMESPACE } from "../../shared/agentProgress.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

// MIRROR of the agent-streaming-aware `subscribeToConversation` poll in
// src/lib/runtime/runtimeSource.js (keep in sync). Ticks are driven explicitly so the draft
// signal can be certified deterministically; every decision line — the stopped guard, the
// envelope→projection mapping, the count+draft signature, the first-refused-read stop — is
// the bridge's own.
function mirrorSubscribeV2(getRead, onUpdate) {
  let stopped = false, seen = -1, reads = 0;
  const poll = async () => {
    if (stopped) return;
    let r;
    try { reads++; r = await getRead(); } catch (e) { if (!stopped) { stopped = true; if (typeof onUpdate === "function") onUpdate({ error: String((e && e.message) || e) }); } return; }
    if (stopped) return;
    const conversation = (r && r.conversation) || null;
    const msgs = conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
    const draft = msgs.find((m) => m && m.streaming) || null;
    const sig = draft ? [msgs.length, draft.message_id, String(draft.content || "").length, (draft.tool_calls || []).map((t) => t.status || "").join(",")].join("|") : String(msgs.length);
    if (sig !== seen) { seen = sig; if (typeof onUpdate === "function") onUpdate(conversation); }
  };
  return { poll, unsubscribe: () => { stopped = true; }, get reads() { return reads; } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The certification boundary, stated explicitly: the transport stays the bounded poll; the
// draft is ephemeral and non-persisted; instant socket push is NOT implemented.
const STREAMING_CONTRACT = {
  transport: "bounded-poll-4s (unchanged)",
  draft_store: "ephemeral short-TTL CacheEntry (agentprogress) — NEVER a Message row",
  draft_identity: "turn id as the stable message_id; the durable Message supersedes the draft",
  tool_status: "documented model only: running → success/error (toolCallView for completed)",
  token_streaming: "UNKNOWN — not implemented, not claimed",
  socket_push: "NOT implemented — instant delivery stays UNKNOWN",
};

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];
  const wsIds = [];
  const convIds = [];
  const turnIds = [];

  // ---- provider boundary stub + gated search (everything else is the REAL machinery) ----
  let script = [];
  let failProvider = false;
  let generateCalls = 0;
  // The FIRST model step is HELD until the cert observes the step-0 empty draft — a
  // deterministic window (the growth test needs to see content "" first), with a hard
  // auto-release so a held step can never wedge the turn.
  let releaseStep1 = null;
  const step1Gate = () => new Promise((resolve) => { releaseStep1 = resolve; });
  const fakeProvider = {
    async generate({ jsonSchema }) {
      if (failProvider) throw new Error("provider down (test)");
      if (generateCalls++ === 0) await Promise.race([step1Gate(), sleep(15000)]);
      const out = script.length ? script.shift() : { action: "reply", content: "OK, noted." };
      return {
        output: jsonSchema ? out : (out.action === "reply" ? out.content : JSON.stringify(out)),
        usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" },
      };
    },
  };
  // The search's fetch is HELD until the cert observes the "running" tool — a deterministic
  // mid-turn window, released by the cert with a well-formed provider response.
  let releaseSearch = null;
  const gatedFetch = async () => new Promise((resolve) => { releaseSearch = resolve; });
  const GOOD_SEARCH = { ok: true, status: 200, json: async () => ({ results: [{ title: "t", url: "https://example.com/x", content: "c" }] }) };

  const client = { asServiceRole: { entities: db.entities } };
  const opts = {
    providerOverrides: { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider },
    webSearch: { keyProvider: async () => "test-key", fetchImpl: gatedFetch, timeoutMs: 20000 },
  };
  const pace = (ms) => appAgentPace(ms || 400);
  const run = async (project, user, op, args) => {
    await pace();
    return handleAppAgent(client, { project, payload, user, op, args, options: opts });
  };

  const payload = { agents: [appAgentDoc("helper", {}, "Answer briefly. SECRET-INSTRUCTION-MARKER")], entities: [], functions: [] };
  const { grant, intOf, msgOf } = makeAgentPoolTools(db, stamp, "agsp");

  try {
    const plan = await makeBillingPlan(db, created, `agsp${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `agsp${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 100);
    await grant(A.ws.id, "integration", 100);
    const projA = await makeAgentProject(db, projectIds, A, stamp, "agsp");
    const userA1 = { id: `agsp_userA1_${stamp}`, email: "a1@agsp.test" };

    // ---- fixture: one owned conversation, no messages yet ---------------------------------
    const conv = await run(projA, userA1, "create", { agent_name: "helper" });
    const convId = conv.conversation.conversation_id;
    convIds.push(convId);

    script = [
      { action: "tool", tool: { name: "google_search", input: { query: "nexus streaming parity" } }, content: "Let me search the web first." },
      { action: "reply", content: "Here is what I found." },
    ];
    const intBefore = await intOf(A.ws.id);
    const msgBefore = await msgOf(A.ws.id);

    // ---- the turn runs while the cert polls the projection --------------------------------
    let turnResult = null, turnError = null;
    const turnPromise = run(projA, userA1, "invoke", { conversation_id: convId, message: "search for me", idempotency_key: "k1" })
      .then((r) => { turnResult = r; }, (e) => { turnError = e; });
    turnPromise.catch(() => {});

    const snaps = [];
    for (let i = 0; i < 100 && !turnResult && !turnError; i++) {
      const g = await run(projA, userA1, "get", { conversation_id: convId });
      const msgs = (g.conversation.messages || []);
      const draft = msgs.find((m) => m.streaming) || null;
      snaps.push({
        persisted: g.messages.length,
        draft: draft ? {
          message_id: draft.message_id, content: draft.content, streaming: draft.streaming === true,
          tools: (draft.tool_calls || []).map((t) => t.status || "?"),
        } : null,
      });
      if (releaseSearch && draft && (draft.tool_calls || []).some((t) => t.status === "running")) {
        releaseSearch(GOOD_SEARCH); // deterministic window closed — the search completes
        releaseSearch = null;
      }
      if (releaseStep1 && draft && draft.content === "") {
        releaseStep1(); // deterministic window closed — the first model step proceeds
        releaseStep1 = null;
      }
      await sleep(120);
    }
    await turnPromise;

    const drafts = snaps.filter((s) => s.draft);
    const draftIds = [...new Set(drafts.map((s) => s.draft.message_id))];
    const contents = drafts.map((s) => s.draft.content);
    const toolsSeen = drafts.flatMap((s) => s.draft.tools);

    // 1 + 2: growing content, stable identity
    harness.check("progress: the draft is observable mid-turn with PROGRESSIVELY GROWING content and a STABLE message_id (the turn id)",
      drafts.length >= 2 && draftIds.length === 1 && !!draftIds[0]
        && contents[0].length < contents[contents.length - 1].length
        && contents[0] === "" && contents[contents.length - 1].includes("Let me search the web first."),
      JSON.stringify({ drafts: drafts.length, ids: draftIds, contents }));

    // 3: tool status rides the draft — documented "running" then "success"
    harness.check("tool status: the draft shows the documented running → success transition",
      toolsSeen.includes("running") && toolsSeen.includes("success"),
      JSON.stringify({ toolsSeen }));

    // 5 (mid-turn half): no partial Message rows persist during generation
    harness.check("no partial rows: while a draft was visible, the PERSISTED messages were only the turn's user row",
      drafts.every((s) => s.persisted === 1),
      JSON.stringify({ persistedDuringDraft: drafts.map((s) => s.persisted) }));

    // 4: the final persisted Message replaces the draft — no projection shows both
    const finalGet = await run(projA, userA1, "get", { conversation_id: convId });
    const finalMsgs = finalGet.messages || [];
    const noDraft = !(finalGet.conversation.messages || []).some((m) => m.streaming);
    harness.check("final supersedes: after the turn the projection has NO draft and the durable Message is the reply",
      noDraft && finalGet.count === 2 && finalMsgs.length === 2
        && finalMsgs[1].role === "assistant" && finalMsgs[1].content === "Here is what I found."
        && (finalMsgs[1].tool_calls || []).length === 1 && finalMsgs[1].tool_calls[0].status === "success"
        && finalMsgs[1].message_id !== draftIds[0],
      JSON.stringify({ count: finalGet.count, noDraft, last: finalMsgs[finalMsgs.length - 1] }));

    // 5 (after): no partial Message rows persist — exactly user + final assistant
    const rowsAfter = await db.entities.AppRecord.filter(
      { project_id: projA.id, entity_name: "__agent_messages", owner_id: userA1.id }, "created_date", 50,
    ).catch(() => []);
    const turnId = draftIds[0];
    if (turnId) turnIds.push(turnId);
    harness.check("no partial rows: the durable store holds exactly the user row and the final assistant row",
      rowsAfter.length === 2 && rowsAfter.every((r) => (r.data || {}).role !== "assistant" || r.id === turnResult.message_id),
      JSON.stringify(rowsAfter.map((r) => ({ role: (r.data || {}).role, id: r.id }))));

    // 6: billing/credits unchanged — reads move nothing; the turn's own charge is the only movement
    const intAfterTurn = await intOf(A.ws.id);
    await run(projA, userA1, "get", { conversation_id: convId });
    await run(projA, userA1, "get", { conversation_id: convId });
    const intAfterReads = await intOf(A.ws.id);
    const msgAfter = await msgOf(A.ws.id);
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("billing: reads move NO credits; the turn's own settled charge is the only integration movement; the message pool is untouched",
      intAfterReads === intAfterTurn && Number(intAfterTurn) === Number(intBefore) - Number(turnResult.usage.integration_credits)
        && msgAfter === msgBefore && integrity.ok,
      JSON.stringify({ intBefore, intAfterTurn, intAfterReads, turn: turnResult.usage.integration_credits, msgBefore, msgAfter, integrity }));

    // 7: invoke_key idempotency unchanged — the replay returns the persisted reply, no draft
    const replay = await run(projA, userA1, "invoke", { conversation_id: convId, message: "search for me", idempotency_key: "k1" });
    const replayGet = await run(projA, userA1, "get", { conversation_id: convId });
    harness.check("idempotency: a keyed replay returns the SAME persisted message, charges nothing and emits no draft",
      replay.idempotent_replay === true && replay.message_id === turnResult.message_id
        && Number(await intOf(A.ws.id)) === intAfterReads
        && !(replayGet.conversation.messages || []).some((m) => m.streaming) && replayGet.count === 2,
      JSON.stringify({ replay: replay.message_id, turn: turnResult.message_id }));

    // 8: a FAILED turn leaves no ephemeral draft behind
    script = [{ action: "reply", content: "never reached" }];
    failProvider = true;
    const failed = await (async () => { try { await run(projA, userA1, "invoke", { conversation_id: convId, message: "break it" }); return null; } catch (e) { return e; } })();
    const failedGet = await run(projA, userA1, "get", { conversation_id: convId });
    const leftoverDrafts = await db.entities.CacheEntry.filter({ namespace: AGENT_PROGRESS_NAMESPACE, cache_key: { $regex: `${convId}$` } }, "created_date", 10).catch(() => []);
    harness.check("failure: the failed turn surfaces its certified 502 and leaves NO ephemeral draft behind",
      !!failed && failed.code === "AGENT_MODEL_UNAVAILABLE"
        && !(failedGet.conversation.messages || []).some((m) => m.streaming) && leftoverDrafts.length === 0,
      JSON.stringify({ error: failed && failed.message, leftover: leftoverDrafts.length }));
    failProvider = false;

    // 9: unsubscribe stops all polling; the draft-aware signal fires on draft change only
    const events = [];
    const sub = mirrorSubscribeV2(() => run(projA, userA1, "get", { conversation_id: convId }), (v) => events.push(v));
    await sub.poll();
    await sub.poll(); // unchanged read — no callback
    sub.unsubscribe();
    const readsAtUnsub = sub.reads;
    await sub.poll();
    await sub.poll();
    harness.check("unsubscribe: after unsubscribe no read happens and no callback fires; a stable read fires no callback",
      events.length === 1 && sub.reads === readsAtUnsub, JSON.stringify({ events: events.length, reads: sub.reads }));

    // draft-aware signal: fires on draft content growth, stays quiet while unchanged
    const sigEvents = [];
    const draftRow = (content, tools) => ({ id: "turn-x", message_id: "turn-x", role: "assistant", content, streaming: true, tool_calls: tools });
    let stub = { conversation: { id: "c", conversation_id: "c", messages: [draftRow("part 1", [])] } };
    const subSig = mirrorSubscribeV2(async () => stub, (v) => sigEvents.push(v));
    await subSig.poll();
    stub = { conversation: { id: "c", conversation_id: "c", messages: [draftRow("part 1 grown", [])] } };
    await subSig.poll(); // content grew — must fire
    await subSig.poll(); // unchanged — must stay quiet
    stub = { conversation: { id: "c", conversation_id: "c", messages: [draftRow("part 1 grown", [{ name: "google_search", status: "running" }])] } };
    await subSig.poll(); // tool status changed — must fire
    harness.check("draft signal: the subscription fires on draft growth and tool-status change, and stays quiet while unchanged",
      sigEvents.length === 3, JSON.stringify({ events: sigEvents.length }));

    // contract boundary pinned
    harness.check("boundary: the streaming contract stays pinned — bounded poll, ephemeral draft, no socket push, token streaming UNKNOWN",
      STREAMING_CONTRACT.transport.includes("unchanged") && STREAMING_CONTRACT.draft_store.includes("NEVER a Message row")
        && STREAMING_CONTRACT.socket_push.startsWith("NOT implemented") && STREAMING_CONTRACT.token_streaming.startsWith("UNKNOWN"),
      JSON.stringify(STREAMING_CONTRACT));
    harness.check("surface: the `agents` export remains registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("agents"), "agents present");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Ephemeral draft rows and tool claims for THIS run's conversations/turns only.
    for (const convId of convIds) {
      await db.entities.CacheEntry.deleteMany({ namespace: AGENT_PROGRESS_NAMESPACE, cache_key: { $regex: `${convId}$` } }).catch(() => {});
    }
    for (const turnId of turnIds) {
      await db.entities.CacheEntry.deleteMany({ namespace: "appagent_tools", cache_key: { $regex: turnId } }).catch(() => {});
    }
    // Bulk cleanup — also sweeps scratch rows left behind by earlier interrupted runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^agsp-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^agsp" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...created.workspaces, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.FunctionInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
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
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_agsp" } }).catch(() => {});
  }
}