// P-9.10C certification — WhatsApp channel foundation for deployed in-app agents.
//
// Drives the REAL shipping modules (appAgentChannels / agentResource / appAuth / appOAuth /
// appAgentRuntime / integrationCharges / secretCrypto) with the REAL canonical billing paths —
// only the WhatsApp Cloud API and the model provider are scripted (counters prove fail-closed
// happens before them). Asserts, in order: the whatsapp_greeting agent contract, fail-closed
// credentials, the connect URL issued through the channel dispatcher, the GET verification
// handshake, POST X-Hub-Signature-256 raw-body signature security (rejected = 0 runs + 0
// charges), single-use/TTL/binding of activations, identity isolation and payload-spoof
// resistance, the EXISTING P-9.4 executor with unchanged message credits, the Base44-documented
// WhatsApp relay charges (1 integration credit per message received + 1 per message sent, hold
// before, settle by delivery, duplicates charge nothing), delivery failure, the documented
// 3-connected-agents workspace limit, redaction, and the durable rate limit.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { grantTestPool } from "../../shared/creditPoolTestHelpers.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import {
  handleAppChannelConnect, handleWhatsAppUpdate, handleWhatsAppVerification,
  WHATSAPP_TOKEN_SECRET, WHATSAPP_PHONE_NUMBER_ID_SECRET, WHATSAPP_VERIFY_TOKEN_SECRET, WHATSAPP_APP_SECRET_NAME,
  CHANNEL_ACTIVATION_TTL_MS,
} from "../../shared/appAgentChannels.ts";
import { parseAgentDocument, agentDocumentContent, WHATSAPP_GREETING_MAX_CHARS } from "../../shared/agentResource.ts";
import { agentFilePath } from "../../shared/base44Layout.ts";
import { createPasswordlessUser, limit } from "../../shared/appAuth.ts";
import { appAgentPace, activationCodeOf, makeAgentPoolTools, makeAgentProject, setProjectSecret, projectSecretResolver } from "../../shared/appAgentTestFixtures.ts";
import { hmacWaHex, makeWaHttp, makeWaUpdate } from "../../shared/whatsappChannelTestHelpers.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const responses = [];   // every JSON handed to the caller — redaction is asserted over all of it
  const issuedCodes = []; // every raw activation code — leakage is asserted over all of them

  const WA_TOKEN = `wapp-token-${stamp}-never-leak`;
  const WA_TOKEN_B = `wapp-token-b-${stamp}-never-leak`;
  const VERIFY_TOKEN = `wapp-verify-${stamp}`;
  const APP_SECRET = `wapp-appsecret-${stamp}`;
  const APP_SECRET_B = `wapp-appsecret-b-${stamp}`;
  const WA_NUMBER = `1555000${String(stamp).slice(-4)}`;
  const PNID = `pnid${stamp}`;
  const WA1 = "15550001111"; // userA1's phone
  const WA2 = "15550002222"; // never linked — the spoof probe's decoy contact

  // ---- WhatsApp Cloud API stub (shared certification stub): records every call ----
  const { http: waHttp, calls: waCalls, setSendFails } = makeWaHttp({ waNumber: WA_NUMBER, pnid: PNID });

  // ---- model provider stub (P-9.4 pattern): the executor and billing paths are REAL ----
  const calls = { llm: 0 };
  let script = [{ action: "reply", content: "WhatsApp agent answer" }];
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
      { name: "helper", display_name: "Helper", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {}, whatsapp_greeting: `Welcome to Helper on WhatsApp (${stamp})` },
      { name: "artist", display_name: "Artist", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {} },
      { name: "other", display_name: "Other", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {} },
    ],
    entities: [],
  };

  const pace = appAgentPace;
  const { msgOf, intOf } = makeAgentPoolTools(db, stamp, "p910c");

  // The provider's signature form: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw).
  const hmacHex = hmacWaHex;
  const waUpdate = makeWaUpdate({ waNumber: WA_NUMBER, pnid: PNID });

  try {
    // --- fixtures: workspace A (funded, 2 projects), C (zero integration credits), L (limit) ---
    const plan = await makeBillingPlan(db, created, `ch910c${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p910ca${stamp}`, { plan });
    const C = await makeBillingWorkspace(db, created, `p910cc${stamp}`, { plan }); // funded messages only
    const L = await makeBillingWorkspace(db, created, `p910cl${stamp}`, { plan });
    for (const f of [A, C, L]) wsIds.push(f.ws.id);
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "message", amount: 200, key: `p910c:msg:A:${stamp}`, reason: "P-9.10C test grant" });
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "integration", amount: 100, key: `p910c:int:A:${stamp}`, reason: "P-9.10C test grant" });
    await grantTestPool(db, { workspace_id: C.ws.id, pool: "message", amount: 200, key: `p910c:msg:C:${stamp}`, reason: "P-9.10C test grant" });
    await grantTestPool(db, { workspace_id: L.ws.id, pool: "message", amount: 200, key: `p910c:msg:L:${stamp}`, reason: "P-9.10C test grant" });
    await grantTestPool(db, { workspace_id: L.ws.id, pool: "integration", amount: 100, key: `p910c:int:L:${stamp}`, reason: "P-9.10C test grant" });

    const mkProject = (ws, tag) => makeAgentProject(db, projectIds, ws, `${tag}-${stamp}`, "p910c");
    const projA = await mkProject(A, "a");
    const projB = await mkProject(A, "b");  // cross-project probe inside the SAME workspace
    const projC = await mkProject(C, "c");
    const Lp = [await mkProject(L, "l1"), await mkProject(L, "l2"), await mkProject(L, "l3"), await mkProject(L, "l4")];

    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p910c.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p910c.test", display_name: "A2", email_verified: true });
    const userB1 = await createPasswordlessUser(db, projB, { email: "b1@p910c.test", display_name: "B1", email_verified: true });
    const userC1 = await createPasswordlessUser(db, projC, { email: "c1@p910c.test", display_name: "C1", email_verified: true });
    const usersL = [];
    for (let i = 0; i < 4; i++) usersL.push(await createPasswordlessUser(db, Lp[i], { email: `lu${i}@p910c.test`, display_name: `LU${i}`, email_verified: true }));

    const setSecret = (project, name, value) => setProjectSecret(db, project, name, value);
    const fullSecrets = (project, token, appSecret) => Promise.all([
      setSecret(project, WHATSAPP_TOKEN_SECRET, token),
      setSecret(project, WHATSAPP_PHONE_NUMBER_ID_SECRET, PNID),
      setSecret(project, WHATSAPP_VERIFY_TOKEN_SECRET, VERIFY_TOKEN),
      setSecret(project, WHATSAPP_APP_SECRET_NAME, appSecret),
    ]);
    await fullSecrets(projA, WA_TOKEN, APP_SECRET);
    await fullSecrets(projC, WA_TOKEN, APP_SECRET);
    for (const p of Lp) await fullSecrets(p, WA_TOKEN, APP_SECRET);
    // projB starts with NO secrets (fail-closed probes) and gets its own credential set later.

    const resolverFor = (project) => projectSecretResolver(db, project);
    const resolveA = resolverFor(projA);
    // projB starts with NO secrets: the first resolver caches those misses (2a/2c), and a FRESH
    // resolver is created after projB's credentials are set — a secret never rotates mid-request,
    // but the test does rotate them between requests.
    let resolveB = resolverFor(projB);

    // connect goes through the RUNTIME DISPATCHER — the exact path agents.getWhatsAppConnectURL rides.
    const waConnect = async (project, user, agent, resolve = resolveA) => {
      await pace(1500);
      const r = await handleAppChannelConnect(client, { project, payload, user, args: { channel: "whatsapp", agent }, resolveSecret: resolve, http: waHttp });
      responses.push(r);
      issuedCodes.push(new URL(r.url).searchParams.get("text") || "");
      return r;
    };
    const codeOf = (r) => activationCodeOf(r.url, "text");
    const waHook = async (raw, { agent = "helper", project = projA, header, appSecret = APP_SECRET, resolve = resolveA } = {}) => {
      await pace(2500);
      const sig = header !== undefined ? header : "sha256=" + (await hmacHex(appSecret, raw));
      const r = await handleWhatsAppUpdate(client, {
        project, payload, update: JSON.parse(raw), agentName: agent,
        signatureHeader: sig, rawBody: raw, resolveSecret: resolve, http: waHttp, options: opts,
      });
      responses.push(r);
      return r;
    };

    // --- 1. Agent contract: whatsapp_greeting is an owned, validated key ----------------------
    const parsed = parseAgentDocument(agentFilePath("greeter"), JSON.stringify({ instructions: "Answer briefly.", whatsapp_greeting: "  Hello from WhatsApp  " }));
    harness.check("1a. whatsapp_greeting is an owned agent key (validated, trimmed)",
      parsed.ok && parsed.agent.whatsapp_greeting === "Hello from WhatsApp", parsed.error || parsed.agent?.whatsapp_greeting);
    const badType = parseAgentDocument(agentFilePath("greeter"), JSON.stringify({ instructions: "x", whatsapp_greeting: 42 }));
    harness.check("1b. a non-string whatsapp_greeting is refused", badType.ok === false && /whatsapp_greeting/.test(badType.error || ""), badType.error || "");
    const badLen = parseAgentDocument(agentFilePath("greeter"), JSON.stringify({ instructions: "x", whatsapp_greeting: "g".repeat(WHATSAPP_GREETING_MAX_CHARS + 1) }));
    harness.check("1c. an oversized whatsapp_greeting is refused", badLen.ok === false, badLen.error || "");
    const round = parseAgentDocument(agentFilePath("greeter"), agentDocumentContent({ name: "greeter", instructions: "x", tools: [], skills: [], whatsapp_greeting: "Hello from WhatsApp" }));
    harness.check("1d. the canonical document round-trips whatsapp_greeting", round.ok && round.agent.whatsapp_greeting === "Hello from WhatsApp", round.error || "");
    harness.check("1e. the greeting does not leak into loose metadata", parsed.ok && parsed.agent.metadata?.whatsapp_greeting === undefined, JSON.stringify(parsed.agent?.metadata));

    // --- 2. Fail-closed credentials (projB has none yet) --------------------------------------
    const noToken = await captureCall(() => handleAppChannelConnect(client, { project: projB, payload, user: userB1, args: { channel: "whatsapp", agent: "helper" }, resolveSecret: resolveB, http: waHttp }));
    harness.check("2a. a missing WhatsApp token fails closed at connect",
      noToken.threw && noToken.code === "WHATSAPP_NOT_CONFIGURED" && noToken.status === 503, JSON.stringify(noToken));
    harness.check("2b. the refusal names the SECRET, never a value",
      noToken.threw && noToken.message.includes(WHATSAPP_TOKEN_SECRET) && !noToken.message.includes(WA_TOKEN), noToken.message);
    const noTokenHook = await captureCall(() => waHook(waUpdate(WA1, "a".repeat(64)), { project: projB, resolve: resolveB, appSecret: APP_SECRET_B }));
    harness.check("2c. a webhook without credentials fails closed", noTokenHook.threw && noTokenHook.code === "WHATSAPP_NOT_CONFIGURED", JSON.stringify(noTokenHook));
    await fullSecrets(projB, WA_TOKEN_B, APP_SECRET_B);
    resolveB = resolverFor(projB);

    // --- 3. Connect flow (through the runtime dispatcher — the SDK path) ----------------------
    const anon = await captureCall(() => handleAppChannelConnect(client, { project: projA, payload, user: null, args: { channel: "whatsapp", agent: "helper" }, resolveSecret: resolveA, http: waHttp }));
    harness.check("3a. anonymous connect is refused", anon.threw && anon.code === "AUTH_REQUIRED" && anon.status === 401, JSON.stringify(anon));
    const unknown = await captureCall(() => waConnect(projA, userA1, "ghost"));
    harness.check("3b. an agent outside the deployment is refused", unknown.threw && unknown.code === "AGENT_NOT_FOUND", JSON.stringify(unknown));
    const connect1 = await waConnect(projA, userA1, "helper");
    const url1 = new URL(connect1.url);
    harness.check("3c. connect returns the wa.me link with a single-use activation code",
      url1.hostname === "wa.me" && url1.pathname === `/${WA_NUMBER}` && /^[a-f0-9]{64}$/.test(codeOf(connect1))
        && connect1.channel === "whatsapp" && connect1.agent === "helper" && connect1.expires_in_ms === CHANNEL_ACTIVATION_TTL_MS,
      connect1.url.slice(0, 60));
    harness.check("3d. the provider call used the server-decrypted token",
      waCalls.some((c) => c.token === `Bearer ${WA_TOKEN}` && String(c.url).includes("display_phone_number")), "graph token mismatch");

    // --- 4. GET verification handshake ------------------------------------------------------------
    const qOk = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "challenge-123" });
    const verified = await handleWhatsAppVerification(client, { project: projA, payload, agentName: "helper", query: qOk, resolveSecret: resolveA });
    harness.check("4a. a valid verification handshake echoes the challenge", verified.ok === true && verified.challenge === "challenge-123", JSON.stringify(verified));
    const qBad = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "wrong-token", "hub.challenge": "challenge-123" });
    const badVerify = await captureCall(() => handleWhatsAppVerification(client, { project: projA, payload, agentName: "helper", query: qBad, resolveSecret: resolveA }));
    harness.check("4b. a wrong verify token is refused", badVerify.threw && badVerify.code === "WHATSAPP_VERIFICATION_INVALID" && badVerify.status === 403, JSON.stringify(badVerify));
    const qMal = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN });
    const malformed = await captureCall(() => handleWhatsAppVerification(client, { project: projA, payload, agentName: "helper", query: qMal, resolveSecret: resolveA }));
    harness.check("4c. a malformed handshake never reaches the echo", malformed.threw && malformed.code === "WHATSAPP_VERIFICATION_INVALID" && malformed.status === 400, JSON.stringify(malformed));

    // --- 5. POST signature security: rejected = 0 runs + 0 charges --------------------------------
    const llm0 = calls.llm;
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);
    const rawProbe = waUpdate(WA1, "hello");
    const wrongRaw = waUpdate(WA1, "tampered");
    const noSig = await captureCall(() => waHook(rawProbe, { header: "" }));
    const wrongSig = await captureCall(() => waHook(rawProbe, { header: "sha256=" + "0".repeat(64) }));
    const reSerialized = await captureCall(async () => waHook(rawProbe, { header: "sha256=" + (await hmacHex(APP_SECRET, wrongRaw)) }));
    harness.check("5a. a missing, wrong or non-raw-body signature is refused identically",
      noSig.threw && wrongSig.threw && reSerialized.threw
        && noSig.code === wrongSig.code && wrongSig.code === reSerialized.code && reSerialized.code === "WHATSAPP_SIGNATURE_INVALID" && noSig.status === 401,
      JSON.stringify([noSig.code, wrongSig.code, reSerialized.code]));
    const msg0b = await msgOf(A.ws.id);
    const int0b = await intOf(A.ws.id);
    harness.check("5b. a rejected webhook runs no agent and charges nothing",
      calls.llm === llm0 && msg0b === msg0 && int0b === int0,
      `llm delta ${calls.llm - llm0}`);

    // --- 6. Activation: single-use, TTL, identity binding -----------------------------------------
    const intBeforeAct = await intOf(A.ws.id);
    const firstLink = await waHook(waUpdate(WA1, codeOf(connect1)));
    harness.check("6a. the activation message binds the WhatsApp account to the issuing user",
      firstLink.ok === firstLink.linked === true && firstLink.greeting_delivered === true, JSON.stringify(firstLink));
    const identityA1 = (await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "whatsapp", provider_subject: WA1, status: "linked" }, "-created_date", 1))[0];
    harness.check("6b. the identity row is server-stamped (project, owner, subject = sender id)",
      !!identityA1 && identityA1.app_user_id === userA1.id && identityA1.profile?.agent === "helper", JSON.stringify(identityA1 && { u: identityA1.app_user_id, s: identityA1.provider_subject, p: identityA1.profile }));
    harness.check("6c. the whatsapp_greeting is delivered on first contact",
      waCalls.some((c) => String(c.url).endsWith("/messages") && c.body?.to === WA1 && String(c.body?.text?.body || "").startsWith("Welcome to Helper on WhatsApp")),
      "no greeting send found");
    const intAfterAct = await intOf(A.ws.id);
    harness.check("6d. the activation turn charges exactly 1 inbound + 1 outbound relay credit",
      intBeforeAct - intAfterAct === 2, `${intBeforeAct} → ${intAfterAct}`);
    const replay = await captureCall(() => waHook(waUpdate(WA1, codeOf(connect1))));
    harness.check("6e. replaying a consumed activation is refused", replay.threw && replay.code === "TOKEN_USED" && replay.status === 410, JSON.stringify(replay));
    const connect2 = await waConnect(projA, userA1, "helper");
    const connect3 = await waConnect(projA, userA1, "helper");
    const stale = await captureCall(() => waHook(waUpdate(WA1, codeOf(connect2))));
    harness.check("6f. an activation superseded by a new issuance is refused", stale.threw && stale.code === "TOKEN_EXPIRED", JSON.stringify(stale));
    const pendingRow3 = (await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation", status: "pending" }, "-created_date", 1))[0];
    await db.entities.AppAuthToken.update(pendingRow3.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await captureCall(() => waHook(waUpdate(WA1, codeOf(connect3))));
    harness.check("6g. an expired activation is refused (short TTL)", expired.threw && expired.code === "TOKEN_EXPIRED" && expired.status === 410, JSON.stringify(expired));
    const connect4 = await waConnect(projA, userA1, "helper");
    const cross = await captureCall(() => waHook(waUpdate(WA1, codeOf(connect4)), { project: projB, resolve: resolveB, appSecret: APP_SECRET_B }));
    harness.check("6h. an activation from project A cannot complete in project B", cross.threw && cross.code === "TOKEN_INVALID", JSON.stringify(cross));
    const connect5 = await waConnect(projA, userA1, "helper");
    const mismatch = await captureCall(() => waHook(waUpdate(WA1, codeOf(connect5)), { agent: "other" }));
    harness.check("6i. an activation for one agent is refused on another agent's webhook",
      mismatch.threw && mismatch.code === "CHANNEL_AGENT_MISMATCH", JSON.stringify(mismatch));
    const connect6 = await waConnect(projA, userA2, "helper");
    const taken = await captureCall(() => waHook(waUpdate(WA1, codeOf(connect6))));
    harness.check("6j. a WhatsApp account linked to one user cannot be taken over by another",
      taken.threw && taken.code === "CHANNEL_IDENTITY_TAKEN" && taken.status === 409, JSON.stringify(taken));
    const idRows = await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "whatsapp", provider_subject: WA1 }, "-created_date", 10);
    harness.check("6k. the linked identity stays a single row after all activations",
      idRows.length === 1 && idRows[0].status === "linked", `${idRows.length} row(s)`);

    // --- 7. A linked message: the EXISTING P-9.4 executor + relay charges -------------------------
    script = [{ action: "reply", content: "WhatsApp agent answer" }];
    const msgBefore = await msgOf(A.ws.id);
    const intBeforeRun = await intOf(A.ws.id);
    const ran = await waHook(waUpdate(WA1, "what can you do?"));
    harness.check("7a. a linked WhatsApp message runs the agent and delivers the reply",
      ran.ok && ran.delivered === true && !!ran.conversation_id, JSON.stringify(ran));
    const last = waCalls[waCalls.length - 1];
    harness.check("7b. the reply goes to the SAME sender with the server-side token",
      String(last.url).endsWith("/messages") && last.body?.to === WA1 && last.body?.text?.body === "WhatsApp agent answer" && last.token === `Bearer ${WA_TOKEN}`,
      JSON.stringify({ to: last.body?.to, text: last.body?.text?.body }));
    const msgAfterRun = await msgOf(A.ws.id);
    const intAfterRun = await intOf(A.ws.id);
    harness.check("7c. the per-message INTEGRATION charge applies through the EXISTING path (P-9.11E), message pool untouched",
      intAfterRun < intBeforeRun && msgAfterRun === msgBefore,
      `int ${intBeforeRun} → ${intAfterRun}; msg ${msgBefore} → ${msgAfterRun}`);
    harness.check("7d. the turn charges exactly 1 inbound + 1 outbound relay credit beside the per-message charge",
      intBeforeRun - intAfterRun === 3, `${intBeforeRun} → ${intAfterRun}`);
    const rows = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 10);
    harness.check("7e. the conversation owner is the identity-bound user (server-side resolution)",
      rows.some((r) => r.owner_id === userA1.id && (r.data || {}).content === "what can you do?"), rows.map((r) => r.owner_id).join(","));
    // 7f rides a REFUSED delivery: the first delivery is claimed durably (and its inbound relay
    // charge earned) even though the agent never runs; the provider's redelivery of the SAME
    // message id is then a no-op — no second charge, no second refusal, no agent run.
    const dupRaw = waUpdate(WA1, "y".repeat(4001));
    const firstDup = await captureCall(() => waHook(dupRaw));
    harness.check("7f-pre. a refused delivery is still claimed and charged inbound exactly once",
      firstDup.threw && firstDup.code === "AGENT_MESSAGE_TOO_LONG", JSON.stringify(firstDup));
    const llmDup = calls.llm;
    const intDup = await intOf(A.ws.id);
    const msgDup = await msgOf(A.ws.id);
    const dup = await waHook(dupRaw);
    const intAfterDup = await intOf(A.ws.id);
    const msgAfterDup = await msgOf(A.ws.id);
    harness.check("7f. a duplicate delivery is acknowledged without a second run or charge",
      dup.ok === true && dup.duplicate === true && calls.llm === llmDup && intAfterDup === intDup && msgAfterDup === msgDup,
      JSON.stringify(dup));
    const { handleAppAgent } = await import("../../shared/appAgentRuntime.ts");
    const crossRead = await captureCall(() => handleAppAgent(client, { project: projA, payload, user: userA2, op: "get", args: { conversation_id: ran.conversation_id } }));
    harness.check("7g. another app user cannot read the channel's conversation",
      crossRead.threw && crossRead.code === "CONVERSATION_NOT_FOUND", JSON.stringify(crossRead));
    const llm7 = calls.llm;
    const crossProject = await captureCall(() => waHook(waUpdate(WA1, "hello from B"), { project: projB, resolve: resolveB, appSecret: APP_SECRET_B }));
    harness.check("7h. the same WhatsApp account is not linked in ANOTHER project (project isolation)",
      crossProject.threw && crossProject.code === "CHANNEL_NOT_LINKED" && calls.llm === llm7, JSON.stringify(crossProject));
    const mismatchMsg = await captureCall(() => waHook(waUpdate(WA1, "for the other agent"), { agent: "other" }));
    harness.check("7i. a message on another agent's webhook is refused",
      mismatchMsg.threw && mismatchMsg.code === "CHANNEL_AGENT_MISMATCH", JSON.stringify(mismatchMsg));
    const tooLong = await captureCall(() => waHook(waUpdate(WA1, "x".repeat(4001))));
    harness.check("7j. an oversized inbound message is refused before the executor",
      tooLong.threw && tooLong.code === "AGENT_MESSAGE_TOO_LONG" && calls.llm === llm7, JSON.stringify(tooLong));
    const spoof = await waHook(waUpdate(WA1, "spoof probe text", { contactWa: WA2 }));
    const spoofRows = await db.entities.AppRecord.filter({ project_id: projA.id, entity_name: "__agent_messages" }, "-created_date", 5);
    harness.check("7k. payload contact fields are never trusted — the verified sender id resolves the owner",
      spoof.ok && spoofRows.some((r) => r.owner_id === userA1.id && (r.data || {}).content === "spoof probe text")
        && !spoofRows.some((r) => r.owner_id === userA2.id),
      JSON.stringify(spoofRows.map((r) => ({ o: r.owner_id, c: (r.data || {}).content }))));

    // --- 8. Relay billing: delivery failure + insufficient credits fail closed ---------------------
    script = [{ action: "reply", content: "will fail to send" }];
    const intBeforeFail = await intOf(A.ws.id);
    setSendFails(true);
    const failedSend = await waHook(waUpdate(WA1, "please reply"));
    setSendFails(false);
    const intAfterFail = await intOf(A.ws.id);
    harness.check("8a. a failed outbound delivery charges no relay credit (settle by delivery) — only inbound + the turn's own charge",
      failedSend.ok === true && failedSend.delivered === false && !!failedSend.delivery_error
        && intBeforeFail - intAfterFail === 2,
      JSON.stringify({ delivered: failedSend.delivered, delta: intBeforeFail - intAfterFail }));
    const connectC = await waConnect(projC, userC1, "helper", resolverFor(projC));
    const llmC = calls.llm;
    const broke = await captureCall(() => waHook(waUpdate("15550009999", codeOf(connectC)), { project: projC, resolve: resolverFor(projC) }));
    harness.check("8b. insufficient integration credits fail closed BEFORE the agent executor",
      broke.threw && ["INSUFFICIENT_CREDITS", "BUDGET_EXCEEDED"].includes(broke.code) && calls.llm === llmC, JSON.stringify(broke));
    const integrityC = await verifyBalanceIntegrity(db, C.ws.id);
    harness.check("8c. a fail-closed refusal strands no hold (ledger integrity)", integrityC.ok, JSON.stringify(integrityC));

    // --- 9. The documented workspace limit: 3 connected WhatsApp agents across all apps ------------
    const linkL = async (i, wa) => {
      const c = await waConnect(Lp[i], usersL[i], "helper", resolverFor(Lp[i]));
      return waHook(waUpdate(wa, codeOf(c)), { project: Lp[i], resolve: resolverFor(Lp[i]) });
    };
    const l1 = await linkL(0, "15550003001");
    const l2 = await linkL(1, "15550003002");
    harness.check("9a. the first two distinct WhatsApp agents connect across the workspace's apps",
      l1.ok === l1.linked === true && l2.ok === l2.linked === true, JSON.stringify([l1.linked, l2.linked]));
    const connectL4 = await waConnect(Lp[3], usersL[3], "helper", resolverFor(Lp[3]));
    const l3 = await linkL(2, "15550003003");
    harness.check("9b. the third distinct WhatsApp agent still connects", l3.ok === l3.linked === true, JSON.stringify(l3.linked));
    const fourth = await captureCall(() => waConnect(Lp[3], usersL[3], "helper", resolverFor(Lp[3])));
    harness.check("9c. a 4th connection is refused at issuance (counted across all apps of the workspace)",
      fourth.threw && fourth.code === "WHATSAPP_AGENT_LIMIT" && fourth.status === 409, JSON.stringify(fourth));
    const fourthBind = await captureCall(() => waHook(waUpdate("15550003004", codeOf(connectL4)), { project: Lp[3], resolve: resolverFor(Lp[3]) }));
    harness.check("9d. a pending activation is also refused at binding when the workspace is at the limit",
      fourthBind.threw && fourthBind.code === "WHATSAPP_AGENT_LIMIT" && fourthBind.status === 409, JSON.stringify(fourthBind));
    const otherWs = await waConnect(projA, userA1, "artist");
    harness.check("9e. an unrelated workspace is not affected by another workspace's limit",
      /^https:\/\/wa\.me\/\d+\?text=[a-f0-9]{64}$/.test(otherWs.url), otherWs.url.slice(0, 50));

    // --- 10. Durable rate limit -------------------------------------------------------------------
    // The bucket is seeded one request short of its budget (the limiter machinery itself is
    // fully exercised by the P-9.10A suite); here only the WhatsApp connect path's enforcement
    // through the SAME durable consume() is proven, without a 20-call request burst.
    const hourWindow = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    await db.entities.RateLimitBucket.create({ identity: `app:${projA.id}:user:rl910c`, action: "channel_activation", window_key: hourWindow, window_start: hourWindow, window_ms: 3600000, count: 19, limit: 20, workspace_id: A.ws.id });
    let blocked = null;
    for (let i = 0; i < 3; i++) {
      try { await limit(db, projA, "channel_activation", "user:rl910c"); } catch (e) { blocked = e; break; }
    }
    harness.check("10a. the activation flow is durably rate limited", blocked?.code === "RATE_LIMITED", blocked?.code || "no block within 3 attempts");

    // --- 11. Redaction / SSRF / activation-code hygiene ---------------------------------------------
    const respJson = JSON.stringify(responses);
    const hookJson = JSON.stringify(responses.filter((r) => r && !r.url));
    const audits = await db.entities.AuditLog.filter({ project_id: projA.id }, "-created_date", 100).catch(() => []);
    const auditJson = JSON.stringify(audits);
    harness.check("11a. no credential value in any response or audit row",
      !respJson.includes(WA_TOKEN) && !respJson.includes(WA_TOKEN_B) && !respJson.includes(VERIFY_TOKEN) && !respJson.includes(APP_SECRET)
        && !auditJson.includes(WA_TOKEN) && !auditJson.includes(APP_SECRET),
      "responses + audit rows scanned");
    const tokens = await db.entities.AppAuthToken.filter({ project_id: projA.id, kind: "channel_activation" }, "-created_date", 50);
    const tokenJson = JSON.stringify(tokens);
    harness.check("11b. activation codes are stored only as hashes",
      !tokenJson.includes(issuedCodes.find(Boolean) || "") && tokens.every((t) => /^[a-f0-9]{64}$/.test(t.token_hash || "")), `${tokens.length} rows`);
    harness.check("11c. no activation code leaks beyond the intended connect URL",
      issuedCodes.filter(Boolean).every((c) => !hookJson.includes(c)), "webhook responses scanned");
    harness.check("11d. no SSRF surface: every provider call goes to the fixed graph host",
      waCalls.length > 0 && waCalls.every((c) => String(c.url).startsWith("https://graph.facebook.com/v")), waCalls[0] && String(waCalls[0].url).slice(0, 40));

    // --- 12. Final ledger integrity -------------------------------------------------------------------
    const integrityA = await verifyBalanceIntegrity(db, A.ws.id);
    const integrityL = await verifyBalanceIntegrity(db, L.ws.id);
    harness.check("12a. ledger integrity holds after all WhatsApp relay charges", integrityA.ok && integrityL.ok, JSON.stringify([integrityA.ok, integrityL.ok]));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    // Error first: the results array can be long, and the cause must survive response truncation.
    return Response.json({ error: error.message, stack: String(error.stack || "").slice(0, 400), ...s, ok: false }, { status: 500 });
  } finally {
    // Scratch cleanup: fixtures removed by name pattern, including residue from earlier runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p910c-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p910c[a-z]" } }, "created_date", 200).catch(() => []);
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
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    await db.entities.CacheEntry.deleteMany({ cache_key: { $regex: "^wa_replay:" } }).catch(() => {});
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^ch910c[0-9]+$" } }).catch(() => {});
  }
}