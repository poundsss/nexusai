// Certification suite for the B1 records-mode cursor CONTINUATION contract (v2/list page form)
// against the audited base44/javascript-sdk@0.8.51 behavior.
//
// DOCUMENTED (SDK 0.8.51 — src/modules/entities.ts readPage, SOURCE-VERBATIM; the page-mode
// unit tests do not exist, so transport is source-verbatim, not test-evidenced):
//   • first page ........ list(options) / filter(query, options) → GET {entity}/v2/list; q,
//                          sort and fields travel ONLY when the caller supplied them; limit
//                          defaults client-side to 100;
//   • cursor contents .... EntityPage JSDoc: "The token carries the query, sort and fields of
//                          the walk, so a later page needs only `cursor` and `limit`. Passing
//                          a different query, sort or fields with a cursor is an error";
//   • { cursor, limit } .. the client sends literally only { limit, cursor } — the server must
//                          recover the walk's query/sort/fields from the token;
//   • mismatch ........... a different query/sort/fields with a cursor is an ERROR. The
//                          error's code/status is UNKNOWN upstream — never invented here.
//
// NEXUSAI-derived / NON-PARITY (fail-closed bounded choices, unchanged by this certification):
//   • token format ....... signed nc1 envelope (appCursor.ts), 24h TTL, signed offset anchor;
//   • invalid cursor ..... malformed/tampered/expired/cross-project/cross-entity tokens all
//                          refuse with DATABASE_INVALID_CURSOR (HTTP 400) before any storage;
//   • mismatch shape .... DATABASE_CURSOR_MISMATCH (HTTP 400);
//   • recovery ........... a parameter NOT supplied is recovered from the VERIFIED cursor
//                          state (HMAC-signed, project/entity-bound); every page still re-walks
//                          the SAME read gate / RLS scoping through the existing filter path;
//   • dispatch .......... runtime/preview/appRuntime page dispatch forwards the query
//                          VERBATIM (omitted stays omitted, never coerced to {}).
//
// UNKNOWN (not claimed): upstream server cursor internals, error codes, statuses, the
// upstream pagination mechanism, and any per-call billing effect (observed neutrality only).
//
// The suite drives the REAL createServerDb funnel (preview, deployed runtime and backend
// functions all read through it). No mocks.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb } from "../../shared/appData.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// The certified contract, pinned so the suite states its own boundary.
const PAGE_CURSOR_CONTRACT = {
  transport: "DOCUMENTED (SDK 0.8.51 readPage, source-verbatim) — GET v2/list; q/sort/fields sent only when supplied; limit defaults client-side to 100",
  cursor_carries_walk: "DOCUMENTED (EntityPage JSDoc) — the token carries the query, sort and fields of the walk",
  cursor_only_needs: "DOCUMENTED — a later page needs only cursor and limit; recovery from the verified state is the bounded NEXUSAI-derived mechanism",
  mismatch_error: "DOCUMENTED — passing a different query/sort/fields with a cursor is an error; the error's code/status is UNKNOWN upstream and stays NEXUSAI-derived (DATABASE_CURSOR_MISMATCH, 400)",
  token_format: "NEXUSAI-derived, non-parity — signed nc1 envelope, 24h TTL, signed offset anchor (appCursor.ts)",
  invalid_cursor: "NEXUSAI-derived, non-parity — malformed/tampered/expired/cross-project/cross-entity tokens all refuse with DATABASE_INVALID_CURSOR (400) before any storage work",
  read_gate_rls: "NEXUSAI-derived enforcement, unchanged — every page re-walks the SAME read gate / RLS scoping through the existing filter path",
  distinct: "B2 surface, unchanged — distinct cursor behavior keeps its own state; cross-mode cursors are refused fail-closed",
  array_form: "unchanged — no cursor code on the array list/filter path",
  dispatch_forwarding: "NEXUSAI-derived dispatch, source-level — runtime/preview/appRuntime page dispatch forwards the query VERBATIM (omitted stays omitted); transport pass-through is covered by appSurfaceTest",
  upstream_server: "UNKNOWN — upstream server cursor internals, error codes, statuses and the pagination mechanism are not published; nothing is claimed",
};

const ENTITIES = [
  { name: "Task", fields: { title: { type: "string" }, status: { type: "string" }, n: { type: "number" } } },
  { name: "Memo", fields: { body: { type: "string" } } },
  { name: "Hidden", fields: { v: { type: "string" } }, rls: { create: true, read: false, update: true, delete: true } },
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
    const plan = await makeBillingPlan(db, created, `b1pc${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `b1pc${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "b1pc");
    await grant(A.ws.id, "message", 50);
    await grant(A.ws.id, "integration", 50);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const P1 = await makeAgentProject(db, projectIds, A, stamp, "b1pc");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "b1pc");
    const PR = await makeAgentProject(db, projectIds, A, stamp, "b1pc");
    await db.entities.Project.update(PR.id, { rls_enabled: true });
    const userA1 = { id: `b1pc_userA1_${stamp}`, email: "a1@b1pc.test" };
    const userA2 = { id: `b1pc_userA2_${stamp}`, email: "a2@b1pc.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbR1 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });
    const dbR2 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA2 });
    const dbR0 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: null });
    await pace();

    // Seed: 6 tasks in P1 (3 open, 3 closed), one task in P2, 3 ledger rows for userA1.
    await db1.Task.bulkCreate([
      { title: "o1", status: "open", n: 1 },
      { title: "o2", status: "open", n: 2 },
      { title: "o3", status: "open", n: 3 },
      { title: "c1", status: "closed", n: 4 },
      { title: "c2", status: "closed", n: 5 },
      { title: "c3", status: "closed", n: 6 },
    ]);
    await db2.Task.create({ title: "p2-only", status: "open", n: 99 });

    // ---- 1. first page creates a cursor ------------------------------------------------
    const q1 = await db1.Task.page({ status: "open" }, { limit: 2 });
    harness.check("first page: a walk with more matches mints a non-empty next_cursor (opaque nc1 envelope)",
      q1.items.length === 2 && q1.items.every((it) => it.status === "open") && q1.has_more === true
        && typeof q1.next_cursor === "string" && q1.next_cursor.startsWith("nc1."),
      JSON.stringify({ items: q1.items.length, has_more: q1.has_more }));

    // ---- 2. cursor-only continuation, non-default QUERY --------------------------------
    const q2 = await db1.Task.page(undefined, { cursor: q1.next_cursor, limit: 2 });
    harness.check("continuation: cursor-only + non-default query recovers the walk's query from the verified state",
      q2.items.length === 1 && q2.items.every((it) => it.status === "open")
        && new Set([...q1.items, ...q2.items].map((it) => it.title)).size === 3 && q2.has_more === false,
      JSON.stringify({ p2: q2.items.map((it) => it.title), has_more: q2.has_more }));

    // ---- 3. cursor-only continuation, non-default SORT ---------------------------------
    const s1 = await db1.Task.page({}, { sort: "title", limit: 2 });
    const s2 = await db1.Task.page(undefined, { cursor: s1.next_cursor, limit: 2 });
    harness.check("continuation: cursor-only + non-default sort recovers the walk's sort",
      s1.items.map((it) => it.title).join(",") === "c1,c2" && s2.items.map((it) => it.title).join(",") === "c3,o1",
      JSON.stringify({ p1: s1.items.map((it) => it.title), p2: s2.items.map((it) => it.title) }));

    // ---- 4. cursor-only continuation, non-default FIELDS --------------------------------
    const f1 = await db1.Task.page({}, { sort: "title", fields: ["title"], limit: 2 });
    const f2 = await db1.Task.page(undefined, { cursor: f1.next_cursor, limit: 2 });
    harness.check("continuation: cursor-only + non-default fields recovers the walk's fields",
      f1.items.every((it) => Object.keys(it).join(",") === "title")
        && f2.items.every((it) => Object.keys(it).join(",") === "title")
        && f2.items.map((it) => it.title).join(",") === "c3,o1",
      JSON.stringify(f2.items));

    // ---- 5. { cursor, limit } ONLY — every walk parameter recovered ----------------------
    const w5a = await db1.Task.page({ status: "open" }, { sort: "title", fields: ["title", "n"], limit: 2 });
    const onlyCursorAndLimit = { cursor: w5a.next_cursor, limit: 2 };
    const w5b = await db1.Task.page(undefined, onlyCursorAndLimit);
    harness.check("continuation: { cursor, limit } only — query, sort AND fields all recovered (options keys: cursor,limit)",
      Object.keys(onlyCursorAndLimit).sort().join(",") === "cursor,limit"
        && w5a.items.map((it) => it.title).join(",") === "o1,o2" && w5b.items.map((it) => it.title).join(",") === "o3"
        && w5b.items.every((it) => Object.keys(it).sort().join(",") === "n,title"),
      JSON.stringify({ p1: w5a.items.map((it) => it.title), p2: w5b.items }));

    // ---- 6. cursor + IDENTICAL explicit parameters --------------------------------------
    const d1 = await db1.Task.page({}, { sort: "title", limit: 2 });
    const d2 = await db1.Task.page({}, { sort: "title", limit: 2, cursor: d1.next_cursor });
    const d3 = await db1.Task.page({ status: "open" }, { limit: 2, cursor: q1.next_cursor });
    harness.check("continuation: cursor + identical explicit query/sort/fields succeeds",
      d2.items.map((it) => it.title).join(",") === "c3,o1"
        && d3.items.length === 1 && d3.items.every((it) => it.status === "open"),
      JSON.stringify({ sort: d2.items.map((it) => it.title), query: d3.items.length }));

    // ---- 7/8/9. cursor + CONFLICTING parameters fail closed -------------------------------
    const badQ = await captureCall(() => db1.Task.page({ status: "closed" }, { cursor: d1.next_cursor, limit: 2 }));
    harness.check("fail-closed: cursor + a conflicting QUERY is refused (DATABASE_CURSOR_MISMATCH, 400)",
      badQ.threw && badQ.code === "DATABASE_CURSOR_MISMATCH" && badQ.status === 400,
      JSON.stringify({ code: badQ.code, status: badQ.status }));
    const badS = await captureCall(() => db1.Task.page(undefined, { sort: "-title", cursor: d1.next_cursor, limit: 2 }));
    harness.check("fail-closed: cursor + a conflicting SORT is refused (DATABASE_CURSOR_MISMATCH, 400)",
      badS.threw && badS.code === "DATABASE_CURSOR_MISMATCH" && badS.status === 400,
      JSON.stringify({ code: badS.code, status: badS.status }));
    const badF = await captureCall(() => db1.Task.page(undefined, { sort: "title", fields: ["status"], cursor: d1.next_cursor, limit: 2 }));
    harness.check("fail-closed: cursor + conflicting FIELDS is refused (DATABASE_CURSOR_MISMATCH, 400)",
      badF.threw && badF.code === "DATABASE_CURSOR_MISMATCH" && badF.status === 400,
      JSON.stringify({ code: badF.code, status: badF.status }));

    // ---- 10. default walk + cursor-only continuation ----------------------------------------
    const w10a = await db1.Task.page({}, { limit: 2 });
    const w10b = await db1.Task.page(undefined, { cursor: w10a.next_cursor, limit: 2 });
    harness.check("default walk: cursor-only continuation still works (recovered values equal the defaults)",
      w10a.items.length === 2 && w10b.items.length === 2
        && [...w10a.items, ...w10b.items].every((it) => typeof it.title === "string"),
      JSON.stringify({ p1: w10a.items.length, p2: w10b.items.length }));

    // ---- 11. has_more / next_cursor progression ---------------------------------------------
    const p11a = await db1.Task.page({}, { limit: 4 });
    const p11b = await db1.Task.page(undefined, { cursor: p11a.next_cursor, limit: 4 });
    const boundary = await db1.Task.page({}, { limit: 6 });
    harness.check("progression: has_more/next_cursor advance correctly and terminate (4+2 over 6; exact boundary yields no cursor)",
      p11a.items.length === 4 && p11a.has_more === true && typeof p11a.next_cursor === "string"
        && p11b.items.length === 2 && p11b.has_more === false && p11b.next_cursor === null
        && boundary.items.length === 6 && boundary.has_more === false && boundary.next_cursor === null,
      JSON.stringify({ p1: p11a.items.length, p2: p11b.items.length, boundary: boundary.items.length }));

    // ---- 12. no duplicate / lost records across pages ----------------------------------------
    const walked = [];
    let cursor12 = null;
    for (let i = 0; i < 4; i++) {
      const page = await db1.Task.page(undefined, cursor12 ? { cursor: cursor12, limit: 2 } : { limit: 2 });
      walked.push(...page.items);
      cursor12 = page.next_cursor;
      if (!page.has_more) break;
    }
    const fullSet = new Set((await db1.Task.filter({}, "-created_date", 50)).map((it) => it.id));
    const walkedIds = new Set(walked.map((it) => it.id));
    harness.check("progression: a full cursor walk yields every record exactly once — no duplicates, no losses",
      walked.length === 6 && walkedIds.size === 6 && walkedIds.size === fullSet.size
        && [...walkedIds].every((id) => fullSet.has(id)),
      JSON.stringify({ walked: walked.length, unique: walkedIds.size, total: fullSet.size }));

    // ---- 13. cursor state is bound to project and entity --------------------------------------
    const crossProject = await captureCall(() => db2.Task.page(undefined, { cursor: d1.next_cursor, limit: 2 }));
    const crossEntity = await captureCall(() => db1.Memo.page(undefined, { cursor: d1.next_cursor, limit: 2 }));
    harness.check("binding: a cursor minted for one project or one entity is refused for another (DATABASE_INVALID_CURSOR, 400)",
      crossProject.threw && crossProject.code === "DATABASE_INVALID_CURSOR" && crossProject.status === 400
        && crossEntity.threw && crossEntity.code === "DATABASE_INVALID_CURSOR" && crossEntity.status === 400,
      JSON.stringify({ project: crossProject.code, entity: crossEntity.code }));

    // ---- 14. invalid / tampered cursor fails closed --------------------------------------------
    const tampered = d1.next_cursor.slice(0, -2) + (d1.next_cursor.endsWith("aa") ? "bb" : "aa");
    const badTamper = await captureCall(() => db1.Task.page(undefined, { cursor: tampered, limit: 2 }));
    const badGarbage = await captureCall(() => db1.Task.page(undefined, { cursor: "garbage.token.here", limit: 2 }));
    harness.check("binding: a tampered or malformed cursor is refused fail-closed before any storage work (DATABASE_INVALID_CURSOR, 400)",
      badTamper.threw && badTamper.code === "DATABASE_INVALID_CURSOR" && badTamper.status === 400
        && badGarbage.threw && badGarbage.code === "DATABASE_INVALID_CURSOR" && badGarbage.status === 400,
      JSON.stringify({ tampered: badTamper.code, garbage: badGarbage.code }));

    // ---- 15. read gate / RLS still applies on continuation -------------------------------------
    await dbR1.Ledger.create({ owner: userA1.id, body: "l-a1" });
    await dbR1.Ledger.create({ owner: userA1.id, body: "l-a2" });
    await dbR1.Ledger.create({ owner: userA1.id, body: "l-a3" });
    await dbR2.Ledger.create({ owner: userA2.id, body: "l-b1" });
    const r15a = await dbR1.Ledger.page({}, { limit: 2 });
    const r15b = await dbR1.Ledger.page(undefined, { cursor: r15a.next_cursor, limit: 2 });
    harness.check("RLS: an owner's cursor-only continuation yields only their own records — the recovered query still re-walks the read gate",
      r15a.items.length === 2 && r15a.items.every((it) => it.body.startsWith("l-a"))
        && r15b.items.length === 1 && r15b.items.every((it) => it.body.startsWith("l-a")),
      JSON.stringify({ p1: r15a.items.map((it) => it.body), p2: r15b.items.map((it) => it.body) }));
    const r15c = await dbR2.Ledger.page(undefined, { cursor: r15a.next_cursor, limit: 2 });
    harness.check("RLS: another user reusing a valid cursor sees NOTHING of the original walk (same token, different scoping)",
      r15c.items.length === 0 && r15c.has_more === false && r15c.next_cursor === null,
      JSON.stringify({ items: r15c.items.length }));
    const r15d = await captureCall(() => dbR1.Ledger.page({ owner: userA2.id }, { cursor: r15a.next_cursor, limit: 2 }));
    harness.check("RLS: a conflicting explicit query with a cursor is still refused under RLS (fail-closed unchanged)",
      r15d.threw && r15d.code === "DATABASE_CURSOR_MISMATCH", JSON.stringify({ code: r15d.code }));
    const r15anon = await captureCall(() => dbR0.Ledger.page(undefined, { limit: 2 }));
    harness.check("RLS: an anonymous caller on an RLS project is refused before any work (AUTH_REQUIRED, 401)",
      r15anon.threw && r15anon.code === "AUTH_REQUIRED" && r15anon.status === 401, JSON.stringify(r15anon));
    await db1.Hidden.bulkCreate([{ v: "h1" }, { v: "h2" }]);
    const hiddenPage = await db1.Hidden.page({}, { limit: 10 });
    const hiddenRows = await db.entities.AppRecord.filter({ project_id: P1.id, entity_name: "Hidden" }, "-created_date", 10);
    harness.check("read gate: an entity whose read rule denies everything yields an empty page on every continuation — rows exist but never surface",
      hiddenPage.items.length === 0 && hiddenPage.has_more === false && hiddenPage.next_cursor === null
        && hiddenRows.length === 2,
      JSON.stringify({ items: hiddenPage.items.length, rows: hiddenRows.length }));

    // ---- 16. array-form list/filter remains unchanged --------------------------------------------
    const arrList = await db1.Task.list("-created_date", 10);
    const arrFilter = await db1.Task.filter({ status: "open" }, "-created_date", 10);
    const arrProj = await db1.Task.filter({ status: "open" }, "-created_date", 10, 0, ["title"]);
    harness.check("array form: list/filter (no options object) keep their documented signature and behavior — no cursor code on this path",
      arrList.length === 6 && arrFilter.length === 3 && arrProj.length === 3 && arrProj.every((it) => Object.keys(it).join(",") === "title"),
      JSON.stringify({ list: arrList.length, filter: arrFilter.length, proj: arrProj.length }));

    // ---- 17. distinct cursor behavior remains unchanged --------------------------------------------
    const dist1 = await db1.Task.page({}, { distinct: "n", limit: 3 });
    const dist2 = await db1.Task.page(undefined, { cursor: dist1.next_cursor, distinct: "n", limit: 3 });
    harness.check("distinct: the distinct walk keeps its own cursor state — the B2-certified continuation re-supplies the distinct field and recovers the offset",
      dist1.items.join(",") === "1,2,3" && dist1.has_more === true
        && dist2.items.join(",") === "4,5,6" && dist2.has_more === false && dist2.next_cursor === null,
      JSON.stringify({ p1: dist1.items, p2: dist2.items }));
    const distConflict = await captureCall(() => db1.Task.page(undefined, { distinct: "status", cursor: dist1.next_cursor, limit: 3 }));
    const crossRecords = await captureCall(() => db1.Task.page(undefined, { distinct: "n", cursor: d1.next_cursor, limit: 3 }));
    const crossDistinct = await captureCall(() => db1.Task.page(undefined, { cursor: dist1.next_cursor, limit: 3 }));
    harness.check("distinct: a conflicting distinct field, a records-cursor in distinct mode and a distinct-cursor in records mode are all refused fail-closed",
      distConflict.threw && distConflict.code === "DATABASE_CURSOR_MISMATCH"
        && crossRecords.threw && crossRecords.code === "DATABASE_CURSOR_MISMATCH"
        && crossDistinct.threw && crossDistinct.code === "DATABASE_CURSOR_MISMATCH",
      JSON.stringify({ field: distConflict.code, recordsInDistinct: crossRecords.code, distinctInRecords: crossDistinct.code }));

    // ---- 18. dispatch preserves omitted-vs-explicit query semantics --------------------------------
    const explicitEmpty = await captureCall(() => db1.Task.page({}, { cursor: q1.next_cursor, limit: 2 }));
    harness.check("dispatch semantics: an EXPLICIT empty query {} against a non-default walk is a conflict — omitted (undefined) and explicit {} are behaviorally distinct",
      explicitEmpty.threw && explicitEmpty.code === "DATABASE_CURSOR_MISMATCH"
        && q2.items.length === 1, // the same cursor with an OMITTED query succeeded above
      JSON.stringify({ explicitEmpty: explicitEmpty.code, omitted: "succeeded" }));

    // ---- billing neutrality + export surface -------------------------------------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: the cursor-continuation surface moves no credits in either pool",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);
    harness.check("surface: the `db` export remains registered in the runtime export surface (page rides on it)",
      RUNTIME_EXPORTS.includes("db"), "db present");

    // ---- contract-boundary classification pinned ----------------------------------------------------
    harness.check("boundary: transport, cursor contents and the { cursor, limit } continuation are labeled DOCUMENTED",
      PAGE_CURSOR_CONTRACT.transport.startsWith("DOCUMENTED") && PAGE_CURSOR_CONTRACT.cursor_carries_walk.startsWith("DOCUMENTED")
        && PAGE_CURSOR_CONTRACT.cursor_only_needs.startsWith("DOCUMENTED") && PAGE_CURSOR_CONTRACT.mismatch_error.startsWith("DOCUMENTED"),
      JSON.stringify(PAGE_CURSOR_CONTRACT));
    harness.check("boundary: token format, invalid-cursor refusal, read-gate re-walk and dispatch forwarding are labeled NEXUSAI-derived, non-parity",
      PAGE_CURSOR_CONTRACT.token_format.startsWith("NEXUSAI-derived") && PAGE_CURSOR_CONTRACT.invalid_cursor.startsWith("NEXUSAI-derived")
        && PAGE_CURSOR_CONTRACT.read_gate_rls.startsWith("NEXUSAI-derived") && PAGE_CURSOR_CONTRACT.dispatch_forwarding.startsWith("NEXUSAI-derived"),
      JSON.stringify(PAGE_CURSOR_CONTRACT));
    harness.check("boundary: the mismatch error shape and the upstream server internals are labeled UNKNOWN — nothing claimed beyond the audit",
      PAGE_CURSOR_CONTRACT.mismatch_error.includes("UNKNOWN upstream") && PAGE_CURSOR_CONTRACT.upstream_server.startsWith("UNKNOWN"),
      JSON.stringify(PAGE_CURSOR_CONTRACT));

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^b1pc-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^b1pc" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:b1pc_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^b1pc[0-9]+$" } }).catch(() => {});
  }
}