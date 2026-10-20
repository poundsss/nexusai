// SEO & GEO — the member-authorized HTTP surface over the deterministic local scan engine
// (shared/seoScan.ts). A THIN action dispatch exactly like the agentSchedules endpoint:
// every action funnels through loadAuthorizedProject (project authorization + the G-2
// workspace lifecycle gate), the run audits through the existing audit primitive, and the
// engine itself is pure and free — NO credit reservation or charge exists on this path.
//
// `run` requires a PUBLISHED project (a production deployment + version); a scan is always
// bound to the production version it inspected, and repeat scans create SEPARATE version-bound
// rows (append-only history, no upsert).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { executeSeoScan } from "../../shared/seoScan.ts";

export const config = { public: true };

// Safe projection: everything the UI would show, nothing internal.
const publicScan = (s) => ({
  scan_id: s.id, project_id: s.project_id, workspace_id: s.workspace_id,
  version_number: s.version_number, production_deployment_id: s.production_deployment_id || null,
  status: s.status, score: s.score, grade: s.grade, categories: s.categories || [],
  critical_capped: !!s.critical_capped, scanned_files: s.scanned_files || 0,
  duration_ms: s.duration_ms || 0, error: s.error || null, completed_at: s.completed_at || null,
  created_at: s.created_date || null,
});

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const url = new URL(req.url);
  try {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET" ? Object.fromEntries(url.searchParams) : await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const svc = base44.asServiceRole || base44;

    if (action === "list") {
      const { project } = await loadAuthorizedProject(svc, user, body.project_id, "project.read");
      const limit = Math.min(Number(body.limit) || 20, 100);
      const rows = await svc.entities.SeoScan.filter({ project_id: project.id }, "-created_date", limit);
      return Response.json({ project_id: project.id, count: rows.length, scans: rows.map(publicScan) });
    }

    if (action === "get") {
      const { project } = await loadAuthorizedProject(svc, user, body.project_id, "project.read");
      if (!body.scan_id) return Response.json({ error: "scan_id is required", code: "SCAN_ID_REQUIRED" }, { status: 400 });
      const row = await svc.entities.SeoScan.get(body.scan_id).catch(() => null);
      // Project isolation: a scan from another project resolves to not-found for this caller.
      if (!row || row.project_id !== project.id) return Response.json({ error: "Scan not found", code: "SCAN_NOT_FOUND" }, { status: 404 });
      return Response.json({ scan: publicScan(row) });
    }

    if (action === "run") {
      const { project, workspace } = await loadAuthorizedProject(svc, user, body.project_id, "project.read");
      // PUBLISHED requirement + engine + append-only row + audit all live in ONE shared path
      // (executeSeoScan), so the certification test exercises the exact certified route.
      const { row } = await executeSeoScan(svc, project, workspace, user);
      return Response.json({ scan: publicScan(row) });
    }

    return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
  } catch (e) {
    const status = e.status || 500;
    return Response.json({ error: String(e.message || e), code: e.code || "SEO_SCAN_ERROR" }, { status });
  }
}