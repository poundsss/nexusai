// Workspace membership control plane: list, invite, accept, change role, remove.
//
// A thin HTTP adapter. The implementation — and with it the whole security model — lives in
// shared/collaboration.ts:
//   • every action resolves the caller's role SERVER-side (Workspace.owner_id or an ACTIVE
//     WorkspaceMember row); the caller never states its own role;
//   • managing members requires member.manage, so an editor or viewer cannot escalate anyone;
//   • the owner is derived from Workspace.owner_id and can never be granted, changed or removed;
//   • an admin cannot modify another admin's membership — only the owner can;
//   • invite_token is single-use, cleared on accept, and returned only to the inviter.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { listMembers, inviteMember, acceptInvitation, updateMemberRole, removeMember } from "../../shared/collaboration.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const action = String(body.action || "list");
    const workspace_id = String(body.workspace_id || "");

    if (action === "accept") return Response.json(await acceptInvitation(base44, user, { invite_token: body.invite_token }));
    if (action === "list") return Response.json(await listMembers(base44, user, workspace_id));
    if (action === "invite") return Response.json(await inviteMember(base44, user, { workspace_id, email: body.email, role: body.role }));
    if (action === "update_role") return Response.json(await updateMemberRole(base44, user, { workspace_id, member_id: body.member_id, role: body.role }));
    if (action === "remove") return Response.json(await removeMember(base44, user, { workspace_id, member_id: body.member_id }));

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}