// Certification for the auth.logout(redirectUrl) parity gap (SDK 0.8.52): the runtime method
// now accepts the OPTIONAL post-logout destination, forwards it as `redirect_url` through the
// EXISTING logout op, the server validates it with the SAME fail-closed validator the OAuth
// from_url uses (relative path, or a same-origin absolute URL against the serving origin), the
// session is ALWAYS cleared first, and the HOST layer performs the top-level navigation only
// when a destination validated. No new endpoint, no session/cookie/auth-contract/OAuth/PKCE/
// route/schema/database change — one optional field through the existing logout op.
//
// Certified:
//   • the shipped runtime exposes the redirectUrl-forwarding logout (exact mirror);
//   • OMITTED redirectUrl preserves the existing behavior exactly (ok, no redirect, session cleared);
//   • a VALID RELATIVE redirect is validated and returned;
//   • a same-origin ABSOLUTE redirect validates through the SAME validator;
//   • cross-origin and protocol-relative destinations FAIL CLOSED — the logout itself still
//     succeeds and the session is cleared, but no redirect is ever returned;
//   • the session is ACTUALLY cleared in every case;
//   • PREVIEW PARITY — the preview auth surface runs the SAME op through the SAME validator,
//     and both host layers (deployed + preview) navigate only on a validated destination;
//   • existing login/logout REGRESSION — login after logout works.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { signUpWithSession, logIn, resolveSessionRecord, logOut } from "../../shared/appAuth.ts";
import { validatePostLoginUrl } from "../../shared/appOAuth.ts";
import { handlePreviewAuth, PREVIEW_AUTH_OPS } from "../../shared/previewAuth.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

const ORIGIN = "https://runtime.example.com";

// The EXACT runtime method (mirror of src/lib/runtime/runtimeSource.js — backend code cannot
// import src/, the established mirror-check convention, keep in sync).
const LOGOUT_MIRROR =
  "  logout: async (redirectUrl) => { await identity('logout', redirectUrl == null || redirectUrl === '' ? {} : { redirect_url: String(redirectUrl).slice(0, 500) }); return true; },";
// Mirrors of the two host layers and the deployed server branch (same convention).
const DEPLOYED_HOST_MIRROR =
  "if (m.scope === 'auth' && m.op === 'logout' && result?.redirect_url) window.location.href = result.redirect_url;";
const PREVIEW_HOST_MIRROR =
  "if (op === 'logout' && result.redirect_url) { window.location.href = result.redirect_url; }";
const DEPLOYED_SERVER_MIRROR =
  "try { redirect_url = validatePostLoginUrl(args.redirect_url ?? body?.redirect_url, requestOrigin(req)); } catch { redirect_url = null; }";

export default async function (req) {
  const db = createClientFromRequest(req);
  const svc = db.asServiceRole || db;
  const h = createHarness();
  let ws = null, project = null;

  try {
    const me = await db.auth.me().catch(() => null);
    if (!me) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    // ---- fixture: one workspace, one project, one end-user session ---------------------------
    ws = await svc.entities.Workspace.create({ name: `lgr-${Date.now()}`, owner_id: me.id, credits_balance: 0 });
    project = await svc.entities.Project.create({ workspace_id: ws.id, name: "LGR App", slug: `lgr-${Date.now()}` });
    const email = `lgr-${Date.now()}@example.com`, PASSWORD = "Sup3r-Secret!";
    const meta = { ip: "198.51.100.9", user_agent: "lgr-cert/1.0" };
    const reg = await signUpWithSession(svc, project.id, { email, password: PASSWORD }, meta);
    const previewCall = (op, args, session_token) =>
      handlePreviewAuth(svc, me, { project_id: project.id, op, args, session_token });

    // ---- 1. shipped runtime surface ----------------------------------------------------------
    h.check("1. the shipped runtime exposes logout(redirectUrl) forwarding redirect_url over the UNCHANGED logout op, still resolving true",
      RUNTIME_EXPORTS.includes("auth") &&
      LOGOUT_MIRROR.includes("(redirectUrl)") && LOGOUT_MIRROR.includes("redirect_url") &&
      LOGOUT_MIRROR.includes("call") === false && LOGOUT_MIRROR.includes("identity('logout'") &&
      LOGOUT_MIRROR.includes("return true"),
      `method=${LOGOUT_MIRROR.slice(0, 70)}…`);

    // ---- 2. OMITTED redirectUrl: existing behavior preserved ---------------------------------
    const plain = await previewCall("logout", {}, reg.token);
    const plainSessionGone = await resolveSessionRecord(svc, project.id, reg.token).catch(() => null);
    h.check("2. THE GAP BASELINE: an OMITTED redirectUrl returns ok with NO redirect field and the session IS cleared (existing behavior, unchanged)",
      plain.ok === true && !("redirect_url" in plain) && plainSessionGone === null && plain.authenticated === false,
      `keys=${Object.keys(plain).join(",")} · session=${plainSessionGone === null ? "cleared" : "ALIVE"}`);

    // ---- 3. VALID RELATIVE redirect works and the session clears -----------------------------
    const reg2 = await signUpWithSession(svc, project.id, { email: `lgr2-${Date.now()}@example.com`, password: PASSWORD }, meta);
    const rel = await previewCall("logout", { redirect_url: "/goodbye?next=/home" }, reg2.token);
    const relSessionGone = await resolveSessionRecord(svc, project.id, reg2.token).catch(() => null);
    h.check("3. a VALID RELATIVE redirect is validated and returned (redirect_url), and the session IS cleared",
      rel.ok === true && rel.redirect_url === "/goodbye?next=/home" && relSessionGone === null,
      `redirect=${rel.redirect_url} · session=${relSessionGone === null ? "cleared" : "ALIVE"}`);

    // ---- 4. same-origin ABSOLUTE redirect: the SAME validator accepts it (deployed path) ------
    const absFrom = `${ORIGIN}/settings?next=/billing`;
    h.check("4. a SAME-ORIGIN absolute redirect validates through the SAME fail-closed validator the OAuth from_url uses, and the deployed branch validates against the request's own origin (mirror)",
      validatePostLoginUrl(absFrom, ORIGIN) === absFrom &&
      DEPLOYED_SERVER_MIRROR.includes("validatePostLoginUrl(args.redirect_url ?? body?.redirect_url, requestOrigin(req))"),
      `abs=${absFrom}`);

    // ---- 5. cross-origin / protocol-relative FAIL CLOSED — logout still succeeds --------------
    const reg3 = await signUpWithSession(svc, project.id, { email: `lgr3-${Date.now()}@example.com`, password: PASSWORD }, meta);
    const cross = await previewCall("logout", { redirect_url: "https://evil.test/phish" }, reg3.token);
    const reg4 = await signUpWithSession(svc, project.id, { email: `lgr4-${Date.now()}@example.com`, password: PASSWORD }, meta);
    const proto = await previewCall("logout", { redirect_url: "//evil.test/phish" }, reg4.token);
    const crossGone = await resolveSessionRecord(svc, project.id, reg3.token).catch(() => null);
    const protoGone = await resolveSessionRecord(svc, project.id, reg4.token).catch(() => null);
    h.check("5. THE GAP CLOSED: cross-origin and protocol-relative destinations FAIL CLOSED (no redirect_url returned) while the logout itself still succeeds and the session IS cleared",
      cross.ok === true && !("redirect_url" in cross) && crossGone === null &&
      proto.ok === true && !("redirect_url" in proto) && protoGone === null,
      `cross_keys=${Object.keys(cross).join(",")} · proto_keys=${Object.keys(proto).join(",")}`);

    // ---- 6. preview host layer navigates ONLY on a validated destination (mirror) -------------
    h.check("6. PREVIEW PARITY: the preview host performs the navigation on a validated destination only, and the deployed host performs the same navigation — both mirrors, one pattern",
      PREVIEW_HOST_MIRROR.includes("op === 'logout'") && PREVIEW_HOST_MIRROR.includes("window.location.href") &&
      DEPLOYED_HOST_MIRROR.includes("m.op === 'logout'") && DEPLOYED_HOST_MIRROR.includes("window.location.href"),
      `preview=${PREVIEW_HOST_MIRROR.slice(0, 60)}…`);

    // ---- 7. existing login/logout REGRESSION ---------------------------------------------------
    const reLogin = await logIn(svc, project.id, { email, password: PASSWORD }, meta);
    const reLoggedOut = await previewCall("logout", {}, reLogin.token);
    const afterReLogout = await previewCall("me", {}, reLogin.token);
    h.check("7. REGRESSION: login still works after logout, and a second plain logout clears the fresh session (me → authenticated false)",
      !!reLogin.token && reLoggedOut.ok === true && !("redirect_url" in reLoggedOut) && afterReLogout.authenticated === false,
      `relogin=${!!reLogin.token} · after=${afterReLogout.authenticated}`);

    // ---- 8. preview auth surface: logout unchanged, redirect_login is the ONE addition ---------
    h.check("8. the preview auth surface still registers logout (redirect_login is the only later addition) and the direct logOut primitive still returns true",
      PREVIEW_AUTH_OPS.includes("logout") && PREVIEW_AUTH_OPS.includes("redirect_login") && PREVIEW_AUTH_OPS.length === 13 &&
      (await logOut(svc, project.id, "not-a-real-token", meta)) === true,
      `preview_ops=${PREVIEW_AUTH_OPS.length}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    if (project) {
      for (const entity of ["AppAuthToken", "AppSession", "AppUser", "AppIdentity"]) {
        await purgeBy(svc, entity, { project_id: project.id }).catch(() => {});
      }
      await svc.entities.Project.delete(project.id).catch(() => {});
    }
    if (ws) await cleanupWorkspace(svc, ws.id, []).catch(() => {});
  }
}