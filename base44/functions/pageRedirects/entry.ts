// Path-level page redirect control plane: create, list, update and delete 301 redirect rules
// for an app's published site. Mirrors the documented Base44 URL-redirect contract.
//
// Authorization reuses the existing project/domain envelope: listing needs project.read; every
// write needs domain.manage AND the custom-domains plan entitlement. No new role matrix is
// introduced. A redirect id from another project is indistinguishable from one that never existed.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { assertCustomDomainsEntitlement } from "../../shared/planLimits.ts";
import { validateRule, view, MAX_REDIRECTS_PER_APP } from "../../shared/pageRedirects.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json();
    const isList = String(body.action || "list") === "list";
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, isList ? "project.read" : "domain.manage");
    const svc = base44.asServiceRole;
    const action = String(body.action || "list");

    const mine = async () => await svc.entities.PageRedirect.filter({ project_id: project.id }, "created_date", MAX_REDIRECTS_PER_APP);
    // A redirect id from another project must be indistinguishable from one that never existed.
    const load = async () => {
      const r = await svc.entities.PageRedirect.get(body.redirect_id).catch(() => null);
      if (!r || r.project_id !== project.id) throw Object.assign(new Error("Redirect not found"), { status: 404 });
      return r;
    };

    if (action === "list") return Response.json({ redirects: (await mine()).map(view) });

    // Every write below requires the custom-domains plan entitlement (listing does not).
    await assertCustomDomainsEntitlement(base44, workspace);

    if (action === "create") {
      const rule = validateRule(body);
      if ((await mine()).length >= MAX_REDIRECTS_PER_APP) {
        return Response.json({ error: `An app can have at most ${MAX_REDIRECTS_PER_APP} redirects`, code: "REDIRECT_LIMIT" }, { status: 400 });
      }
      const created = await svc.entities.PageRedirect.create({ project_id: project.id, workspace_id: workspace.id, ...rule });
      await audit(base44, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "redirect.created", resource: "PageRedirect", resource_id: created.id, metadata: { source_path: rule.source_path, target_path: rule.target_path, match_type: rule.match_type } });
      return Response.json({ redirect: view(created) }, { status: 201 });
    }

    if (action === "update") {
      const existing = await load();
      const rule = validateRule(body);
      const saved = await svc.entities.PageRedirect.update(existing.id, { source_path: rule.source_path, target_path: rule.target_path, match_type: rule.match_type });
      await audit(base44, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "redirect.updated", resource: "PageRedirect", resource_id: saved.id, metadata: { source_path: rule.source_path, target_path: rule.target_path, match_type: rule.match_type } });
      return Response.json({ redirect: view(saved) });
    }

    if (action === "delete") {
      const existing = await load();
      await svc.entities.PageRedirect.delete(existing.id);
      await audit(base44, { workspace_id: workspace.id, project_id: project.id, user_id: user.id, action: "redirect.deleted", resource: "PageRedirect", resource_id: existing.id, metadata: { source_path: existing.source_path } });
      return Response.json({ deleted: true, redirect_id: existing.id });
    }

    return Response.json({ error: `Unsupported action ${action}` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}