// Google Calendar / Drive connector-EVENT receiver — the INGRESS half, mirroring the certified
// GitHub/Slack/Microsoft-Graph connector-event receivers in shape. It turns a verified Google
// web_hook push notification into a connector workflow dispatch through the EXISTING
// `emitConnector` — the certified dispatch path, unchanged.
//
// Phase 1: Calendar + Drive only (Gmail/Pub/Sub deliberately NOT implemented).
//
// Google contract (verified against Google docs): Calendar/Drive push is a DIRECT HTTPS POST to
// the watch `address` with an EMPTY body and ALL metadata in X-Goog-* headers. There is NO
// validation handshake (unlike Microsoft Graph) and NO HMAC (unlike GitHub). The SOLE
// authenticity check is the `X-Goog-Channel-Token` the app set on the watch and Google echoes
// back, compared in constant time against the project's GOOGLE_CHANNEL_TOKEN ProjectSecret.
//
// It reuses the EXISTING infrastructure and adds nothing cryptographic or generic:
//   • project resolution ... from ?project_id= (never from the body — there is no body).
//   • rate limit ........... the existing durable consume() (action channel_webhook).
//   • token validation ..... constantTimeEqual (reused) vs GOOGLE_CHANNEL_TOKEN ProjectSecret.
//   • channel targeting .... X-Goog-Channel-ID resolved through GoogleWatchChannel (created by
//     googleWatchSubscriptions.ts). X-Goog-Channel-ID is AUTHORITATIVE; the row's project_id is
//     re-checked against the URL project. Unknown / expired / deleted channels are rejected.
//   • sync message .......... X-Goog-Resource-State === "sync" → no dispatch (channel creation ack).
//   • replay protection ..... claimDeliveryOnce (reused) keyed by google:<channelId>:<messageNumber>
//     (Google's X-Goog-Message-Number is unique per channel; also the emitConnector idempotency key).
//   • dispatch .............. emitConnector(connector=provider, event=normalized, payload,
//     delivery_id). The provider-native X-Goog-Resource-State is NORMALIZED to the
//     Base44-compatible workflow event before dispatch (Calendar exists/not_exists → "events";
//     Drive change → "changes", add → "file", update/trash/untrash/remove → the DOCUMENTED
//     file-scoped file.update/file.trash/file.untrash/file.delete) and preserved verbatim
//     in the payload as resourceState; an unmapped state passes through verbatim (existing
//     handling). Drive's X-Goog-Changed is preserved in the bounded payload when present. The
//     token is NEVER included in the payload.
//   • audit/trace ........... the existing audit() path.
import { decryptSecretValue } from "./secretCrypto.ts";
import { constantTimeEqual, claimDeliveryOnce } from "./githubWebhook.ts";
import { consume } from "./apiLimits.ts";
import { audit } from "./authz.ts";
import { emitConnector } from "./workflowTriggers.ts";
import { GOOGLE_CHANNEL_TOKEN_SECRET } from "./googleWatchSubscriptions.ts";

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);
const svcOf = (client) => client.asServiceRole || client;
const clientIp = (headers) => String(headers["x-forwarded-for"] || headers["x-real-ip"] || "unknown").split(",")[0].trim();

const SYNC = "sync";

// Base44-compatible workflow-event normalization for the Google channel receiver. Google delivers
// a provider-native X-Goog-Resource-State; the event the WORKFLOW engine matches on is the
// Base44-compatible name. Normalization changes ONLY the matching key — the provider state always
// stays in the dispatched payload (resourceState). An unmapped state returns null and keeps the
// previous verbatim pass-through (existing provider handling preserved).
const GOOGLE_EVENT_NORMALIZATION = {
  googlecalendar: { exists: "events", not_exists: "events" },
  // DOCUMENTED (Base44) googledrive events: "changes" (the change feed), "file" (any change to a
  // file), and the file-scoped file.update / file.trash / file.untrash / file.delete. Drive's
  // "add" state has no documented scoped name, so it keeps the generic "file" event. No other
  // Drive event names are invented.
  googledrive: { change: "changes", add: "file", update: "file.update", remove: "file.delete", trash: "file.trash", untrash: "file.untrash" },
};

export function normalizeGoogleConnectorEvent(provider, resourceState) {
  return GOOGLE_EVENT_NORMALIZATION[provider]?.[resourceState] ?? null;
}

/** The project's channel-token secret, decrypted at verification time. Fail-closed if absent. */
export async function resolveChannelToken(client, projectId) {
  const svc = svcOf(client);
  const row = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: GOOGLE_CHANNEL_TOKEN_SECRET }, "name", 1))[0] || null;
  if (!row?.value) {
    throw Object.assign(new Error(`This project has no ${GOOGLE_CHANNEL_TOKEN_SECRET} configured, so Google push notifications cannot be verified.`), { code: "GOOGLE_CHANNEL_TOKEN_NOT_CONFIGURED", status: 503 });
  }
  return decryptSecretValue(projectId, GOOGLE_CHANNEL_TOKEN_SECRET, row.value);
}

/**
 * Resolve a channel row by X-Goog-Channel-ID (any status), so the receiver can distinguish
 * unknown / inactive / deleted / project-mismatch with explicit rejection reasons.
 */
export async function resolveGoogleWatchChannel(svc, channelId) {
  if (!channelId) return null;
  const rows = await svc.entities.GoogleWatchChannel.filter({ channel_id: String(channelId) }, "-created_date", 5).catch(() => []);
  return rows[0] || null;
}

/**
 * Core Google Calendar/Drive connector-event receiver logic, shared by the HTTP handler and the
 * certification harness so both exercise exactly the same code. Returns { status, body } (JSON).
 * The body is intentionally ignored — Calendar/Drive notifications carry an empty body with all
 * metadata in X-Goog-* headers.
 */
export async function handleGoogleChannelConnectorEvent(client, { projectId, headers, now = Date.now() }) {
  const svc = svcOf(client);
  let project = null;

  const recordAudit = async (action, metadata) => {
    if (!project) return;
    await audit(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: null,
      action, resource: "GoogleWatchChannel", resource_id: null,
      metadata: metadata || {},
    }).catch(() => {});
  };

  // 1. Resolve the project from the URL — never from the body (there is no body).
  if (!projectId) return { status: 400, body: { error: "project_id query parameter is required" } };
  project = await svc.entities.Project.get(projectId).catch(() => null);
  if (!project) return { status: 404, body: { error: "Not found" } };

  // 2. Rate limit before any expensive verification (existing durable limiter).
  const ip = clientIp(headers);
  const limit = await consume(svc, {
    identity: `google_connector:${project.id}:ip:${ip}`, action: "channel_webhook",
    workspace_id: project.workspace_id, now,
  });
  if (!limit.allowed) {
    return { status: 429, body: { error: "Too many Google notifications for this project.", code: "RATE_LIMITED", reset_at: limit.reset_at } };
  }

  // 3. Parse X-Goog-* headers (case-insensitive — the wrapper lowercases keys).
  const channelId = String(headers["x-goog-channel-id"] || "").trim();
  const resourceId = String(headers["x-goog-resource-id"] || "").trim();
  const resourceState = String(headers["x-goog-resource-state"] || "").trim();
  const messageNumber = String(headers["x-goog-message-number"] || "").trim();
  const resourceUri = String(headers["x-goog-resource-uri"] || "").trim();
  const channelToken = String(headers["x-goog-channel-token"] || "").trim();
  const changed = String(headers["x-goog-changed"] || "").trim();

  if (!channelId || !resourceState) {
    await recordAudit("google.rejected", { code: "MISSING_HEADERS", channel_id: channelId, resource_state: resourceState });
    return { status: 400, body: { error: "X-Goog-Channel-ID and X-Goog-Resource-State headers are required.", code: "MISSING_HEADERS" } };
  }

  // 4. Resolve the channel-token secret ONCE for this project (fail-closed if absent).
  let tokenSecret;
  try {
    tokenSecret = await resolveChannelToken(svc, project.id);
  } catch (e) {
    await recordAudit("google.rejected", { code: e.code || "CHANNEL_TOKEN_NOT_CONFIGURED", channel_id: channelId });
    return { status: 503, body: { error: e.message, code: e.code || "CHANNEL_TOKEN_NOT_CONFIGURED" } };
  }

  // 5. Channel-token validation — the SOLE authenticity check (Google sends no HMAC).
  if (!channelToken || !constantTimeEqual(channelToken, tokenSecret)) {
    await recordAudit("google.rejected", { code: "CHANNEL_TOKEN_INVALID", channel_id: channelId, resource_state: resourceState });
    return { status: 200, body: { ok: true, rejected: "channel_token", channel_id: channelId } };
  }

  // 6. Resolve the channel row by X-Goog-Channel-ID (any status) for explicit rejection reasons.
  const channel = await resolveGoogleWatchChannel(svc, channelId);
  if (!channel) {
    await recordAudit("google.rejected", { code: "CHANNEL_UNKNOWN", channel_id: channelId, resource_state: resourceState });
    return { status: 200, body: { ok: true, rejected: "unknown_channel", channel_id: channelId } };
  }
  if (channel.project_id !== project.id) {
    await recordAudit("google.rejected", { code: "CHANNEL_PROJECT_MISMATCH", channel_id: channelId, resource_state: resourceState });
    return { status: 200, body: { ok: true, rejected: "project_mismatch", channel_id: channelId } };
  }
  if (channel.status !== "active") {
    await recordAudit("google.rejected", { code: "CHANNEL_INACTIVE", channel_id: channelId, resource_state: resourceState, channel_status: channel.status });
    return { status: 200, body: { ok: true, rejected: "inactive_channel", channel_id: channelId, channel_status: channel.status } };
  }

  // 7. sync message — channel-creation ack. No dispatch, no replay claim.
  if (resourceState === SYNC) {
    await recordAudit("google.sync", { channel_id: channelId, message_number: messageNumber });
    return { status: 200, body: { ok: true, sync: true, channel_id: channelId } };
  }

  // 8. Replay protection — X-Goog-Message-Number is unique per channel; synthesize a stable key
  //    that is also the emitConnector delivery_id, so a redelivery resolves to the FIRST run.
  if (!messageNumber) {
    await recordAudit("google.rejected", { code: "MISSING_MESSAGE_NUMBER", channel_id: channelId, resource_state: resourceState });
    return { status: 200, body: { ok: true, rejected: "missing_message_number", channel_id: channelId } };
  }
  const deliveryId = `google:${channelId}:${messageNumber}`;
  const claimed = await claimDeliveryOnce(svc, { projectId: project.id, deliveryId, now });
  if (!claimed) {
    await recordAudit("google.replayed", { channel_id: channelId, resource_state: resourceState, delivery_id: deliveryId });
    return { status: 200, body: { ok: true, duplicate: true, channel_id: channelId, delivery_id: deliveryId } };
  }

  // 9. Dispatch through the certified emitConnector. The provider-native X-Goog-Resource-State is
  //    normalized to the Base44-compatible workflow event (normalizeGoogleConnectorEvent); an
  //    unmapped state passes through verbatim (existing handling). Channel/resource metadata +
  //    Drive's X-Goog-Changed travel in the bounded payload, with resourceState preserved so the
  //    provider state is never lost. The channel token is NEVER included in the payload.
  const payload = {
    channelId, resourceId, resourceUri, resourceState, messageNumber,
    ...(changed ? { changed } : {}),
  };
  const workflowEvent = normalizeGoogleConnectorEvent(channel.provider, resourceState);
  const result = await emitConnector(svc, {
    project, workspace_id: project.workspace_id,
    connector: channel.provider, event: workflowEvent || resourceState, payload, delivery_id: deliveryId,
    trace_id: `google-connector:${deliveryId}`,
  });

  await recordAudit("google.received", { channel_id: channelId, resource_state: resourceState, provider: channel.provider, workflow_event: workflowEvent || resourceState, matched: result?.matched ?? 0 });
  return {
    status: 200,
    body: { ok: true, channel_id: channelId, provider: channel.provider, resource_state: resourceState, ...(workflowEvent ? { workflow_event: workflowEvent } : {}), matched: result?.matched ?? 0 },
  };
}