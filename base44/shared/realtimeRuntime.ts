// THE realtime surface of a DEPLOYED application (E8 parity).
//
//   deployed artifact → actor definition → room/session identity → state / events / presence
//
// This is an ADAPTER, not a second engine. Every mechanism it uses already exists and is used
// unchanged:
//   rooms / state / events / presence ... shared/actorRuntime.ts (the SAME AppRecord-backed store
//                                        the builder surface uses — no second state store)
//   sandboxed execution ................ shared/actorRuntime.invokeActor → the existing interpreter
//   end-user identity .................. shared/appAuth's verified session (resolved by the caller)
//   project scope ...................... the project resolved from the public slug/hostname by the
//                                        production runtime; this module never widens it
//   rls / ownership .................... shared/rls + createServerDb, inside actorRuntime
//
// What this module adds is exactly the missing half: the authorization + identity decision for an
// ANONYMOUS production caller, and dispatch to the existing runtime. Room identity, state shape,
// event sequencing and presence semantics are byte-for-byte the builder's, so preview and
// production describe the same room through the same contract.
import { anyEntityRls } from "./rls.ts";
import {
  connectActor, disconnectActor, invokeActor, roomEvents, roomSnapshot, signalActor,
  actorError, roomKey, sessionKey,
} from "./actorRuntime.ts";

export { roomKey, sessionKey };

export const REALTIME_OPS = ["list", "connect", "disconnect", "send", "events", "state", "signal"];

/** Guest participant grammar. Bounded, so a caller-supplied label can never shape a room key. */
const GUEST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

const realtimeError = (code, message, status = 400, details = {}) =>
  Object.assign(new Error(String(message)), { name: "RealtimeError", code, status, details });

/**
 * The participant identity of ONE realtime caller.
 *
 * A verified end-user's identity is DERIVED from the session, never from the request body, so one
 * end-user can never act as another. A guest label is accepted only when the app does not enforce
 * identity at all, and is namespaced so it can never collide with a real user's identity.
 */
export function realtimeParticipant(user, requested = null) {
  if (user) return `user:${user.id}`;
  const label = String(requested ?? "").trim();
  if (!label) return "anonymous";
  if (!GUEST_RE.test(label)) throw realtimeError("REALTIME_PARTICIPANT_INVALID", `'${label}' is not a valid participant label`, 400);
  return `guest:${label}`;
}

/**
 * Whether this deployment enforces end-user identity. The SAME rule the runtime's data path
 * already uses (legacy owner isolation, or any deployed entity declaring its own rules), so
 * realtime introduces no second notion of "this app has users".
 */
export const realtimeIdentityRequired = (project, entities) => !!project.rls_enabled || anyEntityRls(entities || []);

/**
 * Handles ONE realtime operation for a live deployment.
 *
 * `payload` is the immutable artifact's payload — so the actor definition and source executed in
 * production come from what was built and verified, never from the project's mutable working files.
 */
export async function handleRealtimeRuntime(svc, { project, payload, user = null, op, args = {} } = {}) {
  const operation = String(op || "");
  if (!REALTIME_OPS.includes(operation)) {
    throw realtimeError("REALTIME_BAD_OPERATION", `Unsupported realtime operation '${operation}' (${REALTIME_OPS.join(", ")})`, 400);
  }
  const actors = payload?.actors || [];

  if (operation === "list") {
    return {
      count: actors.length,
      actors: actors.map((a) => ({ name: a.name, access: a.access, persist: a.persist, events: a.events, description: a.description || "" })),
    };
  }

  // Identity gate. An app that enforces identity refuses an unauthenticated realtime caller
  // BEFORE any room, state or event is touched.
  if (realtimeIdentityRequired(project, payload?.entities) && !user) {
    throw realtimeError("REALTIME_AUTH_REQUIRED", "Sign in required", 401);
  }

  const name = String(args.actor || "");
  const definition = actors.find((a) => a.name === name);
  if (!definition) {
    throw actorError("ACTOR_NOT_FOUND", `Actor "${name}" is not part of this deployment`, 404, { actor: name });
  }
  const room = String(args.room ?? "");
  const participant = realtimeParticipant(user, args.participant);

  if (operation === "events") return roomEvents(svc, project.id, definition.name, room, { since: Number(args.since) || 0, limit: Number(args.limit) || 50 });
  if (operation === "state") return roomSnapshot(svc, project.id, definition.name, room);
  // signal: ephemeral collaboration presence (cursor/selection), riding the SAME identity gate,
  // actor resolution, room validation and participant derivation as every op above. It routes to
  // the EXISTING certified signalActor primitive — the identical contract the builder control
  // plane (actorInvoke op "signal") serves: presence on the participant's room connection, never
  // an event, never a sequence bump, nothing persisted beyond the connection entry.
  if (operation === "signal") {
    return signalActor(svc, project.id, definition.name, room, { participant, cursor: args.cursor ?? null, selection: args.selection ?? null });
  }
  if (operation === "connect") return connectActor(svc, project.id, definition.name, room, { participant, events: definition.events });
  if (operation === "disconnect") return disconnectActor(svc, project.id, definition.name, room, { participant, events: definition.events });

  // send: one message against one room. A malformed message is refused deterministically rather
  // than handed to the actor's handler.
  const message = args.message ?? null;
  if (message !== null && (typeof message !== "object" || Array.isArray(message))) {
    throw realtimeError("REALTIME_MESSAGE_INVALID", "A realtime message must be an object", 400);
  }
  return invokeActor(svc, {
    project, entities: payload?.entities || [], actor: definition, source: definition.source,
    room, message, user, participant,
  });
}