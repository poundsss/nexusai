// Targeted certification for the Builder App Users → Invite users gap.
//
// Certifies the NEW `invite` action on the `appUsers` backend function, which reuses ONLY the
// existing certified `inviteAppUser` primitive (G-5 proven Base44 inviteUser contract). Runs
// against disposable scratch data; no real project is touched.
//
// Covers:
//   • valid user invite → ok, AppUser persisted with EXACT email + role, email_verified=false
//   • valid admin invite → ok, role=["admin"]
//   • the invite primitive is called with the exact email + role (asserted via the persisted row)
//   • persistence/pending state: the invitee appears in `list` with email_verified=false (the
//     existing pending projection) and a pending email_verification AppAuthToken row exists
//   • no real email is sent — in the backend-function environment no sendEmail hook is wired, so
//     deliverToken returns delivered=false; invitation_sent is false (the existing mock path)
//   • role validation: missing role → 400; unknown role → 400; invalid role (not user/admin) → 400
//     (caught by the backend's existing-role check before the primitive's ROLE_INVALID)
//   • missing email → 400; duplicate email → 409 EMAIL_TAKEN (primitive)
//   • permission enforcement: action !== "list" routes to project.write via loadAuthorizedProject;
//     an unknown project_id is refused (the existing authorization path runs)
//   • audit event written (app_user.invited)
//
// The SDK's functions.invoke throws on non-2xx (the functions axios client has response
// interception disabled), so `tryInvoke` normalizes both thrown and returned responses.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";

const CLEANUP = ["AppAuthToken", "AppSession", "AppUser", "AppRole", "AuditLog", "Project", "Workspace"];

async function tryInvoke(client, name, payload) {
  try {
    const r = await client.functions.invoke(name, payload);
    return { status: r.status, data: r.data };
  } catch (e) {
    return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? { error: e.message, code: e.code ?? null } };
  }
}

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let ws = null;
  const stamp = Date.now();
  const uid = crypto.randomUUID().slice(0, 8);
  const mk = (n) => `inv-${n}-${uid}@example.com`;

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });

    ws = await svc.entities.Workspace.create({ name: `appusers-invite-ws-${stamp}`, owner_id: caller.id, status: "active" });
    const project = await svc.entities.Project.create({ workspace_id: ws.id, name: `Invite App ${stamp}`, slug: `inv-${stamp}` });

    // ===================== 1. valid user invite =====================
    const email1 = mk("u1");
    const r1 = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "invite", user_email: email1, role: "user" });
    h.check("valid user invite → 200 ok", r1.status === 200 && r1.data?.ok === true, JSON.stringify(r1.data));
    h.check("invite returns the invitee id + roles", !!r1.data?.user?.id && (r1.data?.user?.roles || []).includes("user"), JSON.stringify(r1.data?.user));
    h.check("invitation_sent is false (no sendEmail hook in this env — no real email)", r1.data?.invitation_sent === false, JSON.stringify(r1.data?.invitation_sent));

    // The invite primitive was called with the EXACT email + role: verify the persisted AppUser.
    const users1 = await svc.entities.AppUser.filter({ project_id: project.id, email: email1 }, "-created_date", 5);
    const invited1 = users1[0];
    h.check("invitee persisted with the EXACT email", !!invited1 && invited1.email === email1, invited1?.email || "missing");
    h.check("invitee persisted with role=['user']", !!invited1 && JSON.stringify(invited1.roles || []) === JSON.stringify(["user"]), JSON.stringify(invited1?.roles));
    h.check("invitee is unverified (email_verified=false)", !!invited1 && invited1.email_verified === false, String(invited1?.email_verified));
    h.check("invitee has no password (passwordless)", !!invited1 && !invited1.password_hash, "no hash");

    // ===================== 2. pending state + single-use token =====================
    const list1 = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "list" });
    const inList = (list1.data?.users || []).find((u) => u.email === email1);
    h.check("invitee appears in list with email_verified=false (pending projection)", !!inList && inList.email_verified === false, JSON.stringify(inList?.email_verified));
    const pendingTokens = await svc.entities.AppAuthToken.filter({ project_id: project.id, app_user_id: invited1.id, kind: "email_verification", status: "pending" }, "-created_date", 5);
    h.check("exactly one pending email_verification token row exists", pendingTokens.length === 1, String(pendingTokens.length));

    // ===================== 3. valid admin invite =====================
    const email2 = mk("a1");
    const r2 = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "invite", user_email: email2, role: "admin" });
    h.check("valid admin invite → 200 ok, role=['admin']", r2.status === 200 && (r2.data?.user?.roles || []).includes("admin"), JSON.stringify(r2.data?.user));
    const adminRow = (await svc.entities.AppUser.filter({ project_id: project.id, email: email2 }, "-created_date", 5))[0];
    h.check("admin invitee persisted with role=['admin']", !!adminRow && JSON.stringify(adminRow.roles || []) === JSON.stringify(["admin"]), JSON.stringify(adminRow?.roles));

    // ===================== 4. role validation =====================
    const missingRole = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "invite", user_email: mk("u3"), role: "" });
    h.check("missing role → 400", missingRole.status === 400, JSON.stringify(missingRole.data));

    const unknownRole = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "invite", user_email: mk("u4"), role: "superuser" });
    h.check("unknown role (not in project roles) → 400", unknownRole.status === 400, JSON.stringify(unknownRole.data));

    const invalidRole = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "invite", user_email: mk("u5"), role: "editor" });
    h.check("role not in project's existing roles → 400 (caught before primitive)", invalidRole.status === 400, JSON.stringify(invalidRole.data));

    // ===================== 5. email validation =====================
    const missingEmail = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "invite", user_email: "", role: "user" });
    h.check("missing email → 400", missingEmail.status === 400, JSON.stringify(missingEmail.data));

    const dup = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "invite", user_email: email1, role: "user" });
    h.check("duplicate email → 409 EMAIL_TAKEN (primitive)", dup.status === 409 && dup.data?.code === "EMAIL_TAKEN", JSON.stringify(dup.data));

    // ===================== 6. permission enforcement =====================
    // action !== "list" routes to project.write via loadAuthorizedProject; an unknown project_id
    // is refused — the existing authorization path runs for the invite action.
    const unknownProject = await tryInvoke(base44, "appUsers", { project_id: "nonexistent-project-id", action: "invite", user_email: mk("u6"), role: "user" });
    h.check("unknown project_id → refused (authz path runs for invite)", unknownProject.status >= 400 && unknownProject.status !== 500, JSON.stringify({ status: unknownProject.status, data: unknownProject.data }));

    // ===================== 7. audit event =====================
    const auditLogs = await svc.entities.AuditLog.filter({ workspace_id: ws.id, project_id: project.id, action: "app_user.invited" }, "-created_date", 10);
    h.check("app_user.invited audit event written", auditLogs.length >= 1, String(auditLogs.length));

    // ===================== 8. invite does not modify unrelated App Users functionality =====================
    // assign_role / set_status still work after adding invite (smoke).
    const assign = await tryInvoke(base44, "appUsers", { project_id: project.id, action: "assign_role", app_user_id: invited1.id, role: "admin" });
    h.check("assign_role still works alongside invite", assign.status === 200 && (assign.data?.roles || []).includes("admin"), JSON.stringify(assign.data));

    await cleanupWorkspace(svc, ws.id, CLEANUP);
    return harnessResponse(h);
  } catch (error) {
    if (ws) await cleanupWorkspace(svc, ws.id, CLEANUP);
    return harnessError(h, error);
  }
}