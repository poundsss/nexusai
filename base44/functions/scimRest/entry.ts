// SCIM 2.0 REST endpoint — thin HTTP adapter over the certified provisioning core.
//
// Addressing: the SCIM resource path is supplied via a `path` query or body param
// (e.g. "/scim/v2/Users/<id>"), because a Base44 backend function is exposed at a single
// path. The HTTP method is the real request method; a `method` body field is accepted
// ONLY so test_backend_function (which always POSTs) can exercise GET/PUT/PATCH/DELETE.
//
// Authorization reuses the existing gate: base44.auth.me() + workspace membership +
// scim.manage (writes) / sso.read (reads) capability + active workspace for writes.
// Provisioning, verified-domain enforcement, seat limits and audit all run inside the
// existing scim.ts core — nothing is reinvented here.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { resolveRole } from "../../shared/rbac.ts";
import { getOrganization } from "../../shared/sso.ts";
import { ScimError } from "../../shared/scim.ts";
import { handleScim, scimErrorResponse } from "../../shared/scimRest.ts";
import { assertScimEntitlement } from "../../shared/planLimits.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return scimErrorResponse(401, "Authentication required", "SCIM_UNAUTHORIZED");

    const svc = base44.asServiceRole;
    const url = new URL(req.url);
    const raw = await req.text().catch(() => "");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

    const workspaceId = String(body.workspace_id || url.searchParams.get("workspace_id") || "");
    if (!workspaceId) return scimErrorResponse(400, "workspace_id is required (query or body)", "SCIM_NO_WORKSPACE");

    const method = String(body.method || req.method || "GET").toUpperCase();
    const path = String(body.path || url.searchParams.get("path") || "/scim/v2/ServiceProviderConfig");

    const workspace = await svc.entities.Workspace.get(workspaceId).catch(() => null);
    if (!workspace) return scimErrorResponse(404, "Workspace not found", "SCIM_NO_WORKSPACE");

    const role = await resolveRole(base44, workspace, user);
    if (!role) return scimErrorResponse(403, "Forbidden: not a workspace member", "NOT_A_MEMBER");

    // SCIM provisioning is a workspace Enterprise entitlement: every SCIM request requires a plan
    // whose entitlements.scim is true. Resolved server-side; the existing role/capability checks
    // inside handleScim still run unchanged.
    await assertScimEntitlement(base44, workspace);

    return await handleScim({ svc, user, workspace, role, method, path, body, workspaceId });
  } catch (error) {
    if (error instanceof ScimError) return scimErrorResponse(error.status || 400, error.message, error.code || null);
    return scimErrorResponse(error.status || 500, error.message || "SCIM error", error.code || null);
  }
}