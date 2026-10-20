// App transfer (danger zone): thin HTTP boundary that delegates the documented Transfer Ownership
// flow AND the existing same-owner Move app to shared/projectTransfer.ts. No logic lives here.
//
//   op=move          → Move app (existing immediate same-owner re-parent)
//   op=initiate      → Transfer Ownership: owner records a pending transfer to an outside recipient
//   op=accept        → Transfer Ownership: recipient chooses a workspace they own and completes it
//   op=decline       → Transfer Ownership: recipient or owner cancels a pending transfer
//   op=list_pending  → recipient surface: transfers addressed to the authenticated user
//   op=my_workspaces → recipient surface: workspaces the authenticated user may select
//   op=status        → owner-facing transfer status for one project
//
// Omitting op defaults to "move" so the existing Move app caller contract is unchanged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  transferProject, initiateTransfer, acceptTransfer, declineTransfer,
  listPendingTransfers, listMyWorkspaces, transferStatus,
} from "../../shared/projectTransfer.ts";

const OPS = {
  move: (b, u, body) => transferProject(b, u, { project_id: body.project_id, target_workspace_id: body.target_workspace_id }),
  initiate: (b, u, body) => initiateTransfer(b, u, { project_id: body.project_id, recipient_email: body.recipient_email }),
  accept: (b, u, body) => acceptTransfer(b, u, { project_id: body.project_id, target_workspace_id: body.target_workspace_id }),
  decline: (b, u, body) => declineTransfer(b, u, { project_id: body.project_id }),
  list_pending: (b, u) => listPendingTransfers(b, u),
  my_workspaces: (b, u) => listMyWorkspaces(b, u),
  status: (b, u, body) => transferStatus(b, u, { project_id: body.project_id }),
};

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const op = String(body.op || "move");
    const handler = OPS[op];
    if (!handler) return Response.json({ error: `Unknown operation '${op}'`, code: "TRANSFER_BAD_OPERATION" }, { status: 400 });
    const result = await handler(base44, user, body);
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}