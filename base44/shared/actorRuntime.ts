// THE stateful actor RUNTIME (E8) — the execution half of the actor primitive.
//
//   actor resource → resolve → room/session identity → invoke → persist state → emit events
//
// Everything here is built on infrastructure that already exists, and deliberately adds no second
// engine of any kind:
//   sandbox      → shared/jsInterp, through the SAME loader a backend function uses
//                  (readFunctionConfig), so an actor is interpreted by ONE interpreter
//   project data → shared/appData's createServerDb, so an actor reads and writes the project's own
//                  records under the project's own rules (RLS included) and nothing else
//   room state   → the EXISTING project data primitive (AppRecord) under reserved internal entity
//                  namespaces, so state travels with the project like every other runtime surface
//   authorization→ NOT here. The control-plane surface authorizes through the existing authz/rbac
//                  path using the capability the actor resource declares; this module trusts its
//                  caller's already-resolved project and never widens it.
//
// NexusAI's collaboration layer (shared/collaboration.ts) is untouched: it coordinates BUILDER
// edits to a project, while an actor is a per-room runtime surface of the generated app. Realtime
// delivery reuses the platform's existing pull-based event model — an append-only, monotonically
// sequenced room stream a client reads with `since` — rather than introducing a socket transport
// the platform does not have.
import { readFunctionConfig } from "./functionRuntime.ts";
import { createServerDb } from "./appData.ts";
import { unpackFileContent } from "./blobStore.ts";
import { parseActorDocument, actorFilePath, ACTOR_NAME_RE } from "./actorResource.ts";

/** Reserved internal data namespaces. Not project entities — a project cannot declare these. */
export const ACTOR_ROOMS_ENTITY = "__actor_rooms";
export const ACTOR_EVENTS_ENTITY = "__actor_events";

export const ACTOR_LIMITS = {
  MAX_STATE_CHARS: 20000,
  MAX_MESSAGE_CHARS: 10000,
  MAX_CONNECTIONS: 50,
  MAX_EVENTS_READ: 200,
  MAX_ROOM_SCAN: 500,
  MAX_STEPS: 400000,
  TIMEOUT_MS: 10000,
};

/** Room identity grammar. A room id is caller-supplied, so it is bounded and validated. */
export const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const actorError = (code, message, status = 400, details = {}) =>
  Object.assign(new Error(String(message)), { name: "ActorError", code, status, details });

/** The deterministic identity of ONE room: its actor + its room id. Same inputs, same room. */
export const roomKey = (actor, room) => `${actor}:${room}`;
/** The deterministic identity of ONE session: one room + one participant. A reconnect rejoins it. */
export const sessionKey = (actor, room, participant) => `${roomKey(actor, room)}#${participant || "anonymous"}`;

const nowIso = () => new Date().toISOString();

function assertRoom(actorName, room) {
  if (!ACTOR_NAME_RE.test(String(actorName || ""))) throw actorError("ACTOR_INVALID_NAME", `'${actorName}' is not a valid actor name`, 400);
  if (!ROOM_ID_RE.test(String(room || ""))) throw actorError("ACTOR_ROOM_INVALID", `'${room}' is not a valid room id`, 400, { room });
}

/**
 * Resolves ONE actor from the project's own files, by EXACT canonical path — so no entity schema,
 * frontend file or backend function can ever be resolved as an actor.
 */
export async function loadProjectActor(client, projectId, name) {
  if (!ACTOR_NAME_RE.test(String(name || ""))) throw actorError("ACTOR_INVALID_NAME", `'${name}' is not a valid actor name`, 400);
  const path = actorFilePath(name);
  const rows = await client.entities.ProjectFile.filter({ project_id: projectId, path }, "path", 1);
  if (!rows.length) throw actorError("ACTOR_NOT_FOUND", `Actor "${name}" does not exist in this project`, 404, { actor: name, path });
  const source = await unpackFileContent(rows[0]);
  const parsed = parseActorDocument(path, source);
  if (!parsed.ok) throw actorError("ACTOR_INVALID", `${path} ${parsed.error}`, 400, { actor: name, path, ...(parsed.details || {}) });
  return { actor: parsed.actor, source, record: rows[0] };
}

const svcOf = (client) => client.asServiceRole || client;

/** The room record, or null. Scanned in one bounded read — `data.*` is not server-filterable. */
async function findRoom(svc, projectId, key) {
  const rows = await svc.entities.AppRecord.filter({ project_id: projectId, entity_name: ACTOR_ROOMS_ENTITY }, "-created_date", ACTOR_LIMITS.MAX_ROOM_SCAN).catch(() => []);
  return rows.find((r) => (r.data || {}).room_key === key) || null;
}

/** The room, created on first touch. A room's existence is an implementation detail of invoking it. */
export async function ensureRoom(client, projectId, actorName, room) {
  assertRoom(actorName, room);
  const svc = svcOf(client);
  const key = roomKey(actorName, room);
  const existing = await findRoom(svc, projectId, key);
  if (existing) return existing;
  return svc.entities.AppRecord.create({
    project_id: projectId, entity_name: ACTOR_ROOMS_ENTITY,
    data: { room_key: key, actor: actorName, room: String(room), state: {}, connections: {}, seq: 0, invocations: 0, created_at: nowIso(), updated_at: nowIso() },
  });
}

/** Appends ONE event to the room's monotonic stream. The sequence is the room's, never a clock. */
async function appendEvent(svc, projectId, key, seq, event) {
  await svc.entities.AppRecord.create({
    project_id: projectId, entity_name: ACTOR_EVENTS_ENTITY,
    data: { room_key: key, seq, type: String(event.type || "message"), data: event.data ?? null, by: event.by || null, at: nowIso() },
  });
}

/** The room's events after `since`, in sequence order — the realtime read a client polls. */
export async function roomEvents(client, projectId, actorName, room, { since = 0, limit = 50 } = {}) {
  assertRoom(actorName, room);
  const svc = svcOf(client);
  const key = roomKey(actorName, room);
  const rows = await svc.entities.AppRecord.filter({ project_id: projectId, entity_name: ACTOR_EVENTS_ENTITY }, "-created_date", ACTOR_LIMITS.MAX_ROOM_SCAN).catch(() => []);
  const events = rows
    .map((r) => r.data || {})
    .filter((d) => d.room_key === key && Number(d.seq) > Number(since || 0))
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .slice(0, Math.min(Number(limit) || 50, ACTOR_LIMITS.MAX_EVENTS_READ))
    .map(({ room_key, ...e }) => e);
  return { actor: actorName, room: String(room), since: Number(since || 0), count: events.length, events };
}

const presenceOf = (row) => Object.values((row?.data || {}).connections || {}).sort((a, b) => String(a.session_id).localeCompare(String(b.session_id)));

/** The room's current state and participants. A read — nothing is created and nothing is executed. */
export async function roomSnapshot(client, projectId, actorName, room) {
  assertRoom(actorName, room);
  const row = await findRoom(svcOf(client), projectId, roomKey(actorName, room));
  if (!row) return { actor: actorName, room: String(room), exists: false, seq: 0, state: {}, connections: [] };
  const d = row.data || {};
  return { actor: actorName, room: String(room), exists: true, seq: Number(d.seq || 0), state: d.state || {}, connections: Object.values(pruneStaleSignals(d.connections || {})), invocations: Number(d.invocations || 0) };
}

/** Joins a session to a room. Presence is per (room, participant), so a reconnect is idempotent. */
export async function connectActor(client, projectId, actorName, room, { participant = null, events = true } = {}) {
  const row = await ensureRoom(client, projectId, actorName, room);
  const svc = svcOf(client);
  const d = row.data || {};
  const session_id = sessionKey(actorName, room, participant);
  const connections = { ...(d.connections || {}) };
  const isNew = !connections[session_id];
  if (isNew && Object.keys(connections).length >= ACTOR_LIMITS.MAX_CONNECTIONS) {
    throw actorError("ACTOR_ROOM_FULL", `Room '${room}' has reached its connection limit (${ACTOR_LIMITS.MAX_CONNECTIONS})`, 429, { room });
  }
  connections[session_id] = { session_id, participant: participant || null, joined_at: isNew ? nowIso() : connections[session_id].joined_at, last_seen_at: nowIso() };
  const seq = Number(d.seq || 0) + (isNew && events ? 1 : 0);
  await svc.entities.AppRecord.update(row.id, { data: { ...d, connections, seq, updated_at: nowIso() } });
  if (isNew && events) await appendEvent(svc, projectId, roomKey(actorName, room), seq, { type: "actor.join", data: { session_id }, by: participant || null });
  return { actor: actorName, room: String(room), session_id, joined: isNew, seq, connections: Object.values(connections).length };
}

/** Leaves a session. Leaving a session that is not present is a no-op, never an error. */
export async function disconnectActor(client, projectId, actorName, room, { participant = null, events = true } = {}) {
  assertRoom(actorName, room);
  const svc = svcOf(client);
  const key = roomKey(actorName, room);
  const row = await findRoom(svc, projectId, key);
  const session_id = sessionKey(actorName, room, participant);
  if (!row || !((row.data || {}).connections || {})[session_id]) return { actor: actorName, room: String(room), session_id, left: false };
  const d = row.data || {};
  const connections = { ...(d.connections || {}) };
  delete connections[session_id];
  const seq = Number(d.seq || 0) + (events ? 1 : 0);
  await svc.entities.AppRecord.update(row.id, { data: { ...d, connections, seq, updated_at: nowIso() } });
  if (events) await appendEvent(svc, projectId, key, seq, { type: "actor.leave", data: { session_id }, by: participant || null });
  return { actor: actorName, room: String(room), session_id, left: true, seq, connections: Object.values(connections).length };
}

/** Stale-collaborator visuals: a connection whose last signal is older than this is considered
 *  inactive. Its cursor/selection FIELDS are dropped (fail closed — the visuals disappear) but the
 *  connection itself is preserved so the existing presence avatar (which does not heartbeat
 *  last_seen_at) is unaffected. No scheduler/sweeper — pruning piggybacks on signal/state reads. */
export const SIGNAL_STALE_MS = 15000;
export const SIGNAL_LIMITS = { X_Y_MAX: 100000, VIEWPORT_MAX: 16, SELECTION_MAX: 128, ROUTE_MAX: 200 };

function pruneStaleSignals(connections, now = Date.now()) {
  const cutoff = now - SIGNAL_STALE_MS;
  const out = {};
  for (const [k, v] of Object.entries(connections || {})) {
    if (!v) { out[k] = v; continue; }
    const hasSignal = v.cursor || v.selection;
    if (!hasSignal) { out[k] = v; continue; }
    const seen = v.last_seen_at ? Date.parse(v.last_seen_at) : NaN;
    if (Number.isFinite(seen) && seen < cutoff) {
      const rest = { ...v }; delete rest.cursor; delete rest.selection; out[k] = rest;
    } else out[k] = v;
  }
  return out;
}

function sanitizeSignalCursor(c) {
  if (!c || typeof c !== "object") throw actorError("ACTOR_SIGNAL_INVALID", "cursor must be an object", 400);
  const x = Number(c.x), y = Number(c.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > SIGNAL_LIMITS.X_Y_MAX || y > SIGNAL_LIMITS.X_Y_MAX) {
    throw actorError("ACTOR_SIGNAL_INVALID", "cursor x/y out of range", 400);
  }
  const viewport = String(c.viewport ?? "desktop").slice(0, SIGNAL_LIMITS.VIEWPORT_MAX);
  return { x, y, viewport, t: Number.isFinite(Number(c.t)) ? Number(c.t) : Date.now() };
}

function sanitizeSignalSelection(s) {
  if (!s || typeof s !== "object") throw actorError("ACTOR_SIGNAL_INVALID", "selection must be an object", 400);
  const route = String(s.route ?? "").slice(0, SIGNAL_LIMITS.ROUTE_MAX);
  const elementId = String(s.elementId ?? "").slice(0, SIGNAL_LIMITS.SELECTION_MAX);
  if (!route || !elementId) throw actorError("ACTOR_SIGNAL_INVALID", "selection requires route and elementId", 400);
  return { route, elementId, t: Number.isFinite(Number(s.t)) ? Number(s.t) : Date.now() };
}

/** Ephemeral collaboration SIGNAL (cursor/selection). Overwrites the participant's latest cursor
 *  and/or selection on their EXISTING room connection entry — does NOT append to __actor_events,
 *  does NOT change the room sequence, persists nothing beyond the connection. Authorized at
 *  project.read (same as presence observe): a cursor is presence, not a mutation. Stale signal
 *  fields on OTHER connections are pruned on the same write (fail closed, no sweeper). */
export async function signalActor(client, projectId, actorName, room, { participant = null, cursor = null, selection = null } = {}) {
  assertRoom(actorName, room);
  const svc = svcOf(client);
  const row = await ensureRoom(client, projectId, actorName, room);
  const d = row.data || {};
  const session_id = sessionKey(actorName, room, participant);
  const connections = pruneStaleSignals(d.connections || {});
  const cur = connections[session_id] || { session_id, participant: participant || null, joined_at: nowIso() };
  const next = { ...cur, participant: participant || cur.participant || null, last_seen_at: nowIso() };
  if (cursor !== null) next.cursor = sanitizeSignalCursor(cursor);
  if (selection !== null) next.selection = sanitizeSignalSelection(selection);
  connections[session_id] = next;
  await svc.entities.AppRecord.update(row.id, { data: { ...d, connections, updated_at: nowIso() } });
  return { actor: actorName, room: String(room), session_id, ok: true };
}

/**
 * Invokes ONE message against ONE room.
 *
 * The actor's handler runs in the existing sandbox with a context carrying the room's persisted
 * state, the room/session identity, the project's own data accessor and the authenticated caller.
 * What it returns is applied deterministically: `state` replaces the room's state (bounded), `reply`
 * answers this caller only, and `broadcast` becomes the next event in the room's stream.
 *
 * The caller has ALREADY been authorized for `project` — this module never resolves permissions.
 */
export async function invokeActor(client, { project, entities = [], actor, source, room, message = null, user = null, participant = null }) {
  const actorName = actor?.name || actor;
  assertRoom(actorName, room);
  const svc = svcOf(client);
  const projectId = project.id;

  let definition = actor;
  let code = source;
  if (!definition?.name || code === undefined) {
    const loaded = await loadProjectActor(svc, projectId, actorName);
    definition = loaded.actor;
    code = loaded.source;
  }

  const payload = message == null ? null : message;
  if (payload !== null && JSON.stringify(payload).length > ACTOR_LIMITS.MAX_MESSAGE_CHARS) {
    throw actorError("ACTOR_MESSAGE_TOO_LARGE", `A message may not exceed ${ACTOR_LIMITS.MAX_MESSAGE_CHARS} characters`, 400);
  }

  let loaded;
  try {
    loaded = await readFunctionConfig(code, { maxSteps: ACTOR_LIMITS.MAX_STEPS, timeoutMs: ACTOR_LIMITS.TIMEOUT_MS });
  } catch (e) {
    throw actorError("ACTOR_LOAD_FAILED", `Actor "${definition.name}" failed to load: ${e.message}`, 500, { actor: definition.name });
  }
  if (typeof loaded.handler !== "function") {
    throw actorError("ACTOR_INVALID", `Actor "${definition.name}" has no default export handler`, 400, { actor: definition.name });
  }

  const row = await ensureRoom(svc, projectId, definition.name, room);
  const d = row.data || {};
  const key = roomKey(definition.name, room);
  const session_id = sessionKey(definition.name, room, participant || user?.id || null);
  const logs = [];

  const ctx = {
    message: payload,
    state: JSON.parse(JSON.stringify(d.state || {})),
    room: {
      id: String(room), key, actor: definition.name, session_id,
      seq: Number(d.seq || 0), connections: presenceOf(row),
    },
    user: user ? { id: user.id, email: user.email || null } : null,
    db: createServerDb(svc, projectId, entities, { rls: !!project.rls_enabled, user, fieldRules: true }),
    log: (...args) => { logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ").slice(0, 500)); },
  };

  let result;
  try {
    result = await loaded.handler(ctx);
  } catch (e) {
    const inner = e?.value && typeof e.value === "object" ? e.value : e;
    throw actorError("ACTOR_HANDLER_FAILED", `Actor "${definition.name}" failed: ${inner?.message || String(e)}`, 500, { actor: definition.name, room: String(room) });
  }

  const out = result && typeof result === "object" ? result : {};
  const nextState = definition.persist ? ("state" in out ? out.state ?? {} : ctx.state) : {};
  const serialized = JSON.stringify(nextState ?? {});
  if (serialized.length > ACTOR_LIMITS.MAX_STATE_CHARS) {
    throw actorError("ACTOR_STATE_TOO_LARGE", `Actor "${definition.name}" room state may not exceed ${ACTOR_LIMITS.MAX_STATE_CHARS} characters`, 400, { actor: definition.name, bytes: serialized.length });
  }

  const emit = definition.events;
  const seq = Number(d.seq || 0) + (emit ? 1 : 0);
  await svc.entities.AppRecord.update(row.id, {
    data: { ...d, state: JSON.parse(serialized), seq, invocations: Number(d.invocations || 0) + 1, updated_at: nowIso() },
  });
  if (emit) {
    await appendEvent(svc, projectId, key, seq, {
      type: out.broadcast?.type || payload?.type || "message",
      data: "broadcast" in out ? (out.broadcast?.data ?? out.broadcast ?? null) : (payload?.data ?? payload),
      by: participant || user?.id || null,
    });
  }

  return {
    ok: true, actor: definition.name, room: String(room), session_id,
    seq, state: JSON.parse(serialized),
    reply: "reply" in out ? out.reply : null,
    broadcast: "broadcast" in out ? out.broadcast : null,
    logs: logs.slice(-20),
  };
}