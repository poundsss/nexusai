// Focused Auth / Users certification (#29): the GENERATED-APP user lifecycle and its separation
// from the NexusAI platform identity.
//
// Runs against the REAL modules — the real preview auth surface (which authorizes through the
// existing authz path), the real appAuth credential/session layer, the real appAccess role and
// permission resolver, the real sandboxed function executor and the real project-scoped data
// accessor with RLS on. Nothing is stubbed.
//
// Lifecycle asserted end to end:
//   signup → login → session → current user → authenticated API access → authorization
//   → logout / session invalidation
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handlePreviewAuth, PREVIEW_AUTH_OPS } from "../../shared/previewAuth.ts";
import {
  logIn, resolveSessionRecord, resolveSession, publicUser, publicSession, USERS_ENTITY,
} from "../../shared/appAuth.ts";
import { resolvePermissions, can, ensureSystemRoles } from "../../shared/appAccess.ts";
import { executionIdentity, createAppAuthContext, identityEnvelope } from "../../shared/appAuthContext.ts";
import { executeProjectFunction } from "../../shared/functionRuntime.ts";
import { createServerDb } from "../../shared/appData.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const PASSWORD = "Gener4ted-App-Pass!";
const WHOAMI = `export default async function (ctx) {
  if (!ctx.auth.isAuthenticated()) return { status: 200, body: { authenticated: false, kind: ctx.auth.identity.kind } };
  return { status: 200, body: {
    authenticated: true, kind: ctx.auth.identity.kind, user_id: ctx.auth.user.id,
    session_id: ctx.auth.identity.session_id, roles: ctx.auth.roles(),
    permissions: await ctx.auth.permissions(), can_admin: await ctx.auth.can("admin.write"),
    leaked: ctx.auth.user.password_hash || null } };
}`;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let ws = null, foreignWs = null;
  try {
    const platformUser = await base44.auth.me();
    if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // The builder's OWN workspace — the preview surface authorizes against it through the
    // existing authz path, exactly like every other project operation.
    ws = await svc.entities.Workspace.create({ name: "Auth/Users #29", owner_id: platformUser.id, credits_balance: 0 });
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "Generated App", slug: `gu-${crypto.randomUUID().slice(0, 8)}`, rls_enabled: true });
    const other = await svc.entities.Project.create({ workspace_id: ws.id, name: "Other Generated App", slug: `go-${crypto.randomUUID().slice(0, 8)}` });
    foreignWs = await svc.entities.Workspace.create({ name: "Someone Else", owner_id: `other-${crypto.randomUUID().slice(0, 8)}`, credits_balance: 0 });
    const foreignProject = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "Not Mine", slug: `gx-${crypto.randomUUID().slice(0, 8)}` });
    const entities = [{ name: "Note", fields: { title: { type: "string" } } }];
    const email = `enduser-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const preview = (op, body = {}) => handlePreviewAuth(base44, platformUser, { project_id: project.id, op, ...body });

    // --- 1. signup -------------------------------------------------------------------------
    const signed = await preview("signup", { args: { email, password: PASSWORD, full_name: "End User" } });
    h.check("signup_creates_generated_app_user", !!signed.user.id && signed.user.email === email, `user=${signed.user.id}`);
    h.check("signup_mints_no_session", signed.authenticated === false && !signed.session_token && signed.session === null, "G-2: register leaves the user unverified with no session");
    h.check("signup_envelope_has_identity_semantics",
      Array.isArray(signed.roles) && signed.roles.length === 0 && Array.isArray(signed.permissions) && signed.permissions.length === 0,
      "the unauthenticated envelope carries no roles or permissions");
    h.check("signup_envelope_carries_no_credentials",
      !("password_hash" in signed.user) && !("password_salt" in signed.user) && !JSON.stringify(signed.user).includes(PASSWORD),
      Object.keys(signed.user).join(","));

    // --- 2. platform / generated separation -------------------------------------------------
    const platformRows = await svc.entities.User.filter({ email }, "-created_date", 2).catch(() => []);
    const row = await svc.entities.AppUser.get(signed.user.id);
    h.check("no_platform_user_created_by_signup", platformRows.length === 0, `${platformRows.length} platform row(s) for the generated user's email`);
    h.check("generated_user_is_not_the_platform_user", signed.user.id !== platformUser.id && row.project_id === project.id && row.workspace_id === ws.id, `app_user=${row.id} platform_user=${platformUser.id}`);
    h.check("generated_user_persisted_in_own_model", !!row.password_hash && row.password_hash !== PASSWORD && !!row.password_salt, `algorithm=${row.password_algorithm}`);

    // --- 3. login + session -----------------------------------------------------------------
    await h.expectThrow("login_wrong_password_rejected", () => preview("login", { args: { email, password: "not-the-password" } }), "INVALID_CREDENTIALS");
    await h.expectThrow("login_before_verification_rejected", () => preview("login", { args: { email, password: PASSWORD } }), "EMAIL_NOT_VERIFIED");
    // Fixture: the builder preview has no email transport, so the OTP code cannot be delivered
    // here — complete the verification directly and continue with the documented
    // post-verification login. The register → verifyOtp transition itself is certified in
    // appAuthOtpParityTest.
    await svc.entities.AppUser.update(signed.user.id, { email_verified: true, email_verified_at: new Date().toISOString() });
    const logged = await preview("login", { args: { email, password: PASSWORD } });
    h.check("login_returns_same_generated_user", logged.user.id === row.id && logged.session_token !== signed.session_token, `session=${logged.session.id}`);
    const resolved = await resolveSessionRecord(svc, project.id, logged.session_token);
    h.check("session_resolves_server_side", !!resolved && resolved.user.id === row.id, `resolved=${resolved ? resolved.user.id : null}`);
    h.check("session_isolated_across_projects", (await resolveSessionRecord(svc, other.id, logged.session_token)) === null, "one project's token resolves to nothing in another");

    // --- 4. current user ---------------------------------------------------------------------
    const me = await preview("me", { session_token: logged.session_token });
    const anon = await preview("me", { session_token: null });
    const forgedToken = await preview("me", { session_token: "f".repeat(64) });
    h.check("current_user_resolves_from_session", me.authenticated === true && me.user.id === row.id && me.session.id === logged.session.id, `me=${me.user.id}`);
    h.check("no_session_is_unauthenticated", anon.authenticated === false && anon.user === null && anon.roles.length === 0, JSON.stringify(anon));
    h.check("unknown_token_is_unauthenticated", forgedToken.authenticated === false, "a token that matches nothing grants nothing");

    // --- 5. roles / permissions --------------------------------------------------------------
    await ensureSystemRoles(svc, project);
    const memberCan = await preview("can", { session_token: logged.session_token, args: { permission: "admin.write" } });
    const memberProfile = await preview("can", { session_token: logged.session_token, args: { permission: "profile.read" } });
    await svc.entities.AppUser.update(row.id, { roles: ["admin"] });
    const adminMe = await preview("me", { session_token: logged.session_token });
    const adminCan = await preview("can", { session_token: logged.session_token, args: { permission: "admin.write" } });
    h.check("permissions_evaluated_server_side", memberCan.allowed === false && memberProfile.allowed === true, `admin.write=${memberCan.allowed} profile.read=${memberProfile.allowed}`);
    h.check("role_change_reflected_in_permissions", adminMe.roles.includes("admin") && adminCan.allowed === true, `roles=${adminMe.roles.join(",")}`);
    await svc.entities.AppUser.update(row.id, { roles: ["user"] });
    const backToMember = await preview("can", { session_token: logged.session_token, args: { permission: "admin.write" } });
    h.check("no_implicit_privilege_escalation", backToMember.allowed === false && can((await resolvePermissions(svc, project, await svc.entities.AppUser.get(row.id))).permissions, "profile.read"),
      "a generated user holds only what its project roles grant");

    // --- 6. unauthorized access --------------------------------------------------------------
    await h.expectThrow("preview_auth_requires_project_authorization", () => handlePreviewAuth(base44, platformUser, { project_id: foreignProject.id, op: "me" }), null);
    await h.expectThrow("preview_auth_requires_platform_session", () => handlePreviewAuth(base44, null, { project_id: project.id, op: "me" }), "AUTH_REQUIRED");
    await h.expectThrow("unsupported_auth_op_refused", () => preview("promote"), "AUTH_OP_UNSUPPORTED");
    const foreignSession = await preview("me", { session_token: (await logIn(svc, other.id, { email: `x-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PASSWORD }, {}).catch(() => ({ token: "0".repeat(64) }))).token });
    h.check("another_projects_session_grants_nothing", foreignSession.authenticated === false, "a session from another app never authenticates here");

    // --- 7. backend / frontend identity consistency --------------------------------------------
    const fnResolved = await resolveSessionRecord(svc, project.id, logged.session_token);
    const run = await executeProjectFunction(svc, {
      project, entities, integrations: [], name: "whoami", source: WHOAMI, trigger: "frontend",
      requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: null },
      user: publicUser(fnResolved.user), session: publicSession(fnResolved.session),
    });
    const frontend = await preview("me", { session_token: logged.session_token });
    const b = run.body || {};
    h.check("backend_receives_the_same_generated_user",
      run.status === 200 && b.authenticated === true && b.user_id === frontend.user.id && b.session_id === frontend.session.id && b.kind === "app_user",
      `backend=${b.user_id} frontend=${frontend.user.id}`);
    h.check("backend_and_frontend_agree_on_roles_permissions",
      JSON.stringify([...b.roles].sort()) === JSON.stringify([...frontend.roles].sort()) &&
      JSON.stringify([...(b.permissions || [])].sort()) === JSON.stringify([...frontend.permissions].sort()) &&
      b.can_admin === false,
      `roles ${b.roles} vs ${frontend.roles}`);
    h.check("no_credentials_reach_either_side", b.leaked === null && !JSON.stringify(frontend).includes(row.password_hash), "neither surface carries a hash");
    const anonRun = await executeProjectFunction(svc, {
      project, entities, integrations: [], name: "whoami", source: WHOAMI, trigger: "frontend",
      requestId: crypto.randomUUID(), request: { method: "POST", query: {}, headers: {}, body: null },
    });
    h.check("anonymous_backend_call_has_no_identity", anonRun.body?.authenticated === false && anonRun.body.kind === "anonymous", `kind=${anonRun.body?.kind}`);
    const ctx = createAppAuthContext(svc, { project, user: publicUser(fnResolved.user), session: fnResolved.session, identity: executionIdentity({ user: publicUser(fnResolved.user), session: fnResolved.session, trigger: "frontend" }) });
    let denied = null;
    try { await ctx.require("admin.write"); } catch (e) { denied = e.code; }
    h.check("backend_authorization_uses_existing_infrastructure", denied === "FORBIDDEN" && ctx.identity.kind === "app_user", `require → ${denied}`);

    // --- 8. RLS compatibility ------------------------------------------------------------------
    const second = await preview("signup", { args: { email: `second-${crypto.randomUUID().slice(0, 6)}@example.com`, password: PASSWORD } });
    // G-2: register mints no session — the logout-isolation check below needs a second LIVE
    // session, so complete the verification (the preview has no email transport) and sign in.
    await svc.entities.AppUser.update(second.user.id, { email_verified: true, email_verified_at: new Date().toISOString() });
    const secondSession = await preview("login", { args: { email: second.user.email, password: PASSWORD } });
    const dbA = createServerDb(svc, project.id, entities, { rls: true, user: frontend.user });
    const dbB = createServerDb(svc, project.id, entities, { rls: true, user: second.user });
    const mine = await dbA.Note.create({ title: "mine" });
    await dbB.Note.create({ title: "theirs" });
    const seenByA = await dbA.Note.filter({});
    const seenByB = await dbB.Note.filter({});
    let crossRead = null;
    try { await dbB.Note.get(mine.id); } catch (e) { crossRead = e.code || "DENIED"; }
    h.check("rls_scopes_records_to_the_generated_user",
      seenByA.length === 1 && seenByA[0].title === "mine" && seenByB.length === 1 && seenByB[0].title === "theirs" && !!crossRead,
      `A=${seenByA.length} B=${seenByB.length} cross-read → ${crossRead}`);
    const anonDb = createServerDb(svc, other.id, entities, { rls: false, user: null });
    const openRecord = await anonDb.Note.create({ title: "open" });
    h.check("rls_off_behaviour_unchanged", (await anonDb.Note.filter({})).some((r) => r.id === openRecord.id), "an anonymous app keeps open, shared data");

    // --- 9. logout / session invalidation -------------------------------------------------------
    const platformStillThere = await base44.auth.me();
    const out = await preview("logout", { session_token: logged.session_token });
    const afterLogout = await preview("me", { session_token: logged.session_token });
    const sessionRow = await svc.entities.AppSession.get(logged.session.id);
    const platformAfter = await base44.auth.me();
    h.check("logout_invalidates_generated_session",
      out.ok === true && out.authenticated === false && afterLogout.authenticated === false &&
      sessionRow.status === "revoked" && sessionRow.revoke_reason === "logout" &&
      (await resolveSessionRecord(svc, project.id, logged.session_token)) === null,
      `session status=${sessionRow.status}`);
    h.check("logout_does_not_touch_platform_session",
      !!platformAfter && platformAfter.id === platformStillThere.id && platformAfter.id === platformUser.id,
      "the NexusAI builder stays signed in after the generated app signs out");
    h.check("other_generated_session_survives_logout", (await resolveSessionRecord(svc, project.id, secondSession.session_token)) !== null, "logging one end-user out does not sign the others out");

    // --- 10. legacy compatibility ----------------------------------------------------------------
    const relog = await preview("login", { args: { email, password: PASSWORD } });
    h.check("legacy_resolve_session_projection_intact",
      (await resolveSession(svc, project.id, relog.session_token))?.id === row.id && USERS_ENTITY === "__users",
      "the pre-existing compatibility projection and reserved name are unchanged");
    h.check("legacy_unauthenticated_envelope_shape",
      identityEnvelope({}).authenticated === false && identityEnvelope({}).user === null && PREVIEW_AUTH_OPS.join(",") === "me,signup,login,logout,can,verify_otp,resend_otp,invite_user,update_profile,change_password,request_password_reset,confirm_password_reset,redirect_login",
      PREVIEW_AUTH_OPS.join(","));
    h.check("system_trigger_identity_never_impersonates_a_user",
      executionIdentity({ trigger: "scheduled" }).kind === "system" && executionIdentity({ trigger: "webhook" }).kind === "service" && executionIdentity({}).kind === "anonymous",
      "platform-initiated executions are not generated users");

    for (const name of ["AppTeamMember", "AppTeam", "AppIdentity", "AppAuthToken", "AppSession", "AppUser", "AppRole", "FunctionInvocation", "TraceEvent", "AuditLog", "AppRecord"]) {
      for (const p of [project.id, other.id, foreignProject.id]) {
        for (const r of await svc.entities[name].filter({ project_id: p }, "-created_date", 500).catch(() => [])) {
          await svc.entities[name].delete(r.id).catch(() => {});
        }
      }
    }
    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await cleanupWorkspace(svc, ws ? ws.id : null, ["Project", "AuditLog"]).catch(() => {});
    await cleanupWorkspace(svc, foreignWs ? foreignWs.id : null, ["Project", "AuditLog"]).catch(() => {});
  }
}