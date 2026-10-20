// P-9.11L certification — LINE channel foundation for deployed in-app agents.
//
// Drives the REAL shipping modules (appAgentChannels / appAuth / appOAuth / appAgentRuntime /
// agentResource / secretCrypto) with the REAL canonical billing paths — only the LINE
// Messaging API and the model provider are scripted (counters prove fail-closed happens
// before them). Asserts, in order: the documented activation-CODE connect surface (fail-closed
// auth/agent/credentials, the Base44-documented 30-minute expiry, single-use token properties,
// no raw code at rest), X-Line-Signature raw-body authentication (rejected = 0 runs + 0
// charges), activation binding of a LINE userId to the app user (agent mismatch, identity
// taken, cross-channel code rejection), regular message routing through the EXISTING P-9.4
// executor with the documented NO-relay billing (a LINE turn charges exactly what the same
// in-app invoke charges), the pinned-model + tool path unchanged, duplicate-delivery
// idempotency, the SAME per-agent anonymous-access mechanism (fail-closed refusal otherwise),
// ONE plain-text reply carrying greeting + answer on first contact, cross-project/user
// isolation, and Telegram/WhatsApp regression isolation through the SAME dispatcher.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { retryingEntities, makeTgHttpStub, makeWaHttpStub } from "../../shared/channelCertScaffold.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import {
  handleAppChannelConnect, handleLINEUpdate, handleTelegramUpdate,
  LINE_CHANNEL_ACCESS_TOKEN_SECRET, LINE_CHANNEL_SECRET_NAME, LINE_ACTIVATION_TTL_MS,
} from "../../shared/appAgentChannels.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools, setProjectSecret, projectSecretResolver } from "../../shared/appAgentTestFixtures.ts";

export default async function (req) {
  // The platform rate-limits SDK request bursts; a 429 anywhere is retried with backoff.
  const rawDb = createClientFromRequest(req).asServiceRole;
  const db = { entities: retryingEntities(rawDb.entities) };
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  // ---- LINE Messaging API stub: records every call (url, body) ----
  const lineCalls = [];
  const lineHttpStub = async (url, init = {}) => {
    const u = String(url);
    lineCalls.push({ url: u, body: init.body ? JSON.parse(String(init.body)) : null });
    if (u.endsWith("/info")) {
      return new Response(JSON.stringify({ userId: "U911lbot", displayName: "base44 bot" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };

  // ---- Telegram/WhatsApp stubs for the regression-isolation probes ----
  const tgHttpStub = makeTgHttpStub("p911l_bot");
  const waHttpStub = makeWaHttpStub(stamp);

  // ---- model provider stub (P-9.4 pattern): the executor and billing paths are REAL ----
  const calls = { llm: 0, image: 0 };
  const seenModels = [];
  let script = [];
  const fakeProvider = {
    async generate({ model, jsonSchema }) {
      calls.llm++;
      seenModels.push(String(model?.model_id || model?.id || "?"));
      const out = script.length ? script.shift() : { action: "reply", content: "OK, noted." };
      return { output: jsonSchema ? out : (out.action === "reply" ? out.content : JSON.stringify(out)), usage: { input_tokens: 100, output_tokens: 20, usage_source: "provider" } };
    },
  };
  const providerOverrides = { "base44-core": fakeProvider, [NEXUS_PROVIDER]: fakeProvider };
  const client = {
    asServiceRole: {
      entities: db.entities,
      integrations: { Core: { GenerateImage: async () => { calls.image++; return { url: `https://cdn.test/p911l-${calls.image}.png` }; } } },
    },
  };
  // The shipped handlers see the SAME retrying entity surface — a platform 429 inside a handler
  // (which is not the property under test) is retried instead of aborting the certification.
  const opts = { providerOverrides };

  const payload = {
    agents: [
      { name: "helper", display_name: "Helper", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {} },
      { name: "open", display_name: "Open", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {}, allow_anonymous_access: true },
      { name: "artist", display_name: "Artist", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: { app_tools: ["GenerateImage"] }, model: "claude-sonnet-5" },
    ],
    entities: [],
  };

  const pace = () => appAgentPace(1500);
  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911l");

  const LINE_ACCESS_TOKEN = `line-access-${stamp}-never-leak`;
  const LINE_CHANNEL_SECRET = `line-secret-${stamp}`;
  const TELEGRAM_BOT_TOKEN = `777:p911l-secret-token`;
  const TELEGRAM_WEBHOOK_SECRET = `tg-webhook-${stamp}`;
  let projA = null;
  let projB = null;

  // LINE's documented signature form: X-Line-Signature = base64(HMAC-SHA256(secret, raw)).
  const hmacB64 = async (secret, raw) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(raw))))));
  };
  let seq = 0;
  const lineBody = (userId, text, { id = `msg-${++seq}`, type = "text" } = {}) =>
    JSON.stringify({ destination: "U911lbot", events: [{ type: "message", replyToken: `rt-${id}`, source: { type: "user", userId }, message: { type, text, id } }] });

  // ONE authenticated LINE delivery through the REAL handler (fail-closed paths use captureCall).
  const projAresolver = () => projectSecretResolver(db, projA);
  const deliver = async (agent, body, { signature = null, resolve = null, project = null } = {}) => {
    await pace();
    return handleLINEUpdate(client, {
      project: project || projA, payload, update: JSON.parse(body), agentName: agent,
      signatureHeader: signature === null ? await hmacB64(LINE_CHANNEL_SECRET, body) : signature,
      rawBody: body, resolveSecret: resolve || projAresolver(), http: lineHttpStub, options: opts,
    });
  };
  const expectFail = (agent, body, extra = {}) => captureCall(() => deliver(agent, body, extra));

  try {
    // --- fixtures: funded workspace A with two projects; real app users; real secrets ---
    const plan = await makeBillingPlan(db, created, `p911l${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911l${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);
    const projA_local = await makeAgentProject(db, projectIds, A, stamp, "p911la");
    const projB_local = await makeAgentProject(db, projectIds, A, stamp, "p911lb");
    projA = projA_local;
    projB = projB_local;

    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p911l.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p911l.test", display_name: "A2", email_verified: true });
    const userB1 = await createPasswordlessUser(db, projB, { email: "b1@p911l.test", display_name: "B1", email_verified: true });
    void userB1;

    await setProjectSecret(db, projA, LINE_CHANNEL_ACCESS_TOKEN_SECRET, LINE_ACCESS_TOKEN);
    await setProjectSecret(db, projA, LINE_CHANNEL_SECRET_NAME, LINE_CHANNEL_SECRET);
    await setProjectSecret(db, projB, LINE_CHANNEL_ACCESS_TOKEN_SECRET, LINE_ACCESS_TOKEN);
    await setProjectSecret(db, projB, LINE_CHANNEL_SECRET_NAME, LINE_CHANNEL_SECRET);
    await setProjectSecret(db, projA, "TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN);
    await setProjectSecret(db, projA, "TELEGRAM_WEBHOOK_SECRET", TELEGRAM_WEBHOOK_SECRET);
    await setProjectSecret(db, projA, "WHATSAPP_TOKEN", `wapp-token-${stamp}`);
    await setProjectSecret(db, projA, "WHATSAPP_PHONE_NUMBER_ID", `pnid${stamp}`);

    // ---- 1. connect surface: the documented activation CODE ------------------------------
    const anonConnect = await captureCall(() => handleAppChannelConnect(client, { project: projA, payload, user: null, args: { channel: "line", agent: "helper" }, resolveSecret: projAresolver(), http: lineHttpStub }));
    harness.check("connect: an anonymous caller is refused (401)", anonConnect.threw && anonConnect.code === "AUTH_REQUIRED" && anonConnect.status === 401, JSON.stringify(anonConnect));
    const ghostConnect = await captureCall(() => handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "line", agent: "ghost" }, resolveSecret: projAresolver(), http: lineHttpStub }));
    harness.check("connect: an agent outside the deployment is refused", ghostConnect.threw && ghostConnect.code === "AGENT_NOT_FOUND", JSON.stringify(ghostConnect));
    const noSecrets = await captureCall(() => handleAppChannelConnect(client, { project: projB, payload, user: userB1, args: { channel: "line", agent: "helper" }, resolveSecret: (async () => undefined), http: lineHttpStub }));
    void noSecrets;
    harness.check("connect: no LINE credential configured fails closed (503, secret NAMED, value never returned)",
      noSecrets.threw && noSecrets.code === "LINE_NOT_CONFIGURED" && noSecrets.status === 503 && !String(noSecrets.message || "").includes(LINE_ACCESS_TOKEN),
      JSON.stringify(noSecrets));

    const tokensBefore = (await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation" }, "-created_date", 100)).length;
    await pace();
    const connect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "line", agent: "helper" }, resolveSecret: projAresolver(), http: lineHttpStub });
    const tokensAfter = (await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation" }, "-created_date", 100));
    harness.check("connect: returns the documented ACTIVATION CODE with the Base44-documented 30-minute expiry (no invented URL)",
      connect.channel === "line" && connect.agent === "helper" && /^[a-f0-9]{64}$/.test(connect.code) && connect.expires_in_ms === LINE_ACTIVATION_TTL_MS && LINE_ACTIVATION_TTL_MS === 30 * 60 * 1000 && !("url" in connect),
      JSON.stringify({ channel: connect.channel, code: connect.code.slice(0, 8), expires_in_ms: connect.expires_in_ms, has_url: "url" in connect }));
    const tokenRow = tokensAfter[0];
    harness.check("connect: exactly ONE activation token is issued, hashed at rest, bound to (line, agent, user)",
      tokensAfter.length === tokensBefore + 1 && tokenRow.token_hash !== connect.code && tokenRow.status === "pending"
        && tokenRow.data.channel === "line" && tokenRow.data.agent === "helper" && tokenRow.app_user_id === userA1.id,
      JSON.stringify({ count: tokensAfter.length - tokensBefore, hash_is_not_code: tokenRow.token_hash !== connect.code, channel: tokenRow.data.channel }));

    // ---- 2. webhook authentication: fail-closed before the model and any charge -----------
    const llm0 = calls.llm;
    const int0 = await intOf(A.ws.id);
    const noSig = await expectFail("helper", lineBody("U-x", "hello"), { signature: "" });
    const badSig = await expectFail("helper", lineBody("U-x", "hello"), { signature: "bogus-signature" });
    harness.check("webhook: a missing or wrong X-Line-Signature over the exact raw body refuses with 401",
      noSig.threw && noSig.code === "LINE_SIGNATURE_INVALID" && badSig.threw && badSig.code === "LINE_SIGNATURE_INVALID", JSON.stringify({ noSig: noSig.code, badSig: badSig.code }));
    const noAgent = await expectFail("ghost", lineBody("U-x", "hello"));
    harness.check("webhook: an agent outside the deployment refuses (404)", noAgent.threw && noAgent.code === "AGENT_NOT_FOUND", JSON.stringify(noAgent));
    const noCreds = await captureCall(() => handleLINEUpdate(client, {
      project: projA, payload, update: JSON.parse(lineBody("U-x", "hello")), agentName: "helper",
      signatureHeader: "whatever", rawBody: lineBody("U-x", "hello"), resolveSecret: (async () => undefined), http: lineHttpStub,
    }));
    harness.check("webhook: missing LINE credentials fail closed (503 LINE_NOT_CONFIGURED)", noCreds.threw && noCreds.code === "LINE_NOT_CONFIGURED", JSON.stringify(noCreds));
    harness.check("webhook: EVERY refused delivery executed no model step and charged nothing",
      calls.llm === llm0 && (await intOf(A.ws.id)) === int0, `llm ${llm0} → ${calls.llm}`);

    // ---- 3. activation: identity binding through the documented code-as-message flow ------
    const linked = await deliver("helper", lineBody("U-line-A1", connect.code));
    const reply0 = lineCalls[lineCalls.length - 1];
    const identityA1 = (await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "line" }, "-created_date", 10)).find((r) => r.provider_subject === "U-line-A1");
    harness.check("activation: the code sent as a message binds the LINE userId to the app user",
      linked.linked === true && linked.agent === "helper" && !!identityA1 && identityA1.app_user_id === userA1.id && identityA1.status === "linked" && identityA1.profile.agent === "helper",
      JSON.stringify({ linked: linked.linked, bound: !!identityA1 }));
    harness.check("activation: the greeting is ONE plain-text reply through the provider's documented reply endpoint",
      linked.greeting_delivered === true && reply0.url.endsWith("/message/reply")
        && reply0.body.messages.length === 1 && reply0.body.messages[0].type === "text" && !/markdown|<|>/.test(reply0.body.messages[0].text),
      JSON.stringify({ url: reply0.url, messages: reply0.body.messages.length, type: reply0.body.messages[0].type }));
    const replayCode = await expectFail("helper", lineBody("U-line-A1", connect.code));
    harness.check("activation: the activation code is SINGLE-USE (a replayed code refuses)",
      replayCode.threw === true && !replayCode.linked, JSON.stringify({ threw: replayCode.threw, code: replayCode.code, status: replayCode.status }));

    const connectArtist = await handleAppChannelConnect(client, { project: projA, payload, user: userA2, args: { channel: "line", agent: "artist" }, resolveSecret: projAresolver(), http: lineHttpStub });
    const wrongAgent = await expectFail("helper", lineBody("U-line-A2", connectArtist.code));
    harness.check("activation: a code issued for a DIFFERENT agent refuses (CHANNEL_AGENT_MISMATCH)",
      wrongAgent.threw && wrongAgent.code === "CHANNEL_AGENT_MISMATCH", JSON.stringify(wrongAgent));
    const connectA2 = await handleAppChannelConnect(client, { project: projA, payload, user: userA2, args: { channel: "line", agent: "helper" }, resolveSecret: projAresolver(), http: lineHttpStub });
    const taken = await expectFail("helper", lineBody("U-line-A1", connectA2.code));
    harness.check("activation: another user's code cannot re-bind an already-linked LINE id (409)",
      taken.threw && taken.code === "CHANNEL_IDENTITY_TAKEN" && taken.status === 409, JSON.stringify(taken));

    // ---- 4. regular message routing through the EXISTING P-9.4 executor -------------------
    script = [{ action: "reply", content: "LINE agent answer" }];
    const intBefore = await intOf(A.ws.id);
    const llmBefore = calls.llm;
    const run1 = await deliver("helper", lineBody("U-line-A1", "hello agent"));
    const intAfter = await intOf(A.ws.id);
    const reply1 = lineCalls[lineCalls.length - 1];
    harness.check("message: a linked LINE user's message routes through the SAME in-app agent runtime and replies via the reply endpoint",
      run1.delivered === true && run1.agent === "helper" && calls.llm === llmBefore + 1
        && reply1.body.replyToken.startsWith("rt-") && reply1.body.messages.length === 1 && reply1.body.messages[0].text === "LINE agent answer",
      JSON.stringify({ delivered: run1.delivered, reply_token: reply1.body.replyToken, llm: `${llmBefore} → ${calls.llm}` }));
    const conv = await handleAppAgent(client, { project: projA, payload, user: userA1, op: "get", args: { conversation_id: run1.conversation_id } });
    harness.check("binding: the turn persists in the SAME conversation rows as the in-app runtime",
      conv.count === 2 && conv.messages.map((m) => m.role).join(",") === "user,assistant",
      JSON.stringify({ count: conv.count }));
    // No-relay billing: the LINE turn charges EXACTLY what the identical in-app invoke charges.
    const intInApp0 = await intOf(A.ws.id);
    const inApp = await handleAppAgent(client, { project: projA, payload, user: userA1, op: "invoke", args: { name: "helper", message: "hello agent" }, options: opts });
    const intInApp1 = await intOf(A.ws.id);
    harness.check("billing: a LINE turn charges EXACTLY the agent's own turn credits — no relay tariff exists (Telegram precedent)",
      intBefore - intAfter === inApp.usage.integration_credits && intInApp0 - intInApp1 === inApp.usage.integration_credits
        && (await msgOf(A.ws.id)) === 200,
      `line turn ${(intBefore - intAfter)} == in-app ${inApp.usage.integration_credits}; msg pool 200`);

    // ---- 5. duplicate delivery + unsupported events ----------------------------------------
    const dup = await deliver("helper", lineBody("U-line-A1", "hello agent", { id: "msg-dup-1" }));
    void dup;
    const dup2 = await deliver("helper", lineBody("U-line-A1", "hello agent", { id: "msg-dup-1" }));
    const llmDup = calls.llm;
    const nonText = await deliver("helper", lineBody("U-line-A1", "photo bytes", { id: "msg-img-1", type: "image" }));
    const oversize = await expectFail("helper", lineBody("U-line-A1", "x".repeat(4001), { id: "msg-big-1" }));
    harness.check("replay: a duplicate provider delivery is acknowledged and executes nothing",
      dup2.duplicate === true && calls.llm === llmDup, JSON.stringify({ duplicate: dup2.duplicate }));
    harness.check("replay: unsupported events (non-text) are acknowledged and ignored; an oversized message fails closed (413)",
      nonText.ignored === true && oversize.threw && oversize.code === "AGENT_MESSAGE_TOO_LONG" && oversize.status === 413,
      JSON.stringify({ ignored: nonText.ignored, oversize: oversize.code }));

    // ---- 6. anonymous access: the SAME per-agent mechanism ----------------------------------
    const refused = await expectFail("helper", lineBody("U-anon-1", "let me in", { id: "msg-anon-1" }));
    harness.check("anonymous: an unlinked chat of a NON-anonymous agent still refuses (403)",
      refused.threw && refused.code === "CHANNEL_NOT_LINKED" && refused.status === 403, JSON.stringify(refused));
    script = [{ action: "reply", content: "anon answer" }];
    const intAnon0 = await intOf(A.ws.id);
    const anonRun = await deliver("open", lineBody("U-anon-1", "hi there", { id: "msg-anon-2" }));
    const replyAnon = lineCalls[lineCalls.length - 1];
    const anonIdentity = (await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "line" }, "-created_date", 10)).find((r) => r.provider_subject === "U-anon-1");
    harness.check("anonymous: an allow_anonymous_access agent mints the server-side anonymous owner and runs the turn",
      anonRun.delivered === true && !!anonIdentity && anonIdentity.profile.anonymous === true && (await intOf(A.ws.id)) < intAnon0,
      JSON.stringify({ delivered: anonRun.delivered, anon_identity: !!anonIdentity }));
    harness.check("anonymous: first contact delivers greeting + answer in ONE plain-text reply (single-use replyToken)",
      replyAnon.body.messages.length === 2 && replyAnon.body.messages.every((m) => m.type === "text")
        && replyAnon.body.messages[0].text.startsWith("You are now connected to")
        && replyAnon.body.messages[1].text === "anon answer",
      JSON.stringify({ messages: replyAnon.body.messages.length }));
    const anonAgain = await deliver("open", lineBody("U-anon-1", "again", { id: "msg-anon-3" }));
    const replyAgain = lineCalls[lineCalls.length - 1];
    harness.check("anonymous: a returning anonymous chat gets the agent answer only (no repeat greeting)",
      anonAgain.delivered === true && replyAgain.body.messages.length === 1 && replyAgain.body.messages[0].text === "OK, noted.",
      JSON.stringify({ messages: replyAgain.body.messages.length }));

    // ---- 7. tools + pinned model through the normal runtime --------------------------------
    const connectA2b = await handleAppChannelConnect(client, { project: projA, payload, user: userA2, args: { channel: "line", agent: "artist" }, resolveSecret: projAresolver(), http: lineHttpStub });
    await deliver("artist", lineBody("U-line-A2", connectA2b.code, { id: "msg-act-artist" }));
    script = [
      { action: "tool", tool: { name: "GenerateImage", input: { prompt: "a cat" } } },
      { action: "reply", content: "drew it over LINE" },
    ];
    const images0 = calls.image;
    const artistRun = await deliver("artist", lineBody("U-line-A2", "draw a cat", { id: "msg-artist-1" }));
    harness.check("runtime: tools and the pinned model behave identically through the LINE channel",
      artistRun.delivered === true && calls.image === images0 + 1 && seenModels[seenModels.length - 1] === "claude-sonnet-5",
      JSON.stringify({ delivered: artistRun.delivered, images: calls.image - images0, model: seenModels[seenModels.length - 1] }));

    // ---- 8. cross-project / cross-user isolation -------------------------------------------
    const crossProject = await expectFail("helper", lineBody("U-line-A1", "hello from B", { id: "msg-cross-1" }), { project: projB });
    harness.check("isolation: the SAME LINE id has NO identity in ANOTHER project of the workspace (fail-closed)",
      crossProject.threw && crossProject.code === "CHANNEL_NOT_LINKED", JSON.stringify(crossProject));
    const others = await handleAppAgent(client, { project: projA, payload, user: userA2, op: "conversations", args: {} });
    harness.check("isolation: another app user never sees userA1's LINE conversations",
      !others.conversations.some((c) => c.conversation_id === run1.conversation_id), JSON.stringify({ count: others.count }));

    // ---- 9. Telegram / WhatsApp regression isolation through the SAME dispatcher -----------
    const tgConnect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "telegram", agent: "helper" }, resolveSecret: projAresolver(), http: tgHttpStub });
    const waConnect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "whatsapp", agent: "helper" }, resolveSecret: projAresolver(), http: waHttpStub });
    harness.check("regression: Telegram and WhatsApp connect surfaces are UNCHANGED (deep link / wa.me forms)",
      /^https:\/\/t\.me\/p911l_bot\?start=[a-f0-9]{64}$/.test(tgConnect.url) && /^https:\/\/wa\.me\/\d+\?text=[a-f0-9]{64}$/.test(waConnect.url),
      JSON.stringify({ tg: tgConnect.url.slice(0, 40), wa: waConnect.url.slice(0, 40) }));
    const freshLineCode = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "line", agent: "helper" }, resolveSecret: projAresolver(), http: lineHttpStub });
    const tgLine = await captureCall(() => handleTelegramUpdate(client, {
      project: projA, payload, update: { update_id: Date.now(), message: { chat: { id: "tg-chat-1" }, text: `/start ${freshLineCode.code}` } }, agentName: "helper",
      secretTokenHeader: TELEGRAM_WEBHOOK_SECRET, resolveSecret: projAresolver(), http: tgHttpStub,
    }));
    harness.check("regression: a LINE activation code is refused on the Telegram channel (CHANNEL_STATE_MISMATCH)",
      tgLine.threw && tgLine.code === "CHANNEL_STATE_MISMATCH", JSON.stringify(tgLine));
    const unsupported = await captureCall(() => handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "imessage", agent: "helper" }, resolveSecret: projAresolver(), http: lineHttpStub }));
    harness.check("regression: an uncertified channel still refuses through the dispatcher",
      unsupported.threw && unsupported.code === "CHANNEL_NOT_SUPPORTED", JSON.stringify(unsupported));

    // ---- 10. ledger integrity --------------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after LINE channel usage", integrity.ok, JSON.stringify(integrity));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ok: false, passed: s.passed, failed: s.failed, failed_names: s.results.filter((r) => !r.ok).map((r) => r.name), error: error.message, code: error.code || null, status: error.status || null, stack: String(error.stack || "").split("\n").slice(0, 6) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911l[ab]-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "p911l" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppIdentity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppAuthToken.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppUser.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    await db.entities.CacheEntry.deleteMany({ cache_key: { $regex: "^line_(replay|sent):" } }).catch(() => {});
    await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911l" } }).catch(() => {});
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p911l" } }).catch(() => {});
  }
}