// Clone / Fork / Template endpoint (#33).
//
// Thin transport. Every authorization decision, the plan-limit claim, the secret-reference
// projection and the lineage stamp live in shared/projectClone.ts, so this file cannot widen
// what a caller is allowed to copy. The acting user comes from the session; the payload only
// names WHAT to copy and WHERE to put it, never who is asking.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { cloneProject, forkProject, createProjectFromTemplate } from "../../shared/projectClone.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Sign in to copy a project", code: "AUTH_REQUIRED" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "clone");

    let out;
    if (action === "clone") {
      out = await cloneProject(base44, user, {
        source_project_id: body.source_project_id,
        target_workspace_id: body.target_workspace_id || null,
        name: body.name || null,
        description: body.description ?? null,
      });
    } else if (action === "fork") {
      out = await forkProject(base44, user, {
        source_project_id: body.source_project_id,
        version_number: body.version_number || null,
        target_workspace_id: body.target_workspace_id || null,
        name: body.name || null,
        description: body.description ?? null,
      });
    } else if (action === "template") {
      out = await createProjectFromTemplate(base44, user, {
        listing_id: body.listing_id || null,
        listing_slug: body.listing_slug || null,
        version_id: body.version_id || null,
        target_workspace_id: body.target_workspace_id,
        name: body.name || null,
        description: body.description ?? null,
        consented_capabilities: Array.isArray(body.consented_capabilities) ? body.consented_capabilities : [],
      });
    } else {
      return Response.json({ error: `Unknown action "${action}"`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }

    return Response.json({
      project: out.project,
      version_number: out.version.number,
      files_created: out.files_created,
      entities_created: out.entities_created,
      // NAMES of the credentials the new project must have configured before it can run. A copy
      // never inherits a secret value, so this list is what the user still has to fill in.
      secrets_declared: out.secrets_declared,
      install_id: out.install?.id || null,
      credits_charged: out.charged || 0,
    });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null, detail: error.detail || null }, { status: error.status || 500 });
  }
}