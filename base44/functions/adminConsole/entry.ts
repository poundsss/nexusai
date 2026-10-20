// Platform admin console endpoint — read-only operational visibility.
//
// The gate is platform-level and server-resolved (`requirePlatformAdmin`); a workspace owner or
// admin who is not a platform admin is refused, and nothing in the body influences the decision.
// Every access is recorded through the existing AuditLog + TraceEvent systems.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { audit } from "../../shared/authz.ts";
import { requirePlatformAdmin, platformOverview } from "../../shared/platformAdmin.ts";
import { newTraceId, recordSpan } from "../../shared/tracing.ts";
import { diagnosticTrail } from "../../shared/tracing.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const admin = await requirePlatformAdmin(base44, user);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "overview");
    const trace_id = body.trace_id ? String(body.trace_id) : newTraceId();
    const started = Date.now();

    let payload;
    if (action === "overview") {
      payload = await platformOverview(base44, { limit: body.limit ?? 20 });
    } else if (action === "trail") {
      // Reuses the existing project-scoped diagnostic trail; the project scope stays mandatory,
      // so even an admin read is a scoped query rather than a global dump.
      payload = { trail: await diagnosticTrail(base44, { trace_id: String(body.target_trace_id || ""), project_id: String(body.project_id || "") }) };
    } else {
      return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }

    await recordSpan(base44, {
      trace_id, event_type: "diagnostic_query", name: `admin.${action}`, status: "ok",
      duration_ms: Date.now() - started, metadata: { admin_user_id: admin.user_id },
    });
    // Admin access is audited on the platform scope, through the existing audit system.
    await audit(base44.asServiceRole, {
      workspace_id: "platform", project_id: body.project_id || null, user_id: admin.user_id,
      action: `admin.console.${action}`, resource: "PlatformAdmin", resource_id: admin.user_id,
      metadata: { trace_id, action },
    });

    return Response.json({ ...payload, admin: { role: admin.role, user_id: admin.user_id }, trace_id });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}