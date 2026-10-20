// P-Grow — the My Business (Google Business Profile) surface, FAIL-CLOSED at the provider.
//
// The confirmed product behavior (Runable): when a member's site is built or claimed, a Google
// Business Profile ("My Business") LISTING can be claimed and set up if requested or not
// already claimed. Claiming and setting up a listing requires the Google Business Profile API —
// and this runtime has NO Google Business Profile integration: the platform's connector catalog
// publishes no Google Business Profile connector, and Base44 documents no Business Profile
// API contract. Every lifecycle action therefore refuses with the EXACT documented blocker
// instead of fabricating a provider — no fake claim, no invented listing state, no invented
// verification. The same fail-closed contract pattern as the certified Phone/iMessage channels.
//
// Actions: status | claim | setup. `status` answers with the blocker as data (the UI's single
// source of truth); claim/setup are 501 refusals — the lifecycle shell that exists precisely so
// the blocker is machine-checkable.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { loadAuthorizedProject, audit } from "../../shared/authz.ts";
import { companySurface } from "../../shared/companyListening.ts";

export const GBP_INTEGRATION_UNAVAILABLE_CODE = "GBP_INTEGRATION_UNAVAILABLE";

export const GBP_INTEGRATION_BLOCKER =
  "Google Business Profile (My Business) claim and setup are unavailable in this runtime: " +
  "the platform's connector catalog publishes no Google Business Profile connector and Base44 " +
  "documents no Business Profile API contract, so claiming or setting up a listing refuses " +
  "closed instead of fabricating a provider. The project's website, ads and support surfaces " +
  "are unaffected.";

export const config = { public: true };

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");
    if (action === "status") {
      if (body.project_id) await loadAuthorizedProject(base44, user, body.project_id, "project.read");
      return Response.json({ surface: "my_business", provider: "google_business_profile", available: false, blocker: GBP_INTEGRATION_BLOCKER, code: GBP_INTEGRATION_UNAVAILABLE_CODE, company_surface: "Your Company is separate public-mention monitoring; use company_get/configure/run/schedule/remove." });
    }
    if (action.startsWith("company_")) {
      const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, action === "company_get" ? "project.read" : "project.write");
      const result = await companySurface(base44.asServiceRole, project, workspace, body);
      await audit(base44.asServiceRole, { project_id: project.id, workspace_id: workspace.id, user_id: user.id, action: `myBusiness.${action}`, resource: "ListenTerm", resource_id: project.id });
      return Response.json(result);
    }
    if (action !== "claim" && action !== "setup") {
      return Response.json({ error: `Unsupported action — use "status", "claim" or "setup"`, code: "INVALID_ACTION" }, { status: 400 });
    }
    const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.write");
    await audit(base44.asServiceRole, { project_id: project.id, workspace_id: workspace.id, user_id: user.id, action: `myBusiness.${action}.blocked`, resource: "AdsAccount", resource_id: project.id, metadata: { code: GBP_INTEGRATION_UNAVAILABLE_CODE } });
    return Response.json({ error: GBP_INTEGRATION_BLOCKER, code: GBP_INTEGRATION_UNAVAILABLE_CODE }, { status: 501 });
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}