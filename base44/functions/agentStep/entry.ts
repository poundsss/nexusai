// Background agent worker: runs as many loop iterations as fit in one request window and
// reports whether more work remains. Invoked repeatedly by the "Agent Executor" workflow,
// so the agent's lifetime is not bounded by any HTTP request. Authorization happened when
// the run was created; this worker acts with the service role on persisted ids only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { runAgentIterations } from "../../shared/agentLoop.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

export default async function (req) {
  // G-3: the worker boundary is authenticated before anything is touched.
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  try {
    const { agent_run_id } = await req.json();
    if (!agent_run_id) return Response.json({ error: "agent_run_id is required" }, { status: 400 });
    return Response.json(await runAgentIterations(svc, agent_run_id));
  } catch (error) {
    return Response.json({ error: error.message, done: true }, { status: 500 });
  }
}