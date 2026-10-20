// Focused certification for #31G — User-Delegated OAuth.
//
// Exercises the delegated OAuth core (delegatedOAuth.ts) directly through every operation, plus the
// connector execution path (executeProjectFunction → createIntegrationsApi → externalTools) with a
// delegated credential selector, proving the resolver injects the bearer and redacts the token.
// Only the OAuth provider's token endpoint and the integration's upstream are scripted; everything
// else is the real shared code on real (scratch) entities.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { createPasswordlessUser, createSession } from "../../shared/appAuth.ts";
import { normalizeIntegration, serializeIntegration, integrationPath } from "../../shared/integrations.ts";
import { packFileContent } from "../../shared/blobStore.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import {
  beginDelegatedOAuth, completeDelegatedOAuth, refreshDelegatedCredential,
  revokeDelegatedCredential, statusDelegatedCredential, listDelegatedCredentials,
  createDelegatedCredentialResolver,
} from "../../shared/delegatedOAuth.ts";
import { decryptWithAad } from "../../shared/secretCrypto.ts";

const TOKEN_HOST = "oauth.example.test";
// The outbound HTTP path's SSRF gate (assertResolvedUrl) resolves DNS for REAL and fails
// closed on unresolvable hosts, so the scripted upstream must be a PUBLIC IP LITERAL: the
// guard passes IP literals through without DNS, and the scripted fetch below intercepts the
// request before any real network contact. A fake .test hostname can never pass the gate.
const UPSTREAM_HOST = "93.184.216.34";
const CLIENT_ID = "test_client_id_31g";
const CLIENT_SECRET = "test_client_secret_31g_never_leak";
const ACCESS_TOKEN = "at_live_31g_abc123neverleak";
const REFRESH_TOKEN = "rt_live_31g_xyz789neverleak";
const ROTATED_REFRESH = "rt_rotated_31g_qq11";
const ROTATED_ACCESS = "at_rotated_31g_bb22";

const mockJson = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const h = createHarness();
  const realFetch = globalThis.fetch;
  let workspace = null;
  let project = null, otherProj = null;
  let userA = null, userB = null;
  let capturedUpstreamAuth = null;

  // Script the OAuth provider's token endpoint and the integration upstream. Both are counted so
  // "the resolver injected the bearer" is proven from the actual outbound header, not assumed.
  const tokenHits = {};
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname === TOKEN_HOST) {
      tokenHits[u.pathname] = (tokenHits[u.pathname] || 0) + 1;
      if (u.pathname === "/token") {
        const form = new URLSearchParams(String(options.body || ""));
        if (form.get("grant_type") === "authorization_code") {
          return mockJson({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600, scope: "read write", sub: "ext-sub-42", email: "ext@example.test", profile: { name: "Ext User" } });
        }
        if (form.get("grant_type") === "refresh_token") {
          return mockJson({ access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, expires_in: 3600, scope: "read write" });
        }
      }
      if (u.pathname === "/revoke") return mockJson({ ok: true });
      return mockJson({ error: "unexpected token path" }, 500);
    }
    if (u.hostname === UPSTREAM_HOST) {
      capturedUpstreamAuth = options.headers?.Authorization || null;
      return mockJson({ ok: true, whoami: "upstream" });
    }
    return realFetch(url, options);
  };

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `DelOAuth ${Date.now()}`, owner_id: caller.id, credits_balance: 0 });
    project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `DelOAuth ${Date.now()}`, slug: `do-${Date.now()}` });
    otherProj = await svc.entities.Project.create({ workspace_id: workspace.id, name: `DelOAuth Other ${Date.now()}`, slug: `doo-${Date.now()}` });

    userA = await createPasswordlessUser(svc, project, { email: "a@deloauth.test", display_name: "User A", email_verified: true });
    userB = await createPasswordlessUser(svc, project, { email: "b@deloauth.test", display_name: "User B", email_verified: true });

    // Set the OAuth client secrets as project secrets (encrypted at rest by the platform).
    await svc.entities.ProjectSecret.create({ project_id: project.id, name: "OAUTH_CLIENT_ID", value: "", description: "Delegated OAuth client_id", required: true, access: "backend_only" });
    await svc.entities.ProjectSecret.create({ project_id: project.id, name: "OAUTH_CLIENT_SECRET", value: "", description: "Delegated OAuth client_secret", required: true, access: "backend_only" });
    const secRows = await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 100);
    const { encryptSecretValue } = await import("../../shared/secretCrypto.ts");
    for (const row of secRows) {
      if (row.name === "OAUTH_CLIENT_ID") await svc.entities.ProjectSecret.update(row.id, { value: await encryptSecretValue(project.id, row.name, CLIENT_ID) });
      if (row.name === "OAUTH_CLIENT_SECRET") await svc.entities.ProjectSecret.update(row.id, { value: await encryptSecretValue(project.id, row.name, CLIENT_SECRET) });
    }

    const providers = {
      ext: {
        authorization_endpoint: `https://${TOKEN_HOST}/authorize`,
        token_endpoint: `https://${TOKEN_HOST}/token`,
        revoke_endpoint: `https://${TOKEN_HOST}/revoke`,
        client_id_secret: "OAUTH_CLIENT_ID",
        client_secret_secret: "OAUTH_CLIENT_SECRET",
        scopes: ["read", "write"],
        pkce: true,
      },
    };

    const resolveSecret = async (name) => {
      const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
      const row = rows[0];
      if (!row || !row.value) return undefined;
      const { decryptSecretValue } = await import("../../shared/secretCrypto.ts");
      try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
    };
    const http = async (url, options = {}) => {
      const res = await fetch(String(url), options);
      const text = await res.text();
      let parsed = text;
      const type = res.headers.get("content-type") || "";
      if (type.includes("json")) { try { parsed = JSON.parse(text); } catch { /* keep text */ } }
      return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed };
    };

    // ---- 1. begin ----
    const begun = await beginDelegatedOAuth(svc, project, userA, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    h.check("1a. begin returns a state and authorization_url", !!begun.state && typeof begun.authorization_url === "string" && begun.provider_id === "ext", JSON.stringify(begun));
    h.check("1b. begin embeds the state in the authorization_url", new URL(begun.authorization_url).searchParams.get("state") === begun.state, begun.authorization_url);

    // ---- 2. PKCE ----
    const begunUrl = new URL(begun.authorization_url);
    h.check("2a. PKCE: the challenge is present (S256)", begunUrl.searchParams.get("code_challenge_method") === "S256" && !!begunUrl.searchParams.get("code_challenge"), begunUrl.searchParams.get("code_challenge_method"));
    h.check("2b. PKCE: the verifier is NOT returned to the caller", !JSON.stringify(begun).includes("verifier"), JSON.stringify(begun));
    const stateRow = (await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "delegated_oauth_state", token_hash: await (await import("../../shared/appAuth.ts")).sha256(begun.state) }, "-created_date", 1))[0];
    h.check("2c. PKCE: the verifier is stored server-side in the state row", !!stateRow?.data?.pkce_verifier, JSON.stringify(stateRow?.data || {}));

    // ---- 3. state single-use ----
    const begun2 = await beginDelegatedOAuth(svc, project, userA, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    const completed = await completeDelegatedOAuth(svc, project, userA, { state: begun2.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http });
    h.check("3a. callback consumes the state and returns a credential", !!completed.credential_id && completed.status === "active", JSON.stringify(completed));
    await h.expectThrow("3b. a second callback with the same state is refused (single-use)", async () => completeDelegatedOAuth(svc, project, userA, { state: begun2.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http }), "OAUTH_STATE_USED");

    // ---- 3c. concurrent same-state callbacks: exactly one consumes the state ----
    const begunRace = await beginDelegatedOAuth(svc, project, userA, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    const raceCall = () => completeDelegatedOAuth(svc, project, userA, { state: begunRace.state, code: "ac_race", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http })
      .then((r) => ({ ok: true, credential_id: r.credential_id }))
      .catch((e) => ({ ok: false, code: e.code, status: e.status }));
    const [raceA, raceB] = await Promise.all([raceCall(), raceCall()]);
    const raceWins = [raceA, raceB].filter((r) => r.ok);
    const raceRefusals = [raceA, raceB].filter((r) => !r.ok);
    h.check("3c. of two concurrent callbacks on one state exactly one succeeds", raceWins.length === 1 && raceRefusals.length === 1 && raceRefusals[0].code === "OAUTH_STATE_USED" && raceRefusals[0].status === 410, JSON.stringify([raceA, raceB]).slice(0, 220));

    // ---- 4. state expiration ----
    const begunExp = await beginDelegatedOAuth(svc, project, userA, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    const expRow = (await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "delegated_oauth_state", token_hash: await (await import("../../shared/appAuth.ts")).sha256(begunExp.state) }, "-created_date", 1))[0];
    await svc.entities.AppAuthToken.update(expRow.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await h.expectThrow("4a. an expired state is refused", async () => completeDelegatedOAuth(svc, project, userA, { state: begunExp.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http }), "OAUTH_STATE_EXPIRED");

    // ---- 5. replay refusal (already-used state) ----
    await h.expectThrow("5a. replaying the first completed state is refused (already used)", async () => completeDelegatedOAuth(svc, project, userA, { state: begun2.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http }), "OAUTH_STATE_USED");

    // ---- 6. cross-project refusal ----
    const begunCross = await beginDelegatedOAuth(svc, project, userA, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    await h.expectThrow("6a. a state from project A cannot be completed in project B", async () => completeDelegatedOAuth(svc, otherProj, userA, { state: begunCross.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http }), "OAUTH_STATE_INVALID");

    // ---- 7. cross-user refusal ----
    const begunUserB = await beginDelegatedOAuth(svc, project, userB, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    await h.expectThrow("7a. a state issued to user B cannot be completed by user A", async () => completeDelegatedOAuth(svc, project, userA, { state: begunUserB.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http }), "OAUTH_STATE_MISMATCH");

    // ---- 8. successful callback / code exchange ----
    const begunOk = await beginDelegatedOAuth(svc, project, userA, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    const cred = await completeDelegatedOAuth(svc, project, userA, { state: begunOk.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http });
    h.check("8a. callback returns a credential_id and external_subject", cred.credential_id && cred.external_subject === "ext-sub-42", JSON.stringify(cred));
    h.check("8b. callback returns scopes, never a token", Array.isArray(cred.scopes) && cred.scopes.includes("read") && !JSON.stringify(cred).includes(ACCESS_TOKEN) && !JSON.stringify(cred).includes(REFRESH_TOKEN), JSON.stringify(cred));

    // ---- 9. encrypted credential storage ----
    const credRow = (await svc.entities.DelegatedCredential.filter({ project_id: project.id, credential_id: cred.credential_id }, "-created_date", 1))[0];
    h.check("9a. the access token is stored encrypted (not plaintext)", !!credRow.encrypted_access_token && !credRow.encrypted_access_token.includes(ACCESS_TOKEN), credRow.encrypted_access_token?.slice(0, 20));
    h.check("9b. the refresh token is stored encrypted (not plaintext)", !!credRow.encrypted_refresh_token && !credRow.encrypted_refresh_token.includes(REFRESH_TOKEN), credRow.encrypted_refresh_token?.slice(0, 20));
    h.check("9c. the credential row records the app_user_id server-side", credRow.app_user_id === userA.id, `${credRow.app_user_id} vs ${userA.id}`);

    // ---- 10. refresh + rotation ----
    // Force expiry so the resolver / refresh path runs.
    await svc.entities.DelegatedCredential.update(credRow.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const refreshed = await refreshDelegatedCredential(svc, project, userA, cred.credential_id, { resolveSecret, http });
    h.check("10a. refresh returns active status", refreshed.status === "active", JSON.stringify(refreshed));
    h.check("10b. refresh rotated the refresh token (count incremented)", refreshed.rotated === true, JSON.stringify(refreshed));
    const refreshedRow = (await svc.entities.DelegatedCredential.filter({ project_id: project.id, credential_id: cred.credential_id }, "-created_date", 1))[0];
    h.check("10c. the new access token is stored encrypted (not the old or new plaintext)", !!refreshedRow.encrypted_access_token && !refreshedRow.encrypted_access_token.includes(ACCESS_TOKEN) && !refreshedRow.encrypted_access_token.includes(ROTATED_ACCESS), refreshedRow.encrypted_access_token?.slice(0, 20));
    h.check("10d. the rotation count incremented", (refreshedRow.refresh_rotation_count || 0) >= 1, String(refreshedRow.refresh_rotation_count));

    // ---- 11. revoke ----
    const revoked = await revokeDelegatedCredential(svc, project, userA, cred.credential_id, { providers, resolveSecret, http });
    h.check("11a. revoke returns revoked status", revoked.status === "revoked", JSON.stringify(revoked));
    const revokedRow = (await svc.entities.DelegatedCredential.filter({ project_id: project.id, credential_id: cred.credential_id }, "-created_date", 1))[0];
    h.check("11b. the credential row is revoked", revokedRow.status === "revoked" && !!revokedRow.revoked_at, JSON.stringify({ status: revokedRow.status, revoked_at: revokedRow.revoked_at }));
    await h.expectThrow("11c. a revoked credential cannot be refreshed", async () => refreshDelegatedCredential(svc, project, userA, cred.credential_id, { resolveSecret, http }), "OAUTH_CREDENTIAL_REVOKED");

    // ---- 12. identity linking ----
    const identRows = await svc.entities.AppIdentity.filter({ project_id: project.id, provider: "ext", provider_subject: "ext-sub-42" }, "-created_date", 5);
    h.check("12a. an AppIdentity was created for the external subject", identRows.length >= 1 && identRows[0].app_user_id === userA.id, JSON.stringify(identRows.map((i) => ({ app_user_id: i.app_user_id, subject: i.provider_subject }))));
    // Re-authorize the same external account: should update in place, not create a second credential.
    const begunRelink = await beginDelegatedOAuth(svc, project, userA, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    const relinked = await completeDelegatedOAuth(svc, project, userA, { state: begunRelink.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http });
    h.check("12b. re-authorizing the same subject reuses the same credential_id", relinked.credential_id === cred.credential_id, `${relinked.credential_id} vs ${cred.credential_id}`);
    const credCount = (await svc.entities.DelegatedCredential.filter({ project_id: project.id, external_subject: "ext-sub-42" }, "-created_date", 10)).length;
    h.check("12c. re-authorize did not create a second credential row", credCount === 1, String(credCount));
    // A subject linked to user A cannot be linked to user B.
    const begunB = await beginDelegatedOAuth(svc, project, userB, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    await h.expectThrow("12d. a subject linked to user A cannot be linked to user B", async () => completeDelegatedOAuth(svc, project, userB, { state: begunB.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http }), "OAUTH_IDENTITY_TAKEN");

    // ---- 13. credential ownership ----
    await h.expectThrow("13a. user B cannot read user A's credential status", async () => statusDelegatedCredential(svc, project, userB, cred.credential_id), "OAUTH_CREDENTIAL_MISMATCH");
    const listA = await listDelegatedCredentials(svc, project, userA);
    const listB = await listDelegatedCredentials(svc, project, userB);
    h.check("13b. list returns user A's credential to user A", listA.some((c) => c.credential_id === cred.credential_id), JSON.stringify(listA.map((c) => c.credential_id)));
    h.check("13c. list never returns user A's credential to user B", !listB.some((c) => c.credential_id === cred.credential_id), JSON.stringify(listB.map((c) => c.credential_id)));

    // ---- 14. delegated connector execution through the existing resolver ----
    // Create a fresh, active credential for user A (the revoked one can't be selected).
    const begunExec = await beginDelegatedOAuth(svc, project, userA, { provider_id: "ext", redirect_uri: "https://app.example.test/cb", providers }, { resolveSecret });
    const execCred = await completeDelegatedOAuth(svc, project, userA, { state: begunExec.state, code: "ac_test", providers, redirect_uri: "https://app.example.test/cb" }, { resolveSecret, http });
    // Declare an integration whose own auth is "none" — the delegated credential takes over.
    const integDoc = normalizeIntegration({ name: "extapi", type: "http", base_url: `https://${UPSTREAM_HOST}/v1`, auth: { type: "none" }, operations: [{ name: "ping", method: "GET", path: "/me" }] });
    const stored = await packFileContent(svc, integrationPath(integDoc.name), serializeIntegration(integDoc));
    await svc.entities.ProjectFile.create({ project_id: project.id, path: integrationPath(integDoc.name), ...stored, frozen: false });
    const argsJson = JSON.stringify({ credential: { kind: "delegated", credential_id: execCred.credential_id } });
    const source = `export const config = { method: 'POST' };\n` +
      `export default async function handler(ctx) {\n` +
      `  try {\n` +
      `    const r = await ctx.integrations.extapi.ping({}, ${argsJson});\n` +
      `    return { status: 200, body: { ok: true, status: r.status, preview: typeof r.body === "string" ? r.body.slice(0, 300) : JSON.stringify(r.body ?? null).slice(0, 300) } };\n` +
      `  } catch (e) {\n` +
      `    return { status: 200, body: { ok: false, code: e.code, kind: e.details?.kind, message: e.message } };\n` +
      `  }\n}\n`;
    capturedUpstreamAuth = null;
    const trace_id = `t_do_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const result = await executeProjectFunction(svc, {
      project, entities: [], integrations: [integDoc], name: "delegatedExecTest", source, trigger: "test",
      requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: {} },
      messagingTransport: "test", trace_id, quotas: { timeoutMs: 20000 }, user: { id: userA.id, email: userA.email },
    });
    h.check("14a. the delegated connector call succeeded", result.body?.ok === true, JSON.stringify(result.body));
    h.check("14b. the resolver injected the bearer into the upstream Authorization header", capturedUpstreamAuth === `Bearer ${ACCESS_TOKEN}`, capturedUpstreamAuth);

    // Cross-user: user B's function selecting user A's credential is refused.
    const argsJsonB = JSON.stringify({ credential: { kind: "delegated", credential_id: execCred.credential_id } });
    const sourceB = `export const config = { method: 'POST' };\n` +
      `export default async function handler(ctx) {\n` +
      `  try {\n` +
      `    const r = await ctx.integrations.extapi.ping({}, ${argsJsonB});\n` +
      `    return { status: 200, body: { ok: true } };\n` +
      `  } catch (e) {\n` +
      `    return { status: 200, body: { ok: false, code: e.code, kind: e.details?.kind, message: e.message } };\n` +
      `  }\n}\n`;
    capturedUpstreamAuth = null;
    const resultB = await executeProjectFunction(svc, {
      project, entities: [], integrations: [integDoc], name: "delegatedExecTestB", source: sourceB, trigger: "test",
      requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: {} },
      messagingTransport: "test", trace_id: `t_db_${Date.now().toString(36)}`, quotas: { timeoutMs: 20000 }, user: { id: userB.id, email: userB.email },
    });
    h.check("14c. user B selecting user A's credential is refused (no upstream contact)", resultB.body?.ok === false && resultB.body?.kind === "credential_user_mismatch" && capturedUpstreamAuth === null, JSON.stringify(resultB.body));

    // ---- 15. secret / token redaction ----
    const invRows = await svc.entities.IntegrationInvocation.filter({ project_id: project.id, integration_name: "extapi" }, "-created_date", 10);
    const invJson = JSON.stringify(invRows);
    h.check("15a. the access token never enters the IntegrationInvocation record", !invJson.includes(ACCESS_TOKEN) && !invJson.includes(ROTATED_ACCESS), `found: ${invJson.includes(ACCESS_TOKEN)}`);
    const spans = await svc.entities.TraceEvent.filter({ project_id: project.id, trace_id }, "at", 50);
    const spanJson = JSON.stringify(spans);
    h.check("15b. the access token never enters a trace span", !spanJson.includes(ACCESS_TOKEN) && !spanJson.includes(REFRESH_TOKEN), `found: ${spanJson.includes(ACCESS_TOKEN)}`);
    const audits = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 100);
    const auditJson = JSON.stringify(audits);
    h.check("15c. the access/refresh token never enters an audit row", !auditJson.includes(ACCESS_TOKEN) && !auditJson.includes(REFRESH_TOKEN) && !auditJson.includes(CLIENT_SECRET), `found: ${auditJson.includes(ACCESS_TOKEN)}`);
    h.check("15d. the status projection never includes an encrypted or plaintext token", !JSON.stringify(await statusDelegatedCredential(svc, project, userA, execCred.credential_id)).includes("token"), "status leaked a token field");
  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}`);
  } finally {
    globalThis.fetch = realFetch;
    for (const p of [project, otherProj]) {
      if (!p) continue;
      for (const entity of ["ProjectFile", "ProjectSecret", "AuditLog", "IntegrationInvocation", "IntegrationQuota", "IntegrationBreaker", "IntegrationRateLimit", "TraceEvent", "FunctionInvocation", "AppAuthToken", "AppIdentity", "AppSession", "DelegatedCredential", "AppUser"]) {
        await purgeBy(svc, entity, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    if (workspace) await cleanupWorkspace(svc, workspace.id, []);
  }

  return harnessResponse(h);
}