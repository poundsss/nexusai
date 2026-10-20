// Only documented Content Posting endpoints. No platform shared-connector calls.
const API = "https://open.tiktokapis.com/v2/post/publish/";
const PATHS = ["creator_info/query/", "video/init/", "status/fetch/"];
export const tikTokError = (message, code = "TIKTOK_API_ERROR", status = 409) => Object.assign(new Error(message), { code, status });
export async function tikTokRequest(accessToken, path, body = {}, { fetch: fetcher = fetch } = {}) {
  if (!PATHS.includes(path)) throw tikTokError("Unsupported TikTok operation", "TIKTOK_OPERATION_INVALID", 400);
  let response;
  try {
    response = await fetcher(API + path, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error" });
  } catch {
    throw tikTokError("TikTok did not return a confirmed response", path === "video/init/" ? "PUBLISH_OUTCOME_UNKNOWN" : "TIKTOK_API_ERROR", 502);
  }
  const json = await response.json().catch(() => null);
  const code = json?.error?.code;
  if (!response.ok || code !== "ok") {
    const safeCode = /^[a-zA-Z0-9_]{1,100}$/.test(code || "") ? code : `HTTP_${response.status}`;
    const mapped = code === "scope_not_authorized" ? "PERMISSION_MISSING" : code === "access_token_invalid" ? "NO_CONNECTION" : path === "video/init/" && (response.status >= 500 || !json) ? "PUBLISH_OUTCOME_UNKNOWN" : "TIKTOK_API_ERROR";
    throw tikTokError(`TikTok refused ${path}: ${safeCode}`, mapped, mapped === "TIKTOK_API_ERROR" ? 502 : 409);
  }
  if (!json.data || typeof json.data !== "object") throw tikTokError("TikTok returned an invalid response", path === "video/init/" ? "PUBLISH_OUTCOME_UNKNOWN" : "TIKTOK_API_ERROR", 502);
  return json.data;
}
export function tikTokOutcome(data, publishId) {
  if (data.status === "PUBLISH_COMPLETE") return { status: "posted", publish_id: publishId, ref: String(data.publicaly_available_post_id?.[0] || publishId) };
  if (data.status === "FAILED") return { status: "failed", publish_id: publishId, error: `TikTok publish failed: ${String(data.fail_reason || "unspecified").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 100)}` };
  if (["PROCESSING_UPLOAD", "PROCESSING_DOWNLOAD"].includes(data.status)) return { status: "publishing", publish_id: publishId };
  throw tikTokError("TikTok returned an unrecognized Direct Post status", "PUBLISH_OUTCOME_UNKNOWN", 502);
}