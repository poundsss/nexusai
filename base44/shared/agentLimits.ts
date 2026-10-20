// Extracted from appAgentRuntime.ts ONLY for the platform file-size limit — a pure move, no
// change of value or meaning. Every consumer keeps importing APP_AGENT_LIMITS from
// appAgentRuntime (which re-exports this constant).
export const APP_AGENT_LIMITS = {
  MAX_MESSAGE_CHARS: 4000,
  MAX_REPLY_CHARS: 8000,
  MAX_OBSERVATION_CHARS: 2000,
  HISTORY_MESSAGES: 20,
  MAX_STEPS: 6,                // hard server-side ceiling; an agent's max_steps only lowers it
  MODEL_TIMEOUT_MS: 30000,
  MODEL_MAX_ATTEMPTS: 2,
  IDempotENCY_KEY_CHARS: 180,
  LIST_LIMIT: 50,
  METADATA_CHARS: 500,
  METADATA_KEYS: 10,
  // P-9.11B memory caps. The scan bound is DOCUMENTED (Base44): agent memory reads return up to
  // 200 memories, no pagination. The remaining bounds are UNKNOWN in Base44 — this platform's own.
  MEMORY_STATEMENT_CHARS: 400,      // one remembered fact, scrubbed
  MEMORY_MAX_ROWS: 20,              // rows rendered into the model context, at most
  MEMORY_CONTEXT_CHARS: 1500,       // hard cap on the injected memory block
  MEMORY_SCAN: 200,                 // DOCUMENTED 200-memory bound — rows fetched per scope before the agent filter
  MEMORY_OTHER_CONVERSATIONS: 2,    // other conversations shown when configured
  MEMORY_OTHER_CONTEXT_CHARS: 800, // hard cap on the other-conversations block
  // P-9.11D context-file caps. Base44 publishes no injection bound (UNKNOWN) — these are
  // this platform's own: one scrubbed file excerpt and a hard cap on the whole block.
  CONTEXT_FILE_CHARS: 4000,        // one context file's excerpt, scrubbed
  CONTEXT_BLOCK_CHARS: 20000,      // hard cap on the injected context block
  // P-9.11J in-app skill caps. Base44 publishes the selection count (10) but no injection
  // bound (UNKNOWN) — these are this platform's own, mirroring the P-9.11D conventions.
  // The per-skill excerpt rides the EXISTING scrub contract (scrubText → redact), which
  // itself slices a scrubbed string to 500 characters — 500 is the honest effective bound,
  // so the constant states it instead of an unreachable larger cap.
  SKILL_CHARS: 500,                // one selected skill's excerpt, scrubbed (the scrub contract's own ceiling)
  SKILLS_BLOCK_CHARS: 20000,       // hard cap on the injected skills block
};