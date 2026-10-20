// Certification suite for the DOCUMENTED Base44 entities SDK count surface (SDK 0.8.51):
//
//   count(query?) — DOCUMENTED (SDK reference + REST "Count entity records"):
//     • "Counts the records that match a query … in the same form filter() accepts".
//     • "Returns the number of records the current user can read, without fetching them"
//       (REST docs: "Number of records you can read in this entity").
//     • Returns a plain number (the SDK unwraps { count }); no pagination, no cursors.
//
// The suite drives the REAL createServerDb funnel (deployed runtime, preview and backend
// functions all read through it). Bridge/runtime forwarding of `query` is pass-through and
// is covered by the runtime surface suites — not here.
//
// Every behavior that upstream does NOT prove is certified only with its own label:
//   • NEXUSAI-DERIVED (non-parity): {}-equivalence fast-path, unknown-entity refusal shape,
//     zero-result rendering, scan mechanics.
//   • UNKNOWN (not claimed): User-entity special case, sample/seed + trash semantics,
//     snapshot consistency, query-size ceilings, per-call billing.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb } from "../../shared/appData.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// The certified contract, pinned so the suite states its own boundary.
const COUNT_CONTRACT = {
  transport: "DOCUMENTED — GET …/entities/{name}/count with the query as one JSON `q`; SDK unwraps { count }",
  no_query: "DOCUMENTED — undefined/null query means no filter; 'Defaults to all records'",
  empty_query: "NEXUSAI-DERIVED — {} is a real query that match-alls readable records; server-side equivalence with 'no filter' is NOT proven upstream",
  filtered: "DOCUMENTED — the query is evaluated verbatim, 'in the same form filter() accepts'",
  zero_result: "IMPLIED, not upstream test-pinned — no match renders as integer 0",
  operators: "DOCUMENTED — $or / array shorthand / comparison operators via the shared filter machine",
  return_shape: "DOCUMENTED — plain number; no { count } wrapper, no cursor/pagination fields",
  extra_args: "BOUNDARY — signature is count(query?); surplus positional args are inert (never interpreted)",
  visibility: "DOCUMENTED — 'the number of records the current user can read': read gate + RLS + project scope",
  unknown_entity: "NEXUSAI-DERIVED — structured DATABASE_ENTITY_NOT_FOUND (upstream 404 is proven only for list)",
  scan: "NEXUSAI-DERIVED — streaming batch count; no atomicity/consistency claim",
  billing: "NOT CLAIMED — count moves no credits in either pool (observed neutrality only)",
  user_entity: "UNKNOWN — Base44 documents a disconnected record set for the name 'User'; nothing claimed here",
  sample_trash: "UNKNOWN — sample/seed and trash inclusion semantics are not proven; nothing claimed here",
};

const ENTITIES = [
  { name: "Task", fields: { title: { type: "string" }, status: { type: "string" }, done: { type: "boolean" }, n: { type: "number" } } },
  { name: "Ledger", fields: { owner: { type: "string" }, body: { type: "string" } }, rls: { create: true, read: { "data.owner": "{{user.id}}" }, update: true, delete: true } },
];

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  try {
    const plan = await makeBillingPlan(db, created, `p911cnt${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p911cnt${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p911cnt");
    await grant(A.ws.id, "message", 50);
    await grant(A.ws.id, "integration", 50);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const P1 = await makeAgentProject(db, projectIds, A, stamp, "p911cnt");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p911cnt");
    const PR = await makeAgentProject(db, projectIds, A, stamp, "p911cnt");
    await db.entities.Project.update(PR.id, { rls_enabled: true });
    const userA1 = { id: `p911cnt_userA1_${stamp}`, email: "a1@p911cnt.test" };
    const userA2 = { id: `p911cnt_userA2_${stamp}`, email: "a2@p911cnt.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbR1 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });
    const dbR2 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA2 });
    // Same declarative rules, legacy owner-scoping OFF: the per-record read gate must do
    // the visibility work on its own — this is the canRead path, not the query shortcut.
    const dbG2 = createServerDb(db, PR.id, ENTITIES, { rls: false, user: userA2 });

    // Seed a deterministic Task world in P1.
    await db1.Task.bulkCreate([
      { title: "alpha", status: "open", done: false, n: 1 },
      { title: "beta", status: "open", done: false, n: 2 },
      { title: "gamma", status: "done", done: true, n: 3 },
      { title: "delta", status: "done", done: false, n: 4 },
      { title: "epsilon", status: "archived", done: true, n: 5 },
    ]);
    await appAgentPace(400);

    // ---- 1/2. no query / undefined / null: DOCUMENTED "defaults to all records" ---------
    const total = await db1.Task.count();
    const totalUndef = await db1.Task.count(undefined);
    const totalNull = await db1.Task.count(null);
    harness.check("no query: count() returns the full readable count (defaults to all records)",
      total === 5, JSON.stringify(total));
    harness.check("undefined query: identical to count()",
      totalUndef === total, JSON.stringify({ total, totalUndef }));
    harness.check("null query: identical to count() — no filter",
      totalNull === total, JSON.stringify({ total, totalNull }));

    // ---- 3. {} is a REAL query: match-all over readable records -------------------------
    // NEXUSAI-DERIVED equivalence: the server fast-paths {} to "no data filter", which is
    // behaviorally identical to matches(item, {}); upstream distinguishes q='{}' from an
    // absent q on the transport, and its server semantics are NOT proven.
    const totalEmpty = await db1.Task.count({});
    harness.check("{} query: remains a real query and counts every readable record (NEXUSAI-DERIVED equivalence, non-parity)",
      totalEmpty === total, JSON.stringify({ total, totalEmpty }));

    // ---- 4/5. filtered and zero-result counts -------------------------------------------
    const open = await db1.Task.count({ status: "open" });
    const done = await db1.Task.count({ status: "done" });
    harness.check("filtered: count evaluates the query verbatim through the filter machine",
      open === 2 && done === 2, JSON.stringify({ open, done }));
    const none = await db1.Task.count({ title: "no-such-title" });
    const noneBool = await db1.Task.count({ done: true, status: "open" });
    harness.check("zero-result: no match renders as integer 0 (IMPLIED, not upstream test-pinned)",
      none === 0 && noneBool === 0 && Number.isInteger(none), JSON.stringify({ none, noneBool }));

    // ---- 6. representative operators on the count path ---------------------------------
    const orCount = await db1.Task.count({ $or: [{ title: "alpha" }, { title: "beta" }] });
    harness.check("operators: top-level $or — ANY sub-query matches (documented shape)",
      orCount === 2, JSON.stringify(orCount));
    const arrCount = await db1.Task.count({ status: ["open", "done"] });
    harness.check("operators: array shorthand { field: [a, b] } matches any provided value",
      arrCount === 4, JSON.stringify(arrCount));
    const inCount = await db1.Task.count({ title: { $in: ["alpha", "gamma", "epsilon"] } });
    harness.check("operators: $in matches any listed value",
      inCount === 3, JSON.stringify(inCount));
    const rangeCount = await db1.Task.count({ n: { $gte: 3 } });
    const ltCount = await db1.Task.count({ n: { $lt: 3 } });
    harness.check("operators: comparison operators ($gte/$lt) bound the same way as filter()",
      rangeCount === 3 && ltCount === 2, JSON.stringify({ rangeCount, ltCount }));

    // ---- 7. plain numeric return shape ---------------------------------------------------
    const shapeProbe = await db1.Task.count({ status: "open" });
    harness.check("return shape: a primitive number — never { count }, a cursor or pagination fields",
      typeof shapeProbe === "number" && Number.isInteger(shapeProbe) && !Array.isArray(shapeProbe) && shapeProbe !== null,
      `${typeof shapeProbe}:${shapeProbe}`);

    // ---- 8. surplus positional args are inert (signature is count(query?)) --------------
    const extraArgs = await db1.Task.count({ status: "open" }, "-created_date", 99, "bogus");
    harness.check("boundary: surplus positional arguments neither alter nor reject the call",
      extraArgs === 2, JSON.stringify(extraArgs));

    // ---- 9. read-gate visibility: the per-record gate, independent of owner scoping ------
    await dbR1.Ledger.create({ owner: userA1.id, body: "a1-first" });
    await dbR1.Ledger.create({ owner: userA1.id, body: "a1-second" });
    await dbR2.Ledger.create({ owner: userA2.id, body: "a2-first" });
    await appAgentPace(400);
    const gateCount = await dbG2.Ledger.count();
    harness.check("read gate: with owner scoping off, the per-record read rule still counts ONLY readable rows",
      gateCount === 1, JSON.stringify(gateCount));

    // ---- 10. RLS owner isolation -----------------------------------------------------------
    const r1Count = await dbR1.Ledger.count();
    const r2Count = await dbR2.Ledger.count();
    const r2Foreign = await dbR2.Ledger.count({ owner: userA1.id });
    harness.check("RLS: per-owner counts are disjoint and sum to the seeded rows — another user's rows never counted",
      r1Count === 2 && r2Count === 1 && r2Foreign === 0 && r1Count + r2Count === 3,
      JSON.stringify({ r1: r1Count, r2: r2Count, foreign: r2Foreign }));

    // ---- 11. project isolation ---------------------------------------------------------------
    const p2 = await db2.Task.create({ title: "p2-only", status: "open", done: false, n: 9 });
    const iso1 = await db1.Task.count();
    const iso1Foreign = await db1.Task.count({ title: "p2-only" });
    const iso2 = await db2.Task.count({ title: "p2-only" });
    harness.check("isolation: one project's count never sees another project's records",
      iso1 === 5 && iso1Foreign === 0 && iso2 === 1 && !!p2.id,
      JSON.stringify({ iso1, iso1Foreign, iso2 }));

    // ---- 12. unknown entity: fail-closed, naming the attempted operation -------------------
    const unknown = await captureCall(() => db1.NotAnEntity.count());
    harness.check("unknown entity: refused with DATABASE_ENTITY_NOT_FOUND naming count (NEXUSAI-DERIVED shape, non-parity)",
      unknown.threw && unknown.code === "DATABASE_ENTITY_NOT_FOUND" && /count/.test(unknown.message || ""),
      JSON.stringify(unknown));

    // ---- 13. billing neutrality -------------------------------------------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: count moves no credits in either pool",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);

    // ---- 14. contract-boundary classification pinned ----------------------------------------
    harness.check("boundary: upstream-confirmed entries are labeled DOCUMENTED",
      COUNT_CONTRACT.transport.startsWith("DOCUMENTED") && COUNT_CONTRACT.no_query.startsWith("DOCUMENTED")
        && COUNT_CONTRACT.filtered.startsWith("DOCUMENTED") && COUNT_CONTRACT.visibility.startsWith("DOCUMENTED"),
      JSON.stringify(COUNT_CONTRACT));
    harness.check("boundary: {} equivalence and unknown-entity refusal are labeled NEXUSAI-DERIVED, not Base44 parity",
      COUNT_CONTRACT.empty_query.startsWith("NEXUSAI-DERIVED") && COUNT_CONTRACT.unknown_entity.startsWith("NEXUSAI-DERIVED")
        && COUNT_CONTRACT.scan.startsWith("NEXUSAI-DERIVED"),
      JSON.stringify(COUNT_CONTRACT));
    harness.check("boundary: User-entity and sample/trash semantics are UNKNOWN and NOT claimed",
      COUNT_CONTRACT.user_entity.startsWith("UNKNOWN") && COUNT_CONTRACT.sample_trash.startsWith("UNKNOWN"),
      JSON.stringify(COUNT_CONTRACT));

    // ---- 15. db exposure through the runtime export surface ---------------------------------
    harness.check("surface: the `db` export remains registered in the runtime export surface (count rides on it)",
      RUNTIME_EXPORTS.includes("db"), "db present");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p911cnt-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p911cnt" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p911cnt_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p911cnt[0-9]+$" } }).catch(() => {});
  }
}