// G-5 app-user invitation certification: the DOCUMENTED deployed-app invitation surface
// (auth.inviteUser(userEmail, role) / users.inviteUser(user_email, role) — published as
// equivalent) works end-to-end through the REAL dispatch (shared/previewAuth.ts, the same
// shared primitive the deployed runtime dispatches to), reuses ONLY existing primitives
// (AppUser, single-use hashed AppAuthToken, existing audit + limiter) and stays strictly
// separate from the workspace-member control plane.
//
// Certifies exactly: valid user invite; valid admin invite; unauthorized caller rejected;
// invalid role rejected; required email/role validation; single-use invitation token;
// project isolation; no session minted for the invitee; workspace-member invites unchanged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { handlePreviewAuth } from "../../shared/previewAuth.ts";
import {
  signUpWithSession, inviteAppUser, consumeToken, getAppUser, findUserByEmail, logIn,
} from "../../shared/appAuth.ts";
import { inviteMember } from "../../shared/collaboration.ts";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const PASSWORD = "Inv1te-Cert-Pass!";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let ws = null;
  try {
    const platformUser = await base44.auth.me();
    if (!platformUser) return Response.json({ error: "Unauthorized" }, { status: 401 });
    ws = await svc.entities.Workspace.create({ name: "G-5 Invite Parity", owner_id: platformUser.id, credits_balance: 0 });
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: "G5 App", slug: `g5-${crypto.randomUUID().slice(0, 8)}` });
    const other = await svc.entities.Project.create({ workspace_id: ws.id, name: "G5 Other App", slug: `g5x-${crypto.randomUUID().slice(0, 8)}` });
    const preview = (op, body = {}) => handlePreviewAuth(base44, platformUser, { project_id: project.id, op, ...body });
    const uid = crypto.randomUUID().slice(0, 8);
    const mk = (n) => `g5-${n}-${uid}@example.com`;

    // Fixtures: a system-admin app user and a plain-role app user, both verified with live
    // sessions through the existing fixture surface.
    const adminFx = await signUpWithSession(svc, project.id, { email: mk("admin"), password: PASSWORD }, { ip: "203.0.113.30" });
    await svc.entities.AppUser.update(adminFx.user.id, { roles: ["admin"] });
    const plainFx = await signUpWithSession(svc, project.id, { email: mk("plain"), password: PASSWORD }, { ip: "203.0.113.31" });

    // --- 1. unauthorized caller rejected ------------------------------------------------------
    await h.expectThrow("invite_requires_authentication", () => preview("invite_user", { args: { user_email: mk("u1"), role: "user" } }), "AUTH_REQUIRED");

    // --- 2. valid user invite -----------------------------------------------------------------
    // PROVEN Base44 body (runtime probe): HTTP 200 with EXACTLY { "id": "<app_id>" } — and the
    // invite creates NO platform User row (the AppUser invitee row is the app's own registry).
    const inviteeEmail = mk("u1");
    const invitedUser = await preview("invite_user", { session_token: adminFx.token, args: { user_email: inviteeEmail, role: "user" } });
    h.check("valid_user_invite_exact_body",
      Object.keys(invitedUser).length === 1 && invitedUser.id === project.id,
      JSON.stringify(invitedUser));
    const invited1 = await findUserByEmail(svc, project, inviteeEmail);
    h.check("invitee_created_unverified_without_credentials",
      !!invited1 && invited1.email_verified === false,
      "the invitee is an AppUser row, unverified, with no password");
    h.check("invite_creates_no_user_rows",
      (await svc.entities.User.filter({ email: inviteeEmail }, "created_date", 5)).length === 0,
      "no User row is created by the invite");
    h.check("invite_mints_no_session",
      (await svc.entities.AppSession.filter({ project_id: project.id, app_user_id: invited1.id }, "-created_date", 5)).length === 0
      && !("session_token" in invitedUser),
      "no AppSession row exists for the invitee and no token is returned");
    // Targeted HTTP-level assertion: the same op over the preview HTTP surface answers 200 and the
    // EXACT body inside the endpoint's { result } transport envelope.
    const httpRes = await base44.functions.fetch("/previewAuth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: project.id, op: "invite_user", session_token: adminFx.token, args: { user_email: mk("h1"), role: "user" } }),
    });
    const httpBody = await httpRes.json().catch(() => null);
    h.check("invite_http_200_exact_body",
      httpRes.status === 200 && Object.keys(httpBody?.result || {}).length === 1 && httpBody.result.id === project.id,
      JSON.stringify({ status: httpRes.status, body: httpBody }));

    // --- 3. valid admin invite ------------------------------------------------------------------
    const invitedAdmin = await preview("invite_user", { session_token: adminFx.token, args: { user_email: mk("a1"), role: "admin" } });
    const adminRow = await findUserByEmail(svc, project, mk("a1"));
    h.check("valid_admin_invite_exact_body",
      Object.keys(invitedAdmin).length === 1 && invitedAdmin.id === project.id && !!adminRow && adminRow.roles.includes("admin"),
      `id=${invitedAdmin.id} role=${JSON.stringify(adminRow?.roles)}`);

    // --- 4. role rule through the existing permission model -------------------------------------
    const plainInvitesUser = await preview("invite_user", { session_token: plainFx.token, args: { user_email: mk("u2"), role: "user" } });
    h.check("plain_user_can_invite_user",
      plainInvitesUser.id === project.id && Object.keys(plainInvitesUser).length === 1,
      "the documented public-app matrix: a non-admin may invite role \"user\" — with the exact proven body");
    await h.expectThrow("non_admin_cannot_invite_admin", () => preview("invite_user", { session_token: plainFx.token, args: { user_email: mk("a2"), role: "admin" } }), "FORBIDDEN");

    // --- 5. validation ----------------------------------------------------------------------------
    await h.expectThrow("invalid_role_rejected", () => preview("invite_user", { session_token: adminFx.token, args: { user_email: mk("u3"), role: "superuser" } }), "ROLE_INVALID");
    await h.expectThrow("required_role_validation", () => preview("invite_user", { session_token: adminFx.token, args: { user_email: mk("u3") } }), "ROLE_REQUIRED");
    await h.expectThrow("required_email_validation", () => preview("invite_user", { session_token: adminFx.token, args: { user_email: "not-an-email", role: "user" } }), "EMAIL_INVALID");
    await h.expectThrow("duplicate_email_refused", () => preview("invite_user", { session_token: adminFx.token, args: { user_email: mk("u1"), role: "user" } }), "EMAIL_TAKEN");

    // --- 6. single-use invitation token (the EXISTING hashed single-use mechanism) -----------
    const captured = [];
    const direct = await inviteAppUser(svc, project, { id: adminFx.user.id, roles: ["admin"] }, { user_email: mk("u4"), role: "user" }, { ip: "203.0.113.32", onToken: (t) => { captured.push(t); } });
    const pending = await svc.entities.AppAuthToken.filter({ project_id: project.id, app_user_id: direct.user.id, kind: "email_verification", status: "pending" }, "-created_date", 5);
    h.check("invite_issues_single_pending_hashed_token",
      pending.length === 1 && captured.length === 1 && !JSON.stringify(pending[0]).includes(captured[0].token),
      "exactly one pending token row, hashed at rest — the raw code exists only in the delivery hook");
    const used = await consumeToken(svc, project, { token: captured[0].token, kind: "email_verification" });
    h.check("invitation_token_single_use", used.status === "used", "the token consumes exactly once");
    await h.expectThrow("invitation_token_not_reusable", () => consumeToken(svc, project, { token: captured[0].token, kind: "email_verification" }), "TOKEN_USED");

    // --- 7. invitation does not authenticate prematurely ---------------------------------------
    await h.expectThrow("invitee_cannot_login_without_password", () => logIn(svc, project.id, { email: mk("u1"), password: "whatever-password" }, { ip: "203.0.113.33" }), "INVALID_CREDENTIALS");

    // --- 8. project isolation -------------------------------------------------------------------
    h.check("invite_isolated_across_projects",
      (await findUserByEmail(svc, other, mk("u1"))) === null && (await getAppUser(svc, other, invited1.id)) === null,
      "project A's invitee resolves to nothing in project B");

    // --- 9. workspace-member invitation unchanged (separate control plane) ---------------------
    const appInvitedEmails = [mk("u1"), mk("a1"), mk("u2"), mk("u4")];
    const memberRowsForAppEmails = [];
    for (const e of appInvitedEmails) memberRowsForAppEmails.push(...await svc.entities.WorkspaceMember.filter({ workspace_id: ws.id, email: e }, "-created_date", 5).catch(() => []));
    h.check("app_invites_create_no_workspace_members", memberRowsForAppEmails.length === 0, "the app-user invitation never touches the workspace-member plane");
    const wmEmail = `g5-ws-${uid}@example.com`;
    await inviteMember(base44, platformUser, { workspace_id: ws.id, email: wmEmail, role: "viewer" });
    const wmRows = await svc.entities.WorkspaceMember.filter({ workspace_id: ws.id, email: wmEmail }, "-created_date", 5);
    h.check("workspace_member_invite_unchanged",
      wmRows.length === 1 && wmRows[0].status === "invited" && !!wmRows[0].invite_token,
      "the EXISTING workspace-member invitation still works with its own single-use token");

    for (const name of ["AppUser", "AppSession", "AppAuthToken", "AuditLog"]) {
      for (const r of await svc.entities[name].filter({ project_id: project.id }, "-created_date", 500).catch(() => [])) {
        await svc.entities[name].delete(r.id).catch(() => {});
      }
    }
    for (const r of await svc.entities.WorkspaceMember.filter({ workspace_id: ws.id }, "-created_date", 50).catch(() => [])) {
      await svc.entities.WorkspaceMember.delete(r.id).catch(() => {});
    }
    return harnessResponse(h);
  } catch (e) {
    return harnessError(h, e);
  } finally {
    await cleanupWorkspace(svc, ws ? ws.id : null, ["Project", "AuditLog"]).catch(() => {});
  }
}