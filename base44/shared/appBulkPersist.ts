// Pipeline A + B: bulk persist loops with explicit partial-write semantics and best-effort
// compensation. Every gate/validation runs BEFORE the loop (unchanged). The storage layer offers
// NO multi-record transaction (UNKNOWN upstream — never assumed), so the loop is per-record.
// Pipeline B: when a write fails partway and the caller supplies `undoOne`, the already-applied
// records are compensated in REVERSE order. Compensation is best-effort, not atomic: a record that
// changed concurrently is skipped (undo returns false) and reported, never clobbered.
//   • every applied record compensated → DATABASE_BULK_ROLLED_BACK (nothing remains written)
//   • otherwise                          → DATABASE_BULK_PARTIAL with exactly what remains
import { dbError } from "./appRecordValidation.ts";

export async function persistEach(entity, operation, plans, writeOne, undoOne = null) {
  const applied = [];
  for (let i = 0; i < plans.length; i++) {
    try {
      applied.push(await writeOne(plans[i], i));
    } catch (err) {
      const cause = String(err?.message || err).slice(0, 200);
      const base = { entity, operation, failed_index: i, not_written_count: plans.length - i, cause_code: err?.code || null };
      if (!undoOne) {
        throw Object.assign(dbError("DATABASE_BULK_PARTIAL", `${entity}.${operation} stopped at record ${i + 1} of ${plans.length}: ${cause}. ${i} record(s) were written and were not rolled back.`, {
          ...base, written_count: i, written_ids: applied.map((a) => a?.id ?? null), rollback: "not_supported",
        }), { status: 500 });
      }
      const remaining = [], rolledBack = [];
      for (let j = applied.length - 1; j >= 0; j--) {
        let ok = false;
        try { ok = (await undoOne(plans[j], applied[j], j)) !== false; } catch { ok = false; }
        (ok ? rolledBack : remaining).unshift(applied[j]?.id ?? null);
      }
      if (!remaining.length) {
        throw Object.assign(dbError("DATABASE_BULK_ROLLED_BACK", `${entity}.${operation} stopped at record ${i + 1} of ${plans.length}: ${cause}. The ${i} record(s) already written were rolled back; nothing remains written.`, {
          ...base, written_count: 0, written_ids: [], rolled_back_ids: rolledBack, rollback: "complete",
        }), { status: 500 });
      }
      throw Object.assign(dbError("DATABASE_BULK_PARTIAL", `${entity}.${operation} stopped at record ${i + 1} of ${plans.length}: ${cause}. ${remaining.length} record(s) remain written (rollback incomplete).`, {
        ...base, written_count: remaining.length, written_ids: remaining, rolled_back_ids: rolledBack, rollback: "incomplete",
      }), { status: 500 });
    }
  }
  return applied;
}