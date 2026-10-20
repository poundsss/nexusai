// P-9.11E certification — in-app agent BILLING parity (Base44).
//
// Certifies the documented billing contract (docs.base44.com, "AI agents for apps" + "Credits"):
//   • POOL — "Each message sent to an in-app agent uses integration credits" (NOT message
//     credits, which Base44 reserves for building with its AI);
//   • UNIT — one charge per MESSAGE (turn), not per model step, tool call or token;
//   • SHAPE — "varies based on the model you select and the length of the response"
//     (the exact formula is UNKNOWN — no rate is invented: the canonical economics engine
//     prices the turn's real aggregated per-model usage);
//   • ANONYMOUS — "Anonymous conversations also draw integration credits from your workspace
//     pool, the same as logged-in users";
//   • INSUFFICIENT — "Any action that requires integration credits fails" (fail-closed);
//   • ATTRIBUTION — "Credits Used" on the message of the conversation transcript.
// Drives the REAL shipping modules (appAgentRuntime / appAgentChannels / appAuth / aiOperations
// / ledger / economics / primitiveHandlers) — only the model provider and the WhatsApp Cloud
// API are scripted. Every movement is asserted to run through the EXISTING canonical paths:
// ONE beginOperation/finalizeOperation turn operation in the integration pool, the P-9.2
// flat charges of executed tool primitives, and the separately certified WhatsApp relay —
// with the message pool never touched. Every fixture is scratch and removed in the finally.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity, deriveBalance } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent, MESSAGES_ENTITY } from "../../shared/appAgentRuntime.ts";
import { handleWhatsAppUpdate, WHATSAPP_TOKEN_SECRET, WHATSAPP_PHONE_NUMBER_ID_SECRET, WHATSAPP_APP_SECRET_NAME } from "../../shared/appAgentChannels.ts";
import { createPasswordlessUser, createAnonymousUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools, setProjectSecret, projectSecretResolver } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, makeRuntimeAgent, makePayloadInvoke, lastSeenSystem, waSignature, waCloudStub } from "../../shared/appAgentSuiteHelpers.ts";

const INSTRUCTIONS = "Instructions-marker-911e: help the users of this application.";
const MEM_FACT = "Billing-marker-911e the user prefers concise answers.";
const FAQ_PATH = "base44/context/faq.md";
const FAQ = "FAQ-marker-911e returns are accepted within 30 days.";
const WA_TOKEN = `wapp-911e-token-${Date.now()}-never-leak`;
const WA_APP_SECRET = `wapp-911e-appsecret-${Date.now()}`;
const WA_PHONE = "15550001234";

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = []; // every JSON handed to the caller — leakage is asserted over all of it
  const systemSeen = [];

  // ---- model provider stub: records the system, replays a scripted decision ----------------
  const calls = { llm: 0, image: 0 };
  let script = [];
  let llmFailFrom = 0; // fail every model call from this global call number on (0 = never)
  const fakeProvider = {
    async generate({ jsonSchema, system }) {
      calls.llm++;
      if (typeof system === "string" && !systemSeen.includes(system)) systemSeen.push(system);
      if (llmFailFrom > 0 && calls.llm >= llmFailFrom) throw Object.assign(new Error("model provider unavailable"), { code: "PROVIDER_UNAVAILABLE", retryable: true });
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const opts = { providerOverrides: { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider } };
  const pace = appAgentPace;
  // Retry-wrapped service-role db (test-only): every SDK call is a read, an idempotent
  // ledger/claim write or a scratch fixture, so waiting out the per-window request limit is safe.
  // The driven runtime gets the SAME retry-wrapped db, so a concurrent racer waits the window
  // out instead of failing its turn on the platform's request budget.
  const db = makeAgentSuiteDb(rawDb, pace);
  const client = {
    asServiceRole: {
      entities: db.entities,
      integrations: { Core: { GenerateImage: async () => { calls.image++; return { url: `https://cdn.test/p911e-${calls.image}.png` }; } } },
    },
  };

  // ---- the deployed agents this suite drives -------------------------------------------------
  const mkAgent = (name, extra = {}) => makeRuntimeAgent(name, extra, INSTRUCTIONS);
  const payload = {
    agents: [
      mkAgent("helper"),
      mkAgent("artist", { metadata: { app_tools: ["GenerateImage"] } }),
      mkAgent("mem", { memory_config: { enabled: true, scope: "user", include_other_conversation_context: false, instructions: null } }),
      mkAgent("ctx", { context_files: [FAQ_PATH] }),
      mkAgent("anon", { allow_anonymous_access: true }),
    ],
    entities: [], functions: [], integrations: [],
    context_files: [{ path: FAQ_PATH, content: `# FAQ\n${FAQ}\n` }],
  };

  // ---- WhatsApp Cloud API stub (the relay's provider boundary, shared suite helper) ----------
  const waHttp = waCloudStub({ phoneNumber: WA_PHONE });
  const waSig = (raw) => waSignature(WA_APP_SECRET, raw);

  const pools = makeAgentPoolTools(db, stamp, "p911e");
  const invokeAgent = makeAgentInvoke({ handleAppAgent, client, options: opts, pace, responses });
  const invoke = makePayloadInvoke(invokeAgent, payload);
  const lastSystem = () => lastSeenSystem(systemSeen);
  const asc = (a, b) => String(a.created_date).localeCompare(String(b.created_date)) || String(a.id).localeCompare(String(b.id));
  const turnRowOf = async (project, ownerId, content) =>
    ((await db.entities.AppRecord.filter({ project_id: project.id, entity_name: MESSAGES_ENTITY, owner_id: ownerId }, "created_date", 30).catch(() => []))
      .filter((r) => (r.data || {}).role === "user" && (r.data || {}).content === content).sort(asc)[0]) || null;
  const ledgerOf = async (wsId) => db.entities.CreditLedgerEntry.filter({ workspace_id: wsId }, "-created_date", 500).catch(() => []);
  const opsOf = async (wsId) => db.entities.AIOperation.filter({ workspace_id: wsId }, "-created_date", 200).catch(() => []);

  try {
    // --- fixtures: A funded both pools, B funded both pools, C funded plan + zero credits ---
    const plan = await makeBillingPlan(db, created, `p911et${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911ea${stamp}`, { plan });
    const B = await makeBillingWorkspace(db, created, `p911eb${stamp}`, { plan });
    const C = await makeBillingWorkspace(db, created, `p911ec${stamp}`, { plan }); // zero credits
    for (const f of [A, B, C]) wsIds.push(f.ws.id);
    await pace(1500);
    // The integration grant must cover two concurrent worst-case turn holds (an artist turn's
    // 6-step estimate holds ~50) plus every charged turn in the suite.
    await pools.grant(A.ws.id, "message", 300);
    await pools.grant(A.ws.id, "integration", 500);
    await pools.grant(B.ws.id, "message", 300);
    await pools.grant(B.ws.id, "integration", 100);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911e-proj-${A.user.id}-${stamp}`, slug: `p911ea-${stamp}`, rls_enabled: true });
    const projB = await db.entities.Project.create({ workspace_id: B.ws.id, name: `p911e-proj-${B.user.id}-${stamp}`, slug: `p911eb-${stamp}`, rls_enabled: true });
    const projC = await db.entities.Project.create({ workspace_id: C.ws.id, name: `p911e-proj-${C.user.id}-${stamp}`, slug: `p911ec-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id, projB.id, projC.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p911e.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p911e.test", display_name: "A2", email_verified: true });
    const userB1 = await createPasswordlessUser(db, projB, { email: "b1@p911e.test", display_name: "B1", email_verified: true });
    const userC1 = await createPasswordlessUser(db, projC, { email: "c1@p911e.test", display_name: "C1", email_verified: true });
    const userAnon = await createAnonymousUser(db, projA, {});
    await setProjectSecret(db, projA, WHATSAPP_TOKEN_SECRET, WA_TOKEN);
    await setProjectSecret(db, projA, WHATSAPP_PHONE_NUMBER_ID_SECRET, WA_PHONE);
    await setProjectSecret(db, projA, WHATSAPP_APP_SECRET_NAME, WA_APP_SECRET);
    const resolveA = projectSecretResolver(db, projA);
    const msgStart = await pools.msgOf(A.ws.id);
    const intStart = await pools.intOf(A.ws.id);
    // The runtime paths below consume the platform's per-window request budget: pause so the
    // fixtures' calls roll out of the window before the turn sequence starts.
    await pace(15000);

    // --- 1. Normal authenticated turn: pool, unit, attribution --------------------------------
    script = [{ action: "reply", content: "billing parity answer" }];
    const r1 = await invoke(projA, userA1, "helper", "hello billing");
    harness.check("1a. a normal turn replies and reports its Credits Used (integration only, no message-credits field)",
      r1.reply === "billing parity answer" && r1.usage.integration_credits >= 1 && !("message_credits" in r1.usage),
      JSON.stringify({ reply: r1.reply, usage: r1.usage }));
    harness.check("1b. the charge lands in the INTEGRATION pool; the message pool is untouched",
      (await pools.intOf(A.ws.id)) < intStart && (await pools.msgOf(A.ws.id)) === msgStart,
      `int ${intStart} → ${await pools.intOf(A.ws.id)}; msg ${msgStart} → ${await pools.msgOf(A.ws.id)}`);
    const turn1 = await turnRowOf(projA, userA1.id, "hello billing");
    const ops1 = turn1 ? (await opsOf(A.ws.id)).filter((o) => o.idempotency_key === `appagent:${turn1.id}`) : [];
    const op1 = ops1[0] || null;
    harness.check("1c. exactly ONE billable operation per turn: integration pool, completed, per-turn key",
      !!turn1 && ops1.length === 1 && op1.credit_type === "integration" && op1.status === "completed"
        && (op1.credits_charged || 0) >= 1 && (op1.routing || {}).surface === "deployed_app_agent",
      JSON.stringify(ops1.map((o) => ({ key: o.idempotency_key, type: o.credit_type, status: o.status, charged: o.credits_charged }))));
    const stepOps = (await opsOf(A.ws.id)).filter((o) => /^appagent:.*:s\d+$/.test(String(o.idempotency_key || "")));
    harness.check("1d. no per-step operations exist (the unit is the MESSAGE, not the step)",
      stepOps.length === 0, JSON.stringify(stepOps.map((o) => o.idempotency_key).slice(0, 3)));
    const led1 = turn1 ? (await ledgerOf(A.ws.id)).filter((e) => String(e.idempotency_key || "").endsWith(`appagent:${turn1.id}`)) : [];
    const charges1 = led1.filter((e) => e.event_type === "ai_charge");
    harness.check("1e. hold → settle → release through the canonical ledger, exactly one charge entry",
      led1.some((e) => e.event_type === "reservation") && led1.some((e) => e.event_type === "reservation_release")
        && charges1.length === 1 && charges1[0].credit_type === "integration" && charges1[0].amount < 0
        && Math.abs(charges1[0].amount) === (op1?.credits_charged || 0),
      JSON.stringify(led1.map((e) => ({ t: e.event_type, k: e.idempotency_key, type: e.credit_type }))));
    const replyRow1 = turn1 ? (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: MESSAGES_ENTITY, owner_id: userA1.id }, "-created_date", 10))
      .find((r) => (r.data || {}).role === "assistant" && (r.data || {}).content === "billing parity answer") : null;
    harness.check("1f. the persisted reply carries the same Credits Used the response reported (transcript attribution)",
      !!replyRow1 && (replyRow1.data || {}).usage?.integration_credits === r1.usage.integration_credits,
      JSON.stringify((replyRow1 || {}).data && replyRow1.data.usage));

    // --- 2. Insufficient integration credits: fail-closed --------------------------------------
    const llm0 = calls.llm;
    const broke = await captureCall(() => invoke(projC, userC1, "helper", "hi"));
    harness.check("2a. a zero-credit workspace is refused fail-closed before any model call",
      broke.threw && ["INSUFFICIENT_CREDITS", "BUDGET_EXCEEDED"].includes(broke.code) && calls.llm === llm0,
      JSON.stringify(broke));
    const ledgerC = await ledgerOf(C.ws.id);
    const balC = await deriveBalance(db, C.ws.id);
    const rowsC = await db.entities.AppRecord.filter({ project_id: projC.id, entity_name: MESSAGES_ENTITY }, "-created_date", 10).catch(() => []);
    // The inbound user row may persist (the caller's message is a durable record, written before
    // the turn's operation resolves its fail-closed hold) — but nothing else: no credits, no
    // stranded hold, and NO assistant answer ever exists for the refused turn.
    const repliesC = rowsC.filter((r) => (r.data || {}).role === "assistant");
    harness.check("2b. the refusal moved no credits, stranded no hold and produced no answer",
      ledgerC.length === 0 && balC.reserved === 0 && repliesC.length === 0,
      JSON.stringify({ ledger: ledgerC.length, reserved: balC.reserved, replies: repliesC.length }));

    // --- 3. Failed execution: hold/settle/release semantics --------------------------------------
    const intBefore3 = await pools.intOf(A.ws.id);
    llmFailFrom = calls.llm + 1; // the turn's very first model call fails
    const failed = await captureCall(() => invoke(projA, userA1, "helper", "this will fail"));
    llmFailFrom = 0;
    const balA3 = await deriveBalance(db, A.ws.id);
    harness.check("3a. a turn with NO delivered usage charges nothing and strands no hold",
      failed.threw && failed.code === "AGENT_MODEL_UNAVAILABLE"
        && (await pools.intOf(A.ws.id)) === intBefore3 && balA3.reserved === 0,
      JSON.stringify({ threw: failed.threw, code: failed.code, int_delta: intBefore3 - (await pools.intOf(A.ws.id)), reserved: balA3.reserved }));
    // Mid-turn failure: step 1 delivers (a granted tool executes), step 2 fails — the delivered
    // model work settles through the turn's own operation (work delivered is charged).
    const intBefore3b = await pools.intOf(A.ws.id);
    const imgBefore3b = calls.image;
    script = [{ action: "tool", tool: { name: "GenerateImage", input: { prompt: "a cat" } } }];
    llmFailFrom = calls.llm + 2; // step 1 delivers (the tool executes), the NEXT call (step 2) fails
    const midfail = await captureCall(() => invoke(projA, userA1, "artist", "draw then fail"));
    llmFailFrom = 0;
    script = [];
    const balA3b = await deriveBalance(db, A.ws.id);
    harness.check("3b. a mid-turn failure settles the delivered steps and the executed tool, hold released",
      midfail.threw && midfail.code === "AGENT_MODEL_UNAVAILABLE"
        && intBefore3b - (await pools.intOf(A.ws.id)) === 2 && calls.image - imgBefore3b === 1 && balA3b.reserved === 0,
      JSON.stringify({ threw: midfail.threw, int_delta: intBefore3b - (await pools.intOf(A.ws.id)), images: calls.image - imgBefore3b, reserved: balA3b.reserved }));

    // --- 4. Idempotency replay: exactly one charge ----------------------------------------------
    const k1 = `p911e-key-${stamp}`;
    script = [{ action: "reply", content: "keyed billing" }];
    const kr1 = await invoke(projA, userA1, "helper", "keyed turn", { idempotency_key: k1 });
    const intAfterKey = await pools.intOf(A.ws.id);
    const kr2 = await invoke(projA, userA1, "helper", "keyed turn", { idempotency_key: k1 });
    harness.check("4a. a keyed replay returns the stored reply and never double-charges",
      kr1.reply === "keyed billing" && kr2.idempotent_replay === true && kr2.message_id === kr1.message_id
        && (await pools.intOf(A.ws.id)) === intAfterKey,
      JSON.stringify({ replay: kr2.idempotent_replay, int: `${intAfterKey} → ${await pools.intOf(A.ws.id)}` }));

    // --- 5. Concurrent same-key execution: one billable message ---------------------------------
    const k2 = `p911e-conc-${stamp}`;
    // Two tool decisions then two replies: whichever way the racers interleave, each sees
    // tool → reply, the tool claim dedupes the side effect, and both finish with a reply.
    script = [
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "race" } } },
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "race" } } },
      { action: "reply", content: "race done" },
      { action: "reply", content: "race done" },
    ];
    const intBefore5 = await pools.intOf(A.ws.id);
    const imgBefore5 = calls.image;
    const [c1, c2] = await Promise.all([
      invoke(projA, userA1, "artist", "race me", { idempotency_key: k2 }),
      invoke(projA, userA1, "artist", "race me", { idempotency_key: k2 }),
    ]);
    const raceTurns = (await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: MESSAGES_ENTITY, owner_id: userA1.id }, "created_date", 30).catch(() => []))
      .filter((r) => (r.data || {}).role === "user" && (r.data || {}).invoke_key === k2);
    const raceOpKeys = [...new Set(raceTurns.map((t) => `appagent:${t.id}`))];
    const raceOps = (await opsOf(A.ws.id)).filter((o) => raceOpKeys.includes(o.idempotency_key));
    const img5 = calls.image - imgBefore5;
    const raceLedger = (await ledgerOf(A.ws.id)).filter((e) => raceOpKeys.some((k) => String(e.idempotency_key || "").endsWith(k)));
    harness.check("5a. two concurrent same-key invokes both deliver a reply",
      c1.reply === "race done" && c2.reply === "race done", JSON.stringify({ a: c1.reply, b: c2.reply }));
    // Billing invariant under concurrency: exactly ONE completed charged operation for the
    // converged turn; any concurrent duplicate row produced by the known beginOperation TOCTOU
    // ms-window must be failed/voided with charge 0 (reconciled — not duplicate billing).
    const completedOps5 = raceOps.filter((o) => o.status === "completed" && !o.voided);
    const dupOps5 = raceOps.filter((o) => o !== completedOps5[0]);
    const chargedTotal5 = raceOps.reduce((s, o) => s + (Number(o.credits_charged) || 0), 0);
    harness.check("5b. concurrent racers converge on ONE billable message: one tool charge + one per-message charge",
      intBefore5 - (await pools.intOf(A.ws.id)) === 2
        && completedOps5.length === 1 && (completedOps5[0].credits_charged || 0) >= 1
        && dupOps5.every((o) => (o.status === "failed" || o.voided === true) && (Number(o.credits_charged) || 0) === 0)
        && chargedTotal5 === completedOps5[0].credits_charged,
      JSON.stringify({
        int_delta: intBefore5 - (await pools.intOf(A.ws.id)), images: img5,
        turns: raceTurns.map((t) => ({ id: String(t.id).slice(-6), at: String(t.created_date).slice(-8) })),
        ops: raceOps.map((o) => ({ key: String(o.idempotency_key).slice(-6), status: o.status, voided: !!o.voided, charged: o.credits_charged })),
        charged_total: chargedTotal5,
      }));
    harness.check("5c. the single turn operation settled exactly once (no duplicate charge entries)",
      raceLedger.filter((e) => e.event_type === "ai_charge" && !e.voided).length === 1,
      JSON.stringify(raceLedger.filter((e) => e.event_type === "ai_charge").map((e) => ({ k: String(e.idempotency_key).slice(-12), voided: !!e.voided, amount: e.amount }))));

    // --- 6. Anonymous billing: the workspace integration pool, same identity -------------------
    const intBefore6 = await pools.intOf(A.ws.id);
    const msgBefore6 = await pools.msgOf(A.ws.id);
    script = [{ action: "reply", content: "anon billing" }];
    const rAnon = await invoke(projA, null, "anon", "hi anon", {}, { user: userAnon });
    const anonTurn = await turnRowOf(projA, userAnon.id, "hi anon");
    const anonCharge = anonTurn ? (await ledgerOf(A.ws.id)).find((e) => String(e.idempotency_key || "") === `charge:appagent:${anonTurn.id}`) : null;
    harness.check("6a. an anonymous turn charges the workspace INTEGRATION pool exactly like a logged-in turn",
      rAnon.reply === "anon billing" && intBefore6 - (await pools.intOf(A.ws.id)) === 1 && (await pools.msgOf(A.ws.id)) === msgBefore6,
      `int ${intBefore6} → ${await pools.intOf(A.ws.id)}`);
    harness.check("6b. the anonymous charge carries the SAME workspace billing identity as logged-in turns",
      !!anonCharge && anonCharge.workspace_id === A.ws.id && anonCharge.credit_type === "integration",
      JSON.stringify(anonCharge && { ws: anonCharge.workspace_id, type: anonCharge.credit_type }));

    // --- 7. Tool-assisted execution: the turn charge + the certified P-9.2 flat charge ----------
    const intBefore7 = await pools.intOf(A.ws.id);
    script = [
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "bill art" } } },
      { action: "reply", content: "art done" },
    ];
    const rArt = await invoke(projA, userA1, "artist", "draw for billing");
    const led7 = await ledgerOf(A.ws.id);
    const p92 = led7.filter((e) => String(e.idempotency_key || "").startsWith("intchg:"));
    harness.check("7a. a tool turn charges the flat P-9.2 tool credit beside the per-message charge — nothing more",
      rArt.reply === "art done" && rArt.usage.tool_calls === 1 && rArt.usage.integration_credits === 2
        && intBefore7 - (await pools.intOf(A.ws.id)) === 2,
      JSON.stringify({ usage: rArt.usage, int_delta: intBefore7 - (await pools.intOf(A.ws.id)) }));
    harness.check("7b. the tool charge rides the P-9.2 intchg ledger path, distinct from the turn's appagent path",
      p92.some((e) => e.credit_type === "integration" && e.event_type === "ai_charge")
        && !p92.some((e) => String(e.idempotency_key || "").includes("appagent:")),
      JSON.stringify([...new Set(p92.map((e) => e.idempotency_key))].slice(0, 3)));

    // --- 8. Memory-assisted execution: no memory tariff -----------------------------------------
    const intBefore8 = await pools.intOf(A.ws.id);
    script = [
      { action: "memory", memory: { statement: MEM_FACT } },
      { action: "reply", content: "mem noted" },
    ];
    const rMem = await invoke(projA, userA1, "mem", "remember my preference");
    const memRows = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_memories", owner_id: userA1.id }, "-created_date", 10).catch(() => []);
    harness.check("8a. a memory save adds NO charge: one per-message credit, the fact stored, no memory-scoped ledger key",
      rMem.reply === "mem noted" && memRows.some((r) => (r.data || {}).statement === MEM_FACT)
        && intBefore8 - (await pools.intOf(A.ws.id)) === 1
        && !(await ledgerOf(A.ws.id)).some((e) => String(e.idempotency_key || "").includes("memory")),
      `int delta ${intBefore8 - (await pools.intOf(A.ws.id))}`);

    // --- 9. Context-file execution: no context tariff -------------------------------------------
    const intBefore9 = await pools.intOf(A.ws.id);
    script = [{ action: "reply", content: "ctx ok" }];
    const rCtx = await invoke(projA, userA1, "ctx", "what is the faq?");
    harness.check("9a. a context-file turn injects the reference material and charges only the per-message credit",
      rCtx.reply === "ctx ok" && lastSystem().includes(FAQ) && intBefore9 - (await pools.intOf(A.ws.id)) === 1,
      `int delta ${intBefore9 - (await pools.intOf(A.ws.id))}; context_in_system=${lastSystem().includes(FAQ)}`);

    // --- 10. Cross-user / cross-project / cross-workspace isolation ------------------------------
    const intA10 = await pools.intOf(A.ws.id);
    const msgA10 = await pools.msgOf(A.ws.id);
    script = [{ action: "reply", content: "a2 ok" }];
    await invoke(projA, userA2, "helper", "second user turn");
    harness.check("10a. another user's turn charges the same project workspace, message pool untouched",
      intA10 - (await pools.intOf(A.ws.id)) === 1 && (await pools.msgOf(A.ws.id)) === msgA10,
      `int delta ${intA10 - (await pools.intOf(A.ws.id))}`);
    const intA10b = await pools.intOf(A.ws.id);
    const intB10 = await pools.intOf(B.ws.id);
    const msgB10 = await pools.msgOf(B.ws.id);
    script = [{ action: "reply", content: "b ok" }];
    await invoke(projB, userB1, "helper", "hello from B");
    harness.check("10b. another workspace's turn charges ONLY that workspace's integration pool",
      intB10 - (await pools.intOf(B.ws.id)) === 1 && (await pools.intOf(A.ws.id)) === intA10b
        && (await pools.msgOf(B.ws.id)) === msgB10,
      `B int ${intB10} → ${await pools.intOf(B.ws.id)}; A int unchanged`);
    const ledA = await ledgerOf(A.ws.id);
    const ledB = await ledgerOf(B.ws.id);
    harness.check("10c. ledger rows never cross workspaces",
      ledA.every((e) => e.workspace_id === A.ws.id) && ledB.every((e) => e.workspace_id === B.ws.id)
        && ledA.length > 0 && ledB.length > 0,
      `A=${ledA.length} rows, B=${ledB.length} rows`);

    // --- 11. WhatsApp relay billing unchanged (P-9.10C preserved) --------------------------------
    const intBefore11 = await pools.intOf(A.ws.id);
    const waRaw = JSON.stringify({
      entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.p911e.${stamp}`, type: "text", from: "15550009999", text: { body: "unlinked hello" } }] } }] }],
    });
    const waSigHeader = await waSig(waRaw);
    const waRes = await captureCall(() => handleWhatsAppUpdate(client, {
      project: projA, payload, update: JSON.parse(waRaw), agentName: "helper",
      signatureHeader: waSigHeader, rawBody: waRaw, resolveSecret: resolveA, http: waHttp, options: opts,
    }));
    const led11 = (await ledgerOf(A.ws.id)).filter((e) => !ledA.some((x) => x.id === e.id));
    const relay11 = led11.filter((e) => String(e.idempotency_key || "").includes(":whatsapp:"));
    harness.check("11a. an unlinked chat of a non-anonymous agent keeps the certified refusal (no agent run)",
      waRes.threw && waRes.code === "CHANNEL_NOT_LINKED", JSON.stringify(waRes));
    harness.check("11b. the relay charges exactly its certified inbound rate and creates NO per-message agent charge",
      intBefore11 - (await pools.intOf(A.ws.id)) === 1
        && !led11.some((e) => String(e.idempotency_key || "").includes("appagent:")),
      `int delta ${intBefore11 - (await pools.intOf(A.ws.id))}`);
    harness.check("11c. the relay movement ran through the CERTIFIED P-9.2 ledger path (hold/charge/release, integration pool)",
      relay11.some((e) => e.idempotency_key.endsWith(":hold")) && relay11.some((e) => e.idempotency_key.endsWith(":charge"))
        && relay11.some((e) => e.idempotency_key.endsWith(":release"))
        && relay11.every((e) => (e.credit_type || "message") === "integration"),
      JSON.stringify(relay11.map((e) => e.idempotency_key)));

    // --- 12. Integrity, non-duplication of P-9.4 message billing, leakage -------------------------
    harness.check("12a. the message pool NEVER moved across the whole suite (P-9.4 message billing untouched)",
      (await pools.msgOf(A.ws.id)) === 300, `msg ${await pools.msgOf(A.ws.id)}`);
    harness.check("12b. every appagent ledger movement is integration-typed (no second pool path)",
      ledA.concat(ledB).filter((e) => String(e.idempotency_key || "").includes("appagent:"))
        .every((e) => e.credit_type === "integration"),
      "appagent entries all integration");
    const allLedger = ledA.concat(ledB);
    // Voided rows are the certified losers of a duplicate-key race — excluded from every
    // balance derivation by construction, so only live rows count against duplication.
    const keys12 = allLedger.filter((e) => !e.voided).map((e) => e.idempotency_key).filter(Boolean);
    const dups12 = keys12.filter((k, i) => keys12.indexOf(k) !== i);
    harness.check("12c. no duplicate ledger idempotency keys anywhere (no double charge)",
      dups12.length === 0, JSON.stringify(dups12.slice(0, 3)));
    const respJson = JSON.stringify(responses);
    harness.check("12d. no instructions marker, credential or system-prompt content in any response or ledger row",
      !respJson.includes(INSTRUCTIONS) && !respJson.includes(WA_TOKEN)
        && !JSON.stringify(allLedger).includes(INSTRUCTIONS),
      `responses scanned: ${responses.length}`);
    const integrityA = await verifyBalanceIntegrity(db, A.ws.id);
    const integrityB = await verifyBalanceIntegrity(db, B.ws.id);
    const balB12 = await deriveBalance(db, B.ws.id);
    harness.check("12e. ledger integrity holds and no hold is stranded after successes AND failures",
      integrityA.ok && integrityB.ok && balA3.reserved === 0 && balA3b.reserved === 0 && balB12.reserved === 0,
      JSON.stringify({ A: integrityA.ok, B: integrityB.ok, reservedB: balB12.reserved }));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400), ...s }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by name pattern, including residue from earlier runs.
    llmFailFrom = 0;
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911e-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911e[a-c]" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppIdentity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppSession.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.ProjectSecret.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AuditLog.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.PrimitiveInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.FunctionInvocation.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    await db.entities.CacheEntry.deleteMany({ namespace: "appagent_tools" }).catch(() => {});
    await db.entities.CacheEntry.deleteMany({ namespace: "appagent_memory" }).catch(() => {});
    await db.entities.CacheEntry.deleteMany({ namespace: "whatsapp_replay" }).catch(() => {});
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911et[0-9]+$" } }).catch(() => {});
  }
}