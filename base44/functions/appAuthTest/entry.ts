// Focused #29 certification: generated-app end-user identity and auth.
//
// Every check runs against the REAL shipping modules (appAuth / appOAuth / appAccess /
// appAuthContext) and the REAL function executor, in a throwaway workspace + two projects, so
// cross-project isolation is exercised with actual data rather than simulated.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  signUp, logIn, logOut, refreshSession, changePassword, updateProfile, resolveSessionRecord,
  requestPasswordReset, confirmPasswordReset, verifyOtp, revokeUserSessions, publicUser, publicSession,
  findUserByEmail, AUTH_LIMITS,
} from "../../shared/appAuth.ts";
import { beginOAuth, completeOAuth, listIdentities, unlinkIdentity, describeOAuthContract } from "../../shared/appOAuth.ts";
import {
  ensureSystemRoles, resolvePermissions, can, permissionMatches, defineRole, assignRoles, setUserStatus,
  createTeam, listTeams, addTeamMember, listTeamMembers, requireTeamMember,
} from "../../shared/appAccess.ts";
import { executionIdentity } from "../../shared/appAuthContext.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { createHarness } from "../../shared/testHarness.ts";
import { openCertification } from "../../shared/certificationIsolation.ts";

const PASSWORD = "Sup3r-Secret-Pass!";
const AUTH_FN = `export default async function (ctx) {
  if (!ctx.auth.isAuthenticated()) return { status: 200, body: { authenticated: false, kind: ctx.auth.identity.kind } };
  return { status: 200, body: {
    authenticated: true, kind: ctx.auth.identity.kind, user_id: ctx.auth.user.id,
    session_id: ctx.auth.identity.session_id, roles: ctx.auth.roles(),
    permissions: await ctx.auth.permissions(),
    can_admin: await ctx.auth.can("admin.write"),
    teams: (await ctx.auth.teams.list()).map(function (t) { return t.id; }),
    leaked_password: ctx.auth.user.password_hash || null,
  } };
}`;
const GUARD_FN = `export default async function (ctx) {
  await ctx.auth.require("admin.write");
  return { status: 200, body: { ok: true } };
}`;

export default async function (req) {
  let cert;
  try { cert = await openCertification(createClientFromRequest(req), req, "app_auth", 8); }
  catch (error) { return Response.json({ result: "BLOCKED", blocker: { code: error.code, message: error.message } }, { status: error.status || 503 }); }
  if (cert.immediate) return cert.immediate;
  const svc = cert.db;
  const h = createHarness();
  h.results.push(...cert.state.results);
  const phase = cert.state.phase;
  let { ws, project, other, email, signed, row, verifyTok, verified, loggedIn, resetToken, memberPerms, adminCtx, memberCtx, teamOwner, team, outsider, fnSession, fnResolved } = cert.locals;
  const entities = [{ name: "Item", fields: { title: { type: "string" } } }];
  const captured = cert.locals.captured || [];
  const meta = { ip: "203.0.113.9", user_agent: "cert/1.0", trace_id: cert.state.tag, onToken: (t) => { captured.push(t); } };
  const pause = () => cert.pause({ ws, project, other, email, signed, row, verifyTok, verified, loggedIn, resetToken, memberPerms, adminCtx, memberCtx, teamOwner, team, outsider, fnSession, fnResolved, captured }, h.results);
  try {
    if (phase === 0) {
    ws = await svc.entities.Workspace.create({ name: cert.state.tag, owner_id: cert.state.tag, credits_balance: 0, status: "active" });
    project = await svc.entities.Project.create({ workspace_id: ws.id, name: "Auth Cert App", slug: `aa-${crypto.randomUUID().slice(0, 8)}` });
    other = await svc.entities.Project.create({ workspace_id: ws.id, name: "Other App", slug: `ao-${crypto.randomUUID().slice(0, 8)}` });
    email = `owner-${crypto.randomUUID().slice(0, 8)}@example.com`;

    // --- 1. signup + session ---------------------------------------------------------------
    signed = await signUp(svc, project.id, { email, password: PASSWORD, full_name: "Cert Owner" }, meta);
    h.check("signup_creates_app_user", !!signed.user.id && signed.user.email === email, `user=${signed.user.id}`);
    h.check("signup_mints_no_session", !("token" in signed) && !("session" in signed) && (await svc.entities.AppSession.filter({ project_id: project.id, app_user_id: signed.user.id }, "-created_date", 5)).length === 0, "G-2: register creates the user but no session");
    h.check("signup_default_role_user", signed.user.roles.includes("user") && signed.user.email_verified === false, JSON.stringify(signed.user.roles));

    // isolation from NexusAI platform users
    const platform = await svc.entities.User.filter({ email }, "-created_date", 1).catch(() => []);
    h.check("no_platform_user_created", platform.length === 0, `${platform.length} platform row(s) for the app user's email`);
    row = await svc.entities.AppUser.get(signed.user.id);
    h.check("app_user_scoped_to_project", row.project_id === project.id && row.workspace_id === ws.id, `project=${row.project_id}`);

    // --- 2. credential security -------------------------------------------------------------
    h.check("password_not_stored_plaintext", !!row.password_hash && row.password_hash !== PASSWORD && !JSON.stringify(row).includes(PASSWORD), `algorithm=${row.password_algorithm}`);
    h.check("password_salted_per_user", !!row.password_salt && row.password_salt.length >= 32, `salt len=${row.password_salt ? row.password_salt.length : 0}`);
    h.check("public_projection_hides_credentials", !("password_hash" in signed.user) && !("password_salt" in signed.user), Object.keys(signed.user).join(","));

    return await pause();
    }
    if (phase === 1) {
    // --- 3. signin ---------------------------------------------------------------------------
    await h.expectThrow("signin_wrong_password_rejected", () => logIn(svc, project.id, { email, password: "wrong-password-1" }, meta), "INVALID_CREDENTIALS");
    await h.expectThrow("signin_unknown_email_rejected", () => logIn(svc, project.id, { email: `nobody-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PASSWORD }, meta), "INVALID_CREDENTIALS");
    await h.expectThrow("signin_before_verification_rejected", () => logIn(svc, project.id, { email, password: PASSWORD }, meta), "EMAIL_NOT_VERIFIED");
    verifyTok = captured.length ? captured[0].token : null;
    h.check("verification_issued_on_signup", !!verifyTok, "the signup verification secret went to the delivery hook only");
    verified = await verifyOtp(svc, project.id, { email, otpCode: verifyTok }, meta);
    h.check("verify_otp_returns_access_token", /^[a-f0-9]{64}$/.test(verified.access_token), "the now-verified user receives the session token");
    h.check("verify_otp_session_resolves", !!(await resolveSessionRecord(svc, project.id, verified.access_token)), "the OTP token is a live authenticated session");
    await h.expectThrow("verify_otp_token_single_use", () => verifyOtp(svc, project.id, { email, otpCode: verifyTok }, meta), "TOKEN_USED");
    loggedIn = await logIn(svc, project.id, { email, password: PASSWORD }, meta);
    h.check("signin_succeeds_after_verification", loggedIn.user.id === row.id && !!loggedIn.token, `session=${loggedIn.session.id}`);
    const sessionRow = await svc.entities.AppSession.get(loggedIn.session.id);
    h.check("session_token_hashed_at_rest", sessionRow.token_hash !== loggedIn.token && sessionRow.token_hash.length === 64, "only the SHA-256 is persisted");

    return await pause();
    }
    if (phase === 2) {
    // --- 4. session resolution / isolation / refresh / logout --------------------------------
    const resolved = await resolveSessionRecord(svc, project.id, loggedIn.token);
    h.check("session_resolves_in_own_project", resolved && resolved.user.id === row.id, `user=${resolved ? resolved.user.id : null}`);
    h.check("session_isolated_across_projects", (await resolveSessionRecord(svc, other.id, loggedIn.token)) === null, "the same token resolves to nothing in another project");
    h.check("malformed_token_rejected", (await resolveSessionRecord(svc, project.id, "not-a-token")) === null, "malformed token → null");
    const refreshed = await refreshSession(svc, project.id, loggedIn.token, meta);
    h.check("refresh_rotates_token", refreshed.token !== loggedIn.token && refreshed.session.rotated_from === loggedIn.session.id, `rotation_count=${refreshed.session.rotation_count}`);
    h.check("rotated_token_is_replay", (await resolveSessionRecord(svc, project.id, loggedIn.token)) === null, "the pre-refresh token no longer validates");
    await logOut(svc, project.id, refreshed.token, meta);
    h.check("logout_revokes_session", (await resolveSessionRecord(svc, project.id, refreshed.token)) === null, "token invalid after logout");

    // expiry
    const live = await logIn(svc, project.id, { email, password: PASSWORD }, meta);
    await svc.entities.AppSession.update(live.session.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    h.check("expired_session_rejected", (await resolveSessionRecord(svc, project.id, live.token)) === null, "an expired session does not validate");
    h.check("expired_session_marked", (await svc.entities.AppSession.get(live.session.id)).status === "expired", "status flipped to expired on resolution");

    return await pause();
    }
    if (phase === 3) {
    // --- 5. password change + reset ----------------------------------------------------------
    const changer = await logIn(svc, project.id, { email, password: PASSWORD }, meta);
    await h.expectThrow("change_password_requires_current", () => changePassword(svc, project.id, { user: changer.user, session: changer.session }, { current_password: "nope", new_password: "An0ther-Pass!" }, meta), "INVALID_CREDENTIALS");
    await h.expectThrow("weak_password_refused", () => changePassword(svc, project.id, { user: changer.user, session: changer.session }, { current_password: PASSWORD, new_password: "short" }, meta), "PASSWORD_TOO_SHORT");
    const extra = await logIn(svc, project.id, { email, password: PASSWORD }, meta);
    const changed = await changePassword(svc, project.id, { user: changer.user, session: changer.session }, { current_password: PASSWORD, new_password: "An0ther-Pass!" }, meta);
    h.check("password_change_revokes_other_sessions", changed.sessions_revoked >= 1 && (await resolveSessionRecord(svc, project.id, extra.token)) === null, `${changed.sessions_revoked} revoked`);
    h.check("password_change_keeps_current_session", (await resolveSessionRecord(svc, project.id, changer.token)) !== null, "the initiating session survives");

    captured.length = 0;
    const resetAck = await requestPasswordReset(svc, project.id, { email }, meta);
    h.check("reset_secret_not_returned", resetAck.ok === true && !("token" in resetAck) && captured.length === 1, `ack=${JSON.stringify(resetAck)}`);
    const unknownAck = await requestPasswordReset(svc, project.id, { email: `ghost-${crypto.randomUUID().slice(0, 6)}@example.com` }, meta);
    h.check("reset_does_not_enumerate_accounts", unknownAck.ok === true, "an unknown email gets the same answer");
    resetToken = captured[0].token;
    const tokenRow = (await svc.entities.AppAuthToken.filter({ project_id: project.id, kind: "password_reset", status: "pending" }, "-created_date", 1))[0];
    h.check("reset_token_hashed_and_expiring", tokenRow.token_hash !== resetToken && Date.parse(tokenRow.expires_at) > Date.now(), `ttl≈${AUTH_LIMITS.reset_ttl_ms}ms`);
    const done = await confirmPasswordReset(svc, project.id, { token: resetToken, new_password: PASSWORD }, meta);
    h.check("reset_completes_and_revokes_sessions", done.ok === true, `${done.sessions_revoked} session(s) revoked`);
    await h.expectThrow("reset_token_single_use", () => confirmPasswordReset(svc, project.id, { token: resetToken, new_password: PASSWORD }, meta), "TOKEN_USED");
    h.check("password_reset_effective", !!(await logIn(svc, project.id, { email, password: PASSWORD }, meta)).token, "the new password signs in");

    // --- 6. email verification — certified in §3 through the G-2 verifyOtp contract -----------

    return await pause();
    }
    if (phase === 4) {
    // --- 7. roles & permissions ---------------------------------------------------------------
    const roles = await ensureSystemRoles(svc, project);
    h.check("system_roles_provisioned", roles.some((r) => r.key === "user" && r.system) && roles.some((r) => r.key === "admin"), roles.map((r) => r.key).join(","));
    h.check("wildcard_permission_matching", permissionMatches("*", "orders.write") && permissionMatches("orders.*", "orders.read") && !permissionMatches("orders.*", "billing.read"), "resource.action with * wildcards");
    memberPerms = await resolvePermissions(svc, project, await svc.entities.AppUser.get(row.id));
    h.check("plain_user_cannot_admin", !can(memberPerms.permissions, "admin.write"), memberPerms.permissions.join(","));
    const adminUser = await signUp(svc, project.id, { email: `admin-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }, meta);
    await svc.entities.AppUser.update(adminUser.user.id, { roles: ["admin"] });
    const adminRow = await svc.entities.AppUser.get(adminUser.user.id);
    adminCtx = { user: publicUser(adminRow), permissions: (await resolvePermissions(svc, project, adminRow)).permissions };
    h.check("admin_holds_wildcard", can(adminCtx.permissions, "admin.write") && can(adminCtx.permissions, "roles.manage"), adminCtx.permissions.join(","));
    memberCtx = { user: publicUser(await svc.entities.AppUser.get(row.id)), permissions: memberPerms.permissions };
    await h.expectThrow("role_management_requires_permission", () => assignRoles(svc, project, memberCtx, { app_user_id: row.id, roles: ["admin"] }, meta), "FORBIDDEN");
    const custom = await defineRole(svc, project, adminCtx, { key: "editor", name: "Editor", permissions: ["items.*"] }, meta);
    h.check("custom_role_defined", custom.key === "editor" && custom.permissions.includes("items.*"), JSON.stringify(custom.permissions));
    await h.expectThrow("unknown_role_refused", () => assignRoles(svc, project, adminCtx, { app_user_id: row.id, roles: ["wizard"] }, meta), "ROLE_UNKNOWN");
    const assigned = await assignRoles(svc, project, adminCtx, { app_user_id: row.id, roles: ["user", "editor"] }, meta);
    h.check("roles_assigned_server_side", assigned.roles.includes("editor"), assigned.roles.join(","));

    // --- 8. teams / tenant isolation -----------------------------------------------------------
    teamOwner = publicUser(await svc.entities.AppUser.get(row.id));
    team = await createTeam(svc, project, teamOwner, { name: "Acme" }, meta);
    h.check("team_created_with_owner", team.role === "owner" && !!team.id, `team=${team.id}`);
    outsider = await signUp(svc, project.id, { email: `out-${crypto.randomUUID().slice(0, 8)}@example.com`, password: PASSWORD }, meta);
    // G-2: register mints no session — the account-status checks below observe a LIVE session
    // being revoked, so complete the verification (codes go to the capture hook only) and
    // sign the outsider in.
    await svc.entities.AppUser.update(outsider.user.id, { email_verified: true, email_verified_at: new Date().toISOString() });
    await logIn(svc, project.id, { email: outsider.user.email, password: PASSWORD }, meta);
    await h.expectThrow("non_member_cannot_read_team", () => requireTeamMember(svc, project, outsider.user, team.id), "TEAM_NOT_FOUND");
    await h.expectThrow("non_member_cannot_add_members", () => addTeamMember(svc, project, outsider.user, { team_id: team.id, app_user_id: outsider.user.id }, meta), "TEAM_NOT_FOUND");
    const added = await addTeamMember(svc, project, teamOwner, { team_id: team.id, app_user_id: outsider.user.id, role: "member" }, meta);
    h.check("owner_can_add_member", added.role === "member", `${added.app_user_id} added`);
    const outsiderTeams = await listTeams(svc, project, outsider.user);
    const adminTeams = await listTeams(svc, project, adminCtx.user);
    h.check("member_sees_only_own_teams", outsiderTeams.length === 1 && outsiderTeams[0].id === team.id && adminTeams.length === 0, `member=${outsiderTeams.length} non_member=${adminTeams.length}`);
    h.check("team_members_listed_to_members", (await listTeamMembers(svc, project, outsider.user, team.id)).length === 2, "2 active members");
    const foreignTeam = await createTeam(svc, project, teamOwner, { name: "Other Tenant" }, meta);
    await svc.entities.AppTeam.update(foreignTeam.id, { project_id: other.id });
    await h.expectThrow("team_never_spans_projects", () => requireTeamMember(svc, project, teamOwner, foreignTeam.id), "TEAM_NOT_FOUND");

    return await pause();
    }
    if (phase === 5) {
    // --- 9. authenticated function context ------------------------------------------------------
    fnSession = await logIn(svc, project.id, { email, password: PASSWORD }, meta);
    fnResolved = await resolveSessionRecord(svc, project.id, fnSession.token);
    const authedRun = await executeProjectFunction(svc, {
      project, entities, integrations: [], name: "whoami", source: AUTH_FN, trigger: "frontend",
      requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: null },
      user: publicUser(fnResolved.user), session: publicSession(fnResolved.session),
    });
    const b = authedRun.body || {};
    h.check("ctx_auth_identifies_end_user", authedRun.status === 200 && b.authenticated === true && b.user_id === row.id, `status=${authedRun.status} body=${JSON.stringify(b).slice(0, 200)}`);
    h.check("ctx_auth_identity_kind_app_user", b.kind === "app_user" && b.session_id === fnResolved.session.id, `kind=${b.kind}`);
    h.check("ctx_auth_exposes_roles_permissions", Array.isArray(b.roles) && b.roles.includes("editor") && (b.permissions || []).includes("items.*"), JSON.stringify(b.roles));
    h.check("ctx_auth_permission_denied_for_member", b.can_admin === false, `can("admin.write")=${b.can_admin}`);
    h.check("ctx_auth_teams_scoped", Array.isArray(b.teams) && b.teams.includes(team.id), JSON.stringify(b.teams));
    h.check("ctx_auth_leaks_no_credentials", b.leaked_password === null, "ctx.auth.user carries no hash or salt");
    const anonRun = await executeProjectFunction(svc, {
      project, entities, integrations: [], name: "whoami", source: AUTH_FN, trigger: "frontend",
      requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: null },
    });
    h.check("anonymous_call_has_no_identity", anonRun.body && anonRun.body.authenticated === false && anonRun.body.kind === "anonymous", `kind=${anonRun.body ? anonRun.body.kind : null}`);
    const guarded = await executeProjectFunction(svc, {
      project, entities, integrations: [], name: "guard", source: GUARD_FN, trigger: "frontend",
      requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: null },
      user: publicUser(fnResolved.user), session: publicSession(fnResolved.session),
    });
    h.check("ctx_auth_require_blocks_unpermitted", guarded.status >= 400, `status=${guarded.status}`);

    // --- 10. identity propagation to invocations / workflows / primitives ------------------------
    const invocations = await svc.entities.FunctionInvocation.filter({ project_id: project.id, function_name: "whoami" }, "-created_date", 5);
    const userInv = invocations.find((i) => i.identity && i.identity.kind === "app_user");
    h.check("invocation_records_execution_identity", !!userInv && userInv.identity.app_user_id === row.id && userInv.identity.session_id === fnResolved.session.id, `identity=${JSON.stringify(userInv ? userInv.identity : null)}`);
    h.check("anonymous_invocation_identity_recorded", invocations.some((i) => i.identity && i.identity.kind === "anonymous"), "an anonymous call is recorded as anonymous, not as a user");
    h.check("scheduled_and_workflow_identity_is_system", executionIdentity({ trigger: "scheduled" }).kind === "system" && executionIdentity({ trigger: "workflow" }).kind === "system", "system triggers never impersonate an end-user");
    h.check("webhook_identity_is_service", executionIdentity({ trigger: "webhook" }).kind === "service", "a verified webhook is a service identity");
    h.check("workflow_primitive_identity_propagates", executionIdentity({ user: publicUser(row), session: fnResolved.session, trigger: "workflow" }).kind === "app_user", "an app user acting through a workflow step keeps its identity");

    return await pause();
    }
    if (phase === 6) {
    // --- 11. account status / session security -------------------------------------------------
    const outsiderEmail = (await svc.entities.AppUser.get(outsider.user.id)).email;
    const disabled = await setUserStatus(svc, project, adminCtx, { app_user_id: outsider.user.id, status: "disabled" }, meta);
    h.check("disabling_account_revokes_sessions", disabled.sessions_revoked >= 1, `${disabled.sessions_revoked} revoked`);
    await h.expectThrow("disabled_account_cannot_sign_in", () => logIn(svc, project.id, { email: outsiderEmail, password: PASSWORD }, meta), "ACCOUNT_DISABLED");
    h.check("email_unique_lookup_per_project", !!(await findUserByEmail(svc, project, email)), "email is unique per project");
    await h.expectThrow("signup_duplicate_email", () => signUp(svc, project.id, { email, password: PASSWORD }, meta), "EMAIL_TAKEN");
    const sameEmailOther = await signUp(svc, other.id, { email, password: PASSWORD }, meta);
    h.check("same_email_allowed_in_other_project", sameEmailOther.user.id !== row.id, "identities do not collide across projects");
    const revokedCount = await revokeUserSessions(svc, project, row.id, { reason: "cert" });
    h.check("bulk_session_revocation", revokedCount >= 1 && (await resolveSessionRecord(svc, project.id, fnSession.token)) === null, `${revokedCount} revoked`);

    // --- 12. profile write allowlist -------------------------------------------------------------
    const profiled = await updateProfile(svc, project.id, publicUser(await svc.entities.AppUser.get(row.id)), { display_name: "Renamed", profile: { plan: "pro" }, roles: ["admin"], status: "disabled", email: "hacker@example.com" }, meta);
    const afterProfile = await svc.entities.AppUser.get(row.id);
    h.check("profile_update_allowlisted", profiled.display_name === "Renamed" && profiled.profile.plan === "pro", JSON.stringify(profiled.profile));
    h.check("profile_update_cannot_escalate", !(afterProfile.roles || []).includes("admin") && afterProfile.status === "active" && afterProfile.email === email, `roles=${afterProfile.roles} status=${afterProfile.status}`);

    return await pause();
    }
    // --- 13. OAuth foundation -------------------------------------------------------------------
    const contract = describeOAuthContract();
    h.check("oauth_contract_provider_neutral", contract.built_in_providers.length === 0 && contract.provider_config.includes("exchange(code, redirect_uri)"), `steps=${contract.steps.length}`);
    await h.expectThrow("unconfigured_provider_refused", () => beginOAuth(svc, project.id, { provider: "acme" }, { providers: {}, meta }), "OAUTH_PROVIDER_NOT_CONFIGURED");
    const oauthEmail = `oauth-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const providers = {
      acme: {
        authorize_url: "https://auth.example.com/authorize", client_id: "cid", scopes: ["openid", "email"],
        exchange: async () => ({ subject: "acme-sub-1", email: oauthEmail, display_name: "OAuth User", email_verified: true, profile: { name: "OAuth User" } }),
      },
    };
    const begun = await beginOAuth(svc, project.id, { provider: "acme", redirect_uri: "https://app.example.com/cb" }, { providers, meta });
    h.check("oauth_begin_issues_state", /^[a-f0-9]{64}$/.test(begun.state) && begun.authorization_url.includes("state=") && begun.authorization_url.startsWith("https://auth.example.com/authorize"), begun.authorization_url.slice(0, 90));
    const cb = await completeOAuth(svc, project.id, { provider: "acme", state: begun.state, code: "code-1" }, { providers, meta });
    h.check("oauth_callback_creates_session", cb.created === true && cb.linked === true && !!cb.token, `user=${cb.user.id}`);
    await h.expectThrow("oauth_state_single_use", () => completeOAuth(svc, project.id, { provider: "acme", state: begun.state, code: "code-2" }, { providers, meta }), "TOKEN_USED");
    const again = await beginOAuth(svc, project.id, { provider: "acme" }, { providers, meta });
    const second = await completeOAuth(svc, project.id, { provider: "acme", state: again.state, code: "code-3" }, { providers, meta });
    h.check("oauth_repeat_signin_reuses_identity", second.created === false && second.user.id === cb.user.id, `user=${second.user.id}`);
    h.check("oauth_identity_listed", (await listIdentities(svc, project, cb.user)).some((i) => i.provider === "acme"), "linked identity visible");
    await h.expectThrow("oauth_last_credential_protected", () => unlinkIdentity(svc, project, cb.user, { provider: "acme" }, meta), "LAST_CREDENTIAL");
    const idRow = (await svc.entities.AppIdentity.filter({ project_id: project.id, provider: "acme" }, "-created_date", 1))[0];
    h.check("oauth_stores_no_provider_tokens", !/access_token|refresh_token|client_secret/.test(JSON.stringify(idRow)), "identity row carries subject + profile only");

    // --- 14. tracing / audit / scrubbing ---------------------------------------------------------
    const logs = await svc.entities.AuditLog.filter({ project_id: project.id }, "-created_date", 200).catch(() => []);
    const actions = logs.map((l) => l.action);
    const required = ["app_auth.signup", "app_auth.signin", "app_auth.signin_failed", "app_auth.password_reset_completed", "app_auth.email_verified", "app_auth.oauth_signin"];
    h.check("auth_events_audited", required.every((a) => actions.includes(a)), `missing: ${required.filter((a) => !actions.includes(a)).join(",") || "none"}`);
    h.check("access_events_audited", actions.includes("app_auth.roles_assigned") && actions.includes("app_auth.team_created") && actions.includes("app_auth.user_status_changed"), "role/team/status changes are audited");
    const dump = JSON.stringify(logs);
    h.check("audit_carries_no_password_or_token", !dump.includes(PASSWORD) && !dump.includes(resetToken) && !dump.includes(verified.access_token) && !dump.includes(row.password_hash), `${logs.length} audit row(s) scanned`);
    const invDump = JSON.stringify(await svc.entities.FunctionInvocation.filter({ project_id: project.id }, "-created_date", 20).catch(() => []));
    h.check("invocations_carry_no_credentials", !invDump.includes(PASSWORD) && !invDump.includes(row.password_hash), "invocation records scrubbed");
    const spans = await svc.entities.TraceEvent.filter({ project_id: project.id }, "-created_date", 50).catch(() => []);
    h.check("tracing_reuses_existing_span_system", Array.isArray(spans), `${spans.length} span(s) recorded through the existing tracer`);

    return await cert.finish(h.results);
  } catch (e) {
    return await cert.finish(h.results, e);
  }
}