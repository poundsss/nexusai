// Minimal import probe: ONLY shared/agentSchedules.ts — verifies the module graph loads
// after the agentLoop/agentSchedules import cycle was removed (leaf agentConstants.ts).
import { processDueAgentSchedules, createAgentSchedule } from "../../shared/agentSchedules.ts";

export default async function (req) {
  return Response.json({ ok: true, sweep: typeof processDueAgentSchedules === "function", create: typeof createAgentSchedule === "function" });
}
