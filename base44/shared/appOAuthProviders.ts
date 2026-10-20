// Server-side OAuth provider registry for deployed-app end-user social sign-in (P-9.8).
//
// The registry is ALWAYS built here, server-side, from the project's own auth settings plus its
// ProjectSecret rows — never from a browser request. A provider appears in the registry only
// when it is BOTH enabled in the project's settings AND fully credentialled; everything else is
// fail-closed OAUTH_PROVIDER_NOT_CONFIGURED at the appOAuth layer.
//
// Credential sources (Base44-verified):
//   • google — per-project CUSTOM client credentials (Builder+ entitlement). The client_id is a
//     public identifier stored in the project's auth settings; the client secret lives ONLY in
//     ProjectSecret (GOOGLE_OAUTH_CLIENT_SECRET), encrypted at rest with AAD binding, and is
//     read here solely to perform the server-side code exchange. It has no route into any
//     response, log, audit row or stored identity.
//   • microsoft / facebook / apple — Base44 uses MANAGED credentials for these. This platform has
//     no managed-credential infrastructure, so they are deliberately left configured-off: they
//     stay in the catalog (known names, so they are refused as not-configured rather than
//     unknown) but can never appear in a registry until that infrastructure exists. No
//     placeholder, invented or fake credential is ever produced.
import { scrub } from "./tracing.ts";
import { fail, normalizeEmail } from "./appAuth.ts";

export const GOOGLE_CLIENT_SECRET_NAME = "GOOGLE_OAUTH_CLIENT_SECRET";

// Custom Google OAuth is a Builder+ entitlement (Base44: "Builder plan or higher"). The Builder
// tier's rank in this platform's own plan ladder — the gate is enforced on the settings WRITE.
export const CUSTOM_GOOGLE_MIN_TIER_RANK = 6;
export const planAllowsCustomGoogle = (plan) => (plan?.tier_rank || 0) >= CUSTOM_GOOGLE_MIN_TIER_RANK;

// --- App-level SSO (Elite+) -----------------------------------------------------
// App-level SSO lets a published app's END USERS sign in through an external OIDC identity
// provider. Distinct from workspace/Enterprise SSO (builder team, Enterprise-gated): app SSO is
// per-project, Elite-gated, and the PLATFORM owns the entire OIDC dance — the callback
// (https://app.base44.com/api/apps/{APP_ID}/auth/sso/callback), the code exchange, the identity
// mapping and the session minting. This surface owns ONLY the per-project CONFIGURATION: which
// provider, its public client_id + endpoints, and a client secret sealed in ProjectSecret.
// No SSO callback function, no OIDC exchange and no AppUser/AppSession minting exists here.
export const SSO_CLIENT_SECRET_NAME = "SSO_CLIENT_SECRET";
// Elite is tier_rank 20 (scale_monthly/scale_yearly); Enterprise is 30. Pro is tier_rank 10, so a
// threshold of 20 excludes Pro and everything below it — "Elite plan or higher". Enforced server-side on write.
export const APP_SSO_MIN_TIER_RANK = 20;
export const planAllowsAppSso = (plan) => (plan?.tier_rank || 0) >= APP_SSO_MIN_TIER_RANK;

// The documented SSO providers (Setting-up-SSO): Google Workspace, Microsoft Azure AD, GitHub,
// Okta, and Advanced/Manual for any OIDC-compatible IdP. OIDC only — SAML is not app-level SSO.
export const SSO_PROVIDERS = {
  google: { label: "Google Workspace", default_scopes: "openid email profile" },
  microsoft: { label: "Microsoft Azure AD", default_scopes: "openid email profile" },
  github: { label: "GitHub", default_scopes: "user:email" },
  okta: { label: "Okta", default_scopes: "openid email profile" },
  advanced: { label: "Advanced / Manual OIDC", default_scopes: "openid email profile" },
};
export const SSO_PROVIDER_KEYS = Object.keys(SSO_PROVIDERS);

// Provider-specific REQUIRED config fields (the documented setup inputs). The client_secret is
// ALWAYS required but lives in ProjectSecret, so it is not listed here.
export const SSO_PROVIDER_REQUIRED_FIELDS = {
  google: ["client_id"],
  microsoft: ["client_id", "tenant_id"],
  github: ["client_id"],
  okta: ["client_id", "okta_domain"],
  advanced: ["client_id", "authorize_url", "token_url", "userinfo_url"],
};

// The platform-owned callback URL for this app (DOCUMENTED format). The builder registers it with
// their IdP. `app_id` is the project id (the app ID in the editor URL).
export const ssoCallbackUrl = (project, hostname = null) => {
  const host = hostname ? String(hostname) : "app.base44.com";
  return `https://${host}/api/apps/${encodeURIComponent(String(project?.id || ""))}/auth/sso/callback`;
};

// The catalog: every provider the runtime recognizes, with its credential source.
export const APP_OAUTH_PROVIDER_CATALOG = {
  google: { label: "Google", credential_source: "project_custom" },
  microsoft: { label: "Microsoft", credential_source: "platform_managed" },
  facebook: { label: "Facebook", credential_source: "platform_managed" },
  apple: { label: "Apple", credential_source: "platform_managed" },
};

const GOOGLE = {
  authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
  token_url: "https://oauth2.googleapis.com/token",
  userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo",
  scopes: ["openid", "email", "profile"],
  pkce: true,
};

/** Normalized per-project auth settings (defaults for absent fields). */
export function projectAuthSettings(project) {
  const s = project?.auth_settings && typeof project.auth_settings === "object" ? project.auth_settings : {};
  const providers = s.providers && typeof s.providers === "object" ? s.providers : {};
  const google = providers.google && typeof providers.google === "object" ? providers.google : {};
  const ssoRaw = providers.sso && typeof providers.sso === "object" ? providers.sso : {};
  const str = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
  return {
    google: {
      enabled: google.enabled === true,
      client_id: str(google.client_id, 200),
    },
    sso: {
      enabled: ssoRaw.enabled === true,
      provider: SSO_PROVIDER_KEYS.includes(ssoRaw.provider) ? ssoRaw.provider : "",
      client_id: str(ssoRaw.client_id, 200),
      scopes: str(ssoRaw.scopes, 200),
      discovery_url: str(ssoRaw.discovery_url, 500),
      tenant_id: str(ssoRaw.tenant_id, 200),
      okta_domain: str(ssoRaw.okta_domain, 200),
      authorize_url: str(ssoRaw.authorize_url, 500),
      token_url: str(ssoRaw.token_url, 500),
      userinfo_url: str(ssoRaw.userinfo_url, 500),
      custom_domain_callback: ssoRaw.custom_domain_callback === true,
    },
  };
}

// Google adapter: exchanges the code server-side and returns ONLY the identity. The client
// secret is resolved inside this closure and never leaves it; no provider token is stored,
// logged or returned — same never_returned contract as the appOAuth foundation.
const googleExchange = ({ client_id, resolveSecret }) => async (code, redirect_uri, { pkce_verifier = null } = {}) => {
  const client_secret = await resolveSecret(GOOGLE_CLIENT_SECRET_NAME);
  if (!client_secret) fail(503, "OAUTH_CLIENT_NOT_CONFIGURED", "The Google OAuth client secret is not configured for this application");
  const body = new URLSearchParams({ code: String(code || ""), client_id, client_secret, grant_type: "authorization_code" });
  if (redirect_uri) body.set("redirect_uri", String(redirect_uri));
  if (pkce_verifier) body.set("code_verifier", String(pkce_verifier));
  const tokenRes = await fetch(GOOGLE.token_url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const token = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !token?.access_token) fail(502, "OAUTH_EXCHANGE_FAILED", "The sign-in provider rejected the authorization code");
  const infoRes = await fetch(GOOGLE.userinfo_url, { headers: { Authorization: `Bearer ${token.access_token}` } });
  const info = await infoRes.json().catch(() => null);
  if (!infoRes.ok || !info?.sub) fail(502, "OAUTH_IDENTITY_INVALID", "The sign-in provider returned no identity");
  return {
    subject: String(info.sub),
    email: normalizeEmail(info.email || ""),
    display_name: String(info.name || "").slice(0, 100),
    email_verified: info.email_verified === true,
    profile: scrub({ name: info.name || null, picture: info.picture || null }),
  };
};

/**
 * Builds the registry for one project. Server-side only. `resolveSecret(name)` returns the
 * decrypted ProjectSecret value for THIS project (the same contract the delegated OAuth flow
 * uses); a missing secret simply keeps the provider OUT of the registry — fail-closed, never a
 * placeholder credential.
 */
export async function buildAppOAuthProviders(svc, project, { resolveSecret }) {
  const registry = {};
  if (typeof resolveSecret !== "function") return registry;
  const settings = projectAuthSettings(project);
  // Google: enabled + custom client_id + set client secret. The Builder+ entitlement is
  // enforced when the settings are WRITTEN; a later downgrade keeps the paid-for period
  // running per the billing model, and a mis-credentialled project still resolves to no
  // provider at all.
  if (settings.google.enabled && settings.google.client_id) {
    // Probe the secret WITHOUT keeping its value: existence decides availability only.
    const configured = (await resolveSecret(GOOGLE_CLIENT_SECRET_NAME)) !== undefined;
    if (configured) {
      registry.google = {
        authorize_url: GOOGLE.authorize_url,
        client_id: settings.google.client_id,
        scopes: GOOGLE.scopes,
        pkce: GOOGLE.pkce,
        exchange: googleExchange({ client_id: settings.google.client_id, resolveSecret }),
      };
    }
  }
  return registry;
}