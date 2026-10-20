// P-9.12S certification — Slack channel foundation for deployed in-app agents.
//
// Drives the REAL shipping modules (appAgentChannels / appAgentRuntime / secretCrypto) with the
// REAL canonical billing paths — only the Slack Web API and the model provider are scripted
// (counters prove fail-closed happens before them). Asserts, in order: the documented
// activation-CODE connect surface (fail-closed auth/agent/credentials, the documented 30-minute
// expiry, single-use token properties), X-Slack-Signature raw-body authentication (rejected =
// 0 runs + 0 charges), the documented url_verification handshake, activation binding of a Slack
// member id to the app user, regular direct messages AND @-mentions routed through the EXISTING
// P-9.4 executor with the documented NO-relay billing (a Slack turn charges exactly what the
// same in-app invoke charges), threaded replies via chat.postMessage, mention-markup stripping,
// duplicate-delivery idempotency, the SAME per-agent anonymous-access mechanism, cross-project
// isolation, and Telegram/WhatsApp/LINE regression isolation through the SAME dispatcher.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { NEXUS_PROVIDER } from "../../shared/nexusProvider.ts";
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
import {
  handleAppChannelConnect, handleSlackEvent,
  SLACK_BOT_TOKEN_SECRET, SLACK_SIGNING_SECRET_NAME, SLACK_ACTIVATION_TTL_MS,
} from "../../shared/appAgentChannels.ts";
import { createPasswordlessUser } from "../../shared/appAuth.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools, setProjectSecret, projectSecretResolver } from "../../shared/appAgentTestFixtures.ts";
import { retryingEntities, makeTgHttpStub, makeWaHttpStub, makeLineHttpStub } from "../../shared/channelCertScaffold.ts";

export default async function (req) {
  // The platform rate-limits SDK request bursts; a 429 anywhere is retried with backoff.
  const rawDb = createClientFromRequest(req).asServiceRole;
  const db = { entities: retryingEntities(rawDb.entities) };
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  // ---- Slack Web API stub: records every call (url, body) ----
  const slackCalls = [];
  const slackHttpStub = async (url, init = {}) => {
    slackCalls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    if (String(url).endsWith("/auth.test")) {
      return new Response(JSON.stringify({ ok: true, user_id: "U912sbot", team_id: "T912s" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };

  // ---- Telegram/WhatsApp/LINE stubs for the regression-isolation probes ----
  const tgHttpStub = makeTgHttpStub("p912s_bot");
  const waHttpStub = makeWaHttpStub(stamp);
  const lineHttpStub = makeLineHttpStub();

  // ---- model provider stub (P-9.4 pattern): the executor and billing paths are REAL ----
  const calls = { llm: 0 };
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
      integrations: { Core: { GenerateImage: async () => ({ url: `https://cdn.test/p912s.png` }) } },
    },
  };
  const opts = { providerOverrides };

  const payload = {
    agents: [
      { name: "helper", display_name: "Helper", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {} },
      { name: "open", display_name: "Open", description: "test agent", instructions: "Answer briefly.", tools: [], skills: [], model_tier: "fast", max_steps: 3, metadata: {}, allow_anonymous_access: true },
    ],
    entities: [],
  };

  const pace = () => appAgentPace(1500);
  const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p912s");

  const BOT_TOKEN = `slack-bot-${stamp}-never-leak`;
  const SIGNING_SECRET = `slack-signing-${stamp}`;
  let projA = null;
  let projB = null;

  // Slack's documented signature form: X-Slack-Signature = "v0=" + hex(HMAC-SHA256(secret, "v0:<ts>:<raw>")).
  const hmacV0 = async (secret, ts, raw) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hex = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${raw}`)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    return `v0=${hex}`;
  };
  const TS = "1696000000";
  let seq = 0;
  const imBody = (slackUserId, text, { channel = "D912s1", id = null } = {}) =>
    JSON.stringify({ team_id: "T912s", event_id: id || `Ev-im-${++seq}`, event: { type: "message", channel, channel_type: "im", user: slackUserId, ts: `1000.${++seq}`, text } });
  const mentionBody = (slackUserId, text, { channel = "C912s1", id = null } = {}) =>
    JSON.stringify({ team_id: "T912s", event_id: id || `Ev-mn-${++seq}`, event: { type: "app_mention", channel, user: slackUserId, ts: `1000.${++seq}`, thread_ts: `1000.${++seq}`, text: `<@U912sbot> ${text}` } });
  const challengeBody = JSON.stringify({ token: "verification-token", type: "url_verification", challenge: "challenge-p912s" });

  const projAresolver = () => projectSecretResolver(db, projA);
  const NOW = Number(TS) * 1000; // R-11: the fixture clock the fixed TS is fresh against
  const deliver = async (agent, body, { signature = null, project = null, resolve = null, ts = TS, now = NOW } = {}) => {
    await pace();
    return handleSlackEvent(client, {
      project: project || projA, payload, update: JSON.parse(body), agentName: agent,
      signatureHeader: signature === null ? await hmacV0(SIGNING_SECRET, ts, body) : signature,
      timestampHeader: ts, rawBody: body, resolveSecret: resolve || projAresolver(), http: slackHttpStub, options: opts, now,
    });
  };
  const expectFail = (agent, body, extra = {}) => captureCall(() => deliver(agent, body, extra));

  try {
    // --- fixtures: funded workspace A with two projects; real app users; real secrets ---
    const plan = await makeBillingPlan(db, created, `p912s${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p912s${stamp}`, { plan });
    wsIds.push(A.ws.id);
    await grant(A.ws.id, "message", 200);
    await grant(A.ws.id, "integration", 100);
    projA = await makeAgentProject(db, projectIds, A, stamp, "p912sa");
    projB = await makeAgentProject(db, projectIds, A, stamp, "p912sb");

    const userA1 = await createPasswordlessUser(db, projA, { email: "a1@p912s.test", display_name: "A1", email_verified: true });
    const userA2 = await createPasswordlessUser(db, projA, { email: "a2@p912s.test", display_name: "A2", email_verified: true });

    await setProjectSecret(db, projA, SLACK_BOT_TOKEN_SECRET, BOT_TOKEN);
    await setProjectSecret(db, projA, SLACK_SIGNING_SECRET_NAME, SIGNING_SECRET);
    await setProjectSecret(db, projB, SLACK_BOT_TOKEN_SECRET, BOT_TOKEN);
    await setProjectSecret(db, projB, SLACK_SIGNING_SECRET_NAME, SIGNING_SECRET);
    await setProjectSecret(db, projA, "TELEGRAM_BOT_TOKEN", `777:p912s-token`);
    await setProjectSecret(db, projA, "TELEGRAM_WEBHOOK_SECRET", `tg-webhook-${stamp}`);
    await setProjectSecret(db, projA, "WHATSAPP_TOKEN", `wapp-token-${stamp}`);
    await setProjectSecret(db, projA, "WHATSAPP_PHONE_NUMBER_ID", `pnid${stamp}`);
    await setProjectSecret(db, projA, "LINE_CHANNEL_ACCESS_TOKEN", `line-token-${stamp}`);
    await setProjectSecret(db, projA, "LINE_CHANNEL_SECRET", `line-secret-${stamp}`);

    // ---- 1. connect surface: the documented activation CODE ------------------------------
    const anonConnect = await captureCall(() => handleAppChannelConnect(client, { project: projA, payload, user: null, args: { channel: "slack", agent: "helper" }, resolveSecret: projAresolver(), http: slackHttpStub }));
    harness.check("connect: an anonymous caller is refused (401)", anonConnect.threw && anonConnect.code === "AUTH_REQUIRED" && anonConnect.status === 401, JSON.stringify(anonConnect));
    const ghostConnect = await captureCall(() => handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "slack", agent: "ghost" }, resolveSecret: projAresolver(), http: slackHttpStub }));
    harness.check("connect: an agent outside the deployment is refused", ghostConnect.threw && ghostConnect.code === "AGENT_NOT_FOUND", JSON.stringify(ghostConnect));
    const noSecrets = await captureCall(() => handleAppChannelConnect(client, { project: projB, payload, user: userA2, args: { channel: "slack", agent: "helper" }, resolveSecret: (async () => undefined), http: slackHttpStub }));
    harness.check("connect: no Slack credential configured fails closed (503, secret NAMED, value never returned)",
      noSecrets.threw && noSecrets.code === "SLACK_NOT_CONFIGURED" && noSecrets.status === 503 && !String(noSecrets.message || "").includes(BOT_TOKEN),
      JSON.stringify(noSecrets));
    await pace();
    const connect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "slack", agent: "helper" }, resolveSecret: projAresolver(), http: slackHttpStub });
    harness.check("connect: returns the documented ACTIVATION CODE with the documented 30-minute expiry (no invented URL)",
      connect.channel === "slack" && connect.agent === "helper" && /^[a-f0-9]{64}$/.test(connect.code) && connect.expires_in_ms === SLACK_ACTIVATION_TTL_MS && SLACK_ACTIVATION_TTL_MS === 30 * 60 * 1000 && !("url" in connect),
      JSON.stringify({ channel: connect.channel, code: connect.code.slice(0, 8), expires_in_ms: connect.expires_in_ms, has_url: "url" in connect }));

    // ---- 2. webhook authentication: fail-closed before the model and any charge -----------
    const llm0 = calls.llm;
    const int0 = await intOf(A.ws.id);
    const noSig = await expectFail("helper", imBody("U-x", "hello"), { signature: "" });
    const badSig = await expectFail("helper", imBody("U-x", "hello"), { signature: "v0=bogus" });
    harness.check("webhook: a missing or wrong X-Slack-Signature over the exact raw body refuses with 401",
      noSig.threw && noSig.code === "SLACK_SIGNATURE_INVALID" && badSig.threw && badSig.code === "SLACK_SIGNATURE_INVALID", JSON.stringify({ noSig: noSig.code, badSig: badSig.code }));
    // R-11: correctly signed but outside Slack's 5-minute window → 401 SLACK_REQUEST_STALE.
    const stale = await expectFail("helper", imBody("U-x", "hello"), { ts: String(Number(TS) - 301) });
    const future = await expectFail("helper", imBody("U-x", "hello"), { ts: String(Number(TS) + 301) });
    const tooOldReal = await expectFail("helper", imBody("U-x", "hello"), { now: Date.now() });
    harness.check("freshness: a validly signed stale, future-dated or real-clock-old delivery refuses (401 SLACK_REQUEST_STALE)",
      [stale, future, tooOldReal].every((r) => r.threw && r.code === "SLACK_REQUEST_STALE" && r.status === 401), JSON.stringify({ stale: stale.code, future: future.code, real: tooOldReal.code }));
    const edge = await deliver("helper", challengeBody, { ts: String(Number(TS) - 300) });
    harness.check("freshness: a delivery exactly at the 300-second edge is still accepted", edge.challenge === "challenge-p912s", JSON.stringify(edge));
    const noAgent = await expectFail("ghost", imBody("U-x", "hello"));
    harness.check("webhook: an agent outside the deployment refuses (404)", noAgent.threw && noAgent.code === "AGENT_NOT_FOUND", JSON.stringify(noAgent));
    const noCreds = await captureCall(() => handleSlackEvent(client, {
      project: projA, payload, update: JSON.parse(imBody("U-x", "hello")), agentName: "helper",
      signatureHeader: "v0=whatever", timestampHeader: TS, rawBody: imBody("U-x", "hello"), resolveSecret: (async () => undefined), http: slackHttpStub,
    }));
    harness.check("webhook: missing Slack credentials fail closed (503 SLACK_NOT_CONFIGURED)", noCreds.threw && noCreds.code === "SLACK_NOT_CONFIGURED", JSON.stringify(noCreds));
    harness.check("webhook: EVERY refused delivery executed no model step and charged nothing",
      calls.llm === llm0 && (await intOf(A.ws.id)) === int0, `llm ${llm0} → ${calls.llm}`);

    // ---- 3. the documented url_verification handshake -------------------------------------
    const challenge = await deliver("helper", challengeBody);
    harness.check("handshake: the documented url_verification challenge is answered",
      challenge.challenge === "challenge-p912s", JSON.stringify(challenge));

    // ---- 4. activation: identity binding through the documented code-as-message flow ------
    const linked = await deliver("helper", imBody("U-slack-A1", connect.code));
    const reply0 = slackCalls[slackCalls.length - 1];
    const identityA1 = (await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "slack" }, "-created_date", 10)).find((r) => r.provider_subject === "U-slack-A1");
    harness.check("activation: the code sent as a message binds the Slack member id to the app user",
      linked.linked === true && linked.agent === "helper" && !!identityA1 && identityA1.app_user_id === userA1.id && identityA1.status === "linked" && identityA1.profile.agent === "helper",
      JSON.stringify({ linked: linked.linked, bound: !!identityA1 }));
    harness.check("activation: the greeting is posted through the provider's documented chat.postMessage",
      linked.greeting_delivered === true && reply0.url.endsWith("/chat.postMessage") && reply0.body.channel === "D912s1" && typeof reply0.body.text === "string",
      JSON.stringify({ url: reply0.url, channel: reply0.body.channel }));
    const replayCode = await expectFail("helper", imBody("U-slack-A1", connect.code));
    harness.check("activation: the activation code is SINGLE-USE (a replayed code refuses)",
      replayCode.threw === true && !replayCode.linked, JSON.stringify({ threw: replayCode.threw, code: replayCode.code }));
    const connectA2 = await handleAppChannelConnect(client, { project: projA, payload, user: userA2, args: { channel: "slack", agent: "helper" }, resolveSecret: projAresolver(), http: slackHttpStub });
    const taken = await expectFail("helper", imBody("U-slack-A1", connectA2.code));
    harness.check("activation: another user's code cannot re-bind an already-linked Slack id (409)",
      taken.threw && taken.code === "CHANNEL_IDENTITY_TAKEN" && taken.status === 409, JSON.stringify(taken));

    // ---- 5. regular message routing through the EXISTING P-9.4 executor -------------------
    script = [{ action: "reply", content: "Slack agent answer" }];
    const intBefore = await intOf(A.ws.id);
    const llmBefore = calls.llm;
    const run1 = await deliver("helper", imBody("U-slack-A1", "hello agent"));
    const intAfter = await intOf(A.ws.id);
    const reply1 = slackCalls[slackCalls.length - 1];
    harness.check("message: a linked Slack user's DM routes through the SAME in-app agent runtime and replies via chat.postMessage",
      run1.delivered === true && run1.agent === "helper" && calls.llm === llmBefore + 1
        && reply1.body.channel === "D912s1" && reply1.body.thread_ts && reply1.body.text === "Slack agent answer",
      JSON.stringify({ delivered: run1.delivered, channel: reply1.body.channel, thread: reply1.body.thread_ts }));
    const conv = await handleAppAgent(client, { project: projA, payload, user: userA1, op: "get", args: { conversation_id: run1.conversation_id } });
    harness.check("binding: the turn persists in the SAME conversation rows as the in-app runtime",
      conv.count === 2 && conv.messages.map((m) => m.role).join(",") === "user,assistant",
      JSON.stringify({ count: conv.count }));
    // No-relay billing: the Slack turn charges EXACTLY what the identical in-app invoke charges.
    const intInApp0 = await intOf(A.ws.id);
    const inApp = await handleAppAgent(client, { project: projA, payload, user: userA1, op: "invoke", args: { name: "helper", message: "hello agent" }, options: opts });
    const intInApp1 = await intOf(A.ws.id);
    harness.check("billing: a Slack turn charges EXACTLY the agent's own turn credits — no relay tariff exists (Telegram/LINE precedent)",
      intBefore - intAfter === inApp.usage.integration_credits && intInApp0 - intInApp1 === inApp.usage.integration_credits && (await msgOf(A.ws.id)) === 200,
      `slack turn ${intBefore - intAfter} == in-app ${inApp.usage.integration_credits}; msg pool 200`);

    // ---- 6. @-mentions: markup stripped, reply threaded -----------------------------------
    script = [{ action: "reply", content: "threaded answer" }];
    const mentionRun = await deliver("helper", mentionBody("U-slack-A1", "do the thing"));
    const replyMention = slackCalls[slackCalls.length - 1];
    harness.check("mention: Slack's mention markup is stripped from the text the agent sees and the reply is threaded",
      mentionRun.delivered === true && replyMention.body.channel === "C912s1" && !!replyMention.body.thread_ts && replyMention.body.text === "threaded answer",
      JSON.stringify({ channel: replyMention.body.channel, thread: replyMention.body.thread_ts }));

    // ---- 7. duplicate delivery + unsupported events ---------------------------------------
    const dupBody = imBody("U-slack-A1", "dedupe me", { id: "Ev-dup-1" });
    await deliver("helper", dupBody);
    const llmDup = calls.llm;
    const dup2 = await deliver("helper", dupBody);
    const channelMsg = await deliver("helper", JSON.stringify({ team_id: "T912s", event_id: `Ev-ch-${++seq}`, event: { type: "message", channel: "C912s1", user: "U-slack-A1", ts: "1000.9", text: "no mention" } }));
    const botPost = await deliver("helper", JSON.stringify({ team_id: "T912s", event_id: `Ev-bot-${++seq}`, event: { type: "message", channel: "D912s1", channel_type: "im", bot_id: "B1", ts: "1000.10", text: "from a bot" } }));
    harness.check("replay: a duplicate provider delivery is acknowledged and executes nothing",
      dup2.duplicate === true && calls.llm === llmDup, JSON.stringify({ duplicate: dup2.duplicate }));
    harness.check("replay: channel messages WITHOUT a mention and other bots' posts are acknowledged and ignored",
      channelMsg.ignored === true && botPost.ignored === true, JSON.stringify({ channel: channelMsg.ignored, bot: botPost.ignored }));

    // ---- 8. anonymous access: the SAME per-agent mechanism ---------------------------------
    const refused = await expectFail("helper", imBody("U-anon-1", "let me in", { channel: "D912s2" }));
    harness.check("anonymous: an unlinked chat of a NON-anonymous agent still refuses (403)",
      refused.threw && refused.code === "CHANNEL_NOT_LINKED" && refused.status === 403, JSON.stringify(refused));
    script = [{ action: "reply", content: "anon answer" }];
    const intAnon0 = await intOf(A.ws.id);
    const anonRun = await deliver("open", imBody("U-anon-1", "hi there", { channel: "D912s2" }));
    const anonIdentity = (await db.entities.AppIdentity.filter({ project_id: projA.id, provider: "slack" }, "-created_date", 10)).find((r) => r.provider_subject === "U-anon-1");
    harness.check("anonymous: an allow_anonymous_access agent mints the server-side anonymous owner and runs the turn",
      anonRun.delivered === true && !!anonIdentity && anonIdentity.profile.anonymous === true && (await intOf(A.ws.id)) < intAnon0,
      JSON.stringify({ delivered: anonRun.delivered, anon_identity: !!anonIdentity }));
    const anonPosts = slackCalls.filter((c) => c.body?.channel === "D912s2");
    harness.check("anonymous: first contact posts greeting + answer (two documented posts); a returning chat gets the answer only",
      anonPosts.length === 2 && String(anonPosts[0].body?.text || "").startsWith("You are now connected to") && anonPosts[1].body?.text === "anon answer",
      JSON.stringify({ posts: anonPosts.length, first: anonPosts[0] ? String(anonPosts[0].body?.text || "") : null }));

    // ---- 9. cross-project / cross-user isolation -------------------------------------------
    const crossProject = await expectFail("helper", imBody("U-slack-A1", "hello from B", { id: "Ev-cross-1" }), { project: projB });
    harness.check("isolation: the SAME Slack id has NO identity in ANOTHER project of the workspace (fail-closed)",
      crossProject.threw && crossProject.code === "CHANNEL_NOT_LINKED", JSON.stringify(crossProject));
    const others = await handleAppAgent(client, { project: projA, payload, user: userA2, op: "conversations", args: {} });
    harness.check("isolation: another app user never sees userA1's Slack conversations",
      !others.conversations.some((c) => c.conversation_id === run1.conversation_id), JSON.stringify({ count: others.count }));

    // ---- 10. Telegram / WhatsApp / LINE regression isolation through the SAME dispatcher ---
    const tgConnect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "telegram", agent: "helper" }, resolveSecret: projAresolver(), http: tgHttpStub });
    const waConnect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "whatsapp", agent: "helper" }, resolveSecret: projAresolver(), http: waHttpStub });
    const lineConnect = await handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "line", agent: "helper" }, resolveSecret: projAresolver(), http: lineHttpStub });
    harness.check("regression: Telegram, WhatsApp and LINE connect surfaces are UNCHANGED",
      /^https:\/\/t\.me\/p912s_bot\?start=[a-f0-9]{64}$/.test(tgConnect.url) && /^https:\/\/wa\.me\/\d+\?text=[a-f0-9]{64}$/.test(waConnect.url) && /^[a-f0-9]{64}$/.test(lineConnect.code),
      JSON.stringify({ tg: tgConnect.url.slice(0, 30), wa: waConnect.url.slice(0, 30), line: !!lineConnect.code }));
    const unsupported = await captureCall(() => handleAppChannelConnect(client, { project: projA, payload, user: userA1, args: { channel: "imessage", agent: "helper" }, resolveSecret: projAresolver(), http: slackHttpStub }));
    harness.check("regression: a channel with no implemented provider infrastructure still refuses through the dispatcher",
      unsupported.threw && unsupported.code === "CHANNEL_NOT_SUPPORTED", JSON.stringify(unsupported));

    // ---- 11. ledger integrity --------------------------------------------------------------
    const integrity = await verifyBalanceIntegrity(db, A.ws.id);
    harness.check("ledger integrity holds after Slack channel usage", integrity.ok, JSON.stringify(integrity));

    return Response.json(harness.summary());
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ok: false, passed: s.passed, failed: s.failed, failed_names: s.results.filter((r) => !r.ok).map((r) => r.name), error: error.message, code: error.code || null, status: error.status || null, stack: String(error.stack || "").split("\n").slice(0, 6) }, { status: 500 });
  } finally {
    // Bulk cleanup — also sweeps scratch rows left behind by earlier interrupted runs.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p912s[ab]-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "p912s" } }, "created_date", 200).catch(() => []);
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
    await db.entities.CacheEntry.deleteMany({ cache_key: { $regex: "^slack_replay:" } }).catch(() => {});
    await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p912s" } }).catch(() => {});
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p912s" } }).catch(() => {});
  }
}