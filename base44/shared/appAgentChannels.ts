// P-9.10A — Telegram channel foundation for deployed in-app agents.
//
// The narrowest possible addition on top of the EXISTING contracts — no second agent executor,
// no second billing path, no new credential store:
//   • connect URL  — issued for the CURRENT authenticated app user only; a single-use
//                    AppAuthToken (kind "channel_activation", hash-at-rest, short TTL) whose
//                    raw value is the Telegram deep-link start code. It is not a credential:
//                    it is consumed exactly once and grants only this chat↔user binding.
//   • webhook      — authenticated ONLY by the x-telegram-bot-api-secret-token header,
//                    verified against the project's own TELEGRAM_WEBHOOK_SECRET ProjectSecret
//                    (the secret Telegram sends once configured via setWebhook). A request
//                    without a matching secret never reaches the agent executor and never
//                    charges the workspace anything.
//   • identity     — provider "telegram", provider_subject = chat id, on the EXISTING AppIdentity
//                    contract (#29/P-9.8). The acting user is ALWAYS resolved server-side
//                    through the identity row; nothing in the Telegram payload is trusted.
//   • execution    — the EXISTING P-9.4 handler (handleAppAgent): model access, message
//                    credits and tool authorization are enforced inside it exactly as in-app.
//   • credentials  — TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET are ordinary ProjectSecrets,
//                    decrypted only here at the moment of use and never returned, logged or
//                    written into an audit row.
// No billing rate is invented for TELEGRAM channel delivery (UNKNOWN per the P-9.10 audit):
// the only charges are the agent's own message credits (P-9.4) and tool charges inside the
// P-9.2 handlers. (The P-9.10C WhatsApp section below charges the relay rate Base44 DOES
// publish — see its own header.) No loop-guard state is required: the bot's own outgoing
// messages are never
// delivered back as updates, and the per-turn cost is bounded by the P-9.4 step ceiling, the
// inbound message cap and the durable rate limits below.
import { fail, limit, issueToken, consumeToken, getAppUser, publicUser, recordAuthEvent, nowIso, createAnonymousUser, isAnonymousUser } from "./appAuth.ts";
import { findIdentity } from "./appOAuth.ts";
import { handleAppAgent, APP_AGENT_LIMITS } from "./appAgentRuntime.ts";
import { deliverTelegramReplyOnce, deliverReplyOnce, runTurnReleasingReplay } from "./telegramDelivery.ts";
import { TELEGRAM_GREETING_MAX_CHARS, WHATSAPP_GREETING_MAX_CHARS } from "./agentResource.ts";
import { holdIntegrationCredits, chargeWorkspace } from "./integrationCharges.ts";
import { scrub, scrubText } from "./tracing.ts";
import { connectBrowserExtension } from "./agentBrowserBridge.ts";
import { whatsappCreateGroup, handleWhatsAppGroupLifecycle } from "./whatsappGroups.ts";
export { whatsappCreateGroup, handleWhatsAppGroupLifecycle };
export { WHATSAPP_GROUP_SUBJECT_MAX_CHARS, WHATSAPP_GROUP_DESCRIPTION_MAX_CHARS, WHATSAPP_GROUP_PENDING_TTL_MS } from "./whatsappGroups.ts";

export const CHANNEL_CONTRACT_VERSION = "nexusai-agent-channel-1";
export const TELEGRAM_BOT_TOKEN_SECRET = "TELEGRAM_BOT_TOKEN";
export const TELEGRAM_WEBHOOK_SECRET_NAME = "TELEGRAM_WEBHOOK_SECRET";
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const CHANNEL_ACTIVATION_TTL_MS = 10 * 60 * 1000;
export const TELEGRAM_OUTBOUND_MAX_CHARS = 4096; // Telegram's own hard message cap
const ACTIVATION_CODE_RE = /^[a-f0-9]{64}$/;
// P-9.11C: an unlinked chat of an agent with allow_anonymous_access=true gets a server-side
// ANONYMOUS owner. The claim TTL only guards the mint race — it is not a session.
export const ANON_CHANNEL_CLAIM_TTL_MS = 60 * 1000;

// P-9.11C: resolves-or-mints the anonymous identity of one (project, provider, chat). Exactly
// one delivery wins the durable claim (the WhatsApp replay pattern), so a racing duplicate
// re-reads the winner's row instead of minting a second owner. Everything is server-derived;
// nothing about the visitor is trusted from the payload. Base44's persistence semantics for
// anonymous visitors are UNKNOWN — nothing beyond this stable identity is invented.
// R-2e: a failed claim read aborts with a retryable 503 — never "no prior claim" or "won".
async function readAnonClaims(svc, cacheKey) {
  try {
    return await svc.entities.CacheEntry.filter({ cache_key: cacheKey }, "created_date", 5);
  } catch {
    fail(503, "CHANNEL_LINK_UNAVAILABLE", "This chat could not be connected right now; please try again shortly.");
  }
}

export async function ensureAnonymousChannelIdentity(svc, { project, provider, subject, agent, meta = {} }) {
  await limit(svc, project, "app_anonymous_session", `chat:${provider}:${subject}`);
  const found = await findIdentity(svc, project, provider, subject);
  if (found) return { identity: found, created: false };
  const cacheKey = `anon_channel:${project.id}:${provider}:${subject}`;
  const now = Date.now();
  const prior = await readAnonClaims(svc, cacheKey);
  const mine = await svc.entities.CacheEntry.create({
    namespace: "anon_channel", cache_key: cacheKey, value: { claimed: true },
    expires_at: new Date(now + ANON_CHANNEL_CLAIM_TTL_MS).toISOString(), stale_at: new Date(now + ANON_CHANNEL_CLAIM_TTL_MS).toISOString(),
    size_bytes: 64, version: 1,
  });
  const all = (await readAnonClaims(svc, cacheKey)).filter((r) => new Date(r.expires_at).getTime() > now);
  const won = (all[0]?.id || mine.id) === mine.id && !prior.some((r) => new Date(r.expires_at).getTime() > now);
  if (!won) {
    const raced = await findIdentity(svc, project, provider, subject);
    if (raced) return { identity: raced, created: false };
    fail(503, "CHANNEL_LINK_PENDING", "This chat is being connected; please try again shortly.");
  }
  const raced = await findIdentity(svc, project, provider, subject);
  if (raced) return { identity: raced, created: false };
  const user = await createAnonymousUser(svc, project, meta);
  const identity = await svc.entities.AppIdentity.create({
    project_id: project.id, app_user_id: user.id, provider, provider_subject: subject,
    profile: scrub({ agent: agent.name, anonymous: true }), status: "linked", linked_at: nowIso(), last_login_at: nowIso(),
  });
  await recordAuthEvent(svc, project, {
    action: "channel_anonymous_linked", resource: "AppIdentity", resource_id: identity.id,
    metadata: { channel: provider, agent: agent.name, app_user_id: user.id }, meta,
  });
  return { identity, created: true };
}

// Length-independent comparison: a byte-by-byte early return would leak how much of a guessed
// secret was correct. (Same pattern as webhookSecurity, kept private here.)
function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The default Telegram transport. Injectable so certification can script the provider. */
export async function telegramHttp(url, init) {
  return fetch(url, init);
}

// One Telegram Bot API call. The bot token travels only in the URL of this server-side call;
// any error message is scrubbed of it before it can reach a log or a response.
async function telegramCall(http, botToken, method, body) {
  let res;
  try {
    res = await http(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).split(botToken).join("[redacted]") };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data?.ok) {
    const raw = String(data?.description || res.statusText || "Telegram API error");
    return { ok: false, error: scrubText(raw, 200).split(botToken).join("[redacted]") };
  }
  return { ok: true, result: data.result };
}

// Fail closed: no credential → no channel. The refusal names the SECRET, never a value.
async function requireSecret(resolveSecret, name) {
  const value = resolveSecret ? await resolveSecret(name) : undefined;
  if (!value) fail(503, "TELEGRAM_NOT_CONFIGURED", `This application has no ${name} configured, so the Telegram channel is unavailable.`);
  return String(value);
}

// --- connect URL ---------------------------------------------------------------------------

/**
 * Issues the agent's Telegram connect deep link for the CURRENT signed-in app user.
 * The activation code is a fresh single-use AppAuthToken: hashed at rest, short-lived, bound
 * server-side to (project, agent, app user). Its raw value appears exactly once — in the
 * returned URL — and in no log, audit row or later response.
 */
export async function connectTelegram(svc, { project, payload, user, agentName, resolveSecret, http = telegramHttp, meta = {} }) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);
  await limit(svc, project, "channel_activation", `user:${user.id}`);
  const botToken = await requireSecret(resolveSecret, TELEGRAM_BOT_TOKEN_SECRET);
  const me = await telegramCall(http, botToken, "getMe", {});
  if (!me.ok) fail(502, "TELEGRAM_UNAVAILABLE", `The Telegram bot is unreachable: ${me.error}`);
  const username = String(me.result?.username || "");
  if (!username) fail(502, "TELEGRAM_UNAVAILABLE", "The Telegram bot has no public username");
  const { token, row } = await issueToken(svc, project, {
    user, kind: "channel_activation", ttl_ms: CHANNEL_ACTIVATION_TTL_MS,
    data: { channel: "telegram", agent: agent.name },
  });
  await recordAuthEvent(svc, project, {
    action: "channel_activation_requested", resource: "AppAuthToken", resource_id: row.id,
    metadata: { channel: "telegram", agent: agent.name, app_user_id: user.id, expires_in_ms: CHANNEL_ACTIVATION_TTL_MS }, meta,
  });
  return { channel: "telegram", agent: agent.name, url: `https://t.me/${username}?start=${token}`, expires_in_ms: CHANNEL_ACTIVATION_TTL_MS };
}

/** Runtime dispatcher: the sandbox names at most a channel id; the certified Telegram
 *  (P-9.10A) and WhatsApp (P-9.10C) foundations dispatch from here. */
export async function handleAppChannelConnect(client, { project, payload, user, args = {}, resolveSecret, http = null, meta = {} }) {
  const channel = String(args.channel || "");
  const svc = client.asServiceRole || client;
  if (channel === "telegram") {
    return connectTelegram(svc, { project, payload, user, agentName: args.agent, resolveSecret, http: http || telegramHttp, meta });
  }
  if (channel === "whatsapp") {
    // P-9.13G: group management rides the SAME dispatcher — op "group_create" (the documented
    // in-app-agent group tool). The default op stays the certified connect, byte-identical.
    if (args.op === "group_create") {
      return whatsappCreateGroup(svc, { project, payload, user, agentName: args.agent, resolveSecret, http: http || whatsappHttp, subject: args.subject, description: args.description, meta });
    }
    return connectWhatsApp(svc, { project, payload, user, agentName: args.agent, resolveSecret, http: http || whatsappHttp, meta });
  }
  if (channel === "browser_extension") {
    return connectBrowserExtension(svc, { project, payload, user, agentName: args.agent, meta });
  }
  if (channel === "line") {
    return connectLINE(svc, { project, payload, user, agentName: args.agent, resolveSecret, http: http || lineHttp, meta });
  }
  if (channel === "slack") {
    return connectSlack(svc, { project, payload, user, agentName: args.agent, resolveSecret, http: http || slackHttp, meta });
  }
  fail(400, "CHANNEL_NOT_SUPPORTED", `Channel "${channel}" is not supported`);
}

// --- webhook -------------------------------------------------------------------------------

/**
 * Handles ONE verified Telegram update for one agent of one project.
 *
 * Order of checks (each fails closed BEFORE the agent executor and any charge):
 *   agent declared → credentials present → secret-token signature → flood limit →
 *   activation/message parsing → identity-resolved owner.
 * Unsupported updates (edits, channel posts, non-text) are acknowledged and ignored.
 */
export async function handleTelegramUpdate(client, {
  project, payload, update, agentName, secretTokenHeader, resolveSecret, http = telegramHttp, options = {}, meta = {},
}) {
  const svc = client.asServiceRole || client;
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);

  const botToken = await requireSecret(resolveSecret, TELEGRAM_BOT_TOKEN_SECRET);
  const webhookSecret = await requireSecret(resolveSecret, TELEGRAM_WEBHOOK_SECRET_NAME);

  // 1. Signature — the ONLY thing that authenticates this session-less request. Missing and
  //    wrong are the same refusal, so the check reveals nothing about which failed. Verified
  //    BEFORE the rate limiter so garbage traffic cannot drain the project's webhook budget.
  if (!constantTimeEqual(String(secretTokenHeader || ""), webhookSecret)) {
    fail(401, "TELEGRAM_SIGNATURE_INVALID", "This webhook delivery is not authentic");
  }

  // 2. Flood control — durable, per project, counted only for authenticated deliveries.
  await limit(svc, project, "channel_webhook", "endpoint");

  // 2a. update_id (R-2c) — Telegram's Bot API defines it as a required positive integer on every
  //     Update. Anything else is malformed and refused before any parsing, claim, agent or charge.
  const rawUpdateId = update?.update_id;
  if (!Number.isSafeInteger(rawUpdateId) || rawUpdateId <= 0) {
    fail(400, "TELEGRAM_UPDATE_INVALID", "This Telegram update has no valid update_id");
  }

  const message = update?.message || null;
  const chatId = message?.chat?.id != null ? String(message.chat.id) : "";
  const text = String(message?.text || "");
  if (!chatId || !text) return { ok: true, ignored: true }; // non-message / non-text update: acknowledge, never retry

  // 2b. Duplicate delivery (R-2c) — durable single-use claim on Telegram's update_id, BEFORE any
  //     activation, agent execution or charge. A failed claim read is retryable (503), never
  //     "unseen" or "won". UNKNOWN: atomicity depends on database read consistency.
  let claimed;
  try {
    claimed = await claimDeliveryOnce(svc, `tg_replay:${project.id}:${rawUpdateId}`, Date.now(), { namespace: "telegram_replay" });
  } catch {
    fail(503, "DELIVERY_CLAIM_UNAVAILABLE", "Delivery could not be verified; retry later.");
  }
  if (!claimed) return { ok: true, duplicate: true };

  // 3. Activation — the /start deep link carrying the single-use code.
  const start = text.match(/^\/start\s+([a-f0-9]{64})$/);
  if (start) {
    const used = await consumeToken(svc, project, { token: start[1], kind: "channel_activation" });
    if (String(used.data?.channel || "") !== "telegram") fail(400, "CHANNEL_STATE_MISMATCH", "This activation does not belong to the Telegram channel");
    if (String(used.data?.agent || "") !== agent.name) fail(409, "CHANNEL_AGENT_MISMATCH", "This activation was issued for a different agent");
    const linkedUser = await getAppUser(svc, project, used.app_user_id);
    if (!linkedUser || linkedUser.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");
    const existing = await findIdentity(svc, project, "telegram", chatId);
    if (existing && existing.app_user_id !== linkedUser.id) fail(409, "CHANNEL_IDENTITY_TAKEN", "This Telegram chat is already linked to another user");
    const profile = scrub({ agent: agent.name });
    const identity = existing
      ? await svc.entities.AppIdentity.update(existing.id, { last_login_at: nowIso(), profile })
      : await svc.entities.AppIdentity.create({
          project_id: project.id, app_user_id: linkedUser.id, provider: "telegram", provider_subject: chatId,
          profile, status: "linked", linked_at: nowIso(), last_login_at: nowIso(),
        });
    const greeting = scrubText(
      String(agent.telegram_greeting || agent.metadata?.telegram_greeting || `You are now connected to ${agent.display_name || agent.name}.`),
      TELEGRAM_GREETING_MAX_CHARS,
    );
    const sent = await telegramCall(http, botToken, "sendMessage", { chat_id: chatId, text: greeting });
    await recordAuthEvent(svc, project, {
      action: "channel_linked", resource: "AppIdentity", resource_id: identity.id,
      metadata: { channel: "telegram", agent: agent.name, app_user_id: linkedUser.id, greeting_delivered: sent.ok }, meta,
    });
    return { ok: true, linked: true, agent: agent.name, greeting_delivered: !!sent.ok };
  }

  // 4. Regular message — the owner is resolved from the identity row, never from the payload.
  //    P-9.11C: an UNLINKED chat of an agent that allows anonymous access gets a server-minted
  //    anonymous owner instead of the certified refusal; every other agent is unchanged.
  if (!text.trim()) return { ok: true, ignored: true };
  if (text.length > APP_AGENT_LIMITS.MAX_MESSAGE_CHARS) {
    fail(413, "AGENT_MESSAGE_TOO_LONG", `Message exceeds ${APP_AGENT_LIMITS.MAX_MESSAGE_CHARS} characters`);
  }
  let identity = await findIdentity(svc, project, "telegram", chatId);
  let firstContact = false;
  if (!identity) {
    if (agent.allow_anonymous_access !== true) fail(403, "CHANNEL_NOT_LINKED", "This Telegram chat is not linked to an account yet");
    const ensured = await ensureAnonymousChannelIdentity(svc, { project, provider: "telegram", subject: chatId, agent, meta });
    identity = ensured.identity;
    firstContact = ensured.created;
  }
  if (String(identity.profile?.agent || "") && identity.profile.agent !== agent.name) {
    fail(409, "CHANNEL_AGENT_MISMATCH", "This Telegram chat is linked to a different agent");
  }
  const owner = await getAppUser(svc, project, identity.app_user_id);
  if (!owner || owner.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");
  if (firstContact) {
    const greeting = scrubText(
      String(agent.telegram_greeting || `You are now connected to ${agent.display_name || agent.name}.`),
      TELEGRAM_GREETING_MAX_CHARS,
    );
    const sent = await telegramCall(http, botToken, "sendMessage", { chat_id: chatId, text: greeting });
    await recordAuthEvent(svc, project, {
      action: "channel_anonymous_greeting", resource: "AppIdentity", resource_id: identity.id,
      metadata: { channel: "telegram", agent: agent.name, greeting_delivered: !!sent.ok }, meta,
    });
  }

  // 5. The EXISTING P-9.4 executor — model access, message credits and tool authorization are
  //    enforced inside it; this module adds no second billing path. An anonymous owner travels
  //    through the `anonymous` param, so the per-agent gate is enforced inside and tools run
  //    with NO user context (per-user private data stays fail-closed).
  const anonChat = isAnonymousUser(owner);
  const turnReplayKey = `tg_replay:${project.id}:${rawUpdateId}`;
  const run = await runTurnReleasingReplay(svc, turnReplayKey, () => handleAppAgent(client, {
    project, payload, user: anonChat ? null : publicUser(owner), anonymous: anonChat ? { user: publicUser(owner) } : null, op: "invoke",
    args: { name: agent.name, message: text, idempotency_key: `telegram:${rawUpdateId}` }, options,
  }));
  // The saved reply (fresh or keyed replay) is sent at most once per successful delivery; a failed
  // send stays retryable by a later delivery of the same update (telegramDelivery.ts).
  const reply = scrubText(String(run.reply || ""), TELEGRAM_OUTBOUND_MAX_CHARS);
  const sent = await deliverTelegramReplyOnce(svc, {
    projectId: project.id, updateId: rawUpdateId, claim: claimDeliveryOnce,
    send: () => telegramCall(http, botToken, "sendMessage", { chat_id: chatId, text: reply }),
  });
  const replay = run.idempotent_replay ? { duplicate: true, replayed: true } : {};
  if (sent.already_sent) return { ok: true, ...replay, conversation_id: run.conversation_id, agent: agent.name, delivered: false, delivery_error: null };
  return {
    ok: true, ...replay, conversation_id: run.conversation_id, agent: agent.name,
    delivered: !!sent.ok, delivery_error: sent.ok ? null : sent.error,
  };
}

// =============================================================================================
// P-9.10C — WhatsApp channel foundation, mirroring the certified P-9.10A Telegram contracts.
//
// Differences from Telegram are evidence-driven (see the P-9.10C audit), never assumptions:
//   • transport — the WhatsApp Business Cloud API (graph.facebook.com: fixed host, bearer
//     token, phone-number id). No client-configurable endpoint exists, so there is no SSRF
//     surface, and credential values are redacted from every error before it can be logged.
//   • webhook  — GET subscription handshake (hub.mode / hub.verify_token / hub.challenge) and
//     POST X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, EXACT raw body), compared
//     in constant time. These are the PROVIDER's documented contracts; Base44's own relay
//     internals are not published (UNKNOWN) — everything here stays fail-closed.
//   • binding  — the SAME single-use AppAuthToken (kind "channel_activation") and AppIdentity
//     (provider "whatsapp", subject = the sender's WhatsApp id) contracts as P-9.10A.
//   • billing  — the rate Base44 publishes for in-app agents: 1 integration credit per
//     message RECEIVED and 1 per message SENT for the WhatsApp relay, through the canonical
//     P-9.2 hold/settle path (hold before the provider operation, settle by actual delivery,
//     fail-closed on insufficient credits). The agent's own per-message charge (P-9.11E: one
//     integration-pool turn operation, unchanged here) stays separate from the relay; no
//     equivalent Telegram rate exists (P-9.10A stays free of one).
//   • capacity — the documented workspace limit: at most 3 in-app agents connected to
//     WhatsApp across ALL the workspace's apps, enforced at connect issuance AND at binding.
// Duplicate provider deliveries are claimed durably by the provider message id (the ledger's
// exactly-once keys back this up); status/edits/non-text updates are acknowledged and
// ignored; and no retry semantics beyond the provider's own redelivery are invented.
export const WHATSAPP_TOKEN_SECRET = "WHATSAPP_TOKEN";
export const WHATSAPP_PHONE_NUMBER_ID_SECRET = "WHATSAPP_PHONE_NUMBER_ID";
export const WHATSAPP_VERIFY_TOKEN_SECRET = "WHATSAPP_VERIFY_TOKEN";
export const WHATSAPP_APP_SECRET_NAME = "WHATSAPP_APP_SECRET";
export const WHATSAPP_SIGNATURE_HEADER_NAME = "x-hub-signature-256";
// Base44-documented (docs.base44.com, in-app agents): "Each message sent or received uses 1
// integration credit for the WhatsApp relay"; "A total of 3 in-app agents can be connected to
// WhatsApp across all your apps".
export const WHATSAPP_RELAY_CREDITS = 1;
import { WHATSAPP_MAX_CONNECTED_AGENTS, assertWhatsAppAgentCapacity } from "./whatsappCapacity.ts";
export { WHATSAPP_MAX_CONNECTED_AGENTS };
export const WHATSAPP_OUTBOUND_MAX_CHARS = 4096; // the provider's own hard text-message cap
export const WHATSAPP_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
export const GRAPH_API_VERSION = "v21.0";

/** The default WhatsApp transport. Injectable so certification can script the provider. */
export async function whatsappHttp(url, init) {
  return fetch(url, init);
}

// Fail closed: no credential → no channel. The refusal names the SECRET, never a value.
export async function requireWhatsAppSecret(resolveSecret, name) {
  const value = resolveSecret ? await resolveSecret(name) : undefined;
  if (!value) fail(503, "WHATSAPP_NOT_CONFIGURED", `This application has no ${name} configured, so the WhatsApp channel is unavailable.`);
  return String(value);
}

// HMAC-SHA256 hex of the app secret over the EXACT raw body — the provider's signature form.
async function hmacSha256Hex(secret, raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(raw ?? ""))))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// One WhatsApp Cloud API GET. The token travels only in the server-side Authorization
// header; any error is scrubbed of it before it can reach a log or a response.
async function whatsappGraphGet(http, token, path) {
  let res;
  try {
    res = await http(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).split(token).join("[redacted]") };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) return { ok: false, error: scrubText(String(data?.error?.message || res.statusText || "WhatsApp API error"), 200).split(token).join("[redacted]") };
  return { ok: true, result: data };
}

async function whatsappSendMessage(http, token, phoneNumberId, to, text, recipientType = "individual") {
  let res;
  try {
    res = await http(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: recipientType, to, type: "text", text: { body: text } }),
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e).split(token).join("[redacted]") };
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !Array.isArray(data?.messages) || !data.messages.length) {
    return { ok: false, error: scrubText(String(data?.error?.message || res.statusText || "WhatsApp API error"), 200).split(token).join("[redacted]") };
  }
  return { ok: true, result: data };
}

// Durable single-use claim on a provider message id (the webhookSecurity replay pattern): the
// earliest row wins, a racing loser is a duplicate — a redelivered message can neither execute
// the agent nor charge anything twice. Fail closed: a failed read throws, so the webhook answers
// 5xx and the provider retries — it is never treated as "not seen" or as a won claim. Only live
// (unexpired) rows compete, so an expired claim cannot block a new one.
// UNKNOWN: atomicity still depends on the database's read consistency (no unique constraint).
export async function claimDeliveryOnce(svc, cacheKey, now = Date.now(), { namespace = "whatsapp_replay", ttlMs = WHATSAPP_REPLAY_TTL_MS } = {}) {
  const live = (rows) => rows.filter((r) => new Date(r.expires_at).getTime() > now);
  const existing = await svc.entities.CacheEntry.filter({ cache_key: cacheKey }, "created_date", 5);
  if (live(existing).length) return false;
  const mine = await svc.entities.CacheEntry.create({
    namespace, cache_key: cacheKey,
    value: { claimed_at: new Date(now).toISOString() },
    expires_at: new Date(now + ttlMs).toISOString(), stale_at: new Date(now + ttlMs).toISOString(),
    size_bytes: 64, version: 1,
  });
  const all = live(await svc.entities.CacheEntry.filter({ cache_key: cacheKey }, "created_date", 5));
  return (all[0]?.id || mine.id) === mine.id;
}

// R-2d: a provider message id is a non-empty, bounded string with no surrounding whitespace.
export function isProviderMessageId(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 512 && v.trim() === v;
}


// One outbound WhatsApp message through the canonical P-9.2 relay charge: hold 1 integration
// credit BEFORE the provider send, settle by actual delivery (a failed send charges nothing).
// R-2 (Pipeline A): `chargeKey` derives from the inbound provider message id + purpose, so a
// duplicate processing of the SAME inbound message settles the SAME ledger entries (charged
// once). Sends with no inbound message (proactive) keep a fresh key.
export async function sendWithRelayCharge(svc, { workspace_id, project, http, token, phoneNumberId, to, text, recipientType = "individual", chargeKey = null }) {
  const hold = workspace_id ? await holdIntegrationCredits(svc, {
    workspace_id, project_id: project.id, credits: WHATSAPP_RELAY_CREDITS,
    key: chargeKey ? `whatsapp:out:${chargeKey}` : `whatsapp:out:${crypto.randomUUID()}`,
    reason: `WhatsApp relay · outbound · ${WHATSAPP_RELAY_CREDITS} credit per sent message`,
  }) : null;
  const sent = await whatsappSendMessage(http, token, phoneNumberId, to, text, recipientType);
  await hold?.settle(sent.ok ? WHATSAPP_RELAY_CREDITS : 0, "WhatsApp relay · outbound", { direction: "outbound", delivered: !!sent.ok });
  return sent;
}

// --- connect URL ---------------------------------------------------------------------------

/**
 * Issues the agent's WhatsApp connect link for the CURRENT signed-in app user: the documented
 * wa.me flow with the single-use activation code as the prefilled message text. The code is a
 * fresh AppAuthToken (hashed at rest, short TTL, bound server-side to project + agent + app
 * user); its raw value appears exactly once — in the returned URL — and nowhere else.
 */
export async function connectWhatsApp(svc, { project, payload, user, agentName, resolveSecret, http = whatsappHttp, meta = {} }) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);
  await limit(svc, project, "channel_activation", `user:${user.id}`);
  await assertWhatsAppAgentCapacity(svc, project, agent.name, { reserve: false });
  const waToken = await requireWhatsAppSecret(resolveSecret, WHATSAPP_TOKEN_SECRET);
  const phoneNumberId = await requireWhatsAppSecret(resolveSecret, WHATSAPP_PHONE_NUMBER_ID_SECRET);
  // The provider call both validates the credentials and resolves the number the wa.me link
  // must point at (mirror of the Telegram getMe step).
  const me = await whatsappGraphGet(http, waToken, `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number`);
  if (!me.ok) fail(502, "WHATSAPP_UNAVAILABLE", `The WhatsApp business number is unreachable: ${me.error}`);
  const number = String(me.result?.display_phone_number || "").replace(/[^\d]/g, "");
  if (!number) fail(502, "WHATSAPP_UNAVAILABLE", "The WhatsApp business number has no public phone number");
  const { token, row } = await issueToken(svc, project, {
    user, kind: "channel_activation", ttl_ms: CHANNEL_ACTIVATION_TTL_MS,
    data: { channel: "whatsapp", agent: agent.name },
  });
  await recordAuthEvent(svc, project, {
    action: "channel_activation_requested", resource: "AppAuthToken", resource_id: row.id,
    metadata: { channel: "whatsapp", agent: agent.name, app_user_id: user.id, expires_in_ms: CHANNEL_ACTIVATION_TTL_MS }, meta,
  });
  return { channel: "whatsapp", agent: agent.name, url: `https://wa.me/${number}?text=${token}`, expires_in_ms: CHANNEL_ACTIVATION_TTL_MS };
}

// --- webhook verification (GET) -------------------------------------------------------------

/**
 * The provider's subscription verification handshake. The challenge is echoed ONLY on a
 * matching hub.verify_token (constant-time); a malformed request never reaches the echo.
 */
export async function handleWhatsAppVerification(client, { project, payload, agentName, query, resolveSecret, meta = {} }) {
  const svc = client.asServiceRole || client;
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);
  const verifyToken = await requireWhatsAppSecret(resolveSecret, WHATSAPP_VERIFY_TOKEN_SECRET);
  const mode = String(query?.get?.("hub.mode") || "");
  const provided = String(query?.get?.("hub.verify_token") || "");
  const challenge = String(query?.get?.("hub.challenge") || "");
  if (mode !== "subscribe" || !challenge) fail(400, "WHATSAPP_VERIFICATION_INVALID", "This webhook verification request is malformed");
  // A wrong token is refused in constant time and reveals nothing about the secret.
  if (!constantTimeEqual(provided, verifyToken)) fail(403, "WHATSAPP_VERIFICATION_INVALID", "This webhook verification is not authentic");
  await limit(svc, project, "channel_webhook", "endpoint");
  return { ok: true, challenge };
}

// --- webhook ingestion (POST) ---------------------------------------------------------------

/**
 * Handles ONE verified WhatsApp delivery for one agent of one project.
 *
 * Order of checks (each fails closed BEFORE the agent executor and any charge):
 *   agent declared → credentials present → X-Hub-Signature-256 over the EXACT raw body →
 *   flood limit → parse → duplicate-delivery claim → inbound relay charge →
 *   activation/message parsing → identity-resolved owner.
 * Unsupported updates (statuses, edits, non-text) are acknowledged and ignored.
 */
export async function handleWhatsAppUpdate(client, {
  project, payload, update, agentName, signatureHeader, rawBody, resolveSecret, http = null, options = {}, meta = {},
}) {
  const svc = client.asServiceRole || client;
  const httpx = http || whatsappHttp;
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);

  const appSecret = await requireWhatsAppSecret(resolveSecret, WHATSAPP_APP_SECRET_NAME);
  const waToken = await requireWhatsAppSecret(resolveSecret, WHATSAPP_TOKEN_SECRET);
  const phoneNumberId = await requireWhatsAppSecret(resolveSecret, WHATSAPP_PHONE_NUMBER_ID_SECRET);

  // 1. Signature — the ONLY thing that authenticates this session-less request: HMAC-SHA256
  //    of the app secret over the EXACT raw bytes received (a re-serialized body is not
  //    verified). Missing and wrong are the same refusal; verified BEFORE the limiter so
  //    garbage traffic cannot drain the project's webhook budget, and before ANY charge.
  const provided = String(signatureHeader || "").replace(/^sha256=/, "").trim();
  if (!provided) fail(401, "WHATSAPP_SIGNATURE_INVALID", "This webhook delivery is not authentic");
  const expected = await hmacSha256Hex(appSecret, rawBody ?? "");
  if (!constantTimeEqual(provided, expected)) fail(401, "WHATSAPP_SIGNATURE_INVALID", "This webhook delivery is not authentic");

  // 2. Flood control — durable, per project, counted only for authenticated deliveries.
  await limit(svc, project, "channel_webhook", "endpoint");

  // 2b. P-9.13G: a group_lifecycle_update delivery (the provider's OWN groups webhook field,
  //     verified against the SAME signature above) carries the group create/invite events.
  //     Bounded, scrubbed extraction only — no pending request is acknowledged and ignored.
  const lifecycleChange = update?.entry?.[0]?.changes?.find((c) => c?.field === "group_lifecycle_update");
  if (lifecycleChange) {
    return handleWhatsAppGroupLifecycle(svc, { project, payload, agentName, resolveSecret, value: lifecycleChange.value || null, http: httpx, meta });
  }

  // 3. Parse: only the messages field of the first change is acted on. Identity fields other
  //    than the sender id of the verified message are never trusted.
  const value = update?.entry?.[0]?.changes?.find((c) => c?.field === "messages")?.value || null;
  const message = Array.isArray(value?.messages) ? value.messages[0] : null;
  if (!message || (message.type && message.type !== "text")) return { ok: true, ignored: true };
  const from = String(message?.from || "");
  // P-9.13G: a GROUP message carries the provider's group_id while `from` — and the contacts
  // entry — stay the PARTICIPANT who sent it (Meta's documented shape), so sender identity and
  // routing are the certified P-9.10C contracts, unchanged.
  const groupId = String(message?.group_id || "");
  const replyTo = groupId || from;
  const text = String(message?.text?.body ?? "");
  if (!from || !text) return { ok: true, ignored: true };
  // R-2d: the Cloud API defines messages[].id (wamid) on every message. A processable message
  // without a valid one is malformed and refused before the claim, charge or agent.
  if (!isProviderMessageId(message?.id)) fail(400, "WHATSAPP_MESSAGE_INVALID", "This WhatsApp message has no valid id");
  const messageId = message.id;

  // 4. Duplicate delivery — durable single-use claim on the provider message id. A duplicate
  //    is acknowledged (the provider stops redelivering) and neither executes nor charges.
  if (!(await claimDeliveryOnce(svc, `wa_replay:${project.id}:${messageId}`))) {
    return { ok: true, duplicate: true };
  }

  // 5. Inbound relay charge (the Base44-documented rate): 1 integration credit per RECEIVED
  //    message, held BEFORE any processing and settled exactly once. The hold refuses
  //    fail-closed when the workspace has nothing to spend; the ledger keys derive from the
  //    provider message id, so even a racing duplicate settles the same entries.
  const workspace_id = await chargeWorkspace(svc, project.id);
  const inbound = workspace_id ? await holdIntegrationCredits(svc, {
    workspace_id, project_id: project.id, credits: WHATSAPP_RELAY_CREDITS,
    key: `whatsapp:in:${messageId}`,
    reason: `WhatsApp relay · inbound · ${WHATSAPP_RELAY_CREDITS} credit per received message`,
  }) : null;
  // The provider already delivered this message — the inbound relay charge is earned now.
  await inbound?.settle(WHATSAPP_RELAY_CREDITS, "WhatsApp relay · inbound", { direction: "inbound", agent: agent.name });

  // 6. Activation — the connect URL's prefilled message carrying the single-use code. Groups
  //    NEVER activate (P-9.13G): the code is a private single-use DM contract, and consuming it
  //    inside a shared chat would leak the binding to every participant.
  if (groupId && ACTIVATION_CODE_RE.test(text.trim())) return { ok: true, ignored: true };
  if (ACTIVATION_CODE_RE.test(text.trim())) {
    const used = await consumeToken(svc, project, { token: text.trim(), kind: "channel_activation" });
    if (String(used.data?.channel || "") !== "whatsapp") fail(400, "CHANNEL_STATE_MISMATCH", "This activation does not belong to the WhatsApp channel");
    if (String(used.data?.agent || "") !== agent.name) fail(409, "CHANNEL_AGENT_MISMATCH", "This activation was issued for a different agent");
    const linkedUser = await getAppUser(svc, project, used.app_user_id);
    if (!linkedUser || linkedUser.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");
    const existing = await findIdentity(svc, project, "whatsapp", from);
    if (existing && existing.app_user_id !== linkedUser.id) fail(409, "CHANNEL_IDENTITY_TAKEN", "This WhatsApp account is already linked to another user");
    await assertWhatsAppAgentCapacity(svc, project, agent.name);
    const profile = scrub({ agent: agent.name });
    const identity = existing
      ? await svc.entities.AppIdentity.update(existing.id, { last_login_at: nowIso(), profile })
      : await svc.entities.AppIdentity.create({
          project_id: project.id, app_user_id: linkedUser.id, provider: "whatsapp", provider_subject: from,
          profile, status: "linked", linked_at: nowIso(), last_login_at: nowIso(),
        });
    // First contact: the agent's whatsapp_greeting, through the same outbound relay charge.
    const greeting = scrubText(
      String(agent.whatsapp_greeting || `You are now connected to ${agent.display_name || agent.name}.`),
      WHATSAPP_GREETING_MAX_CHARS,
    );
    const sent = await sendWithRelayCharge(svc, { workspace_id, project, http: httpx, token: waToken, phoneNumberId, to: from, text: greeting, chargeKey: `${messageId}:greeting` });
    await recordAuthEvent(svc, project, {
      action: "channel_linked", resource: "AppIdentity", resource_id: identity.id,
      metadata: { channel: "whatsapp", agent: agent.name, app_user_id: linkedUser.id, greeting_delivered: !!sent.ok }, meta,
    });
    return { ok: true, linked: true, agent: agent.name, greeting_delivered: !!sent.ok, delivery_error: sent.ok ? null : sent.error };
  }

  // 7. Regular message — the owner is resolved from the identity row, never from the payload.
  //    P-9.11C: an UNLINKED chat of an agent that allows anonymous access gets a server-minted
  //    anonymous owner instead of the certified refusal; every other agent is unchanged.
  if (!text.trim()) return { ok: true, ignored: true };
  if (text.length > APP_AGENT_LIMITS.MAX_MESSAGE_CHARS) {
    fail(413, "AGENT_MESSAGE_TOO_LONG", `Message exceeds ${APP_AGENT_LIMITS.MAX_MESSAGE_CHARS} characters`);
  }
  let identity = await findIdentity(svc, project, "whatsapp", from);
  let firstContact = false;
  if (!identity) {
    if (agent.allow_anonymous_access !== true) fail(403, "CHANNEL_NOT_LINKED", "This WhatsApp account is not linked to an account yet");
    const ensured = await ensureAnonymousChannelIdentity(svc, { project, provider: "whatsapp", subject: from, agent, meta });
    identity = ensured.identity;
    firstContact = ensured.created;
  }
  if (String(identity.profile?.agent || "") && identity.profile.agent !== agent.name) {
    fail(409, "CHANNEL_AGENT_MISMATCH", "This WhatsApp account is linked to a different agent");
  }
  const owner = await getAppUser(svc, project, identity.app_user_id);
  if (!owner || owner.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");
  if (firstContact) {
    // First contact: the agent's whatsapp_greeting, through the SAME outbound relay charge.
    const greeting = scrubText(
      String(agent.whatsapp_greeting || `You are now connected to ${agent.display_name || agent.name}.`),
      WHATSAPP_GREETING_MAX_CHARS,
    );
    const sent = await sendWithRelayCharge(svc, { workspace_id, project, http: httpx, token: waToken, phoneNumberId, to: replyTo, text: greeting, chargeKey: `${messageId}:greeting` });
    await recordAuthEvent(svc, project, {
      action: "channel_anonymous_greeting", resource: "AppIdentity", resource_id: identity.id,
      metadata: { channel: "whatsapp", agent: agent.name, greeting_delivered: !!sent.ok }, meta,
    });
  }

  // 8. The EXISTING P-9.4 executor — model access, message credits and tool authorization are
  //    enforced inside it; this module adds no second billing path. An anonymous owner travels
  //    through the `anonymous` param, so the per-agent gate is enforced inside and tools run
  //    with NO user context (per-user private data stays fail-closed).
  const anonChat = isAnonymousUser(owner);
  const turnReplayKey = `wa_replay:${project.id}:${messageId}`;
  const run = await runTurnReleasingReplay(svc, turnReplayKey, () => handleAppAgent(client, {
    project, payload, user: anonChat ? null : publicUser(owner), anonymous: anonChat ? { user: publicUser(owner) } : null, op: "invoke",
    args: { name: agent.name, message: text, idempotency_key: `whatsapp:${messageId}` }, options,
  }));

  // 9. Outbound delivery: hold 1 relay credit BEFORE the provider send, settle by delivery.
  const reply = scrubText(String(run.reply || ""), WHATSAPP_OUTBOUND_MAX_CHARS);
  // At-most-once per successful send; a failed send stays retryable by a redelivery of the same
  // message (keyed replay, same charge key — the relay credit is charged once, on success).
  const sent = await deliverReplyOnce(svc, {
    sentKey: `wa_sent:${project.id}:${messageId}`, replayKey: `wa_replay:${project.id}:${messageId}`, namespace: "whatsapp_sent", claim: claimDeliveryOnce,
    send: () => sendWithRelayCharge(svc, { workspace_id, project, http: httpx, token: waToken, phoneNumberId, to: replyTo, text: reply, recipientType: groupId ? "group" : "individual", chargeKey: `${messageId}:reply` }),
  });
  if (sent.already_sent) return { ok: true, duplicate: true, replayed: true, conversation_id: run.conversation_id, agent: agent.name, delivered: false, delivery_error: null };
  return {
    ok: true, conversation_id: run.conversation_id, agent: agent.name,
    delivered: !!sent.ok, delivery_error: sent.ok ? null : sent.error,
  };
}

// =============================================================================================
// P-9.11L — LINE channel foundation, mirroring the certified P-9.10A/P-9.10C channel contracts.
//
// Evidence-driven (READ-ONLY audit of docs.base44.com before any edit), never assumptions:
//   • VERIFIED (docs.base44.com, AI-agents-for-apps · LINE): "Connect your agent to LINE so
//     people can message it directly from the LINE app, without opening your app. A
//     LINE-connected agent has the same capabilities as your in-app agent." The documented
//     connect mechanism is an ACTIVATION CODE the user sends to the bot as a message ("copy
//     the activation code, open LINE on your phone, add the Base44 bot, and send the
//     activation code to connect"), and "Activation codes expire after 30 minutes" (the Tip
//     on the same page). Notes on the same page: "LINE replies are plain text only" and, in
//     the groups section, "LINE groups aren't supported". "LINE is only available in Japan"
//     is a product availability note with no published runtime mechanism — nothing is
//     enforced for it here. The product changelog ships Telegram+LINE together for in-app
//     agents and the channel governance policy covers LINE. The Base44 SDK documents NO LINE
//     connect method (agents interface: getWhatsAppConnectURL / getTelegramConnectURL only),
//     so the runtime SDK surface gains none.
//   • webhook — the PROVIDER's documented mechanism: X-Line-Signature = base64(
//     HMAC-SHA256(channel secret, EXACT raw body)), compared in constant time. Base44's own
//     LINE relay internals are not published (UNKNOWN) — everything stays fail-closed. LINE
//     defines NO GET verification handshake (unlike WhatsApp's hub challenge), so there is
//     none here either.
//   • binding — the SAME single-use AppAuthToken (kind "channel_activation", hash-at-rest,
//     the Base44-documented 30-minute TTL) and AppIdentity (provider "line", subject = the
//     sender's LINE userId) contracts as P-9.10A/P-9.10C. The connect surface returns the
//     activation CODE and its expiry; Base44 publishes no LINE URL scheme and no QR content
//     (UNKNOWN) — no deep-link or QR semantics are invented.
//   • outbound — the provider's documented reply endpoint: ONE replyToken per webhook event,
//     one reply request carrying up to 5 plain-text messages. A first-contact greeting and
//     the agent's answer therefore travel in ONE reply; a failed agent turn delivers no
//     reply at all rather than inventing the push API (delivery semantics stay the
//     provider's own, and no retry/redelivery is invented).
//   • billing — Base44 publishes NO LINE relay rate (unlike WhatsApp's documented 1 credit
//     in/out). The certified P-9.10A Telegram precedent applies: the ONLY charges are the
//     agent's own per-turn integration credits (P-9.11E) and tool charges inside the P-9.2
//     handlers; no LINE relay tariff is invented.
//   • greeting — Base44 documents a customizable "LINE welcome message" in the builder UI
//     but publishes NO agent-document field for it (UNKNOWN; `line_greeting` is NOT
//     invented). The platform's existing generic channel fallback greeting applies.
//   • identity/execution — the owner is ALWAYS resolved server-side from the identity row
//     and the run goes through the EXISTING P-9.4 executor (handleAppAgent); anonymous
//     access reuses the SAME per-agent P-9.11C mechanism (allow_anonymous_access),
//     channel-generic exactly as certified.
export const LINE_CHANNEL_ACCESS_TOKEN_SECRET = "LINE_CHANNEL_ACCESS_TOKEN";
export const LINE_CHANNEL_SECRET_NAME = "LINE_CHANNEL_SECRET";
export const LINE_SIGNATURE_HEADER_NAME = "x-line-signature";
export const LINE_ACTIVATION_TTL_MS = 30 * 60 * 1000; // Base44-documented: codes expire after 30 minutes
export const LINE_OUTBOUND_MAX_CHARS = 5000;         // the provider's own hard text-message cap
export const LINE_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const LINE_API_BASE = "https://api.line.me/v2/bot";

/** The default LINE transport. Injectable so certification can script the provider. */
export async function lineHttp(url, init) {
  return fetch(url, init);
}

// Fail closed: no credential → no channel. The refusal names the SECRET, never a value.
async function requireLINESecret(resolveSecret, name) {
  const value = resolveSecret ? await resolveSecret(name) : undefined;
  if (!value) fail(503, "LINE_NOT_CONFIGURED", `This application has no ${name} configured, so the LINE channel is unavailable.`);
  return String(value);
}

// Base64(HMAC-SHA256(secret, raw)) — LINE's documented signature form (WhatsApp's is hex).
async function hmacSha256Base64(secret, raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(raw ?? ""))))));
}

// One LINE Messaging API call. The channel access token travels only in the server-side
// Authorization header; any error is scrubbed of it before it can reach a log or a response.
// LINE answers 200 with an (often empty) JSON body — there is no ok envelope to check.
async function lineApi(http, accessToken, { method = "GET", path, body = null }) {
  const init = {
    method,
    headers: { authorization: `Bearer ${accessToken}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
  };
  let res;
  try { res = await http(`${LINE_API_BASE}/${path}`, init); }
  catch (e) { return { ok: false, error: String(e?.message || e).split(accessToken).join("[redacted]") }; }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) return { ok: false, error: scrubText(String(data?.message || res.statusText || "LINE API error"), 200).split(accessToken).join("[redacted]") };
  return { ok: true, result: data };
}

// --- connect code ---------------------------------------------------------------------------

/**
 * Issues the agent's LINE activation CODE for the CURRENT signed-in app user — the
 * Base44-documented connect surface ("copy the activation code... and send the activation
 * code to connect"). The code is a fresh single-use AppAuthToken: hashed at rest, expiring
 * after the Base44-documented 30 minutes, bound server-side to (project, agent, app user).
 * Its raw value appears exactly once — in this response — and in no log, audit row or later
 * response. Base44 publishes no LINE URL scheme and no QR content (UNKNOWN): none is invented.
 */
export async function connectLINE(svc, { project, payload, user, agentName, resolveSecret, http = lineHttp, meta = {} }) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);
  await limit(svc, project, "channel_activation", `user:${user.id}`);
  const accessToken = await requireLINESecret(resolveSecret, LINE_CHANNEL_ACCESS_TOKEN_SECRET);
  // The provider call validates the credential (the mirror of Telegram's getMe and
  // WhatsApp's display_phone_number steps).
  const info = await lineApi(http, accessToken, { path: "info" });
  if (!info.ok || !String(info.result?.userId || "")) fail(502, "LINE_UNAVAILABLE", `The LINE bot is unreachable: ${info.error || "no bot identity"}`);
  const { token, row } = await issueToken(svc, project, {
    user, kind: "channel_activation", ttl_ms: LINE_ACTIVATION_TTL_MS,
    data: { channel: "line", agent: agent.name },
  });
  await recordAuthEvent(svc, project, {
    action: "channel_activation_requested", resource: "AppAuthToken", resource_id: row.id,
    metadata: { channel: "line", agent: agent.name, app_user_id: user.id, expires_in_ms: LINE_ACTIVATION_TTL_MS }, meta,
  });
  return { channel: "line", agent: agent.name, code: token, expires_in_ms: LINE_ACTIVATION_TTL_MS };
}

// --- webhook ingestion ------------------------------------------------------------------------

/**
 * Handles ONE verified LINE webhook delivery for one agent of one project.
 *
 * Order of checks (each fails closed BEFORE the agent executor and any charge):
 *   agent declared → credentials present → X-Line-Signature over the EXACT raw body →
 *   flood limit → parse → duplicate-delivery claim → activation/message parsing →
 *   identity-resolved owner.
 * Unsupported events (non-text messages, non-user sources) are acknowledged and ignored.
 */
export async function handleLINEUpdate(client, {
  project, payload, update, agentName, signatureHeader, rawBody, resolveSecret, http = null, options = {}, meta = {},
}) {
  const svc = client.asServiceRole || client;
  const httpx = http || lineHttp;
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);

  const accessToken = await requireLINESecret(resolveSecret, LINE_CHANNEL_ACCESS_TOKEN_SECRET);
  const channelSecret = await requireLINESecret(resolveSecret, LINE_CHANNEL_SECRET_NAME);

  // 1. Signature — the ONLY thing that authenticates this session-less request: LINE's
  //    documented X-Line-Signature = base64(HMAC-SHA256(channel secret, EXACT raw bytes);
  //    a re-serialized body is not verified). Missing and wrong are the same refusal;
  //    verified BEFORE the limiter so garbage traffic cannot drain the project's webhook
  //    budget, and before ANY charge.
  const provided = String(signatureHeader || "").trim();
  if (!provided) fail(401, "LINE_SIGNATURE_INVALID", "This webhook delivery is not authentic");
  const expected = await hmacSha256Base64(channelSecret, rawBody ?? "");
  if (!constantTimeEqual(provided, expected)) fail(401, "LINE_SIGNATURE_INVALID", "This webhook delivery is not authentic");

  // 2. Flood control — durable, per project, counted only for authenticated deliveries.
  await limit(svc, project, "channel_webhook", "endpoint");

  // 3. Parse: only the first event of the delivery is acted on. Identity fields other than
  //    the sender's userId of the verified message are never trusted.
  const event = Array.isArray(update?.events) ? update.events[0] : null;
  if (!event || event.type !== "message" || String(event.source?.type || "") !== "user") {
    return { ok: true, ignored: true }; // unsupported event: acknowledge, never retry
  }
  const message = event.message || null;
  const userId = String(event.source?.userId || "");
  const replyToken = String(event.replyToken || "");
  if (!message || (message.type && message.type !== "text") || !userId || !replyToken) {
    return { ok: true, ignored: true }; // non-text message / missing reply token: acknowledge
  }
  const text = String(message.text ?? "");
  if (!text.trim()) return { ok: true, ignored: true };
  // R-2d: the Messaging API defines message.id on every message event. A processable message
  // without a valid one is malformed and refused before the claim, agent or any reply.
  if (!isProviderMessageId(message.id)) fail(400, "LINE_MESSAGE_INVALID", "This LINE message has no valid id");
  const messageId = message.id;

  // 4. Duplicate delivery — durable single-use claim on the provider message id (the SAME
  //    WhatsApp replay pattern). A duplicate is acknowledged (the provider stops
  //    redelivering) and neither executes nor charges.
  if (!(await claimDeliveryOnce(svc, `line_replay:${project.id}:${messageId}`, Date.now(), { namespace: "line_replay", ttlMs: LINE_REPLAY_TTL_MS }))) {
    return { ok: true, duplicate: true };
  }

  // 5. Activation — the Base44-documented connect mechanism: the activation code sent to the
  //    bot as a message.
  if (ACTIVATION_CODE_RE.test(text.trim())) {
    const used = await consumeToken(svc, project, { token: text.trim(), kind: "channel_activation" });
    if (String(used.data?.channel || "") !== "line") fail(400, "CHANNEL_STATE_MISMATCH", "This activation does not belong to the LINE channel");
    if (String(used.data?.agent || "") !== agent.name) fail(409, "CHANNEL_AGENT_MISMATCH", "This activation was issued for a different agent");
    const linkedUser = await getAppUser(svc, project, used.app_user_id);
    if (!linkedUser || linkedUser.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");
    const existing = await findIdentity(svc, project, "line", userId);
    if (existing && existing.app_user_id !== linkedUser.id) fail(409, "CHANNEL_IDENTITY_TAKEN", "This LINE account is already linked to another user");
    const profile = scrub({ agent: agent.name });
    const identity = existing
      ? await svc.entities.AppIdentity.update(existing.id, { last_login_at: nowIso(), profile })
      : await svc.entities.AppIdentity.create({
          project_id: project.id, app_user_id: linkedUser.id, provider: "line", provider_subject: userId,
          profile, status: "linked", linked_at: nowIso(), last_login_at: nowIso(),
        });
    // First contact: the platform's generic channel greeting (no `line_greeting` exists —
    // Base44 publishes no agent-document field, so none is invented). ONE plain-text reply.
    const greeting = scrubText(`You are now connected to ${agent.display_name || agent.name}.`, 500);
    const sent = await lineApi(httpx, accessToken, { method: "POST", path: "message/reply", body: { replyToken, messages: [{ type: "text", text: greeting }] } });
    await recordAuthEvent(svc, project, {
      action: "channel_linked", resource: "AppIdentity", resource_id: identity.id,
      metadata: { channel: "line", agent: agent.name, app_user_id: linkedUser.id, greeting_delivered: !!sent.ok }, meta,
    });
    return { ok: true, linked: true, agent: agent.name, greeting_delivered: !!sent.ok, delivery_error: sent.ok ? null : sent.error };
  }

  // 6. Regular message — the owner is resolved from the identity row, never from the payload.
  //    P-9.11C: an UNLINKED chat of an agent that allows anonymous access gets a server-minted
  //    anonymous owner instead of the certified refusal; every other agent is unchanged.
  if (text.length > APP_AGENT_LIMITS.MAX_MESSAGE_CHARS) {
    fail(413, "AGENT_MESSAGE_TOO_LONG", `Message exceeds ${APP_AGENT_LIMITS.MAX_MESSAGE_CHARS} characters`);
  }
  let identity = await findIdentity(svc, project, "line", userId);
  let firstContact = false;
  if (!identity) {
    if (agent.allow_anonymous_access !== true) fail(403, "CHANNEL_NOT_LINKED", "This LINE account is not linked to an account yet");
    const ensured = await ensureAnonymousChannelIdentity(svc, { project, provider: "line", subject: userId, agent, meta });
    identity = ensured.identity;
    firstContact = ensured.created;
  }
  if (String(identity.profile?.agent || "") && identity.profile.agent !== agent.name) {
    fail(409, "CHANNEL_AGENT_MISMATCH", "This LINE account is linked to a different agent");
  }
  const owner = await getAppUser(svc, project, identity.app_user_id);
  if (!owner || owner.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");

  // 7. The EXISTING P-9.4 executor — model access, message credits and tool authorization are
  //    enforced inside it; this module adds no second billing path and NO LINE relay charge
  //    (Base44 publishes none — the P-9.10A Telegram precedent). An anonymous owner travels
  //    through the `anonymous` param, so the per-agent gate is enforced inside and tools run
  //    with NO user context (per-user private data stays fail-closed).
  const anonChat = isAnonymousUser(owner);
  const turnReplayKey = `line_replay:${project.id}:${messageId}`;
  const run = await runTurnReleasingReplay(svc, turnReplayKey, () => handleAppAgent(client, {
    project, payload, user: anonChat ? null : publicUser(owner), anonymous: anonChat ? { user: publicUser(owner) } : null, op: "invoke",
    args: { name: agent.name, message: text, idempotency_key: `line:${messageId}` }, options,
  }));

  // 8. Outbound delivery — the provider's documented reply mechanism: ONE replyToken per
  //    webhook event, one reply request carrying up to 5 plain-text messages. A first-contact
  //    greeting and the agent's answer therefore travel in ONE reply (a replyToken is
  //    single-use); a failed agent turn delivers no reply at all rather than inventing the
  //    push API.
  const reply = scrubText(String(run.reply || ""), LINE_OUTBOUND_MAX_CHARS);
  const messages = [
    ...(firstContact ? [{ type: "text", text: scrubText(`You are now connected to ${agent.display_name || agent.name}.`, 500) }] : []),
    { type: "text", text: reply },
  ];
  // At-most-once per successful reply (shared deliverReplyOnce); a failed reply releases both
  // claims so a provider redelivery reaches the keyed replay (no agent rerun). Whether a
  // redelivered event's replyToken is still usable is the provider's (UNKNOWN) behavior.
  const sent = await deliverReplyOnce(svc, {
    sentKey: `line_sent:${project.id}:${messageId}`, replayKey: `line_replay:${project.id}:${messageId}`, namespace: "line_sent", claim: claimDeliveryOnce,
    send: () => lineApi(httpx, accessToken, { method: "POST", path: "message/reply", body: { replyToken, messages } }),
  });
  if (sent.already_sent) return { ok: true, duplicate: true, replayed: true, conversation_id: run.conversation_id, agent: agent.name, delivered: false, delivery_error: null };
  if (firstContact) {
    await recordAuthEvent(svc, project, {
      action: "channel_anonymous_greeting", resource: "AppIdentity", resource_id: identity.id,
      metadata: { channel: "line", agent: agent.name, greeting_delivered: !!sent.ok }, meta,
    });
  }
  return {
    ok: true, conversation_id: run.conversation_id, agent: agent.name,
    delivered: !!sent.ok, delivery_error: sent.ok ? null : sent.error,
  };
}

// P-9.13G — WhatsApp groups live in ./whatsappGroups.ts.

// =============================================================================================
// P-9.12S — Slack channel foundation, mirroring the certified P-9.10A/P-9.10C/P-9.11L contracts.
//
// Evidence-driven (READ-ONLY audit of docs.base44.com before any edit), never assumptions:
//   • VERIFIED (docs.base44.com, Customizing your Superagent · Slack): Slack is a documented
//     messaging channel with two documented setups — the Slack User connector (the member's
//     own Slack account through OAuth) and the Channel setup ("people in Slack channels
//     interact with your Superagent directly. They can mention it in a channel, your
//     Superagent replies in a thread").
//   • The DOCUMENTED channel setup installs Base44's OWN Slack app ("Superagents by Base44")
//     — platform-owned infrastructure this app cannot publish. The smallest production-grade
//     extension therefore reuses the SAME provider-native posture the certified channels use
//     (the documented register-a-webhook mechanism): the member registers THIS webhook URL in
//     their own Slack app's Events API configuration, supplies SLACK_BOT_TOKEN and
//     SLACK_SIGNING_SECRET as project secrets, and the bot answers @-mentions in channels and
//     direct messages, replying in a thread.
//   • webhook — the PROVIDER's documented mechanism: X-Slack-Signature = "v0=" + hex(
//     HMAC-SHA256(signing secret, "v0:<timestamp>:<exact raw body>")). The documented
//     url_verification handshake is answered (same-signature discipline).
//   • binding — the SAME single-use AppAuthToken (kind "channel_activation", the documented
//     30-minute TTL) and AppIdentity (provider "slack", subject = the sender's Slack member
//     id) contracts as the certified channels.
//   • outbound — the provider's documented chat.postMessage; a channel mention replies in the
//     mention's thread (thread_ts), matching the documented "replies in a thread".
//   • billing — no relay tariff is invented (the certified Telegram/LINE precedent): the ONLY
//     charges are the agent's own per-turn credits through the EXISTING P-9.4 executor.
//   • Redeliveries: Slack retries deliveries — the durable duplicate claim keys on the
//     provider's event_id.
export const SLACK_BOT_TOKEN_SECRET = "SLACK_BOT_TOKEN";
export const SLACK_SIGNING_SECRET_NAME = "SLACK_SIGNING_SECRET";
export const SLACK_SIGNATURE_HEADER_NAME = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER_NAME = "x-slack-request-timestamp";
export const SLACK_MAX_SKEW_SECONDS = 300;
export const SLACK_ACTIVATION_TTL_MS = 30 * 60 * 1000; // the SAME documented 30-minute TTL
export const SLACK_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
export const SLACK_OUTBOUND_MAX_CHARS = 4000; // the provider's own hard message cap
const SLACK_API_BASE = "https://slack.com/api";

/** The default Slack transport. Injectable so certification can script the provider. */
export async function slackHttp(url, init) {
  return fetch(url, init);
}

// Fail closed: no credential → no channel. The refusal names the SECRET, never a value.
async function requireSlackSecret(resolveSecret, name) {
  const value = resolveSecret ? await resolveSecret(name) : undefined;
  if (!value) fail(503, "SLACK_NOT_CONFIGURED", `This application has no ${name} configured, so the Slack channel is unavailable.`);
  return String(value);
}

// (The hex HMAC-SHA256 helper is the ONE shared hmacSha256Hex above — WhatsApp's documented
// signature form is the same hex scheme, so Slack reuses it instead of a second copy.)

// One Slack Web API call. The bot token travels only in the server-side Authorization header;
// any error is scrubbed of it before it can reach a log or a response.
async function slackApi(http, botToken, { path, body = null }) {
  const init = {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body || {}),
  };
  let res;
  try { res = await http(`${SLACK_API_BASE}/${path}`, init); }
  catch (e) { return { ok: false, error: String(e?.message || e).split(botToken).join("[redacted]") }; }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || data?.ok === false) {
    const raw = String(data?.error || res.statusText || "Slack API error");
    return { ok: false, error: scrubText(raw, 200).split(botToken).join("[redacted]") };
  }
  return { ok: true, result: data };
}

// --- connect code ---------------------------------------------------------------------------

/**
 * Issues the agent's Slack activation CODE for the CURRENT signed-in app user — the SAME
 * documented connect mechanism the certified channels use (the activation code is sent to the
 * bot as a message). The code is a fresh single-use AppAuthToken: hashed at rest, expiring
 * after the documented 30 minutes, bound server-side to (project, agent, app user). Its raw
 * value appears exactly once — in this response — and in no log, audit row or later response.
 * The documented install-to-workspace step belongs to the member's own Slack app; none of its
 * semantics are invented here.
 */
export async function connectSlack(svc, { project, payload, user, agentName, resolveSecret, http = slackHttp, meta = {} }) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in required");
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);
  await limit(svc, project, "channel_activation", `user:${user.id}`);
  const botToken = await requireSlackSecret(resolveSecret, SLACK_BOT_TOKEN_SECRET);
  // The provider call validates the credential (the mirror of Telegram's getMe and
  // WhatsApp's display_phone_number steps).
  const info = await slackApi(http, botToken, { path: "auth.test" });
  if (!info.ok || !String(info.result?.user_id || "")) fail(502, "SLACK_UNAVAILABLE", `The Slack bot is unreachable: ${info.error || "no bot identity"}`);
  const { token, row } = await issueToken(svc, project, {
    user, kind: "channel_activation", ttl_ms: SLACK_ACTIVATION_TTL_MS,
    data: { channel: "slack", agent: agent.name },
  });
  await recordAuthEvent(svc, project, {
    action: "channel_activation_requested", resource: "AppAuthToken", resource_id: row.id,
    metadata: { channel: "slack", agent: agent.name, app_user_id: user.id, expires_in_ms: SLACK_ACTIVATION_TTL_MS }, meta,
  });
  return { channel: "slack", agent: agent.name, code: token, expires_in_ms: SLACK_ACTIVATION_TTL_MS };
}

// --- webhook ingestion ------------------------------------------------------------------------

/**
 * Handles ONE verified Slack Events API delivery for one agent of one project.
 *
 * Order of checks (each fails closed BEFORE the agent executor and any charge):
 *   agent declared → credentials present → X-Slack-Signature over the EXACT raw body →
 *   flood limit → url_verification handshake → event parsing → duplicate-delivery claim →
 *   activation/message parsing → identity-resolved owner.
 * Unsupported events (reaction events, edits, other bots' posts, non-mentioned channel
 * messages) are acknowledged and ignored.
 */
export async function handleSlackEvent(client, {
  project, payload, update, agentName, signatureHeader, timestampHeader, rawBody, resolveSecret, http = null, options = {}, meta = {}, now = Date.now(),
}) {
  const svc = client.asServiceRole || client;
  const httpx = http || slackHttp;
  const agent = (payload?.agents || []).find((a) => a.name === String(agentName || ""));
  if (!agent) fail(404, "AGENT_NOT_FOUND", `Agent "${agentName}" is not part of this deployment`);

  const botToken = await requireSlackSecret(resolveSecret, SLACK_BOT_TOKEN_SECRET);
  const signingSecret = await requireSlackSecret(resolveSecret, SLACK_SIGNING_SECRET_NAME);

  // 1. Signature — the ONLY thing that authenticates this session-less request: Slack's
  //    documented X-Slack-Signature = "v0=" + hex(HMAC-SHA256(signing secret,
  //    "v0:<timestamp>:<exact raw body>")). Missing and wrong are the same refusal; verified
  //    BEFORE the limiter so garbage traffic cannot drain the project's webhook budget.
  const provided = String(signatureHeader || "").trim();
  const timestamp = String(timestampHeader || "");
  if (!provided || !timestamp || !/^\d+$/.test(timestamp)) fail(401, "SLACK_SIGNATURE_INVALID", "This webhook delivery is not authentic");
  const expected = "v0=" + (await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody ?? ""}`));
  if (!constantTimeEqual(provided, expected)) fail(401, "SLACK_SIGNATURE_INVALID", "This webhook delivery is not authentic");
  // R-11: Slack's documented replay guard — refuse a timestamp more than 5 minutes from now
  // (stale or future-dated), BEFORE the limiter so it consumes no webhook budget.
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > SLACK_MAX_SKEW_SECONDS) fail(401, "SLACK_REQUEST_STALE", "This webhook delivery is too old or too far in the future");

  // 2. Flood control — durable, per project, counted only for authenticated deliveries.
  await limit(svc, project, "channel_webhook", "endpoint");

  // 3. The documented Events API handshake.
  if (update?.type === "url_verification") {
    return { challenge: String(update.challenge || "") };
  }

  // 4. Parse ONE event. Unsupported payloads are acknowledged and ignored. A channel message
  //    is served only as an @-mention (app_mention); a direct message carries no mention.
  const event = update?.event && typeof update.event === "object" ? update.event : null;
  if (!event) return { ok: true, ignored: true };
  const eventType = String(event.type || "");
  if (eventType !== "app_mention" && eventType !== "message") return { ok: true, ignored: true };
  const channel = String(event.channel || "");
  const slackUserId = String(event.user || "");
  if (event.bot_id || !slackUserId || !channel) return { ok: true, ignored: true }; // our own/bot posts, or no member id
  const isIm = eventType === "message" && (String(event.channel_type || "") === "im" || channel.startsWith("D"));
  if (eventType === "message" && !isIm) return { ok: true, ignored: true };
  // The mention markup Slack carries in app_mention text is stripped — never shown to the agent.
  const text = String(event.text || "").replace(/<@[A-Za-z0-9.]+>/g, "").trim();
  if (!text) return { ok: true, ignored: true };

  // 5. Duplicate delivery — durable single-use claim on the provider event id (the SAME
  //    LINE/WhatsApp replay pattern). A duplicate is acknowledged, never re-executed.
  const dedupKey = String(update.event_id || `${channel}:${event.ts || ""}`);
  const replayKey = `slack_replay:${project.id}:${dedupKey}`;
  if (dedupKey && !(await claimDeliveryOnce(svc, replayKey, Date.now(), { namespace: "slack_replay", ttlMs: SLACK_REPLAY_TTL_MS }))) {
    return { ok: true, duplicate: true };
  }

  // 6. Activation — the documented connect mechanism: the activation code sent to the bot.
  if (ACTIVATION_CODE_RE.test(text)) {
    const used = await consumeToken(svc, project, { token: text.trim(), kind: "channel_activation" });
    if (String(used.data?.channel || "") !== "slack") fail(400, "CHANNEL_STATE_MISMATCH", "This activation does not belong to the Slack channel");
    if (String(used.data?.agent || "") !== agent.name) fail(409, "CHANNEL_AGENT_MISMATCH", "This activation was issued for a different agent");
    const linkedUser = await getAppUser(svc, project, used.app_user_id);
    if (!linkedUser || linkedUser.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");
    const existing = await findIdentity(svc, project, "slack", slackUserId);
    if (existing && existing.app_user_id !== linkedUser.id) fail(409, "CHANNEL_IDENTITY_TAKEN", "This Slack account is already linked to another user");
    const profile = scrub({ agent: agent.name });
    const identity = existing
      ? await svc.entities.AppIdentity.update(existing.id, { last_login_at: nowIso(), profile })
      : await svc.entities.AppIdentity.create({
          project_id: project.id, app_user_id: linkedUser.id, provider: "slack", provider_subject: slackUserId,
          profile, status: "linked", linked_at: nowIso(), last_login_at: nowIso(),
        });
    const greeting = scrubText(`You are now connected to ${agent.display_name || agent.name}.`, 500);
    const sent = await slackApi(httpx, botToken, { path: "chat.postMessage", body: { channel, text: greeting } });
    await recordAuthEvent(svc, project, {
      action: "channel_linked", resource: "AppIdentity", resource_id: identity.id,
      metadata: { channel: "slack", agent: agent.name, app_user_id: linkedUser.id, greeting_delivered: !!sent.ok }, meta,
    });
    return { ok: true, linked: true, agent: agent.name, greeting_delivered: !!sent.ok, delivery_error: sent.ok ? null : sent.error };
  }

  // 7. Regular message — the owner is resolved from the identity row, never from the payload.
  //    P-9.11C: an UNLINKED chat of an agent that allows anonymous access gets a server-minted
  //    anonymous owner instead of the certified refusal; every other agent is unchanged.
  if (text.length > APP_AGENT_LIMITS.MAX_MESSAGE_CHARS) {
    fail(413, "AGENT_MESSAGE_TOO_LONG", `Message exceeds ${APP_AGENT_LIMITS.MAX_MESSAGE_CHARS} characters`);
  }
  let identity = await findIdentity(svc, project, "slack", slackUserId);
  let firstContact = false;
  if (!identity) {
    if (agent.allow_anonymous_access !== true) fail(403, "CHANNEL_NOT_LINKED", "This Slack account is not linked to an account yet");
    const ensured = await ensureAnonymousChannelIdentity(svc, { project, provider: "slack", subject: slackUserId, agent, meta });
    identity = ensured.identity;
    firstContact = ensured.created;
  }
  if (String(identity.profile?.agent || "") && identity.profile.agent !== agent.name) {
    fail(409, "CHANNEL_AGENT_MISMATCH", "This Slack account is linked to a different agent");
  }
  const owner = await getAppUser(svc, project, identity.app_user_id);
  if (!owner || owner.status !== "active") fail(403, "ACCOUNT_DISABLED", "This account is disabled");

  // 8. The EXISTING P-9.4 executor — model access, message credits and tool authorization are
  //    enforced inside it; no Slack relay charge exists (the certified Telegram/LINE precedent).
  const anonChat = isAnonymousUser(owner);
  const turnReplayKey = replayKey;
  const run = await runTurnReleasingReplay(svc, turnReplayKey, () => handleAppAgent(client, {
    project, payload, user: anonChat ? null : publicUser(owner), anonymous: anonChat ? { user: publicUser(owner) } : null, op: "invoke",
    args: { name: agent.name, message: text, idempotency_key: `slack:${dedupKey}` }, options,
  }));

  // 9. Outbound delivery — the provider's documented chat.postMessage. A channel mention
  //    replies in the mention's thread (documented: "replies in a thread"); the mention that
  //    started it anchors the thread when it is not already one.
  const threadTs = String(event.thread_ts || event.ts || "");
  if (firstContact) {
    const greeting = scrubText(`You are now connected to ${agent.display_name || agent.name}.`, 500);
    await slackApi(httpx, botToken, { path: "chat.postMessage", body: { channel, thread_ts: threadTs, text: greeting } }).catch(() => null);
  }
  const reply = scrubText(String(run.reply || ""), SLACK_OUTBOUND_MAX_CHARS);
  const sent = await deliverReplyOnce(svc, {
    sentKey: `slack_sent:${project.id}:${dedupKey}`, replayKey, namespace: "slack_sent", claim: claimDeliveryOnce,
    send: () => slackApi(httpx, botToken, { path: "chat.postMessage", body: { channel, thread_ts: threadTs, text: reply } }),
  });
  if (sent.already_sent) return { ok: true, duplicate: true, replayed: true, conversation_id: run.conversation_id, agent: agent.name, delivered: false, delivery_error: null };
  if (firstContact) {
    await recordAuthEvent(svc, project, {
      action: "channel_anonymous_greeting", resource: "AppIdentity", resource_id: identity.id,
      metadata: { channel: "slack", agent: agent.name, greeting_delivered: !!sent.ok }, meta,
    });
  }
  return {
    ok: true, conversation_id: run.conversation_id, agent: agent.name,
    delivered: !!sent.ok, delivery_error: sent.ok ? null : sent.error,
  };
}