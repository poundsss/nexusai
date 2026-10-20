// Platform Badge visibility — the documented Base44 project-level "Made with Base44" attribution
// toggle. get returns the effective state; set writes badge_hidden (server-side only, through the
// existing project.write capability gate) and enforces the Starter+ entitlement server-side before
// persisting. Removing the badge on a free plan is refused with 402; the published runtime
// re-checks the entitlement at render time so a downgraded plan re-shows the badge.
//
// No new billing contract, no client trust, no schema beyond the single additive `badge_hidden`
// Project field. Existing projects keep the default (false → badge shown) and their published
// apps are unchanged.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { badgeRemovalEntitled } from "../../shared/planLimits.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "get");
    // Reading is a project read; setting is a project write — same choke point as the other surfaces.
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, String(body.project_id || ""), action === "get" ? "project.read" : "project.write",
    );
    const svc = base44.asServiceRole;

    if (action === "get") {
      // The entitlement is resolved server-side so the UI can show the gate without trusting a client.
      const entitled = await badgeRemovalEntitled(svc, workspace);
      // A private app's badge is always hidden; surface that effective state to the UI too.
      const effective_hidden = (project.visibility === "private") || (!!project.badge_hidden && entitled);
      return Response.json({
        badge_hidden: !!project.badge_hidden,
        entitled,
        visibility: project.visibility || "public",
        effective_hidden,
      });
    }

    if (action === "set") {
      const hide = !!body.badge_hidden;
      // Turning the badge ON is always allowed (the free-plan default). Only hiding it is gated.
      if (hide) {
        const entitled = await badgeRemovalEntitled(svc, workspace);
        if (!entitled) {
          return Response.json(
            { error: "Hiding the platform badge requires a Starter or higher plan.", code: "PLAN_BADGE_REMOVAL_NOT_INCLUDED" },
            { status: 402 },
          );
        }
      }
      await svc.entities.Project.update(project.id, { badge_hidden: hide });
      await audit(svc, {
        workspace_id: workspace.id, project_id: project.id, user_id: user.id,
        action: hide ? "project_badge.hidden" : "project_badge.shown", resource: "Project", resource_id: project.id,
      });
      const entitled = hide ? true : await badgeRemovalEntitled(svc, workspace);
      const effective_hidden = (project.visibility === "private") || (hide && entitled);
      return Response.json({ badge_hidden: hide, entitled, visibility: project.visibility || "public", effective_hidden });
    }

    return Response.json({ error: `Unknown action '${action}'` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}