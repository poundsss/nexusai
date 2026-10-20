// CreditService: the credit façade used by run/agent orchestration.
//
// It is now a thin wrapper over the authoritative ledger (base44/shared/ledger.ts): balances
// are derived from immutable ledger entries, and every movement carries an idempotency key so a
// retried or duplicated worker cannot move credits twice. Nothing writes
// Workspace.credits_balance directly any more — that field is a projection of the ledger.

import { recordEvent, deriveBalance, InsufficientCredits } from "./ledger.ts";
import { DEFAULT_CREDIT_POLICY, creditsForCharge } from "./economics.ts";

// Legacy helper: provider cost → credits, now routed through the credit pricing policy so the
// platform has exactly one cost→credits conversion.
export function creditsForCost(providerCostUsd, policy = DEFAULT_CREDIT_POLICY) {
  return creditsForCharge({ provider_cost: providerCostUsd, policy }).credits;
}

const move = (base44, workspaceId, event_type, signedAmount, referenceId, description) =>
  recordEvent(base44, {
    workspace_id: workspaceId,
    event_type,
    amount: signedAmount,
    // Keyed by reference: one charge (or refund) per referenced run/operation, ever.
    idempotency_key: `${event_type}:${referenceId || "unreferenced"}:${Math.abs(signedAmount)}`,
    reason: description || event_type,
    metadata: { reference_id: referenceId || null },
  }, { allowNegative: true }).then((r) => r.balance);

export const CreditService = {
  consume: (base44, workspaceId, amount, referenceId, description) => move(base44, workspaceId, "ai_charge", -Math.abs(amount), referenceId, description),
  refund: (base44, workspaceId, amount, referenceId, description) => move(base44, workspaceId, "refund", Math.abs(amount), referenceId, description),
  grant: (base44, workspaceId, amount, referenceId, description) => move(base44, workspaceId, "promotional", Math.abs(amount), referenceId, description),
  getBalance: async (base44, workspaceId) => (await deriveBalance(base44, workspaceId)).balance,
  getAvailable: async (base44, workspaceId) => (await deriveBalance(base44, workspaceId)).available,
};

export { InsufficientCredits };