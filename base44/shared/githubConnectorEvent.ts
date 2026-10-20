// GitHub connector-EVENT receiver — the ingestion half that was missing.
//
// The existing `githubWebhook` fn + `shared/githubWebhook.ts` verify a GitHub push delivery and
// enqueue a GitSync import. That path is UNCHANGED and still owns push→import. This module is a
// SEPARATE receiver that turns a verified GitHub delivery into a connector workflow dispatch
// through the existing `emitConnector` emitter — the call that had no caller.
//
// It reuses the EXISTING verified GitHub webhook primitives from `shared/githubWebhook.ts` and
// adds nothing cryptographic, nothing generic, and no second signature scheme:
//   • exact raw-body HMAC-SHA256 verification ......... verifyGithubSignature
//   • constant-time signature comparison .............. (inside verifyGithubSignature)
//   • x-github-delivery replay protection ............. claimDeliveryOnce
//   • x-github-event event type ....................... extractEventType
//   • encrypted ProjectSecret resolution .............. resolveWebhookSecret
//   • existing GitHub project/repository targeting ... GitHubWebhook row + GitHubLink
//
// Scope is deliberately narrow: only GitHub event types whose envelope/targeting can be handled
// from the existing verified contract — i.e. repo-scoped deliveries that carry
// `repository.full_name` (the ONE targeting field the existing contract exposes). Events without
// it are rejected as untargetable rather than guessed. No per-event-type schema is invented; the
// verified payload is passed through to `emitConnector` bounded by the engine's own context bound.
import {
  verifyGithubSignature, extractSignature, extractDeliveryId, extractEventType,
  resolveWebhookSecret,
} from "./githubWebhook.ts";
import { ingestConnectorDelivery } from "./managedConnectorIngest.ts";
import { audit } from "./authz.ts";

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);

// GitHub webhook payloads are repo-scoped: every repository event carries a `repository` object
// with `full_name`. That is the ONLY targeting field the existing verified contract exposes, so
// it is the only one enforced. Org-level deliveries (no repository) are rejected as untargetable.
function repoOf(payload) {
  const name = payload?.repository?.full_name;
  return typeof name === "string" && name.trim() ? name : null;
}

/**
 * Core connector-event receiver logic, shared by the HTTP handler and the certification harness so
 * both exercise exactly the same code. Returns { status, body } — the handler wraps it in a
 * Response, the cert inspects it directly.
 *
 * Does NOT touch the import path. A push delivery here is emitted as a connector event; a push
 * delivery to the import endpoint still enqueues a GitSync run. The two endpoints are independent
 * delivery targets and never share a provider subscription (registration is out of scope).
 */
export async function handleGithubConnectorEvent(svc, { projectId, rawBody, headers, now = Date.now() }) {
  let project = null;
  let webhook = null;
  let deliveryId = null;

  const recordAudit = async (action, metadata) => {
    if (!project) return;
    await audit(svc, {
      workspace_id: project.workspace_id, project_id: project.id, user_id: null,
      action, resource: "GitHubConnectorEvent", resource_id: webhook?.id || null,
      metadata: { delivery_id: deliveryId, ...metadata },
    }).catch(() => {});
  };

  const reject = async (code, message, status = 401, extra = {}) => {
    await recordAudit("github.connector.rejected", { code, reason: trunc(message), ...extra });
    if (webhook) {
      await svc.entities.GitHubWebhook.update(webhook.id, {
        last_delivery_id: deliveryId || null,
        last_delivery_at: new Date().toISOString(),
        last_delivery_status: "rejected",
        last_error: trunc(message),
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return { status, body: { error: message, code } };
  };

  // 1. Resolve the project from the URL — never from the body.
  if (!projectId) return { status: 400, body: { error: "project_id query parameter is required" } };
  project = await svc.entities.Project.get(projectId).catch(() => null);
  if (!project) return { status: 404, body: { error: "Not found" } };

  deliveryId = extractDeliveryId(headers);
  const eventType = extractEventType(headers);
  const providedSig = extractSignature(headers);

  // 2. Find the active GitHubWebhook for this project — the SAME connected repo the existing
  //    import path uses. The connector receiver does NOT create a second connection record; it
  //    reuses the existing one for repo targeting and secret resolution.
  const webhooks = await svc.entities.GitHubWebhook.filter({ project_id: project.id, active: true }, "-created_date", 5);
  webhook = webhooks[0] || null;
  if (!webhook) {
    return reject("WEBHOOK_NOT_FOUND", "This project has no active GitHub webhook.", 404);
  }

  // 3. Verify the HMAC signature against the exact raw body (existing primitive). Missing and
  //    wrong are the same refusal; verified BEFORE any parsing, limiter or charge.
  let secret;
  try {
    secret = await resolveWebhookSecret(svc, project.id);
  } catch (e) {
    return reject(e.code || "WEBHOOK_SECRET_NOT_CONFIGURED", e.message, 503);
  }
  try {
    await verifyGithubSignature(secret, rawBody, providedSig);
  } catch (e) {
    return reject(e.code, e.message, 401);
  }

  // 4. Delivery id is required — it is the replay key AND the connector idempotency key.
  if (!deliveryId) {
    return reject("WEBHOOK_DELIVERY_ID_MISSING", "The webhook delivery has no delivery id header.", 400);
  }

  // 5. Event type is required — it is the connector `event` field.
  if (!eventType) {
    return reject("WEBHOOK_EVENT_MISSING", "The webhook delivery has no event type header.", 400);
  }

  // 6. Parse the payload (after signature verification, so malformed JSON is safe).
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reject("WEBHOOK_MALFORMED_PAYLOAD", "The webhook body is not valid JSON.", 400);
  }

  // 7. Repo targeting — the ONLY targeting field the existing verified contract exposes.
  const repo = repoOf(payload);
  if (!repo) {
    return reject("WEBHOOK_REPO_UNTARGETABLE", "The event payload has no repository.full_name and cannot be targeted.", 400);
  }
  if (repo !== webhook.repo_full_name) {
    return reject("WEBHOOK_REPO_MISMATCH", `The event is for ${repo}, but this webhook watches ${webhook.repo_full_name}.`, 403, { event_repo: repo });
  }

  // 8. Resolve the connected GitHub account — the existing GitHubLink the webhook belongs to.
  //    A disconnected link means the connector account is no longer connected; the receiver
  //    refuses rather than dispatching a workflow against a stale connection.
  const link = await svc.entities.GitHubLink.get(webhook.github_link_id).catch(() => null);
  if (!link || link.status === "disconnected") {
    return reject("WEBHOOK_LINK_INACTIVE", "The GitHub repository link for this webhook is disconnected.", 428);
  }

  // 9–11. Replay protection + dispatch through the shared managed-connector ingestion core.
  //    The core owns dedup (existing claimDeliveryOnce; replay_key is the raw x-github-delivery id,
  //    exactly the previous inline key, so prior dedup behavior is preserved) and dispatch (existing
  //    emitConnector, provider-native x-github-event preserved verbatim). Verification, repo
  //    targeting and link checks above are unchanged. A core rejection (envelope/catalog) is
  //    surfaced through the same reject() path so the receiver's audit + error contract is unchanged.
  const ingested = await ingestConnectorDelivery(svc, {
    project, connector: "github", event: eventType, delivery_id: deliveryId, payload,
    replay_key: deliveryId, trace_id: `github-connector:${deliveryId}`, now,
  });
  if (!ingested.ok) {
    return reject(ingested.code, ingested.error || "the delivery was rejected", ingested.status || 400, { event_type: eventType });
  }
  if (ingested.duplicate) {
    await recordAudit("github.connector.replayed", { event_type: eventType, repo });
    return { status: 200, body: { ok: true, duplicate: true, delivery_id: deliveryId } };
  }

  // Update the webhook record with delivery info.
  await svc.entities.GitHubWebhook.update(webhook.id, {
    last_delivery_id: deliveryId, last_delivery_at: new Date().toISOString(),
    last_delivery_status: "accepted", last_error: null, updated_at: new Date().toISOString(),
  }).catch(() => {});

  await recordAudit("github.connector.received", { event_type: eventType, repo, matched: ingested.matched });

  return { status: 202, body: { ok: true, event: eventType, delivery_id: deliveryId, matched: ingested.matched } };
}