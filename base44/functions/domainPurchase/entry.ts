// GoDaddy domain purchase: a thin authorization wrapper over the certified surface module
// (shared/godaddyApi.ts), which owns ALL registrar complexity and never leaks it.
//
// Authorization is the existing project path — reads (search, quote) need project.read,
// everything that starts or advances a purchase needs domain.manage (owner/admin), and the
// workspace lifecycle gate applies. The GoDaddy credential lives ONLY in backend secrets
// (GODADDY_PAT): it is read here, handed to the shared surface, and never returned, logged
// or persisted. Billing stays registrar-side (the account's payment method) — no NexusAI
// credits and no per-call payment data are involved.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { secrets } from "base44:runtime";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { domainPurchaseSurface, GODADDY_READ_ACTIONS } from "../../shared/godaddyApi.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, body.project_id,
      GODADDY_READ_ACTIONS.includes(action) ? "project.read" : "domain.manage",
    );
    let token = null;
    try { token = secrets.get("GODADDY_PAT") || null; } catch { token = null; }
    const result = await domainPurchaseSurface(base44.asServiceRole, {
      token, action,
      project_id: project.id, workspace_id: workspace.id, added_by: user.id,
      query: body.query, domain: body.domain, period: body.period,
      registration_id: body.registration_id, auto_renew: body.auto_renew,
    });
    await audit(base44.asServiceRole, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `domainPurchase.${action}`, resource: "GodaddyRegistration",
      resource_id: result?.registration?.registration_id || project.id,
      metadata: { domain: body.domain || null, available: result?.available ?? null },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error.message, code: error.code || null },
      { status: Number(error?.status) || 500 },
    );
  }
}