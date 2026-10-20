// Idempotent UsageEvent stamping — the run row is the coordination point.
//
// Every settlement path (Builder settle, agent finalize, agent recovery, the abandoned-operation
// sweep) must leave exactly ONE usage-analytics event per run. The run's usage_event_id is the
// claim: the candidate event is created first, then claimed onto the run with ONE conditional
// updateMany, so concurrent settlers converge instead of racing — the same single-writer claim
// freezeForSettlement uses for AIOperation. A worker that loses the claim deletes its candidate
// and adopts the winner's id, so no duplicate ever survives. Not billing: the charge lives in the
// ledger under the operation's own idempotency key; this helper writes no ledger entries and never
// moves credits — usage_event_id / operation_id / credits_charged are display stamps copied from
// the settlement result.

export async function stampUsageEvent(svc, {
  run_entity, run_id, event,
  operation_id = null, credits_charged = 0,
}: { run_entity: "AIRun" | "AgentRun"; run_id: string; event: object; operation_id?: string | null; credits_charged?: number }) {
  if (!run_id) throw new Error("stampUsageEvent: run_id is required");
  const runRows = run_entity === "AgentRun" ? svc.entities.AgentRun : svc.entities.AIRun;
  const candidate = await svc.entities.UsageEvent.create({ ...event });
  // THE atomic claim: exactly one concurrent worker's update matches an unclaimed run row, however
  // stale its earlier in-memory read was. Every other worker updates zero rows.
  const claim = await runRows.updateMany(
    { id: run_id, usage_event_id: null },
    { $set: { usage_event_id: candidate.id, operation_id, credits_charged } }
  );
  if ((Number(claim?.updated) || 0) >= 1) return { usage_event_id: candidate.id, duplicate: false };
  // Another worker won: this candidate is a duplicate, so it never enters the analytics record.
  await svc.entities.UsageEvent.delete(candidate.id).catch(() => {});
  const run = await runRows.get(run_id).catch(() => null);
  return { usage_event_id: run?.usage_event_id || null, duplicate: true };
}