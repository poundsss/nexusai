// P-9.11C certification — per-agent anonymous access for deployed in-app agents (Base44 parity).
//
// Drives the REAL shipping modules (agentResource / appAuth / appAgentRuntime / appData /
// functionRuntime / appAgentChannels / the canonical ledger paths) — only the model provider
// and the Telegram/WhatsApp APIs are scripted. Certifies the Base44-documented contract:
//   allow_anonymous_access: boolean owned key, OFF by default, per agent —
//   "visitors can chat with the agent without signing in, on the web and on connected
//    channels (WhatsApp and Telegram)"; "Anonymous users can't access per-user private data";
//   "Anonymous conversations also draw credits from your workspace pool, the same as
//    logged-in users".
// Across: contract validation + default + round-trip, the anonymous identity primitives,
// the per-agent gate (off → the exact certified 401; on → create/invoke/get/list), isolation
// (anonymous↔anonymous, anonymous↔user, cross-project), per-user private data (RLS
// fail-closed for entity data, public data on a non-RLS project, function tools with NO user),
// memory isolation, idempotency, billing (the EXISTING P-9.4 path only — no second ledger
// branch; relay tariffs unchanged), the Telegram/WhatsApp anonymous channel paths, and
// redaction. Every fixture is scratch and removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { parseAgentDocument, agentDocumentContent } from "../../shared/agentResource.ts";
import {
  handleAppAgent, CONVERSATIONS_ENTITY, MESSAGES_ENTITY, MEMORIES_ENTITY, MEMORY_GLOBAL_OWNER,
} from "../../shared/appAgentRuntime.ts";
import {
  createPasswordlessUser, createSession, createAnonymousSession, resolveAnonymousSession, isAnonymousUser,
} from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools, setProjectSecret, projectSecretResolver } from "../../shared/appAgentTestFixtures.ts";
import { makeAgentSuiteDb, makeAgentInvoke, lastMessageText, lastSeenSystem, waSignature, waCloudStub } from "../../shared/appAgentSuiteHelpers.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";
import {
  handleTelegramUpdate, handleWhatsAppUpdate, TELEGRAM_BOT_TOKEN_SECRET, TELEGRAM_WEBHOOK_SECRET_NAME,
  WHATSAPP_TOKEN_SECRET, WHATSAPP_PHONE_NUMBER_ID_SECRET, WHATSAPP_APP_SECRET_NAME, WHATSAPP_RELAY_CREDITS,
} from "../../shared/appAgentChannels.ts";
import { findIdentity } from "../../shared/appOAuth.ts";

const INSTRUCTIONS = "Instructions-marker-911c: help visitors of this application.";
const TG_GREET = "Welcome, anonymous visitor (p911c)";
const WA_GREET = "Welcome on WhatsApp (p911c)";
const MEM_ANON = "Anonymous fact-marker-911c: the visitor likes tea.";
const MEM_GLOBAL = "Global fact-marker-911c: the office is closed on Fridays.";
const STAMP = Date.now();
const BOT_TOKEN = `911c${STAMP}:tg-bot-token-never-leak`;
const WEBHOOK_SECRET = `911c-wh-${STAMP}`;
const WA_APP_SECRET = `911c-wa-app-${STAMP}`;
const WA_TOKEN = `911c-wa-token-${STAMP}`;
const WA_PHONE = "15550001234";
const WA_FROM = "15550007777";
const WA_FROM_CLOSED = "15550008888";
const CHAT_ANON = 501234901;
const CHAT_CLOSED = 501234902;
const FN_SOURCE = [
  "export const config = {};",
  "export default async function (ctx) {",
  "  return { status: 200, body: { ok: true, user_id: ctx.user ? ctx.user.id : null } };",
  "};",
].join("\n");
const FUNCTIONS = [{ name: "add_note", path: "functions/add_note.js", source: FN_SOURCE }];

export default async function (req) {
  const rawDb = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = []; // every JSON handed to the caller — redaction is asserted over all of it

  // ---- model provider stub: records every system + message batch, replays a scripted decision ----
  const calls = { llm: 0 };
  const systemSeen = [];
  const seen = [];
  let script = [];
  const fakeProvider = {
    async generate({ messages, jsonSchema, system }) {
      calls.llm++;
      if (typeof system === "string") systemSeen.push(system);
      if (Array.isArray(messages)) seen.push(messages);
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const opts = { providerOverrides };

  // ---- Telegram API stub: records every call (method, token, chat id, text) ----
  const tgCalls = [];
  const tgHttp = async (url, init = {}) => {
    const u = new URL(String(url));
    const m = u.pathname.match(/^\/bot(.+)\/(getMe|sendMessage)$/);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (!m) return new Response(JSON.stringify({ ok: false, description: "unknown method" }), { status: 404 });
    tgCalls.push({ method: m[2], token: m[1], chat_id: body.chat_id ?? null, text: body.text ?? null });
    if (m[2] === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "p911c_cert_bot" } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: tgCalls.length } }), { status: 200 });
  };

  // ---- WhatsApp API stub: records every outbound message ----
  const waCalls = [];
  let waMsgSeq = 0;
  const waHttp = waCloudStub({
    phoneNumber: WA_PHONE,
    onSend: (m) => { waCalls.push(m); return `wamid.p911c.${++waMsgSeq}`; },
  });
  const waSig = (raw) => waSignature(WA_APP_SECRET, raw);

  // ---- the deployed agents this suite drives, parsed through the REAL parser ----
  const docOf = (name, over = {}) => parseAgentDocument(agentFilePath(name), JSON.stringify({
    name, display_name: name, description: "test agent", instructions: INSTRUCTIONS,
    tools: [], skills: [], model_tier: "fast", max_steps: 6, ...over,
  }, null, 2));
  const TASK = { name: "task", fields: { title: { type: "string", required: true } } };
  const AGENTS = [
    docOf("closed").agent,
    docOf("open", { allow_anonymous_access: true, whatsapp_greeting: WA_GREET }).agent,
    docOf("openglobal", { allow_anonymous_access: true, memory_config: { enabled: true, scope: "global", include_other_conversation_context: false, instructions: null } }).agent,
    docOf("opentools", {
      allow_anonymous_access: true, telegram_greeting: TG_GREET,
      tool_configs: [{ entity_name: "task", allowed_operations: ["create", "read"] }, { function_name: "add_note", description: "Record a note" }],
    }).agent,
  ];
  const payload = { agents: AGENTS, entities: [TASK], functions: FUNCTIONS, integrations: [] };

  const pace = appAgentPace;
  // Retry-wrapped service-role db (test-only): every SDK call is a read, an idempotent
  // ledger/claim write or a scratch fixture, so waiting out the per-window request limit is safe.
  const db = makeAgentSuiteDb(rawDb, pace);
  const pools = makeAgentPoolTools(db, stamp, "p911c");
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };

  const lastSystem = () => lastSeenSystem(systemSeen);
  const lastMsg = (needle) => lastMessageText(seen, needle);
  const invokeAgent = makeAgentInvoke({ handleAppAgent, client, options: opts, pace, responses });
  const invoke = (project, user, name, message, extra = {}, anonymous = null) =>
    invokeAgent({ project, payload, user, anonymous, name, message, extra });
  const agentOp = async (op, args, { project, user = null, anonymous = null } = {}) => {
    await pace(400);
    const r = await handleAppAgent(client, { project, payload, user, anonymous, op, args });
    responses.push(r);
    return r;
  };
  const convRows = (project, owner) => db.entities.AppRecord.filter(
    { project_id: project.id, entity_name: CONVERSATIONS_ENTITY, ...(owner ? { owner_id: owner } : {}) }, "-created_date", 50,
  ).catch(() => []);

  try {
    // --- fixtures: two funded workspaces; projA (RLS on), projOpen (RLS off), projB (RLS on) ---
    const plan = await makeBillingPlan(db, created, `p911ct${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911ca${stamp}`, { plan });
    const B = await makeBillingWorkspace(db, created, `p911cb${stamp}`, { plan });
    for (const f of [A, B]) wsIds.push(f.ws.id);
    await pace(1500);
    await pools.grant(A.ws.id, "message", 300);
    await pools.grant(A.ws.id, "integration", 50);
    await pools.grant(B.ws.id, "message", 100);
    await pace(1500);
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911c-proj-${A.user.id}-${stamp}`, slug: `p911ca-${stamp}`, rls_enabled: true });
    const projOpen = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p911c-open-${A.user.id}-${stamp}`, slug: `p911co-${stamp}` });
    const projB = await db.entities.Project.create({ workspace_id: B.ws.id, name: `p911c-projb-${B.user.id}-${stamp}`, slug: `p911cb-${stamp}`, rls_enabled: true });
    projectIds.push(projA.id, projOpen.id, projB.id);
    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p911c.test", display_name: "A1", email_verified: true });
    await setProjectSecret(db, projA, TELEGRAM_BOT_TOKEN_SECRET, BOT_TOKEN);
    await setProjectSecret(db, projA, TELEGRAM_WEBHOOK_SECRET_NAME, WEBHOOK_SECRET);
    await setProjectSecret(db, projA, WHATSAPP_TOKEN_SECRET, WA_TOKEN);
    await setProjectSecret(db, projA, WHATSAPP_PHONE_NUMBER_ID_SECRET, WA_PHONE);
    await setProjectSecret(db, projA, WHATSAPP_APP_SECRET_NAME, WA_APP_SECRET);
    const resolveA = projectSecretResolver(db, projA);
    const userSession = await createSession(db, projA, userA1);
    const anon1 = await createAnonymousSession(db, projA);
    const anon2 = await createAnonymousSession(db, projA);
    const anonOpen = await createAnonymousSession(db, projOpen);
    const tgHook = ({ text, chat, agent }) =>
      handleTelegramUpdate(client, { project: projA, payload, update: { update_id: ++waMsgSeq + Date.now(), message: { chat: { id: chat }, text } }, agentName: agent, secretTokenHeader: WEBHOOK_SECRET, resolveSecret: resolveA, http: tgHttp, options: opts });
    const waHook = async ({ text, from, agent }) => {
      const update = { entry: [{ changes: [{ field: "messages", value: { messages: [{ id: `wamid.p911c.${++waMsgSeq}`, type: "text", from, text: { body: text } }] } }] }] };
      const raw = JSON.stringify(update);
      return handleWhatsAppUpdate(client, { project: projA, payload, update, agentName: agent, signatureHeader: await waSig(raw), rawBody: raw, resolveSecret: resolveA, http: waHttp, options: opts });
    };
    // The runtime paths below consume the platform's per-window request budget: pause so the
    // fixtures' calls roll out of the window before the turn sequence starts.
    await pace(15000);

    // --- A. Contract (pure parsing — no platform requests) -------------------------------------
    const ap = (over) => parseAgentDocument(agentFilePath("closed"), JSON.stringify({ instructions: "x", ...over }, null, 2));
    const c0 = ap({});
    harness.check("1a. an agent with NO allow_anonymous_access normalizes to the documented default (OFF)",
      c0.ok && c0.agent.allow_anonymous_access === false, c0.error || JSON.stringify(c0.agent && c0.agent.allow_anonymous_access));
    const c1 = ap({ allow_anonymous_access: true });
    harness.check("1b. allow_anonymous_access: true parses as a boolean owned key",
      c1.ok && c1.agent.allow_anonymous_access === true, c1.error || "");
    const c2 = ap({ allow_anonymous_access: "yes" });
    harness.check("1c. a non-boolean allow_anonymous_access is refused", !c2.ok && /allow_anonymous_access/.test(c2.error || ""), c2.error || "");
    const c3 = ap({ allow_anonymous_access: true, mystery: 1 });
    harness.check("1d. allow_anonymous_access never leaks into loose metadata (unknown keys still do)",
      c3.ok && c3.agent.metadata?.mystery === 1 && c3.agent.metadata?.allow_anonymous_access === undefined,
      c3.error || JSON.stringify(c3.agent && c3.agent.metadata));
    const rt = parseAgentDocument(agentFilePath("closed"), agentDocumentContent(c1.agent));
    const rt0 = parseAgentDocument(agentFilePath("closed"), agentDocumentContent(c0.agent));
    harness.check("1e. the canonical document round-trips the toggle (true kept, default emits no key)",
      rt.ok && rt.agent.allow_anonymous_access === true && rt0.ok && rt0.agent.allow_anonymous_access === false,
      rt.error || rt0.error || "");

    // --- B. Anonymous identity primitives --------------------------------------------------------
    harness.check("2a. a minted anonymous identity is a credential-less, email-less AppUser with a session",
      isAnonymousUser(anon1.user) && anon1.user.email == null && anon1.user.password_hash == null
        && anon1.user.profile?.anonymous === true && /^[a-f0-9]{64}$/.test(anon1.token) && anon1.session.status === "active"
        && !isAnonymousUser(userA1),
      JSON.stringify({ email: anon1.user.email, anon: anon1.user.profile?.anonymous }));
    const r2b = await resolveAnonymousSession(db, projA, anon1.token);
    harness.check("2b. resolveAnonymousSession resolves the token to the same anonymous user",
      !!r2b && r2b.user.id === anon1.user.id, r2b ? r2b.user.id : "null");
    const r2c = await resolveAnonymousSession(db, projA, userSession.token);
    harness.check("2c. a REAL user's session token never resolves on the anonymous path (no identity laundering)",
      r2c === null, JSON.stringify(r2c && r2c.user && r2c.user.id));
    const r2d = await resolveAnonymousSession(db, projB, anon1.token);
    harness.check("2d. cross-project: project A's anonymous token never resolves in project B",
      r2d === null, JSON.stringify(r2d && r2d.user && r2d.user.id));

    // --- C. The per-agent gate --------------------------------------------------------------------
    const llm0 = calls.llm;
    const g1 = await captureCall(() => agentOp("create", { agent_name: "closed" }, { project: projA }));
    harness.check("3a. no identity at all is refused exactly as before (401, no model step)",
      g1.threw && g1.code === "AGENT_AUTH_REQUIRED" && g1.status === 401 && calls.llm === llm0, JSON.stringify(g1));
    const g2 = await captureCall(() => agentOp("create", { agent_name: "closed" }, { project: projA, anonymous: { user: anon1.user } }));
    harness.check("3b. an anonymous identity is refused for an agent WITHOUT the toggle (per-agent gate)",
      g2.threw && g2.code === "AGENT_AUTH_REQUIRED" && g2.status === 401 && calls.llm === llm0, JSON.stringify(g2));
    script = [{ action: "reply", content: "never" }];
    const g3 = await captureCall(() => invoke(projA, null, "closed", "hello", {}, { user: anon1.user }));
    harness.check("3c. invoke on a non-anonymous agent is refused for the anonymous identity",
      g3.threw && g3.code === "AGENT_AUTH_REQUIRED" && calls.llm === llm0, JSON.stringify(g3));
    const g4 = await captureCall(() => invoke(projA, null, "open", "hello", {}, null));
    harness.check("3d. the open agent still refuses NO identity (minting is the public runtime's contract)",
      g4.threw && g4.code === "AGENT_AUTH_REQUIRED" && calls.llm === llm0, JSON.stringify(g4));
    const conv1 = await agentOp("create", { agent_name: "open" }, { project: projA, anonymous: { user: anon1.user } });
    const ownerRows1 = await convRows(projA, anon1.user.id);
    harness.check("3e. createConversation works for the anonymous identity on an open agent (owned by it)",
      conv1.conversation?.conversation_id && ownerRows1.some((r) => r.id === conv1.conversation.conversation_id),
      JSON.stringify(conv1).slice(0, 120));
    script = [{ action: "reply", content: "anon web reply" }];
    const r3f = await invoke(projA, null, "open", "hi from anonymous", { conversation_id: conv1.conversation.conversation_id }, { user: anon1.user });
    const msgs1 = await agentOp("messages", { conversation_id: conv1.conversation.conversation_id }, { project: projA, anonymous: { user: anon1.user } });
    harness.check("3f. addMessage + messages work for the anonymous identity (P-9.4 path, owner-scoped)",
      r3f.reply === "anon web reply" && msgs1.count >= 2 && msgs1.messages.every((m) => m.conversation_id === conv1.conversation.conversation_id),
      JSON.stringify({ reply: r3f.reply, count: msgs1.count }));
    script = [{ action: "reply", content: "user reply" }];
    const r3g = await invoke(projA, userA1, "open", "hello from a user");
    harness.check("3g. the authenticated path on the same agent is UNCHANGED",
      r3g.reply === "user reply", JSON.stringify(r3g).slice(0, 120));

    // --- D. Isolation ------------------------------------------------------------------------------
    const convUser = await agentOp("create", { agent_name: "open" }, { project: projA, user: userA1 });
    const anon2List = await agentOp("conversations", {}, { project: projA, anonymous: { user: anon2.user } });
    harness.check("4a. one anonymous identity never lists another's conversations",
      !anon2List.conversations.some((c) => c.conversation_id === conv1.conversation.conversation_id)
        && !anon2List.conversations.some((c) => c.conversation_id === convUser.conversation.conversation_id),
      JSON.stringify(anon2List.conversations.map((c) => c.conversation_id)));
    const g4b = await captureCall(() => agentOp("get", { conversation_id: conv1.conversation.conversation_id }, { project: projA, anonymous: { user: anon2.user } }));
    harness.check("4b. get: another anonymous identity sees a foreign conversation as NOT FOUND",
      g4b.threw && g4b.code === "CONVERSATION_NOT_FOUND", JSON.stringify(g4b));
    const g4c = await captureCall(() => agentOp("get", { conversation_id: conv1.conversation.conversation_id }, { project: projA, user: userA1 }));
    harness.check("4c. an authenticated user cannot read an anonymous conversation",
      g4c.threw && g4c.code === "CONVERSATION_NOT_FOUND", JSON.stringify(g4c));
    const g4d = await captureCall(() => agentOp("get", { conversation_id: convUser.conversation.conversation_id }, { project: projA, anonymous: { user: anon1.user } }));
    harness.check("4d. the anonymous identity cannot read a user's conversation",
      g4d.threw && g4d.code === "CONVERSATION_NOT_FOUND", JSON.stringify(g4d));
    const g4e = await captureCall(() => agentOp("conversations", { agent: "open" }, { project: projB, anonymous: { user: anon1.user } }));
    const bConvs = g4e.threw ? null : g4e.value;
    harness.check("4e. cross-project: the anonymous identity sees nothing under another project's scope",
      (!g4e.threw && (bConvs.conversations || []).length === 0) || (g4e.threw && g4e.code === "AGENT_AUTH_REQUIRED"),
      JSON.stringify(g4e.threw ? g4e.code : bConvs.count));

    // --- E. Per-user private data + tools (P-9.11A contract, fail-closed) --------------------------
    script = [
      { action: "tool", tool: { name: "entity_task_create", input: { data: { title: "ANON-RLS" } } } },
      { action: "tool", tool: { name: "entity_task_read", input: {} } },
      { action: "reply", content: "rls done" },
    ];
    const r5a = await invoke(projA, null, "opentools", "try to write private data", {}, { user: anon1.user });
    const rlsTasks = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "task" }, "-created_date", 50).catch(() => []);
    harness.check("5a. RLS project: the anonymous entity tool is refused fail-closed and writes nothing",
      r5a.reply === "rls done" && rlsTasks.length === 0 && lastMsg("AUTH_REQUIRED").length > 0,
      `${rlsTasks.length} row(s); obs: ${lastMsg("AUTH_REQUIRED").slice(0, 80)}`);
    script = [
      { action: "tool", tool: { name: "entity_task_create", input: { data: { title: "ANON-PUBLIC" } } } },
      { action: "tool", tool: { name: "entity_task_read", input: {} } },
      { action: "tool", tool: { name: "function_add_note", input: {} } },
      { action: "reply", content: "open done" },
    ];
    const r5b = await invoke(projOpen, null, "opentools", "write public data and call the function", {}, { user: anonOpen.user });
    const openTasks = await db.entities.AppRecord.filter({ project_id: projOpen.id, entity_name: "task" }, "-created_date", 50).catch(() => []);
    const fnObs = lastMsg("[tool function_add_note result]");
    harness.check("5b. non-RLS project: the anonymous entity tool serves the app's public data",
      r5b.reply === "open done" && openTasks.length === 1 && (openTasks[0].data || {}).title === "ANON-PUBLIC"
        && lastMsg("[tool entity_task_read result]").includes("ANON-PUBLIC"),
      JSON.stringify(openTasks.map((r) => (r.data || {}).title)));
    const fnInv = await db.entities.FunctionInvocation.filter({ project_id: projOpen.id, function_name: "add_note" }, "-created_date", 10).catch(() => []);
    harness.check("5c. the backend-function tool runs for the anonymous actor with ctx.user = null (existing runtime)",
      fnObs.includes('"user_id":null') && fnInv.length >= 1 && fnInv[0].status === 200,
      `${fnObs.slice(0, 90)} inv=${fnInv.length}`);

    // --- F. Memory isolation (P-9.11B contract) ------------------------------------------------------
    script = [
      { action: "memory", memory: { statement: MEM_ANON } },
      { action: "reply", content: "mem noted" },
    ];
    const r6a = await invoke(projA, null, "open", "remember my preference", {}, { user: anon1.user });
    const memRows1 = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: MEMORIES_ENTITY, owner_id: anon1.user.id }, "-created_date", 50).catch(() => []);
    harness.check("6a. the anonymous identity saves user-scoped memory under its own owner",
      r6a.reply === "mem noted" && memRows1.length === 1 && (memRows1[0].data || {}).statement === MEM_ANON && (memRows1[0].data || {}).scope === "user",
      JSON.stringify(memRows1.map((r) => ({ scope: (r.data || {}).scope, s: String((r.data || {}).statement).slice(0, 30) }))));
    script = [{ action: "reply", content: "ok" }];
    await invoke(projA, null, "open", "what do you know about me?", {}, { user: anon2.user });
    harness.check("6b. another anonymous identity never sees the first one's memory",
      !lastSystem().includes(MEM_ANON), "anon2's system lacks anon1's fact");
    script = [{ action: "reply", content: "ok" }];
    await invoke(projA, userA1, "open", "what do you know?");
    harness.check("6c. an authenticated user never sees an anonymous identity's memory",
      !lastSystem().includes(MEM_ANON), "user's system lacks the anonymous fact");
    script = [
      { action: "memory", memory: { statement: MEM_GLOBAL } },
      { action: "reply", content: "global noted" },
    ];
    await invoke(projA, null, "openglobal", "remember a shared fact", {}, { user: anon1.user });
    const globalRows = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: MEMORIES_ENTITY, owner_id: MEMORY_GLOBAL_OWNER }, "-created_date", 50).catch(() => []);
    harness.check("6d. a scope-global agent writes to the shared global store (semantics unchanged)",
      globalRows.length === 1 && (globalRows[0].data || {}).statement === MEM_GLOBAL && (globalRows[0].data || {}).scope === "global",
      JSON.stringify(globalRows.map((r) => ({ owner: r.owner_id, scope: (r.data || {}).scope }))));
    script = [{ action: "reply", content: "hi" }];
    await invoke(projA, userA1, "openglobal", "what is shared?");
    harness.check("6e. global memory saved by an anonymous identity is shared exactly as before",
      lastSystem().includes(MEM_GLOBAL), "user sees the global fact");

    // --- G. Idempotency --------------------------------------------------------------------------------
    const k = `p911c-key-${stamp}`;
    script = [{ action: "reply", content: "keyed anon" }];
    await invoke(projA, null, "open", "keyed turn", { idempotency_key: k }, { user: anon1.user });
    const llmA = calls.llm;
    script = [{ action: "reply", content: "SHOULD-NOT-RUN" }];
    const replay = await invoke(projA, null, "open", "keyed turn", { idempotency_key: k }, { user: anon1.user });
    harness.check("7a. a keyed anonymous turn replays idempotently (no duplicate reply, no new model step)",
      replay.idempotent_replay === true && replay.reply === "keyed anon" && calls.llm === llmA,
      JSON.stringify({ replayed: replay.idempotent_replay, reply: replay.reply }));

    // --- H. Billing (variant A: the EXISTING P-9.4 path only) -------------------------------------------
    const ledger = await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "-created_date", 500).catch(() => []);
    const keys = ledger.map((r) => r.idempotency_key).filter(Boolean);
    const dups = keys.filter((kx, i) => keys.indexOf(kx) !== i);
    harness.check("8a. the per-message charge moved for anonymous turns through the EXISTING path (appagent: keys)",
      ledger.some((r) => String(r.idempotency_key || "").includes("appagent:")), "appagent: entries present");
    harness.check("8b. no duplicate ledger idempotency keys and no second ledger branch (variant A)",
      dups.length === 0 && ledger.filter((r) => r.idempotency_key
        && !String(r.idempotency_key).includes("appagent:")
        && !String(r.idempotency_key).startsWith("p911c:")
        && !String(r.idempotency_key).includes(":whatsapp:")).length === 0,
      JSON.stringify(dups.slice(0, 3)));
    harness.check("8c. web anonymous turns draw INTEGRATION credits from the workspace pool, message pool untouched (documented parity)",
      (await pools.intOf(A.ws.id)) < 50 && (await pools.msgOf(A.ws.id)) === 300,
      `int 50 → ${await pools.intOf(A.ws.id)}; msg 300 → ${await pools.msgOf(A.ws.id)}`);

    // --- I. Telegram anonymous path -----------------------------------------------------------------------
    const intT0 = await pools.intOf(A.ws.id);
    const llmT0 = calls.llm;
    const g9a = await captureCall(() => tgHook({ text: "hello", chat: CHAT_CLOSED, agent: "closed" }));
    harness.check("9a. an unlinked chat of a non-anonymous agent keeps the exact certified refusal",
      g9a.threw && g9a.code === "CHANNEL_NOT_LINKED" && calls.llm === llmT0, JSON.stringify(g9a));
    script = [
      { action: "tool", tool: { name: "entity_task_create", input: { data: { title: "ANON-TG" } } } },
      { action: "reply", content: "tg anon reply" },
    ];
    const r9b = await tgHook({ text: "hi agent", chat: CHAT_ANON, agent: "opentools" });
    responses.push(r9b);
    const tgIdentity = await findIdentity(db, projA, "telegram", String(CHAT_ANON));
    const tgOwner = tgIdentity ? await db.entities.AppUser.get(tgIdentity.app_user_id).catch(() => null) : null;
    const tgTasks = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "task" }, "-created_date", 50).catch(() => []);
    const tgGreetCalls = tgCalls.filter((c) => c.method === "sendMessage" && String(c.text || "").startsWith("Welcome, anonymous visitor"));
    harness.check("9b. an unlinked chat of an anonymous-enabled agent runs: identity minted server-side, reply delivered",
      r9b.ok && r9b.delivered === true && !!tgIdentity && tgIdentity.profile?.anonymous === true && !!tgOwner && isAnonymousUser(tgOwner),
      JSON.stringify(r9b).slice(0, 100));
    harness.check("9c. the channel greeting is delivered once on first contact (same contract as linked)",
      tgGreetCalls.length === 1 && String(tgGreetCalls[0].chat_id) === String(CHAT_ANON)
        && tgCalls.some((c) => c.text === "tg anon reply" && String(c.chat_id) === String(CHAT_ANON)),
      JSON.stringify(tgGreetCalls.length));
    harness.check("9d. per-user private data stays fail-closed over the channel (RLS project, no task written)",
      tgTasks.length === 0 && lastMsg("AUTH_REQUIRED").length > 0, `${tgTasks.length} row(s)`);
    const tgMsgRows = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: MESSAGES_ENTITY, owner_id: tgOwner?.id }, "-created_date", 10).catch(() => []);
    harness.check("9e. the channel conversation is owned by the minted anonymous identity",
      tgMsgRows.some((r) => (r.data || {}).content === "hi agent"), tgMsgRows.map((r) => (r.data || {}).content).join("|"));
    harness.check("9f. Telegram adds no relay tariff: the only integration movement is the turn's own per-message charge (P-9.10A preserved)",
      intT0 - (await pools.intOf(A.ws.id)) === 1, `${intT0} → ${await pools.intOf(A.ws.id)}`);
    script = [{ action: "reply", content: "tg again" }];
    const r9g = await tgHook({ text: "second message", chat: CHAT_ANON, agent: "opentools" });
    const tgIdRows = await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "telegram", provider_subject: String(CHAT_ANON) }, "-created_date", 10).catch(() => []);
    harness.check("9g. a second message reuses the same anonymous identity (no duplicate owner, no second greeting)",
      r9g.ok && r9g.delivered === true && tgIdRows.length === 1 && tgGreetCalls.length === 1,
      `ids=${tgIdRows.length} greetings=${tgGreetCalls.length}`);

    // --- J. WhatsApp anonymous path (relay billing unchanged) ------------------------------------------------
    const intW0 = await pools.intOf(A.ws.id);
    const g10a = await captureCall(() => waHook({ text: "hello", from: WA_FROM_CLOSED, agent: "closed" }));
    const intAfter10a = await pools.intOf(A.ws.id);
    harness.check("10a. an unlinked WhatsApp chat of a non-anonymous agent keeps the certified refusal",
      g10a.threw && g10a.code === "CHANNEL_NOT_LINKED", JSON.stringify(g10a));
    harness.check("10b. the inbound relay charge still runs before the refusal (unchanged P-9.10C behavior)",
      intW0 - intAfter10a === WHATSAPP_RELAY_CREDITS, `${intW0} → ${intAfter10a}`);
    script = [{ action: "reply", content: "wa anon reply" }];
    const r10c = await waHook({ text: "hi there", from: WA_FROM, agent: "open" });
    responses.push(r10c);
    const intAfter10c = await pools.intOf(A.ws.id);
    const waIdentity = await findIdentity(db, projA, "whatsapp", WA_FROM);
    const waOwner = waIdentity ? await db.entities.AppUser.get(waIdentity.app_user_id).catch(() => null) : null;
    harness.check("10c. an unlinked WhatsApp chat of an anonymous-enabled agent runs and delivers",
      r10c.ok && r10c.delivered === true && !!waIdentity && waIdentity.profile?.anonymous === true && !!waOwner && isAnonymousUser(waOwner),
      JSON.stringify(r10c).slice(0, 100));
    harness.check("10d. the WhatsApp relay charges exactly the certified 1+1 rates (+greeting outbound) beside the turn's own per-message charge",
      intAfter10a - intAfter10c === 3 * WHATSAPP_RELAY_CREDITS + 1
        && waCalls.some((c) => c.text === WA_GREET) && waCalls.some((c) => c.text === "wa anon reply"),
      `${intAfter10a} → ${intAfter10c}; sends=${waCalls.length}`);
    script = [{ action: "reply", content: "wa again" }];
    const r10e = await waHook({ text: "again", from: WA_FROM, agent: "open" });
    const intAfter10e = await pools.intOf(A.ws.id);
    const waIdRows = await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "whatsapp", provider_subject: WA_FROM }, "-created_date", 10).catch(() => []);
    harness.check("10e. a second message reuses the same identity and charges the same 1+1 relay rates beside its per-message charge",
      r10e.ok && r10e.delivered === true && waIdRows.length === 1 && intAfter10c - intAfter10e === 2 * WHATSAPP_RELAY_CREDITS + 1,
      `ids=${waIdRows.length} ${intAfter10c} → ${intAfter10e}`);
    // Canonical P-9.2 keys: intchg:<ws>:whatsapp:<op-id>:{hold,charge,release} — one logical
    // relay movement = up to three ledger rows, all in the integration pool.
    const relayRows = (await db.entities.CreditLedgerEntry.filter({ workspace_id: A.ws.id }, "-created_date", 500).catch(() => []))
      .filter((r) => String(r.idempotency_key || "").includes(":whatsapp:"));
    const relayOps = new Set(relayRows.map((r) => String(r.idempotency_key).replace(/:(hold|charge|release)$/, "")));
    harness.check("10f. every relay movement ran through the CERTIFIED P-9.2 ledger path (keys unchanged)",
      relayOps.size === 6 && relayRows.every((r) => (r.credit_type || "message") === "integration"),
      `${relayOps.size} relay ops, ${relayRows.length} rows`);

    // --- K. Redaction ------------------------------------------------------------------------------------------
    const allJson = JSON.stringify(responses);
    harness.check("11a. no agent instructions marker in any response",
      !allJson.includes(INSTRUCTIONS), `responses scanned: ${responses.length}`);
    const audits = await db.entities.AuditLog.filter({ project_id: projA.id }, "-created_date", 200).catch(() => []);
    const auditJson = JSON.stringify(audits);
    harness.check("11b. the anonymous session token appears in no response and no audit row",
      !allJson.includes(anon1.token) && !auditJson.includes(anon1.token) && !allJson.includes(BOT_TOKEN) && !auditJson.includes(WA_APP_SECRET),
      `audits scanned: ${audits.length}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by name pattern, including residue from earlier runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911c-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911c[a-b]" } }, "created_date", 200).catch(() => []);
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
    await db.entities.CacheEntry.deleteMany({ namespace: "anon_channel" }).catch(() => {});
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
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911ct[0-9]+$" } }).catch(() => {});
  }
}