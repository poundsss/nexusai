import { loadAuthorizedProject } from "./authz.ts";
import { decryptSecretValue, decryptWithAad } from "./secretCrypto.ts";
import { refreshDelegatedCredential } from "./delegatedOAuth.ts";
import { TIKTOK_PROVIDER_ID, TIKTOK_TOKEN_URL, TIKTOK_SECRET_NAMES } from "./tiktokOAuth.ts";
import { tikTokError } from "./tiktokApi.ts";

// Project-owned secrets already use NexusAI's encrypted ProjectSecret contract. No new
// environment secret or shared Base44 connector is consulted, and unset configuration refuses.
export function tikTokSecretResolver(svc, projectId) {
  return async (name) => {
    if (!TIKTOK_SECRET_NAMES.includes(name)) return undefined;
    const page = await svc.entities.ProjectSecret.filter({ project_id: projectId, name }, { limit: 1 });
    const row = page.items[0];
    return row?.value ? await decryptSecretValue(projectId, name, row.value) : undefined;
  };
}
export async function tikTokOAuthHttp(url, options) {
  if (![TIKTOK_TOKEN_URL, "https://open.tiktokapis.com/v2/oauth/revoke/"].includes(url)) throw tikTokError("Unsupported TikTok OAuth endpoint", "TIKTOK_ENDPOINT_INVALID", 400);
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: "error" });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
}
export async function ownTikTokCredentials(svc, project, user) {
  const page = await svc.entities.DelegatedCredential.filter({ project_id: project.id, app_user_id: user.id, provider_id: TIKTOK_PROVIDER_ID, status: "active" }, { limit: 50, fields: ["credential_id", "external_subject", "scopes", "expires_at"] });
  return page.items.map((c) => ({ credential_id: c.credential_id, external_subject: c.external_subject, scopes: c.scopes || [], expires_at: c.expires_at }));
}
export async function resolveOwnTikTokConnection(svc, row) {
  if (!row.project_id || !row.tiktok_user_id || !row.tiktok_credential_id) throw tikTokError("Select your own TikTok account", "NO_CONNECTION");
  const { project } = await loadAuthorizedProject(svc, { id: row.tiktok_user_id }, row.project_id, "project.write");
  const query = { project_id: project.id, provider_id: TIKTOK_PROVIDER_ID, app_user_id: row.tiktok_user_id, credential_id: row.tiktok_credential_id };
  let credential = (await svc.entities.DelegatedCredential.filter(query, { limit: 1 })).items[0];
  if (!credential || credential.status !== "active" || credential.token_endpoint !== TIKTOK_TOKEN_URL || credential.client_id_secret !== TIKTOK_SECRET_NAMES[0] || credential.client_secret_secret !== TIKTOK_SECRET_NAMES[1]) throw tikTokError("No active project-owned TikTok authorization", "NO_CONNECTION");
  if (!credential.scopes?.includes("video.publish")) throw tikTokError("The authorized TikTok account lacks video.publish", "PERMISSION_MISSING");
  const expires = Date.parse(credential.expires_at || "");
  if (!Number.isFinite(expires)) throw tikTokError("TikTok token expiry is unavailable; reconnect", "NO_CONNECTION");
  if (expires <= Date.now() + 30000) {
    if (!credential.encrypted_refresh_token) throw tikTokError("The TikTok authorization has expired; reconnect", "NO_CONNECTION");
    await refreshDelegatedCredential(svc, project, { id: row.tiktok_user_id }, credential.credential_id, { resolveSecret: tikTokSecretResolver(svc, project.id), http: tikTokOAuthHttp });
    credential = (await svc.entities.DelegatedCredential.filter(query, { limit: 1 })).items[0];
    if (credential?.status !== "active" || !credential.scopes?.includes("video.publish")) throw tikTokError("TikTok no longer grants video.publish", "PERMISSION_MISSING");
  }
  const accessToken = await decryptWithAad(`delegated-credential:${project.id}:${credential.credential_id}`, credential.encrypted_access_token);
  if (!accessToken) throw tikTokError("No TikTok access token", "NO_CONNECTION");
  return { accessToken, scopes: credential.scopes, subject: credential.external_subject };
}