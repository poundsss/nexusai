// Version diff endpoint: read-only comparison of two immutable versions of one project.
//
// Authorization reuses the existing project authorization path (`project.read`), so a caller who
// may not read the project cannot diff it, and the diff service itself enforces that both versions
// belong to that project. The access is recorded through the existing audit + tracing systems —
// no new logging surface.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { diffVersions } from "../../shared/versionDiff.ts";
import { newTraceId, recordSpan } from "../../shared/tracing.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");

    // A diff is one diagnostic operation, so it gets one correlation id — either the caller's
    // existing trace (a Builder run being inspected) or a fresh one.
    const trace_id = body.trace_id ? String(body.trace_id) : newTraceId();
    const started = Date.now();
    const diff = await diffVersions(base44, {
      project,
      from_version_id: body.from_version_id,
      to_version_id: body.to_version_id,
      offset: body.offset ?? 0,
      limit: body.limit ?? undefined,
      paths: body.paths || [],
    });

    await recordSpan(base44, {
      trace_id, workspace_id: workspace.id, project_id: project.id, event_type: "diagnostic_query",
      name: "version.diff", status: "ok", duration_ms: Date.now() - started,
      metadata: { from: diff.from.number, to: diff.to.number, changed: diff.files.total_changed, entities_changed: diff.entities.modified.length + diff.entities.added.length + diff.entities.removed.length },
    });
    // AuditLog is system-written only, so the entry goes through the service role.
    await audit(base44.asServiceRole, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: "version.diff", resource: "ProjectVersion", resource_id: diff.to.id,
      metadata: { trace_id, from_version_id: diff.from.id, from: diff.from.number, to: diff.to.number, changed_files: diff.files.total_changed },
    });

    return Response.json({ ...diff, trace_id });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}