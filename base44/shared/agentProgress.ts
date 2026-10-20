// Agent response streaming (additive, non-parity): the ephemeral progress projection.
//
// While an in-app agent turn executes, the running text and tool statuses are published as a
// SHORT-TTL cache entry (the EXISTING CacheEntry primitive, `agentprogress` namespace) — NEVER
// a Message row, never a ledger entry, never a change to billing, idempotency or the turn
// lifecycle. The draft carries the conversation id and the TURN id as its stable message_id,
// a `streaming: true` marker, and ONLY the certified tool-call projection (completed entries
// exactly as persisted via toolCallView; an in-flight tool shows the documented "running"
// status with no ok/code yet). The durable assistant Message — created at the END of the turn
// by the UNCHANGED settlement path — supersedes the draft: the draft is retired BEFORE the
// reply row is written, so a projection never shows both. Every write/read/clear is fail-safe
// (a progress failure can never affect the turn), and an expired/removed entry simply means
// "no draft". The `get` op embeds the draft in the conversation projection ONLY — the
// documented `count` and top-level `messages` stay the persisted contract, unchanged.
import * as cache from "./cache.ts";

export const AGENT_PROGRESS_NAMESPACE = "agentprogress";
export const AGENT_PROGRESS_TTL_MS = 120000;
export const AGENT_PROGRESS_CONTENT_CHARS = 4000; // keeps the draft well under the cache value cap

export const agentProgressKey = (project, conversationId) => `agentprogress:${project.id}:${conversationId}`;

export const agentProgressView = (p) => ({
  id: p.message_id, message_id: p.message_id,
  conversation_id: p.conversation_id || null,
  role: "assistant", content: p.content || "",
  created_at: p.started_at || null, created_date: p.started_at || null, updated_date: p.started_at || null,
  ...(Array.isArray(p.tool_calls) && p.tool_calls.length ? { tool_calls: p.tool_calls } : {}),
  streaming: true,
});

/** One progress write from the turn loop. Fail-safe: a write can never break the turn. */
export const writeAgentProgress = async (svc, key, { conversationId, turnId, startedAt, content, step, toolCalls, runningTool }) => {
  try {
    await cache.set(svc, key, {
      conversation_id: conversationId, message_id: turnId, role: "assistant",
      content: content || "", started_at: startedAt, step: step || 0, streaming: true,
      tool_calls: [...toolCalls,
        ...(runningTool ? [{ tool: runningTool, name: runningTool, status: "running" }] : [])],
    }, { namespace: AGENT_PROGRESS_NAMESPACE, ttl_ms: AGENT_PROGRESS_TTL_MS });
  } catch { /* additive: a progress write can never break the turn */ }
};

export async function readAgentProgress(svc, key) {
  try { const hit = await cache.get(svc, key, {}); return hit ? hit.value : null; } catch { return null; }
}

export async function clearAgentProgress(svc, key) {
  try { await cache.invalidate(svc, key); } catch { /* fail-safe: cleanup can never throw into the turn */ }
}