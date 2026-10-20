// Base44 Security Scan — the member-authorized HTTP surface over the audited engine
// (shared/securityScan.ts), mirroring the DOCUMENTED API beta:
//   • POST ("run")  → cached result or a background scan; the X-Scan-Source header
//     distinguishes the two cases; language is validated with a 422;
//   • GET ("get")   → the read-only status/result surface; NEVER starts a scan;
//   • "ignore"/"restore" → the documented ignored_fingerprints lifecycle.
// Every action funnels through loadAuthorizedProject (project authorization + the G-2
// workspace lifecycle gate): reads with project.read, run/ignore/restore with project.write.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { securityScanSurface } from "../../shared/securityScan.ts";

export const config = { public: true };

const WRITE_ACTIONS = new Set(["run", "ignore", "restore"]);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json().catch(() => ({}));
    const action = String(body.action || "get");
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, body.project_id,
      WRITE_ACTIONS.has(action) ? "project.write" : "project.read",
    );
    const svc = base44.asServiceRole;
    const { body: result, scan_source } = await securityScanSurface(svc, project, workspace, { id: user.id }, { ...body, action });
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `security_scan.${action}`, resource: "SecurityScan",
      resource_id: project.id,
      metadata: { action, ...(action === "run" ? { language: String(body.language || "en") } : {}), ...(body.fingerprint ? { fingerprint: String(body.fingerprint) } : {}) },
    });
    const headers = scan_source ? { "X-Scan-Source": scan_source } : undefined;
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}