// Training / evaluation pipeline API (#39).
//
// Candidate evaluation over FINALIZED evaluation datasets: create a measurement, score it from
// authoritative records, compare candidates and check a candidate against a fixed reference for
// quality regressions. Authorization is never taken from the client — a project-scoped dataset is
// authorized through the platform's existing project path, a platform-scoped dataset requires a
// platform admin. Dataset construction itself stays in the existing dataset API.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createCandidateEvaluation, scoreCandidateEvaluation, finalizeCandidateEvaluation,
  getCandidateEvaluation, listCandidateEvaluations, compareCandidates, detectRegression,
  candidateEvaluationContract,
} from "../../shared/candidateEvaluation.ts";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const action = body.action || "get";
    if (action === "contract") return Response.json(candidateEvaluationContract());

    const user = await base44.auth.me();
    switch (action) {
      case "create_candidate": return Response.json(await createCandidateEvaluation(base44, user, body));
      case "score": return Response.json(await scoreCandidateEvaluation(base44, user, body));
      case "finalize": return Response.json(await finalizeCandidateEvaluation(base44, user, body));
      case "get": return Response.json(await getCandidateEvaluation(base44, user, body));
      case "list": return Response.json(await listCandidateEvaluations(base44, user, body));
      case "compare": return Response.json(await compareCandidates(base44, user, body));
      case "regression": return Response.json(await detectRegression(base44, user, body));
      default: return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}