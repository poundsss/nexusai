// Project logo upload/get/remove — the documented Base44 "Dashboard → Overview → Edit logo"
// surface. The logo is stored as a PUBLIC file (world-readable, so the published app can serve
// it as a browser favicon and home-screen icon) and its URL is kept on the Project row as
// `logo_url`.
//
// Limits (PNG/JPEG, ≤5 MB, ≤1024×1024 px) are enforced server-side through the shared validator.
// Authorization reuses the existing project.read / project.write capability gate; storage reuses
// the existing Core.UploadPublicFile primitive. No new storage system, no schema beyond the
// single additive `logo_url` Project field. Existing projects with no logo keep null and the
// published runtime falls back to the platform default favicon.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { validateLogoBytes, decodeLogoBase64, logoExtension } from "../../shared/projectLogo.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "get");
    // Reading the logo is a project read; setting/removing it is a project write. Enforced at the
    // same choke point every other project surface uses.
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, String(body.project_id || ""), action === "get" ? "project.read" : "project.write",
    );
    const svc = base44.asServiceRole;

    if (action === "get") {
      return Response.json({ logo_url: project.logo_url || null });
    }

    if (action === "remove") {
      if (!project.logo_url) return Response.json({ logo_url: null });
      await svc.entities.Project.update(project.id, { logo_url: null });
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: "project_logo.removed", resource: "Project", resource_id: project.id,
      });
      return Response.json({ logo_url: null });
    }

    if (action === "set") {
      const bytes = decodeLogoBase64(body.content_base64);
      const meta = validateLogoBytes(bytes, { contentType: body.content_type });
      const filename = `logo-${project.id}.${logoExtension(meta.content_type)}`;
      const stored = await svc.integrations.Core.UploadPublicFile({
        file: new File([bytes], filename, { type: meta.content_type }),
      });
      if (!stored?.file_url) {
        return Response.json({ error: "Storage returned no file URL", code: "LOGO_UPLOAD_FAILED" }, { status: 502 });
      }
      await svc.entities.Project.update(project.id, { logo_url: stored.file_url });
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: "project_logo.set", resource: "Project", resource_id: project.id,
        metadata: { content_type: meta.content_type, width: meta.width, height: meta.height, size: meta.size },
      });
      return Response.json({ logo_url: stored.file_url, width: meta.width, height: meta.height, size: meta.size });
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}