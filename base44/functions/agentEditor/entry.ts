// Member-authorized Agent create/edit HTTP surface over shared/agentEditor.ts. Two actions:
//   validate — compose + parse + reference-check, write nothing;
//   save     — the same composition committed through the EXISTING projectEdit journalled path.
// Authorization, conflicts, live-run policy immutability and the build gate all live in that
// existing path; this endpoint only refuses with the composition's structured errors.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { buildAgentDocument, saveAgentDocument, cloneAgentDocument, moveAgentDocument, deleteAgentDocument, restoreAgentDocument, listRecentlyDeletedAgents } from "../../shared/agentEditor.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "save");
    const project_id = String(body.project_id || "");

    if (action === "validate") {
      const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
      const { path, content, agent } = await buildAgentDocument(base44.asServiceRole || base44, project.id, body.agent || {}, body.original_name || null);
      return Response.json({ ok: true, path, content, agent_name: agent.name });
    }
    if (action === "save") {
      return Response.json(await saveAgentDocument(base44, user, {
        project_id,
        agent: body.agent || {},
        original_name: body.original_name || null,
        expected_version: body.expected_version ?? null,
        edit_id: body.edit_id || null,
      }));
    }
    // Owner lifecycle — the Base44-documented General-settings actions (Customizing your
    // Superagent): clone, move, delete, and the 30-day Recently-deleted restore. Each is a thin
    // composition over the SAME journalled commit path save uses; errors carry their own status.
    if (action === "clone") {
      return Response.json(await cloneAgentDocument(base44, user, {
        project_id, original_name: body.original_name || null,
        new_name: body.new_name || (body.agent && body.agent.name) || null,
        expected_version: body.expected_version ?? null, edit_id: body.edit_id || null,
      }));
    }
    if (action === "move") {
      return Response.json(await moveAgentDocument(base44, user, {
        project_id, agent_name: body.agent_name || (body.original_name || ""),
        target_project_id: body.target_project_id || "", edit_id: body.edit_id || null,
      }));
    }
    if (action === "delete") {
      return Response.json(await deleteAgentDocument(base44, user, {
        project_id, agent_name: body.agent_name || (body.original_name || ""),
        expected_version: body.expected_version ?? null, edit_id: body.edit_id || null,
      }));
    }
    if (action === "restore") {
      return Response.json(await restoreAgentDocument(base44, user, {
        project_id, agent_name: body.agent_name || (body.original_name || ""),
        expected_version: body.expected_version ?? null, edit_id: body.edit_id || null,
      }));
    }
    if (action === "list_deleted") {
      return Response.json(await listRecentlyDeletedAgents(base44, user, { project_id }));
    }
    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null, details: error.details || null }, { status: error.status || 500 });
  }
}