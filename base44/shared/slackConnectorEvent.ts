// Slack connector-EVENT receiver — the ingestion half for Slack, mirroring the certified
// GitHub connector-event receiver (`shared/githubConnectorEvent.ts`).
//
// This is a SEPARATE receiver from any Slack channel the in-app agent runtime may use. It turns
// a verified Slack Events API delivery into a connector workflow dispatch through the EXISTING
// `emitConnector` emitter — the same call the GitHub receiver uses. It adds nothing
// cryptographic, nothing generic, and no second dispatch system:
//   • exact raw-body HMAC-SHA256 verification (Slack's v0 signature) ... constantTimeEqual
//   • timestamp freshness (Slack's documented 5-minute window) ........... compared before HMAC cost
//   • event_id replay protection ......................................... claimDeliveryOnce (reused)
//   • url_verification handshake ......................................... echoed, not dispatched
//   • existing Slack connection resolution ............................... DelegatedCredential
//     (provider_id "slack", external_subject = team_id, status active) — the existing
//     per-project connector credential contract. No new entity.
//   • signing secret ..................................................... ProjectSecret
//     SLACK_SIGNING_SECRET, decrypted only here at verification time.
//
// Scope is deliberately narrow: only Slack's documented Events API contract is handled. The
// provider-native event name (payload.event.type) is passed through to `emitConnector` as
// `event` — NO Base44 event normalization is invented. The verified payload is bounded by the
// engine's own context bound. Subscription management (creating/rotating the Slack subscription)
// is out of scope for this module.
import { decryptSecretValue } from "./secretCrypto.ts";
import { constantTimeEqual } from "./githubWebhook.ts";
import { consume } from "./apiLimits.ts";
import { audit } from "./authz.ts";
import { ingestConnectorDelivery } from "./managedConnectorIngest.ts";

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);

export const SLACK_SIGNING_SECRET_NAME = "SLACK_SIGNING_SECRET";
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
// Slack's documented freshness window: reject deliveries whose timestamp is more than 5 minutes
// from the server clock (https://api.slack.com/authentication/verifying-requests-from-slack).
export const SLACK_STALE_WINDOW_SEC = 300;

const svcOf = (client) => client.asServiceRole || client;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const clientIp = (headers) => String(headers["x-forwarded-for"] || headers["x-real-ip"] || "unknown").split(",")[0].trim();

// Slack's signature: HMAC-SHA256(signing_secret, `v0:<timestamp>:<raw_body>`) prefixed with "v0=".
// This is the exact computation Slack performs over the EXACT received bytes.
export async function computeSlackSignature(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${String(timestamp)}:${rawBody ?? ""}`));
  return `v0=${hex(mac)}`;
}

// The project's Slack signing secret, decrypted at the point of verification. A project with no
// secret configured cannot receive deliveries — the receiver refuses rather than accepting
// unsigned/unverifiable requests.
export async function resolveSlackSigningSecret(client, projectId) {
  const svc = svcOf(client);
  const row = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: SLACK_SIGNING_SECRET_NAME }, "name", 1))[0] || null;
  if (!row?.value) {
    throw Object.assign(new Error(`This project has no ${SLACK_SIGNING_SECRET_NAME} configured, so Slack deliveries cannot be verified.`), { code: "SLACK_SIGNING_SECRET_NOT_CONFIGURED", status: 503 });
  }
  return decryptSecretValue(projectId, SLACK_SIGNING_SECRET_NAME, row.value);
}

/**
 * Resolve the existing Slack connection for this project + team. Reuses the existing
 * DelegatedCredential contract (provider_id "slack", external_subject = team_id, status active)
 * as the per-project connection record — no new entity. A team with no active credential is
 * treated as "not connected" and the delivery is refused.
 */
export async function resolveSlackConnection(svc, projectId, teamId) {
  if (!teamId) return null;
  const rows = await svc.entities.DelegatedCredential.filter(
    { project_id: projectId, provider_id: "slack", external_subject: teamId, status: "active" },
    "-created_date", 5,
  ).catch(() => []);
  return rows[0] || null;
}

/**
 * Core Slack connector-event receiver logic, shared by the HTTP handler and the certification
 * harness so both exercise exactly the same code. Returns { status, body } — the handler wraps
 * it in a Response, the cert inspects it directly.
 */
export async function handleSlackConnectorEvent(client, { projectId, rawBody, headers, now = Date.now() }) {
  const svc = svcOf(client);
  let project = null;
  let deliveryId = null;

  const recordAudit = async (action, metadata) => {
    if (!project) return;
    await audit(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: null,
      action, resource: "SlackConnectorEvent", resource_id: null,
      metadata: { delivery_id: deliveryId, ...metadata },
    }).catch(() => {});
  };

  const reject = async (code, message, status = 401, extra = {}) => {
    await recordAudit("slack.connector.rejected", { code, reason: trunc(message), ...extra });
    return { status, body: { error: message, code } };
  };

  // 1. Resolve the project from the URL — never from the body.
  if (!projectId) return { status: 400, body: { error: "project_id query parameter is required" } };
  project = await svc.entities.Project.get(projectId).catch(() => null);
  if (!project) return { status: 404, body: { error: "Not found" } };

  // 2. Rate limit before any expensive verification (existing durable limiter).
  const ip = clientIp(headers);
  const limit = await consume(svc, {
    identity: `slack_connector:${project.id}:ip:${ip}`, action: "channel_webhook",
    workspace_id: project.workspace_id, now,
  });
  if (!limit.allowed) {
    return reject("RATE_LIMITED", `Too many Slack deliveries for this project. Retry after ${limit.reset_at}.`, 429);
  }

  const providedSig = String(headers[SLACK_SIGNATURE_HEADER] || headers[SLACK_SIGNATURE_HEADER.toLowerCase()] || "").trim();
  const timestamp = String(headers[SLACK_TIMESTAMP_HEADER] || headers[SLACK_TIMESTAMP_HEADER.toLowerCase()] || "").trim();

  // 3. Signature + timestamp headers are both required.
  if (!providedSig || !timestamp) {
    return reject("SLACK_SIGNATURE_MISSING", `Both ${SLACK_SIGNATURE_HEADER} and ${SLACK_TIMESTAMP_HEADER} headers are required.`, 401);
  }

  // 4. Freshness — Slack's documented 5-minute window. Checked before the HMAC, since a stale
  //    request is refused either way.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return reject("SLACK_TIMESTAMP_MALFORMED", "The Slack request timestamp is malformed.", 401);
  }
  if (Math.abs(Math.floor(now / 1000) - ts) > SLACK_STALE_WINDOW_SEC) {
    return reject("SLACK_TIMESTAMP_STALE", `The Slack request timestamp is outside the ${SLACK_STALE_WINDOW_SEC}s delivery window.`, 401);
  }

  // 5. Verify the HMAC signature over the exact received bytes (existing constant-time compare).
  let secret;
  try {
    secret = await resolveSlackSigningSecret(svc, project.id);
  } catch (e) {
    return reject(e.code || "SLACK_SIGNING_SECRET_NOT_CONFIGURED", e.message, 503);
  }
  const expected = await computeSlackSignature(secret, timestamp, rawBody ?? "");
  if (!constantTimeEqual(providedSig, expected)) {
    return reject("SLACK_SIGNATURE_INVALID", "The Slack signature does not match the request body.", 401);
  }

  // 6. Parse the payload (after signature verification, so malformed JSON is safe).
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reject("SLACK_MALFORMED_PAYLOAD", "The Slack body is not valid JSON.", 400);
  }

  // 7. URL/event verification handshake — Slack's one-time `url_verification` delivery. Echo the
  //    challenge, do NOT dispatch, do NOT claim replay. The signature was already verified above.
  if (payload?.type === "url_verification") {
    await recordAudit("slack.connector.url_verification", { challenge: trunc(payload?.challenge) });
    return { status: 200, body: { challenge: String(payload?.challenge || "") } };
  }

  // 8. Extract event_id (replay key + connector idempotency key), event.type (native event name),
  //    and team_id (connection targeting).
  const eventId = String(payload?.event_id || "").trim();
  const eventType = String(payload?.event?.type || "").trim();
  const teamId = String(payload?.team_id || "").trim();
  deliveryId = eventId;

  if (!eventId) {
    return reject("SLACK_DELIVERY_ID_MISSING", "The Slack event has no event_id.", 400);
  }
  if (!eventType) {
    return reject("SLACK_EVENT_TYPE_MISSING", "The Slack event has no event.type.", 400);
  }
  if (!teamId) {
    return reject("SLACK_TEAM_MISSING", "The Slack event has no team_id.", 400);
  }

  // 9. Resolve the existing Slack connection for this project/team. Missing → fail closed.
  const connection = await resolveSlackConnection(svc, project.id, teamId);
  if (!connection) {
    return reject("SLACK_CONNECTION_NOT_FOUND", `No active Slack connection for team ${teamId} on this project.`, 404, { team_id: teamId });
  }

  // 10–11. Replay protection + dispatch through the shared managed-connector ingestion core.
  //    The core owns dedup (existing claimDeliveryOnce; the default replay key `slack:<event_id>`
  //    is exactly the previous inline key, so prior dedup behavior is preserved) and dispatch
  //    (existing emitConnector, provider-native event.type preserved verbatim). The
  //    provider-specific verification, url_verification handshake and connection targeting above
  //    are unchanged. A core rejection (envelope/catalog) is surfaced through the same reject()
  //    path so the receiver's audit + error contract is unchanged.
  const ingested = await ingestConnectorDelivery(svc, {
    project, connector: "slack", event: eventType, delivery_id: eventId, payload,
    trace_id: `slack-connector:${eventId}`, now,
  });
  if (!ingested.ok) {
    return reject(ingested.code, ingested.error || "the delivery was rejected", ingested.status || 400, { event_type: eventType });
  }
  if (ingested.duplicate) {
    await recordAudit("slack.connector.replayed", { event_type: eventType, team_id: teamId });
    return { status: 200, body: { ok: true, duplicate: true, delivery_id: eventId } };
  }

  await recordAudit("slack.connector.received", { event_type: eventType, team_id: teamId, matched: ingested.matched });

  return { status: 202, body: { ok: true, event: eventType, delivery_id: eventId, matched: ingested.matched } };
}