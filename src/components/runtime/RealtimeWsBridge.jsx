// Host-owned WebSocket bridge for Actor realtime push (NEXUSAI transport layer).
//
// The generated app's iframe is opaque-origin and holds no credential, so the HOST page owns the
// WebSocket: it connects to the platform's NexusActorRelay Durable Object (one instance per
// project::actor::room) and relays the pushed room events into the frame over the SAME postMessage
// bridge the streaming surface uses:
//   bridge:rt-ws-sub     iframe → host: subscribe (actor, room, since)
//   bridge:rt-ws-ready   host → iframe: the relay acked (rt:hello) — the client may pause its poll
//   bridge:rt-ws-event   host → iframe: one room event, exactly the events-op projection
//   bridge:rt-ws-closed  host → iframe: the subscription failed/closed — the poll resumes
// No token, session or relay credential is ever placed on a frame; writes (connect/disconnect/
// send/signal) keep riding the certified HTTP path.
import React, { useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";

// The SAME grammars the server enforces (shared/actorResource.ts, shared/actorRuntime.ts).
const ACTOR_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The relay Durable Object's room identity (shared/realtimeWsRelay.ts relayRoomKey).
const relayRoomKey = (projectId, actor, room) => `${projectId}::${actor}::${room}`;
// Agent conversation rooms (shared/agentConversationWs.ts): the generated SDK subscribes with
// the CLIENT-facing room string; the host maps it onto the AgentConversation relay room ONLY
// after proving the session's read of that conversation — with the SAME certified agent get
// op the poll uses. No token, session or relay credential ever crosses to the frame.
const AGENT_CONVERSATION_ACTOR = "AgentConversation";
const CONVERSATION_ROOM_PREFIX = "agent-conversations:";

export default function RealtimeWsBridge({ iframeRef, target, sessionTokenRef }) {
  const projectIdRef = useRef(null);

  useEffect(() => {
    projectIdRef.current = null; // the serving target changed — resolve again
    const subs = new Map(); // subId → { room, sub }

    // The host page knows only a slug; the relay room key needs the project id, resolved ONCE
    // through the EXISTING app read (the documented getPublicSettings surface — { id, ... }).
    const ensureProjectId = async () => {
      if (projectIdRef.current) return projectIdRef.current;
      const res = await base44.functions.invoke("appRuntime", {
        ...target, action: "app", op: "get_public_settings",
        ...(sessionTokenRef.current ? { session_token: sessionTokenRef.current } : {}),
      });
      projectIdRef.current = (res.data?.result?.id) || null;
      return projectIdRef.current;
    };
    const tell = (win, payload) => { try { win.postMessage(payload, "*"); } catch { /* frame gone */ } };

    const onMessage = async (e) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || e.source !== frame) return;
      const m = e.data || {};
      if (m.type === "bridge:rt-ws-sub") {
        // One WS per subscription. The HOST owns the socket: the opaque-origin frame never sees
        // the relay, its token or any credential — only rt:event frames forwarded back.
        try {
          // Agent conversation room (agents.subscribeToConversation): the client-facing room
          // string maps onto the AgentConversation actor's room — but ONLY for a conversation
          // the session can READ (the certified agent get proves it; anything else fails closed
          // and the frame's own 4s poll keeps serving).
          let actor = String(m.actor || "");
          let roomName = String(m.room || "");
          if (roomName.startsWith(CONVERSATION_ROOM_PREFIX)) {
            if (actor !== AGENT_CONVERSATION_ACTOR) throw new Error("invalid agent conversation room");
            const conversationId = roomName.slice(CONVERSATION_ROOM_PREFIX.length);
            if (!ROOM_ID_RE.test(conversationId)) throw new Error("invalid conversation room");
            const auth = await base44.functions.invoke("appRuntime", {
              ...target, action: "agent", op: "get", args: { conversation_id: conversationId },
              ...(sessionTokenRef.current ? { session_token: sessionTokenRef.current } : {}),
            });
            if (auth.data?.error || !auth.data?.result?.conversation) throw new Error("conversation read refused");
            actor = AGENT_CONVERSATION_ACTOR;
            roomName = conversationId;
          } else if (!ACTOR_NAME_RE.test(actor) || !ROOM_ID_RE.test(roomName)) {
            throw new Error("invalid actor/room");
          }
          const projectId = await ensureProjectId();
          if (!projectId) throw new Error("project unavailable");
          const relayKey = relayRoomKey(projectId, actor, roomName);
          const room = base44.actors.NexusActorRelay(relayKey).connect({ id: "h-" + String(m.subId).slice(-24) });
          // The platform actors client sends no handshake of its own — the relay admits the
          // subscription on the bounded rt:sub only (realtimeWsTransportCert). Sent immediately;
          // the socket client buffers it until the connection is open.
          try { room.send({ type: "rt:sub", key: relayKey }); } catch { /* buffered or closed */ }
          const sub = room.subscribe((msg) => {
            if (msg && msg.type === "rt:event" && msg.event) tell(frame, { type: "bridge:rt-ws-event", subId: m.subId, event: msg.event });
            else if (msg && msg.type === "rt:hello") tell(frame, { type: "bridge:rt-ws-ready", subId: m.subId });
          });
          subs.set(String(m.subId), { room, sub });
        } catch {
          tell(frame, { type: "bridge:rt-ws-closed", subId: m.subId });
        }
        return;
      }
      if (m.type === "bridge:rt-ws-unsub") {
        const s = subs.get(String(m.subId));
        if (s) { try { s.sub.unsubscribe(); s.room.close(); } catch { /* already closed */ } subs.delete(String(m.subId)); }
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const s of subs.values()) { try { s.sub.unsubscribe(); s.room.close(); } catch { /* already closed */ } }
    };
  }, [target, iframeRef]);

  return null;
}