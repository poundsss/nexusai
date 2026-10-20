// Shared plumbing for the integrations-scope certification suites (mediaIntegrationCert,
// generateImageRefCert, …): integration-credit grants/reads and the two dispatch bridges.
// Pure test-plumbing extraction — no behavior of its own.
import { grantTestPool, poolBalance } from "./creditPoolTestHelpers.ts";
import { handleAppIntegrations } from "./appIntegrations.ts";

/** Grants integration credits from the canonical ledger to a workspace. */
export const grantIntegrationCredits = (db, wsId, amount, key, reason = "Certification grant") =>
  grantTestPool(db, { workspace_id: wsId, pool: "integration", amount, key, reason });

/** The workspace's integration-credit pool view ({ balance, reserved, available }). */
export const integrationPoolBalance = (db, wsId) => poolBalance(db, wsId, "integration");

/** Drives ONE integrations-scope bridge call against a (provider-stubbed) service client. */
export const integrationBridge = (stub, project, op, args, user = null) =>
  handleAppIntegrations(stub, { project, integrations: [], user, session: null, op, args, transport: "test" });

/** Calls ONE integrations operation through the REAL deployed public runtime. */
export const runtimeIntegrationsCall = (rt, slug, op, args, session_token) =>
  rt({ action: "integrations", slug, op, args, session_token });