// Shared helpers for the FunctionsModule invoke parity suites (F1 + G-A): the request pacing
// and the Δ0-credit probe both suites certify with. One module owns them so the two suites
// certify the SAME billing semantics instead of re-implementing the probe.
import { appAgentPace } from "./appAgentTestFixtures.ts";
import { poolBalance } from "./creditPoolTestHelpers.ts";

// Deployed-runtime call pacing, shared with the agent suites' default cadence.
export const invokePace = (ms) => appAgentPace(ms || 250);

// Δ0-credit probe: snapshots BOTH pools, runs the invoke thunk, returns the deltas. A parity
// suite asserts both deltas are 0 — an invoke (JSON or File/multipart) must never move a credit.
export async function probeCreditDeltas(db, workspaceId, thunk) {
  const messageBefore = (await poolBalance(db, workspaceId, "message")).balance;
  const integrationBefore = (await poolBalance(db, workspaceId, "integration")).balance;
  await thunk();
  const messageAfter = (await poolBalance(db, workspaceId, "message")).balance;
  const integrationAfter = (await poolBalance(db, workspaceId, "integration")).balance;
  return { messageDelta: messageAfter - messageBefore, integrationDelta: integrationAfter - integrationBefore };
}