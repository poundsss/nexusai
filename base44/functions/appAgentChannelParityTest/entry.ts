// P-9.10A certification — Telegram channel foundation for deployed in-app agents.
//
// Drives the REAL shipping modules (appAgentChannels / agentResource / appAuth / appOAuth /
// appAgentRuntime / secretCrypto) with the REAL canonical billing paths — only the Telegram
// API and the model provider are scripted (counters prove fail-closed happens before them).
// Asserts, in order: agent contract (telegram_greeting), fail-closed credentials, connect
// deep link, single-use/TTL/binding of activations, identity isolation, webhook signature
// security (rejected = 0 runs + 0 charges), owner resolution, the EXISTING P-9.4 executor,
// delivery to the right chat, redaction, cross-project isolation, rate limits, length caps.
// Every fixture is scratch and removed in the finally block.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { grantTestPool } from "../../shared/creditPoolTestHelpers.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import {
  connectTelegram, handleTelegramUpdate, TELEGRAM_BOT_TOKEN_SECRET, TELEGRAM_WEBHOOK_SECRET_NAME,
} from "../../shared/appAgentChannels.ts";
import { parseAgentDocument, agentDocumentContent, TELEGRAM_GREETING_MAX_CHARS } from "../../shared/agentResource.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";
import { createPasswordlessUser, limit } from "../../shared/appAuth.ts";
import { appAgentPace, activationCodeOf, makeAgentPoolTools, setProjectSecret, projectSecretResolver } from "../../shared/appAgentTestFixtures.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = []; // every JSON handed to the caller — redaction is asserted over all of it

  const BOT_TOKEN = `910${stamp}:tg-bot-token-never-leak`;
  const BOT_USERNAME = "p910_cert_bot";
  const WEBHOOK_SECRET = `910-wh-secret-${stamp}`;
  const WEBHOOK_SECRET_B = `910-wh-secret-b-${stamp}`;
  const CHAT = 501234567;

  // ---- Telegram API stub: records every call (method, token used, chat id, text) ----
  const tgCalls = [];
  let tgFailNext = 0;
  const tgHttp = async (url, init = {}) => {
    const u = new URL(String(url));
    const m = u.pathname.match(/^\/bot(.+)\/(getMe|sendMessage)$/);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (!m) return new Response(JSON.stringify({ ok: false, description: "unknown method" }), { status: 404 });
    tgCalls.push({ method: m[2], token: m[1], chat_id: body.chat_id ?? null, text: body.text ?? null });
    if (m[2] === "sendMessage" && tgFailNext > 0) { tgFailNext--; return new Response(JSON.stringify({ ok: false, description: "simulated send failure" }), { status: 500 }); }
    if (m[2] === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: BOT_USERNAME } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: tgCalls.length } }), { status: 200 });
  };

  // ---- model provider stub (P-9.4 pattern): the executor and billing paths are REAL ----
  const calls = { llm: 0 };
  let script = [{ action: "reply", content: "Channel reply from the agent" }];
  const fakeProvider = {
    async generate({ jsonSchema }) {
      calls.llm++;
      const out = script.length ? script.shift() : { action: "reply", content: "OK" };
      return { output: jsonSchema ? out : out.content, usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const client = { asServiceRole: { entities: db.entities, integrations: { Core: {} } } };
  const opts = { providerOverrides };

  const payload = {
    agents: [
      { name: "helper", display_name: "Helper", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {}, telegram_greeting: `Welcome to Helper (${stamp})` },
      { name: "other", display_name: "Other", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {} },
    ],
    entities: [],
  };

  const pace = appAgentPace;
  const { msgOf, intOf } = makeAgentPoolTools(db, stamp, "p910");

  try {
    // --- fixtures: two funded workspaces, one project each (projB starts with NO secrets) ---
    const plan = await makeBillingPlan(db, created, `ch910${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p910a${stamp}`, { plan });
    const B = await makeBillingWorkspace(db, created, `p910b${stamp}`, { plan });
    for (const f of [A, B]) wsIds.push(f.ws.id);
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "message", amount: 200, key: `p910:msg:${A.ws.id}:${stamp}`, reason: "P-9.10A test grant" });
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "integration", amount: 50, key: `p910:int:${A.ws.id}:${stamp}`, reason: "P-9.10A test grant" });
    await grantTestPool(db, { workspace_id: B.ws.id, pool: "message", amount: 200, key: `p910:msg:${B.ws.id}:${stamp}`, reason: "P-9.10A test grant" });
    await grantTestPool(db, { workspace_id: B.ws.id, pool: "integration", amount: 50, key: `p910:int:${B.ws.id}:${stamp}`, reason: "P-9.10A test grant" });
    const projA = await db.entities.Project.create({ workspace_id: A.ws.id, name: `p910-proj-${A.user.id}-${stamp}`, slug: `p910a-${stamp}` });
    const projB = await db.entities.Project.create({ workspace_id: B.ws.id, name: `p910-proj-${B.user.id}-${stamp}`, slug: `p910b-${stamp}` });
    projectIds.push(projA.id, projB.id);

    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p910.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p910.test", display_name: "A2", email_verified: true });
    const userB1 = await createPasswordlessUser(db, projB, { email: "b1@p910.test", display_name: "B1", email_verified: true });

    const setSecret = (project, name, value) => setProjectSecret(db, project, name, value);
    await setSecret(projA, TELEGRAM_BOT_TOKEN_SECRET, BOT_TOKEN);
    await setSecret(projA, TELEGRAM_WEBHOOK_SECRET_NAME, WEBHOOK_SECRET);

    const resolverFor = (project) => projectSecretResolver(db, project);
    const resolveA = resolverFor(projA);
    // projB starts with NO secrets: the first resolver caches those misses (2a/2c), and a FRESH
    // resolver is created after projB's credentials are set (a secret never rotates mid-request,
    // but the test does rotate them between requests).
    let resolveB = resolverFor(projB);

    const connect = async (project, user, agent, resolve) => {
      await pace(400);
      const r = await connectTelegram(db, { project, payload, user, agentName: agent, resolveSecret: resolve, http: tgHttp });
      responses.push(r);
      return r;
    };
    const hook = (update, { agent = "helper", header = WEBHOOK_SECRET, project = projA, resolve = resolveA } = {}) =>
      handleTelegramUpdate(client, { project, payload, update, agentName: agent, secretTokenHeader: header, resolveSecret: resolve, http: tgHttp, options: opts });
    // Each fixture is a distinct, valid Telegram update (R-2c requires a positive integer update_id).
    let updSeq = Date.now() * 100;
    const upd = (text, chat = CHAT) => ({ update_id: ++updSeq, message: { chat: { id: chat }, text } });
    const codeOf = (r) => activationCodeOf(r.url, "start");

    // --- 1. Agent contract: telegram_greeting is an owned, validated key ------------------
    const parsed = parseAgentDocument(agentFilePath("greeter"), JSON.stringify({ instructions: "Answer briefly.", telegram_greeting: "  Hello from Telegram  " }));
    harness.check("1a. telegram_greeting is an owned agent key (validated, trimmed)", parsed.ok && parsed.agent.telegram_greeting === "Hello from Telegram", parsed.error || parsed.agent?.telegram_greeting);
    const badType = parseAgentDocument(agentFilePath("greeter"), JSON.stringify({ instructions: "x", telegram_greeting: 42 }));
    harness.check("1b. a non-string telegram_greeting is refused", badType.ok === false && /telegram_greeting/.test(badType.error || ""), badType.error || "");
    const badLen = parseAgentDocument(agentFilePath("greeter"), JSON.stringify({ instructions: "x", telegram_greeting: "g".repeat(TELEGRAM_GREETING_MAX_CHARS + 1) }));
    harness.check("1c. an oversized telegram_greeting is refused", badLen.ok === false, badLen.error || "");
    const round = parseAgentDocument(agentFilePath("greeter"), agentDocumentContent({ name: "greeter", instructions: "x", tools: [], skills: [], telegram_greeting: "Hello from Telegram" }));
    harness.check("1d. the canonical document round-trips telegram_greeting", round.ok && round.agent.telegram_greeting === "Hello from Telegram", round.error || "");
    harness.check("1e. the greeting does not leak into loose metadata", parsed.ok && parsed.agent.metadata?.telegram_greeting === undefined, JSON.stringify(parsed.agent?.metadata));

    // --- 2. Fail-closed credentials (projB has none yet) ----------------------------------
    const noToken = await captureCall(() => connectTelegram(db, { project: projB, payload, user: userB1, agentName: "helper", resolveSecret: resolveB, http: tgHttp }));
    harness.check("2a. a missing bot token fails closed at connect", noToken.threw && noToken.code === "TELEGRAM_NOT_CONFIGURED" && noToken.status === 503, JSON.stringify(noToken));
    const noTokenHook = await captureCall(() => hook(upd(`/start ${"0".repeat(64)}`), { project: projB, resolve: resolveB, header: WEBHOOK_SECRET }));
    harness.check("2b. a webhook without credentials fails closed", noTokenHook.threw && noTokenHook.code === "TELEGRAM_NOT_CONFIGURED", JSON.stringify(noTokenHook));
    await setSecret(projB, TELEGRAM_BOT_TOKEN_SECRET, BOT_TOKEN);
    await setSecret(projB, TELEGRAM_WEBHOOK_SECRET_NAME, WEBHOOK_SECRET_B);
    resolveB = resolverFor(projB);

    // --- 3. Connect flow -------------------------------------------------------------------
    const anon = await captureCall(() => connectTelegram(db, { project: projA, payload, user: null, agentName: "helper", resolveSecret: resolveA, http: tgHttp }));
    harness.check("3a. anonymous connect is refused", anon.threw && anon.code === "AUTH_REQUIRED" && anon.status === 401, JSON.stringify(anon));
    const unknown = await captureCall(() => connect(projA, userA1, "ghost", resolveA));
    harness.check("3b. an agent outside the deployment is refused", unknown.threw && unknown.code === "AGENT_NOT_FOUND", JSON.stringify(unknown));
    const connect1 = await connect(projA, userA1, "helper", resolveA);
    const code1 = codeOf(connect1);
    const url1 = new URL(connect1.url);
    harness.check("3c. connect returns the bot deep link with a single-use activation code",
      url1.hostname === "t.me" && url1.pathname === `/${BOT_USERNAME}` && /^[a-f0-9]{64}$/.test(code1), connect1.url.slice(0, 60));
    harness.check("3d. getMe used the server-decrypted bot token", tgCalls.some((c) => c.method === "getMe" && c.token === BOT_TOKEN), "getMe token mismatch");

    // --- 4. Activation: single-use, identity binding ----------------------------------------
    const firstLink = await hook(upd(`/start ${code1}`));
    responses.push(firstLink);
    harness.check("4a. the /start deep link binds the chat to the issuing user", firstLink.ok === firstLink.linked === true && firstLink.greeting_delivered === true, JSON.stringify(firstLink));
    const idA1 = (await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "telegram", provider_subject: String(CHAT), status: "linked" }, "-created_date", 1))[0];
    harness.check("4b. the identity row is server-stamped (project, owner, subject = chat id)",
      !!idA1 && idA1.app_user_id === userA1.id && idA1.provider_subject === String(CHAT) && idA1.profile?.agent === "helper", JSON.stringify(idA1 && { u: idA1.app_user_id, s: idA1.provider_subject, p: idA1.profile }));
    const replay = await captureCall(() => hook(upd(`/start ${code1}`)));
    harness.check("4c. replaying a consumed activation is refused", replay.threw && replay.code === "TOKEN_USED" && replay.status === 410, JSON.stringify(replay));
    // 4d/5a. A NEW issuance revokes the still-PENDING prior code (one active activation per
    // user), and expiry refuses the newest one. code1 is already consumed, so the supersede
    // check must use connect2's still-pending code AFTER connect3 supersedes it.
    const connect2 = await connect(projA, userA1, "helper", resolveA);
    const connect3 = await connect(projA, userA1, "helper", resolveA);
    const stale = await captureCall(() => hook(upd(`/start ${codeOf(connect2)}`)));
    harness.check("4d. an activation superseded by a new issuance is refused", stale.threw && stale.code === "TOKEN_EXPIRED", JSON.stringify(stale));

    // --- 5. Activation TTL --------------------------------------------------------------------
    const row3 = (await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation", status: "pending" }, "-created_date", 1))[0];
    await db.entities.AppAuthToken.update(row3.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await captureCall(() => hook(upd(`/start ${codeOf(connect3)}`)));
    harness.check("5a. an expired activation is refused (short TTL)", expired.threw && expired.code === "TOKEN_EXPIRED" && expired.status === 410, JSON.stringify(expired));

    // --- 6. Activation binding: project / agent / user ----------------------------------------
    const connect4 = await connect(projA, userA1, "helper", resolveA);
    const code4 = codeOf(connect4);
    const cross = await captureCall(() => hook(upd(`/start ${code4}`), { project: projB, resolve: resolveB, header: WEBHOOK_SECRET_B }));
    harness.check("6a. an activation from project A cannot complete in project B", cross.threw && cross.code === "TOKEN_INVALID", JSON.stringify(cross));
    const mismatch = await captureCall(() => hook(upd(`/start ${code4}`), { agent: "other" }));
    harness.check("6b. an activation for one agent is refused on another agent's webhook", mismatch.threw && mismatch.code === "CHANNEL_AGENT_MISMATCH", JSON.stringify(mismatch));
    const row4 = (await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation", status: "used" }, "-created_date", 1))[0];
    harness.check("6c. the activation row binds channel + agent + issuing user",
      row4 && row4.data?.channel === "telegram" && row4.data?.agent === "helper" && row4.app_user_id === userA1.id, JSON.stringify(row4 && row4.data));

    // --- 7. Identity isolation -----------------------------------------------------------------
    const connect5 = await connect(projA, userA2, "helper", resolveA);
    const taken = await captureCall(() => hook(upd(`/start ${codeOf(connect5)}`)));
    harness.check("7a. a chat linked to one user cannot be taken over by another", taken.threw && taken.code === "CHANNEL_IDENTITY_TAKEN" && taken.status === 409, JSON.stringify(taken));
    const connectB = await connect(projB, userB1, "helper", resolveB);
    const linkB = await hook(upd(`/start ${codeOf(connectB)}`), { project: projB, resolve: resolveB, header: WEBHOOK_SECRET_B });
    responses.push(linkB);
    harness.check("7b. the same chat id links independently per project", linkB.ok === linkB.linked === true, JSON.stringify(linkB));

    // --- 8. Webhook security: rejected = 0 runs + 0 charges -------------------------------------
    const llm0 = calls.llm;
    const pool0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);
    const badSig = await captureCall(() => hook(upd("hello"), { header: "wrong-secret" }));
    const noSig = await captureCall(() => hook(upd("hello"), { header: null }));
    harness.check("8a. a wrong or missing webhook secret is refused identically",
      badSig.threw && badSig.code === "TELEGRAM_SIGNATURE_INVALID" && badSig.status === 401 && noSig.threw && noSig.code === "TELEGRAM_SIGNATURE_INVALID", JSON.stringify([badSig.code, noSig.code]));
    harness.check("8b. a rejected webhook runs no agent and charges nothing (both pools unchanged)",
      calls.llm === llm0 && (await msgOf(A.ws.id)) === pool0 && (await intOf(A.ws.id)) === int0, `llm delta ${calls.llm - llm0}`);
    const unlinked = await captureCall(() => hook(upd("hello", 987654321)));
    harness.check("8c. an unlinked chat is refused with no agent run", unlinked.threw && unlinked.code === "CHANNEL_NOT_LINKED" && calls.llm === llm0, JSON.stringify(unlinked));

    // --- 9. A linked message: the EXISTING P-9.4 executor ----------------------------------------
    await pace(1500);
    script = [{ action: "reply", content: "Telegram agent answer" }];
    const msgBefore9 = await msgOf(A.ws.id);
    const intBefore9 = await intOf(A.ws.id);
    const ran = await hook(upd("what can you do?"));
    responses.push(ran);
    harness.check("9a. a linked chat message runs the agent and delivers the reply", ran.ok && ran.delivered === true && !!ran.conversation_id, JSON.stringify(ran));
    harness.check("9b. the per-message INTEGRATION charge is applied through the EXISTING path, message pool untouched (P-9.11E)",
      intBefore9 - (await intOf(A.ws.id)) === 1 && (await msgOf(A.ws.id)) === msgBefore9,
      `int ${intBefore9} → ${await intOf(A.ws.id)}; msg ${msgBefore9} → ${await msgOf(A.ws.id)}`);
    const rows = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 10);
    harness.check("9c. the conversation owner is the identity-bound user (server-side resolution)",
      rows.some((r) => r.owner_id === userA1.id && (r.data || {}).content === "what can you do?"), rows.map((r) => r.owner_id).join(","));
    const last = tgCalls[tgCalls.length - 1];
    harness.check("9d. the reply goes to the SAME chat with the server-side bot token",
      last.method === "sendMessage" && String(last.chat_id) === String(CHAT) && last.text === "Telegram agent answer" && last.token === BOT_TOKEN, JSON.stringify({ chat_id: last.chat_id, text: last.text }));

    // 9e. Duplicate Telegram update past a lost delivery claim: keyed replay, no rerun, no resend.
    const dupUpd = { update_id: updSeq, message: { chat: { id: CHAT }, text: "what can you do?" } };
    const claimRows = await db.entities.CacheEntry.filter({ cache_key: `tg_replay:${projA.id}:${updSeq}` }, "created_date", 5);
    for (const c of claimRows) await db.entities.CacheEntry.delete(c.id);
    const llm9 = calls.llm, tg9 = tgCalls.length, int9 = await intOf(A.ws.id), msg9 = await msgOf(A.ws.id);
    const dup = await hook(dupUpd);
    harness.check("9e. a duplicate Telegram update replays the saved reply: no agent rerun, no second send, no charge",
      dup.ok && dup.replayed === true && dup.conversation_id === ran.conversation_id && calls.llm === llm9 && tgCalls.length === tg9
        && (await intOf(A.ws.id)) === int9 && (await msgOf(A.ws.id)) === msg9,
      JSON.stringify({ dup, claims: claimRows.length, llm: calls.llm - llm9, sends: tgCalls.length - tg9 }));

    // 9f–9h. Failed first delivery → a duplicate update retries the SAVED reply exactly once.
    await pace(1500);
    script = [{ action: "reply", content: "Recovered answer" }];
    tgFailNext = 1;
    const fUpd = upd("retry me");
    const llmF = calls.llm, intF = await intOf(A.ws.id), msgF = await msgOf(A.ws.id), tgF = tgCalls.length;
    const first = await hook(fUpd);
    const llmAfterFirst = calls.llm, intAfterFirst = await intOf(A.ws.id);
    harness.check("9f. a failed first send reports delivered=false after one agent run and one charge",
      first.ok && first.delivered === false && !!first.delivery_error && llmAfterFirst > llmF && intF - intAfterFirst === 1 && tgCalls.length === tgF + 1,
      JSON.stringify({ first, llm: llmAfterFirst - llmF, int: intF - intAfterFirst }));
    const retry = await hook(fUpd);
    const lastSend = tgCalls[tgCalls.length - 1];
    harness.check("9g. a duplicate update after a failed send retries the saved reply: no agent rerun, no new charge",
      retry.ok && retry.replayed === true && retry.delivered === true && retry.conversation_id === first.conversation_id
        && calls.llm === llmAfterFirst && (await intOf(A.ws.id)) === intAfterFirst && (await msgOf(A.ws.id)) === msgF
        && tgCalls.length === tgF + 2 && lastSend.text === "Recovered answer",
      JSON.stringify({ retry, llm: calls.llm - llmAfterFirst, sends: tgCalls.length - tgF }));
    const again = await hook(fUpd);
    for (const c of await db.entities.CacheEntry.filter({ cache_key: `tg_replay:${projA.id}:${fUpd.update_id}` }, "created_date", 5)) await db.entities.CacheEntry.delete(c.id);
    const pastClaim = await hook(fUpd);
    harness.check("9h. after a successful delivery, duplicates never send again (claim duplicate, and past a lost claim)",
      again.duplicate === true && pastClaim.ok && pastClaim.delivered === false && pastClaim.replayed === true
        && calls.llm === llmAfterFirst && tgCalls.length === tgF + 2 && (await intOf(A.ws.id)) === intAfterFirst,
      JSON.stringify({ again, pastClaim, sends: tgCalls.length - tgF }));

    // --- 10. Cross-project isolation --------------------------------------------------------------
    await pace(1500);
    script = [{ action: "reply", content: "B reply" }];
    const aMsg = await msgOf(A.ws.id);
    const aInt = await intOf(A.ws.id);
    const bMsg = await msgOf(B.ws.id);
    const bInt = await intOf(B.ws.id);
    const ranB = await hook(upd("hello from B"), { project: projB, resolve: resolveB, header: WEBHOOK_SECRET_B });
    responses.push(ranB);
    harness.check("10a. project B's chat runs B's agent against B's workspace", ranB.ok && ranB.delivered === true, JSON.stringify(ranB));
    harness.check("10b. cross-project: only B's integration pool moved by B's own per-message charge",
      bInt - (await intOf(B.ws.id)) === 1 && (await intOf(A.ws.id)) === aInt
        && (await msgOf(B.ws.id)) === bMsg && (await msgOf(A.ws.id)) === aMsg, "pool isolation holds");

    // --- 11. Message length cap --------------------------------------------------------------------
    const llm1 = calls.llm;
    const tooLong = await captureCall(() => hook(upd("x".repeat(4001))));
    harness.check("11a. an oversized inbound message is refused before the executor", tooLong.threw && tooLong.code === "AGENT_MESSAGE_TOO_LONG" && calls.llm === llm1, JSON.stringify(tooLong));

    // --- 12. Greeting --------------------------------------------------------------------------------
    const greetCall = tgCalls.find((c) => c.method === "sendMessage" && c.text && c.text.startsWith("Welcome to Helper"));
    harness.check("12a. the agent's telegram_greeting is delivered on first contact", !!greetCall && String(greetCall.chat_id) === String(CHAT), greetCall?.text || "no greeting send found");

    // --- 13. Redaction ---------------------------------------------------------------------------------
    const audits = await db.entities.AuditLog.filter({ project_id: projA.id }, "-created_date", 100).catch(() => []);
    const auditJson = JSON.stringify(audits);
    harness.check("13a. no credential value in any audit row", !auditJson.includes(BOT_TOKEN) && !auditJson.includes(WEBHOOK_SECRET), `rows scanned: ${audits.length}`);
    const tokens = await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation" }, "-created_date", 50);
    const tokenJson = JSON.stringify(tokens);
    harness.check("13b. activation codes are stored only as hashes", !tokenJson.includes(code1) && tokens.every((t) => /^[a-f0-9]{64}$/.test(t.token_hash || "")), `${tokens.length} rows`);
    const respJson = JSON.stringify(responses);
    harness.check("13c. no credential value in any response", !respJson.includes(BOT_TOKEN) && !respJson.includes(WEBHOOK_SECRET), "responses scanned");

    // --- 14. Durable rate limit ---------------------------------------------------------------------
    let blocked = null;
    for (let i = 0; i < 25; i++) {
      try { await limit(db, projA, "channel_activation", "user:rl910"); } catch (e) { blocked = e; break; }
    }
    harness.check("14a. the activation flow is durably rate limited", blocked?.code === "RATE_LIMITED", blocked?.code || "no block within 25 attempts");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by name pattern, including residue from earlier runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p910-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p910[a-b]" } }, "created_date", 200).catch(() => []);
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
      // Telegram delivery markers of this suite's projects (tg_replay/tg_sent) — previously leaked.
      for (const id of pIds) await db.entities.CacheEntry.deleteMany({ cache_key: { $regex: `^tg_(replay|sent):${id}:` } }).catch(() => {});
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
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^ch910[0-9]+$" } }).catch(() => {});
  }
}