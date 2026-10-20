// Mock responses ONLY. All TikTok network requests in certification use this transport.
// No production secret, connector or user content is passed to any provider.
export const MOCK_CREATOR = { creator_username: "fixture_creator", creator_nickname: "Fixture Creator", privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 300 };
export const MOCK_TOKEN = "tiktok_mock_token_not_a_real_credential";
export const MOCK_REFRESH = "tiktok_mock_refresh_not_a_real_credential";
export function createTikTokMock({ status = "PUBLISH_COMPLETE", initError = null, creatorError = null, failReason = "duration_check_failed", initThrows = false } = {}) {
  const calls = [];
  const state = { status };
  const fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    if (!path.startsWith("/v2/post/publish/")) throw new Error("Unexpected mock provider URL");
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ path, body, method: options.method, authorization: options.headers?.Authorization });
    let data = null, error = { code: "ok", message: "" }, httpStatus = 200;
    if (path.endsWith("creator_info/query/")) { data = MOCK_CREATOR; if (creatorError) { error = { code: creatorError }; httpStatus = 401; } }
    else if (path.endsWith("video/init/")) {
      if (initThrows) throw new Error("Mock timeout after send");
      data = { publish_id: "mock_publish_operation_1" };
      if (initError) { error = { code: initError }; httpStatus = 403; }
    } else if (path.endsWith("status/fetch/")) data = { status: state.status, publicaly_available_post_id: state.status === "PUBLISH_COMPLETE" ? ["900000000000000001"] : [], fail_reason: failReason };
    else throw new Error("Unexpected mock path");
    return new Response(JSON.stringify({ data, error }), { status: httpStatus, headers: { "content-type": "application/json" } });
  };
  return { calls, state, fetch, initCount: () => calls.filter((c) => c.path.endsWith("video/init/")).length };
}
export const mockTikTokSecrets = async (name) => ({ TIKTOK_OAUTH_CLIENT_KEY: "mock_client_key", TIKTOK_OAUTH_CLIENT_SECRET: "mock_client_secret", TIKTOK_OAUTH_REDIRECT_URI: "https://fixture.invalid/oauth/callback" })[name];
export function mockTikTokOAuthHttp(calls = [], { scopes = "video.publish", subject = "mock_tiktok_open_id" } = {}) {
  return async (url, options) => {
    const form = new URLSearchParams(options.body);
    calls.push({ url, form: Object.fromEntries(form) });
    if (String(url).endsWith("/revoke/")) return { ok: true, status: 200, body: {} };
    return { ok: true, status: 200, body: { access_token: MOCK_TOKEN, refresh_token: MOCK_REFRESH, expires_in: 86400, open_id: subject, scope: scopes, token_type: "Bearer" } };
  };
}