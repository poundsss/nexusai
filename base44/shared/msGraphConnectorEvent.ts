// Microsoft Graph connector-EVENT receiver — the INGRESS half, mirroring the certified
// GitHub/Slack connector-event receivers (`shared/githubConnectorEvent.ts`,
// `shared/slackConnectorEvent.ts`) in shape. It turns a verified Microsoft Graph change
// notification into a connector workflow dispatch through the EXISTING `emitConnector` — the
// certified dispatch path, unchanged.
//
// Phase 1: BASIC notifications only (clientState is the sole per-notification authenticity
// check). Rich notifications (validationTokens[] JWT / JWKS / encryptedContent) are deliberately
// NOT implemented.
//
// It reuses the EXISTING infrastructure and adds nothing cryptographic or generic:
//   • validationToken handshake — Graph's documented plain-text echo (URL-decoded), text/plain,
//     no JSON parsing, no dispatch.
//   • clientState validation ..... constantTimeEqual (reused) vs MS_GRAPH_CLIENT_STATE ProjectSecret
//     (decrypted only here, server-side).
//   • subscription targeting ...... subscriptionId resolved through GraphSubscription (created by
//     msGraphSubscriptions.ts). subscriptionId is AUTHORITATIVE; tenantId is never used for
//     project targeting. Unknown / inactive / expired / deleted subscriptions are rejected.
//   • replay protection ........... claimDeliveryOnce (reused) keyed by a synthesized
//     msgraph:<subId>:<changeType>:<resource>[:<resId>] delivery id (Graph has no native
//     per-notification id; the synthesized key is also the emitConnector idempotency key).
//   • lifecycle notifications ..... reauthorizationRequired / missed are handled WITHOUT dispatch
//     (reauthorizationRequired triggers an inline renewal best-effort; missed is audited only).
//   • dispatch .................... emitConnector(connector, event=changeType, payload, delivery_id).
//   • audit/trace ................. the EXISTING audit() path.
import { decryptSecretValue } from "./secretCrypto.ts";
import { constantTimeEqual, claimDeliveryOnce } from "./githubWebhook.ts";
import { consume } from "./apiLimits.ts";
import { audit } from "./authz.ts";
import { emitConnector } from "./workflowTriggers.ts";
import { fail, nowIso } from "./appAuth.ts";
import { MS_GRAPH_CLIENT_STATE_SECRET, graphHttp, renewGraphSubscription, DEFAULT_RENEWAL_EXTENSION_MS } from "./msGraphSubscriptions.ts";

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);
const svcOf = (client) => client.asServiceRole || client;
const clientIp = (headers) => String(headers["x-forwarded-for"] || headers["x-real-ip"] || "unknown").split(",")[0].trim();

/** The project's clientState secret, decrypted at verification time. Fail-closed if absent. */
export async function resolveClientState(client, projectId) {
  const svc = svcOf(client);
  const row = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: MS_GRAPH_CLIENT_STATE_SECRET }, "name", 1))[0] || null;
  if (!row?.value) {
    throw Object.assign(new Error(`This project has no ${MS_GRAPH_CLIENT_STATE_SECRET} configured, so Graph notifications cannot be verified.`), { code: "MS_GRAPH_CLIENT_STATE_NOT_CONFIGURED", status: 503 });
  }
  return decryptSecretValue(projectId, MS_GRAPH_CLIENT_STATE_SECRET, row.value);
}

/** Resolve an ACTIVE GraphSubscription by subscriptionId. Inactive/expired/deleted → null. */
export async function resolveGraphSubscription(svc, subscriptionId) {
  if (!subscriptionId) return null;
  const rows = await svc.entities.GraphSubscription.filter({ subscription_id: String(subscriptionId), status: "active" }, "-created_date", 5).catch(() => []);
  return rows[0] || null;
}

/**
 * Core Graph connector-event receiver logic, shared by the HTTP handler and the certification
 * harness so both exercise exactly the same code. Returns { status, body, contentType } —
 * contentType "text/plain" for the validation handshake, JSON otherwise.
 */
export async function handleMsGraphConnectorEvent(client, { projectId, rawBody, headers, validationToken, now = Date.now(), http = graphHttp }) {
  const svc = svcOf(client);
  let project = null;

  const recordAudit = async (action, metadata) => {
    if (!project) return;
    await audit(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: null,
      action, resource: "GraphSubscription", resource_id: null,
      metadata: metadata || {},
    }).catch(() => {});
  };

  // 1. Resolve the project from the URL — never from the body.
  if (!projectId) return { status: 400, body: { error: "project_id query parameter is required" } };
  project = await svc.entities.Project.get(projectId).catch(() => null);
  if (!project) return { status: 404, body: { error: "Not found" } };

  // 2. Rate limit before any expensive verification (existing durable limiter).
  const ip = clientIp(headers);
  const limit = await consume(svc, {
    identity: `msgraph_connector:${project.id}:ip:${ip}`, action: "channel_webhook",
    workspace_id: project.workspace_id, now,
  });
  if (!limit.allowed) {
    return { status: 429, body: { error: "Too many Graph notifications for this project.", code: "RATE_LIMITED", reset_at: limit.reset_at } };
  }

  // 3. validationToken handshake — Graph's documented plain-text echo. The token arrives in the
  //    query string (URL-encoded) and the body is text/plain; the endpoint must respond within 10s
  //    with text/plain and the URL-decoded token. NO JSON parsing, NO dispatch, NO project lookup
  //    beyond the rate limit above. Also tolerate a text/plain body (no query token) as a fallback.
  if (validationToken) {
    const token = decodeURIComponent(String(validationToken));
    await recordAudit("msgraph.validation_handshake", { via: "query" });
    return { status: 200, body: token, contentType: "text/plain" };
  }
  const ct = String(headers["content-type"] || "").toLowerCase();
  if (ct.startsWith("text/plain") && rawBody && !String(rawBody).trim().startsWith("{")) {
    await recordAudit("msgraph.validation_handshake", { via: "body" });
    return { status: 200, body: String(rawBody), contentType: "text/plain" };
  }

  // 4. Parse the notification envelope (after handshake detection, so a plain-text body never
  //    reaches JSON.parse).
  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    await recordAudit("msgraph.rejected", { code: "MALFORMED_PAYLOAD" });
    return { status: 400, body: { error: "The Graph body is not valid JSON.", code: "MALFORMED_PAYLOAD" } };
  }
  const entries = Array.isArray(envelope?.value) ? envelope.value : [];
  if (!entries.length) return { status: 202, body: { ok: true, ignored: true, processed: 0 } };

  // 5. Resolve the clientState secret ONCE for this project (fail-closed if absent).
  let clientStateSecret;
  try {
    clientStateSecret = await resolveClientState(svc, project.id);
  } catch (e) {
    await recordAudit("msgraph.rejected", { code: e.code || "CLIENT_STATE_NOT_CONFIGURED" });
    return { status: 503, body: { error: e.message, code: e.code || "CLIENT_STATE_NOT_CONFIGURED" } };
  }

  const processed = [];
  for (const entry of entries) {
    const subscriptionId = String(entry?.subscriptionId || "").trim();
    const changeType = String(entry?.changeType || "").trim();
    const lifecycleEvent = String(entry?.lifecycleEvent || "").trim();
    const resource = String(entry?.resource || "").trim();
    const providedState = String(entry?.clientState || "");
    const tenantId = String(entry?.tenantId || "").trim();

    // 6. Lifecycle notification — changeType "lifecycleNotification" (or a lifecycleEvent field).
    //    Handled WITHOUT workflow dispatch. reauthorizationRequired triggers an inline renewal
    //    (best-effort); missed is audited only.
    if (changeType === "lifecycleNotification" || lifecycleEvent) {
      if (!constantTimeEqual(providedState, clientStateSecret)) {
        await recordAudit("msgraph.lifecycle.rejected", { code: "CLIENT_STATE_INVALID", subscription_id: subscriptionId, lifecycle_event: lifecycleEvent });
        processed.push({ subscription_id: subscriptionId, lifecycle: lifecycleEvent, rejected: "clientState" });
        continue;
      }
      const sub = await resolveGraphSubscription(svc, subscriptionId).catch(() => null);
      if (sub && sub.project_id !== project.id) {
        await recordAudit("msgraph.lifecycle.rejected", { code: "SUBSCRIPTION_PROJECT_MISMATCH", subscription_id: subscriptionId });
        processed.push({ subscription_id: subscriptionId, lifecycle: lifecycleEvent, rejected: "project_mismatch" });
        continue;
      }
      if (sub && lifecycleEvent === "reauthorizationRequired") {
        try {
          const newExp = new Date(Date.now() + DEFAULT_RENEWAL_EXTENSION_MS).toISOString();
          await renewGraphSubscription(svc, { subscriptionId, expirationDateTime: newExp, http, meta: {} });
          await recordAudit("msgraph.lifecycle.renewed", { subscription_id: subscriptionId, lifecycle_event: lifecycleEvent });
        } catch (e) {
          await recordAudit("msgraph.lifecycle.renew_failed", { subscription_id: subscriptionId, lifecycle_event: lifecycleEvent, code: e.code || "RENEW_FAILED", reason: trunc(e.message) });
        }
      } else {
        await recordAudit("msgraph.lifecycle.received", { subscription_id: subscriptionId, lifecycle_event: lifecycleEvent });
      }
      processed.push({ subscription_id: subscriptionId, lifecycle: lifecycleEvent, dispatched: false });
      continue;
    }

    // 7. Regular basic notification — clientState is the sole per-notification authenticity check.
    if (!constantTimeEqual(providedState, clientStateSecret)) {
      await recordAudit("msgraph.rejected", { code: "CLIENT_STATE_INVALID", subscription_id: subscriptionId, change_type: changeType });
      processed.push({ subscription_id: subscriptionId, change_type: changeType, rejected: "clientState" });
      continue;
    }

    // 8. Resolve the subscription through GraphSubscription (subscriptionId authoritative).
    const sub = await resolveGraphSubscription(svc, subscriptionId).catch(() => null);
    if (!sub) {
      await recordAudit("msgraph.rejected", { code: "SUBSCRIPTION_NOT_FOUND", subscription_id: subscriptionId, change_type: changeType });
      processed.push({ subscription_id: subscriptionId, change_type: changeType, rejected: "unknown_or_inactive" });
      continue;
    }
    if (sub.project_id !== project.id) {
      await recordAudit("msgraph.rejected", { code: "SUBSCRIPTION_PROJECT_MISMATCH", subscription_id: subscriptionId, change_type: changeType });
      processed.push({ subscription_id: subscriptionId, change_type: changeType, rejected: "project_mismatch" });
      continue;
    }

    // 9. Replay protection — Graph has no native per-notification id, so synthesize a stable key
    //    from subscriptionId + changeType + resource (+ resourceData.id when present). The same
    //    key is the emitConnector delivery_id, so a redelivery resolves to the FIRST run.
    const resId = entry?.resourceData?.id ? String(entry.resourceData.id) : "";
    const deliveryId = `msgraph:${subscriptionId}:${changeType}:${resource}${resId ? `:${resId}` : ""}`;
    const claimed = await claimDeliveryOnce(svc, { projectId: project.id, deliveryId, now });
    if (!claimed) {
      await recordAudit("msgraph.replayed", { subscription_id: subscriptionId, change_type: changeType, delivery_id: deliveryId });
      processed.push({ subscription_id: subscriptionId, change_type: changeType, duplicate: true });
      continue;
    }

    // 10. Dispatch through the certified emitConnector. Provider-native changeType is preserved
    //     as the event name; subscription/resource metadata travels in the bounded payload.
    //     clientState is NEVER included in the payload.
    const payload = {
      subscriptionId, changeType, resource, tenantId,
      resourceData: entry?.resourceData || null,
      subscriptionExpirationDateTime: entry?.subscriptionExpirationDateTime || null,
    };
    const result = await emitConnector(svc, {
      project, workspace_id: project.workspace_id,
      connector: sub.connector, event: changeType, payload, delivery_id: deliveryId,
      trace_id: `msgraph-connector:${deliveryId}`,
    });

    await recordAudit("msgraph.received", { subscription_id: subscriptionId, change_type: changeType, connector: sub.connector, matched: result?.matched ?? 0 });
    processed.push({ subscription_id: subscriptionId, change_type: changeType, connector: sub.connector, matched: result?.matched ?? 0 });
  }

  return { status: 202, body: { ok: true, processed: entries.length, results: processed } };
}