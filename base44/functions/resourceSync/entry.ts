// The authorized COMMAND boundary for Base44 resource push / pull (E14 + E15).
//
// Three actions, one shape:
//   pull   — the project's current resource state, in the canonical local representation
//   status — what a push would do, with nothing written
//   push   — apply the local resource state (full-sync by default, merge on request)
//
// The exit contract is the platform's EXISTING one, unchanged: success answers 200 with a parseable
// JSON body, and every failure answers the deterministic non-zero status its error carries — 400 a
// validation/user error, 401 unauthenticated, 403 permission, 404 a missing project or resource,
// 409 a conflict, 500 an internal failure. No second exit-code system is introduced, and the body is
// always machine-readable JSON: `{ ok, error, code, details, status }`.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { pullResources, pushResources, resourceStatus } from "../../shared/resourceSync.ts";
import { commandFailure, commandStatus, resourceError } from "../../shared/resourceErrors.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      const e = resourceError("RESOURCE_UNAUTHENTICATED", "Sign in required");
      return Response.json(commandFailure(e), { status: commandStatus(e) });
    }
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "pull");
    const args = {
      project_id: String(body.project_id || ""),
      resources: body.resources || [],
      kinds: Array.isArray(body.kinds) && body.kinds.length ? body.kinds.map(String) : null,
      mode: body.mode || "full",
      expected_version: body.expected_version ?? null,
      message: body.message || null,
    };

    if (action === "pull") return Response.json({ ok: true, ...(await pullResources(base44, user, args)) });
    if (action === "status") return Response.json({ ok: true, ...(await resourceStatus(base44, user, args)) });
    if (action === "push") return Response.json({ ok: true, ...(await pushResources(base44, user, args)) });

    const unknown = resourceError("RESOURCE_INVALID_SOURCE", `Unknown action '${action}' (pull, status, push)`, { action });
    return Response.json(commandFailure(unknown), { status: commandStatus(unknown) });
  } catch (error) {
    return Response.json(commandFailure(error), { status: commandStatus(error) });
  }
}