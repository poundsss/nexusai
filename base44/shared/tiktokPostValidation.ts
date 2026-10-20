import { tikTokError } from "./tiktokApi.ts";
export function validateTikTokPost(row, creator) {
  let video;
  try { video = new URL(String(row.video_url || "")); } catch { throw tikTokError("A video URL is required", "TIKTOK_VIDEO_REQUIRED", 422); }
  if (video.protocol !== "https:" || video.username || video.password || video.hash || video.href.length > 2000) throw tikTokError("Use an HTTPS video URL on a TikTok-verified domain or URL prefix", "TIKTOK_VIDEO_INVALID", 422);
  if (!Number.isFinite(row.video_duration_sec) || row.video_duration_sec <= 0 || !Number.isFinite(creator.max_video_post_duration_sec) || row.video_duration_sec > creator.max_video_post_duration_sec) throw tikTokError("The video duration exceeds the creator's permitted duration or is unavailable", "TIKTOK_DURATION_INVALID", 422);
  const settings = row.tiktok_settings || {};
  if (!Array.isArray(creator.privacy_level_options) || !creator.privacy_level_options.includes(settings.privacy_level)) throw tikTokError("Select a privacy level from the current creator options", "TIKTOK_PRIVACY_INVALID", 422);
  if (!row.tiktok_consent_at) throw tikTokError("Explicit consent to post this video and TikTok Music Usage Confirmation are required", "TIKTOK_CONSENT_REQUIRED", 422);
  if (settings.brand_content_toggle && settings.privacy_level === "SELF_ONLY") throw tikTokError("Branded content cannot use Only me privacy", "TIKTOK_DISCLOSURE_INVALID", 422);
  const caption = `${row.body || ""}${row.hashtags?.length ? `\n\n${row.hashtags.map((tag) => `#${String(tag).replace(/^#/, "")}`).join(" ")}` : ""}`;
  if (caption.length > 2200) throw tikTokError("TikTok captions are limited to 2200 UTF-16 characters, including hashtags", "TIKTOK_CAPTION_TOO_LONG", 422);
  return {
    title: caption, privacy_level: settings.privacy_level,
    disable_comment: creator.comment_disabled === true || settings.allow_comment !== true,
    disable_duet: creator.duet_disabled === true || settings.allow_duet !== true,
    disable_stitch: creator.stitch_disabled === true || settings.allow_stitch !== true,
    brand_content_toggle: settings.brand_content_toggle === true,
    brand_organic_toggle: settings.brand_organic_toggle === true, is_aigc: settings.is_aigc === true,
  };
}