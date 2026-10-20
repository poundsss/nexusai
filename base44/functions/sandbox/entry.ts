// The authorized sandbox / remote-development command surface.
//
// One operation per request: info · read_file · list_directory · grep · write_file · edit_file ·
// delete_file · run_command · create_checkpoint. Every operation resolves the caller's project
// authorization itself (shared/sandbox.ts → shared/authz.ts), and every failure answers with the
// EXISTING E15 resource error contract, so a remote client gets a deterministic code and status.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { sandboxExecute, SANDBOX_OPS } from "../../shared/sandbox.ts";
import { commandFailure, commandStatus } from "../../shared/resourceErrors.ts";

export const config = { method: "POST", description: "Sandbox / remote-development operations over a project's filesystem, build and checkpoints." };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ ok: false, error: "Unauthorized", code: "RESOURCE_UNAUTHENTICATED", status: 401 }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const op = String(body.op || body.action || "info");
    return Response.json(await sandboxExecute(base44, user, op, body));
  } catch (error) {
    const failure = commandFailure(error);
    return Response.json({ ...failure, operations: Object.keys(SANDBOX_OPS) }, { status: commandStatus(error) });
  }
}