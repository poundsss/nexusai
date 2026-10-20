// Per-change Revert (Builder/AI parity): thin HTTP wrapper that reverts the project to the
// state immediately before ONE completed AI change. It does NOT introduce a new rollback model
// or permission — it authorizes the EXISTING `version.restore` capability and delegates to the
// EXISTING `restoreProjectVersion` service, exactly the same primitive the Versions pane uses.
//
// The "state before this change" is the AI run's base version (AIRun.base_version_number — the
// project version the run started from). Restoring to that parent version is what rolls the app
// back to before the change AND undoes every later committed change, because version restore is
// append-only and replaces the current draft with the parent snapshot. Version history stays
// append-only: a new version is created by the restore, nothing is rewritten.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { restoreProjectVersion } from "../../shared/versionRestore.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "version.restore");

    const run = await base44.entities.AIRun.get(body.run_id).catch(() => null);
    if (!run || run.project_id !== project.id) {
      return Response.json({ error: "Run not found", code: "RUN_NOT_FOUND" }, { status: 404 });
    }
    // Only a committed, file-producing run can be reverted. Discuss runs make no changes;
    // incomplete/failed runs produced no version. Both must expose no Revert.
    if (run.status !== "COMPLETED") {
      return Response.json({ error: "Only completed runs can be reverted", code: "RUN_NOT_COMPLETED" }, { status: 409 });
    }
    if (run.mode === "discuss") {
      return Response.json({ error: "Discuss runs make no changes", code: "RUN_NOT_REVERTIBLE" }, { status: 409 });
    }
    if (!run.version_id || run.base_version_number == null) {
      return Response.json({ error: "Run has no committed version to revert", code: "RUN_NOT_COMMITTED" }, { status: 409 });
    }

    // The parent version is the exact state the run started from.
    const parent = (await base44.entities.ProjectVersion.filter(
      { project_id: project.id, number: run.base_version_number },
      "-number",
      1,
    ))[0];
    if (!parent) {
      return Response.json({ error: "Base version not found", code: "VERSION_NOT_FOUND" }, { status: 404 });
    }

    const out = await restoreProjectVersion(base44, {
      project, workspace, user,
      versionId: parent.id,
      // Optimistic concurrency against the current project version, same as the Versions restore.
      baseVersionNumber: project.version_count ?? null,
    });
    return Response.json(out);
  } catch (error) {
    return Response.json(
      { error: error.message, code: error.code, build_id: error.build_id, logs: error.logs, blocking: error.blocking },
      { status: error.status || 500 },
    );
  }
}