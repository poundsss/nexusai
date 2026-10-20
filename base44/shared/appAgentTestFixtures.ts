// Shared fixtures for the deployed-app agent certification suites (P-9.4 / P-9.10A / P-9.10B / P-9.10C).
//
// One place owns the scratch-shape helpers every agent suite needs, so no suite re-implements
// (and drifts from) the pacing, the declared-agent document factory, the scratch-project factory,
// the credit-pool probes, the channel connect-URL code extraction or the encrypted ProjectSecret
// fixtures. Pure helpers only — no transport stubs, no assertions, no cleanup policy; each suite
// keeps its own scenario and its own finally block.
import { grantTestPool, poolBalance } from "./creditPoolTestHelpers.ts";
import { encryptSecretValue, decryptSecretValue } from "./secretCrypto.ts";

// The platform rate-limits bursts of SDK requests, and every agent op rides the real
// entity/ledger paths (a dozen+ requests per call) — pace between calls.
export const appAgentPace = (ms = 1200) => new Promise((resolve) => setTimeout(resolve, ms));

/** A declared agent document exactly as the immutable artifact carries it. */
export const appAgentDoc = (name, metadata = {}, instructions = "Answer briefly.") => ({
  name, display_name: name, description: "test agent", instructions,
  tools: [], skills: [], model_tier: "fast", max_steps: 3,
  metadata: Object.keys(metadata).length ? metadata : {},
});

/** A scratch project inside a scratch workspace; every id is tracked for the suite's cleanup. */
export async function makeAgentProject(svc, projectIds, ws, stamp, prefix) {
  const p = await svc.entities.Project.create({ workspace_id: ws.ws.id, name: `${prefix}-proj-${ws.user.id}-${stamp}` });
  projectIds.push(p.id);
  return p;
}

/** Credit-pool grants and probes with suite-scoped idempotency keys. */
export function makeAgentPoolTools(svc, stamp, prefix) {
  return {
    grant: (wsId, pool, n) => grantTestPool(svc, { workspace_id: wsId, pool, amount: n, key: `${prefix}:${pool}:${wsId}:${stamp}`, reason: `${prefix} test grant` }),
    msgOf: async (wsId) => (await poolBalance(svc, wsId, "message")).balance,
    intOf: async (wsId) => (await poolBalance(svc, wsId, "integration")).balance,
  };
}

/** The single-use activation code a channel connect URL carries in its query param. */
export const activationCodeOf = (url, param = "start") => {
  try { return new URL(String(url)).searchParams.get(param) || ""; } catch { return ""; }
};

/** Writes one ENCRYPTED ProjectSecret row for a scratch project (fresh project per suite
 *  run, so a plain create keeps the fixture one request per secret). */
export async function setProjectSecret(svc, project, name, value) {
  const sealed = await encryptSecretValue(project.id, name, value);
  await svc.entities.ProjectSecret.create({ project_id: project.id, name, value: sealed, description: "agent-suite fixture", required: true, access: "backend_only" });
}

/** A resolveSecret function for the channel/runtime handlers, decrypting this project's rows.
 *  Per-name memoization: a resolver lives for ONE request, and a secret never rotates
 *  mid-request — the webhook handler resolves the same four names on every path. */
export const projectSecretResolver = (svc, project) => {
  const cache = new Map();
  return async (name) => {
    if (cache.has(name)) return cache.get(name);
    const rows = await svc.entities.ProjectSecret.filter({ project_id: project.id, name: String(name) }, "name", 1).catch(() => []);
    const row = rows[0];
    let value;
    if (!row || !row.value) value = undefined;
    else { try { value = await decryptSecretValue(project.id, row.name, row.value); } catch { value = undefined; } }
    cache.set(name, value);
    return value;
  };
};