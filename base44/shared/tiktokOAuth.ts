// TikTok's OWN OAuth application, not Base44's read-only shared connector.
// Official: developers.tiktok.com/doc/login-kit-web/ and oauth-user-access-token-management.
export const TIKTOK_PROVIDER_ID = "tiktokOrganic";
export const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
export const TIKTOK_SECRET_NAMES = ["TIKTOK_OAUTH_CLIENT_KEY", "TIKTOK_OAUTH_CLIENT_SECRET", "TIKTOK_OAUTH_REDIRECT_URI"];
export const TIKTOK_PROVIDERS = {
  [TIKTOK_PROVIDER_ID]: {
    authorization_endpoint: "https://www.tiktok.com/v2/auth/authorize/",
    token_endpoint: TIKTOK_TOKEN_URL,
    revoke_endpoint: "https://open.tiktokapis.com/v2/oauth/revoke/",
    client_id_secret: TIKTOK_SECRET_NAMES[0], client_secret_secret: TIKTOK_SECRET_NAMES[1],
    scopes: ["video.publish"], pkce: false,
  },
};
export const isTikTokOAuth = (config) => config?.token_endpoint === TIKTOK_TOKEN_URL;
export const tikTokGrantedScopes = (scope) => typeof scope === "string" ? scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
export function validateTikTokRedirect(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { throw Object.assign(new Error("Configure TikTok's registered HTTPS callback URL"), { status: 409, code: "TIKTOK_REDIRECT_REQUIRED" }); }
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password || url.href.length >= 512) {
    throw Object.assign(new Error("TikTok requires a static HTTPS redirect URI without query parameters or a fragment"), { status: 422, code: "TIKTOK_REDIRECT_INVALID" });
  }
  return url.toString();
}