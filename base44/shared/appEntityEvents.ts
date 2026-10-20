// The DOCUMENTED entities.subscribe event path (bounded poll, NEXUSAI-derived visibility).
// Moved verbatim from appData.ts (re-exported there for backward compatibility).
// Storage is the SAME AppRecord primitive under a reserved internal namespace — no new entity.
import { gateFor } from "./rls.ts";
import { fieldReadPlan, filterEventData } from "./fieldRls.ts";
import { captureAfterWrite } from "./dataHistory.ts";
import { dbError } from "./appRecordValidation.ts";

export const ENTITY_EVENTS_ENTITY = "__entity_events";
export const ENTITY_EVENT_LIMITS = { MAX_READ: 100, DEFAULT: 50 };

const nowIso = () => new Date().toISOString();

/** Appends ONE entity event. Fail-safe: an event failure NEVER breaks the write it describes. */
export async function emitEntityEvent(client, projectId, entityName, type, item, owner = null) {
  try {
    const record = {
      project_id: projectId, entity_name: ENTITY_EVENTS_ENTITY,
      data: { entity: entityName, record_id: item.id, type, data: item, at: nowIso() },
    };
    if (owner != null) record.owner_id = owner;
    await client.entities.AppRecord.create(record);
    // Data Version History: an automatic CRUD checkpoint rides every successful write
    // (fail-safe, burst-deduped — see dataHistory.ts).
    await captureAfterWrite(client, projectId, entityName);
  } catch { /* fail-safe: the write already succeeded */ }
}

/**
 * The events read the client's bounded subscribe poll rides. Visibility mirrors the read path:
 * the caller's own events under legacy RLS, all events on an open project, NO events for an
 * entity with a non-open declarative read rule (fail-closed).
 */
export async function readEntityEvents(client, projectId, entities, { rls = false, user = null, fieldRules = false } = {}, { entity, after = null, limit } = {}) {
  const def = (entities || []).find((e) => e && e.name === String(entity || ""));
  if (!def) {
    throw dbError("DATABASE_ENTITY_NOT_FOUND", `Unknown entity "${entity}". Declared entities: ${(entities || []).map((e) => e.name).join(", ") || "none"}`, { entity: String(entity || "") });
  }
  const gate = gateFor(def, "read", user || null);
  if (!gate.open) return { events: [], after: null };
  if (rls && !user?.id) throw Object.assign(new Error("Sign in required"), { status: 401, code: "AUTH_REQUIRED" });
  const svc = client.asServiceRole || client;
  const fplan = fieldRules === true ? fieldReadPlan(def, user || null) : null;
  const want = Math.min(Math.max(Number(limit) || ENTITY_EVENT_LIMITS.DEFAULT, 1), ENTITY_EVENT_LIMITS.MAX_READ);
  const query = {
    project_id: projectId, entity_name: ENTITY_EVENTS_ENTITY,
    ...(rls ? { owner_id: user.id } : {}),
    ...(after ? { created_date: { $gte: after } } : {}),
  };
  const rows = await svc.entities.AppRecord.filter(query, "created_date", want, 0).catch(() => []);
  const events = rows
    .filter((r) => (r.data || {}).entity === def.name && ["create", "update", "delete"].includes((r.data || {}).type))
    .map((r) => ({ event_id: r.id, at: r.created_date, id: (r.data || {}).record_id, type: (r.data || {}).type, data: fplan ? filterEventData(fplan, (r.data || {}).data, r.owner_id) : (r.data || {}).data }))
    // R-7 Phase 3: an event whose field rules cannot be evaluated safely is dropped.
    .filter((ev) => ev.data !== null || !fplan);
  return { events, after: events.length ? events[events.length - 1].at : (after || null) };
}