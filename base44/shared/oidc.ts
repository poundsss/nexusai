// OIDC (OpenID Connect) integration helpers.
//
// OIDC is used when the enterprise IdP supports it (Google Workspace, Azure AD, Okta). The
// platform acts as a standard OIDC client: redirect to the authorize URL, exchange the code
// for tokens, fetch userinfo, and map claims to platform fields.
//
// The client secret is encrypted at rest on the SsoConnection and decrypted only server-side
// at token-exchange time. It is never returned to the client and never logged.

export class OidcError extends Error {
  constructor(message, code = "OIDC_ERROR") {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

function randomState() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Build the authorization URL the browser redirects to. State is a random challenge the
// callback must echo back, binding the redirect to this specific sign-in attempt.
export function buildAuthorizeUrl(connection, { redirectUri, state = randomState() } = {}) {
  if (!connection.oidc_authorize_url) throw new OidcError("Connection has no authorize URL", "OIDC_NO_AUTHORIZE_URL");
  if (!connection.oidc_client_id) throw new OidcError("Connection has no client_id", "OIDC_NO_CLIENT_ID");
  const scopes = (connection.oidc_scopes || ["openid", "email", "profile"]).join(" ");
  const url = new URL(connection.oidc_authorize_url);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", connection.oidc_client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

// Exchange the authorization code for tokens. The client_secret is decrypted by the caller
// and passed in as `client_secret` — this function never touches stored secrets.
export async function exchangeOidcCode(connection, { code, redirectUri, client_secret }) {
  if (!connection.oidc_token_url) throw new OidcError("Connection has no token URL", "OIDC_NO_TOKEN_URL");
  if (!client_secret) throw new OidcError("client_secret is required", "OIDC_NO_SECRET");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code || ""),
    redirect_uri: redirectUri,
    client_id: connection.oidc_client_id,
    client_secret,
  });
  const res = await fetch(connection.oidc_token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });
  const text = await res.text();
  let tokens;
  try { tokens = JSON.parse(text); } catch { throw new OidcError(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`, "OIDC_BAD_TOKEN_RESPONSE"); }
  if (!res.ok || tokens.error) throw new OidcError(tokens.error_description || tokens.error || "token exchange failed", "OIDC_TOKEN_ERROR");
  return tokens;
}

// Fetch the userinfo endpoint with the access token to get the user's claims.
export async function fetchOidcUserInfo(accessToken, connection) {
  if (!connection.oidc_userinfo_url) throw new OidcError("Connection has no userinfo URL", "OIDC_NO_USERINFO_URL");
  const res = await fetch(connection.oidc_userinfo_url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const text = await res.text();
  let info;
  try { info = JSON.parse(text); } catch { throw new OidcError(`UserInfo returned non-JSON: ${text.slice(0, 200)}`, "OIDC_BAD_USERINFO"); }
  if (!res.ok) throw new OidcError(info.error_description || info.error || "userinfo failed", "OIDC_USERINFO_ERROR");
  return info;
}

// Map OIDC userinfo claims to platform fields using the connection's attribute mapping.
// Defaults follow the standard OIDC claim names (email, name, groups).
export function mapOidcClaims(userinfo, connection) {
  const mapping = connection.attribute_mapping || {};
  const emailKey = mapping.email || "email";
  const nameKey = mapping.full_name || "name";
  const groupsKey = mapping.groups || "groups";
  const email = String(userinfo[emailKey] || "").toLowerCase().trim();
  const full_name = String(userinfo[nameKey] || "").slice(0, 100);
  let groups = userinfo[groupsKey];
  if (typeof groups === "string") groups = [groups];
  if (!Array.isArray(groups)) groups = [];
  return { email, full_name, groups: groups.map(String) };
}

export { randomState };