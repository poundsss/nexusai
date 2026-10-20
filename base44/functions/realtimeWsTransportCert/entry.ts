// Transport certification for the Actor WebSocket push layer (NexusActorRelay, NEXUSAI).
// Pure-function: no LLM calls, no mutations, no fixture rows. It certifies the relay's TRANSPORT
// contract — the room-key identity, the event projection (filter/order/cap/watermark), the
// existence admission and the broadcast envelope (no identity/session/credential leakage). The
// certified semantic layer (realtimeParityTest, actorsParityCert, realtimeSignalCert) is untouched
// by this transport and must remain green alongside it.
import {
  RELAY_ACTOR_NAME, RT_SUB_MSG, RT_HELLO_MSG, RT_EVENT_MSG, PUMP_CADENCE_MS,
  relayRoomKey, parseRelayRoomKey, roomExistsInScan, selectRoomEvents, relayBroadcastEnvelope,
} from "../../shared/realtimeWsRelay.ts";

export default async function () {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok, detail: String(detail ?? "").slice(0, 300) }); };

  // 1. Room identity: one relay instance per (project, actor, room); strict both directions.
  const key = relayRoomKey("abc123xyz", "ChatRoom", "board-1");
  check("relay room key round-trips", key === "abc123xyz::ChatRoom::board-1" && JSON.stringify(parseRelayRoomKey(key)) === JSON.stringify({ project_id: "abc123xyz", actor: "ChatRoom", room: "board-1" }), key || "null");
  check("malformed relay keys are refused",
    relayRoomKey("", "ChatRoom", "r") === null
      && relayRoomKey("abc123xyz", "chatRoom", "r") === null // lowercase actor (actor grammar)
      && relayRoomKey("abc123xyz", "ChatRoom", ":bad") === null
      && relayRoomKey("bad id", "ChatRoom", "r") === null
      && parseRelayRoomKey("abc123xyz::ChatRoom") === null
      && parseRelayRoomKey("a::ChatRoom::r::extra") === null
      && parseRelayRoomKey("abc123xyz::chatRoom::r") === null,
    "");

  // 2. Admission: existence-based, read from the certified room store's rows.
  const roomRows = [
    { id: "1", data: { room_key: "ChatRoom:board-1", actor: "ChatRoom", room: "board-1", seq: 7 } },
    { id: "2", data: { room_key: "ChatRoom:other", seq: 3 } },
  ];
  check("admission accepts only an existing room row",
    roomExistsInScan(roomRows, "ChatRoom:board-1") && !roomExistsInScan(roomRows, "ChatRoom:missing") && !roomExistsInScan([], "ChatRoom:board-1"),
    "");

  // 3. Event projection: the SAME shape the certified events op returns — room-filtered, seq
  //    ordered above `since`, bounded, room_key stripped, seq/type/data/by/at preserved.
  const eventRows = [
    { id: "e3", data: { room_key: "ChatRoom:board-1", seq: 3, type: "message", data: { i: 3 }, by: "user:u1", at: "t3" } },
    { id: "e9", data: { room_key: "ChatRoom:other", seq: 9, type: "actor.join", data: {}, by: "user:u2", at: "t9" } },
    { id: "e1", data: { room_key: "ChatRoom:board-1", seq: 1, type: "actor.join", data: { session_id: "s" }, by: "user:u1", at: "t1" } },
    { id: "e5", data: { room_key: "ChatRoom:board-1", seq: 5, type: "message", data: { i: 5 }, by: "user:u1", at: "t5" } },
    { id: "e7", data: { room_key: "ChatRoom:board-1", seq: 7, type: "actor.leave", data: { session_id: "s" }, by: "user:u1", at: "t7" } },
  ];
  const { events, watermark } = selectRoomEvents(eventRows, "ChatRoom:board-1", 0, 50);
  check("projection filters to the room, orders by seq, strips room_key",
    JSON.stringify(events.map((e) => e.seq)) === "[1,3,5,7]"
      && events.every((e) => !("room_key" in e))
      && events[0].type === "actor.join" && events[1].data.i === 3 && events[3].by === "user:u1" && events[3].at === "t7",
    JSON.stringify(events.map((e) => e.seq)));
  check("since cursor: only newer events, watermark = last delivered seq",
    JSON.stringify(selectRoomEvents(eventRows, "ChatRoom:board-1", 3, 50).events.map((e) => e.seq)) === "[5,7]"
      && selectRoomEvents(eventRows, "ChatRoom:board-1", 3, 50).watermark === 7,
    "");
  check("batch cap bounds each pump; watermark stays put when nothing is new",
    selectRoomEvents(eventRows, "ChatRoom:board-1", 0, 2).events.length === 2
      && selectRoomEvents(eventRows, "ChatRoom:board-1", 0, 2).watermark === 3
      && selectRoomEvents(eventRows, "ChatRoom:board-1", 99, 50).events.length === 0
      && selectRoomEvents(eventRows, "ChatRoom:board-1", 99, 50).watermark === 99,
    "");

  // 4. Broadcast envelope: the ONLY frame clients receive — the event projection plus its type,
  //    and NEVER a participant identity beyond the event's own `by`, a session or a credential.
  const env = relayBroadcastEnvelope(events[1]);
  check("broadcast envelope is rt:event with the projected event only",
    env.type === RT_EVENT_MSG && env.event.seq === 3 && env.event.data.i === 3
      && JSON.stringify(Object.keys(env.event).sort()) === JSON.stringify(["at", "by", "data", "seq", "type"])
      && !JSON.stringify(env).includes("token") && !JSON.stringify(env).includes("session_id"),
    JSON.stringify(env));

  // 5. Wire constants: the relay is downstream-only (rt:sub/rt:hello exist on the protocol, the
  //    broadcast type is rt:event) and the internal pump cadence is bounded under the 4s poll.
  check("wire constants are stable and bounded",
    RELAY_ACTOR_NAME === "NexusActorRelay" && /^[A-Z][A-Za-z0-9]*$/.test(RELAY_ACTOR_NAME)
      && RT_SUB_MSG === "rt:sub" && RT_HELLO_MSG === "rt:hello" && RT_EVENT_MSG === "rt:event"
      && PUMP_CADENCE_MS > 0 && PUMP_CADENCE_MS <= 1000,
    `cadence=${PUMP_CADENCE_MS}ms`);

  const ok = checks.every((c) => c.ok);
  return Response.json({ ok, checks });
}