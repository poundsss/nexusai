// Shared scratch-workspace CREDIT-POOL helpers for the credit regression suites.
//
// One definition of "grant a scratch pool" and "read a pool balance", so no two suites drift
// apart on how a test grant is recorded or a pool is measured. Grants ride the REAL canonical
// ledger (recordEvent); balances are the REAL derived ledger views — nothing here invents a
// second billing path.
import { deriveBalance, recordEvent } from "./ledger.ts";

/** Ledger-backed scratch grant into one credit pool ("message" | "integration"). */
export function grantTestPool(svc, { workspace_id, pool, amount, key, reason }) {
  return recordEvent(svc, {
    workspace_id, event_type: "purchase", amount, credit_type: pool,
    idempotency_key: key, reason: reason || "Test credit grant",
  });
}

/** The current derived balance view of one credit pool. */
export async function poolBalance(svc, workspace_id, pool) {
  return (await deriveBalance(svc, workspace_id)).by_type[pool];
}