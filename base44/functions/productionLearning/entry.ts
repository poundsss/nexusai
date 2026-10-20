// Production Learning Flywheel (#43) — authenticated API surface.
//
// A thin routing boundary over shared/productionLearning.ts and NOTHING else: every action
// delegates to the module, which owns the loop, the promotion policy and the authorization. No
// learning logic, no second policy, no service-role escalation — the caller's own identity is
// passed through, so the module's existing project authorization decides what they may reach.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  productionLearningContract, runLearningCycle, captureOutcomes,
  listLearningCycles, getLearningCycle, getLearningLineage, rollbackLearningCycle,
} from "../../shared/productionLearning.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const action = body.action || "contract";

    // Public contract metadata: the promotion rules and the systems the loop runs through.
    if (action === "contract") return Response.json(productionLearningContract());

    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Sign in to use production learning", code: "AUTH_REQUIRED" }, { status: 401 });

    switch (action) {
      case "run":
        return Response.json(await runLearningCycle(base44, user, { project_id: body.project_id, candidate: body.candidate || null, trace_id: body.trace_id || null, dry_run: body.dry_run === true }));
      case "capture":
        return Response.json(await captureOutcomes(base44, user, { project_id: body.project_id }));
      case "list":
        return Response.json(await listLearningCycles(base44, user, { project_id: body.project_id, limit: body.limit }));
      case "get":
        return Response.json(await getLearningCycle(base44, user, { cycle_id: body.cycle_id }));
      case "lineage":
        return Response.json(await getLearningLineage(base44, user, { cycle_id: body.cycle_id }));
      case "rollback":
        return Response.json(await rollbackLearningCycle(base44, user, { cycle_id: body.cycle_id }));
      default:
        return Response.json({ error: `Unknown action: ${action}`, code: "UNKNOWN_ACTION" }, { status: 400 });
    }
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || "ERROR" }, { status: error.status || 500 });
  }
}