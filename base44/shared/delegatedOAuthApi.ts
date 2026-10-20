// #31G / P-9.9 — the delegated OAuth endpoint handler for generated-app end users.
//
// Lives in shared/ (not inside the function) so the certification suite can invoke the REAL
// request handler in-process with a synthetic Request, proving the endpoint's own contract —
// not a parallel copy of it. functions/delegatedOAuth is a one-line wrapper around this.
//
// The client names AT MOST a connector/provider ID and the opaque state/code/credential_id of
// its own flow. It can NEVER influence the provider configuration: the registry is built
// server-side from the project's own connector documents (base44/connectors/<name>.jsonc,
// parsed by the connector resource contract), whose `delegated_oauth` block names the
// endpoints, scopes and ProjectSecret NAMES — the secret VALUES are resolved from ProjectSecret
// server-side and have no route into any response, log or audit row. An unknown, malformed or
// unconfigured connector is refused fail-closed, and the connect/callback flows additionally
// require the Builder+ entitlement (Base44: app user connectors are a Builder-or-higher feature).
//
// This handler never returns an access token, refresh token, authorization code, client secret or
// PKCE verifier — metadata only (credential_id, provider_id, external_subject, status, scopes,
// expires_at). Audit and trace go through the EXISTING systems (recordAuthEvent / AuditLog).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { resolveSessionRecord, readSessionToken } from "./appAuth.ts";
import { enforceLimit, identityFor } from "./apiLimits.ts";
import { decryptSecretValue } from "./secretCrypto.ts";
import { loadProjectConnectors, buildDelegatedProviders, oauthExchangeHttp, planAllowsAppConnectors } from "./appConnectors.ts";
import { effectivePlan } from "./planLimits.ts";
import { loadAuthorizedProject } from "./authz.ts";
import { requireActiveWorkspace } from "./rbac.ts";
import {
  beginDelegatedOAuth, completeDelegatedOAuth, refreshDelegatedCredential,
  revokeDelegatedCredential, statusDelegatedCredential, listDelegatedCredentials,
} from "./delegatedOAuth.ts";

const svcOf = (b) => b.asServiceRole || b;

// Server-verifiable origins only: the project's DNS-verified (active) custom domains. Request
// headers (Origin/Referer/X-Forwarded-Host) are client-controlled and req.url is the platform
// dispatcher, so neither is trusted. No verified domain → empty list → redirect refused (fail closed).
const verifiedOrigins = async (svc, projectId) => {
  const rows = await svc.entities.CustomDomain.filter({ project_id: projectId, status: "active" }, "-created_date", 50).catch(() => []);
  return [...new Set((rows || []).map((d) => `https://${String(d.hostname || "").toLowerCase()}`).filter((o) => o !== "https://"))];
};

// The builder shell's public base URL: an https ORIGIN only (no path, query, credentials or
// fragment). Anything else → null, which keeps the builder-shell flow closed.
export function builderBaseUrl(value) {
  if (!value) return null;
  let u;
  try { u = new URL(String(value).trim()); } catch { return null; }
  const ok = u.protocol === "https:" && !u.username && !u.password && !u.hash && !u.search && u.pathname === "/" && !String(value).includes("?") && !String(value).includes("#");
  return ok ? u.origin : null;
}

export async function handleDelegatedOAuth(req) {
  try {
    const base44 = createClientFromRequest(req);
    const svc = svcOf(base44);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");

    // Resolve the project. The client names it, but ownership is never trusted from the client —
    // the app user session below is filtered by this project id, so a session from another project
    // resolves to nothing and every operation is refused.
    const projectId = String(body.project_id || "");
    if (!projectId) return Response.json({ error: "project_id is required" }, { status: 400 });
    const project = await svc.entities.Project.get(projectId).catch(() => null);
    if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

    // Resolve the app user from the authenticated session — never from the client.
    const resolved = await resolveSessionRecord(svc, project.id, readSessionToken(req, body));
    let user = resolved ? resolved.user : null;
    // Builder-side surface (Meetings / Plugins connect in the workspace shell): no AppSession
    // exists there, so the authenticated PLATFORM (builder) user acts as the connecting user.
    if (!user) {
      const me = await base44.auth.me().catch(() => null);
      if (me?.id) {
        // The builder must be a member of the project's workspace (project.read, any role). The
        // connection is the caller's own: per-user ownership is enforced by the core. Throws 403.
        const { workspace } = await loadAuthorizedProject(base44, me, project.id, "project.read");
        // Credential-mutating flows stay closed on a suspended/terminated workspace.
        if (["begin", "callback", "refresh", "revoke"].includes(action)) requireActiveWorkspace(workspace, "integration.manage");
        user = { id: me.id, email: me.email || "", display_name: me.full_name || "" };
      }
    }
    if (!user) return Response.json({ error: "Sign in required", code: "AUTH_REQUIRED" }, { status: 401 });

    // Server-side secret resolver: loads from ProjectSecret and decrypts. A missing/unset secret
    // returns undefined, which the core surfaces as OAUTH_CLIENT_NOT_CONFIGURED — a value never
    // has a route out of this closure. The secret NAME comes only from the project's own
    // connector document, never from the request.
    const resolveSecret = async (name) => {
      if (!name) return undefined;
      const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
      const row = rows[0];
      if (!row || !row.value) {
        // Fallback: app-level secrets (the app's own Secrets dashboard) so the builder can
        // configure the OAuth client without a per-project ProjectSecret row.
        const envVal = process.env[String(name)];
        return envVal ? String(envVal) : undefined;
      }
      try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
    };

    // THE REGISTRY — built exclusively from the project's own server-side connector declarations.
    // There is deliberately NO provider field on the request: a client can never name an
    // endpoint, a scope, a secret name or a secret value.
    const providers = buildDelegatedProviders(await loadProjectConnectors(svc, project.id));
    const meta = { trace_id: body.trace_id || null };

    // G-6.4: the OAuth flows mint server-side state rows and exchange codes, so they are metered
    // through the platform's durable limiter, keyed to the resolved app user + project.
    if (action === "begin" || action === "callback") {
      await enforceLimit(base44, { identity: identityFor({ user, workspace_id: project.workspace_id || null }), action: "delegated_oauth", workspace_id: project.workspace_id || null });
      // App user connectors are a Builder+ feature (Base44 parity); enforced on every entry
      // into the flow, never by the UI alone. The builder acting from the workspace shell is
      // already on the builder plan in the real platform, so the gate applies only to the
      // app's own end-user sessions.
      if (resolved) {
        const { plan } = await effectivePlan(svc, project.workspace_id || null);
        if (!planAllowsAppConnectors(plan)) {
          return Response.json({ error: "App user connectors require the Builder plan or higher", code: "PLAN_NOT_ENTITLED" }, { status: 403 });
        }
      }
    }
    if (action === "begin" && !resolved) {
      // Builder-shell flow: the redirect is built ONLY from the server-only BUILDER_PUBLIC_BASE_URL.
      // The body's redirect_uri and Origin/Referer/X-Forwarded-Host are ignored. Missing/invalid → 503.
      const base = builderBaseUrl(process.env.BUILDER_PUBLIC_BASE_URL);
      if (!base) return Response.json({ error: "No server-verifiable callback URL exists for the builder application", code: "BUILDER_REDIRECT_UNAVAILABLE" }, { status: 503 });
      const redirect = `${base}/oauth/callback?connector=${encodeURIComponent(String(body.provider_id || ""))}&project_id=${encodeURIComponent(project.id)}`;
      const result = await beginDelegatedOAuth(svc, project, user, { provider_id: body.provider_id, redirect_uri: redirect, providers, trusted_origins: [base] }, { resolveSecret }, meta);
      return Response.json(result);
    }
    if (action === "begin") {
      const result = await beginDelegatedOAuth(svc, project, user, { provider_id: body.provider_id, redirect_uri: body.redirect_uri, providers, trusted_origins: await verifiedOrigins(svc, project.id) }, { resolveSecret }, meta);
      return Response.json(result);
    }
    if (action === "callback") {
      const result = await completeDelegatedOAuth(svc, project, user, { state: body.state, code: body.code, redirect_uri: resolved ? body.redirect_uri : undefined, providers }, { resolveSecret, http: oauthExchangeHttp }, meta);
      return Response.json(result);
    }
    if (action === "refresh") {
      const result = await refreshDelegatedCredential(svc, project, user, String(body.credential_id || ""), { resolveSecret, http: oauthExchangeHttp }, meta);
      return Response.json(result);
    }
    if (action === "revoke") {
      const result = await revokeDelegatedCredential(svc, project, user, String(body.credential_id || ""), { providers, resolveSecret, http: oauthExchangeHttp }, meta);
      return Response.json(result);
    }
    if (action === "status") {
      const result = await statusDelegatedCredential(svc, project, user, String(body.credential_id || ""));
      return Response.json(result);
    }
    if (action === "list") {
      const result = await listDelegatedCredentials(svc, project, user, { provider_id: body.provider_id || null });
      return Response.json({ credentials: result });
    }
    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status || 500 });
  }
}