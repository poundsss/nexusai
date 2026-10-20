import { beginDelegatedOAuth, completeDelegatedOAuth, revokeDelegatedCredential } from "./delegatedOAuth.ts";
import { TIKTOK_PROVIDERS, TIKTOK_PROVIDER_ID, TIKTOK_SECRET_NAMES, validateTikTokRedirect } from "./tiktokOAuth.ts";
import { tikTokSecretResolver, tikTokOAuthHttp, ownTikTokCredentials } from "./tiktokConnection.ts";
import { tikTokCreator, publishOwnTikTok } from "./tiktokPublishing.ts";
import { executeOwnTikTokJob } from "./tiktokSocialJob.ts";
import { tikTokError } from "./tiktokApi.ts";
import { limit } from "./appAuth.ts";

export const TIKTOK_ACTIONS = new Set(["tiktok_readiness", "tiktok_oauth_begin", "tiktok_oauth_callback", "tiktok_disconnect", "tiktok_creator", "tiktok_check_status"]);
// Invoked ONLY after virality's existing authenticated project authorization. No scope, OAuth
// endpoint, owner id or client credential is accepted from an end-user request.
export async function tikTokSurface(svc, project, user, input, options = {}) {
  if (!user?.id) throw tikTokError("Sign in required", "AUTH_REQUIRED", 401);
  const resolveSecret = options.resolveSecret || tikTokSecretResolver(svc, project.id);
  const http = options.http || tikTokOAuthHttp;
  const credentialRow = { project_id: project.id, tiktok_user_id: user.id, tiktok_credential_id: input.credential_id };
  if (input.action === "tiktok_readiness") {
    const missing = [];
    for (const name of TIKTOK_SECRET_NAMES) if (!await resolveSecret(name)) missing.push(name);
    return { configured: missing.length === 0, missing_configuration: missing, credentials: await ownTikTokCredentials(svc, project, user), shared_connector_unchanged: true };
  }
  if (input.action === "tiktok_oauth_begin" || input.action === "tiktok_oauth_callback") {
    await limit(svc, project, "delegated_oauth", `user:${user.id}`);
    for (const name of TIKTOK_SECRET_NAMES) if (!await resolveSecret(name)) throw tikTokError(`Configure project secret ${name}`, "OAUTH_CLIENT_NOT_CONFIGURED");
    const redirect = validateTikTokRedirect(await resolveSecret(TIKTOK_SECRET_NAMES[2]));
    if (input.action === "tiktok_oauth_begin") {
      const result = await beginDelegatedOAuth(svc, project, user, { provider_id: TIKTOK_PROVIDER_ID, redirect_uri: redirect, providers: TIKTOK_PROVIDERS }, { resolveSecret });
      return { ...result, redirect_uri: redirect };
    }
    // Pre-check the server-issued state provider; another provider's state cannot be consumed here.
    const { sha256 } = await import("./appAuth.ts");
    const statePage = await svc.entities.AppAuthToken.filter({ project_id: project.id, token_hash: await sha256(String(input.state || "")), kind: "delegated_oauth_state" }, { limit: 1 });
    if (statePage.items[0]?.data?.provider_id !== TIKTOK_PROVIDER_ID) throw tikTokError("Invalid TikTok OAuth state", "OAUTH_STATE_MISMATCH", 400);
    return completeDelegatedOAuth(svc, project, user, { state: input.state, code: input.code, redirect_uri: redirect, providers: TIKTOK_PROVIDERS }, { resolveSecret, http });
  }
  if (input.action === "tiktok_disconnect") {
    const own = (await ownTikTokCredentials(svc, project, user)).find((credential) => credential.credential_id === input.credential_id);
    if (!own) throw tikTokError("TikTok authorization not found", "OAUTH_CREDENTIAL_NOT_FOUND", 404);
    return revokeDelegatedCredential(svc, project, user, String(input.credential_id || ""), { providers: TIKTOK_PROVIDERS, resolveSecret, http });
  }
  if (input.action === "tiktok_creator") {
    const { creator } = await tikTokCreator(svc, credentialRow, options);
    const fields = ["creator_username", "creator_nickname", "privacy_level_options", "comment_disabled", "duet_disabled", "stitch_disabled", "max_video_post_duration_sec"];
    return { creator: Object.fromEntries(fields.map((field) => [field, creator[field]])), publishing_capability_confirmed: true };
  }
  if (input.action === "tiktok_check_status") {
    const row = await svc.entities.ViralityScheduledPost.get(String(input.post_id || ""));
    if (!row || row.project_id !== project.id || row.platform !== "tiktok" || row.tiktok_user_id !== user.id || !row.tiktok_publish_id) throw tikTokError("TikTok post not found", "POST_NOT_FOUND", 404);
    return executeOwnTikTokJob(svc, row, { publisher: (s, r) => publishOwnTikTok(s, r, options), resume: true });
  }
  throw tikTokError("Unknown TikTok action", "UNKNOWN_ACTION", 400);
}