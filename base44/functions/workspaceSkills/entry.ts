// Workspace Skills control plane (Phase 16A).
//
// DOCUMENTED (Base44): workspace skills are managed in Workspace Settings → Plugins → Skills,
// a workspace holds at most 100, and adding one requires a Builder plan or higher. Management
// follows the workspace-settings tier of the existing RBAC (secret.manage — owner/admin, the
// same surface that manages PATs), is workspace-lifecycle-gated for mutations, and every
// mutation is audited. Listing is available to every member who can read the workspace's
// projects. All reads and writes are workspace-scoped — a record from another workspace is
// simply not found here.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { resolveRole, requireCapability, requireActiveWorkspace } from "../../shared/rbac.ts";
import { effectivePlan } from "../../shared/planLimits.ts";
import {
  planAllowsWorkspaceSkills, workspaceSkillView,
  listWorkspaceSkills, createWorkspaceSkill, updateWorkspaceSkill, deleteWorkspaceSkill,
} from "../../shared/skills.ts";
import { WORKSPACE_SKILL_PRESETS, refineWorkspaceSkill } from "../../shared/workspaceSkillPresets.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const svc = base44.asServiceRole;
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    const workspaceId = String(body.workspace_id || "");
    if (!workspaceId) return Response.json({ error: "workspace_id is required" }, { status: 400 });
    const workspace = await svc.entities.Workspace.get(workspaceId).catch(() => null);
    if (!workspace) return Response.json({ error: "Workspace not found" }, { status: 404 });
    const role = await resolveRole(base44, workspace, user);
    const isRead = action === "list" || action === "presets";
    requireCapability(role, isRead ? "project.read" : "secret.manage");
    if (!isRead) requireActiveWorkspace(workspace, "secret.manage");

    if (action === "list") {
      return Response.json({ skills: await listWorkspaceSkills(svc, { workspace_id: workspaceId }) });
    }
    if (action === "presets") {
      // Fixed platform-side catalog content (NEXUSAI-DERIVED — see the shared module header):
      // read-only, no database involved.
      return Response.json({ presets: WORKSPACE_SKILL_PRESETS });
    }
    if (action === "create") {
      // DOCUMENTED (Base44): adding a skill requires a Builder plan or higher. The gate applies
      // to ADDING only — the docs do not condition editing or toggling on the plan.
      const { plan } = await effectivePlan(base44, workspaceId);
      if (!planAllowsWorkspaceSkills(plan)) {
        return Response.json({ error: "Managing workspace skills requires a Builder plan or higher.", code: "PLAN_REQUIRED" }, { status: 403 });
      }
      const record = await createWorkspaceSkill(svc, {
        workspace_id: workspaceId, name: body.name, description: body.description,
        instructions: body.instructions, enabled: body.enabled, created_by: user.id,
      });
      return Response.json({ skill: workspaceSkillView(record) });
    }
    if (action === "refine") {
      // AI refinement PROPOSAL of description + instructions only. Returns a suggestion and
      // writes NOTHING to the database; persistence stays with the existing create/update
      // paths, and the skill's name is never part of the refinement output.
      const refined = await refineWorkspaceSkill(svc, { description: body.description, instructions: body.instructions });
      return Response.json({ refined });
    }
    if (action === "update") {
      const patch = body.patch && typeof body.patch === "object" ? body.patch : body;
      const record = await updateWorkspaceSkill(svc, { workspace_id: workspaceId, skill_id: body.skill_id, patch, updated_by: user.id });
      return Response.json({ skill: workspaceSkillView(record) });
    }
    if (action === "delete") {
      return Response.json(await deleteWorkspaceSkill(svc, { workspace_id: workspaceId, skill_id: body.skill_id, deleted_by: user.id }));
    }
    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}