// Pure transport logic for NexusActorRelay — the platform Durable Object that pushes Actor room
// events over a persistent WebSocket. TRANSPORT ONLY: it executes nothing, authorizes nothing and
// widens nothing — the certified actorInvoke path remains the ONLY execution/authorization surface,
// and room events remain the AppRecord-backed __actor_events stream the events op reads.
//
//   room identity  → one relay instance per (project, actor, room), keyed by relayRoomKey
//   delivery       → bounded, seq-ordered scan of __actor_events above the relay's watermark,
//                    broadcast as rt:event frames; clients dedupe by their own seq (at-least-once)
//   admission      → the room must EXIST in __actor_rooms (created by the certified connect path);
//                    a relay instance whose room does not exist refuses its connections
export const RELAY_ACTOR_NAME = "NexusActorRelay";
export const RT_SUB_MSG = "rt:sub";
export const RT_HELLO_MSG = "rt:hello";
export const RT_EVENT_MSG = "rt:event";
export const PUMP_WAKE_KEY = "pump";
// Internal pump cadence: the relay scans the room's event stream while it has clients. Delivery
// latency is this cadence plus platform scheduling (±seconds), NOT instant — no server→DO
// notification hook exists (documented UNKNOWN). It is still bounded far under the 4s client
// poll it replaces.
export const PUMP_CADENCE_MS = 750;
export const RELAY_ROOM_SCAN = 500; // mirrors ACTOR_LIMITS.MAX_ROOM_SCAN
export const RELAY_EVENT_SCAN = 300; // bounded __actor_events scan per pump
export const RELAY_EVENT_BATCH = 50; // max events broadcast per pump (mirrors the events-op cap)

const PROJECT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
const ACTOR_NAME_RE = /^[A-Z][A-Za-z0-9]*$/; // mirrors shared/actorResource.ts ACTOR_NAME_RE
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // mirrors shared/actorRuntime.ts ROOM_ID_RE

/** The relay room identity: `<project_id>::<Actor>::<room>`, or null for malformed inputs. */
export function relayRoomKey(projectId, actor, room) {
  const p = String(projectId || ""), a = String(actor || ""), r = String(room || "");
  if (!PROJECT_ID_RE.test(p) || !ACTOR_NAME_RE.test(a) || !ROOM_ID_RE.test(r)) return null;
  return `${p}::${a}::${r}`;
}

/** The inverse of relayRoomKey: strict, bounded, and null for anything malformed. */
export function parseRelayRoomKey(key) {
  const parts = String(key || "").split("::");
  if (parts.length !== 3) return null;
  const [project_id, actor, room] = parts;
  if (!PROJECT_ID_RE.test(project_id) || !ACTOR_NAME_RE.test(actor) || !ROOM_ID_RE.test(room)) return null;
  return { project_id, actor, room };
}

/** Admission check: the room row (created by the certified connect path) exists in the scan. */
export function roomExistsInScan(rows, key) {
  return (rows || []).some((r) => (r.data || {}).room_key === key);
}

/**
 * The relay's ONE read shape — the same projection the certified events op returns: the room's
 * events above `since`, in sequence order, bounded, with room_key stripped and the event fields
 * (seq/type/data/by/at) preserved. `watermark` is the seq to persist after broadcasting the batch.
 */
export function selectRoomEvents(rows, key, since, limit = RELAY_EVENT_BATCH) {
  const events = (rows || [])
    .map((r) => r.data || {})
    .filter((d) => d.room_key === key && Number(d.seq) > Number(since || 0))
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .slice(0, Math.max(1, Math.min(Number(limit) || RELAY_EVENT_BATCH, RELAY_EVENT_BATCH)))
    .map(({ room_key, ...e }) => ({ seq: Number(e.seq) || 0, type: e.type || "message", data: e.data ?? null, by: e.by ?? null, at: e.at ?? null }));
  const watermark = events.length ? Number(events[events.length - 1].seq) : Number(since || 0);
  return { events, watermark };
}

/**
 * The ONLY frame the relay broadcasts to clients: the room event exactly as the events op projects
 * it. It NEVER carries a participant identity beyond the event's own `by` field, a session, a
 * token or any credential.
 */
export function relayBroadcastEnvelope(event) {
  return { type: RT_EVENT_MSG, event: { seq: Number(event?.seq) || 0, type: event?.type || "message", data: event?.data ?? null, by: event?.by ?? null, at: event?.at ?? null } };
}