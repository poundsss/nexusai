// Collaboration (#36): the authorized member-facing project edit surface.
//
// Two actions:
//   collaborators — who can reach this project, and what the CALLER may do (project.read)
//   commit        — a direct, conflict-safe file edit committed as a new version (project.write)
//
// Authorization, conflict handling and audit all live in shared/collaboration.ts, which composes
// the platform's existing rbac, project-authorization and journalled-commit machinery.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { applyVisualEdit } from "../../shared/visualEditSource.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { readCanonicalSnapshot } from "../../shared/commitJournal.ts";
import { projectCollaborators, commitMemberEdit, archiveProject, unpublishProject, republishProject, deleteProject, restoreProject, renameProject } from "../../shared/collaboration.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "collaborators");

    if (action === "collaborators") {
      return Response.json(await projectCollaborators(base44, user, String(body.project_id || "")));
    }

    if (action === "commit") {
      return Response.json(await commitMemberEdit(base44, user, {
        project_id: String(body.project_id || ""),
        edits: body.edits,
        message: body.message || "Edited by a collaborator",
        expected_version: body.expected_version ?? null,
        edit_id: body.edit_id || null,
      }));
    }

    if (action === "visual_edit") {
      // Visual Edit toolbar: resolve the picked element deterministically, then commit through
      // the SAME authorized, conflict-safe, build-checked, journalled path as a manual edit.
      const projectId = String(body.project_id || "");
      await loadAuthorizedProject(base44, user, projectId, "project.write");
      const snap = await readCanonicalSnapshot(base44, projectId);
      const edit = applyVisualEdit(snap.files, { element: body.element, changes: body.changes, page_file: body.page_file || null });
      const out = await commitMemberEdit(base44, user, {
        project_id: projectId, edits: [{ path: edit.path, content: edit.content }],
        message: `Visual edit in ${edit.path}`, expected_version: body.expected_version ?? null, edit_id: body.edit_id || null,
      });
      return Response.json({ ...out, path: edit.path });
    }

    if (action === "archive") {
      return Response.json(await archiveProject(base44, user, String(body.project_id || "")));
    }

    if (action === "unpublish") {
      return Response.json(await unpublishProject(base44, user, String(body.project_id || "")));
    }

    if (action === "republish") {
      return Response.json(await republishProject(base44, user, String(body.project_id || "")));
    }

    if (action === "delete") {
      return Response.json(await deleteProject(base44, user, String(body.project_id || "")));
    }

    if (action === "restore") {
      return Response.json(await restoreProject(base44, user, String(body.project_id || "")));
    }

    if (action === "rename") {
      return Response.json(await renameProject(base44, user, String(body.project_id || ""), body.name));
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null, details: error.details || null }, { status: error.status || 500 });
  }
}