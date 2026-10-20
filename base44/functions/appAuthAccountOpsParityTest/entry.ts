// Targeted certification for the AuthModule account-management parity cluster:
//   update_profile            → auth.updateMe
//   request_password_reset    → auth.resetPasswordRequest
//   confirm_password_reset   → auth.resetPassword
//   change_password           → auth.changePassword
//
// The four operations were ALREADY implemented and certified server-side (appAuthTest certifies
// the primitives: current-password verification, single-use hashed reset tokens, session
// revocation, durable rate limits, anti-enumeration). This suite certifies ONLY the NEW EXPOSURE:
// the deployed public runtime (over its real HTTP surface, with a real live deployment) and the
// builder-preview dispatch both route the four ops with bridge-shaped payloads (the exact args
// the generated-app bridge forwards), with identical semantics, fail-closed behavior and
// cross-project isolation.
//
// Certifies exactly: op-set parity; each op reachable on BOTH dispatches; session authorization
// enforced; invalid inputs fail-closed; update allowlist ignores security fields; the reset token
// is single-use ACROSS surfaces; password/session behavior unchanged; project isolation intact.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { appRuntimeCaller, createDeployedApp } from "../../shared/deployFixtures.ts";
import { signUpWithSession, requestPasswordReset, logIn, resolveSessionRecord, getAppUser } from "../../shared/appAuth.ts";
import { handlePreviewAuth, PREVIEW_AUTH_OPS } from "../../shared/previewAuth.ts";

const PASSWORD = "Acct-0ps-Cert-0!";
const NEW_PASSWORD = "Acct-0ps-New-9!";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let ws = null;
  let projects = [];
  try {
    const platformUser = await base44.auth.me();
    if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });
    ws = await svc.entities.Workspace.create({ name: "Auth Account Ops Parity", owner_id: platformUser.id, credits_balance: 0 });
    const stamp = Date.now();

    // Fixtures: two projects with REAL live deployments through the shared deployed-runtime
    // fixtures, so the deployed dispatch resolves a real artifact exactly as production does.
    const mkDeployed = (name, slug) => createDeployedApp(svc, {
      workspace_id: ws.id, name, slug, deployed_by: platformUser.id,
      on_project_created: (p) => projects.push(p.id),
    });
    const a = await mkDeployed("AcctOps A", `acctops-a-${stamp}`);
    const b = await mkDeployed("AcctOps B", `acctops-b-${stamp}`);
    const projectA = a.project;
    const projectB = b.project;
    const slugA = projectA.slug, slugB = projectB.slug;

    const uid = crypto.randomUUID().slice(0, 8);
    const mk = (n) => `acctops-${n}-${uid}@example.com`;

    // The DEPLOYED public runtime over its real HTTP surface, with the EXACT payloads the
    // generated-app bridge forwards (op + args + session_token) — shared caller.
    const runtime = appRuntimeCaller(svc);
    const dep = (slug, op, args = {}, token = null) =>
      runtime({ action: "auth", slug, op, args, ...(token ? { session_token: token } : {}) });
    // The BUILDER-PREVIEW dispatch, exactly as the preview bridge calls it.
    const prev = (projectId, op, body = {}) => handlePreviewAuth(base44, platformUser, { project_id: projectId, op, ...body });

    // --- 1. op-set parity: the preview dispatch registers the four account-management ops -----
    const OPS = ["update_profile", "change_password", "request_password_reset", "confirm_password_reset"];
    h.check("preview_op_set_includes_account_ops", OPS.every((o) => PREVIEW_AUTH_OPS.includes(o)), `ops=${PREVIEW_AUTH_OPS.join(",")}`);

    // --- 1b. auth.redirectToLogin(nextUrl) parity: the SAME destination resolution/validation
    // on BOTH dispatch surfaces (relative + same-origin absolute validated; cross-origin refused).
    h.check("preview_surface_registers_redirect_login", PREVIEW_AUTH_OPS.includes("redirect_login"), `ops=${PREVIEW_AUTH_OPS.join(",")}`);
    const depRl = await dep(slugA, "redirect_login", { next_url: "/todos?utm=e2e" });
    h.check("deployed_redirect_login_validates_relative", depRl.ok && depRl.data.from_url === "/todos?utm=e2e", JSON.stringify(depRl).slice(0, 140));
    const depRlBad = await dep(slugA, "redirect_login", { next_url: "https://evil.example.com/x" });
    h.check("deployed_redirect_login_refuses_cross_origin", !depRlBad.ok && depRlBad.code === "OAUTH_FROM_URL_INVALID", JSON.stringify({ status: depRlBad.status, code: depRlBad.code }).slice(0, 140));
    const prevRl = await prev(projectA.id, "redirect_login", { args: { next_url: "/todos?utm=e2e" } });
    h.check("preview_redirect_login_validates_relative", prevRl && prevRl.from_url === "/todos?utm=e2e", JSON.stringify(prevRl).slice(0, 140));
    let prevRlBadMsg = null;
    try { await prev(projectA.id, "redirect_login", { args: { next_url: "https://evil.example.com/x" } }); } catch (e) { prevRlBadMsg = e.message; }
    h.check("preview_redirect_login_refuses_cross_origin", !!prevRlBadMsg && prevRlBadMsg.indexOf("same-origin") !== -1, String(prevRlBadMsg));
    const prevRlAbs = await handlePreviewAuth(base44, platformUser, { project_id: projectA.id, op: "redirect_login", args: { next_url: "https://preview-origin.example/pricing" } }, { origin: "https://preview-origin.example" });
    h.check("preview_redirect_login_validates_same_origin_absolute", prevRlAbs && prevRlAbs.from_url === "https://preview-origin.example/pricing", JSON.stringify(prevRlAbs).slice(0, 140));

    // --- 2. updateMe reachable on BOTH dispatches, updating allowlisted fields only ---------
    const updA = await signUpWithSession(svc, projectA.id, { email: mk("upd"), password: PASSWORD, full_name: "Update Me" }, { ip: "203.0.113.40" });
    const depUpd = await dep(slugA, "update_profile", { display_name: "Renamed Deployed" }, updA.token);
    h.check("deployed_update_me_reachable",
      depUpd.ok && depUpd.data.user?.id === updA.user.id && depUpd.data.user.display_name === "Renamed Deployed",
      JSON.stringify(depUpd).slice(0, 160));
    const prevUpd = await prev(projectA.id, "update_profile", { session_token: updA.token, args: { display_name: "Renamed Preview" } });
    h.check("preview_update_me_reachable",
      prevUpd.user?.id === updA.user.id && prevUpd.user.display_name === "Renamed Preview",
      JSON.stringify(prevUpd).slice(0, 160));

    // --- 3. updateMe stays fail-closed: session required; security fields unreachable -------
    const noSessDep = await dep(slugA, "update_profile", { display_name: "Ghost" });
    h.check("deployed_update_me_requires_session", !noSessDep.ok && noSessDep.code === "AUTH_REQUIRED", `${noSessDep.status}/${noSessDep.code}`);
    await h.expectThrow("preview_update_me_requires_session",
      () => prev(projectA.id, "update_profile", { args: { display_name: "Ghost" } }), "AUTH_REQUIRED");
    const sneaky = { display_name: "Should Stay", roles: ["admin"], status: "disabled", email: "evil@example.com", password_hash: "0".repeat(64), password_salt: "nope" };
    const depSneaky = await dep(slugA, "update_profile", sneaky, updA.token);
    const rowAfter = await getAppUser(svc, projectA, updA.user.id);
    h.check("update_me_allowlist_ignores_security_fields",
      depSneaky.ok && depSneaky.data.user.roles.includes("user") && !depSneaky.data.user.roles.includes("admin")
        && rowAfter.roles.includes("user") && !rowAfter.roles.includes("admin") && rowAfter.status === "active"
        && rowAfter.email === mk("upd") && rowAfter.password_hash !== "0".repeat(64) && (rowAfter.password_hash || "").length === 64,
      `roles=${JSON.stringify(rowAfter.roles)} status=${rowAfter.status}`);
    await prev(projectA.id, "update_profile", { session_token: updA.token, args: { roles: ["admin"], status: "disabled", email: "evil@example.com" } });
    const prevRow = await getAppUser(svc, projectA, updA.user.id);
    h.check("preview_update_me_allowlist_ignores_security_fields",
      prevRow.roles.includes("user") && !prevRow.roles.includes("admin") && prevRow.status === "active" && prevRow.email === mk("upd"),
      `roles=${JSON.stringify(prevRow.roles)}`);

    // --- 4. changePassword on the deployed dispatch -------------------------------------------
    const chg = await signUpWithSession(svc, projectA.id, { email: mk("chg"), password: PASSWORD, full_name: "Change Me" }, { ip: "203.0.113.41" });
    const extraSess = await logIn(svc, projectA.id, { email: mk("chg"), password: PASSWORD }, { ip: "203.0.113.42" });
    const wrongCur = await dep(slugA, "change_password", { current_password: "wrong-current", new_password: NEW_PASSWORD }, chg.token);
    h.check("deployed_change_password_requires_current_password",
      !wrongCur.ok && wrongCur.code === "INVALID_CREDENTIALS", `${wrongCur.status}/${wrongCur.code}`);
    const weakNew = await dep(slugA, "change_password", { current_password: PASSWORD, new_password: "short" }, chg.token);
    h.check("deployed_change_password_refuses_weak_password",
      !weakNew.ok && weakNew.code === "PASSWORD_TOO_SHORT", `${weakNew.status}/${weakNew.code}`);
    const depChg = await dep(slugA, "change_password", { current_password: PASSWORD, new_password: NEW_PASSWORD }, chg.token);
    h.check("deployed_change_password_reachable_and_revokes_other_sessions",
      depChg.ok && depChg.data.ok === true && depChg.data.sessions_revoked >= 1
        && (await resolveSessionRecord(svc, projectA.id, extraSess.token)) === null
        && (await resolveSessionRecord(svc, projectA.id, chg.token)) !== null,
      `revoked=${depChg.ok ? depChg.data.sessions_revoked : depChg.error}`);
    await h.expectThrow("old_password_invalid_after_change",
      () => logIn(svc, projectA.id, { email: mk("chg"), password: PASSWORD }, { ip: "203.0.113.43" }), "INVALID_CREDENTIALS");
    h.check("new_password_signs_in_after_change",
      !!(await logIn(svc, projectA.id, { email: mk("chg"), password: NEW_PASSWORD }, { ip: "203.0.113.44" })).token,
      "deployed changePassword left login behavior unchanged");

    // --- 5. changePassword on the preview dispatch ---------------------------------------------
    const chgP = await signUpWithSession(svc, projectA.id, { email: mk("chgp"), password: PASSWORD, full_name: "Change Preview" }, { ip: "203.0.113.45" });
    const extraSessP = await logIn(svc, projectA.id, { email: mk("chgp"), password: PASSWORD }, { ip: "203.0.113.56" });
    await h.expectThrow("preview_change_password_requires_session",
      () => prev(projectA.id, "change_password", { args: { current_password: PASSWORD, new_password: NEW_PASSWORD } }), "AUTH_REQUIRED");
    await h.expectThrow("preview_change_password_requires_current_password",
      () => prev(projectA.id, "change_password", { session_token: chgP.token, args: { current_password: "wrong-current", new_password: NEW_PASSWORD } }), "INVALID_CREDENTIALS");
    const prevChg = await prev(projectA.id, "change_password", { session_token: chgP.token, args: { current_password: PASSWORD, new_password: NEW_PASSWORD } });
    h.check("preview_change_password_reachable",
      prevChg.ok === true && prevChg.sessions_revoked >= 1
        && (await resolveSessionRecord(svc, projectA.id, extraSessP.token)) === null
        && (await resolveSessionRecord(svc, projectA.id, chgP.token)) !== null,
      JSON.stringify(prevChg).slice(0, 120));
    h.check("preview_new_password_signs_in_after_change",
      !!(await logIn(svc, projectA.id, { email: mk("chgp"), password: NEW_PASSWORD }, { ip: "203.0.113.46" })).token,
      "preview changePassword left login behavior unchanged");

    // --- 6. resetPasswordRequest: reachable, anti-enumeration, never leaks the secret ----------
    const rst = await signUpWithSession(svc, projectA.id, { email: mk("rst"), password: PASSWORD, full_name: "Reset Me" }, { ip: "203.0.113.47" });
    const depReq = await dep(slugA, "request_password_reset", { email: mk("rst") });
    const depReqUnknown = await dep(slugA, "request_password_reset", { email: mk("ghost") });
    h.check("deployed_reset_request_reachable_and_anti_enumeration",
      depReq.ok && depReq.data.ok === true && depReqUnknown.ok
        && JSON.stringify(depReq.data) === JSON.stringify(depReqUnknown.data)
        && !("token" in depReq.data),
      `known=${JSON.stringify(depReq.data)} unknown=${JSON.stringify(depReqUnknown.data)}`);
    const prevReq = await prev(projectA.id, "request_password_reset", { args: { email: mk("rst") } });
    const prevReqUnknown = await prev(projectA.id, "request_password_reset", { args: { email: mk("ghost2") } });
    h.check("preview_reset_request_reachable_and_anti_enumeration",
      prevReq.ok === true && JSON.stringify(prevReq) === JSON.stringify(prevReqUnknown) && !("token" in prevReq),
      `known=${JSON.stringify(prevReq)} unknown=${JSON.stringify(prevReqUnknown)}`);

    // --- 7. resetPassword: single-use token across BOTH surfaces; fail-closed inputs -----------
    const captured = [];
    await requestPasswordReset(svc, projectA, { email: mk("rst") }, { ip: "203.0.113.48", onToken: (t) => { captured.push(t); } });
    const resetToken = captured.length ? captured[captured.length - 1].token : null;
    h.check("reset_secret_reaches_delivery_hook_only", /^[a-f0-9]{64}$/.test(resetToken || ""), "the raw single-use secret exists only in the delivery hook");
    const badTok = await dep(slugA, "confirm_password_reset", { token: "f".repeat(64), new_password: NEW_PASSWORD });
    h.check("deployed_reset_refuses_unknown_token", !badTok.ok && badTok.code === "TOKEN_INVALID", `${badTok.status}/${badTok.code}`);
    const depReset = await dep(slugA, "confirm_password_reset", { token: resetToken, new_password: NEW_PASSWORD });
    h.check("deployed_reset_reachable",
      depReset.ok && depReset.data.ok === true && depReset.data.sessions_revoked >= 1
        && (await resolveSessionRecord(svc, projectA.id, rst.token)) === null,
      JSON.stringify(depReset).slice(0, 120));
    const replayDep = await dep(slugA, "confirm_password_reset", { token: resetToken, new_password: NEW_PASSWORD });
    h.check("deployed_reset_token_single_use", !replayDep.ok && replayDep.code === "TOKEN_USED", `${replayDep.status}/${replayDep.code}`);
    await h.expectThrow("reset_token_single_use_across_surfaces",
      () => prev(projectA.id, "confirm_password_reset", { args: { token: resetToken, new_password: NEW_PASSWORD } }), "TOKEN_USED");
    await h.expectThrow("old_password_invalid_after_reset",
      () => logIn(svc, projectA.id, { email: mk("rst"), password: PASSWORD }, { ip: "203.0.113.49" }), "INVALID_CREDENTIALS");
    h.check("new_password_signs_in_after_reset",
      !!(await logIn(svc, projectA.id, { email: mk("rst"), password: NEW_PASSWORD }, { ip: "203.0.113.50" })).token,
      "deployed reset left login behavior unchanged");

    // --- 8. preview reset confirm with its own token --------------------------------------------
    const rstP = await signUpWithSession(svc, projectA.id, { email: mk("rstp"), password: PASSWORD, full_name: "Reset Preview" }, { ip: "203.0.113.51" });
    const capturedP = [];
    await requestPasswordReset(svc, projectA, { email: mk("rstp") }, { ip: "203.0.113.52", onToken: (t) => { capturedP.push(t); } });
    const tokP = capturedP.length ? capturedP[capturedP.length - 1].token : null;
    const prevReset = await prev(projectA.id, "confirm_password_reset", { args: { token: tokP, new_password: NEW_PASSWORD } });
    h.check("preview_reset_reachable",
      prevReset.ok === true && prevReset.sessions_revoked >= 1 && (await resolveSessionRecord(svc, projectA.id, rstP.token)) === null,
      JSON.stringify(prevReset).slice(0, 120));
    await h.expectThrow("preview_reset_token_single_use",
      () => prev(projectA.id, "confirm_password_reset", { args: { token: tokP, new_password: NEW_PASSWORD } }), "TOKEN_USED");
    h.check("preview_new_password_signs_in_after_reset",
      !!(await logIn(svc, projectA.id, { email: mk("rstp"), password: NEW_PASSWORD }, { ip: "203.0.113.53" })).token,
      "preview reset left login behavior unchanged");

    // --- 9. project isolation -------------------------------------------------------------------
    const crossDepUpd = await dep(slugB, "update_profile", { display_name: "Stolen" }, updA.token);
    h.check("deployed_session_isolated_across_projects", !crossDepUpd.ok && crossDepUpd.code === "AUTH_REQUIRED", `${crossDepUpd.status}/${crossDepUpd.code}`);
    await h.expectThrow("preview_session_isolated_across_projects",
      () => prev(projectB.id, "update_profile", { session_token: updA.token, args: { display_name: "Stolen" } }), "AUTH_REQUIRED");
    const iso = await signUpWithSession(svc, projectA.id, { email: mk("iso"), password: PASSWORD, full_name: "Isolation" }, { ip: "203.0.113.54" });
    const capturedIso = [];
    await requestPasswordReset(svc, projectA, { email: mk("iso") }, { ip: "203.0.113.55", onToken: (t) => { capturedIso.push(t); } });
    const tokIso = capturedIso.length ? capturedIso[capturedIso.length - 1].token : null;
    const crossDepReset = await dep(slugB, "confirm_password_reset", { token: tokIso, new_password: NEW_PASSWORD });
    h.check("deployed_reset_token_isolated_across_projects",
      !crossDepReset.ok && crossDepReset.code === "TOKEN_INVALID", `${crossDepReset.status}/${crossDepReset.code}`);
    await h.expectThrow("preview_reset_token_isolated_across_projects",
      () => prev(projectB.id, "confirm_password_reset", { args: { token: tokIso, new_password: NEW_PASSWORD } }), "TOKEN_INVALID");
    const sameProjReset = await dep(slugA, "confirm_password_reset", { token: tokIso, new_password: NEW_PASSWORD });
    h.check("reset_token_still_valid_in_own_project",
      sameProjReset.ok && sameProjReset.data.ok === true, "a refused cross-project confirm does not consume the token");

    return Response.json(h.summary());
  } catch (e) {
    return Response.json({
      ok: false, error: e.message, stack: String(e.stack || "").slice(0, 800),
      ...(h.summary ? ((s) => ({ passed: s.passed, failed: s.failed, failures: s.failures }))(h.summary()) : {}),
    }, { status: 500 });
  } finally {
    for (const pid of projects) {
      for (const name of ["AppUser", "AppSession", "AppAuthToken", "ProjectFile", "Deployment", "DeploymentArtifact", "ProjectVersion"]) {
        await purgeBy(svc, name, { project_id: pid });
      }
    }
    await cleanupWorkspace(svc, ws ? ws.id : null, ["AuditLog", "WorkspaceMember", "Project"]).catch(() => {});
  }
}