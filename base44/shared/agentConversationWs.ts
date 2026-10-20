// Agent conversation realtime push (additive transport): publishes the EXISTING message
// projections as events in the SAME AppRecord room store the certified NexusActorRelay
// transports, so an agent conversation gains WebSocket push delivery WITHOUT any new
// transport, entity, schema or authorization surface.
//
//   room identity  → actor "AgentConversation", room = conversation_id (both inside the
//                    certified room grammars); the CLIENT-facing subscription room is the
//                    SDK's own 'agent-conversations:<conversation_id>' string, which the host
//                    bridge maps onto the relay key before it ever reaches the relay.
//   frames         → the EXISTING projections only: messageView for a durable Message, the
//                    agentProgressView-shaped draft for an in-flight turn, and an explicit
//                    retired marker when the draft is cleared. Tool-call entries are truncated
//                    to the DOCUMENTED realtime limits (arguments_string ≤ 500, results ≤ 50)
//                    at frame time — nothing on a frame ever exceeds them.
//   authorization  → NONE added. The relay is transport-only (existence-based admission); the
//                    ONLY way a socket reaches a conversation room is the host bridge, which
//                    proves the current session's read with the SAME certified agent get op
//                    (ownership server-side) before connecting. Writes never ride the socket.
//   fail-safety    → every publish is fail-safe: a push failure can never affect the turn,
//                    matching the existing draft/progress contract.
import { ACTOR_EVENTS_ENTITY, ensureRoom, roomKey, ROOM_ID_RE } from "./actorRuntime.ts";
import { relayRoomKey } from "./realtimeWsRelay.ts";

export const AGENT_CONVERSATION_ACTOR = "AgentConversation";
export const CONVERSATION_ROOM_PREFIX = "agent-conversations:";

/** DOCUMENTED (docs.base44.com SDK reference `agents`) realtime frame truncation limits. */
export const FRAME_TOOL_ARGS_CHARS = 500;
export const FRAME_TOOL_RESULTS_CHARS = 50;

/** The relay room key for ONE conversation, or null when the id is outside the room grammar. */
export const conversationRelayKey = (projectId, conversationId) =>
  relayRoomKey(projectId, AGENT_CONVERSATION_ACTOR, conversationId);

/** The client-facing subscription room string for ONE conversation ('agent-conversations:<id>'). */
export const conversationRoomId = (conversationId) => `${CONVERSATION_ROOM_PREFIX}${conversationId}`;

/**
 * The documented truncation, applied at frame time to every tool-call entry. The certified
 * persistence contract stores { primitive|tool, ok, code } and never an argument or a result,
 * so in practice nothing is truncated — the truncator is the GUARD that keeps any future write
 * path from ever exceeding the documented limits on a realtime frame.
 */
export function truncateFrameToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((t) => (t && typeof t === "object"
    ? {
        ...t,
        ...(typeof t.arguments_string === "string" ? { arguments_string: t.arguments_string.slice(0, FRAME_TOOL_ARGS_CHARS) } : {}),
        ...(typeof t.results === "string" ? { results: t.results.slice(0, FRAME_TOOL_RESULTS_CHARS) } : {}),
      }
    : t));
}

/** The draft frame: the SAME agentProgressView projection the get read embeds. */
export const conversationDraftFrame = (p) => ({
  id: p.message_id, message_id: p.message_id,
  conversation_id: p.conversation_id || null,
  role: "assistant", content: p.content || "",
  created_at: p.started_at || null, created_date: p.started_at || null, updated_date: p.started_at || null,
  ...(Array.isArray(p.tool_calls) && p.tool_calls.length ? { tool_calls: truncateFrameToolCalls(p.tool_calls) } : {}),
  streaming: true,
});

/**
 * Creates the conversation's room row ONCE (idempotent, mirroring the certified actor room
 * creation), so the relay can admit subscribers that join BEFORE the first message. Fail-safe.
 */
export async function ensureConversationRoom(svc, projectId, conversationId) {
  try {
    if (!ROOM_ID_RE.test(String(conversationId || ""))) return;
    await ensureRoom(svc, projectId, AGENT_CONVERSATION_ACTOR, String(conversationId));
  } catch { /* fail-safe: room creation can never break the conversation */ }
}

/** ONE conversation event into the room's monotonic stream (the SAME store the relay pumps). */
export async function publishConversationEvent(svc, projectId, conversationId, type, data) {
  try {
    const cid = String(conversationId || "");
    if (!ROOM_ID_RE.test(cid) || !relayRoomKey(projectId, AGENT_CONVERSATION_ACTOR, cid)) return;
    const row = await ensureRoom(svc, projectId, AGENT_CONVERSATION_ACTOR, cid);
    const d = row.data || {};
    const seq = Number(d.seq || 0) + 1;
    await svc.entities.AppRecord.update(row.id, { data: { ...d, seq, updated_at: new Date().toISOString() } });
    await svc.entities.AppRecord.create({
      project_id: projectId, entity_name: ACTOR_EVENTS_ENTITY,
      data: { room_key: roomKey(AGENT_CONVERSATION_ACTOR, cid), seq, type: String(type || "message"), data: data ?? null, by: null, at: new Date().toISOString() },
    });
  } catch { /* fail-safe: a push failure can never break the turn */ }
}

/** A durable Message frame: EXACTLY the messageView projection, tool entries truncated. */
export const publishAgentMessage = (svc, projectId, conversationId, view) =>
  publishConversationEvent(svc, projectId, conversationId, "message",
    view && Array.isArray(view.tool_calls) ? { ...view, tool_calls: truncateFrameToolCalls(view.tool_calls) } : view);

/** The in-flight draft frame (the SAME projection the get read embeds, truncated). */
export const publishAgentDraft = (svc, projectId, conversationId, payload) =>
  publishConversationEvent(svc, projectId, conversationId, "draft", conversationDraftFrame(payload));

/** The draft's retirement frame — the durable Message supersedes the draft; a failed turn
 *  leaves none behind. The client removes the draft entry by its message_id. */
export const publishAgentDraftRetired = (svc, projectId, conversationId, messageId) =>
  publishConversationEvent(svc, projectId, conversationId, "draft",
    { id: messageId, message_id: messageId, streaming: true, retired: true });