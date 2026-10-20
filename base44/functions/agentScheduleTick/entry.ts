// Scheduled Superagent automations tick (Phase 16C-4). Invoked once per minute by the
// "Agent Schedule Tick" workflow (every five minutes — the platform's workflow cadence floor,
// identical to the certified Scheduled Triggers sweep); performs the due AgentSchedule sweep.
// It sits behind the SAME G-3 worker boundary as the other background entries (aiRunStep,
// deployStep, runScheduledTriggers, ...): the platform's workflow invocation passes via its
// x-workflow-run marker, and any other caller must present WORKER_SECRET. Fails closed when
// it is not configured.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { processDueAgentSchedules } from "../../shared/agentSchedules.ts";
import { requireWorkerAuth } from "../../shared/workerAuth.ts";

export default async function (req) {
  const unauthorized = requireWorkerAuth(req);
  if (unauthorized) return unauthorized;
  const svc = createClientFromRequest(req).asServiceRole;
  const result = await processDueAgentSchedules(svc);
  // A Response, like every other worker entry point.
  return Response.json(result);
}