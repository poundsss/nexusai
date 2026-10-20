// Mobile build control plane (P-10.3): request a native package of an already-deployed app,
// download a finished package, and manage the workspace's mobile signing credentials.
//
// Creating a build persists it as QUEUED and returns immediately — the "Mobile Build Executor"
// workflow drives BUILDING → SIGNING → READY in the background. The build is pinned to the
// deployment's immutable artifact and never reads the project's mutable working files.
//
// Signing credentials follow the existing WorkspaceSecret pattern: encrypted at rest,
// backend-only access, never exposed to a client, every change audited. Management is
// workspace-level and requires the secret.manage capability (owner/admin).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { requestMobileBuild, createMobileArtifactDownloadUrl } from "../../shared/mobileBuilds.ts";
import { resolveRole, requireCapability, requireActiveWorkspace } from "../../shared/rbac.ts";
import { putSigningCredential, removeSigningCredential, describeSigningCredentials } from "../../shared/mobileSigning.ts";
import { createMobileRelease, readyMobileRelease, releaseMobileRelease, rollbackMobileRelease, listMobileReleases } from "../../shared/mobileReleases.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "create");
    const svc = base44.asServiceRole;

    if (action === "create") {
      try {
        const r = await requestMobileBuild(base44, user, {
          project_id: body.project_id,
          deployment_id: body.deployment_id,
          platform: body.platform,
        });
        return Response.json({
          build_id: r.build.id, status: "QUEUED", platform: r.build.platform,
          artifact_id: r.build.artifact_id, checksum: r.build.checksum,
          version_number: r.build.version_number ?? null,
          deployment_id: r.build.deployment_id,
        }, { status: 202 });
      } catch (e) {
        return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.build_id ? { build_id: e.build_id } : {}) }, { status: e.status || 500 });
      }
    }

    if (action === "download_url") {
      try {
        const out = await createMobileArtifactDownloadUrl(base44, user, { build_id: body.build_id, expires_in: body.expires_in });
        return Response.json(out);
      } catch (e) {
        return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
      }
    }

    // ---- signing credential management (workspace-level, secret.manage: owner/admin) ----
    if (["put_signing_credential", "delete_signing_credential", "list_signing_credentials"].includes(action)) {
      const workspaceId = String(body.workspace_id || "");
      const workspace = workspaceId ? await svc.entities.Workspace.get(workspaceId).catch(() => null) : null;
      if (!workspace) return Response.json({ error: "Workspace not found" }, { status: 404 });
      const role = await resolveRole(base44, workspace, user);
      if (!role) return Response.json({ error: "Forbidden", code: "NOT_A_MEMBER" }, { status: 403 });
      requireCapability(role, "secret.manage");
      requireActiveWorkspace(workspace, "secret.manage");

      if (action === "put_signing_credential") {
        const out = await putSigningCredential(base44, {
          workspace_id: workspaceId, platform: String(body.platform || ""),
          value: body.value, user_id: user.id, description: body.description || "",
        });
        return Response.json(out);
      }
      if (action === "delete_signing_credential") {
        const out = await removeSigningCredential(base44, { workspace_id: workspaceId, platform: String(body.platform || ""), user_id: user.id });
        return Response.json(out);
      }
      const credentials = await describeSigningCredentials(base44, workspaceId);
      return Response.json({ credentials });
    }

    // ---- mobile release lifecycle (project-scoped, deploy.manage: owner/admin) ----
    if (["create_release", "ready_release", "publish_release", "rollback_release", "list_releases"].includes(action)) {
      try {
        const out = action === "create_release"
          ? await createMobileRelease(base44, user, {
              build_id: body.build_id, version_name: body.version_name, version_code: body.version_code,
              release_notes: body.release_notes, minimum_os_version: body.minimum_os_version,
            })
          : action === "ready_release" ? await readyMobileRelease(base44, user, { release_id: body.release_id })
          : action === "publish_release" ? await releaseMobileRelease(base44, user, { release_id: body.release_id })
          : action === "rollback_release" ? await rollbackMobileRelease(base44, user, { release_id: body.release_id })
          : await listMobileReleases(base44, user, { project_id: body.project_id, platform: body.platform });
        return Response.json(out);
      } catch (e) {
        return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status || 500 });
      }
    }

    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.capability ? { capability: error.capability } : {}) }, { status: error.status || 500 });
  }
}