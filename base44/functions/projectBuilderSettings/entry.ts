// Builder settings — the documented Base44 project-scoped Builder controls exposed under the
// AI chat's "More options" menu: Auto approve and Custom Instructions.
//
//   get  — project.read  → { auto_approve, custom_instructions, design_system_id }
//   set  — project.write → persists one or more fields, returns the full effective state
//
// Authorization, audit and persistence all reuse the EXISTING project-settings path
// (loadAuthorizedProject + Project.update + audit), exactly like projectBadge. No new capability,
// no new plan gate, no client trust: the caller's role and the project are resolved server-side.
// custom_instructions is stored in full; only the first 10,000 characters are injected into the
// Build prompt (see prompts.customInstructionsBlock). A high storage guard (100k chars) protects
// the record from oversized fields; it is NOT the injection truncation.
//
// design_system_id (Phase 1): the Bolt-style design-system selection. Validated SERVER-side
// against the static registry (designSystemPresets.isSupportedDesignSystemId) — a client cannot
// store an arbitrary or unsupported id. Null clears the selection.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { isSupportedDesignSystemId } from "../../shared/designSystemPresets.ts";
import { importedDesignRow } from "../../shared/designSystemImport.ts";

// design_system_id now accepts: a static registry preset id, OR the id of a DesignSystem row
// that is an IMPORTED system owned by the SAME project (server-side ownership check — another
// project's imported row, or a non-imported row, is refused). Null clears the selection.
const importedNameFor = async (svc, project, id) => {
  if (!id || isSupportedDesignSystemId(id)) return null;
  const row = await svc.entities.DesignSystem.get(String(id)).catch(() => null);
  return row && row.project_id === project.id && row.imported ? (row.imported.source_name || null) : null;
};

const CI_STORAGE_MAX = 100000;

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "get");
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, String(body.project_id || ""), action === "get" ? "project.read" : "project.write",
    );
    const svc = base44.asServiceRole;

    if (action === "get") {
      return Response.json({
        auto_approve: !!project.auto_approve,
        custom_instructions: project.custom_instructions || "",
        design_system_id: project.design_system_id || null,
        design_system_name: await importedNameFor(svc, project, project.design_system_id),
      });
    }

    if (action === "set") {
      const patch = {};
      if (body.auto_approve !== undefined) patch.auto_approve = !!body.auto_approve;
      if (body.custom_instructions !== undefined) {
        const text = typeof body.custom_instructions === "string" ? body.custom_instructions : "";
        patch.custom_instructions = text.slice(0, CI_STORAGE_MAX);
      }
      if (body.design_system_id !== undefined) {
        const id = body.design_system_id == null ? null : String(body.design_system_id);
        if (id !== null && !isSupportedDesignSystemId(id)) {
          const imported = await importedDesignRow(svc, project.id, id);
          if (!imported) {
            return Response.json({ error: `Unsupported design system '${id}'`, code: "INVALID_DESIGN_SYSTEM" }, { status: 400 });
          }
        }
        patch.design_system_id = id;
      }
      if (Object.keys(patch).length === 0) {
        return Response.json({ error: "No settings to update", code: "EMPTY_SETTINGS" }, { status: 400 });
      }
      await svc.entities.Project.update(project.id, patch);
      const actionName = patch.design_system_id !== undefined
        ? `project_builder_settings.design_system_set`
        : patch.auto_approve !== undefined
        ? `project_builder_settings.auto_approve.${patch.auto_approve ? "on" : "off"}`
        : "project_builder_settings.custom_instructions_set";
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: actionName, resource: "Project", resource_id: project.id,
      });
      const fresh = await svc.entities.Project.get(project.id);
      return Response.json({
        auto_approve: !!fresh.auto_approve,
        custom_instructions: fresh.custom_instructions || "",
        design_system_id: fresh.design_system_id || null,
        design_system_name: await importedNameFor(svc, fresh, fresh.design_system_id),
      });
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}