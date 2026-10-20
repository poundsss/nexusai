// Authorized surface for the evaluation / judge engine.
//
// Deliberately minimal: evaluate one SEALED episode, retrieve its evaluation, and read its
// evaluation history. Evaluations are derived server-side from authoritative execution records, so
// no client can submit a verdict, and nothing here writes to the trajectory, build, runtime or
// version records the judgement is read from.
//
// Every action authorizes the caller against the project through the platform's existing path
// (write to evaluate, read to retrieve) and is then filtered by that project id, so one workspace
// can never reach another's evaluations. Responses come from a field allowlist and expose no
// evaluator internals or secrets.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runEvaluation, getEvaluation, listEvaluationHistory, listProjectEvaluations, EVALUATOR_VERSION, evaluatorVersions } from "../../shared/evaluation.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action || "get";

    if (action === "evaluate") return Response.json(await runEvaluation(base44, user, body));
    if (action === "get") return Response.json(await getEvaluation(base44, user, body));
    if (action === "history") return Response.json(await listEvaluationHistory(base44, user, body));
    if (action === "list") return Response.json(await listProjectEvaluations(base44, user, body));
    if (action === "versions") return Response.json({ current: EVALUATOR_VERSION, versions: evaluatorVersions() });
    return Response.json({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}