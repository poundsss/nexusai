// Targeted P-9.8 parity suite: deployed-app end-user OAuth social sign-in.
//
// Runs against the REAL shipping modules (appAuth / appOAuth / appOAuthProviders / pkce /
// secretCrypto) in a throwaway workspace with two projects, so per-project isolation and
// per-project secret isolation are exercised with actual data. Every provider adapter that
// would touch a real provider is a stub supplied SERVER-side, exactly like appAuthTest's OAuth
// section; the Google registry path is exercised up to the adapter contract (no network).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { signUp, signUpWithSession, logIn, limit, sha256 } from "../../shared/appAuth.ts";
import { beginOAuth, completeOAuth, unlinkIdentity } from "../../shared/appOAuth.ts";
import { pkceChallengeFromVerifier } from "../../shared/pkce.ts";
import {
  buildAppOAuthProviders, GOOGLE_CLIENT_SECRET_NAME, APP_OAUTH_PROVIDER_CATALOG, planAllowsCustomGoogle,
} from "../../shared/appOAuthProviders.ts";
import { encryptSecretValue, decryptSecretValue, hasEncryptionKey } from "../../shared/secretCrypto.ts";
import { DEFAULT_PLANS } from "../../shared/billing.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const PASSWORD = "Sup3r-Secret-Pass!";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const h = createHarness();
  let ws = null;
  try {
    ws = await svc.entities.Workspace.create({ name: "AppOAuth P-9.8 Cert", owner_id: `oc-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    const projectA = await svc.entities.Project.create({ workspace_id: ws.id, name: "OAuth App A", slug: `oa-${crypto.randomUUID().slice(0, 8)}` });
    const projectB = await svc.entities.Project.create({ workspace_id: ws.id, name: "OAuth App B", slug: `ob-${crypto.randomUUID().slice(0, 8)}` });
    const meta = { ip: "203.0.113.7", user_agent: "cert/1.0" };
    h.check("secret_encryption_available", hasEncryptionKey(), "SECRET_ENCRYPTION_KEY present in this environment");

    // Update persists server-side; refresh the LOCAL object so the registry builder sees the
    // settings exactly like the public runtime does (it always loads a fresh project row).
    const setSettings = async (project, providers) => {
      const saved = await svc.entities.Project.update(project.id, { auth_settings: { providers } });
      project.auth_settings = saved?.auth_settings || { providers };
      return saved;
    };
    const resolverFor = (project) => async (name) => {
      const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
      const row = rows[0];
      if (!row || !row.value) return undefined;
      try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
    };
    const setSecret = async (project, value) => {
      const sealed = await encryptSecretValue(project.id, GOOGLE_CLIENT_SECRET_NAME, value);
      const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: GOOGLE_CLIENT_SECRET_NAME }, "name", 1).catch(() => []);
      if (rows[0]) await svc.entities.ProjectSecret.update(rows[0].id, { value: sealed });
      else await svc.entities.ProjectSecret.create({ project_id: project.id, name: GOOGLE_CLIENT_SECRET_NAME, value: sealed, description: "cert", required: true, access: "backend_only" });
    };

    // --- 1. Registry is server-side + fail-closed -----------------------------------------------
    h.check("registry_empty_without_settings", Object.keys(await buildAppOAuthProviders(svc, projectA, { resolveSecret: resolverFor(projectA) })).length === 0, "no settings → no providers");
    await setSettings(projectA, { google: { enabled: true, client_id: "cert-client-id.apps.googleusercontent.com" } });
    h.check("registry_missing_secret_fail_closed", !(await buildAppOAuthProviders(svc, projectA, { resolveSecret: resolverFor(projectA) })).google, "enabled without secret → excluded (no placeholder credentials)");
    await setSecret(projectA, "g-oauth-secret");
    const regA = await buildAppOAuthProviders(svc, projectA, { resolveSecret: resolverFor(projectA) });
    h.check("registry_google_configured_server_side", !!regA.google && regA.google.authorize_url.startsWith("https://accounts.google.com/") && regA.google.pkce === true && regA.google.client_id === "cert-client-id.apps.googleusercontent.com" && typeof regA.google.exchange === "function", Object.keys(regA).join(","));

    await setSettings(projectA, { google: { enabled: false, client_id: "cert-client-id.apps.googleusercontent.com" } });
    const regOff = await buildAppOAuthProviders(svc, projectA, { resolveSecret: resolverFor(projectA) });
    h.check("registry_google_disabled_fail_closed", !regOff.google, "disabled → excluded");
    await h.expectThrow("disabled_provider_refused", () => beginOAuth(svc, projectA.id, { provider: "google" }, { providers: regOff, meta }), "OAUTH_PROVIDER_NOT_CONFIGURED");
    await h.expectThrow("managed_provider_refused_configured_off", () => beginOAuth(svc, projectA.id, { provider: "microsoft" }, { providers: regOff, meta }), "OAUTH_PROVIDER_NOT_CONFIGURED");
    h.check("catalog_declares_credential_sources", APP_OAUTH_PROVIDER_CATALOG.google.credential_source === "project_custom" && ["microsoft", "facebook", "apple"].every((p) => APP_OAUTH_PROVIDER_CATALOG[p].credential_source === "platform_managed"), "google custom; others platform-managed (configured-off)");

    // --- 2. Builder+ entitlement ------------------------------------------------------------------
    const planOf = (code) => DEFAULT_PLANS.find((p) => p.code === code);
    h.check("custom_google_builder_plus_only", planAllowsCustomGoogle(planOf("free")) === false && planAllowsCustomGoogle(planOf("starter_monthly")) === false && planAllowsCustomGoogle(planOf("builder_monthly")) === true && planAllowsCustomGoogle(planOf("pro_monthly")) === true, "free/starter refused, builder+ allowed");

    // --- 3. Secret isolation ------------------------------------------------------------------------
    await setSettings(projectB, { google: { enabled: true, client_id: "b-client-id.apps.googleusercontent.com" } });
    h.check("registry_reads_only_own_project_secrets", !(await buildAppOAuthProviders(svc, projectB, { resolveSecret: resolverFor(projectB) })).google, "A's secret never satisfies B's registry");
    const sealedForA = await encryptSecretValue(projectA.id, GOOGLE_CLIENT_SECRET_NAME, "g-oauth-secret");
    let cross = null;
    try { await decryptSecretValue(projectB.id, GOOGLE_CLIENT_SECRET_NAME, sealedForA); } catch (e) { cross = e; }
    h.check("secret_ciphertext_project_bound", !!cross, "a ciphertext moved to another project cannot be decrypted");

    // --- 4. PKCE S256 in the sign-in flow ------------------------------------------------------------
    let capturedVerifier = null;
    let capturedCode = null;
    const acme = {
      authorize_url: "https://auth.example.com/authorize", client_id: "cid", scopes: ["openid", "email"], pkce: true,
      exchange: async (code, redirect_uri, opts) => { capturedCode = code; capturedVerifier = opts?.pkce_verifier || null; return { subject: "acme-sub-1", email: `pkce-${crypto.randomUUID().slice(0, 6)}@example.com`, display_name: "PKCE User", email_verified: true, profile: {} }; },
    };
    const plain = {
      authorize_url: "https://plain.example.com/authorize", client_id: "cid2", scopes: ["email"],
      exchange: async () => ({ subject: "plain-sub-1", email: `plain-${crypto.randomUUID().slice(0, 6)}@example.com`, display_name: "Plain User", email_verified: false, profile: {} }),
    };
    const flowMeta = { ip: "198.51.100.5" };
    const begun = await beginOAuth(svc, projectA.id, { provider: "acme", redirect_uri: "https://runtime.example.com/app/x/oauth/callback?provider=acme" }, { providers: { acme, plain }, meta: flowMeta });
    const authUrl = new URL(begun.authorization_url);
    const challenge = authUrl.searchParams.get("code_challenge");
    const method = authUrl.searchParams.get("code_challenge_method");
    const [stateRow] = await svc.entities.AppAuthToken.filter({ project_id: projectA.id, kind: "oauth_state", token_hash: await sha256(begun.state) }, "-created_date", 1);
    const storedVerifier = stateRow?.data?.pkce_verifier || null;
    h.check("pkce_s256_challenge_in_authorize_url", method === "S256" && /^[A-Za-z0-9_-]{40,}$/.test(challenge || ""), authUrl.search.slice(0, 140));
    h.check("pkce_verifier_stored_server_side_only", !!storedVerifier && !begun.authorization_url.includes(storedVerifier), "verifier only in the state row");
    h.check("pkce_challenge_matches_verifier", challenge === await pkceChallengeFromVerifier(storedVerifier), "challenge derives from the stored verifier");
    const noPkceUrl = new URL((await beginOAuth(svc, projectA.id, { provider: "plain" }, { providers: { acme, plain }, meta: flowMeta })).authorization_url);
    h.check("pkce_absent_when_provider_unsupported", !noPkceUrl.searchParams.get("code_challenge"), "no verifier, no challenge");

    // --- 5. Callback: exchange, single-use state, replay, provider binding ----------------------------
    const cb = await completeOAuth(svc, projectA.id, { provider: "acme", state: begun.state, code: "code-1" }, { providers: { acme, plain }, meta: flowMeta });
    h.check("pkce_verifier_passed_to_exchange", capturedVerifier === storedVerifier && capturedCode === "code-1" && !!cb.token, "adapter received the state's verifier");
    await h.expectThrow("oauth_state_single_use_replay_rejected", () => completeOAuth(svc, projectA.id, { provider: "acme", state: begun.state, code: "code-2" }, { providers: { acme, plain }, meta: flowMeta }), "TOKEN_USED");
    const mismatch = await beginOAuth(svc, projectA.id, { provider: "plain" }, { providers: { acme, plain }, meta: flowMeta });
    await h.expectThrow("oauth_state_provider_bound", () => completeOAuth(svc, projectA.id, { provider: "acme", state: mismatch.state, code: "x" }, { providers: { acme, plain }, meta: flowMeta }), "OAUTH_STATE_MISMATCH");

    // --- 6. Identity reuse, linking, identity taken, LAST_CREDENTIAL ----------------------------------
    const again = await beginOAuth(svc, projectA.id, { provider: "acme" }, { providers: { acme, plain }, meta: flowMeta });
    const second = await completeOAuth(svc, projectA.id, { provider: "acme", state: again.state, code: "code-3" }, { providers: { acme, plain }, meta: flowMeta });
    h.check("oauth_identity_reused_on_repeat", second.created === false && second.user.id === cb.user.id, `user=${second.user.id}`);

    const linkEmail = `link-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const pwUser = await signUp(svc, projectA.id, { email: linkEmail, password: PASSWORD }, meta);
    const beta = {
      authorize_url: "https://beta.example.com/authorize", client_id: "cid3", scopes: ["email"],
      exchange: async () => ({ subject: "beta-sub-1", email: linkEmail, display_name: "Beta User", email_verified: true, profile: {} }),
    };
    const b1 = await beginOAuth(svc, projectA.id, { provider: "beta" }, { providers: { beta }, meta: flowMeta });
    const linked = await completeOAuth(svc, projectA.id, { provider: "beta", state: b1.state, code: "b1" }, { providers: { beta }, meta: flowMeta });
    h.check("oauth_links_to_existing_email_account", linked.created === false && linked.linked === true && linked.user.id === pwUser.user.id, `user=${linked.user.id}`);

    const other = await signUp(svc, projectA.id, { email: `other-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PASSWORD }, meta);
    const b2 = await beginOAuth(svc, projectA.id, { provider: "beta" }, { providers: { beta }, meta: flowMeta });
    await h.expectThrow("oauth_identity_taken_refused", () => completeOAuth(svc, projectA.id, { provider: "beta", state: b2.state, code: "b2", link_to: { id: other.user.id } }, { providers: { beta }, meta: flowMeta }), "OAUTH_IDENTITY_TAKEN");

    await h.expectThrow("oauth_last_credential_protected", () => unlinkIdentity(svc, projectA, cb.user, { provider: "acme" }, meta), "LAST_CREDENTIAL");
    const unlinked = await unlinkIdentity(svc, projectA, pwUser.user, { provider: "beta" }, meta);
    h.check("oauth_unlink_allowed_with_password", unlinked.ok === true, "a password remains, unlink allowed");

    // --- 7. Project isolation --------------------------------------------------------------------------
    const crossState = await beginOAuth(svc, projectA.id, { provider: "beta" }, { providers: { beta }, meta: flowMeta });
    await h.expectThrow("state_cannot_cross_projects", () => completeOAuth(svc, projectB.id, { provider: "beta", state: crossState.state, code: "b3" }, { providers: { beta }, meta: flowMeta }), "TOKEN_INVALID");

    // --- 8. Durable OAuth rate limits --------------------------------------------------------------------
    const rlMeta = { ip: "198.51.100.99" };
    let beginBlocked = null;
    for (let i = 0; i < 32; i++) {
      try { await beginOAuth(svc, projectA.id, { provider: "beta" }, { providers: { beta }, meta: rlMeta }); }
      catch (e) { beginBlocked = e; break; }
    }
    h.check("oauth_begin_rate_limited", beginBlocked?.code === "RATE_LIMITED", beginBlocked?.code || "no block within 32 begins");
    let callbackBlocked = null;
    for (let i = 0; i < 32; i++) {
      try { await limit(svc, projectA, "app_oauth_callback", "ip:rl-callback"); }
      catch (e) { callbackBlocked = e; break; }
    }
    h.check("oauth_callback_rate_limited", callbackBlocked?.code === "RATE_LIMITED", callbackBlocked?.code || "no block within 32 calls");

    // --- 9. Password auth regression ----------------------------------------------------------------------
    const email = `pw-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const su = await signUpWithSession(svc, projectA.id, { email, password: PASSWORD }, meta);
    h.check("password_signup_regression", !!su.user.id && /^[a-f0-9]{64}$/.test(su.token), "email/password signup unchanged");
    h.check("password_login_regression", (await logIn(svc, projectA.id, { email, password: PASSWORD }, meta)).user.id === su.user.id, "email/password signin unchanged");

    // --- cleanup --------------------------------------------------------------------------------------------
    for (const name of ["AppUser", "AppSession", "AppAuthToken", "AppIdentity"]) {
      for (const p of [projectA.id, projectB.id]) {
        for (const r of await svc.entities[name].filter({ project_id: p }, "-created_date", 500).catch(() => [])) {
          await svc.entities[name].delete(r.id).catch(() => {});
        }
      }
    }
    for (const p of [projectA.id, projectB.id]) {
      for (const r of await svc.entities.ProjectSecret.filter({ project_id: p }, "name", 100).catch(() => [])) {
        await svc.entities.ProjectSecret.delete(r.id).catch(() => {});
      }
    }
    for (const r of await svc.entities.RateLimitBucket.filter({ workspace_id: ws.id }, "-created_date", 500).catch(() => [])) {
      await svc.entities.RateLimitBucket.delete(r.id).catch(() => {});
    }
    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await cleanupWorkspace(svc, ws ? ws.id : null, ["Project", "AuditLog"]).catch(() => {});
  }
}