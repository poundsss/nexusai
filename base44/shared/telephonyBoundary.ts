import { PHONE_CHANNEL_BLOCKER, PHONE_TRANSPORT_UNAVAILABLE_CODE } from "./agentChannelGaps.ts";
// No telephony provider is installed in this project. No generic caller-selected HTTP
// endpoint, fake number, unverified webhook or success-shaped mock enters production.
// A registered real adapter must supply provisioning, credential validation, idempotent
// submission, authenticated callbacks/status reconciliation, cancellation and results.
export const TELEPHONY_CONTRACT = Object.freeze({ version: 1,
  operations: ["configuration", "provision", "dial", "status", "cancel", "retry", "results"],
  requires: ["provider account and billing", "verified caller identity/number", "server-side credentials", "idempotent outbound-call API", "signed status/results callbacks", "bidirectional audio transport for an AI caller"],
  registered_provider: null, credentials_verified: false, transport_ready: false });
export function createTelephonyBoundary() {
  const refuse = async () => { throw Object.assign(new Error(PHONE_CHANNEL_BLOCKER), { code: PHONE_TRANSPORT_UNAVAILABLE_CODE, status: 501, retryable: false }); };
  return { ...Object.fromEntries(TELEPHONY_CONTRACT.operations.map((op) => [op, refuse])), configuration: async () => ({ ...TELEPHONY_CONTRACT, available: false, code: PHONE_TRANSPORT_UNAVAILABLE_CODE, blocker: PHONE_CHANNEL_BLOCKER }) };
}