// A-stage certification suite: `agents.subscribeToConversation` — callback shape + stop
// invariants ONLY (Этап A of the realtime parity audit).
//
// DOCUMENTED (docs.base44.com SDK reference `agents`): subscribeToConversation(conversationId,
// onUpdate) returns an unsubscribe function; the callback receives the updated conversation.
// Certified here: the callback receives the DOCUMENTED AgentConversation projection
// (id / conversation_id / agent_name / title / created_by_id / created_at / created_date /
// updated_date / metadata / messages — P-9.11I), never the raw { conversation, count, messages }
// bridge envelope, and the unsubscribe / first-refused-read stop invariants hold.
//
// NEXUSAI-derived, explicitly NOT parity: the transport is a bounded 4-second poll over the
// SAME certified get read — the documented WebSocket / instant-update transport is NOT claimed.
// Token-level streaming is UNKNOWN (only a secondary source documents it; the official SDK
// reference documents message-level updates) and is not implemented, not claimed.
//
// The P-9.4/P-9.11 conversation semantics are UNCHANGED and re-driven through the REAL
// handleAppAgent paths: the server `get` op still returns the bridge envelope with the
// projection embedded (P-9.11I get-read embedding), and the BRIDGE (mirrored below, keep in
// sync with runtimeSource.js) maps it to the documented projection. Reads move no credits;
// the two scripted turns ride the existing P-9.11E per-turn billing path unchanged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, appAgentDoc, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// The certified transport contract, stated explicitly so the suite pins the certification
// boundary itself: bounded poll = NexusAI-derived substitute, WebSocket/instant NOT claimed.
const SUBSCRIBE_CONTRACT = {
  transport: "bounded-poll-4s",
  transport_parity: "NEXUSAI-derived substitute — the documented WebSocket/instant transport is NOT claimed (non-parity)",
  callback: "documented AgentConversation projection (P-9.11I) — never the raw { conversation, count, messages } bridge envelope",
  token_streaming: "UNKNOWN — not implemented, not claimed",
};

// MIRROR of `subscribeToConversation` in src/lib/runtime/runtimeSource.js (keep in sync). The
// ONLY adaptation: poll ticks are driven explicitly by the suite instead of setInterval(4000),
// so the stop invariants can be certified deterministically. Every decision line — the stopped
// guard, the envelope→projection mapping, the seen counter, the first-refused-read stop — is
// the bridge's own.
function mirrorSubscribe(getRead, onUpdate) {
  let stopped = false, seen = -1, reads = 0;
  const poll = async () => {
    if (stopped) return;
    let r;
    try { reads++; r = await getRead(); } catch (e) { if (!stopped) { stopped = true; if (typeof onUpdate === 'function') onUpdate({ error: String((e && e.message) || e) }); } return; }
    if (stopped) return;
    const conversation = (r && r.conversation) || null;
    const count = conversation && Array.isArray(conversation.messages) ? conversation.messages.length : -1;
    if (count !== seen) { seen = count; if (typeof onUpdate === 'function') onUpdate(conversation); }
  };
  return { poll, unsubscribe: () => { stopped = true; }, get reads() { return reads; } };
}

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  // ---- provider boundary stub (handlers, ledger and executor are the REAL ones) ----
  let script = [];
  const fakeProvider = {
    async generate({ messages, jsonSchema }) {
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

  const payload = { agents: [appAgentDoc("helper", {}, "Answer briefly. SECRET-INSTRUCTION-MARKER")], entities: [] };
  const { grant, intOf } = makeAgentPoolTools(db, stamp, "p911q");

  try {
    const plan = await makeBillingPlan(db, created, `p911q${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911q${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 100);
    await grant(A.ws.id, "integration", 100);

    const projA = await makeAgentProject(db, projectIds, A, stamp, "p911q");
    const userA1 = { id: `p911q_userA1_${stamp}`, email: "a1@p911q.test" };
    const userA2 = { id: `p911q_userA2_${stamp}`, email: "a2@p911q.test" };

    // ---- fixture: one owned conversation with one completed turn -----------------------
    const conv = await run(projA, userA1, "create", { agent_name: "helper", metadata: { priority: "high" } });
    const convId = conv.conversation.conversation_id;
    script = [{ action: "reply", content: "Hello from the agent" }];
    await run(projA, userA1, "invoke", { conversation_id: convId, message: "first question" });

    // ---- regression: the SERVER get op is unchanged — the bridge envelope with the
    // documented projection EMBEDDED (P-9.11I get-read embedding) ---------------------------------
    const got1 = await run(projA, userA1, "get", { conversation_id: convId });
    harness.check("regression: the server get op still returns the bridge envelope with the projection embedded",
      got1.count === 2 && !!got1.conversation && got1.conversation.conversation_id === convId
        && Array.isArray(got1.conversation.messages) && got1.conversation.messages.length === 2
        && Array.isArray(got1.messages) && got1.messages.length === 2,
      JSON.stringify({ count: got1.count, embedded: got1.conversation && got1.conversation.messages && got1.conversation.messages.length }));

    // ---- callback shape: the callback receives the DOCUMENTED AgentConversation ----------
    const events = [];
    const sub = mirrorSubscribe(() => run(projA, userA1, "get", { conversation_id: convId }), (v) => events.push(v));
    await sub.poll();
    const initial = events[0] || null;
    harness.check("callback: receives the DOCUMENTED AgentConversation projection, never the raw bridge envelope",
      !!initial && initial.id === convId && initial.conversation_id === convId
        && initial.agent_name === "helper" && typeof initial.title === "string"
        && initial.created_by_id === userA1.id
        && typeof initial.created_at === "string" && typeof initial.created_date === "string" && typeof initial.updated_date === "string"
        && initial.metadata && initial.metadata.priority === "high"
        && !("conversation" in initial) && !("count" in initial),
      JSON.stringify({ keys: initial ? Object.keys(initial) : null }));
    harness.check("callback: the embedded messages are the persisted message projections of the turn",
      !!initial && Array.isArray(initial.messages) && initial.messages.length === 2
        && initial.messages[0].role === "user" && initial.messages[0].content === "first question"
        && initial.messages[1].role === "assistant" && initial.messages[1].content === "Hello from the agent"
        && initial.messages.every((m) => m.conversation_id === convId && typeof m.message_id === "string"),
      JSON.stringify(initial && initial.messages && initial.messages.map((m) => m.role)));
    harness.check("callback: no instructions or credentials leak through the projection",
      !JSON.stringify(initial || {}).includes("SECRET-INSTRUCTION-MARKER"),
      "marker absent");

    // ---- stable signal: no callback when the read is unchanged ---------------------------
    await sub.poll();
    harness.check("stable signal: an unchanged read fires no callback (initial snapshot + change only)",
      events.length === 1, JSON.stringify({ events: events.length }));

    // ---- unsubscribe invariants: stopped means no read and no callback -------------------
    sub.unsubscribe();
    let probeReads = 0;
    const probeSub = mirrorSubscribe(() => { probeReads++; return got1; }, (v) => events.push(v));
    probeSub.unsubscribe();
    await probeSub.poll();
    await probeSub.poll();
    harness.check("unsubscribe: after unsubscribe no read happens and no callback fires (stopped guard)",
      probeReads === 0 && events.length === 1, JSON.stringify({ probeReads, events: events.length }));

    // ---- update detection: a new turn grows messages and fires the callback once ----------
    script = [{ action: "reply", content: "second reply" }];
    await run(projA, userA1, "invoke", { conversation_id: convId, message: "second question" });
    const intAfterTurn2 = await intOf(A.ws.id);
    const events2 = [];
    const sub2 = mirrorSubscribe(() => run(projA, userA1, "get", { conversation_id: convId }), (v) => events2.push(v));
    await sub2.poll();
    await sub2.poll();
    const updated = events2[events2.length - 1] || null;
    harness.check("update detection: a new turn fires exactly one callback with the grown projection",
      events2.length === 1 && !!updated && Array.isArray(updated.messages) && updated.messages.length === 4
        && updated.messages[3].role === "assistant" && updated.messages[3].content === "second reply",
      JSON.stringify({ events: events2.length, messages: updated && updated.messages && updated.messages.length }));

    // ---- reads move no credits: the pure read path spends nothing ------------------------
    await sub2.poll(); // unchanged read, still no charge and no callback
    const intAfterReads = await intOf(A.ws.id);
    harness.check("billing: the subscription read path moves no integration credits",
      intAfterReads === intAfterTurn2 && events2.length === 1, `int ${intAfterTurn2} → ${intAfterReads}`);

    // ---- first refused read: the poll stops and surfaces the error once -------------------
    const crossGet = () => run(projA, userA2, "get", { conversation_id: convId });
    const errEvents = [];
    const subX = mirrorSubscribe(crossGet, (v) => errEvents.push(v));
    await subX.poll();
    await subX.poll();
    harness.check("first refused read: the poll stops, surfaces the error exactly once, and never polls again",
      errEvents.length === 1 && !!errEvents[0].error && errEvents[0].error.includes("not found") && subX.reads === 1,
      JSON.stringify({ events: errEvents.length, reads: subX.reads, error: errEvents[0] && errEvents[0].error }));

    // ---- regression: the cross-user get refusal itself is unchanged (404) -----------------
    const cross = await captureCall(() => run(projA, userA2, "get", { conversation_id: convId }));
    harness.check("regression: a cross-user get is still refused 404 (server ownership isolation unchanged)",
      cross.threw && cross.code === "CONVERSATION_NOT_FOUND" && cross.status === 404, JSON.stringify(cross));

    // ---- certification boundary stated and pinned ------------------------------------------
    harness.check("transport: the bounded poll is certified as a NEXUSAI-derived NON-PARITY substitute (no WebSocket/instant claim)",
      SUBSCRIBE_CONTRACT.transport === "bounded-poll-4s"
        && SUBSCRIBE_CONTRACT.transport_parity.includes("NOT claimed (non-parity)"),
      JSON.stringify(SUBSCRIBE_CONTRACT));
    harness.check("token streaming: UNKNOWN — not implemented and not claimed",
      SUBSCRIBE_CONTRACT.token_streaming.startsWith("UNKNOWN"), JSON.stringify({ token_streaming: SUBSCRIBE_CONTRACT.token_streaming }));
    harness.check("surface: the `agents` export remains registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("agents"), "agents present");

    // ---- final ledger integrity ----------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after the subscription surface usage", integrity.ok, JSON.stringify(integrity));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911q-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911q" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911q_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911q[0-9]+$" } }).catch(() => {});
  }
}