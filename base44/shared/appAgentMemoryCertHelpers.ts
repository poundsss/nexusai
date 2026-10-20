// Shared fixtures/lookups for the deployed-app agent MEMORY certification suites
// (appAgentMemoryParityTest / appAgentMemoryScopeBothCert). Pure plumbing only — no assertions,
// no scenario, no cleanup policy.
import { lastMessageText, lastSeenSystem, makeRuntimeAgent } from "./appAgentSuiteHelpers.ts";

/** A per-suite agent factory binding the suite's fixed instructions. `memory_config === undefined`
 *  omits the key entirely (the parity-default agent). */
export const makeMemoryAgent = (instructions) => (name, memory_config, extra = {}) =>
  makeRuntimeAgent(name, { ...(memory_config !== undefined ? { memory_config } : {}), ...extra }, instructions);

/** Memory-row lookups over the reserved `__agent_memories` AppRecord entity, scoped to one project. */
export const makeMemoryLookups = (db) => ({
  memRows: async (project, owner) => (await db.entities.AppRecord.filter(
    { project_id: project.id, entity_name: "__agent_memories", ...(owner ? { owner_id: owner } : {}) },
    "-created_date", 200,
  ).catch(() => [])),
  rowsOf: async (project, owner, agent) => (await db.entities.AppRecord.filter(
    { project_id: project.id, entity_name: "__agent_memories", ...(owner ? { owner_id: owner } : {}) },
    "-created_date", 200,
  ).catch(() => [])).filter((r) => (r.data || {}).agent_name === agent),
});

/** The evidence lookups over the scripted provider's recorded system prompts and message batches. */
export const makeMemoryEvidence = (systemSeen, seen) => ({
  lastSystem: () => lastSeenSystem(systemSeen),
  lastMsg: (needle) => lastMessageText(seen, needle),
});