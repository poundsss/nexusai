// Targeted certification for the app-level SSO configuration surface (Elite+).
//
// Confirms:
//   • Elite gate  — planAllowsAppSso is true ONLY for Elite (tier_rank 7) and above; false for
//     Free/Starter/Builder/Pro. The gate is server-side (planLimits already enforces it on write
//     via the projectAuthSettings Elite check, which mirrors planAllowsAppSso).
//   • Config normalization — projectAuthSettings() surfaces a per-project `sso` block with
//     provider, client_id, scopes, endpoints and the custom-domain toggle, defaulting to
//     disabled/empty when absent.
//   • Callback URL — the documented platform-hosted format
//     https://app.base44.com/api/apps/{APP_ID}/auth/sso/callback, plus the custom-domain variant.
//   • Provider catalog — Google, Microsoft, GitHub, Okta, Advanced/Manual; required fields per
//     provider (client_id always; tenant_id for Microsoft; okta_domain for Okta; endpoints for
//     Advanced). OIDC only.
//   • NO platform-owned SSO work was added to the app — buildAppOAuthProviders (the app's own
//     social-exchange registry) NEVER includes 'sso': the platform owns the SSO callback, code
//     exchange, identity mapping and session minting, so the app has no SSO exchange path.
//
// No real IdP credentials, no real OIDC callback, no real session minting is exercised.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness } from "../../shared/testHarness.ts";
import { seedPlans, getPlan } from "../../shared/billing.ts";
import {
  planAllowsAppSso, projectAuthSettings, ssoCallbackUrl,
  SSO_PROVIDERS, SSO_PROVIDER_KEYS, SSO_PROVIDER_REQUIRED_FIELDS,
  APP_SSO_MIN_TIER_RANK, buildAppOAuthProviders,
} from "../../shared/appOAuthProviders.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check } = h;

  try {
    await seedPlans(svc);

    // 1. Elite gate — tier_rank boundaries.
    const free = await getPlan(svc, "free");
    const starter = await getPlan(svc, "starter_monthly");
    const builder = await getPlan(svc, "builder_monthly");
    const pro = await getPlan(svc, "pro_monthly");
    const elite = await getPlan(svc, "scale_monthly");
    const enterprise = await getPlan(svc, "enterprise");
    check("1. Elite gate: Elite (scale_monthly) tier_rank is 20", Number(elite?.tier_rank) === 20, `tier_rank ${elite?.tier_rank}`);
    check("1. Elite gate: APP_SSO_MIN_TIER_RANK is 20", APP_SSO_MIN_TIER_RANK === 20, String(APP_SSO_MIN_TIER_RANK));
    check("1. Elite gate: Elite+ allowed, below blocked",
      planAllowsAppSso(elite) === true && planAllowsAppSso(enterprise) === true &&
      planAllowsAppSso(free) === false && planAllowsAppSso(starter) === false &&
      planAllowsAppSso(builder) === false && planAllowsAppSso(pro) === false,
      `free=${planAllowsAppSso(free)} starter=${planAllowsAppSso(starter)} builder=${planAllowsAppSso(builder)} pro=${planAllowsAppSso(pro)} elite=${planAllowsAppSso(elite)}`);

    // 2. Config normalization — defaults when absent.
    const empty = projectAuthSettings({ auth_settings: {} });
    check("2. normalization: absent SSO defaults to disabled/empty",
      empty.sso.enabled === false && empty.sso.provider === "" && empty.sso.client_id === "" && empty.sso.custom_domain_callback === false,
      JSON.stringify(empty.sso));
    const populated = projectAuthSettings({ auth_settings: { providers: { sso: {
      enabled: true, provider: "okta", client_id: "0oa123", okta_domain: "acme", scopes: "openid email profile",
    } } } });
    check("2. normalization: populated SSO round-trips",
      populated.sso.enabled === true && populated.sso.provider === "okta" && populated.sso.client_id === "0oa123" && populated.sso.okta_domain === "acme",
      JSON.stringify(populated.sso));
    // Unknown provider is coerced to "" — never stored verbatim.
    const bad = projectAuthSettings({ auth_settings: { providers: { sso: { enabled: true, provider: "saml", client_id: "x" } } } });
    check("2. normalization: unknown provider coerced to empty (OIDC catalog only)",
      bad.sso.provider === "" && SSO_PROVIDER_KEYS.includes("saml") === false,
      `provider "${bad.sso.provider}"`);

    // 3. Callback URL — documented platform-hosted format + custom-domain variant.
    const proj = { id: "686404784ac37377589a1f7f" };
    check("3. callback URL: platform-hosted default",
      ssoCallbackUrl(proj) === "https://app.base44.com/api/apps/686404784ac37377589a1f7f/auth/sso/callback",
      ssoCallbackUrl(proj));
    check("3. callback URL: custom-domain variant",
      ssoCallbackUrl(proj, "app.acme.com") === "https://app.acme.com/api/apps/686404784ac37377589a1f7f/auth/sso/callback",
      ssoCallbackUrl(proj, "app.acme.com"));

    // 4. Provider catalog — the five documented OIDC providers + per-provider required fields.
    check("4. catalog: five documented OIDC providers",
      SSO_PROVIDER_KEYS.length === 5 && ["google", "microsoft", "github", "okta", "advanced"].every((k) => SSO_PROVIDER_KEYS.includes(k)),
      JSON.stringify(SSO_PROVIDER_KEYS));
    check("4. catalog: Google requires client_id only",
      JSON.stringify(SSO_PROVIDER_REQUIRED_FIELDS.google) === JSON.stringify(["client_id"]));
    check("4. catalog: Microsoft requires client_id + tenant_id",
      JSON.stringify(SSO_PROVIDER_REQUIRED_FIELDS.microsoft) === JSON.stringify(["client_id", "tenant_id"]));
    check("4. catalog: Okta requires client_id + okta_domain",
      JSON.stringify(SSO_PROVIDER_REQUIRED_FIELDS.okta) === JSON.stringify(["client_id", "okta_domain"]));
    check("4. catalog: Advanced requires client_id + three endpoints",
      JSON.stringify(SSO_PROVIDER_REQUIRED_FIELDS.advanced) === JSON.stringify(["client_id", "authorize_url", "token_url", "userinfo_url"]));

    // 5. NO platform-owned SSO work in the app: buildAppOAuthProviders (the app's social-exchange
    //    registry) must NEVER include 'sso', even when the project has SSO enabled. The platform
    //    owns the SSO callback/exchange/session; the app has no SSO exchange path.
    const ssoEnabledProject = { id: "p1", auth_settings: { providers: { sso: { enabled: true, provider: "google", client_id: "c" }, google: { enabled: false } } } };
    const registry = await buildAppOAuthProviders(svc, ssoEnabledProject, { resolveSecret: async () => undefined });
    check("5. no app-side SSO exchange: buildAppOAuthProviders never includes 'sso' (platform owns it)",
      !("sso" in registry) && registry.google === undefined,
      `registry keys: ${JSON.stringify(Object.keys(registry))}`);

    const s = h.summary();
    return Response.json({ ok: s.ok, passed: s.passed, failed: s.failed, failures: s.failures, results: s.results });
  } catch (error) {
    const s = h.summary();
    return Response.json({ ok: false, error: error.message, passed: s.passed, failed: s.failed, failures: s.failures, results: s.results }, { status: 500 });
  }
}