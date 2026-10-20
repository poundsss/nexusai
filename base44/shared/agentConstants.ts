// Leaf constant shared by the agent loop and the schedule sweep. Lives apart from agentLoop so
// agentSchedules can import it without touching the loop's own module graph — no import cycle.
export const AGENT_TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];