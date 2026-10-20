// Microsoft Graph subscription management — the OUTBOUND half of the Graph connector-event
// integration. Mirrors nothing certified; it is NexusAI-native infrastructure required to make a
// Microsoft Graph change-notification subscription function, because Base44 publishes no Graph
// subscription lifecycle.
//
// This module REUSES the existing infrastructure and adds no second system:
//   • access token  — the EXISTING DelegatedCredential (#31G). The token is decrypted with the
//                     existing decryptWithAad (AAD = `delegated-credential:<project>:<credential_id>`)
//                     and refreshed through the EXISTING refreshDelegatedCredential when expired.
//                     No token value is ever logged, returned or stored outside DelegatedCredential.
//   • clientState   — an ordinary ProjectSecret (MS_GRAPH_CLIENT_STATE), encrypted at rest with
//                     the existing encryptSecretValue, decrypted only here at use time. One per
//                     project; reused across that project's subscriptions so rotating it does not
//                     break existing subscriptions' validation.
//   • secret crypto — the EXISTING secretCrypto (encryptSecretValue/decryptSecretValue and
//                     encryptWithAad/decryptWithAad), unchanged.
//   • audit         — the EXISTING audit() path.
//
// Scope is deliberately narrow: BASIC Graph subscriptions only (no includeResourceData, no
// encryptionCertificate, no rich-notification JWT). Subscription create / renew / delete and a
// renewal sweeper. No new OAuth flow, no new secret store, no new dispatch path — the INGRESS
// receiver (msGraphConnectorEvent.ts) dispatches through the certified emitConnector.
import { encryptSecretValue, decryptSecretValue, encryptWithAad, decryptWithAad } from "./secretCrypto.ts";
import { refreshDelegatedCredential } from "./delegatedOAuth.ts";
import { audit } from "./authz.ts";
import { fail, nowIso } from "./appAuth.ts";
import { scrubText } from "./tracing.ts";

export const MS_GRAPH_CLIENT_STATE_SECRET = "MS_GRAPH_CLIENT_STATE";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// Outlook / OneDrive subscriptions allow up to ~3 days; renew to just under that ceiling.
export const DEFAULT_RENEWAL_EXTENSION_MS = 3 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
export const DEFAULT_RENEWAL_LEAD_MS = 60 * 60 * 1000; // renew subscriptions expiring within 1h

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);
const svcOf = (client) => client.asServiceRole || client;
const aadFor = (projectId, credentialId) => `delegated-credential:${projectId}:${credentialId}`;
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Minimal HTTP client matching the shape delegatedOAuth expects ({ ok, status, headers, body })
 * and usable for Graph REST calls. The bearer token travels only in the Authorization header of
 * this server-side call; any error is scrubbed of it before it can reach a log or response.
 */
export async function graphHttp(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    body = options.body;
    if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  let res;
  try {
    res = await fetch(String(url), { method, headers, body });
  } catch (e) {
    return { ok: false, status: 0, headers: {}, body: { error: { message: String(e?.message || e) } } };
  }
  const text = await res.text();
  let parsed = text;
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) { try { parsed = JSON.parse(text); } catch { /* keep text */ } }
  return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed };
}

/** Resolves a ProjectSecret VALUE for this project (decrypted), or undefined. Server-side only. */
export function makeResolveSecret(svc, projectId) {
  return async (name) => {
    const row = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: String(name) }, "name", 1))[0] || null;
    if (!row?.value) return undefined;
    return decryptSecretValue(projectId, String(name), row.value);
  };
}

/** Store (or rotate) the per-project clientState as an encrypted ProjectSecret. */
export async function storeClientState(svc, projectId, value) {
  const sealed = await encryptSecretValue(projectId, MS_GRAPH_CLIENT_STATE_SECRET, value);
  const existing = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: MS_GRAPH_CLIENT_STATE_SECRET }, "name", 1))[0] || null;
  if (existing) return svc.entities.ProjectSecret.update(existing.id, { value: sealed });
  return svc.entities.ProjectSecret.create({ project_id: projectId, name: MS_GRAPH_CLIENT_STATE_SECRET, value: sealed, required: true });
}

/**
 * Returns the per-project clientState, generating + storing it on first use. Subsequent calls
 * REUSE the existing secret so existing subscriptions keep validating. The value is used only
 * in the server-side Graph POST body and never logged.
 */
export async function ensureClientState(svc, projectId) {
  const existing = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: MS_GRAPH_CLIENT_STATE_SECRET }, "name", 1))[0] || null;
  if (existing?.value) return decryptSecretValue(projectId, MS_GRAPH_CLIENT_STATE_SECRET, existing.value);
  const value = randomHex(32);
  await storeClientState(svc, projectId, value);
  return value;
}

async function loadDelegatedCredential(svc, projectId, credentialId) {
  const rows = await svc.entities.DelegatedCredential.filter({ project_id: projectId, credential_id: String(credentialId || "") }, "-created_date", 1).catch(() => []);
  return rows[0] || null;
}

async function loadGraphSubscription(svc, subscriptionId) {
  const rows = await svc.entities.GraphSubscription.filter({ subscription_id: String(subscriptionId || "") }, "-created_date", 5).catch(() => []);
  return rows[0] || null;
}

/**
 * Resolve a usable Graph access token for a delegated credential, server-side. Reuses the
 * EXISTING refreshDelegatedCredential when the token is expired — passing a synthetic user
 * satisfying the ownership check (the credential's own app_user_id), so the certified refresh
 * path is exercised unchanged. A revoked / refresh-failed credential fails closed.
 */
export async function resolveGraphAccessToken(svc, project, credentialId, { http = graphHttp, meta = {} } = {}) {
  const cred = await loadDelegatedCredential(svc, project.id, credentialId);
  if (!cred) fail(404, "DELEGATED_CREDENTIAL_NOT_FOUND", "The delegated credential for this Graph subscription was not found");
  if (cred.status === "revoked") fail(403, "DELEGATED_CREDENTIAL_REVOKED", "The delegated credential has been revoked");
  const expired = !cred.expires_at || Date.parse(cred.expires_at) <= Date.now() + 30000;
  if (expired) {
    if (!cred.encrypted_refresh_token) fail(403, "DELEGATED_CREDENTIAL_INACTIVE", "The delegated credential is expired and has no refresh token");
    // Synthetic user satisfies refreshDelegatedCredential's ownership check (cred.app_user_id).
    await refreshDelegatedCredential(svc, project, { id: cred.app_user_id }, credentialId, { resolveSecret: makeResolveSecret(svc, project.id), http }, meta);
  }
  const fresh = await loadDelegatedCredential(svc, project.id, credentialId);
  if (!fresh || fresh.status !== "active") fail(403, "DELEGATED_CREDENTIAL_INACTIVE", "The delegated credential is no longer active");
  if (!fresh.encrypted_access_token) fail(403, "DELEGATED_CREDENTIAL_INACTIVE", "The delegated credential has no access token");
  return decryptWithAad(aadFor(project.id, credentialId), fresh.encrypted_access_token);
}

/**
 * Create a Graph subscription. Resolves the delegated access token (refresh if needed), ensures
 * the per-project clientState, POSTs to /subscriptions, and persists the GraphSubscription row.
 * Fail-closed: a Graph failure throws BEFORE any row is written, so no orphaned local record.
 */
export async function createGraphSubscription(svc, {
  project, connector, resource, changeTypes, delegatedCredentialId,
  expirationDateTime, notificationUrl, lifecycleNotificationUrl = null, http = graphHttp, meta = {},
}) {
  if (!project?.id) fail(400, "PROJECT_REQUIRED", "A project is required");
  if (!["outlook", "one_drive"].includes(connector)) fail(400, "BAD_CONNECTOR", "connector must be 'outlook' or 'one_drive'");
  if (!resource) fail(400, "RESOURCE_REQUIRED", "A Graph resource is required");
  if (!Array.isArray(changeTypes) || !changeTypes.length) fail(400, "CHANGE_TYPES_REQUIRED", "changeTypes is required");
  const token = await resolveGraphAccessToken(svc, project, delegatedCredentialId, { http, meta });
  const clientState = await ensureClientState(svc, project.id);
  const body = {
    changeType: changeTypes.join(","),
    notificationUrl,
    resource,
    expirationDateTime,
    clientState,
    ...(lifecycleNotificationUrl ? { lifecycleNotificationUrl } : {}),
  };
  const res = await http(`${GRAPH_BASE}/subscriptions`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body?.id) {
    fail(502, "GRAPH_SUBSCRIPTION_CREATE_FAILED", `Graph rejected the subscription (HTTP ${res.status}): ${scrubText(JSON.stringify(res.body?.error || res.body), 200)}`);
  }
  const sub = res.body;
  const row = await svc.entities.GraphSubscription.create({
    subscription_id: String(sub.id), project_id: project.id, workspace_id: project.workspace_id || null,
    connector, resource, change_types: changeTypes, delegated_credential_id: delegatedCredentialId,
    notification_url: notificationUrl, lifecycle_notification_url: lifecycleNotificationUrl || null,
    expiration_date_time: sub.expirationDateTime || expirationDateTime,
    client_state_secret_name: MS_GRAPH_CLIENT_STATE_SECRET, status: "active",
    created_at: nowIso(), updated_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: null,
    action: "msgraph.subscription.created", resource: "GraphSubscription", resource_id: row.id,
    metadata: { subscription_id: String(sub.id), connector, resource, expiration_date_time: sub.expirationDateTime || null },
  }).catch(() => {});
  return { subscription_id: String(sub.id), expiration_date_time: sub.expirationDateTime || expirationDateTime, row_id: row.id };
}

/**
 * Renew a Graph subscription (PATCH /subscriptions/{id}) before it expires. Reuses the delegated
 * credential's access token (refresh if needed). A 404 from Graph means the subscription is gone
 * on the provider side → the row is marked deleted (no orphan). Renewal PATCHes the existing
 * subscription; it NEVER POSTs a new one, so it cannot create a duplicate subscription.
 */
export async function renewGraphSubscription(svc, { subscriptionId, expirationDateTime, http = graphHttp, meta = {} }) {
  const row = await loadGraphSubscription(svc, subscriptionId);
  if (!row) fail(404, "GRAPH_SUBSCRIPTION_NOT_FOUND", "This Graph subscription was not found");
  if (row.status === "deleted") fail(410, "GRAPH_SUBSCRIPTION_DELETED", "This Graph subscription has been deleted");
  const project = await svc.entities.Project.get(row.project_id).catch(() => null);
  if (!project) fail(404, "PROJECT_NOT_FOUND", "The project for this Graph subscription was not found");
  const token = await resolveGraphAccessToken(svc, project, row.delegated_credential_id, { http, meta });
  const res = await http(`${GRAPH_BASE}/subscriptions/${encodeURIComponent(row.subscription_id)}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ expirationDateTime }),
  });
  if (!res.ok) {
    if (res.status === 404) {
      await svc.entities.GraphSubscription.update(row.id, { status: "deleted", updated_at: nowIso() }).catch(() => {});
      fail(410, "GRAPH_SUBSCRIPTION_GONE", "The Graph subscription no longer exists on the provider side");
    }
    fail(502, "GRAPH_SUBSCRIPTION_RENEW_FAILED", `Graph rejected the renewal (HTTP ${res.status}): ${scrubText(JSON.stringify(res.body?.error || res.body), 200)}`);
  }
  const newExp = res.body?.expirationDateTime || expirationDateTime;
  const updated = await svc.entities.GraphSubscription.update(row.id, {
    expiration_date_time: newExp, status: "active", last_renewed_at: nowIso(), last_renewal_error: null, updated_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: null,
    action: "msgraph.subscription.renewed", resource: "GraphSubscription", resource_id: row.id,
    metadata: { subscription_id: row.subscription_id, expiration_date_time: newExp },
  }).catch(() => {});
  return { subscription_id: row.subscription_id, expiration_date_time: newExp, row_id: updated.id };
}

/**
 * Delete a Graph subscription. Best-effort provider DELETE then the local row is marked deleted
 * (mirrors revokeDelegatedCredential: a failed provider delete still removes the local record).
 * A missing or already-deleted row is a no-op success.
 */
export async function deleteGraphSubscription(svc, { subscriptionId, http = graphHttp, meta = {} }) {
  const row = await loadGraphSubscription(svc, subscriptionId);
  if (!row) return { subscription_id: subscriptionId, deleted: false, reason: "not_found" };
  if (row.status === "deleted") return { subscription_id: subscriptionId, deleted: true, already: true };
  const project = await svc.entities.Project.get(row.project_id).catch(() => null);
  let provider_deleted = false;
  if (project) {
    try {
      const token = await resolveGraphAccessToken(svc, project, row.delegated_credential_id, { http, meta });
      const res = await http(`${GRAPH_BASE}/subscriptions/${encodeURIComponent(row.subscription_id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      provider_deleted = res.ok || res.status === 404;
    } catch { /* best-effort; local deletion is authoritative */ }
  }
  await svc.entities.GraphSubscription.update(row.id, { status: "deleted", updated_at: nowIso() });
  await audit(svc, {
    workspace_id: project?.workspace_id || null, project_id: row.project_id, user_id: null,
    action: "msgraph.subscription.deleted", resource: "GraphSubscription", resource_id: row.id,
    metadata: { subscription_id: row.subscription_id, provider_deleted },
  }).catch(() => {});
  return { subscription_id: subscriptionId, deleted: true, provider_deleted };
}

/**
 * Renewal sweeper: renews every ACTIVE subscription whose expiration_date_time is within
 * `renewalLeadMs` of now. Runs on the existing scheduled infrastructure (a scheduled workflow
 * invoking the msGraphSubscriptionRenew function). Each renewal PATCHes the existing subscription
 * — never POSTs — so the sweep cannot create duplicates. A renewal that fails because the
 * subscription is gone (404) marks the row deleted; other failures are recorded for the next
 * sweep without creating a duplicate.
 */
export async function renewExpiringSubscriptions(svc, { now = Date.now(), renewalLeadMs = DEFAULT_RENEWAL_LEAD_MS, http = graphHttp, meta = {} } = {}) {
  const rows = await svc.entities.GraphSubscription.filter({ status: "active" }, "expiration_date_time", 200).catch(() => []);
  const due = rows.filter((r) => r.expiration_date_time && Date.parse(r.expiration_date_time) <= now + renewalLeadMs);
  const results = [];
  for (const r of due) {
    try {
      const newExp = new Date(now + DEFAULT_RENEWAL_EXTENSION_MS).toISOString();
      results.push(await renewGraphSubscription(svc, { subscriptionId: r.subscription_id, expirationDateTime: newExp, http, meta }));
    } catch (e) {
      await svc.entities.GraphSubscription.update(r.id, { last_renewal_error: trunc(e.message), updated_at: nowIso() }).catch(() => {});
      results.push({ subscription_id: r.subscription_id, error: e.code || "RENEW_FAILED", message: trunc(e.message) });
    }
  }
  return { due: due.length, renewed: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length, results };
}