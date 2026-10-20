import { canonical, enforceOnWrite, enforceOnDelete } from "./relations.ts";
// THE row-level-security evaluator — the ONLY one. Declarative per-entity rules are compiled into
// gates here and evaluated against the record views it owns; no rule is interpreted in this file.
import { gateFor, recordView, pendingView } from "./rls.ts";
import { fieldReadPlan, assertQueryable, assertNoFieldRules, omitBlocked, fieldWritePlan, assertFieldsWritable, isFieldHidden } from "./fieldRls.ts";
// Phase B1: the records-mode page cursor (NEXUSAI-DERIVED token format — see the module).
import { mintPageCursor, verifyPageCursor } from "./appCursor.ts";
import { moveToTrash } from "./appTrash.ts";
import { persistEach } from "./appBulkPersist.ts";
// Data Version History: the edit pause (a running restore blocks writes to its entity) and
// automatic CRUD checkpoint capture ride this module's write path.
import { historyWriteGuard } from "./dataHistory.ts";
import { matches, sortItems } from "./appQuery.ts";
// Server-side, project-scoped data access for generated applications.
// The SAME storage the preview's client bridge uses (AppRecord rows keyed by
// project_id + entity_name) — backend functions get a server-side accessor, not a
// second database. Every operation is bound to one project id, so a function can
// never observe or mutate another project's records.
//
// SCALABLE QUERYING
// The storage layer (Base44 entity SDK over AppRecord) supports server-side:
//   • equality / $in / $ne / $gte / $lte filtering on TOP-LEVEL fields
//   • limit + skip (offset) pagination
//   • sort on top-level fields (created_date, updated_date, id)
// It does NOT support filtering or sorting on nested `data.*` fields, and there is
// no native count primitive. So the query plan is:
//   • Scope (project_id + entity_name) and RLS owner_id are top-level → pushed to
//     the server query. owner_id is a top-level indexed field on AppRecord for this.
//   • No app-field filter + top-level sort → FAST PATH: the server does filter,
//     sort, limit and skip. Only `limit` rows are loaded, regardless of dataset size.
//   • App-field filter (data.*) or data-field sort → STREAMING PATH: page through
//     storage in bounded batches (server-sorted by created_date), apply the data
//     filter in memory, and accumulate matches. One batch + the accumulated matches
//     are in memory at a time — never the whole dataset. A SAFETY_MAX ceiling bounds
//     in-memory sorts. This also removes the previous hard 1000-row blind spot.

// Split modules (R-7 follow-up refactor). Re-exported so existing imports stay stable.
import { toItem, dbError, validateRecord, makeProjection } from "./appRecordValidation.ts";
import { stableStringify, parseUpdateOperators, applyUpdateOperators, UPDATE_MANY_BATCH } from "./appUpdateOps.ts";
import { ENTITY_EVENTS_ENTITY, ENTITY_EVENT_LIMITS, emitEntityEvent, readEntityEvents } from "./appEntityEvents.ts";
export { toItem, dbError, validateRecord, ENTITY_EVENTS_ENTITY, ENTITY_EVENT_LIMITS, readEntityEvents };

// --- updateMany: the DOCUMENTED MongoDB-operator surface (Base44 SDK 0.8.51, PR #143) ------
//
// DOCUMENTED (SDK 0.8.51 — src/modules/entities.ts + entities.types.ts, added in PR #143 and
// unchanged through #287): updateMany(query, data) sends { query, data } VERBATIM over
// PATCH .../update-many; `data` is a MongoDB UPDATE OPERATOR document whose only documented
// operators are $set, $rename, $unset, $inc, $mul, $min, $max, $currentDate, $addToSet,
// $push, $pull; operators combine in one call but "each field may only appear in one
// operator"; the response is EXACTLY { success, updated, has_more }; "results are batched in
// groups of up to 500 — when has_more is true, call updateMany again with the same query to
// update the next batch"; no cursor/options exist on this surface. `bulkUpdate` (per-record
// updates, returns the records) is a DIFFERENT documented surface.
//
// NEXUSAI-derived / NON-PARITY — every server semantic the SDK does NOT pin is a bounded,
// fail-closed choice made here and nowhere claimed as Base44 behavior:
//   • query form ......... the typed query is Partial<T> (equality only); anything richer
//                          rides the EXISTING matches() machine — upstream acceptance of
//                          filter operators in an update-many query is UNKNOWN;
//   • batch selection .... the 500 LEAST-recently-updated matches (ascending updated_date).
//                          AppRecord.update bumps updated_date, so a repeated call with the
//                          SAME query advances to the next-oldest batch instead of
//                          re-selecting the rows it just wrote. The upstream progression
//                          mechanism is UNKNOWN; equal-updated_date ties at the batch
//                          boundary may re-order records (a batch is never dropped);
//   • has_more ........... a 1-row pre-update probe past the batch boundary;
//   • $currentDate ....... true and { $type: "date" | "timestamp" } all stamp the field with
//                          the server's current ISO-8601 instant (this platform's date fields
//                          are strings; the upstream value format is UNKNOWN);
//   • $inc/$mul .......... a missing/null field counts as 0 (Mongo semantics); a non-numeric
//                          existing value refuses the whole call;
//   • $min/$max .......... numeric comparison only (upstream comparability is UNKNOWN);
//                          missing/null sets the value; non-numeric existing refuses;
//   • array operators .... $push appends (the $each modifier is NOT documented and is
//                          refused), $pull removes JSON-equal elements, $addToSet appends
//                          only when JSON-unequal to every element; missing/null starts a
//                          new array for $push/$addToSet and is a no-op for $pull; a
//                          non-array existing value refuses;
//   • $rename/$unset ..... rename moves the value to another DECLARED field and removes the
//                          old name; unset removes the field — validateRecord then refuses
//                          the removal of a required field, fail-closed;
//   • updated counting ... every applied batch record counts as updated, even when the
//                          resulting value equals the old one (upstream UNKNOWN);
//   • atomicity .......... every gate, operator application, validation and relation check
//                          runs BEFORE the first persist (a refused call writes nothing);
//                          the persist loop itself is per-record like bulkUpdate — NOT
//                          all-or-nothing (upstream UNKNOWN);
//   • RLS/events .......... the EXISTING per-record update gate, legacy owner isolation,
//                          project isolation, relation enforcement and per-record entity
//                          events apply (upstream event behavior is UNKNOWN);
//   • error surface ...... structured DATABASE_VALIDATION_FAILED / DATABASE_RLS_DENIED;
//                          relation violations keep the relation machine's own code
//                          (e.g. FK_NOT_FOUND); unknown entity keeps the Proxy's
//                          DATABASE_ENTITY_NOT_FOUND
//                          (upstream 404 is proven only for list).
// Parsing/application lives in appUpdateOps.ts.

const TOP_SORT_KEYS = new Set(["created_date", "updated_date", "id"]);
const SAFETY_MAX = 10000;   // bound for streamed / in-memory-sorted queries
const STREAM_BATCH = 500;   // server-side page size while streaming
const MAX_BULK = 500;       // records per bulk write call
// DOCUMENTED (Base44 entities reference, list/filter): limit "Defaults to 50" and "The maximum
// limit is 5,000 items per request". BEHAVIOR CORRECTION (V2 query parity): the previous code
// used 10,000 for both — never certified against Base44. Response limits only — the streaming
// SAFETY_MAX bound, the events limits and every other ceiling are unchanged.
const READ_DEFAULT_LIMIT = 50;
const READ_MAX_LIMIT = 5000;

// --- B-stage: the DOCUMENTED entities.subscribe event path --------------------------------
//
// DOCUMENTED (docs.base44.com SDK reference `entities`): every entity handler has
// `subscribe(callback)` returning an unsubscribe function; the callback receives an event
// object `{ id, type, data }` where type is create/update/delete and id is the RECORD's id.
//
// NEXUSAI-derived, explicitly NOT parity (every UNKNOWN semantic below is fail-closed or
// bounded — never claimed as Base44 behavior):
//   • transport .... a bounded client poll over readEntityEvents — NOT the documented
//                    WebSocket; no instant-update, ordering or replay guarantee is claimed;
//   • visibility ... UNKNOWN in the docs. Bounded to mirror the read path: an entity with a
//                    non-open declarative read rule delivers NO events (fail-closed); a
//                    legacy-RLS project delivers only the caller's OWN record events
//                    (top-level owner_id, exactly like its reads); an open project delivers all;
//   • delete payload UNKNOWN. Bounded choice: the record projection as it existed before
//                    deletion, still only through the visibility rules above;
//   • emission ..... every createServerDb write emits per record (bulk ops per record);
//                    relation-maintenance writes (relStore) and reserved internal namespaces
//                    never emit. An event-append failure NEVER breaks the write it describes.
// Storage is the SAME AppRecord primitive under a reserved internal namespace (`__actor_events`
// pattern) — no new entity, no migration, no second event engine. Implementation:
// appEntityEvents.ts.

// Builds the `db` object handed to a generated backend function. `client` must be a
// service-role client (webhooks have no user), but scoping is enforced here, not by the caller.
//
// Row-level isolation (RLS): when `rls` is true, every record carries a top-level `owner_id`
// set to the authenticated end-user's id, and all reads/writes are restricted to that user.
// owner_id is a TOP-LEVEL field on AppRecord so the storage layer filters it server-side
// (the index for the per-user query path). Enforcement is HERE (server-side), never by
// trusting a frontend-supplied filter:
//   • create  — stamps owner_id = user.id; a caller-supplied owner_id is stripped and replaced
//   • filter  — adds owner_id = user.id to the SERVER query, so only the user's rows are paged
//   • get/update/delete — the record is returned/mutated only if its owner_id === user.id;
//     otherwise it is reported as "not found" so existence never leaks across users
//   • anonymous (no user) — every op is rejected with AUTH_REQUIRED before any data is touched
// `owner_id` is a system-managed field: stripped from user payloads before validation (so it
// is never subject to entity schema validation) and never reassignable via update.
// When `rls` is false (the default — the builder/preview path), behavior is open, shared,
// project-scoped data, but with scalable server-side pagination instead of the old 1000-row cap.
export function createServerDb(client, projectId, entities, { rls = false, user = null, fieldRules = false } = {}) {
  const known = entities.map((e) => e.name);
  const userId = user?.id || null;
  const requireUser = () => {
    if (rls && !userId) throw Object.assign(new Error("Sign in required"), { status: 401, code: "AUTH_REQUIRED" });
  };
  // owner_id is system-managed: strip it from any caller-supplied payload so it is never
  // validated against the entity schema and can never be forged or reassigned by the client.
  const stripOwner = (data) => { const { owner_id, ...rest } = data || {}; return rest; };
  // The user view handed to the evaluator for {{user.*}} templates and user_condition.
  const rlsUser = user || null;
  // A write refused by a declarative rule is a PERMISSION failure, distinct from "not found":
  // the caller may read the record but may not change it.
  const rlsCheck = (gate, view, entity, operation) => {
    if (gate.open) return;
    if (!gate.allows(view)) {
      throw Object.assign(
        dbError("DATABASE_RLS_DENIED", `Not permitted: ${operation} on ${entity}`, { entity, operation }),
        { status: 403 },
      );
    }
  };
  const defOf = (name) => {
    const def = entities.find((e) => e.name === name);
    if (!def) {
      throw dbError("DATABASE_ENTITY_NOT_FOUND", `Unknown entity "${name}". Declared entities: ${known.join(", ") || "none"}`, { entity: name, known_entities: known });
    }
    return def;
  };
  const owned = async (def, id) => {
    let r = null;
    try { r = await client.entities.AppRecord.get(id); } catch { r = null; }
    if (!r || r.project_id !== projectId || r.entity_name !== def.name) {
      throw dbError("DATABASE_RECORD_NOT_FOUND", `${def.name} record not found`, { entity: def.name, record_id: String(id) });
    }
    if (rls) {
      // owner_id is top-level (indexed). Legacy records created before this field may carry it
      // only inside data — accept either so a migration is not forced.
      const owner = r.owner_id != null ? r.owner_id : (r.data || {}).owner_id;
      if (owner !== userId) {
        throw dbError("DATABASE_RECORD_NOT_FOUND", `${def.name} record not found`, { entity: def.name, record_id: String(id) });
      }
    }
    return r;
  };

  // --- Relations / foreign keys ----------------------------------------------
  // Relation definitions live in AppRelation (project-scoped). They are loaded once
  // per request and enforced here, server-side, on top of the existing CRUD ops —
  // the query primitives (filter/sort/limit/skip) are unchanged. Fails open (no
  // relations → no enforcement) so existing apps keep their behavior when no
  // relations are defined or if the AppRelation read faults.
  let canonRelsPromise = null;
  const getCanonRels = () => {
    if (!canonRelsPromise) canonRelsPromise = client.entities.AppRelation
      .filter({ project_id: projectId }, "name", 200)
      .then((rows) => rows.map(canonical))
      .catch(() => []);
    return canonRelsPromise;
  };
  const relStore = {
    async getRef(refEntity, id) {
      let r; try { r = await client.entities.AppRecord.get(id); } catch { r = null; }
      if (!r || r.project_id !== projectId || r.entity_name !== refEntity) return null;
      if (rls) { const owner = r.owner_id != null ? r.owner_id : (r.data || {}).owner_id; if (owner !== userId) return null; }
      return r;
    },
    async findWithFk(fkEntity, fkField, refId, excludeId) {
      const q = rls ? { project_id: projectId, entity_name: fkEntity, owner_id: userId } : { project_id: projectId, entity_name: fkEntity };
      const out = []; let skip = 0;
      while (out.length < 1000) {
        const rows = await client.entities.AppRecord.filter(q, "-created_date", 500, skip);
        if (!rows.length) break;
        for (const r of rows) { const it = toItem(r); if (it[fkField] === refId && it.id !== excludeId) out.push(it); }
        skip += rows.length;
        if (rows.length < 500) break;
      }
      return out;
    },
    async nullFk(recordId, fkField) {
      const r = await client.entities.AppRecord.get(recordId).catch(() => null);
      if (!r || r.project_id !== projectId) return;
      const doc = { data: { ...(r.data || {}), [fkField]: null } };
      if (rls) doc.owner_id = r.owner_id != null ? r.owner_id : userId;
      await client.entities.AppRecord.update(recordId, doc);
    },
    async deleteRecord(recordId) { await client.entities.AppRecord.delete(recordId); },
    // R-7 Phase 3: relation errors go generic when the link field is hidden from this caller.
    isHidden(entityName, field) {
      if (fieldRules !== true) return false;
      const d = entities.find((x) => x.name === entityName);
      return !!d && isFieldHidden(fieldReadPlan(d, rlsUser), field);
    },
  };

  // Pipeline B compensation for bulk loops (best-effort, see appBulkPersist.ts). A created record
  // is removed again; an updated record is restored to its pre-write data ONLY if nobody changed
  // it since our write (updated_date guard) — a concurrent change is reported, never clobbered.
  const undoCreate = (entityName) => async (_p, item) => {
    await client.entities.AppRecord.delete(item.id);
    await emitEntityEvent(client, projectId, entityName, "delete", item, rls ? userId : null);
    return true;
  };
  const undoUpdate = (entityName) => async (p, item) => {
    const cur = await client.entities.AppRecord.get(p.r.id);
    if (!cur || String(cur.updated_date) !== String(item.updated_date)) return false;
    const doc = { data: p.r.data || {} };
    if (rls) doc.owner_id = p.r.owner_id != null ? p.r.owner_id : userId;
    const row = await client.entities.AppRecord.update(p.r.id, doc);
    await emitEntityEvent(client, projectId, entityName, "update", toItem(row), rls ? userId : null);
    return true;
  };

  const api = {};
  // Data Version History: every write op first passes the restore edit-pause (the documented
  // "editing pauses while a restore runs"); checkpoint capture rides emitEntityEvent above.
  const history = historyWriteGuard(client, projectId);
  for (const e of entities) {
    const base = { project_id: projectId, entity_name: e.name };
    // Compiled once per entity per request. An entity that declares no `rls` yields open gates,
    // so every path below behaves EXACTLY as it did before this layer existed.
    const gates = {
      read: gateFor(e, "read", rlsUser),
      create: gateFor(e, "create", rlsUser),
      update: gateFor(e, "update", rlsUser),
      delete: gateFor(e, "delete", rlsUser),
    };
    // One per-record read gate, used by every read path so filtering can never drift apart.
    const canRead = (row) => gates.read.open || gates.read.allows(recordView(row));
    // R-7 Phase 1: field read plan, only for opted-in (end-user) callers. null = no enforcement.
    const fplan = fieldRules === true ? fieldReadPlan(e, rlsUser) : null;
    const asItem = (r) => omitBlocked(fplan, toItem(r), r);
    // R-7 Phase 2: field write plan (same opt-in). Checked in each op's pre-write phase.
    const wplan = fieldRules === true ? fieldWritePlan(e, rlsUser) : null;
    api[e.name] = {
      list: async (sort, limit, skip, fields) => api[e.name].filter({}, sort, limit, skip, fields),
      filter: async (query, sort, limit, skip, fields) => {
        requireUser();
        const project = makeProjection(defOf(e.name), fields);
        const q = query || {};
        assertQueryable(fplan, { query: q, sort, fields, operation: "filter" });
        const hasDataFilter = Object.keys(q).length > 0;
        // '+'/'-' sort prefixes (Base44 SortField) normalize away for the top-key check; a
        // '+created_date' passes through to the platform filter, which documents '+' as ascending.
        const sortKey = String(sort || "-created_date").replace(/^[-+]/, "");
        const serverSortable = TOP_SORT_KEYS.has(sortKey);
        const serverSort = serverSortable ? (sort || "-created_date") : "-created_date";
        const want = Math.min(Number(limit) || READ_DEFAULT_LIMIT, READ_MAX_LIMIT);
        const offset = Math.max(0, Number(skip) || 0);
        // Server query: scope (+ RLS owner_id, a top-level indexed field).
        const serverQuery = rls ? { ...base, owner_id: userId } : { ...base };

        // A read rule of `false` yields nothing at all — no query is issued.
        if (gates.read.deny) return [];

        // FAST PATH — no app-field filter, sort on a top-level field AND no declarative read
        // rule: the storage layer filters, sorts, limits and skips. Only `want` rows load,
        // regardless of total dataset size. With a read rule present the streaming path below
        // is used instead, because the rule is evaluated per record.
        if (!hasDataFilter && serverSortable && gates.read.open) {
          const rows = await client.entities.AppRecord.filter(serverQuery, serverSort, want, offset);
          return project(rows.map(asItem));
        }

        // STREAMING PATH — a data-field filter (not server-filterable on this storage
        // layer) and/or a data-field sort. Page through storage in bounded batches
        // (server-sorted by created_date), filter in memory, accumulate matches until we
        // have offset+want or exhaust the set. Memory: one batch + accumulated matches.
        const collected = [];
        let batchSkip = 0;
        while (collected.length < offset + want) {
          const rows = await client.entities.AppRecord.filter(serverQuery, serverSort, STREAM_BATCH, batchSkip);
          if (!rows.length) break;
          for (const r of rows) {
            // The read gate is applied PER RECORD before the row is yielded, so paging can
            // never let an inaccessible record through.
            if (!canRead(r)) continue;
            const item = toItem(r);
            if (matches(item, q)) collected.push(omitBlocked(fplan, item, r));
          }
          batchSkip += rows.length;
          if (rows.length < STREAM_BATCH) break;       // exhausted
          if (collected.length >= SAFETY_MAX) break;    // bound in-memory work
        }
        const sorted = serverSortable ? collected : sortItems(collected, sort);
        return project(sorted.slice(offset, offset + want));
      },
      // --- records-mode v2/list page form (Phase B1) -------------------------------------------
      // DOCUMENTED (Base44 SDK 0.8.51 — the options-object overloads of list()/filter() and
      // EntityPage, which the public reference pages do not yet document): one cursor page
      // { items, next_cursor, has_more }. limit defaults to 100 and caps at 5,000 (SDK types);
      // sort/fields/q mirror the array form's semantics; the cursor "carries the query, sort
      // and fields of the walk" and "passing a different query, sort or fields with a cursor
      // is an error" (SDK JSDoc — enforced fail-closed below). `distinct` is NOT implemented
      // in this phase and is refused fail-closed. Token format, TTL, invalid-cursor behavior,
      // the mismatch error's code/status and the has_more edge at the 5,000 ceiling are
      // NEXUSAI-DERIVED / NON-PARITY (appCursor.ts). The page rides the EXISTING filter path:
      // read gate, RLS scoping, project isolation, fields projection and query matching are
      // that implementation's, untouched — every page is gated exactly like an array read.
      page: async (query, options) => {
        requireUser();
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name} page options must be an object`, { entity: e.name, operation: "page" });
        }
        // --- distinct mode (Phase B2) -------------------------------------------------------------
        // DOCUMENTED (Base44 SDK 0.8.51, options-object distinct): Entity.list({ distinct: field })
        // / Entity.filter(query, { distinct: field }) ride the SAME v2/list page transport and
        // return DISTINCT VALUES of `field` in ascending order — array fields contribute each
        // element separately; records are never returned, `items` holds the values; limit
        // defaults to 100 and caps at 1,000 (the SDK's distinct ceiling, distinct from the
        // records walk's 5,000); the cursor carries the walk's query + distinct field; a
        // query/field mismatch with the cursor fails closed; sort/fields are NOT part of a
        // distinct request and never affect the result (they are ignored, not errors).
        // NOT pinned by Base44 — every choice below is NEXUSAI-DERIVED / NON-PARITY:
        //   • null/undefined values are excluded from the result;
        //   • mixed-type ordering is numbers first (natural), then everything else by string
        //     comparison — no cross-type coercion is invented;
        //   • values are computed by a BOUNDED scan (10 × the 5,000-record read window) of the
        //     matched records; exceeding the bound is an explicit structured refusal
        //     (DATABASE_DISTINCT_SCAN_EXCEEDED, HTTP 400), never a silently partial answer;
        //   • a limit above 1,000 CLAMPS to 1,000 (mirroring the records walk's clamp);
        //   • a records-mode cursor is refused in distinct mode and vice versa: the distinct
        //     state carries no sort, the records state carries no distinct field, so the
        //     existing fail-closed comparisons catch every cross-mode token.
        if ("distinct" in options) {
          assertNoFieldRules(fplan, "distinct");
          const field = options.distinct;
          if (typeof field !== "string" || !field.trim()) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name} distinct requires a field name`, { entity: e.name, operation: "page" });
          }
          const q = query && typeof query === "object" && !Array.isArray(query) ? query : {};
          const rawLimit = Number(options.limit);
          const want = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100, 1000);
          let offset = 0;
          if (options.cursor !== undefined && options.cursor !== null && options.cursor !== "") {
            const state = await verifyPageCursor(options.cursor, { projectId, entity: e.name });
            if (state.distinct !== field || stableStringify(state.q) !== stableStringify(q)) {
              throw Object.assign(
                dbError("DATABASE_CURSOR_MISMATCH", "cursor does not match this request's query or distinct field", { entity: e.name, operation: "page" }),
                { status: 400 },
              );
            }
            offset = state.offset;
          }
          // Bounded scan of the matched records' field values (projection keeps each row tiny).
          const values = new Set();
          for (let batch = 0; batch < 10; batch++) {
            const rows = await api[e.name].filter(q, "-created_date", READ_MAX_LIMIT, batch * READ_MAX_LIMIT, [field]);
            for (const row of rows) {
              const v = row[field];
              if (Array.isArray(v)) {
                for (const el of v) if (el !== null && el !== undefined) values.add(el);
              } else if (v !== null && v !== undefined) {
                values.add(v);
              }
            }
            if (rows.length < READ_MAX_LIMIT) break;
            if (batch === 9) {
              throw Object.assign(
                dbError("DATABASE_DISTINCT_SCAN_EXCEEDED", `${e.name} distinct scan limit reached`, { entity: e.name, operation: "page" }),
                { status: 400 },
              );
            }
          }
          const sorted = [...values].sort((a, b) => {
            const aNum = typeof a === "number", bNum = typeof b === "number";
            if (aNum && bNum) return a - b;
            if (aNum !== bNum) return aNum ? -1 : 1;
            return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
          });
          const fetched = sorted.slice(offset, offset + want + 1);
          const has_more = fetched.length > want;
          const items = has_more ? fetched.slice(0, want) : fetched;
          const next_cursor = has_more
            ? await mintPageCursor({ projectId, entity: e.name, q, distinct: field, offset: offset + items.length })
            : null;
          return { items, next_cursor, has_more };
        }
        // Explicit-supply detection mirrors the SDK client transport (readPage): q, sort and
        // fields travel only when the caller supplied them, so their ABSENCE is meaningful.
        // DOCUMENTED (SDK 0.8.51, EntityPage JSDoc): "a later page needs only `cursor` and
        // `limit`" — a cursor-only continuation recovers the walk's query/sort/fields from
        // the VERIFIED cursor state. An EXPLICITLY supplied value is still compared against
        // the verified state and a mismatch fails closed (the mismatch ERROR is DOCUMENTED;
        // its code/status stays NEXUSAI-derived).
        const querySupplied = query !== undefined && query !== null;
        let q = querySupplied && typeof query === "object" && !Array.isArray(query) ? query : {};
        const sortSupplied = !!options.sort;
        let sort = sortSupplied ? String(options.sort) : "-created_date";
        let fields = null;
        const fieldsSupplied = options.fields !== undefined && options.fields !== null;
        if (fieldsSupplied) {
          if (!Array.isArray(options.fields)) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name} page fields must be an array of field names`, { entity: e.name, operation: "page" });
          }
          fields = options.fields;
        }
        // Page-form limits: SDK default 100, cap 5,000 (SDK types) — distinct from the array
        // form's documented default of 50, which filter() above keeps unchanged.
        const raw = Number(options.limit);
        const want = Math.min(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100, READ_MAX_LIMIT);
        let offset = 0;
        if (options.cursor !== undefined && options.cursor !== null && options.cursor !== "") {
          const state = await verifyPageCursor(options.cursor, { projectId, entity: e.name });
          // Cross-mode refusal (B2, unchanged): a DISTINCT-walk cursor never continues in
          // records mode — without this guard the recovery below would ACCEPT it, because the
          // distinct state carries no sort/fields and those absent values trivially satisfy
          // the comparisons. state.distinct is the distinct walk's own mode marker.
          if (state.distinct !== undefined) {
            throw Object.assign(
              dbError("DATABASE_CURSOR_MISMATCH", "cursor does not match this request's query, sort or fields", { entity: e.name, operation: "page" }),
              { status: 400 },
            );
          }
          // Cursor-only continuation: a parameter the caller did NOT supply is recovered from
          // the VERIFIED cursor state (bounded by its HMAC signature and project/entity
          // binding), so recovery trivially satisfies the comparison below; an EXPLICITLY
          // supplied conflicting value still fails it closed. Canonical sorted-key JSON keeps
          // key order from ever causing a spurious mismatch (the mismatch ERROR itself is
          // DOCUMENTED; its code/status stays NEXUSAI-derived).
          if (!querySupplied) q = state.q;
          if (!sortSupplied) sort = state.sort;
          if (!fieldsSupplied) fields = state.fields ?? null;
          if (stableStringify(state.q) !== stableStringify(q) || state.sort !== sort || stableStringify(state.fields ?? null) !== stableStringify(fields)) {
            throw Object.assign(
              dbError("DATABASE_CURSOR_MISMATCH", "cursor does not match this request's query, sort or fields", { entity: e.name, operation: "page" }),
              { status: 400 },
            );
          }
          offset = state.offset;
        }
        // One extra row decides has_more; at the 5,000 ceiling the +1 probe cannot ride the
        // same call (the read path caps at 5,000), so a full 5,000-row page gets a 1-row probe.
        const fetchLimit = want < READ_MAX_LIMIT ? want + 1 : want;
        const fetched = await api[e.name].filter(q, sort, fetchLimit, offset, fields || undefined);
        let items = fetched;
        let has_more = false;
        if (want < READ_MAX_LIMIT && fetched.length > want) {
          items = fetched.slice(0, want);
          has_more = true;
        } else if (want === READ_MAX_LIMIT && fetched.length === want) {
          const probe = await api[e.name].filter(q, sort, 1, offset + fetched.length, fields || undefined);
          has_more = probe.length > 0;
        }
        const next_cursor = has_more
          ? await mintPageCursor({ projectId, entity: e.name, q, sort, fields, offset: offset + items.length })
          : null;
        return { items, next_cursor, has_more };
      },
      count: async (query) => {
        requireUser();
        const q = query || {};
        assertQueryable(fplan, { query: q, operation: "count" });
        const hasDataFilter = Object.keys(q).length > 0;
        const serverQuery = rls ? { ...base, owner_id: userId } : { ...base };
        if (gates.read.deny) return 0;
        // No native count primitive in the SDK; stream-count in bounded batches.
        let n = 0, batchSkip = 0;
        while (true) {
          const rows = await client.entities.AppRecord.filter(serverQuery, "-created_date", STREAM_BATCH, batchSkip);
          if (!rows.length) break;
          for (const r of rows) {
            // Only readable records are counted, so a count can never reveal rows a query hides.
            if (!canRead(r)) continue;
            if (!hasDataFilter || matches(toItem(r), q)) n++;
          }
          batchSkip += rows.length;
          if (rows.length < STREAM_BATCH) break;
        }
        return n;
      },
      // --- Phase B3: server-side group-by aggregation ---------------------------------------
      // DOCUMENTED (Base44 SDK 0.8.51 — EntityAggregateSpec/EntityAggregateResult + the
      // entities module): aggregate(spec) receives the spec verbatim and returns { rows,
      // truncated }. groupBy is a field or up to four fields; no groupBy yields ONE total row;
      // dateBucket buckets a date field by day|week|month|year with `week` CONFIRMED only for
      // created_date/updated_date (schema date fields: day|month|year); count defaults to
      // true; sum/avg/min/max take a field or fields; countDistinct takes exactly one field;
      // having filters the computed fields after grouping; sort is exactly one string with
      // `-` for descending; limit defaults to 1,000, "up to 1,000"; truncated is true when
      // more groups exist than the limit allowed. Row keys: group fields as-is, then `count`,
      // `sum_<field>`, `avg_<field>`, `min_<field>`, `max_<field>`, `count_distinct_<field>`.
      // A raw Mongo pipeline is NOT part of 0.8.51 and is not implemented; there is no
      // aggregate cursor pagination.
      // Every semantic the SDK does NOT pin is a bounded NEXUSAI-derived, non-parity choice:
      //   • scan ......... matched records stream through the SAME storage query, per-record
      //                    read gate, legacy-RLS scoping and matches() filtering count() uses,
      //                    with an explicit refusal past 50,000 matched records — never a
      //                    silently partial aggregate;
      //   • numeric ops ... only finite numbers participate: null/undefined/non-numeric
      //                    values are skipped, never coerced; an empty set yields sum 0 and
      //                    avg/min/max null;
      //   • countDistinct. null/undefined are not distinct values; an array value counts as
      //                    one value (no element explosion — B2's distinct docs do not apply);
      //   • having ....... reuses the EXISTING query operator set (matches()) against the
      //                    computed row; unknown/malformed conditions fail closed (group out);
      //   • dateBucket ... buckets are UTC ISO prefixes (day YYYY-MM-DD, month YYYY-MM, year
      //                    YYYY; week is ISO-8601 Monday-start 'YYYY-Www'), emitted under the
      //                    field's own name; a dateBucket field that is ALSO a groupBy field is
      //                    refused (output-key collision — upstream semantics UNKNOWN); an
      //                    unparseable date value buckets as null;
      //   • fields ....... every groupBy/measure/countDistinct/sort field outside the schema
      //                    (plus id/created_date/updated_date) is refused with a structured
      //                    validation error; unknown spec keys are ignored;
      //   • limit ........ a limit above 1,000 CLAMPS to 1,000 (B2's clamp choice);
      //   • no sort ...... rows keep first-seen scan order;
      //   • key order .... group fields in spec order, then the bucket field, then count,
      //                    then measures in spec order.
      aggregate: async (spec) => {
        requireUser();
        assertNoFieldRules(fplan, "aggregate");
        const def = defOf(e.name);
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate requires an aggregate spec object`, { entity: e.name, operation: "aggregate" });
        }
        const knownFields = new Set(["id", "created_date", "updated_date", ...Object.keys((def || {}).fields || {})]);
        const fieldList = (value, key, max) => {
          const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
          if (!list || !list.length || !list.every((f) => typeof f === "string" && knownFields.has(f))) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate ${key} must be a field name or array of field names`, { entity: e.name, operation: "aggregate", key });
          }
          if (max && list.length > max) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate ${key} accepts at most ${max} fields (got ${list.length})`, { entity: e.name, operation: "aggregate", key, limit: max, got: list.length });
          }
          return [...new Set(list)];
        };
        if (spec.query !== undefined && spec.query !== null && (typeof spec.query !== "object" || Array.isArray(spec.query))) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate query must be an object`, { entity: e.name, operation: "aggregate", key: "query" });
        }
        const q = spec.query || {};
        const groupBy = spec.groupBy === undefined || spec.groupBy === null ? [] : fieldList(spec.groupBy, "groupBy", 4);
        let bucket = null;
        if (spec.dateBucket !== undefined && spec.dateBucket !== null) {
          const b = spec.dateBucket;
          const unitOk = b && typeof b === "object" && !Array.isArray(b) && typeof b.field === "string" && knownFields.has(b.field) && ["day", "week", "month", "year"].includes(b.unit);
          if (!unitOk) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate dateBucket must be { field, unit: day|week|month|year }`, { entity: e.name, operation: "aggregate", key: "dateBucket" });
          }
          const builtInDate = b.field === "created_date" || b.field === "updated_date";
          if (!builtInDate && ((def || {}).fields || {})[b.field]?.type !== "date") {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate dateBucket field "${b.field}" is not a date field`, { entity: e.name, operation: "aggregate", key: "dateBucket", field: b.field });
          }
          if (b.unit === "week" && !builtInDate) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate dateBucket week is supported only for created_date/updated_date`, { entity: e.name, operation: "aggregate", key: "dateBucket", field: b.field });
          }
          if (groupBy.includes(b.field)) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate dateBucket field "${b.field}" is also a groupBy field`, { entity: e.name, operation: "aggregate", key: "dateBucket", field: b.field });
          }
          bucket = { field: b.field, unit: b.unit };
        }
        if (spec.count !== undefined && spec.count !== null && typeof spec.count !== "boolean") {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate count must be a boolean`, { entity: e.name, operation: "aggregate", key: "count" });
        }
        const wantCount = spec.count !== false;
        if (spec.having !== undefined && spec.having !== null && (typeof spec.having !== "object" || Array.isArray(spec.having))) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate having must be an object`, { entity: e.name, operation: "aggregate", key: "having" });
        }
        const having = spec.having || null;
        const measures = [];
        for (const key of ["sum", "avg", "min", "max"]) {
          if (spec[key] === undefined || spec[key] === null) continue;
          for (const f of fieldList(spec[key], key)) measures.push({ op: key, field: f, out: `${key}_${f}` });
        }
        let countDistinct = null;
        if (spec.countDistinct !== undefined && spec.countDistinct !== null) {
          const f = fieldList(spec.countDistinct, "countDistinct");
          if (f.length !== 1) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate countDistinct accepts exactly one field`, { entity: e.name, operation: "aggregate", key: "countDistinct" });
          }
          countDistinct = f[0];
        }
        let sort = null;
        if (spec.sort !== undefined && spec.sort !== null && spec.sort !== "") {
          if (typeof spec.sort !== "string") {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate sort must be a single field string with an optional '-' prefix`, { entity: e.name, operation: "aggregate", key: "sort" });
          }
          const desc = spec.sort.startsWith("-");
          const sortKey = desc || spec.sort.startsWith("+") ? spec.sort.slice(1) : spec.sort;
          const sortable = new Set([...groupBy, ...(bucket ? [bucket.field] : []), ...(wantCount ? ["count"] : []), ...measures.map((m) => m.out), ...(countDistinct ? [`count_distinct_${countDistinct}`] : [])]);
          if (!sortable.has(sortKey)) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.aggregate sort field "${sortKey}" is not a group or computed field`, { entity: e.name, operation: "aggregate", key: "sort", field: sortKey, sortable: [...sortable] });
          }
          sort = spec.sort;
        }
        const rawLimit = Number(spec.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1000) : 1000;

        // The matched-record scan: the SAME storage query, per-record read gate, legacy-RLS
        // scoping and matches() filtering count() uses, with an explicit refusal past the
        // scan bound — aggregate never reads what the read path would hide.
        const serverQuery = rls ? { ...base, owner_id: userId } : { ...base };
        if (gates.read.deny) return { rows: [], truncated: false };
        const hasDataFilter = Object.keys(q).length > 0;
        const items = [];
        let batchSkip = 0;
        const AGG_SCAN_MAX = 50000;
        while (true) {
          const rows = await client.entities.AppRecord.filter(serverQuery, "-created_date", STREAM_BATCH, batchSkip);
          if (!rows.length) break;
          for (const r of rows) {
            if (!canRead(r)) continue;
            const item = toItem(r);
            if (!hasDataFilter || matches(item, q)) {
              items.push(item);
              if (items.length > AGG_SCAN_MAX) {
                throw Object.assign(dbError("DATABASE_AGG_SCAN_EXCEEDED", `${e.name}.aggregate scan limit reached (more than ${AGG_SCAN_MAX} matched records)`, { entity: e.name, operation: "aggregate", limit: AGG_SCAN_MAX }), { status: 400 });
              }
            }
          }
          batchSkip += rows.length;
          if (rows.length < STREAM_BATCH) break;
        }

        // Bucket a date value into its UTC ISO prefix (week = ISO-8601 Monday-start).
        const bucketOf = (value, unit) => {
          const d = new Date(value);
          if (typeof value !== "string" || isNaN(d.getTime())) return null;
          const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
          if (unit === "day") return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          if (unit === "month") return `${y}-${String(m).padStart(2, "0")}`;
          if (unit === "year") return String(y);
          const thursday = new Date(Date.UTC(y, m - 1, day - ((d.getUTCDay() + 6) % 7) + 3));
          const isoYear = thursday.getUTCFullYear();
          const jan4 = new Date(Date.UTC(isoYear, 0, 4));
          const week1Monday = Date.UTC(isoYear, 0, 4) - ((jan4.getUTCDay() + 6) % 7) * 86400000;
          const week = 1 + Math.round((thursday.getTime() - week1Monday) / 604800000);
          return `${isoYear}-W${String(week).padStart(2, "0")}`;
        };

        // Group and accumulate measures.
        const groups = new Map();
        for (const item of items) {
          const keyParts = groupBy.map((f) => item[f] ?? null);
          if (bucket) keyParts.push(bucketOf(item[bucket.field], bucket.unit));
          const key = stableStringify(keyParts);
          let g = groups.get(key);
          if (!g) {
            const row = {};
            groupBy.forEach((f, i) => { row[f] = keyParts[i]; });
            if (bucket) row[bucket.field] = keyParts[groupBy.length];
            g = { row, count: 0, agg: {}, distincts: countDistinct ? new Set() : null };
            groups.set(key, g);
          }
          g.count++;
          for (const m of measures) {
            const v = item[m.field];
            if (typeof v !== "number" || !Number.isFinite(v)) continue;
            let a = g.agg[m.out] || (g.agg[m.out] = { sum: 0, n: 0, min: undefined, max: undefined });
            a.sum += v; a.n++;
            if (a.min === undefined || v < a.min) a.min = v;
            if (a.max === undefined || v > a.max) a.max = v;
          }
          if (g.distincts) { const v = item[countDistinct]; if (v !== null && v !== undefined) g.distincts.add(v); }
        }

        // Computed rows: group fields as-is, then count, then measures, then countDistinct.
        let rows = [];
        for (const g of groups.values()) {
          const row = { ...g.row };
          if (wantCount) row.count = g.count;
          for (const m of measures) {
            const a = g.agg[m.out];
            row[m.out] = m.op === "sum" ? (a ? a.sum : 0) : a ? (m.op === "avg" ? a.sum / a.n : m.op === "min" ? a.min : a.max) : null;
          }
          if (countDistinct) row[`count_distinct_${countDistinct}`] = g.distincts.size;
          rows.push(row);
        }
        // having: post-group filter over the computed fields, using the EXISTING operator set.
        if (having) rows = rows.filter((row) => matches(row, having));
        const sorted = sort ? sortItems(rows, sort) : rows;
        return { rows: sorted.slice(0, limit), truncated: rows.length > limit };
      },
      // --- upsert (Base44 SDK 0.8.51 surface) ------------------------------------------------
      // DOCUMENTED (SDK 0.8.51 — EntityHandler.upsert + EntityUpsertOptions/EntityUpsertResult,
      // PR #287): upsert(records, { key }) — create or update by a natural key; key is a field
      // or array of fields and the ONLY options property; the result is { created, updated,
      // records } where records are the written records "as they now exist". The records/key
      // travel verbatim — no client-side normalization is part of the SDK surface.
      // UPSTREAM-PR-CONFIRMED (PR #287 body + commit message — NOT in the shipped types/JSDoc):
      // at most 500 records per call; refused fail-closed, never silently clamped.
      //
      // Every semantic the SDK does NOT pin is a bounded NEXUSAI-derived, non-parity choice
      // (fail-closed wherever the read-only audit marked it UNKNOWN):
      //   • key fields .... must be declared schema fields. The upstream type (keyof T) also
      //                      admits built-ins like id, but this storage assigns id/created_date
      //                      itself, so a caller-supplied builtin key is refused;
      //   • key values .... must be present non-null non-empty-string primitives
      //                      (string|number|boolean); matching is strict, type-sensitive
      //                      equality (5 never matches "5"); object/array key values refused;
      //   • missing key ... any record missing a key field aborts the whole call pre-write;
      //   • empty records. refused (upstream UNKNOWN — deterministic fail-closed);
      //   • dup keys within one call ... DOCUMENTED (0.8.52 JSDoc): accepted — the LAST
      //                      occurrence wins; surviving records keep their input order;
      //   • multiple existing matches .. refused as ambiguous, before any write;
      //   • visibility .... matches resolve through the SAME read path (per-record read gate +
      //                      legacy-RLS scoping): an existing record the caller cannot read is
      //                      not a match and a new record is created — the platform-wide
      //                      "existence never leaks" stance; a flat read deny refuses upsert;
      //   • merge ......... an update merges the submitted fields over the existing record
      //                      (exactly like update()), never a blind replace;
      //   • events ........ create/update events per written record, like the single ops;
      //   • order ......... records return in input order; created/updated count the writes;
      //   • atomicity ..... the whole set is validated, gated, matched and relation-checked
      //                      BEFORE the first write, mirroring bulkCreate/bulkUpdate;
      //   • system fields . id/created_date/created_by ownership are the existing storage
      //                      ops' — nothing here mints or rewrites them.
      upsert: async (records, options) => {
        requireUser();
        const def = defOf(e.name);
        // UPSTREAM-PR-CONFIRMED (PR #287): 500 records per call — fail-closed, no clamp.
        const UPSERT_MAX = 500;
        const keyRaw = options && options.key;
        const keyList = typeof keyRaw === "string" ? [keyRaw] : Array.isArray(keyRaw) ? keyRaw : null;
        if (!keyList || !keyList.length || !keyList.every((f) => typeof f === "string" && f.trim() !== "")) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert key must be a field name or array of field names`, { entity: e.name, operation: "upsert", key: keyRaw ?? null });
        }
        if (new Set(keyList).size !== keyList.length) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert key lists a field more than once: ${keyList.join(", ")}`, { entity: e.name, operation: "upsert", key: keyList });
        }
        const schemaFields = new Set(Object.keys((def || {}).fields || {}));
        const badKeyField = keyList.find((f) => !schemaFields.has(f));
        if (badKeyField !== undefined) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert key field "${badKeyField}" is not a declared schema field`, { entity: e.name, operation: "upsert", field: badKeyField, known_fields: [...schemaFields] });
        }
        if (!Array.isArray(records)) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert requires a records array`, { entity: e.name, operation: "upsert" });
        }
        if (!records.length) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert needs a non-empty records array`, { entity: e.name, operation: "upsert" });
        }
        if (records.length > UPSERT_MAX) {
          throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert accepts at most ${UPSERT_MAX} records per call (got ${records.length})`, { entity: e.name, operation: "upsert", limit: UPSERT_MAX, got: records.length });
        }
        // Validate every record and its key BEFORE any read or write.
        const wanted = new Map();
        records.forEach((rec, i) => {
          if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert record ${i + 1} must be an object`, { entity: e.name, operation: "upsert", index: i });
          }
          const payload = stripOwner(rec);
          const keyVals = keyList.map((f) => payload[f]);
          for (let k = 0; k < keyList.length; k++) {
            const v = keyVals[k];
            const ok = (typeof v === "string" && v !== "") || typeof v === "number" || typeof v === "boolean";
            if (!ok) {
              throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert record ${i + 1} is missing key field "${keyList[k]}" (or its value is null/empty/non-primitive)`, { entity: e.name, operation: "upsert", index: i, field: keyList[k] });
            }
          }
          const keyStr = stableStringify(keyVals);
          // DOCUMENTED (SDK 0.8.52 JSDoc): duplicate keys within one call are ACCEPTED — the
          // LAST occurrence wins. delete+set re-inserts the key at the end, so planning (and
          // the returned records) iterates in the original order of the SURVIVING records;
          // the superseded earlier occurrence is simply never planned. Input-order handling
          // of non-duplicate records and the 500-record input cap are unchanged.
          if (wanted.has(keyStr)) wanted.delete(keyStr);
          wanted.set(keyStr, i);
          try { validateRecord(def, payload); }
          catch (err) { throw dbError(err.code || "DATABASE_VALIDATION_FAILED", `${e.name}.upsert record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, operation: "upsert", index: i }); }
        });
        // A flat read deny makes existing matches invisible — refusing upsert entirely is the
        // fail-closed choice (silent duplicate creation is never invented).
        if (gates.read.deny) {
          throw Object.assign(dbError("DATABASE_RLS_DENIED", `Not permitted: upsert on ${e.name} (read rule denies matching)`, { entity: e.name, operation: "upsert" }), { status: 403 });
        }
        // ONE streaming pass over the entity (the same scoped query the count/aggregate scans
        // use) collects at most the first 2 readable matches per requested key — enough to
        // detect the ambiguity the fail-closed choice refuses.
        const serverQuery = rls ? { ...base, owner_id: userId } : { ...base };
        const found = new Map();
        let scanSkip = 0;
        while (true) {
          const rows = await client.entities.AppRecord.filter(serverQuery, "-created_date", STREAM_BATCH, scanSkip);
          if (!rows.length) break;
          for (const r of rows) {
            if (!canRead(r)) continue;
            const item = toItem(r);
            const keyStr = stableStringify(keyList.map((f) => item[f]));
            if (!wanted.has(keyStr)) continue;
            const list = found.get(keyStr) || [];
            if (list.length < 2) list.push(r);
            found.set(keyStr, list);
          }
          scanSkip += rows.length;
          if (rows.length < STREAM_BATCH) break;
        }
        // Plan every write before the first one: 0 matches → create, 1 → update, ≥2 → refuse.
        const plans = [];
        for (const [keyStr, i] of wanted) {
          const matches = found.get(keyStr) || [];
          const payload = stripOwner(records[i]);
          if (matches.length > 1) {
            throw dbError("DATABASE_VALIDATION_FAILED", `${e.name}.upsert record ${i + 1}: its key matches more than one existing record`, { entity: e.name, operation: "upsert", index: i, key: keyList });
          }
          if (!matches.length) {
            try { rlsCheck(gates.create, pendingView(payload, { userId, email: user?.email || null }), e.name, "create"); }
            catch (err) { throw Object.assign(dbError(err.code || "DATABASE_RLS_DENIED", `${e.name}.upsert record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, operation: "upsert", index: i }), { status: err.status || 403 }); }
            assertFieldsWritable(wplan, "create", Object.keys(payload), pendingView(payload, { userId, email: user?.email || null }), "upsert", i);
            plans.push({ kind: "create", payload });
          } else {
            const r = matches[0];
            try { rlsCheck(gates.update, recordView(r), e.name, "update"); }
            catch (err) { throw Object.assign(dbError(err.code || "DATABASE_RLS_DENIED", `${e.name}.upsert record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, operation: "upsert", index: i, record_id: String(r.id) }), { status: err.status || 403 }); }
            assertFieldsWritable(wplan, "update", Object.keys(payload), recordView(r), "upsert", i);
            const merged = stripOwner({ ...(r.data || {}), ...payload });
            try { validateRecord(def, merged); }
            catch (err) { throw dbError(err.code || "DATABASE_VALIDATION_FAILED", `${e.name}.upsert record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, operation: "upsert", index: i, record_id: String(r.id) }); }
            plans.push({ kind: "update", r, merged, keys: Object.keys(payload) });
          }
        }
        const rels = await getCanonRels();
        for (let i = 0; i < plans.length; i++) {
          const p = plans[i];
          try {
            await enforceOnWrite({ rels, entity: e.name, data: p.kind === "create" ? p.payload : p.merged, existingId: p.kind === "update" ? p.r.id : null, isUpdate: p.kind === "update", updateKeys: p.kind === "update" ? p.keys : undefined, store: relStore });
          } catch (err) { throw dbError(err.code || "DATABASE_RELATION_VIOLATION", `${e.name}.upsert record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, operation: "upsert", index: i }); }
        }
        // Apply in input order — the SAME persistence + event machinery the single ops use.
        let createdCount = 0, updatedCount = 0;
        const out = await persistEach(e.name, "upsert", plans, async (p) => {
          if (p.kind === "create") {
            const record = { ...base, data: p.payload };
            if (rls) record.owner_id = userId;
            const row = await client.entities.AppRecord.create(record);
            createdCount++;
            await emitEntityEvent(client, projectId, e.name, "create", toItem(row), rls ? userId : null);
            return asItem(row);
          }
          const doc = { data: p.merged };
          if (rls) doc.owner_id = userId; // ownership is immutable, exactly like update()
          const row = await client.entities.AppRecord.update(p.r.id, doc);
          updatedCount++;
          await emitEntityEvent(client, projectId, e.name, "update", toItem(row), rls ? userId : null);
          return asItem(row);
        }, (p, item, j) => (p.kind === "create" ? undoCreate(e.name)(p, item, j) : undoUpdate(e.name)(p, item, j)));
        return { created: createdCount, updated: updatedCount, records: out };
      },
      get: async (id) => {
        requireUser();
        const def = defOf(e.name);
        const r = await owned(def, id);
        // A record the read rule excludes is reported as NOT FOUND, exactly like a record of
        // another project or another owner, so existence never leaks.
        if (!canRead(r)) {
          throw dbError("DATABASE_RECORD_NOT_FOUND", `${def.name} record not found`, { entity: def.name, record_id: String(id) });
        }
        return asItem(r);
      },
      create: async (data) => {
        requireUser();
        const payload = stripOwner(data);
        validateRecord(defOf(e.name), payload);
        // Evaluated against the record that WOULD be written (ownership is the server's), and
        // refused before insertion. Legacy owner stamping below is untouched.
        rlsCheck(gates.create, pendingView(payload, { userId, email: user?.email || null }), e.name, "create");
        assertFieldsWritable(wplan, "create", Object.keys(payload), pendingView(payload, { userId, email: user?.email || null }), "create");
        await enforceOnWrite({ rels: await getCanonRels(), entity: e.name, data: payload, existingId: null, isUpdate: false, store: relStore });
        const record = { ...base, data: payload };
        if (rls) record.owner_id = userId;
        const createdRow = await client.entities.AppRecord.create(record);
        await emitEntityEvent(client, projectId, e.name, "create", toItem(createdRow), rls ? userId : null);
        return asItem(createdRow);
      },
      update: async (id, data) => {
        requireUser();
        const r = await owned(defOf(e.name), id);
        // The update gate is evaluated against the EXISTING, pre-change record.
        rlsCheck(gates.update, recordView(r), e.name, "update");
        assertFieldsWritable(wplan, "update", Object.keys(stripOwner(data)), recordView(r), "update");
        const merged = { ...(r.data || {}), ...stripOwner(data) };
        const cleanMerged = stripOwner(merged);
        validateRecord(defOf(e.name), cleanMerged);
        await enforceOnWrite({ rels: await getCanonRels(), entity: e.name, data: cleanMerged, existingId: r.id, isUpdate: true, updateKeys: Object.keys(stripOwner(data)), store: relStore });
        const updateDoc = { data: merged };
        if (rls) updateDoc.owner_id = userId; // ownership is immutable: a write cannot reassign it
        const updatedRow = await client.entities.AppRecord.update(r.id, updateDoc);
        await emitEntityEvent(client, projectId, e.name, "update", toItem(updatedRow), rls ? userId : null);
        return asItem(updatedRow);
      },
      delete: async (id) => {
        requireUser();
        const r = await owned(defOf(e.name), id);
        // The delete gate is evaluated against the existing record, before any relation work.
        rlsCheck(gates.delete, recordView(r), e.name, "delete");
        await enforceOnDelete({ rels: await getCanonRels(), entity: e.name, id: r.id, store: relStore });
        // Entity Trash parity: deletion is recoverable — the record moves to the entity's
        // trash instead of being destroyed (audited contract; permanent delete is a separate
        // explicit action on the trash surface). The delete event emission is unchanged.
        await moveToTrash(client, r, { by: rls ? userId : null });
        await emitEntityEvent(client, projectId, e.name, "delete", toItem(r), rls ? userId : null);
        // B6 write-contract parity (SDK 0.8.51): delete resolves with the DOCUMENTED
        // DeleteResult { success: true } — the unit-tested upstream response body.
        return { success: true };
      },
      // --- bulk operations ---------------------------------------------------
      // Set-based writes for real workloads (imports, batch edits, cleanups). They reuse the
      // SAME validation, RLS ownership and relation enforcement as the single-record ops, so a
      // bulk call can never bypass a rule the per-record path enforces.
      //
      // Semantics are explicit and fail-fast: the whole set is validated BEFORE anything is
      // written, so a malformed batch changes nothing. Ownership/relation failures during
      // application are reported per record instead of being swallowed.
      bulkCreate: async (items) => {
        requireUser();
        const list = Array.isArray(items) ? items : [];
        if (!list.length) throw dbError("DATABASE_INVALID_BULK", `${e.name}.bulkCreate needs a non-empty array of records`, { entity: e.name, operation: "bulkCreate" });
        if (list.length > MAX_BULK) throw dbError("DATABASE_BULK_LIMIT", `${e.name}.bulkCreate accepts at most ${MAX_BULK} records per call (got ${list.length})`, { entity: e.name, operation: "bulkCreate", limit: MAX_BULK, got: list.length });
        const def = defOf(e.name);
        const payloads = list.map((d) => stripOwner(d));
        // Validate the ENTIRE batch first: an invalid record aborts before any write.
        payloads.forEach((p, i) => {
          try { validateRecord(def, p); }
          catch (err) { throw dbError(err.code || "DATABASE_VALIDATION_FAILED", `${e.name}.bulkCreate record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, index: i }); }
        });
        // Each payload is evaluated INDIVIDUALLY against its own pending view, before any write.
        payloads.forEach((p, i) => {
          try { rlsCheck(gates.create, pendingView(p, { userId, email: user?.email || null }), e.name, "create"); }
          catch (err) { throw Object.assign(dbError(err.code || "DATABASE_RLS_DENIED", `${e.name}.bulkCreate record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, index: i }), { status: err.status || 403 }); }
          assertFieldsWritable(wplan, "create", Object.keys(p), pendingView(p, { userId, email: user?.email || null }), "bulkCreate", i);
        });
        const rels = await getCanonRels();
        for (let i = 0; i < payloads.length; i++) {
          try { await enforceOnWrite({ rels, entity: e.name, data: payloads[i], existingId: null, isUpdate: false, store: relStore }); }
          catch (err) { throw dbError(err.code || "DATABASE_RELATION_VIOLATION", `${e.name}.bulkCreate record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, index: i }); }
        }
        const created = await persistEach(e.name, "bulkCreate", payloads, async (payload) => {
          const record = { ...base, data: payload };
          if (rls) record.owner_id = userId;
          const row = await client.entities.AppRecord.create(record);
          await emitEntityEvent(client, projectId, e.name, "create", toItem(row), rls ? userId : null);
          return asItem(row);
        }, undoCreate(e.name));
        // B6 write-contract parity (SDK 0.8.51 docs): bulkCreate resolves with the created
        // records array T[] — the documented response body, verbatim.
        return created;
      },
      bulkUpdate: async (updates) => {
        requireUser();
        const list = Array.isArray(updates) ? updates : [];
        if (!list.length) throw dbError("DATABASE_INVALID_BULK", `${e.name}.bulkUpdate needs a non-empty array of { id, ...changes }`, { entity: e.name, operation: "bulkUpdate" });
        if (list.length > MAX_BULK) throw dbError("DATABASE_BULK_LIMIT", `${e.name}.bulkUpdate accepts at most ${MAX_BULK} records per call (got ${list.length})`, { entity: e.name, operation: "bulkUpdate", limit: MAX_BULK, got: list.length });
        const def = defOf(e.name);
        // B6 write-contract parity (SDK 0.8.51): the DOCUMENTED upstream form is FLAT
        // [{ id, ...changes }] ("each item must have id"); the legacy nested [{ id, data: ... }]
        // form stays accepted for the existing internal callers (updateWhere, suites).
        // Disambiguation: a `data` key holding a plain object selects the legacy form — a
        // NEXUSAI-derived boundary choice (a schema field literally named `data` with an
        // object value is inherently ambiguous; upstream publishes nothing — UNKNOWN).
        const changesOf = (entry) => {
          if (entry && typeof entry === "object" && entry.data != null && typeof entry.data === "object" && !Array.isArray(entry.data)) return entry.data;
          const rest = { ...(entry || {}) };
          delete rest.id;
          delete rest.data;
          return rest;
        };
        // Resolve + validate everything (ownership included) before the first write.
        const planned = [];
        for (let i = 0; i < list.length; i++) {
          const { id } = list[i] || {};
          const data = changesOf(list[i]);
          if (!id) throw dbError("DATABASE_INVALID_BULK", `${e.name}.bulkUpdate entry ${i + 1} is missing 'id'`, { entity: e.name, index: i });
          const r = await owned(def, id);            // enforces legacy owner isolation
          // Per-record update gate, on the pre-change record, before the first write.
          try { rlsCheck(gates.update, recordView(r), e.name, "update"); }
          catch (err) { throw Object.assign(dbError(err.code || "DATABASE_RLS_DENIED", `${e.name}.bulkUpdate record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, index: i, record_id: String(id) }), { status: err.status || 403 }); }
          assertFieldsWritable(wplan, "update", Object.keys(stripOwner(data)), recordView(r), "bulkUpdate", i);
          const merged = stripOwner({ ...(r.data || {}), ...stripOwner(data) });
          try { validateRecord(def, merged); }
          catch (err) { throw dbError(err.code || "DATABASE_VALIDATION_FAILED", `${e.name}.bulkUpdate record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, index: i, record_id: String(id) }); }
          planned.push({ r, merged, keys: Object.keys(stripOwner(data)) });
        }
        const rels = await getCanonRels();
        for (let i = 0; i < planned.length; i++) {
          try { await enforceOnWrite({ rels, entity: e.name, data: planned[i].merged, existingId: planned[i].r.id, isUpdate: true, updateKeys: planned[i].keys, store: relStore }); }
          catch (err) { throw dbError(err.code || "DATABASE_RELATION_VIOLATION", `${e.name}.bulkUpdate record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, index: i }); }
        }
        const items = await persistEach(e.name, "bulkUpdate", planned, async (p) => {
          const doc = { data: p.merged };
          if (rls) doc.owner_id = userId;
          const row = await client.entities.AppRecord.update(p.r.id, doc);
          await emitEntityEvent(client, projectId, e.name, "update", toItem(row), rls ? userId : null);
          return asItem(row);
        }, undoUpdate(e.name));
        // B6 write-contract parity (SDK 0.8.51): bulkUpdate resolves with the updated records
        // array T[] (the documented response body), in input order.
        return items;
      },
      bulkDelete: async (ids) => {
        requireUser();
        const list = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
        if (!list.length) throw dbError("DATABASE_INVALID_BULK", `${e.name}.bulkDelete needs a non-empty array of ids`, { entity: e.name, operation: "bulkDelete" });
        if (list.length > MAX_BULK) throw dbError("DATABASE_BULK_LIMIT", `${e.name}.bulkDelete accepts at most ${MAX_BULK} ids per call (got ${list.length})`, { entity: e.name, operation: "bulkDelete", limit: MAX_BULK, got: list.length });
        const def = defOf(e.name);
        const records = [];
        for (let i = 0; i < list.length; i++) {
          const r = await owned(def, list[i]);
          // Per-record delete gate, on the existing record, before anything is removed.
          try { rlsCheck(gates.delete, recordView(r), e.name, "delete"); }
          catch (err) { throw Object.assign(dbError(err.code || "DATABASE_RLS_DENIED", `${e.name}.bulkDelete record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, index: i, record_id: String(list[i]) }), { status: err.status || 403 }); }
          records.push(r);
        }
        const rels = await getCanonRels();
        for (const r of records) await enforceOnDelete({ rels, entity: e.name, id: r.id, store: relStore });
        await persistEach(e.name, "bulkDelete", records, async (r) => {
          // Entity Trash parity: bulk deletion (bulkDelete / deleteWhere / deleteMany) is
          // recoverable too — same trash move, same delete-gate and relation enforcement.
          await moveToTrash(client, r, { by: rls ? userId : null });
          await emitEntityEvent(client, projectId, e.name, "delete", toItem(r), rls ? userId : null);
          return { id: r.id };
        });
        // B6: deleteMany routes here — the response now carries the DOCUMENTED DeleteManyResult
        // fields { success, deleted } (the additive ids are kept: removing them would churn
        // unrelated callers).
        return { success: true, deleted: records.length, ids: records.map((r) => r.id) };
      },
      // Query-driven variants: the query goes through the SAME filter path (so RLS scoping and
      // the streaming data-field matcher apply), then the resolved ids are updated/deleted.
      updateWhere: async (query, data) => {
        const targets = await api[e.name].filter(query || {}, "-created_date", MAX_BULK);
        if (!targets.length) return { updated: 0, items: [] };
        // B6: bulkUpdate now resolves with the upstream records array — updateWhere keeps its
        // own { updated, items } contract by adapting at this boundary.
        const items = await api[e.name].bulkUpdate(targets.map((t) => ({ id: t.id, data })));
        return { updated: items.length, items };
      },
      deleteWhere: async (query, options) => {
        const q = query || {};
        // A destructive whole-entity wipe must be asked for explicitly.
        if (!Object.keys(q).length && !(options && options.all === true)) {
          throw dbError("DATABASE_UNSAFE_BULK", `${e.name}.deleteWhere refused an empty query — pass a filter, or { all: true } to delete every ${e.name} record`, { entity: e.name, operation: "deleteWhere" });
        }
        const targets = await api[e.name].filter(q, "-created_date", MAX_BULK);
        if (!targets.length) return { success: true, deleted: 0, ids: [] };
        return api[e.name].bulkDelete(targets.map((t) => t.id));
      },
      // --- updateMany: the DOCUMENTED MongoDB-operator surface (SDK 0.8.51, PR #143) --------
      // Signature and result match the SDK exactly: updateMany(query, data) →
      // { success, updated, has_more }, `data` a MongoDB operator document, one batch of at
      // most 500 records. Batch resolution rides the EXISTING filter machine (read gate, RLS
      // scoping, project isolation, query matching); per-record writes reuse the update
      // gate, validation, relation enforcement, persistence and event emission bulkUpdate
      // uses. Every semantic the SDK does not pin is marked NEXUSAI-derived in the module
      // notes above parseUpdateOperators. updateWhere (the previous alias target) and
      // bulkUpdate are untouched.
      updateMany: async (query, operatorsDoc) => {
        requireUser();
        const def = defOf(e.name);
        const parsed = parseUpdateOperators(def, operatorsDoc);
        // The 500 least-recently-updated matches: the storage bump of updated_date makes a
        // repeated call with the SAME query advance past the rows it just wrote.
        const targets = await api[e.name].filter(query || {}, "updated_date", UPDATE_MANY_BATCH);
        const has_more = targets.length === UPDATE_MANY_BATCH
          ? (await api[e.name].filter(query || {}, "updated_date", 1, UPDATE_MANY_BATCH)).length > 0
          : false;
        if (!targets.length) return { success: true, updated: 0, has_more: false };
        // Gate + apply + validate EVERY record before the first persist (fail-fast).
        const planned = [];
        for (let i = 0; i < targets.length; i++) {
          const r = await owned(def, targets[i].id);
          try { rlsCheck(gates.update, recordView(r), e.name, "update"); }
          catch (err) { throw Object.assign(dbError(err.code || "DATABASE_RLS_DENIED", `${e.name}.updateMany record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, operation: "updateMany", index: i, record_id: String(r.id) }), { status: err.status || 403 }); }
          assertFieldsWritable(wplan, "update", parsed.touched, recordView(r), "updateMany", i);
          const merged = applyUpdateOperators(def, toItem(r), parsed, i);
          const dataDoc = { ...merged };
          delete dataDoc.id; delete dataDoc.created_date; delete dataDoc.updated_date;
          try { validateRecord(def, dataDoc); }
          catch (err) { throw dbError(err.code || "DATABASE_VALIDATION_FAILED", `${e.name}.updateMany record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, operation: "updateMany", index: i, record_id: String(r.id) }); }
          planned.push({ r, dataDoc });
        }
        const rels = await getCanonRels();
        for (let i = 0; i < planned.length; i++) {
          try { await enforceOnWrite({ rels, entity: e.name, data: planned[i].dataDoc, existingId: planned[i].r.id, isUpdate: true, updateKeys: parsed.touched, store: relStore }); }
          catch (err) { throw dbError(err.code || "DATABASE_RELATION_VIOLATION", `${e.name}.updateMany record ${i + 1}: ${err.message}`, { ...(err.details || {}), entity: e.name, operation: "updateMany", index: i }); }
        }
        await persistEach(e.name, "updateMany", planned, async (p) => {
          const doc = { data: p.dataDoc };
          if (rls) doc.owner_id = userId; // ownership is immutable, exactly like update()
          const updated = toItem(await client.entities.AppRecord.update(p.r.id, doc));
          await emitEntityEvent(client, projectId, e.name, "update", updated, rls ? userId : null);
          return updated;
        }, undoUpdate(e.name));
        return { success: true, updated: planned.length, has_more };
      },
      // DOCUMENTED (Base44 SDK reference): deleteMany(query) — "Deletes multiple records
      // matching a query" — stays routed onto the EXISTING deleteWhere machine.
      deleteMany: async (query) => api[e.name].deleteWhere(query),
    };
  }
  // Wrap the write ops with the restore edit-pause. Reads and the internal relation-maintenance
  // writes are untouched; the restore executor and trash surface write through the storage
  // layer directly, so they are never paused by their own operations.
  for (const name of Object.keys(api)) {
    for (const op of ["create", "update", "delete", "bulkCreate", "bulkUpdate", "bulkDelete", "updateMany", "upsert"]) {
      const orig = api[name][op];
      api[name][op] = async (...args) => { await history.assertWritable(name); return orig(...args); };
    }
  }

  // Accessing an entity that does not exist used to surface as an opaque
  // "Cannot read properties of undefined". Every operation on an unknown entity now raises
  // a structured DATABASE_ENTITY_NOT_FOUND naming the entity and the attempted operation.
  return new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== "string" || prop in target) return target[prop];
      const missing = {};
      for (const operation of ["list", "filter", "page", "count", "aggregate", "upsert", "get", "create", "update", "delete", "bulkCreate", "bulkUpdate", "bulkDelete", "updateWhere", "deleteWhere", "updateMany", "deleteMany"]) {
        missing[operation] = async () => {
          throw dbError("DATABASE_ENTITY_NOT_FOUND", `Unknown entity "${prop}" (db.${prop}.${operation}). Declared entities: ${known.join(", ") || "none"}`, { entity: prop, operation, known_entities: known });
        };
      }
      return missing;
    },
  });
}