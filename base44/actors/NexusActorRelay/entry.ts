// THE transport relay for generated-app Actor rooms (NEXUSAI): ONE platform Durable Object
// instance per (project, actor, room) that pushes the room's certified event stream to connected
// host pages over a persistent WebSocket.
//
// TRANSPORT ONLY, by contract:
//   • it executes NO actor handler — execution stays on the certified actorInvoke/appRuntime path
//     (identity, capability gates, RLS and participant derivation are unchanged there);
//   • it authorizes nothing itself — admission is existence-based: the room must already exist in
//     the project's __actor_rooms store, created by the certified connect path;
//   • it is DOWNSTREAM-only: client messages other than the bounded rt:sub are ignored, so no
//     socket path can mutate a room;
//   • it carries NO credential: the host page owns the socket and never receives one to hold.
import { Actor } from "base44:runtime/actors";
import {
  RT_SUB_MSG, PUMP_WAKE_KEY, PUMP_CADENCE_MS,
  RELAY_ROOM_SCAN, RELAY_EVENT_SCAN, RELAY_EVENT_BATCH,
  parseRelayRoomKey, roomExistsInScan, selectRoomEvents, relayBroadcastEnvelope,
} from "../../shared/realtimeWsRelay.ts";

const roomKeyOf = (k) => `${k.actor}:${k.room}`;

export default class NexusActorRelay extends Actor {
  since = 0; // high-water mark of events BROADCAST — monotonic, persisted
  key = null; // this instance's parsed (project, actor, room)
  pumping = false; // one pump at a time (connect + wake overlap guard)
  initialized = false; // whether this instance has ever admitted a room

  async handleStart() {
    // Any wake (deploy restart, idle, hibernation): rehydrate the watermark AND the room identity
    // — a hibernation wake keeps sockets ATTACHED without re-running handleConnect, so the pump
    // must be able to resume for them.
    this.since = Number(await this.storage.get("since")) || 0;
    const savedKey = parseRelayRoomKey(await this.storage.get("key"));
    this.key = savedKey;
    this.initialized = !!savedKey;
    this.pumping = false;
    if (this.getConnections().length > 0 && this.key) this.pumpNow();
  }

  async handleConnect(conn) {
    // Downstream-only: the host page proves nothing until it sends its bounded rt:sub. An
    // unproven connection simply waits — the host's client falls back to the certified poll if
    // the room never acks.
  }

  async handleMessage(conn, msg) {
    if (!msg || typeof msg !== "object" || msg.type !== RT_SUB_MSG) return; // downstream-only
    const parsed = parseRelayRoomKey(msg.key);
    if (!parsed) { conn.reject(4004, "invalid room"); return; }
    // Admission: the room must EXIST (the certified connect path created it). One bounded scan.
    const svc = this.client.asServiceRole;
    const rows = await svc.entities.AppRecord
      .filter({ project_id: parsed.project_id, entity_name: "__actor_rooms" }, "-created_date", RELAY_ROOM_SCAN)
      .catch(() => []);
    const key = roomKeyOf(parsed);
    const row = (rows || []).find((r) => (r.data || {}).room_key === key);
    if (!row) { conn.reject(4004, "room not found"); return; }
    this.key = parsed;
    await this.storage.put("key", msg.key);
    if (!this.initialized) {
      // First ever sub in this instance: start from the room's CURRENT sequence, so no ancient
      // history is replayed; every client dedupes by its own seq anyway.
      this.since = Math.max(this.since, Number((row.data || {}).seq) || 0);
      await this.storage.put("since", this.since);
      this.initialized = true;
    }
    conn.send({ type: "rt:hello", since: this.since });
    this.pumpNow();
  }

  async pumpNow() {
    if (this.pumping || !this.key) return;
    this.pumping = true;
    try {
      const svc = this.client.asServiceRole;
      const rows = await svc.entities.AppRecord
        .filter({ project_id: this.key.project_id, entity_name: "__actor_events" }, "-created_date", RELAY_EVENT_SCAN)
        .catch(() => []);
      const { events, watermark } = selectRoomEvents(rows, roomKeyOf(this.key), this.since, RELAY_EVENT_BATCH);
      for (const ev of events) {
        try { this.broadcast(relayBroadcastEnvelope(ev)); } catch { break; }
        this.since = Number(ev.seq) || this.since;
      }
      if (events.length) await this.storage.put("since", this.since);
    } finally { this.pumping = false; }
    // Keep the pump alive while ANY client is attached; the last client leaving lets the next
    // scheduled wake be the final one, after which the room hibernates.
    if (this.getConnections().length > 0) this.schedule(PUMP_WAKE_KEY, Date.now() + PUMP_CADENCE_MS);
  }

  async handleWake(key) {
    if (key === PUMP_WAKE_KEY) await this.pumpNow();
  }

  async handleClose(conn) {
    // Nothing to persist — membership is derived from live sockets, exactly like the certified
    // runtime's presence (a stale-collaborator prune rides reads, not a sweeper).
  }
}