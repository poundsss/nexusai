// B-stage certification suite: `entities.subscribe` — the DOCUMENTED Realtime SDK contract.
//
// DOCUMENTED (docs.base44.com SDK reference `entities`): every entity handler has
// subscribe(callback) → unsubscribe function; the callback receives { id, type, data, timestamp }
// with type = create|update|delete, id the RECORD's id and timestamp the event's own time
// (upstream 0.8.51 RealtimeEvent: { type, data, id, timestamp }) passed through when provided.
//
// NEXUSAI-derived, explicitly NOT parity: the transport is a bounded client poll over the
// events read (readEntityEvents) — the documented WebSocket/instant transport is NOT claimed;
// ordering/replay/reconnect guarantees are UNKNOWN and not claimed; service-role subscribe,
// FLS/hidden-field filtering and delete-payload semantics are UNKNOWN — the delete payload here
// is this platform's own bounded choice (the pre-delete record projection), and visibility is
// fail-closed wherever the docs publish nothing.
//
// The suite drives the REAL createServerDb write paths (the single funnel every surface —
// deployed runtime, preview, backend functions — writes through) and the REAL readEntityEvents,
// plus a MIRROR of the client bridge (keep in sync with runtimeSource.js). The certified actor
// realtime rooms (E8) and agents.subscribeToConversation (A-stage) are untouched, separate
// surfaces.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb, readEntityEvents, ENTITY_EVENTS_ENTITY } from "../../shared/appData.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// The certified contract, stated explicitly so the suite pins its own certification boundary.
const SUBSCRIBE_CONTRACT = {
  transport: "bounded-poll-4s",
  transport_parity: "NEXUSAI-derived substitute — the documented WebSocket/instant transport is NOT claimed (non-parity)",
  callback: "documented event object { id, type, data, timestamp } — id is the RECORD's id; timestamp is the event's own time, passed through when provided",
  ordering: "UNKNOWN — not claimed",
  reconnect_replay: "UNKNOWN — client cursor only, not claimed",
  service_role_subscribe: "UNKNOWN — not exposed on the backend accessor (fail-closed)",
  fls_hidden_fields: "UNKNOWN — not filtered (fail-closed visibility rules apply instead)",
  delete_payload: "NEXUSAI-derived bounded choice — the pre-delete record projection (non-parity)",
};

// MIRROR of the db proxy's `subscribe` in src/lib/runtime/runtimeSource.js (keep in sync). The
// ONLY adaptation: poll ticks are driven explicitly by the suite instead of setInterval(4000).
function mirrorSubscribe(eventsRead, onUpdate) {
  let stopped = false, after = null, reads = 0;
  const seen = new Set();
  const callbacks = [];
  const poll = async () => {
    if (stopped) return;
    let r;
    try { reads++; r = await eventsRead(after); } catch (e) { return; }  // transient: skip tick, keep polling
    if (stopped) return;
    for (const ev of (r && r.events) || []) {
      if (seen.has(ev.event_id)) continue;
      seen.add(ev.event_id);
      after = ev.at;
      if (typeof onUpdate === 'function') onUpdate({ id: ev.id, type: ev.type, data: ev.data, ...(ev.at != null ? { timestamp: ev.at } : {}) });
      callbacks.push({ id: ev.id, type: ev.type, data: ev.data, ...(ev.at != null ? { timestamp: ev.at } : {}) });
    }
  };
  return { poll, unsubscribe: () => { stopped = true; }, get reads() { return reads; }, get callbacks() { return callbacks; } };
}

const ENTITIES = [
  { name: "Task", fields: { title: { type: "string" }, done: { type: "boolean" } } },
  { name: "Memo", fields: { body: { type: "string" } } },
  { name: "Ledger", fields: { owner: { type: "string" }, body: { type: "string" } }, rls: { create: true, read: { "data.owner": "{{user.id}}" }, update: true, delete: true } },
];

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const pace = (ms) => appAgentPace(ms || 400);

  try {
    const plan = await makeBillingPlan(db, created, `p911r${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911r${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911r");
    await grant(A.ws.id, "message", 50);
    await grant(A.ws.id, "integration", 50);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const P1 = await makeAgentProject(db, projectIds, A, stamp, "p911r");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p911r");
    const PR = await makeAgentProject(db, projectIds, A, stamp, "p911r");
    await db.entities.Project.update(PR.id, { rls_enabled: true });
    const userA1 = { id: `p911r_userA1_${stamp}`, email: "a1@p911r.test" };
    const userA2 = { id: `p911r_userA2_${stamp}`, email: "a2@p911r.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbR = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });

    // ---- 1. create / update / delete emit the DOCUMENTED event object -------------------
    const t1 = await db1.Task.create({ title: "first", done: false });
    await pace();
    const ev1 = await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task" });
    harness.check("create: emits exactly one event with the DOCUMENTED { id, type, data, timestamp } shape",
      ev1.events.length === 1 && ev1.events[0].id === t1.id && ev1.events[0].type === "create" && typeof ev1.events[0].at === "string"
        && ev1.events[0].data && ev1.events[0].data.title === "first" && ev1.events[0].data.id === t1.id,
      JSON.stringify(ev1));
    await db1.Task.update(t1.id, { done: true });
    await pace();
    const ev2 = await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task" });
    harness.check("update: emits an update event carrying the merged record projection",
      ev2.events.length === 2 && ev2.events[1].type === "update" && ev2.events[1].id === t1.id
        && ev2.events[1].data.done === true && ev2.events[1].data.title === "first",
      JSON.stringify({ count: ev2.events.length, second: ev2.events[1] && ev2.events[1].type }));
    await db1.Task.delete(t1.id);
    await pace();
    const ev3 = await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task" });
    harness.check("delete: emits a delete event with the pre-delete record projection (NexusAI-derived bounded choice)",
      ev3.events.length === 3 && ev3.events[2].type === "delete" && ev3.events[2].id === t1.id
        && ev3.events[2].data.title === "first" && ev3.events[2].data.done === true,
      JSON.stringify({ count: ev3.events.length }));

    // ---- 2. bulk and query-driven writes emit per record --------------------------------
    const bulk = await db1.Task.bulkCreate([{ title: "b1", done: false }, { title: "b2", done: false }]);
    await pace();
    await db1.Task.bulkUpdate(bulk.map((it) => ({ id: it.id, data: { done: true } })));
    await pace();
    await db1.Task.bulkDelete(bulk.map((it) => it.id));
    await pace();
    const prior = new Set(ev3.events.map((e) => e.event_id));
    const evB = (await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task", after: ev3.events[ev3.events.length - 1].at })).events
      .filter((e) => !prior.has(e.event_id));
    const counts = evB.events ? evB.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] || 0) + 1 }), {}) : evB.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] || 0) + 1 }), {});
    harness.check("bulk ops: emit one event per record (bulkCreate / bulkUpdate / bulkDelete)",
      evB.length === 6 && counts.create === 2 && counts.update === 2 && counts.delete === 2,
      JSON.stringify({ count: evB.length, counts }));

    const t2 = await db1.Task.create({ title: "where", done: false });
    await pace();
    await db1.Task.updateWhere({ title: "where" }, { done: true });
    await pace();
    await db1.Task.deleteWhere({ title: "where" });
    await pace();
    const evW = (await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task" })).events
      .filter((e) => e.id === t2.id).map((e) => e.type);
    harness.check("updateWhere/deleteWhere: route through the SAME per-record emission",
      evW.join(",") === "create,update,delete", JSON.stringify(evW));

    // ---- 3. entity isolation + unknown entity --------------------------------------------
    const m1 = await db1.Memo.create({ body: "memo row" });
    await db1.Ledger.create({ owner: "x", body: "ledger row" });
    await pace();
    const evTaskNow = await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task" });
    const evMemo = await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Memo" });
    harness.check("isolation: an entity's event read never includes another entity's records",
      evMemo.events.length === 1 && evMemo.events[0].id === m1.id
        && evTaskNow.events.every((e) => e.id !== m1.id && e.data.body === undefined),
      JSON.stringify({ memo: evMemo.events.length }));
    const unknown = await captureCall(() => readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Nope" }));
    harness.check("isolation: an entity outside the deployment is refused fail-closed",
      unknown.threw && unknown.code === "DATABASE_ENTITY_NOT_FOUND", JSON.stringify(unknown));

    // ---- 4. declarative read rule → fail-closed NO events (visibility UNKNOWN) -----------
    const ruleRead = await readEntityEvents(db, P1.id, ENTITIES, { user: { id: "x" } }, { entity: "Ledger" });
    harness.check("visibility (fail-closed): an entity with a non-open declarative read rule delivers NO events — per-subscriber semantics are UNKNOWN, nothing invented",
      ruleRead.events.length === 0, JSON.stringify(ruleRead));

    // ---- 5. legacy RLS: owner-scoped events, mirroring the read path ----------------------
    const rt1 = await dbR.Task.create({ title: "mine", done: false });
    await pace();
    const mine = await readEntityEvents(db, PR.id, ENTITIES, { rls: true, user: userA1 }, { entity: "Task" });
    const theirs = await readEntityEvents(db, PR.id, ENTITIES, { rls: true, user: userA2 }, { entity: "Task" });
    const anon = await captureCall(() => readEntityEvents(db, PR.id, ENTITIES, { rls: true, user: null }, { entity: "Task" }));
    harness.check("RLS: the owner sees their own record's events",
      mine.events.length === 1 && mine.events[0].id === rt1.id && mine.events[0].type === "create",
      JSON.stringify(mine));
    harness.check("RLS: another user's events are invisible (owner-scoped, mirroring the read path)",
      theirs.events.length === 0, JSON.stringify(theirs));
    harness.check("RLS: an anonymous events read is refused fail-closed",
      anon.threw && anon.code === "AUTH_REQUIRED" && anon.status === 401, JSON.stringify(anon));

    // ---- 6. cross-project isolation -------------------------------------------------------
    const evCrossBefore = await readEntityEvents(db, P2.id, ENTITIES, {}, { entity: "Task" });
    const tP2 = await db2.Task.create({ title: "p2", done: false });
    await pace();
    const evP2 = await readEntityEvents(db, P2.id, ENTITIES, {}, { entity: "Task" });
    const evP1 = await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task" });
    harness.check("isolation: a write emits only into ITS OWN project's event namespace",
      evCrossBefore.events.length === 0 && evP2.events.length === 1 && evP2.events[0].id === tP2.id
        && evP1.events.every((e) => e.id !== tP2.id),
      JSON.stringify({ p2: evP2.events.length, p1_has_p2: evP1.events.some((e) => e.id === tP2.id) }));

    // ---- 7. namespace purity: event rows never pollute entity reads, no recursive events ----
    const tasks = await db1.Task.filter({});
    const rawEvents = await db.entities.AppRecord.filter({ project_id: P1.id, entity_name: ENTITY_EVENTS_ENTITY }, "created_date", 200);
    harness.check("namespace: event rows live ONLY in the reserved __entity_events namespace — entity reads unchanged, no recursive emission",
      tasks.length === 0 && rawEvents.length >= 14
        && rawEvents.every((r) => ["Task", "Memo", "Ledger"].includes((r.data || {}).entity))
        && rawEvents.every((r) => (r.data || {}).entity !== ENTITY_EVENTS_ENTITY),
      JSON.stringify({ tasks: tasks.length, events: rawEvents.length }));

    // ---- 8. client bridge mirror: DOCUMENTED callback, cursor, dedupe, stop ------------------
    const seen2 = [];
    const sub2 = mirrorSubscribe((after) => readEntityEvents(db, P2.id, ENTITIES, {}, { entity: "Task", after }), (ev) => seen2.push(ev));
    await sub2.poll();
    harness.check("client bridge: the callback receives exactly the DOCUMENTED { id, type, data, timestamp } object",
      seen2.length === 1 && Object.keys(seen2[0]).sort().join(",") === "data,id,timestamp,type"
        && typeof seen2[0].timestamp === "string"
        && seen2[0].id === tP2.id && seen2[0].type === "create" && seen2[0].data.title === "p2",
      JSON.stringify(seen2.map((e) => Object.keys(e).sort())));
    await sub2.poll();
    const tP2b = await db2.Task.create({ title: "p2b", done: false });
    await pace();
    await sub2.poll();
    harness.check("client bridge: no callback on unchanged reads; a new write fires exactly its own event (cursor + event-id dedupe)",
      seen2.length === 2 && seen2[1].id === tP2b.id && seen2[1].type === "create" && seen2[1].data.title === "p2b",
      JSON.stringify({ count: seen2.length }));

    let failOnce = true;
    const seen3 = [];
    const sub3 = mirrorSubscribe(async (after) => {
      if (failOnce) { failOnce = false; throw new Error("transient"); }
      return readEntityEvents(db, P2.id, ENTITIES, {}, { entity: "Task", after });
    }, (ev) => seen3.push(ev));
    await sub3.poll();
    await sub3.poll();
    harness.check("client bridge: a transient read error skips the tick and polling continues (NexusAI-derived, non-parity)",
      seen3.length === 2 && sub3.reads === 2, JSON.stringify({ count: seen3.length, reads: sub3.reads }));

    let probeReads = 0;
    const probe = mirrorSubscribe(() => { probeReads++; return { events: [] }; }, (ev) => seen3.push(ev));
    probe.unsubscribe();
    await probe.poll();
    await probe.poll();
    harness.check("client bridge: after unsubscribe no read happens and no callback fires (stopped guard)",
      probeReads === 0 && seen3.length === 2, JSON.stringify({ probeReads, count: seen3.length }));

    // ---- 9. no billing side effects --------------------------------------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: the entity event path moves no credits in either pool",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);

    // ---- 10. certification boundary pinned ------------------------------------------------
    harness.check("transport: the bounded poll is certified as a NEXUSAI-derived NON-PARITY substitute (no WebSocket/instant claim)",
      SUBSCRIBE_CONTRACT.transport === "bounded-poll-4s" && SUBSCRIBE_CONTRACT.transport_parity.includes("NOT claimed (non-parity)"),
      JSON.stringify(SUBSCRIBE_CONTRACT));
    harness.check("unknown semantics: ordering, replay/reconnect, service-role subscribe, FLS and delete payload are NOT claimed as parity",
      SUBSCRIBE_CONTRACT.ordering.startsWith("UNKNOWN") && SUBSCRIBE_CONTRACT.reconnect_replay.startsWith("UNKNOWN")
        && SUBSCRIBE_CONTRACT.service_role_subscribe.startsWith("UNKNOWN") && SUBSCRIBE_CONTRACT.fls_hidden_fields.startsWith("UNKNOWN")
        && SUBSCRIBE_CONTRACT.delete_payload.includes("non-parity"),
      JSON.stringify(SUBSCRIBE_CONTRACT));
    harness.check("surface: the `db` export remains registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("db"), "db present");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911r-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911r" } }, "created_date", 200).catch(() => []);
    const pIds = [...new Set([...projectIds, ...scratchProjects.map((p) => p.id)])];
    const wIds = [...new Set([...wsIds, ...scratchWorkspaces.map((w) => w.id)])];
    if (pIds.length) {
      await db.entities.AppRecord.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.AppEntity.deleteMany({ project_id: { $in: pIds } }).catch(() => {});
      await db.entities.Project.deleteMany({ id: { $in: pIds } }).catch(() => {});
    }
    if (wIds.length) {
      await db.entities.CreditLedgerEntry.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.AIOperation.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Subscription.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.BillingEvent.deleteMany({ workspace_id: { $in: wIds } }).catch(() => {});
      await db.entities.Workspace.deleteMany({ id: { $in: wIds } }).catch(() => {});
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911r_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911r[0-9]+$" } }).catch(() => {});
  }
}