// The member-authorized HTTP surface over the Google Ads foundation (shared/googleAds.ts).
// Mirrors the documented Base44 Google Ads contract: accounts, launch, campaigns, briefs,
// asset sessions and conversions — every LIVE operation behind the provider adapter, which
// fails closed (PROVIDER_NOT_CONFIGURED) until the external Google Ads infrastructure exists.
// Reads use project.read, every mutating action project.write, all through loadAuthorizedProject.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { googleAdsSurface, createDefaultGenerators } from "../../shared/googleAds.ts";

export const config = { public: true };

const READ_ACTIONS = new Set([
  "account_get", "launch_readiness", "budget_boundaries", "campaign_list", "campaign_get", "change_log_list",
  "brief_list", "brief_get", "asset_list", "conversion_mapping_list", "report_list", "account_options",
]);

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "AUTH_REQUIRED" }, { status: 401 });
    const body = req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : await req.json().catch(() => ({}));
    const action = String(body?.action || "account_get");
    if (action === "account_get") {
      // The existing account selector is project_id + channel, NOT a caller-supplied
      // account_id/provider reference. Reject invalid input before any lookup or adapter.
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw Object.assign(new Error("Request body must be an object"), { status: 400, code: "INVALID_INPUT" });
      }
      if (body.project_id == null || (typeof body.project_id === "string" && !body.project_id.trim())) {
        throw Object.assign(new Error("project_id is required"), { status: 400 });
      }
      if (typeof body.project_id !== "string") {
        throw Object.assign(new Error("project_id must be a non-empty string"), { status: 400, code: "INVALID_INPUT" });
      }
    }
    const { project, workspace } = await loadAuthorizedProject(
      base44, user, body.project_id,
      READ_ACTIONS.has(action) ? "project.read" : "project.write",
    );
    const svc = base44.asServiceRole;
    // Only brief_generate gets the documented default copy generator; every other action is unchanged.
    const opts = action === "brief_generate" ? { generators: { brief: createDefaultGenerators(base44).brief } } : {};
    const result = await googleAdsSurface(svc, project, workspace, { id: user.id }, { ...body, action }, opts);
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: `google_ads.${action}`, resource: "AdsAccount", resource_id: project.id,
      metadata: { action },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error.message, code: error.code || null, ...(error.blockers ? { blockers: error.blockers } : {}) },
      { status: error.status || 500 },
    );
  }
}