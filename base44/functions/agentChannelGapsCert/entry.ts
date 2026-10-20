// P-9.13 certification — the confirmed Superagent channel/browser gaps, closed in one batch:
// browser extension (bridge), Phone, iMessage, WhatsApp groups — plus the existing-channel
// regression. Drives the REAL shipping modules (appAgentChannels / agentBrowserBridge /
// agentChannelGaps / appAuth / appOAuth / appAgentRuntime / integrationCharges) with the REAL
// canonical billing paths — only the providers are scripted (counters prove fail-closed happens
// before them). Asserts, in order:
//   A. Browser extension — pairing through the certified dispatcher (single-use, 10-minute
//      activation token), activation into a hashed 24h bridge session + AppIdentity, one-time
//      consumption, channel/agent mismatch refusals, session resolution (invalid/expired →
//      null), browse fail-closed (non-https, private host, no fetch executed), bounded browse
//      with scripted fetch, the LLM fill plan (sensitive field types never fillable, unknown
//      names dropped, bounded, LLM failure surfaces a 502).
//   P/I. Phone + iMessage — the exact fail-closed transport blocker for the lifecycle.
//   G. WhatsApp groups — group message routing (group_id + participant sender), group reply
//      with recipient_type "group", relay charges, duplicate replay, bad signature (0 runs, 0
//      charges), unlinked participant refusal, group activation ignored, the 1:1 regression
//      (individual path unchanged), the documented group_create op and the
//      group_lifecycle_update invite-link delivery.
//   R. Existing channels — Telegram through the SAME dispatcher (bad secret refused, linked
//      message answered) and the unknown-channel refusal.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { grantTestPool } from "../../shared/creditPoolTestHelpers.ts";
import { sha256Hex } from "../../shared/hash.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import {
  handleAppChannelConnect, handleWhatsAppUpdate, handleTelegramUpdate,
  WHATSAPP_TOKEN_SECRET, WHATSAPP_PHONE_NUMBER_ID_SECRET, WHATSAPP_VERIFY_TOKEN_SECRET, WHATSAPP_APP_SECRET_NAME,
  WHATSAPP_GROUP_SUBJECT_MAX_CHARS,
  TELEGRAM_BOT_TOKEN_SECRET, TELEGRAM_WEBHOOK_SECRET_NAME,
} from "../../shared/appAgentChannels.ts";
import {
  connectBrowserExtension, activateBridgeSession, resolveBridgeSession, bridgeBrowse, buildFillPlan,
  BRIDGE_PAIRING_TTL_MS, BRIDGE_SESSION_TTL_MS, BRIDGE_MAX_FILL_FIELDS,
} from "../../shared/agentBrowserBridge.ts";
import {
  phoneChannelTransportUnavailable, imessageChannelTransportUnavailable,
  PHONE_CHANNEL_BLOCKER, IMESSAGE_CHANNEL_BLOCKER,
  PHONE_TRANSPORT_UNAVAILABLE_CODE, IMESSAGE_TRANSPORT_UNAVAILABLE_CODE,
} from "../../shared/agentChannelGaps.ts";
import { issueToken, createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentPoolTools, makeAgentProject, setProjectSecret, projectSecretResolver } from "../../shared/appAgentTestFixtures.ts";
import { hmacWaHex, makeWaHttp, makeWaUpdate, makeWaLifecycle } from "../../shared/whatsappChannelTestHelpers.ts";

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  const WA_TOKEN = `p913g-token-${stamp}`;
  const VERIFY_TOKEN = `p913g-verify-${stamp}`;
  const APP_SECRET = `p913g-appsecret-${stamp}`;
  const WA_NUMBER = `1555000${String(stamp).slice(-4)}`;
  const PNID = `pnid${stamp}`;
  const WA1 = "15550001111";
  const WA2 = "15550002222"; // never linked — the unlinked-group-participant probe
  const GROUP_ID = `p913ggroup${stamp}`;
  const INVITE = `https://chat.whatsapp.com/invite${stamp}`;
  const TG_CHAT = `tgchat${stamp}`;

  // ---- WhatsApp Cloud API stub (shared certification stub) ---------------------------------
  const { http: waHttp, calls: waCalls } = makeWaHttp({ waNumber: WA_NUMBER, pnid: PNID, groupResponse: { id: GROUP_ID } });
  const waUpdate = makeWaUpdate({ waNumber: WA_NUMBER, pnid: PNID });
  const waLifecycle = makeWaLifecycle({ waNumber: WA_NUMBER, pnid: PNID });

  // ---- Telegram Bot API stub ------------------------------------------------------------
  const tgCalls = [];
  const tgHttp = async (url, init = {}) => {
    tgCalls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    if (String(url).includes("/getMe")) {
      return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "nexus_bot" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };

  // ---- model provider stub (P-9.4 pattern): the executor and billing paths are REAL ----
  const calls = { llm: 0 };
  let script = [];
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
      { name: "helper", display_name: "Helper", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {}, whatsapp_greeting: `Welcome to Helper (${stamp})` },
      { name: "artist", display_name: "Artist", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {} },
    ],
    entities: [],
  };

  const { intOf } = makeAgentPoolTools(db, stamp, "p913g");

  // The certified surfaces run against the fixture project + user; declared at this scope so the
  // closures below can reach them.
  let projA = null;
  let userA1 = null;
  let resolveA = null;

  const connect = async (args, user = userA1, http = waHttp) => {
    await appAgentPace(900);
    return handleAppChannelConnect(client, { project: projA, payload, user, args, resolveSecret: resolveA, http });
  };
  const waHook = async (raw, { agent = "helper", header, appSecret = APP_SECRET } = {}) => {
    await appAgentPace(900);
    const sig = header !== undefined ? header : "sha256=" + (await hmacWaHex(appSecret, raw));
    return handleWhatsAppUpdate(client, {
      project: projA, payload, update: JSON.parse(raw), agentName: agent,
      signatureHeader: sig, rawBody: raw, resolveSecret: resolveA, http: waHttp, options: opts,
    });
  };
  const waMsgs = () => [...waCalls].reverse().filter((c) => String(c.url).endsWith("/messages"));

  try {
    // --- fixtures: one funded workspace + project with real (encrypted) channel secrets ------
    const plan = await makeBillingPlan(db, created, `ch913g${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p913ga${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "message", amount: 200, key: `p913g:msg:A:${stamp}`, reason: "P-9.13G test grant" });
    await grantTestPool(db, { workspace_id: A.ws.id, pool: "integration", amount: 200, key: `p913g:int:A:${stamp}`, reason: "P-9.13G test grant" });
    projA = await makeAgentProject(db, projectIds, A, `${stamp}`, "p913g");
    userA1 = await createPasswordlessUser(db, projA, { email: "a1@p913g.test", display_name: "A1", email_verified: true });
    for (const [name, value] of [
      [WHATSAPP_TOKEN_SECRET, WA_TOKEN], [WHATSAPP_PHONE_NUMBER_ID_SECRET, PNID],
      [WHATSAPP_VERIFY_TOKEN_SECRET, VERIFY_TOKEN], [WHATSAPP_APP_SECRET_NAME, APP_SECRET],
      [TELEGRAM_BOT_TOKEN_SECRET, `tg-token-${stamp}`], [TELEGRAM_WEBHOOK_SECRET_NAME, `tg-secret-${stamp}`],
    ]) await setProjectSecret(db, projA, name, value);
    resolveA = projectSecretResolver(db, projA);

    // --- A. BROWSER EXTENSION ------------------------------------------------------------------
    const pairA = await connect({ channel: "browser_extension", agent: "helper" });
    harness.check("A1. pairing issues the certified single-use activation token through the dispatcher",
      pairA.channel === "browser_extension" && pairA.agent === "helper" && /^[a-f0-9]{64}$/.test(pairA.token) && pairA.expires_in_ms === BRIDGE_PAIRING_TTL_MS,
      JSON.stringify(pairA && { channel: pairA.channel, t: pairA.token?.slice(0, 8), ttl: pairA.expires_in_ms }));
    const activated = await activateBridgeSession(db, projA, { token: pairA.token, agentName: "helper" });
    harness.check("A2. a valid pairing activates into a hashed 24h session bound to the agent",
      activated.session_token && /^[a-f0-9]{64}$/.test(activated.session_token) && activated.agent === "helper" && activated.expires_in_ms === BRIDGE_SESSION_TTL_MS,
      JSON.stringify(activated && { agent: activated.agent, ttl: activated.expires_in_ms }));
    const bridgeIdentity = (await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "browser_extension", status: "linked" }, "-created_date", 1))[0];
    harness.check("A3. activation stamps the EXISTING AppIdentity contract (provider browser_extension, subject = the app user)",
      !!bridgeIdentity && bridgeIdentity.app_user_id === userA1.id && bridgeIdentity.provider_subject === `user:${userA1.id}`, JSON.stringify(bridgeIdentity && { s: bridgeIdentity.provider_subject }));
    const reActivate = await captureCall(() => activateBridgeSession(db, projA, { token: pairA.token, agentName: "helper" }));
    harness.check("A4. a pairing token is consumed exactly once", reActivate.threw && reActivate.code === "TOKEN_USED", JSON.stringify(reActivate));
    const tgishToken = (await issueToken(db, projA, { user: userA1, kind: "channel_activation", ttl_ms: BRIDGE_PAIRING_TTL_MS, data: { channel: "telegram", agent: "helper" } })).token;
    const wrongChannel = await captureCall(() => activateBridgeSession(db, projA, { token: tgishToken, agentName: "" }));
    harness.check("A5. an activation token of ANOTHER channel is refused by the bridge",
      wrongChannel.threw && wrongChannel.code === "CHANNEL_STATE_MISMATCH", JSON.stringify(wrongChannel));
    const pairB = await connect({ channel: "browser_extension", agent: "artist" });
    const wrongAgent = await captureCall(() => activateBridgeSession(db, projA, { token: pairB.token, agentName: "helper" }));
    harness.check("A6. activating another agent's pairing for the wrong agent is refused",
      wrongAgent.threw && wrongAgent.code === "CHANNEL_AGENT_MISMATCH" && wrongAgent.status === 409, JSON.stringify(wrongAgent));
    const badSession = await resolveBridgeSession(db, projA, { sessionToken: "f".repeat(64) });
    const expiredRow = "e".repeat(64);
    await db.entities.AppAuthToken.create({
      project_id: projA.id, app_user_id: userA1.id, kind: "browser_bridge_session", token_hash: await sha256Hex(expiredRow),
      status: "pending", expires_at: new Date(Date.now() - 1000).toISOString(), data: { channel: "browser_extension", agent: "helper" }, created_at: new Date().toISOString(),
    });
    const expiredSession = await resolveBridgeSession(db, projA, { sessionToken: expiredRow });
    harness.check("A7. session resolution fails closed: unknown and expired sessions resolve to null",
      badSession === null && expiredSession === null, JSON.stringify([badSession, expiredSession]));
    let browseFetches = 0;
    const markerFetch = async () => { browseFetches++; return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }); };
    const httpUrl = await captureCall(() => bridgeBrowse({ url: "http://example.com/page", fetchImpl: markerFetch }));
    const privateUrl = await captureCall(() => bridgeBrowse({ url: "https://192.168.1.10/page", fetchImpl: markerFetch }));
    harness.check("A8. browse refuses non-https and private hosts BEFORE any fetch",
      httpUrl.threw && privateUrl.threw && httpUrl.code === "BRIDGE_URL_REFUSED" && privateUrl.code === "BRIDGE_URL_REFUSED" && browseFetches === 0,
      JSON.stringify([httpUrl.code, privateUrl.code, browseFetches]));
    const pageHtml = `<html><head><title>Sign up</title></head><body><p>Join our service</p><a href="/about">About</a>` +
      `<form action="/signup"><input name="email" type="email" placeholder="You"><textarea name="notes"></textarea>` +
      `<input name="pwd" type="password"></form></body></html>`;
    const browsed = await bridgeBrowse({ url: "https://example.com/signup", fetchImpl: async () => new Response(pageHtml, { status: 200, headers: { "content-type": "text/html" } }) });
    harness.check("A9. a valid browse returns bounded extracted text, links and form fields",
      browsed.title === "Sign up" && browsed.text.includes("Join our service") && browsed.links[0] === "/about"
        && browsed.forms[0]?.fields?.some((f) => f.name === "email") && browsed.forms[0]?.fields?.some((f) => f.name === "notes"),
      JSON.stringify(browsed && { t: browsed.title, forms: browsed.forms }));
    const fillScript = { fills: [{ name: "email", value: "a@example.com" }, { name: "notes", value: "please" }, { name: "ghost_field", value: "dropped" }], notes: "ok" };
    const fillPlan = await buildFillPlan({
      llm: async () => fillScript, intent: "sign up",
      fields: [{ name: "email", type: "email", label: "You" }, { name: "notes", type: "textarea" }, { name: "pwd", type: "password" }, { name: "doc", type: "file" }],
    });
    harness.check("A10. the fill plan contains values ONLY for fillable names — password/file are never fillable, unknown names are dropped",
      fillPlan.fills.length === 2 && fillPlan.fills.every((f) => ["email", "notes"].includes(f.name)), JSON.stringify(fillPlan));
    const tooMany = await captureCall(() => buildFillPlan({
      llm: async () => fillScript, intent: "x", fields: Array.from({ length: BRIDGE_MAX_FILL_FIELDS + 1 }, (_, i) => ({ name: `f${i}`, type: "text" })),
    }));
    const nothing = await captureCall(() => buildFillPlan({ llm: async () => fillScript, intent: "x", fields: [{ name: "pwd", type: "password" }] }));
    const llmDown = await captureCall(() => buildFillPlan({ llm: async () => { throw new Error("llm down"); }, intent: "x", fields: [{ name: "email", type: "email" }] }));
    harness.check("A11. fill permission failures: >30 fields, nothing fillable, and an LLM failure are all refused fail-closed",
      tooMany.threw && tooMany.code === "BRIDGE_TOO_MANY_FIELDS" && nothing.threw && nothing.code === "BRIDGE_NOTHING_FILLABLE"
        && llmDown.threw && llmDown.code === "BRIDGE_FILL_UNAVAILABLE" && llmDown.status === 502,
      JSON.stringify([tooMany.code, nothing.code, llmDown.code]));

    // --- P/I. PHONE + IMESSAGE -----------------------------------------------------------------
    const phoneRefused = await captureCall(() => phoneChannelTransportUnavailable());
    const imessageRefused = await captureCall(() => imessageChannelTransportUnavailable());
    harness.check("P1. the Phone lifecycle fails closed with the EXACT documented transport blocker",
      phoneRefused.threw && phoneRefused.code === PHONE_TRANSPORT_UNAVAILABLE_CODE && phoneRefused.status === 501
        && /no telephony provider contract/i.test(PHONE_CHANNEL_BLOCKER) && !PHONE_CHANNEL_BLOCKER.includes(WA_TOKEN),
      JSON.stringify({ code: phoneRefused.code, status: phoneRefused.status }));
    harness.check("I1. the iMessage lifecycle fails closed with the EXACT documented transport blocker",
      imessageRefused.threw && imessageRefused.code === IMESSAGE_TRANSPORT_UNAVAILABLE_CODE && imessageRefused.status === 501
        && /no public iMessage API/i.test(IMESSAGE_CHANNEL_BLOCKER) && /WhatsApp Cloud API/i.test(IMESSAGE_CHANNEL_BLOCKER),
      JSON.stringify({ code: imessageRefused.code, status: imessageRefused.status }));

    // --- G. WHATSAPP GROUPS ---------------------------------------------------------------------
    const intBeforeLink = await intOf(A.ws.id);
    const waConnect = await connect({ channel: "whatsapp", agent: "helper" });
    const waCode = String(new URL(waConnect.url).searchParams.get("text") || "");
    const linked = await waHook(waUpdate(WA1, waCode));
    harness.check("G1. the 1:1 activation binds the sender before the group probes",
      linked.ok === true && linked.linked === true, JSON.stringify(linked));

    script = [{ action: "reply", content: "Group answer" }];
    const llmBeforeGroup = calls.llm;
    const intBeforeGroup = await intOf(A.ws.id);
    const groupRaw = waUpdate(WA1, "hello group", { groupId: GROUP_ID });
    const groupMsgId = JSON.parse(groupRaw).entry[0].changes[0].value.messages[0].id;
    const groupMsg = await waHook(groupRaw);
    const groupSend = waMsgs()[0];
    const intAfterGroup = await intOf(A.ws.id);
    harness.check("G2. a group message is routed to the agent and answered IN THE GROUP (recipient_type group, to = group id)",
      groupMsg.ok === true && groupMsg.delivered === true && groupSend?.body?.recipient_type === "group" && groupSend?.body?.to === GROUP_ID,
      JSON.stringify(groupSend?.body));
    // The parity suite's 8a pins the 1:1 turn: inbound (1) + the turn's own charge (1) + the
    // outbound relay (1, settled by delivery) — the group turn must charge the SAME total.
    harness.check("G3. the group turn charges the SAME relay rate as the 1:1 turn (inbound + own charge + outbound)",
      intBeforeGroup - intAfterGroup === 3, `${intBeforeGroup} → ${intAfterGroup}`);
    const groupReplay = await waHook(waUpdate(WA1, "hello group", { groupId: GROUP_ID, id: groupMsgId }));
    const intAfterReplay = await intOf(A.ws.id);
    harness.check("G4. a redelivered group message is a durable duplicate: no second run, no second charge",
      groupReplay.duplicate === true && calls.llm === llmBeforeGroup + 1 && intAfterReplay === intAfterGroup,
      JSON.stringify({ duplicate: groupReplay.duplicate, llm: calls.llm - llmBeforeGroup, credits: intAfterReplay - intAfterGroup }));
    const llmBeforeBadSig = calls.llm;
    const intBeforeBadSig = await intOf(A.ws.id);
    const badSigGroup = await captureCall(() => waHook(waUpdate(WA1, "tampered group", { groupId: GROUP_ID }), { header: "sha256=" + "0".repeat(64) }));
    const intAfterBadSig = await intOf(A.ws.id);
    harness.check("G5. a bad-signature GROUP delivery is refused before any run or charge",
      badSigGroup.threw && badSigGroup.code === "WHATSAPP_SIGNATURE_INVALID" && badSigGroup.status === 401
        && calls.llm === llmBeforeBadSig && intAfterBadSig === intBeforeBadSig,
      JSON.stringify({ code: badSigGroup.code, llm: calls.llm - llmBeforeBadSig, credits: intAfterBadSig - intBeforeBadSig }));
    const unlinkedGroup = await captureCall(() => waHook(waUpdate(WA2, "who are you", { groupId: GROUP_ID })));
    harness.check("G6. an unlinked group participant follows the SAME certified refusal (owner approval semantics preserved)",
      unlinkedGroup.threw && unlinkedGroup.code === "CHANNEL_NOT_LINKED" && unlinkedGroup.status === 403, JSON.stringify(unlinkedGroup));
    const freshConnect = await connect({ channel: "whatsapp", agent: "helper" });
    const freshCode = String(new URL(freshConnect.url).searchParams.get("text") || "");
    const groupActivation = await waHook(waUpdate(WA1, freshCode, { groupId: GROUP_ID }));
    harness.check("G7. a group delivery NEVER consumes an activation code (private DM contract)",
      groupActivation.ignored === true, JSON.stringify(groupActivation));
    const directActivation = await waHook(waUpdate(WA1, freshCode));
    harness.check("G8. the same code STILL activates through a direct message — the 1:1 path is unchanged",
      directActivation.ok === true && directActivation.linked === true, JSON.stringify(directActivation));
    script = [{ action: "reply", content: "Direct answer" }];
    const oneToOne = await waHook(waUpdate(WA1, "hi there"));
    const oneToOneSend = waMsgs()[0];
    harness.check("G9. 1:1 REGRESSION: the individual reply is byte-identical (recipient_type individual, to = the sender)",
      oneToOne.ok === true && oneToOne.delivered === true && oneToOneSend?.body?.recipient_type === "individual" && oneToOneSend?.body?.to === WA1,
      JSON.stringify(oneToOneSend?.body));

    const groupCreate = await connect({ channel: "whatsapp", op: "group_create", agent: "helper", subject: `Trip ${stamp}`, description: "planning" });
    const createCall = [...waCalls].reverse().find((c) => String(c.url).endsWith("/groups"));
    harness.check("G10. the documented group_create op calls the provider's create endpoint with the scrubbed subject",
      groupCreate.channel === "whatsapp" && groupCreate.op === "group_create" && groupCreate.group_id === GROUP_ID
        && createCall?.body?.subject === `Trip ${stamp}` && createCall?.body?.messaging_product === "whatsapp"
        && WHATSAPP_GROUP_SUBJECT_MAX_CHARS === 128,
      JSON.stringify(createCall?.body));
    // Documented pending contract: the project's MOST RECENT create within the TTL — the first
    // lifecycle event after the create delivers, then the pending is consumed.
    const inviteDelivery = await waHook(waLifecycle(GROUP_ID, INVITE));
    const inviteSend = waMsgs()[0];
    harness.check("G11. the provider's group_lifecycle_update webhook delivers the invite link to the requester as a DM, then the pending request is consumed",
      inviteDelivery.ok === true && inviteDelivery.invite_delivered === true
        && inviteSend?.body?.to === WA1 && String(inviteSend?.body?.text?.body || "").includes(INVITE),
      JSON.stringify(inviteSend?.body));
    const secondLifecycle = await waHook(waLifecycle(`othergroup${stamp}`, INVITE));
    harness.check("G12. a lifecycle event with NO pending request is acknowledged and ignored (no second delivery)",
      secondLifecycle.ignored === true, JSON.stringify(secondLifecycle));
    // G13: a redelivered lifecycle event for the SAME group (pending row restored, as if its
    // best-effort delete was lost) never DMs or charges twice.
    await db.entities.CacheEntry.create({ namespace: "whatsapp_group_pending", cache_key: `wa_group_pending:${projA.id}:${GROUP_ID}`,
      value: { app_user_id: userA1.id, agent: "helper", group_id: GROUP_ID }, expires_at: new Date(Date.now() + 60000).toISOString(),
      stale_at: new Date(Date.now() + 60000).toISOString(), size_bytes: 64, version: 1 });
    const sendsBefore = waCalls.length, intBeforeDup = await intOf(A.ws.id);
    const dupLifecycle = await waHook(waLifecycle(GROUP_ID, INVITE));
    harness.check("G13. a redelivered lifecycle event never sends the invite or charges twice",
      dupLifecycle.duplicate === true && waCalls.length === sendsBefore && (await intOf(A.ws.id)) === intBeforeDup,
      JSON.stringify({ dupLifecycle, sends: waCalls.length - sendsBefore }));

    // --- R. EXISTING CHANNEL REGRESSION ----------------------------------------------------------
    const unknownChannel = await captureCall(() => connect({ channel: "nonsense", agent: "helper" }));
    harness.check("R1. the dispatcher still refuses an unknown channel",
      unknownChannel.threw && unknownChannel.code === "CHANNEL_NOT_SUPPORTED", JSON.stringify(unknownChannel));
    const tgConnect = await connect({ channel: "telegram", agent: "helper" }, userA1, tgHttp);
    const tgCode = String(new URL(tgConnect.url).searchParams.get("start") || "");
    const badTgHook = await captureCall(() => handleTelegramUpdate(client, {
      project: projA, payload, update: { message: { chat: { id: TG_CHAT }, text: `/start ${tgCode}` } }, agentName: "helper",
      secretTokenHeader: "wrong", resolveSecret: resolveA, http: tgHttp, options: opts,
    }));
    harness.check("R2. the Telegram channel's secret-token gate is intact",
      badTgHook.threw && badTgHook.code === "TELEGRAM_SIGNATURE_INVALID" && badTgHook.status === 401, JSON.stringify(badTgHook));
    script = [{ action: "reply", content: "Telegram answer" }];
    const tgLinked = await handleTelegramUpdate(client, {
      project: projA, payload, update: { update_id: stamp + 1, message: { chat: { id: TG_CHAT }, text: `/start ${tgCode}` } }, agentName: "helper",
      secretTokenHeader: `tg-secret-${stamp}`, resolveSecret: resolveA, http: tgHttp, options: opts,
    });
    harness.check("R3. the Telegram channel regression: linked activation rides the unchanged path",
      tgLinked.linked === true, JSON.stringify(tgLinked));
    script = [{ action: "reply", content: "Telegram answer" }];
    const tgMsg = await handleTelegramUpdate(client, {
      project: projA, payload, update: { update_id: stamp + 2, message: { chat: { id: TG_CHAT }, text: "hi again" } }, agentName: "helper",
      secretTokenHeader: `tg-secret-${stamp}`, resolveSecret: resolveA, http: tgHttp, options: opts,
    });
    const tgReply = [...tgCalls].reverse().find((c) => String(c.url).includes("/sendMessage") && c.body?.text === "Telegram answer");
    harness.check("R4. the Telegram message path is unchanged end-to-end", tgMsg.delivered === true && !!tgReply, JSON.stringify([tgMsg, !!tgReply]));
    void intBeforeLink;

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ error: error.message, stack: String(error.stack || "").slice(0, 400), ...s, ok: false }, { status: 500 });
  } finally {
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p913g-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p913g[a-z]" } }, "created_date", 200).catch(() => []);
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
    await db.entities.CacheEntry.deleteMany({ cache_key: { $regex: "^(wa_replay:|wa_sent:|wa_group_pending:|wa_group_invite:|wa_group_sent:|tg_replay:|tg_sent:|anon_channel:)" } }).catch(() => {});
    if (wIds.length) {
      for (const w of wIds) {
        await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: w }).catch(() => {});
        await db.entities.Budget.deleteMany({ workspace_id: w }).catch(() => {});
        await db.entities.WorkspaceMember.deleteMany({ workspace_id: w }).catch(() => {});
        await db.entities.Workspace.deleteMany({ id: w }).catch(() => {});
      }
    }
    for (const c of created.plans || []) await db.entities.BillingPlan.delete(c.id).catch(() => {});
  }
}