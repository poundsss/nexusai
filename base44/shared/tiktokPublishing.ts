import { resolveOwnTikTokConnection } from "./tiktokConnection.ts";
import { tikTokRequest, tikTokOutcome, tikTokError } from "./tiktokApi.ts";
import { validateTikTokPost } from "./tiktokPostValidation.ts";

export async function tikTokCreator(svc, row, options = {}) {
  const connection = await (options.getConnection || resolveOwnTikTokConnection)(svc, row);
  if (!connection?.accessToken) throw tikTokError("No project-owned TikTok authorization", "NO_CONNECTION");
  if (!Array.isArray(connection.scopes) || !connection.scopes.includes("video.publish")) throw tikTokError("The TikTok authorization lacks video.publish", "PERMISSION_MISSING");
  const creator = await tikTokRequest(connection.accessToken, "creator_info/query/", {}, options);
  return { connection, creator };
}
export async function prepareTikTokPost(svc, project, user, input, options = {}) {
  if (!user?.id) throw tikTokError("Sign in to authorize a TikTok post", "AUTH_REQUIRED", 401);
  if (input.consent !== true || input.music_usage_confirmed !== true) throw tikTokError("Explicit video-post consent and Music Usage Confirmation are required", "TIKTOK_CONSENT_REQUIRED", 422);
  const raw = input.tiktok_settings || {};
  if (raw.disclosure === true && raw.brand_content_toggle !== true && raw.brand_organic_toggle !== true) throw tikTokError("Select the commercial-content disclosure", "TIKTOK_DISCLOSURE_INVALID", 422);
  const settings = { privacy_level: raw.privacy_level };
  for (const key of ["allow_comment", "allow_duet", "allow_stitch", "brand_content_toggle", "brand_organic_toggle", "is_aigc"]) settings[key] = raw[key] === true;
  const patch = { tiktok_user_id: user.id, tiktok_credential_id: String(input.tiktok_credential_id || ""), video_url: String(input.video_url || "").trim(), video_duration_sec: Number(input.video_duration_sec), tiktok_settings: settings, tiktok_consent_at: new Date().toISOString() };
  const row = { ...input, ...patch, project_id: project.id };
  const { creator } = await tikTokCreator(svc, row, options);
  validateTikTokPost(row, creator);
  return patch;
}
export async function assertOwnTikTokReady(svc, row, options = {}) {
  const { creator } = await tikTokCreator(svc, row, options);
  validateTikTokPost(row, creator);
  return true;
}
// PULL_FROM_URL is deliberately the single supported transfer mode. TikTok, not a local
// boolean, verifies URL/domain ownership and enforces application review/audit restrictions.
export async function publishOwnTikTok(svc, row, options = {}) {
  const connection = await (options.getConnection || resolveOwnTikTokConnection)(svc, row);
  if (!connection?.accessToken) throw tikTokError("No project-owned TikTok authorization", "NO_CONNECTION");
  if (!connection.scopes?.includes("video.publish")) throw tikTokError("The TikTok authorization lacks video.publish", "PERMISSION_MISSING");
  let publishId = row.tiktok_publish_id;
  if (!publishId) {
    const creator = await tikTokRequest(connection.accessToken, "creator_info/query/", {}, options);
    const postInfo = validateTikTokPost(row, creator);
    const initialized = await tikTokRequest(connection.accessToken, "video/init/", { post_info: postInfo, source_info: { source: "PULL_FROM_URL", video_url: row.video_url } }, options);
    if (typeof initialized.publish_id !== "string" || !initialized.publish_id || initialized.publish_id.length > 64) throw tikTokError("TikTok accepted no usable publish_id; do not resubmit", "PUBLISH_OUTCOME_UNKNOWN", 502);
    publishId = initialized.publish_id;
    // Persist BEFORE polling. If this write fails, the job marks outcome unknown and never
    // re-initializes. publish_id is an asynchronous operation handle, NOT a published post id.
    try { await svc.entities.ViralityScheduledPost.update(row.id, { tiktok_publish_id: publishId }); }
    catch { throw tikTokError("TikTok accepted the video but its tracking handle could not be persisted", "PUBLISH_OUTCOME_UNKNOWN", 502); }
  }
  const status = await tikTokRequest(connection.accessToken, "status/fetch/", { publish_id: publishId }, options);
  return tikTokOutcome(status, publishId);
}