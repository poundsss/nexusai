// Background executor: runs ONE phase of a persisted AI run and reports whether more remains.
// Invoked repeatedly by the "AI Run Executor" workflow, so the run's total lifetime is not
// bounded by any single HTTP request. Authorization already happened when the run was enqueued;
// this worker has no user session and acts with the service role against persisted ids only.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { executeRunPhase } from "../../shared/runPipeline.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

export default async function (req) {
  // G-3: the worker boundary is authenticated before anything is touched. The
  // executor workflow's own invocations pass via the platform marker; every
  // other caller must present WORKER_SECRET (fail closed when unconfigured).
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  try {
    const { run_id } = await req.json();
    if (!run_id) return Response.json({ error: "run_id is required" }, { status: 400 });
    // The worker identity is what the run's phase lease is held by, so two overlapping ticks
    // cannot execute the same phase: the loser observes the live lease and returns without work.
    const result = await executeRunPhase(svc, run_id, { worker_id: `aiRunStep_${crypto.randomUUID().slice(0, 8)}` });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error.message, done: true }, { status: 500 });
  }
}