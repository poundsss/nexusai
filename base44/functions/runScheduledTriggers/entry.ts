// Scheduler tick entry point. Invoked every minute by the "Scheduled Triggers"
// workflow. It performs the full due-trigger sweep and returns a summary.
// P-2: this tick executes generated apps' backend functions with the service role,
// so it sits behind the same G-3 worker boundary as the other background entries:
// the platform's workflow invocation passes via its x-workflow-run marker, and any
// other caller must present WORKER_SECRET. Fails closed when it is not configured.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { processDueTriggers } from "../../shared/scheduler.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

export default async function (req) {
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const svc = createClientFromRequest(req).asServiceRole;
  const result = await processDueTriggers(svc);
  // A Response, like every other worker entry point (deployStep, aiRunStep, ...) — the
  // workflow's internal invoke path throws on a plain-object return ("user worker threw an
  // exception") even though the sweep itself completed.
  return Response.json(result);
}