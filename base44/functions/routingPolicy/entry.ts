// Routing policy + self-improving router API (#41).
//
//   contract  — the scoring contract, dimensions, default weights and rejection vocabulary.
//   evidence  — what persisted #38/#39 evidence the router can currently see for a scope.
//   propose   — create a new IMMUTABLE policy version from that evidence (never from telemetry).
//   activate  — make one version ACTIVE; the previous one is superseded, not edited.
//   rollback  — re-activate the previous (or a named earlier) immutable version.
//   list      — the version lineage of a scope, with its active version.
//   preview   — run the deterministic selection for a hypothetical request without persisting.
//   decisions — the persisted explainability trail for a project.
//
// Authorization is never taken from the client: platform scope requires a platform admin, project
// scope goes through the platform's existing project authorization path.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { proposePolicyFromEvidence, activatePolicy, rollbackPolicy, listPolicies, routingPolicyContract, resolveEffectivePolicy, publicPolicy } from "../../shared/routingPolicy.ts";
import { gatherRoutingEvidence } from "../../shared/routingEvidence.ts";
import { selectModel, routerContract } from "../../shared/selfImprovingRouter.ts";
import { loadAuthorizedProject } from "../../shared/authz.ts";
import { requirePlatformAdmin } from "../../shared/platformAdmin.ts";
import { skillContract, selectSkills } from "../../shared/skills.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action || "contract";
    // Skills read surface: the validated, checksummed catalog contract, alongside the routing one.
    if (action === "contract") return Response.json({ policy: routingPolicyContract(), router: routerContract(), skills: skillContract() });
    if (action === "skills") return Response.json(skillContract());

    const user = await base44.auth.me();
    const svc = base44.asServiceRole;

    switch (action) {
      case "evidence": {
        if (body.scope === "project") {
          const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");
          return Response.json(await gatherRoutingEvidence(svc, { scope: "project", project_id: project.id, workspace_id: workspace.id }));
        }
        await requirePlatformAdmin(base44, user);
        return Response.json(await gatherRoutingEvidence(svc, { scope: "platform" }));
      }
      case "propose": return Response.json(await proposePolicyFromEvidence(base44, user, body));
      case "activate": return Response.json(await activatePolicy(base44, user, body));
      case "rollback": return Response.json(await rollbackPolicy(base44, user, body));
      case "list": return Response.json(await listPolicies(base44, user, body));
      case "effective": {
        const { project } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");
        const resolved = await resolveEffectivePolicy(svc, { project_id: project.id });
        return Response.json({ resolved_from: resolved.resolved_from, policy: publicPolicy(resolved.policy) });
      }
      case "preview": {
        const { project, workspace } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");
        // Skills participate in a preview exactly as in a run: selected deterministically, then
        // handed to the router as its (model + skill strategy) pair.
        const skill_strategy = selectSkills({ mode: body.inputs?.mode === "discuss" ? "discuss" : "default", prompt: body.inputs?.prompt || "", paths: body.paths || [], signals: body.signals || {} });
        const res = await selectModel(base44, { ...body, project_id: project.id, workspace_id: workspace.id, persist: false, skill_strategy });
        return Response.json({ selected_model_id: res.decision.selected_model_id, decision: res.decision, skill_strategy: res.decision.skill_strategy, fallbacks: res.fallbacks });
      }
      case "decisions": {
        const { project } = await loadAuthorizedProject(base44, user, body.project_id, "project.read");
        const rows = await svc.entities.RoutingDecision.filter({ project_id: project.id }, "-created_date", Math.min(body.limit || 20, 100));
        return Response.json({ project_id: project.id, count: rows.length, decisions: rows });
      }
      default: return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null, detail: e.detail || null }, { status: e.status || 500 });
  }
}