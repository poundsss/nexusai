// PUBLIC production runtime for deployed applications.
// (rebuild marker: shared-module refresh, r8 — G-2 public-serving lifecycle gate)
//
// This is the only surface a deployed app talks to, and it is deliberately the narrowest
// one on the platform. It is NOT a second runtime: it serves an immutable artifact and
// reuses the existing sandboxed function executor and the existing project-scoped data
// accessor.
//
// SECURITY MODEL — a production app is anonymous and holds no builder identity:
//   • The caller supplies ONLY a public slug. It cannot name a project, version, artifact
//     or deployment id, so it cannot address anything but the slug's LIVE deployment.
//   • Scope is derived server-side: slug → Project → production_deployment_id → Deployment
//     (must be LIVE) → its immutable artifact. A non-live or superseded deployment is
//     unreachable, and one slug resolves to exactly one project.
//   • The service role is used to READ that project's own rows only; every db operation is
//     bound to the resolved project id by createServerDb.
//   • Backend function SOURCE comes from the artifact, never from the project's mutable
//     working files, so editing in the builder cannot change production behaviour.
//   • Secret values are resolved inside the executor and redacted from every response.
//     Nothing here ever returns a secret, a function source, or another project's data.
//   • No control-plane operation is reachable: no builder entity, no deployment mutation,
//     no project mutation, no MCP, no AI run.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadArtifactPayload, currentLiveDeployment, assertPublicServing } from "../../shared/deploy.ts";
import { handleAppPublicSettings, APP_PUBLIC_SETTINGS_OPS } from "../../shared/appPublicSettings.ts";
import { badgeVisible } from "../../shared/platformBadge.ts";
import { badgeRemovalEntitled } from "../../shared/planLimits.ts";
import { parseAppSlug, pointerFields } from "../../shared/environments.ts";
import { resolveHostname } from "../../shared/domains.ts";
import { matchRedirect } from "../../shared/pageRedirects.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { runProjectFunctionFetch } from "../../shared/appFetch.ts";
import { createServerDb, readEntityEvents } from "../../shared/appData.ts";
import { importEntitiesIntoDb } from "../../shared/appImport.ts";
// THE row-level-security contract. Used here only to decide whether an end-user session must be
// resolved; every rule is evaluated inside createServerDb through the same single evaluator.
import { anyEntityRls } from "../../shared/rls.ts";
import { anyFieldReadRules } from "../../shared/fieldRls.ts";
import { allowRequest, RATE_LIMIT_CONFIG } from "../../shared/rateLimit.ts";
import {
  signUp, logIn, logOut, resolveSession, resolveSessionRecord, refreshSession, changePassword,
  updateProfile, requestPasswordReset, confirmPasswordReset, verifyOtp, resendOtp,
  publicUser, publicSession, readSessionToken, sessionCookieHeader, clearSessionCookieHeader,
  createAnonymousSession, resolveAnonymousSession, inviteAppUser,
} from "../../shared/appAuth.ts";
import { resolvePermissions, can, listTeams, createTeam, addTeamMember, removeTeamMember, listTeamMembers } from "../../shared/appAccess.ts";
// THE one identity projection handed to a generated app's frontend, shared with the builder
// preview, so both surfaces describe the same verified end-user with the same semantics.
import { identityEnvelope } from "../../shared/appAuthContext.ts";
import { listIdentities, unlinkIdentity, beginOAuth, completeOAuth, validatePostLoginUrl } from "../../shared/appOAuth.ts";
import { createServerFiles } from "../../shared/appFiles.ts";
// P-9.8: the server-side social-sign-in provider registry — built ONLY here, from the project's
// own auth settings + ProjectSecret, never from a browser request.
import { buildAppOAuthProviders } from "../../shared/appOAuthProviders.ts";
// P-9.9 App User Connectors: the deployed runtime's connect / disconnect / connections
// operations and the connector OAuth callback completion — registry from the artifact,
// current-session user only, Builder+ entitlement enforced server-side.
import { handleAppConnectors, completeAppConnectorCallback, oauthExchangeHttp } from "../../shared/appConnectors.ts";
import { decryptSecretValue } from "../../shared/secretCrypto.ts";
import { sendEmail } from "../../shared/appMessaging.ts";
import { runtimeNotificationsRoute } from "../../shared/runtimeNotificationsRoute.ts";
// IntegrationsModule parity: the Core.* endpoints + custom.call dispatch, shared with the
// builder preview — ONE module owns the mapping onto the existing primitives.
import { handleAppIntegrations, APP_INTEGRATION_OPS } from "../../shared/appIntegrations.ts";
import { withSecurityHeaders, appSecurityConfig } from "../../shared/securityHeaders.ts";
// G-A: the invoke path additionally accepts genuine multipart/form-data (SDK 0.8.52 wire).
import { isMultipartInvoke, parseMultipartInvokeBody } from "../../shared/multipartInvoke.ts";
import { handleAnalyticsRuntime } from "../../shared/analyticsRuntime.ts";
// THE realtime surface of a deployed app: an adapter over the EXISTING actor runtime (rooms,
// state, events, presence). No second realtime engine, state store or permission model.
import { handleRealtimeRuntime } from "../../shared/realtimeRuntime.ts";
// Read-only discovery of the app's declared agents and connectors. Execution stays where it already
// lives (the run pipeline / the backend-function runtime); nothing here can run either.
import { handleAgentsRuntime, handleConnectorsRuntime } from "../../shared/sdkDiscovery.ts";
// P-9.4: EXECUTION of the app's declared in-app agents — server-side, fail-closed, billed
// through the existing canonical paths. Discovery stays in sdkDiscovery; the browser only
// ever sees reply text and ids.
import { handleAppAgent } from "../../shared/appAgentRuntime.ts";
// P-9.10A: the Telegram channel foundation — connect-URL issuance for the CURRENT signed-in
// app user. The activation binding and the public webhook live in appAgentChannels /
// appChannelWebhook.
import { handleAppChannelConnect, telegramHttp } from "../../shared/appAgentChannels.ts";
// P-10.3 phase 3: the NATIVE-app bearer-token path. Additive only — the web cookie session
// contract above is untouched; this path activates solely on an Authorization: Bearer header.
import { readBearerToken, resolveMobileRuntimeTarget } from "../../shared/mobileRuntime.ts";
// Published SEO surfaces (additive): /sitemap.xml and /robots.txt builders over the app's
// EXISTING data (page routes + App Visibility) — no new storage, no invented SEO behavior.
import { validPublishedBaseUrl, buildPublishedRobotsTxt, buildPublishedSitemapXml } from "../../shared/publishedSeo.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;
const DB_OPS = ["filter", "page", "get", "create", "update", "delete", "count", "aggregate", "upsert", "bulkCreate", "bulkUpdate", "bulkDelete", "updateWhere", "deleteWhere", "updateMany", "deleteMany", "events", "importEntities"];

// The request's own origin — the ONLY source for OAuth callback URLs, so they are platform-host
// agnostic and never hardcoded to a specific hostname.
function requestOrigin(req) {
  try { const u = new URL(req.url); if (u.origin && u.origin !== "null") return u.origin; } catch { /* fall through */ }
  const host = req.headers.get("host");
  return host ? `${req.headers.get("x-forwarded-proto") || "https"}://${host}` : null;
}

// slug (optionally carrying the staging suffix) or a verified custom hostname → project +
// environment. Both are PUBLIC identifiers: the caller still cannot name a project, version,
// artifact or deployment id, and an unverified hostname resolves to nothing at all.
async function resolveTarget(svc, body) {
  if (body.host) {
    const resolved = await resolveHostname(svc, body.host);
    if (!resolved) throw Object.assign(new Error("Application not found"), { status: 404 });
    const project = await svc.entities.Project.get(resolved.project_id).catch(() => null);
    if (!project) throw Object.assign(new Error("Application not found"), { status: 404 });
    return { project, environment: resolved.environment };
  }
  const { slug, environment } = parseAppSlug(body.slug);
  if (!SLUG_RE.test(slug)) throw Object.assign(new Error("Application not found"), { status: 404 });
  const projects = await svc.entities.Project.filter({ slug }, "slug", 1);
  if (!projects[0]) throw Object.assign(new Error("Application not found"), { status: 404 });
  return { project: projects[0], environment };
}

async function resolveLive(svc, body, presetTarget = null, sessionToken = null) {
  // A mobile bearer token presets the target: the project is DERIVED from the token itself,
  // so the slug/host addressing the web runtime uses is not consulted for resolution at all.
  const { project, environment } = presetTarget || await resolveTarget(svc, body);
  // G-2 lifecycle + App Visibility: a suspended/terminated workspace or archived project is
  // refused, and (for private/workspace apps) an authenticated app user is required. This is the
  // ONE choke point every public request resolves through, so the gate covers artifact delivery,
  // data, functions, agents and every other action alike. The 'auth' action is exempt from the
  // visibility requirement so a private/workspace app can be opened after login; the suspension
  // and archive gates still apply to it. The shared gate (deploy.ts) is the single implementation
  // every public surface and certification test exercises.
  await assertPublicServing(svc, project, { sessionToken, action: String(body.action || "artifact") });
  // What an environment serves is DERIVED: the newest LIVE, non-superseded deployment of
  // this project IN THAT ENVIRONMENT. The project's pointer is only a cache, so a deployment
  // interrupted mid-switch leaves the previous version serving instead of taking the app
  // offline, and a staging deployment can never be served as production.
  const fields = pointerFields(environment);
  const pointed = project[fields.deployment]
    ? await svc.entities.Deployment.get(project[fields.deployment]).catch(() => null)
    : null;
  const deployment = pointed && pointed.status === "LIVE" && !pointed.superseded_at && pointed.project_id === project.id
    && (pointed.environment || "production") === environment
    ? pointed
    : await currentLiveDeployment(svc, project, environment);
  if (!deployment || deployment.project_id !== project.id) {
    throw Object.assign(new Error("Application not found"), { status: 404 });
  }
  const artifact = await svc.entities.DeploymentArtifact.get(deployment.artifact_id).catch(() => null);
  if (!artifact || artifact.project_id !== project.id) throw Object.assign(new Error("Application unavailable"), { status: 503 });
  return { project, environment, deployment, artifact, payload: await loadArtifactPayload(artifact) };
}

// Every response of this endpoint carries the platform's security headers (CSP, nosniff,
// no-referrer, no-store, restrictive Permissions-Policy). Applied here, once, so no branch
// below can accidentally answer without them.
export default async function (req) {
  return withSecurityHeaders(await handleRuntime(req));
}

async function handleRuntime(req) {
  try {
    const client = createClientFromRequest(req);
    const svc = client.asServiceRole;
    // G-A: multipart/form-data invoke requests (the documented SDK 0.8.52 wire for File
    // parameters) are parsed into the SAME envelope every action below already reads; the
    // JSON path is untouched. functions.fetch is NOT changed — a multipart fetch-mode body
    // carries no `fetch` args and is refused by that branch as before.
    const body = isMultipartInvoke(req) ? await parseMultipartInvokeBody(req) : await req.json();
    const action = String(body.action || "artifact");
    // Mobile runtime authentication (P-10.3 phase 3): a native client presents a
    // workspace-scoped, revocable bearer token. The project is DERIVED from the token, the
    // token cannot address another app, and the end-user session resolution below (cookies,
    // body tokens, RLS evaluation) is unchanged for both paths.
    const bearer = readBearerToken(req, body);
    let mobileTarget = null;
    if (bearer) {
      // The project is DERIVED from the token; a slug/host may only name the SAME app —
      // the shared resolver enforces both and refuses expired/revoked tokens.
      // A non-mobile Bearer credential (e.g. the platform's own service token on an internal
      // svc.functions.invoke) is not a mobile runtime token: resolution failure falls through
      // to the normal web path instead of refusing the request. Strict refusals for real
      // mobile tokens are unchanged and stay certified at the module level (mobileRuntimeTest).
      try {
        const target = await resolveMobileRuntimeTarget(svc, bearer, { slug: body.slug, host: body.host });
        mobileTarget = { project: target.project, environment: target.environment };
      } catch {
        mobileTarget = null;
      }
    }
    // Public rate limit for the data and function paths (not the artifact bundle fetch).
    // Best-effort, per-instance: see shared/rateLimit.ts. Fails open to preserve behavior.
    if (action === "db" || action === "fn" || action === "auth" || action === "files" || action === "analytics" || action === "realtime" || action === "agents" || action === "connectors" || action === "agent" || action === "channel" || action === "integrations" || action === "notifications" || action === "app") {
      try {
        if (!allowRequest(req, String(body.slug || body.host || mobileTarget?.project.slug || ""), action)) {
          return Response.json({ error: "Too many requests. Please try again later." }, { status: 429, headers: { "Retry-After": String(Math.ceil(RATE_LIMIT_CONFIG.WINDOW_MS / 1000)) } });
        }
      } catch {
        // Fail open: a limiter fault must never block a legitimate request or leak internals.
      }
    }
    // 0) AppModule parity (SDK 0.8.52 `base44.app.getPublicSettings()`): the DOCUMENTED
    //    "before app boot" surface. It deliberately does NOT resolve a live deployment —
    //    its purpose is to decide how the app should render BEFORE serving — and it reuses
    //    the EXISTING public-serving gate (assertPublicServing) unchanged. The shared handler
    //    (appPublicSettings.ts) owns the visibility mapping and the documented 403 envelope;
    //    only { id, public_settings } is ever returned.
    if (action === "app") {
      if (!APP_PUBLIC_SETTINGS_OPS.includes(String(body.op || ""))) {
        return Response.json({ error: `Unsupported app operation ${body.op || ""}` }, { status: 400 });
      }
      const { project } = await resolveTarget(svc, body);
      try {
        const result = await handleAppPublicSettings(svc, project, { sessionToken: readSessionToken(req, body) });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null, ...(e.extra_data ? { extra_data: e.extra_data } : {}) }, { status: e.status || 400 });
      }
    }
    const { project, environment, deployment, artifact, payload } = await resolveLive(svc, body, mobileTarget, readSessionToken(req, body));

    // 1) Serve the client bundle. Only client files ship — function sources and
    //    integration credentials stay server-side.
    if (action === "artifact") {
      // Path-level 301 redirects: only the PAGE-serving path evaluates them. The host page
      // sends the visitor's pathname + search; the decision is made server-side (authoritative)
      // and returned as a directive the host honors. Excluded paths are never redirected, and
      // the separate data/API runtime below is untouched.
      if (typeof body.path === "string" && body.path) {
        const rules = await svc.entities.PageRedirect.filter({ project_id: project.id }, "created_date", 50);
        const hit = matchRedirect(rules, body.path, typeof body.search === "string" ? body.search : "");
        if (hit) return Response.json({ redirect: { status: 301, location: hit.location } });
      }
      return Response.json({
        // Additive SEO metadata (NexusAI-native): description from the project's declared app
        // config (.app.jsonc) or its creation description; icon only as an ASSET NAME from the
        // artifact's own config — no public asset URL exists, so nothing more is exposed.
        // Existing fields and every other action are unchanged.
        app: {
          name: project.name, slug: project.slug, environment,
          description: payload.config?.app?.description || project.description || null,
          // Project logo (the documented "Edit logo" surface): a public URL the published runtime
          // renders as the browser favicon and home-screen icon. Absent (no logo) is null, so
          // AppHeadMeta leaves the platform default favicon untouched. Additive only.
            logo_url: project.logo_url || null,
            ...(payload.config?.app?.icon ? { icon: payload.config.app.icon } : {}),
            // Platform Badge visibility (documented Base44): shown by default; hidden when the
            // project set badge_hidden AND the workspace is Starter+ (re-checked here, so a
            // downgraded plan re-shows it); always hidden for private apps. The entitlement is
            // resolved SERVER-side only when badge_hidden is set, so a free-plan app that never
            // touched the setting pays no extra plan lookup. The host page renders the badge from
            // this flag alone — never from a client claim.
            badge: { visible: badgeVisible(project, project.badge_hidden ? await badgeRemovalEntitled(svc, { id: project.workspace_id }) : false) },
          },
        deployment: { id: deployment.id, environment, version_number: deployment.version_number, checksum: artifact.checksum, deployed_at: deployment.completed_at },
        files: payload.client_files,
        // B5: digest-verified package modules (module text only); null when none are pinned.
        package_modules: payload.package_modules || null,
        entities: payload.entities,
        entry: payload.config.entry,
        // Server-owned document policy: the CSP and the iframe sandbox tokens the host page
        // must apply to this app. Decided here, not in the browser.
        security: appSecurityConfig(),
      });
    }

    // Published SEO surfaces (additive): the documented well-known files every published
    // site serves — /sitemap.xml (page URLs) and /robots.txt (crawl directives). Built from
    // the project's EXISTING data only (its page routes and its App Visibility); the URL base
    // is the requesting host's own origin, validated before use — no asset URL is invented
    // and no new storage exists. The full public-serving gate above applies unchanged, so
    // visibility behavior here is exactly the app's own.
    if (action === "seo") {
      const op = String(body.op || "");
      if (op !== "sitemap" && op !== "robots") {
        return Response.json({ error: `Unsupported seo operation ${op}` }, { status: 400 });
      }
      const base = validPublishedBaseUrl(body.base_url);
      if (!base) return Response.json({ error: "A valid https origin base_url is required" }, { status: 400 });
      // The URL base is the app's own canonical URL root: on a verified custom domain the origin
      // itself; on the built-in domain the /app/<slug> path the app is served under (the slug that
      // resolved this very request, so a staging suffix carries through). The prefix is the
      // platform's own serving path — never an invented URL.
      const urlBase = body.host ? base : `${base}/app/${body.slug || project.slug}`;
      if (op === "robots") {
        return Response.json({ content: buildPublishedRobotsTxt(project.visibility || "public", urlBase), content_type: "text/plain" });
      }
      return Response.json({ content: buildPublishedSitemapXml(urlBase, payload.client_files), content_type: "application/xml" });
    }

    // End-user authentication for the deployed app. Accounts and sessions are scoped to
    // this project and stored in its own data (reserved rows); no platform builder account
    // is created. The session token travels only between this runtime and the host page,
    // never the generated frontend (see PublicApp.jsx).
    if (action === "auth") {
      const op = String(body.op || "");
      // Security metadata + the delivery hook for single-use secrets. The raw reset/verification
      // secret goes ONLY to the project's email transport; it never enters a response or a log.
      const meta = {
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        user_agent: req.headers.get("user-agent") || null,
        sendEmail: (msg) => sendEmail(svc, project.id, { to: [msg.to], subject: msg.subject, body: msg.text }),
      };
      // Every authenticated op re-resolves the session server-side; the request cannot assert
      // who it is, and another project's token resolves to nothing here.
      const authed = async () => {
        const resolved = await resolveSessionRecord(svc, project.id, readSessionToken(req, body));
        if (!resolved) throw Object.assign(new Error("Sign in required"), { status: 401, code: "AUTH_REQUIRED" });
        return { user: publicUser(resolved.user), session: publicSession(resolved.session), row: resolved.user };
      };
      const args = body.args || {};
      try {
        let result, headers;
        if (op === "signup") {
          // G-2: register creates the UNVERIFIED user and issues the OTP challenge — no
          // session, no cookie. The session first exists at verify_otp, the documented
          // transition that returns the access token for the now-verified user.
          // G-4 transport parity: register's optional wire fields travel VERBATIM into the auth
          // call (snake_case wire form or the camelCase alias) — the SDK posts the register
          // payload unchanged. Accepted, never validated, transformed, persisted or logged;
          // server semantics stay UNKNOWN (G-4 audit).
          const r = await signUp(svc, project.id, { email: body.email ?? args.email, password: body.password ?? args.password, full_name: body.full_name ?? args.full_name, turnstile_token: body.turnstile_token ?? args.turnstile_token ?? body.turnstileToken ?? args.turnstileToken, referral_code: body.referral_code ?? args.referral_code ?? body.referralCode ?? args.referralCode }, meta);
          result = { ...identityEnvelope({}), user: r.user, verification_sent: r.verification_sent };
        } else if (op === "login") {
          // G-4 transport parity: the optional SDK wire field travels into the auth call VERBATIM
          // (snake_case wire form or the camelCase alias). Accepted, never validated, transformed,
          // persisted or logged — server semantics stay UNKNOWN (G-4 audit); the auth layer
          // ignores unknown input keys, so omitted-field behavior is unchanged.
          const r = await logIn(svc, project.id, { email: body.email ?? args.email, password: body.password ?? args.password, turnstile_token: body.turnstile_token ?? args.turnstile_token ?? body.turnstileToken ?? args.turnstileToken }, meta);
          const perms = await resolvePermissions(svc, project, { roles: r.user.roles });
          result = { ...identityEnvelope({ user: r.user, session: r.session, roles: perms.roles, permissions: perms.permissions }), session_token: r.token };
          headers = { "Set-Cookie": sessionCookieHeader(r.token) };
        } else if (op === "can") {
          // Permission evaluation stays SERVER-side: the app asks, it never decides.
          const resolved = await resolveSessionRecord(svc, project.id, readSessionToken(req, body));
          const perms = resolved ? await resolvePermissions(svc, project, resolved.user) : { roles: [], permissions: [] };
          result = {
            allowed: !!resolved && can(perms.permissions, String(args.permission || "")),
            ...identityEnvelope(resolved ? { user: publicUser(resolved.user), session: publicSession(resolved.session), roles: perms.roles, permissions: perms.permissions } : {}),
          };
        } else if (op === "refresh") {
          const r = await refreshSession(svc, project.id, readSessionToken(req, body), meta);
          const perms = await resolvePermissions(svc, project, { roles: r.user.roles });
          result = { ...identityEnvelope({ user: r.user, session: r.session, roles: perms.roles, permissions: perms.permissions }), session_token: r.token };
          headers = { "Set-Cookie": sessionCookieHeader(r.token) };
        } else if (op === "logout") {
          // Ends the GENERATED-APP session only — no platform identity is involved here at all.
          // SDK logout(redirectUrl) parity (SDK 0.8.52): the optional post-logout destination
          // travels as redirect_url and is validated with the SAME fail-closed validator the
          // OAuth from_url uses, against the request's own serving origin. The session is ALWAYS
          // cleared first — a refused destination never blocks the logout — and the HOST page
          // (the only layer that can navigate top-level) performs the redirect when one
          // validates. Omitted → unchanged behavior.
          await logOut(svc, project.id, readSessionToken(req, body), meta);
          let redirect_url = null;
          try { redirect_url = validatePostLoginUrl(args.redirect_url ?? body?.redirect_url, requestOrigin(req)); } catch { redirect_url = null; }
          result = { ok: true, ...(redirect_url ? { redirect_url } : {}), ...identityEnvelope({}) };
          headers = { "Set-Cookie": clearSessionCookieHeader() };
        } else if (op === "me") {
          const resolved = await resolveSessionRecord(svc, project.id, readSessionToken(req, body));
          const perms = resolved ? await resolvePermissions(svc, project, resolved.user) : { roles: [], permissions: [] };
          result = identityEnvelope(resolved ? { user: publicUser(resolved.user), session: publicSession(resolved.session), roles: perms.roles, permissions: perms.permissions } : {});
        } else if (op === "change_password") {
          const a = await authed();
          result = await changePassword(svc, project.id, { user: a.user, session: a.session }, { current_password: args.current_password, new_password: args.new_password }, meta);
        } else if (op === "update_profile") {
          result = { user: await updateProfile(svc, project.id, (await authed()).user, args, meta) };
        } else if (op === "request_password_reset") {
          result = await requestPasswordReset(svc, project.id, { email: body.email || args.email }, meta);
        } else if (op === "confirm_password_reset") {
          result = await confirmPasswordReset(svc, project.id, { token: args.token, new_password: args.new_password }, meta);
        } else if (op === "verify_otp" || op === "verify_email") {
          // G-2: verification ESTABLISHES the session — the access token (and cookie) for the
          // now-verified user. The legacy op name stays as an alias for existing callers.
          const r = await verifyOtp(svc, project.id, { email: body.email ?? args.email, otpCode: args.otpCode ?? args.token }, meta);
          const perms = await resolvePermissions(svc, project, { roles: r.user.roles });
          result = { ...identityEnvelope({ user: r.user, session: r.session, roles: perms.roles, permissions: perms.permissions }), ok: true, session_token: r.access_token };
          headers = { "Set-Cookie": sessionCookieHeader(r.access_token) };
        } else if (op === "resend_otp" || op === "resend_verification") {
          // G-2: pre-auth, email-keyed — no session is required or implied.
          result = await resendOtp(svc, project.id, { email: body.email || args.email }, meta);
        } else if (op === "invite_user") {
          // G-5: the DOCUMENTED deployed-app invitation surface — auth.inviteUser(userEmail, role) /
          // users.inviteUser(user_email, role), which the docs publish as equivalent. The caller
          // must hold a live session; the role rule is enforced inside the shared primitive through
          // the EXISTING app permission model. PROVEN (Base44 runtime probe): the successful
          // response is HTTP 200 with the EXACT body { "id": "<app_id>" } and NO platform User row
          // is created. The primitive's { ok, user, invitation_sent } answer stays the INTERNAL
          // projection (the dashboard app-users surface) — only its persistence, invitation token
          // and delivery ride it; the public body is the proven shape alone.
          const a = await authed();
          const perms = await resolvePermissions(svc, project, a.row);
          await inviteAppUser(svc, project, { id: a.user.id, roles: perms.roles }, { user_email: body.user_email ?? args.user_email, role: body.role ?? args.role }, meta);
          result = { id: project.id };
        } else if (op === "redirect_login") {
          // auth.redirectToLogin(nextUrl) parity: pure destination resolution/validation with the
          // EXISTING fail-closed validator (the same one the logout redirect_url and the OAuth
          // from_url use), resolved against the request's own serving origin. No session, user,
          // token or rate-limit semantics — the HOST page owns the navigation and the login surface.
          result = { from_url: validatePostLoginUrl(args.next_url ?? body.next_url ?? null, requestOrigin(req)) };
        } else if (op === "teams") {
          result = { teams: await listTeams(svc, project, (await authed()).user) };
        } else if (op === "create_team") {
          result = { team: await createTeam(svc, project, (await authed()).user, args, meta) };
        } else if (op === "team_members") {
          result = { members: await listTeamMembers(svc, project, (await authed()).user, args.team_id) };
        } else if (op === "add_team_member") {
          result = await addTeamMember(svc, project, (await authed()).user, args, meta);
        } else if (op === "remove_team_member") {
          result = await removeTeamMember(svc, project, (await authed()).user, args, meta);
        } else if (op === "identities") {
          result = { identities: await listIdentities(svc, project, (await authed()).user) };
        } else if (op === "unlink_identity") {
          result = await unlinkIdentity(svc, project, (await authed()).user, args, meta);
        } else if (op === "providers" || op === "oauth_begin" || op === "oauth_callback") {
          // Social sign-in (P-9.8). The provider registry is ALWAYS built server-side from the
          // project's auth settings + ProjectSecret — the browser names at most a provider id,
          // and an unconfigured or disabled provider is refused fail-closed. The Google client
          // secret is resolved inside the registry builder and never leaves it.
          const resolveSecret = async (name) => {
            if (!name) return undefined;
            const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
            const row = rows[0];
            if (!row || !row.value) return undefined;
            try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
          };
          const providers = await buildAppOAuthProviders(svc, project, { resolveSecret });
          if (op === "providers") {
            // Safe metadata ONLY: which providers this app may actually offer today. A provider
            // that is not fully credentialled is absent — never shown to the app's login UI.
            result = { providers: Object.keys(providers) };
          } else if (op === "oauth_begin") {
            // The redirect URI is DERIVED server-side from the request's own origin and the
            // addressing the caller used (slug route or custom domain) — platform-host agnostic,
            // never a hardcoded hostname.
            const origin = requestOrigin(req);
            const base = body.host ? "/~app/oauth/callback" : `/app/${String(body.slug || "")}/oauth/callback`;
            const provider = String(args.provider || "");
            result = await beginOAuth(svc, project.id, { provider, redirect_uri: origin ? `${origin}${base}?provider=${encodeURIComponent(provider)}` : null, from_url: args.from_url ?? body.from_url }, { providers, meta, origin });
          } else if (args.connector) {
            // Connector OAuth completion (P-9.9): the SAME callback route as social sign-in, but
            // the state is a delegated_oauth_state and the registry is the artifact's connector
            // declarations. The client's `connector` value is a dispatch hint only — the
            // single-use state names the provider server-side, and the answer is metadata.
            const resolved = await resolveSessionRecord(svc, project.id, readSessionToken(req, body));
            if (!resolved) throw Object.assign(new Error("Sign in required"), { status: 401, code: "AUTH_REQUIRED" });
            result = await completeAppConnectorCallback(svc, {
              project, connectors: payload.connectors || [], user: resolved.user,
              state: args.state, code: args.code, meta, resolveSecret, http: oauthExchangeHttp,
            });
          } else {
            const r = await completeOAuth(svc, project.id, { provider: args.provider, state: args.state, code: args.code }, { providers, meta });
            const perms = await resolvePermissions(svc, project, { roles: r.user.roles });
            result = { ...identityEnvelope({ user: r.user, session: r.session, roles: perms.roles, permissions: perms.permissions }), session_token: r.token, provider: r.provider, linked: r.linked, created: r.created };
            headers = { "Set-Cookie": sessionCookieHeader(r.token) };
          }
        } else {
          return Response.json({ error: `Unsupported auth operation ${op}` }, { status: 400 });
        }
        return Response.json(result, { status: 200, headers });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
      }
    }

    // 2) Database access for the running app, scoped to this project only.
    //    When the project has RLS enabled, the end-user is resolved from the session and
    //    createServerDb enforces per-user ownership server-side. Anonymous apps (rls off)
    //    keep their existing open-data behavior — no user resolution, no isolation.
    if (action === "db") {
      const op = String(body.op || "");
      if (!DB_OPS.includes(op)) return Response.json({ error: `Unsupported operation ${op}` }, { status: 400 });
      const rls = !!project.rls_enabled;
      // The end-user is resolved when the project uses legacy owner isolation OR any deployed
      // entity declares its own RLS — a declarative rule needs the user even with the flag off.
      // `rls` itself is unchanged, so legacy owner-isolation behaviour is untouched.
      const needsUser = rls || anyEntityRls(payload.entities || []) || anyFieldReadRules(payload.entities || []);
      const sessionToken = needsUser ? readSessionToken(req, body) : null;
      const user = needsUser ? await resolveSession(svc, project.id, sessionToken).catch(() => null) : null;
      const db = createServerDb(svc, project.id, payload.entities, { rls, user, fieldRules: true });
      const args = body.args || {};
      // B-stage (entities.subscribe): the events read the client's bounded subscribe poll
      // rides — the SAME visibility contract as the read path (readEntityEvents). The entity
      // must be part of this deployment's artifact; another project's events are unreachable
      // because the query is bound to the resolved project id.
      if (op === "events") {
        try {
          return Response.json({ result: await readEntityEvents(svc, project.id, payload.entities, { rls, user, fieldRules: true }, args) });
        } catch (e) {
          const status = e.status || (e.code === "AUTH_REQUIRED" ? 401 : e.code === "DATABASE_ENTITY_NOT_FOUND" ? 404 : 400);
          return Response.json({ error: e.message, code: e.code || null }, { status });
        }
      }
      const entity = String(args.entity || "");
      try {
        const target = db[entity];
        // Phase B1: the records-mode v2/list page form — list(options) / filter(query, options).
        // The query travels VERBATIM: an omitted query must stay omitted (not {}), because the
        // page layer recovers a cursor-only continuation's query from the verified cursor state.
        // Upsert dispatch note: see the DB_OPS registration above — records + key verbatim.
        const result = op === "page" ? await target.page(args.query, args.options || {})
          : op === "filter" ? await target.filter(args.query || {}, args.sort, args.limit, args.skip, args.fields)
          : op === "get" ? await target.get(args.id)
          : op === "create" ? await target.create(args.data || {})
          : op === "update" ? await target.update(args.id, args.data || {})
          : op === "count" ? await target.count(args.query || {})
          : op === "aggregate" ? await target.aggregate(args.spec || {})
          // Upsert (SDK 0.8.51): records + key verbatim — fail-closed server-side, never
          // normalized at the dispatch boundary.
          : op === "upsert" ? await target.upsert(args.records, { key: args.key })
          // Bulk writes: same validation, RLS ownership and relation enforcement as the
          // single-record ops (enforced inside createServerDb, never by the caller).
          : op === "bulkCreate" ? await target.bulkCreate(args.items || [])
          : op === "bulkUpdate" ? await target.bulkUpdate(args.updates || [])
          : op === "bulkDelete" ? await target.bulkDelete(args.ids || [])
          : op === "updateWhere" ? await target.updateWhere(args.query || {}, args.data || {})
          : op === "deleteWhere" ? await target.deleteWhere(args.query || {}, args.options || {})
          : op === "updateMany" ? await target.updateMany(args.query || {}, args.data || {})
          : op === "deleteMany" ? await target.deleteMany(args.query || {})
          : op === "importEntities" ? await importEntitiesIntoDb(db, entity, args)
          : await target.delete(args.id);
        return Response.json({ result });
      } catch (e) {
        const status = e.status || (e.code === "DATABASE_RECORD_NOT_FOUND" ? 404 : 400);
        return Response.json({ error: e.message, code: e.code || null }, { status });
      }
    }

    // 2b) File storage for the running app, scoped to this project only. Bytes live in
    //     PRIVATE storage; the browser only ever receives metadata and short-lived signed
    //     URLs. The internal storage handle (file_uri) is never returned. Under RLS the
    //     end-user is resolved from the session and ownership is enforced server-side, so
    //     one user can never read or delete another user's file.
    if (action === "files") {
      const op = String(body.op || "");
      if (!["upload", "upload_public", "get", "list", "access", "delete"].includes(op)) {
        return Response.json({ error: `Unsupported file operation ${op}` }, { status: 400 });
      }
      const rls = !!project.rls_enabled;
      const user = rls ? await resolveSession(svc, project.id, readSessionToken(req, body)).catch(() => null) : null;
      const files = createServerFiles(svc, project.id, { rls, user });
      const args = body.args || {};
      try {
        const result = op === "upload" ? await files.upload(args)
          : op === "upload_public" ? await files.uploadPublic(args)
          : op === "get" ? await files.get(args.id)
          : op === "list" ? await files.list({ limit: args.limit })
          : op === "access" ? await files.access(args.id)
          : await files.delete(args.id);
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    // 2b1) In-app notification inbox (read side of SendPushNotification): always session-bound,
    //      owner-scoped to the verified end user, independent of the project's RLS setting.
    if (action === "notifications") {
      const out = await runtimeNotificationsRoute(svc, { project, req, body });
      return Response.json(out.body, { status: out.status });
    }

    // 2b2) IntegrationsModule parity: the SDK's `base44.integrations` client surface — the Core
    //      platform endpoints and custom.call — dispatched onto the EXISTING certified server
    //      primitives (primitive executor, file storage, messaging, custom-integration engine).
    //      The browser names an operation and its arguments only; the project comes from the
    //      addressed deployment, the end-user from the verified session, and every charge,
    //      quota, retry and redaction stays inside the existing handlers.
    if (action === "integrations") {
      const op = String(body.op || "");
      if (!APP_INTEGRATION_OPS.includes(op)) return Response.json({ error: `Unsupported integration operation ${op}` }, { status: 400 });
      // The end-user is resolved exactly like the files action: only an RLS project requires a
      // session, and an anonymous caller on an open app keeps the existing anonymous behavior.
      const rls = !!project.rls_enabled;
      const sessionToken = rls ? readSessionToken(req, body) : null;
      const resolved = sessionToken ? await resolveSessionRecord(svc, project.id, sessionToken).catch(() => null) : null;
      try {
        const result = await handleAppIntegrations(svc, {
          project,
          integrations: payload.integrations || [],
          user: resolved ? publicUser(resolved.user) : null,
          session: resolved ? publicSession(resolved.session) : null,
          op, args: body.args || {},
          transport: "platform",
        });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null, ...(e.details ? { details: e.details } : {}) }, { status: e.status || 400 });
      }
    }

    // 2c) Analytics for the running app (#30). Ownership is resolved HERE — project, workspace and
    //     environment come from the addressed live deployment, and the end-user comes from the
    //     verified #29 session — so a submission can never attribute an event to another project,
    //     another user or another environment. Validation, credential policy, redaction and
    //     idempotency belong to the ingestion contract; nothing about them is decided by the caller.
    if (action === "analytics") {
      const sessionToken = readSessionToken(req, body);
      const resolved = sessionToken ? await resolveSessionRecord(svc, project.id, sessionToken).catch(() => null) : null;
      try {
        const result = await handleAnalyticsRuntime(svc, {
          project, environment,
          user: resolved ? publicUser(resolved.user) : null,
          session: resolved ? publicSession(resolved.session) : null,
          op: body.op, args: body.args || {},
        });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    // 2d) Realtime rooms for the running app (E8). The actor definition and source come from the
    //     immutable artifact, the room/state/event store is the existing actor runtime's, and the
    //     participant identity is DERIVED from the verified #29 session — so one end-user can never
    //     act as another, and one project's rooms are unreachable from another project's slug.
    if (action === "realtime") {
      const sessionToken = readSessionToken(req, body);
      const resolved = sessionToken ? await resolveSessionRecord(svc, project.id, sessionToken).catch(() => null) : null;
      try {
        const result = await handleRealtimeRuntime(svc, {
          project, payload, user: resolved ? publicUser(resolved.user) : null,
          op: body.op, args: body.args || {},
        });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    // 2e) Declared agents and connectors, read from the immutable artifact. Discovery only: an
    //     agent's instructions and every credential reference stay server-side, and neither
    //     namespace can execute anything from the browser.
    if (action === "agents" || action === "connectors") {
      const sessionToken = readSessionToken(req, body);
      const resolved = sessionToken ? await resolveSessionRecord(svc, project.id, sessionToken).catch(() => null) : null;
      // App user connectors (P-9.9): connect / disconnect / connections for the CURRENT signed-in
      // app user. The connector registry is the artifact's OWN declarations; the browser names at
      // most a connector id, and every credential/token stays server-side. list/describe keep
      // flowing to the read-only discovery handler below.
      if (action === "connectors" && ["connect", "disconnect", "connections"].includes(String(body.op || ""))) {
        if (!resolved) return Response.json({ error: "Sign in required", code: "AUTH_REQUIRED" }, { status: 401 });
        const origin = requestOrigin(req);
        const base = body.host ? "/~app/oauth/callback" : `/app/${String(body.slug || "")}/oauth/callback`;
        try {
          const result = await handleAppConnectors(svc, {
            project, connectors: payload.connectors || [], user: resolved.user,
            op: String(body.op || ""), args: body.args || {},
            meta: {
              ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
              user_agent: req.headers.get("user-agent") || null,
              trace_id: body.trace_id || null,
            },
            resolveSecret: async (name) => {
              if (!name) return undefined;
              const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
              const row = rows[0];
              if (!row || !row.value) return undefined;
              try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
            },
            http: oauthExchangeHttp,
            callback_url: origin ? `${origin}${base}` : null,
          });
          return Response.json({ result });
        } catch (e) {
          return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
        }
      }
      const handler = action === "agents" ? handleAgentsRuntime : handleConnectorsRuntime;
      try {
        const result = await handler(svc, {
          project, payload, user: resolved ? publicUser(resolved.user) : null,
          op: body.op, args: body.args || {},
        });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    // 2f) In-app agent EXECUTION (P-9.4). The agent comes from the immutable artifact; the
    //     end-user is resolved from the verified session server-side and is REQUIRED — no
    //     anonymous agent runs. Model access, message credits and every tool charge are
    //     enforced inside the shared handler through the existing canonical paths.
    if (action === "agent") {
      const sessionToken = readSessionToken(req, body);
      const resolved = sessionToken ? await resolveSessionRecord(svc, project.id, sessionToken).catch(() => null) : null;
      // P-9.11C: with no user session, an ANONYMOUS identity may carry the turn — resolved from
      // the host-held anonymous token (project-scoped, anonymous-only; a real user's token never
      // resolves here), or minted ONCE on the documented conversation-start op for an agent that
      // declares allow_anonymous_access=true. The mint is durably rate limited and fail-closed;
      // the minted token returns to the host in the result only, never a cookie.
      let anonymous = null;
      let mintedToken = null;
      if (!resolved) {
        const anonToken = typeof body.anonymous_token === "string" ? body.anonymous_token : null;
        if (anonToken) anonymous = await resolveAnonymousSession(svc, project, anonToken).catch(() => null);
        if (!anonymous && String(body.op || "") === "create") {
          const name = String(body.args?.agent_name || body.args?.agent || "");
          const agent = (payload?.agents || []).find((a) => a && a.name === name);
          if (agent?.allow_anonymous_access === true) {
            const minted = await createAnonymousSession(svc, project, {
              ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
              user_agent: req.headers.get("user-agent") || null,
            });
            anonymous = minted;
            mintedToken = minted.token;
          }
        }
      }
      try {
        const result = await handleAppAgent(client, {
          project, payload,
          user: resolved ? publicUser(resolved.user) : null,
          anonymous: anonymous ? { user: publicUser(anonymous.user) } : null,
          op: body.op, args: body.args || {},
        });
        return Response.json({ result: mintedToken ? { ...result, anonymous_session_token: mintedToken } : result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    // 2g) P-9.10A Telegram channel: connect-URL issuance for the current signed-in app user.
    //     Fail-closed without bot credentials; the activation code is a single-use token whose
    //     raw value exists only in the returned URL — never in logs, audit rows or any later
    //     response.
    if (action === "channel") {
      const sessionToken = readSessionToken(req, body);
      const resolved = sessionToken ? await resolveSessionRecord(svc, project.id, sessionToken).catch(() => null) : null;
      if (!resolved) return Response.json({ error: "Sign in required", code: "AUTH_REQUIRED" }, { status: 401 });
      try {
        const result = await handleAppChannelConnect(client, {
          project, payload, user: resolved.user, args: body.args || {},
          resolveSecret: async (name) => {
            if (!name) return undefined;
            const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
            const row = rows[0];
            if (!row || !row.value) return undefined;
            try { return await decryptSecretValue(project.id, row.name, row.value); } catch { return undefined; }
          },
          http: telegramHttp,
        });
        return Response.json({ result });
      } catch (e) {
        return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
      }
    }

    // 3) Backend function execution, from the ARTIFACT's source. Secrets are resolved and
    //    redacted inside the executor; the browser only ever sees the safe response.
    if (action === "fn") {
      const name = String(body.function_name || "");
      // functions.fetch (documented raw-HTTP surface): additive branch. The function's source
      // still comes from the immutable artifact and the end-user session is resolved
      // server-side exactly as the invoke branch does. The raw envelope returns whatever the
      // function's status is — a function 4xx/5xx is a Response for the caller. Only an
      // infrastructure refusal (unknown function, invalid args) becomes { error }, which the
      // bridge turns into a rejected promise. The invoke branch below is untouched.
      if (body.mode === "fetch") {
        const sessionToken = readSessionToken(req, body);
        const resolved = sessionToken ? await resolveSessionRecord(svc, project.id, sessionToken).catch(() => null) : null;
        try {
          // Streaming (additive, multi-frame bridge): a stream-capable handler result is returned
          // as a RAW passthrough Response (the marker header tells the host to frame chunks);
          // anything else keeps the exact buffered envelope below, byte-identical to before.
          const out = await runProjectFunctionFetch(svc, {
            project, entities: payload.entities, integrations: payload.integrations || [],
            args: body.fetch || {},
            user: resolved ? publicUser(resolved.user) : null,
            session: resolved ? publicSession(resolved.session) : null,
            streaming: body.stream === true,
            signal: req.signal || null,
            loadSource: async (fnName) => {
              const f = (payload.functions || []).find((x) => x.name === fnName);
              if (!f) throw Object.assign(new Error(`Backend function "${fnName}" is not part of this deployment`), { status: 404 });
              return { source: f.source };
            },
          });
          if (out.__stream__) {
            return new Response(out.body, { status: out.status, headers: { ...out.headers, "x-nexus-stream": "1" } });
          }
          return Response.json({ result: out });
        } catch (e) {
          return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 400 });
        }
      }
      const fn = (payload.functions || []).find((f) => f.name === name);
      if (!fn) return Response.json({ error: `Backend function "${name}" is not part of this deployment` }, { status: 404 });
      // Resolve the end-user (if any) from the session and expose it to the generated
      // function as ctx.user. Anonymous calls (no/invalid session) still run, with ctx.user = null.
      const sessionToken = readSessionToken(req, body);
      const resolved = sessionToken ? await resolveSessionRecord(svc, project.id, sessionToken).catch(() => null) : null;
      const result = await executeProjectFunction(svc, {
        project, entities: payload.entities, integrations: payload.integrations || [],
        name, source: fn.source, trigger: "frontend", requestId: crypto.randomUUID(),
        request: { method: "POST", query: {}, headers: {}, body: body.payload ?? null },
        // The session is resolved SERVER-side and handed to the executor so ctx.auth and the
        // invocation's recorded identity describe the same, verified end-user.
        user: resolved ? publicUser(resolved.user) : null,
        session: resolved ? publicSession(resolved.session) : null,
      });
      return Response.json({ status: result.status, body: result.body, duration_ms: result.duration_ms });
    }

    return Response.json({ error: `Unsupported action ${action}` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: error.status || 500 });
  }
}