// Shared harness helpers for the deployed-app agent certification suites
// (appAgentToolsParityTest / appAgentMemoryParityTest / later suites).
//
// Pure plumbing only — no assertions, no scenario, no cleanup policy. The suites keep their own
// fixtures and finally blocks; what they share is the retry-wrapped service-role db, the paced
// scripted-turn invoke, and the small lookups over the provider stub's recorded evidence.
import { appAgentPace } from "./appAgentTestFixtures.ts";

// The suites' runtime paths (agent turns, ledger settlement, durable claims) burn a dozen-plus
// platform requests each, so a whole run trips the platform's per-window request limit. The
// proxy below waits out the window on a rate-limit refusal — safe ONLY because every retried
// call is a read, an idempotent keyed write (unique idempotency keys make the replay a no-op)
// or a scratch fixture. TEST-SUITES ONLY: production code must never swallow rate limits.
export function makeAgentSuiteDb(rawDb, pace = appAgentPace) {
  const withRetry = (fn) => async (...args) => {
    for (let a = 1; ; a++) {
      try { return await fn(...args); }
      catch (e) {
        if (!/rate limit/i.test(String((e && e.message) || "")) || a >= 4) throw e;
        await pace(20000);
      }
    }
  };
  return new Proxy(rawDb, {
    get(target, prop) {
      if (prop !== "entities") return target[prop];
      return new Proxy(target.entities, {
        get(ents, name) {
          const ent = ents[name];
          if (!ent || typeof ent !== "object") return ent;
          return new Proxy(ent, { get: (e, m) => (typeof e[m] === "function" ? withRetry(e[m].bind(e)) : e[m]) });
        },
      });
    },
  });
}

/** The paced, response-collecting scripted-turn invoke every agent suite uses. */
export function makeAgentInvoke({ handleAppAgent, client, options, pace = appAgentPace, responses = [] }) {
  return async ({ project, payload, user, anonymous = null, name, message, extra = {} }) => {
    await pace(2500);
    const r = await handleAppAgent(client, { project, payload, user, anonymous, op: "invoke", args: { name, message, ...extra }, options });
    responses.push(r);
    return r;
  };
}

/** The last system prompt a scripted provider recorded (per-suite evidence array). */
export const lastSeenSystem = (systemSeen) => String(systemSeen[systemSeen.length - 1] || "");

/** The standard runtime agent object the agent suites drive — exactly the shape the immutable
 *  artifact's `agents` projection carries for a declared agent document. Suite-specific keys
 *  (memory_config, tool_configs, context_files, allow_anonymous_access, ...) ride `extra`. */
export function makeRuntimeAgent(name, extra = {}, instructions = "Answer briefly.") {
  return {
    name, display_name: name, description: "test agent", instructions,
    tools: [], skills: [], model_tier: "fast", max_steps: 6, metadata: {},
    ...extra,
  };
}

/** The per-suite invoke closure binding one deployed payload (positional, shared by the
 *  agent parity suites so no suite re-implements the wrapper). */
export function makePayloadInvoke(invokeAgent, payload) {
  return (project, user, name, message, extra = {}, anonymous = null) =>
    invokeAgent({ project, payload, user, anonymous, name, message, extra });
}

/** The last observation text containing `needle`, newest first, across recorded message batches. */
export const lastMessageText = (seen, needle) => {
  for (let i = seen.length - 1; i >= 0; i--) {
    const m = (seen[i] || []).find((x) => String((x || {}).content || "").includes(needle));
    if (m) return String(m.content);
  }
  return "";
};

/** The assistant reply row of one idempotency key, from the reserved agent-messages entity. */
export async function findKeyedReplyRow(db, projectId, key) {
  const rows = await db.entities.AppRecord.filter({ project_id: projectId, entity_name: "__agent_messages" }, "-created_date", 50);
  return rows.find((r) => (r.data || {}).invoke_key === key && (r.data || {}).role === "assistant") || null;
}

/** HMAC-SHA256 over a raw webhook body, in the exact header form the WhatsApp Cloud API sends. */
export async function waSignature(appSecret, raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Scripted WhatsApp Cloud API boundary shared by the agent suites: POST /messages records the
 *  send through `onSend` (which may return the provider message id to answer with); every other
 *  path answers the phone-number lookup. */
export function waCloudStub({ onSend = () => {}, phoneNumber = "15550001234" } = {}) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (u.pathname.endsWith("/messages")) {
      const id = onSend({ to: body.to ?? null, text: body.text?.body ?? null });
      return new Response(JSON.stringify({ messages: [{ id: id || `wamid.${Date.now()}` }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ display_phone_number: phoneNumber }), { status: 200 });
  };
}