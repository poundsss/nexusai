// Deployed-app authentication settings (P-9.8): which social sign-in providers a project's
// end-users may use, and the Google custom OAuth client configuration.
//
// The client_id is a PUBLIC identifier and lives in the project's auth_settings; the client
// SECRET never touches this endpoint's inputs or outputs — it is written through the EXISTING
// projectSecrets flow (GOOGLE_OAUTH_CLIENT_SECRET, encrypted at rest) and this surface only
// reports whether it is set. Custom Google is a Builder+ entitlement, enforced HERE
// server-side on every write — the UI alone decides nothing.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { effectivePlan } from "../../shared/planLimits.ts";
import {
  APP_OAUTH_PROVIDER_CATALOG, projectAuthSettings as normalize, planAllowsCustomGoogle, GOOGLE_CLIENT_SECRET_NAME,
  SSO_CLIENT_SECRET_NAME, SSO_PROVIDERS, SSO_PROVIDER_KEYS, SSO_PROVIDER_REQUIRED_FIELDS,
  planAllowsAppSso, ssoCallbackUrl,
} from "../../shared/appOAuthProviders.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "get");
    // Reading settings is a project read; writing them is a project write. Role and workspace
    // lifecycle are enforced at this choke point, exactly like every other project surface.
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, String(body.project_id || ""), action === "get" ? "project.read" : "project.write",
    );
    const svc = base44.asServiceRole;

    if (action === "get") {
      const { plan } = await effectivePlan(svc, workspace.id);
      const secrets = await svc.entities.ProjectSecret.filter({ project_id: project.id }, "name", 100).catch(() => []);
      const has = (name) => secrets.some((s) => s.name === name && s.value);
      // Verified custom domains: only an 'active' domain is servable, so the custom-domain SSO
      // callback toggle is offered only when one exists. No new verification contract.
      const domains = await svc.entities.CustomDomain.filter({ project_id: project.id, status: "active" }, "-created_date", 50).catch(() => []);
      const primaryDomain = domains.find((d) => d.is_primary) || domains[0] || null;
      const sso = normalize(project).sso;
      const callbackHost = sso.custom_domain_callback && primaryDomain ? primaryDomain.hostname : null;
      return Response.json({
        settings: normalize(project),
        visibility: project.visibility || "public",
        catalog: APP_OAUTH_PROVIDER_CATALOG,
        google_secret_set: has(GOOGLE_CLIENT_SECRET_NAME),
        custom_google_allowed: planAllowsCustomGoogle(plan),
        sso: {
          settings: sso,
          secret_set: has(SSO_CLIENT_SECRET_NAME),
          allowed: planAllowsAppSso(plan),
          providers: SSO_PROVIDERS,
          callback_url: ssoCallbackUrl(project, callbackHost),
          custom_domain_available: !!primaryDomain,
          custom_domain_hostname: primaryDomain?.hostname || null,
        },
        plan_code: plan?.code || "free",
      });
    }

    if (action === "set") {
      const patch = body.settings && typeof body.settings === "object" ? body.settings : {};
      const google = patch.google && typeof patch.google === "object" ? patch.google : {};
      const current = normalize(project);
      const next = { google: { ...current.google } };
      if (google.enabled !== undefined) next.google.enabled = google.enabled === true;
      if (google.client_id !== undefined) {
        const cid = String(google.client_id || "").trim();
        if (cid && (cid.length > 200 || !/^[A-Za-z0-9._-]+$/.test(cid))) {
          return Response.json({ error: "Invalid Google client ID" }, { status: 400 });
        }
        next.google.client_id = cid;
      }
      // Enabling Google with custom credentials is a Builder+ entitlement — enforced
      // server-side, never by the UI alone.
      const { plan } = await effectivePlan(svc, workspace.id);
      if (next.google.enabled && next.google.client_id && !planAllowsCustomGoogle(plan)) {
        return Response.json({ error: "Custom Google OAuth requires the Builder plan or higher", code: "PLAN_NOT_ENTITLED" }, { status: 403 });
      }
      // App Visibility (who can open the app): 'public' | 'private' | 'workspace'. Written here
      // server-side through the same authorized surface as the other auth settings; no new role
      // matrix. 'public_login_required' is deliberately NOT accepted (UNKNOWN availability).
      const visibility = String(body.visibility || "");
      const VISIBILITY_MODES = ["public", "private", "workspace"];
      if (visibility && !VISIBILITY_MODES.includes(visibility)) {
        return Response.json({ error: "Invalid visibility", code: "INVALID_VISIBILITY" }, { status: 400 });
      }
      // App-level SSO (Elite+). The platform owns the OIDC callback/exchange/session; this surface
      // persists ONLY the per-project configuration. Enabling SSO is an Elite+ entitlement,
      // enforced server-side on write — the UI alone decides nothing.
      const sso = patch.sso && typeof patch.sso === "object" ? patch.sso : null;
      if (sso) {
        const { plan } = await effectivePlan(svc, workspace.id);
        if (!planAllowsAppSso(plan)) {
          return Response.json({ error: "Single sign-on requires the Elite plan or higher", code: "PLAN_SSO_NOT_INCLUDED" }, { status: 403 });
        }
        const provider = SSO_PROVIDER_KEYS.includes(sso.provider) ? sso.provider : "";
        const enabled = sso.enabled === true;
        if (enabled && !provider) {
          return Response.json({ error: "An SSO provider is required", code: "SSO_NO_PROVIDER" }, { status: 400 });
        }
        const cur = normalize(project).sso;
        const str = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
        const nextSso = {
          enabled,
          provider,
          client_id: str(sso.client_id ?? cur.client_id, 200),
          scopes: str(sso.scopes ?? cur.scopes, 200) || (provider ? SSO_PROVIDERS[provider].default_scopes : ""),
          discovery_url: str(sso.discovery_url ?? cur.discovery_url, 500),
          tenant_id: str(sso.tenant_id ?? cur.tenant_id, 200),
          okta_domain: str(sso.okta_domain ?? cur.okta_domain, 200),
          authorize_url: str(sso.authorize_url ?? cur.authorize_url, 500),
          token_url: str(sso.token_url ?? cur.token_url, 500),
          userinfo_url: str(sso.userinfo_url ?? cur.userinfo_url, 500),
          custom_domain_callback: sso.custom_domain_callback === true ? true : (sso.custom_domain_callback === false ? false : cur.custom_domain_callback),
        };
        // Provider-specific required fields (client_id always; plus tenant_id/okta_domain/endpoints).
        if (enabled) {
          const required = SSO_PROVIDER_REQUIRED_FIELDS[provider] || [];
          for (const f of required) {
            if (!nextSso[f]) {
              return Response.json({ error: `SSO provider "${provider}" requires ${f}`, code: "SSO_MISSING_FIELD" }, { status: 400 });
            }
          }
          if (sso.custom_domain_callback === true) {
            const domains = await svc.entities.CustomDomain.filter({ project_id: project.id, status: "active" }, "-created_date", 50).catch(() => []);
            if (!domains.length) {
              return Response.json({ error: "Custom-domain SSO callback requires a verified custom domain", code: "SSO_NO_CUSTOM_DOMAIN" }, { status: 400 });
            }
          }
        }
        next.sso = nextSso;
      } else {
        next.sso = normalize(project).sso;
      }

      const projectPatch = { auth_settings: { providers: next } };
      if (visibility) projectPatch.visibility = visibility;
      await svc.entities.Project.update(project.id, projectPatch);
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: "auth_settings.updated", resource: "Project", resource_id: project.id,
        metadata: { google_enabled: next.google.enabled, google_client_id_set: !!next.google.client_id, sso_enabled: !!next.sso?.enabled, sso_provider: next.sso?.provider || null, visibility: visibility || (project.visibility || "public") },
      });
      return Response.json({ settings: next, visibility: visibility || (project.visibility || "public") });
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}