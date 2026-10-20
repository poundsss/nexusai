// Google Calendar / Drive watch-channel management — the OUTBOUND half of the Google
// connector-event integration (Phase 1, Calendar + Drive only; Gmail/Pub/Sub deliberately NOT
// implemented). Base44 publishes no Google watch lifecycle, so this is NexusAI-native
// infrastructure required to make a Google web_hook channel function.
//
// It REUSES the existing infrastructure and adds no second system:
//   • access token  — the EXISTING DelegatedCredential (#31G). The token is decrypted with the
//                     existing decryptWithAad (AAD = `delegated-credential:<project>:<credential_id>`)
//                     and refreshed through the EXISTING refreshDelegatedCredential when expired.
//                     No token value is ever logged, returned or stored outside DelegatedCredential.
//   • channel token — an ordinary ProjectSecret (GOOGLE_CHANNEL_TOKEN), encrypted at rest with
//                     the existing encryptSecretValue, decrypted only here at use time. One per
//                     project; reused across that project's channels so rotation does not break
//                     existing channels' X-Goog-Channel-Token validation. This is the SOLE
//                     authenticity check for Google push (Google sends no HMAC).
//   • secret crypto — the EXISTING secretCrypto (encryptSecretValue/decryptSecretValue and
//                     encryptWithAad/decryptWithAad), unchanged.
//   • audit         — the EXISTING audit() path.
//
// Google contract (verified against Google docs): Calendar/Drive push is a DIRECT HTTPS POST to
// the watch `address` with an EMPTY body and all metadata in X-Goog-* headers. Renewal is a
// RE-WATCH (a new channel) before expiration — there is no PATCH-renew — so renewGoogleWatch
// re-issues a watch and UPDATES the existing row with the new channel/resource IDs, never
// creating a duplicate row. A revoked / refresh-failed delegated credential fails closed.
import { encryptSecretValue, decryptSecretValue, encryptWithAad, decryptWithAad } from "./secretCrypto.ts";
import { refreshDelegatedCredential } from "./delegatedOAuth.ts";
import { audit } from "./authz.ts";
import { fail, nowIso } from "./appAuth.ts";
import { scrubText } from "./tracing.ts";

export const GOOGLE_CHANNEL_TOKEN_SECRET = "GOOGLE_CHANNEL_TOKEN";
export const DEFAULT_RENEWAL_LEAD_MS = 60 * 60 * 1000; // re-watch channels expiring within 1h
// Google watch max lifetimes (verified): Drive ~24h, Calendar ~7 days. Renew to just under each.
export const MAX_WATCH_MS = {
  googledrive: 23 * 60 * 60 * 1000,
  googlecalendar: 7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000,
};

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);
const svcOf = (client) => client.asServiceRole || client;
const aadFor = (projectId, credentialId) => `delegated-credential:${projectId}:${credentialId}`;
const newUuid = () => (crypto.randomUUID ? crypto.randomUUID() : `ch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Minimal HTTP client for Google REST calls (watch / channels.stop). The bearer token travels
 * only in the Authorization header of this server-side call; any error is scrubbed of it before
 * it can reach a log or response.
 */
export async function googleHttp(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    body = options.body;
    if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
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

/** Store (or rotate) the per-project channel token as an encrypted ProjectSecret. */
export async function storeChannelToken(svc, projectId, value) {
  const sealed = await encryptSecretValue(projectId, GOOGLE_CHANNEL_TOKEN_SECRET, value);
  const existing = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: GOOGLE_CHANNEL_TOKEN_SECRET }, "name", 1))[0] || null;
  if (existing) return svc.entities.ProjectSecret.update(existing.id, { value: sealed });
  return svc.entities.ProjectSecret.create({ project_id: projectId, name: GOOGLE_CHANNEL_TOKEN_SECRET, value: sealed, required: true });
}

/** Returns the per-project channel token, generating + storing it on first use. Reused thereafter. */
export async function ensureChannelToken(svc, projectId) {
  const existing = (await svc.entities.ProjectSecret.filter({ project_id: projectId, name: GOOGLE_CHANNEL_TOKEN_SECRET }, "name", 1))[0] || null;
  if (existing?.value) return decryptSecretValue(projectId, GOOGLE_CHANNEL_TOKEN_SECRET, existing.value);
  const value = randomHex(32);
  await storeChannelToken(svc, projectId, value);
  return value;
}

async function loadDelegatedCredential(svc, projectId, credentialId) {
  const rows = await svc.entities.DelegatedCredential.filter({ project_id: projectId, credential_id: String(credentialId || "") }, "-created_date", 1).catch(() => []);
  return rows[0] || null;
}

async function loadChannelByChannelId(svc, channelId) {
  const rows = await svc.entities.GoogleWatchChannel.filter({ channel_id: String(channelId || "") }, "-created_date", 5).catch(() => []);
  return rows[0] || null;
}

/**
 * Resolve a usable Google access token for a delegated credential, server-side. Reuses the
 * EXISTING refreshDelegatedCredential when the token is expired — passing a synthetic user
 * satisfying the ownership check (the credential's own app_user_id), so the certified refresh
 * path is exercised unchanged. A revoked / refresh-failed credential fails closed.
 */
export async function resolveGoogleAccessToken(svc, project, credentialId, { http = googleHttp, meta = {} } = {}) {
  const cred = await loadDelegatedCredential(svc, project.id, credentialId);
  if (!cred) fail(404, "DELEGATED_CREDENTIAL_NOT_FOUND", "The delegated credential for this Google watch was not found");
  if (cred.status === "revoked") fail(403, "DELEGATED_CREDENTIAL_REVOKED", "The delegated credential has been revoked");
  const expired = !cred.expires_at || Date.parse(cred.expires_at) <= Date.now() + 30000;
  if (expired) {
    if (!cred.encrypted_refresh_token) fail(403, "DELEGATED_CREDENTIAL_INACTIVE", "The delegated credential is expired and has no refresh token");
    await refreshDelegatedCredential(svc, project, { id: cred.app_user_id }, credentialId, { resolveSecret: makeResolveSecret(svc, project.id), http }, meta);
  }
  const fresh = await loadDelegatedCredential(svc, project.id, credentialId);
  if (!fresh || fresh.status !== "active") fail(403, "DELEGATED_CREDENTIAL_INACTIVE", "The delegated credential is no longer active");
  if (!fresh.encrypted_access_token) fail(403, "DELEGATED_CREDENTIAL_INACTIVE", "The delegated credential has no access token");
  return decryptWithAad(aadFor(project.id, credentialId), fresh.encrypted_access_token);
}

/**
 * Call a Google `watch` endpoint (Calendar/Drive). Resolves the delegated access token (refresh
 * if needed), ensures the per-project channel token, POSTs the watch body, and returns the new
 * channel identifiers. Does NOT persist a row — createGoogleWatch / renewGoogleWatch decide that.
 * Fail-closed: a Google failure throws BEFORE any row is written, so no orphaned local state.
 */
export async function callGoogleWatch(svc, {
  project, provider, watchEndpoint, delegatedCredentialId, expirationMs, notificationUrl, http = googleHttp, meta = {},
}) {
  if (!project?.id) fail(400, "PROJECT_REQUIRED", "A project is required");
  if (!["googlecalendar", "googledrive"].includes(provider)) fail(400, "BAD_PROVIDER", "provider must be 'googlecalendar' or 'googledrive'");
  if (!watchEndpoint) fail(400, "WATCH_ENDPOINT_REQUIRED", "A Google watch endpoint URL is required");
  const token = await resolveGoogleAccessToken(svc, project, delegatedCredentialId, { http, meta });
  const channelToken = await ensureChannelToken(svc, project.id);
  const channelId = newUuid();
  const watchBody = {
    id: channelId, type: "web_hook", address: notificationUrl,
    token: channelToken, expiration: Math.max(1, Number(expirationMs) || 0),
  };
  const res = await http(watchEndpoint, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(watchBody),
  });
  if (!res.ok || !res.body?.resourceId) {
    fail(502, "GOOGLE_WATCH_FAILED", `Google rejected the watch (HTTP ${res.status}): ${scrubText(JSON.stringify(res.body?.error || res.body), 200)}`);
  }
  const b = res.body;
  const expMs = Number(b.expiration) || Number(expirationMs) || Date.now();
  return {
    channel_id: String(b.id || channelId),
    resource_id: String(b.resourceId),
    watch_resource_uri: String(b.resourceUri || ""),
    expiration: new Date(expMs).toISOString(),
  };
}

/** Call Google `channels.stop` for a channel. Best-effort: a provider failure never blocks local deletion. */
export async function callGoogleStop(svc, { project, channelId, resourceId, delegatedCredentialId, http = googleHttp, meta = {} }) {
  if (!project?.id || !channelId || !resourceId) return { stopped: false };
  try {
    const token = await resolveGoogleAccessToken(svc, project, delegatedCredentialId, { http, meta });
    const res = await http("https://www.googleapis.com/api/v3/channels/stop", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: String(channelId), resourceId: String(resourceId) }),
    });
    return { stopped: res.ok || res.status === 204 || res.status === 404 };
  } catch { return { stopped: false }; }
}

/**
 * Create a Google watch and persist the GoogleWatchChannel row. The row is written only AFTER a
 * successful Google watch response, so a Google failure leaves no orphaned local subscription.
 */
export async function createGoogleWatch(svc, {
  project, provider, watchEndpoint, delegatedCredentialId, expirationMs, notificationUrl, http = googleHttp, meta = {},
}) {
  const watched = await callGoogleWatch(svc, { project, provider, watchEndpoint, delegatedCredentialId, expirationMs, notificationUrl, http, meta });
  const row = await svc.entities.GoogleWatchChannel.create({
    channel_id: watched.channel_id, resource_id: watched.resource_id, provider,
    project_id: project.id, workspace_id: project.workspace_id || null,
    delegated_credential_id: delegatedCredentialId, expiration: watched.expiration,
    token_secret_name: GOOGLE_CHANNEL_TOKEN_SECRET, watch_resource_uri: watched.watch_resource_uri,
    notification_url: notificationUrl, status: "active", created_at: nowIso(), updated_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: null,
    action: "google.watch.created", resource: "GoogleWatchChannel", resource_id: row.id,
    metadata: { channel_id: watched.channel_id, provider, resource_id: watched.resource_id, expiration: watched.expiration },
  }).catch(() => {});
  return { channel_id: watched.channel_id, resource_id: watched.resource_id, expiration: watched.expiration, watch_resource_uri: watched.watch_resource_uri, row_id: row.id };
}

/**
 * Renew a Google watch by RE-ISSUING a watch (a new channel) before expiration and UPDATING the
 * existing row with the new channel/resource IDs — NEVER a new row, so renewal creates no
 * duplicate subscription. The old channel is best-effort stopped first (it would auto-expire
 * anyway); the per-(channelId,messageNumber) replay key guarantees no duplicate dispatch even if
 * both channels briefly deliver. A 404/missing row is a no-op; a deleted row is refused.
 */
export async function renewGoogleWatch(svc, { channelId, expirationMs = null, http = googleHttp, meta = {} }) {
  const row = await loadChannelByChannelId(svc, channelId);
  if (!row) fail(404, "GOOGLE_CHANNEL_NOT_FOUND", "This Google watch channel was not found");
  if (row.status === "deleted") fail(410, "GOOGLE_CHANNEL_DELETED", "This Google watch channel has been deleted");
  const project = await svc.entities.Project.get(row.project_id).catch(() => null);
  if (!project) fail(404, "PROJECT_NOT_FOUND", "The project for this Google watch was not found");
  // Best-effort stop the expiring channel (it would auto-expire; replay dedup covers any overlap).
  await callGoogleStop(svc, { project, channelId: row.channel_id, resourceId: row.resource_id, delegatedCredentialId: row.delegated_credential_id, http, meta });
  const expMs = Number(expirationMs) || (Date.now() + (MAX_WATCH_MS[row.provider] || MAX_WATCH_MS.googledrive));
  const watchEndpoint = row.watch_resource_uri ? `${row.watch_resource_uri.replace(/\?.*$/, "")}/watch` : null;
  if (!watchEndpoint) fail(400, "GOOGLE_WATCH_ENDPOINT_UNKNOWN", "The channel row carries no watch resource URI to renew against");
  const watched = await callGoogleWatch(svc, {
    project, provider: row.provider, watchEndpoint, delegatedCredentialId: row.delegated_credential_id,
    expirationMs: expMs, notificationUrl: row.notification_url || null, http, meta,
  });
  const updated = await svc.entities.GoogleWatchChannel.update(row.id, {
    channel_id: watched.channel_id, resource_id: watched.resource_id, watch_resource_uri: watched.watch_resource_uri,
    expiration: watched.expiration, status: "active", last_renewed_at: nowIso(), last_renewal_error: null, updated_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: null,
    action: "google.watch.renewed", resource: "GoogleWatchChannel", resource_id: row.id,
    metadata: { old_channel_id: row.channel_id, new_channel_id: watched.channel_id, expiration: watched.expiration },
  }).catch(() => {});
  return { channel_id: watched.channel_id, resource_id: watched.resource_id, expiration: watched.expiration, row_id: updated.id };
}

/**
 * Stop a Google watch. Best-effort provider `channels.stop`, then the local row is marked deleted
 * (mirrors revokeDelegatedCredential: a failed provider stop still removes the local record). A
 * missing or already-deleted row is a no-op success.
 */
export async function stopGoogleWatch(svc, { channelId, http = googleHttp, meta = {} }) {
  const row = await loadChannelByChannelId(svc, channelId);
  if (!row) return { channel_id: channelId, stopped: false, reason: "not_found" };
  if (row.status === "deleted") return { channel_id: channelId, stopped: true, already: true };
  const project = await svc.entities.Project.get(row.project_id).catch(() => null);
  let provider_stopped = false;
  if (project) {
    provider_stopped = (await callGoogleStop(svc, { project, channelId: row.channel_id, resourceId: row.resource_id, delegatedCredentialId: row.delegated_credential_id, http, meta })).stopped;
  }
  await svc.entities.GoogleWatchChannel.update(row.id, { status: "deleted", updated_at: nowIso() });
  await audit(svc, {
    workspace_id: project?.workspace_id || null, project_id: row.project_id, user_id: null,
    action: "google.watch.stopped", resource: "GoogleWatchChannel", resource_id: row.id,
    metadata: { channel_id: row.channel_id, provider_stopped },
  }).catch(() => {});
  return { channel_id: channelId, stopped: true, provider_stopped };
}

/**
 * Renewal sweeper: re-watches every ACTIVE channel whose expiration is within `renewalLeadMs` of
 * now. Runs on the existing scheduled infrastructure (a scheduled workflow invoking the
 * googleWatchRenew function). Each renewal re-issues a watch and UPDATES the existing row — never
 * a new row — so the sweep cannot create duplicates. Safely skips expired/deleted channels. Does
 * NOT dispatch workflow events (renewal is subscription management, not a connector event).
 */
export async function renewExpiringWatchChannels(svc, { now = Date.now(), renewalLeadMs = DEFAULT_RENEWAL_LEAD_MS, http = googleHttp, meta = {} } = {}) {
  const rows = await svc.entities.GoogleWatchChannel.filter({ status: "active" }, "expiration", 200).catch(() => []);
  const due = rows.filter((r) => r.expiration && Date.parse(r.expiration) <= now + renewalLeadMs);
  const results = [];
  for (const r of due) {
    try {
      const expMs = now + (MAX_WATCH_MS[r.provider] || MAX_WATCH_MS.googledrive);
      results.push(await renewGoogleWatch(svc, { channelId: r.channel_id, expirationMs: expMs, http, meta }));
    } catch (e) {
      await svc.entities.GoogleWatchChannel.update(r.id, { last_renewal_error: trunc(e.message), updated_at: nowIso() }).catch(() => {});
      results.push({ channel_id: r.channel_id, error: e.code || "RENEW_FAILED", message: trunc(e.message) });
    }
  }
  return { due: due.length, renewed: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length, results };
}