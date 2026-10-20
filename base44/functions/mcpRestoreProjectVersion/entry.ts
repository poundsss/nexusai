// MCP tool: restore_project_version (WRITE). Delegates entirely to the shared rollback
// service — history is preserved and a NEW version is created.
import { mcpTool, apiError } from "../../shared/platformApi.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { restoreProjectVersion } from "../../shared/versionRestore.ts";

export default async function (req) {
  return mcpTool(req, "restore_project_version", async ({ base44, user, body }) => {
    if (!body.version_id) throw apiError("INVALID_INPUT", "version_id is required");
    // Optimistic concurrency for an EXTERNAL caller: when the client states the version it last
    // saw, the shared restore service refuses with VERSION_CONFLICT (409) if the project has moved
    // on since — so a restore driven from a stale MCP view can never silently overwrite newer
    // work. Omitting expected_version preserves the previous behaviour exactly.
    let expected = null;
    if (body.expected_version !== undefined && body.expected_version !== null) {
      expected = Number(body.expected_version);
      if (!Number.isFinite(expected)) throw apiError("INVALID_INPUT", "expected_version must be a number");
    }
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "version.restore");
    const out = await restoreProjectVersion(base44, { project, workspace, user, versionId: String(body.version_id), baseVersionNumber: expected });
    return { project_id: project.id, expected_version: expected, new_version: out.version, new_version_id: out.version_id, restored_from_version: out.restored_from_version, changed_files: out.changed_files.map((c) => c.path) };
  });
}
