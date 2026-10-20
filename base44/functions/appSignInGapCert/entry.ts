// Certification + fixture helpers for the PUBLISHED-APP SIGN-IN GAP:
// a private/workspace app refused an anonymous visitor with the generic
// "This application is not available" error and no way to authenticate.
//
// Modes:
//   seed    { project_id, email, password } → creates a VERIFIED end-user
//           account directly through the shipping appAuth surface
//           (signUpWithSession: auto-verifies + issues the session) and
//           exercises the login primitive (token issuance) on it.
//   cleanup { project_id, email } → removes the seeded AppUser, its sessions
//           and its auth tokens.
//   restore { project_id } → restores visibility='public' and archives the
//           fixture project.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { signUpWithSession, logIn, findUserByEmail, normalizeEmail } from "../../shared/appAuth.ts";

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const mode = body.mode || "seed";
  try {
    const project = body.project_id ? await svc.entities.Project.get(body.project_id) : null;
    if (mode !== "restore" && !project) return Response.json({ error: "PROJECT_NOT_FOUND" }, { status: 404 });
    const email = normalizeEmail(body.email || "gapfix-enduser@example.com");
    const password = body.password || "GapFix-Pass1!";

    if (mode === "cleanup") {
      const user = await findUserByEmail(svc, project.id, email).catch(() => null);
      if (user) {
        await svc.entities.AppSession.deleteMany({ project_id: project.id, app_user_id: user.id });
        await svc.entities.AppAuthToken.deleteMany({ project_id: project.id, app_user_id: user.id });
        await svc.entities.AppUser.delete(user.id);
      }
      return Response.json({ cleaned: true, user_id: user ? user.id : null });
    }

    if (mode === "restore") {
      await svc.entities.Project.update(project.id, { visibility: "public", status: "archived" });
      return Response.json({ restored: true });
    }

    // seed — a verified end user with a password, minted through the shipping surface.
    let created = false;
    let user = await findUserByEmail(svc, project.id, email).catch(() => null);
    if (!user) {
      await signUpWithSession(svc, project.id, { email, password, display_name: "Gap Fix End User" }, {
        ip: "203.0.113.77", user_agent: "appSignInGapCert/1.0",
      });
      user = await findUserByEmail(svc, project.id, email);
      created = true;
    } else if (!user.email_verified) {
      await svc.entities.AppUser.update(user.id, { email_verified: true, updated_at: new Date().toISOString() });
      user = await svc.entities.AppUser.get(user.id);
    }
    if (!user) return Response.json({ error: "USER_CREATE_FAILED" }, { status: 500 });

    // The login primitive issues a session token (the sign-in flow's terminal step).
    let loginErr = null, login = null;
    try { login = await logIn(svc, project.id, { email, password }, { ip: "203.0.113.78", user_agent: "appSignInGapCert/1.0" }); }
    catch (e) { loginErr = e.message; }

    return Response.json({
      mode, project_id: project.id, slug: project.slug, email, password,
      user_id: user.id, created, verified: user.email_verified === true,
      login_issues_session: !loginErr && !!login && !!login.token,
      login_error: loginErr,
    });
  } catch (e) {
    return Response.json({ error: "SEED_FAILED", detail: String((e && (e.detail || e.message)) || e).slice(0, 500), code: e && e.code }, { status: 200 });
  }
}