// Certification suite for the IMPLEMENTED Phase B3 aggregate surface (base44/shared/appData.ts),
// pinned against the DOCUMENTED Base44 SDK 0.8.51 contract (EntityAggregateSpec /
// EntityAggregateResult + the entities module). The suite drives the REAL createServerDb funnel —
// the deployed runtime, the preview and backend functions all route db ops through it; the
// bridge/preview/runtime op registration is pass-through (args travel verbatim).
//
// CERTIFIED (DOCUMENTED, 0.8.51):
//   • aggregate(spec) — spec verbatim, result { rows, truncated }, no cursor pagination;
//   • query filters BEFORE grouping; groupBy field or up to 4 fields; no groupBy = ONE total row;
//   • dateBucket day/week/month/year, `week` only for created_date/updated_date (schema date
//     fields day/month/year); count default true; sum/avg/min/max field or fields with the
//     confirmed output names; countDistinct exactly one field; having filters computed fields
//     post-group; sort one string with '-' desc; limit default/cap 1,000; truncated = groups
//     exceed the limit.
//   • raw Mongo pipeline: NOT part of 0.8.51 — NOT implemented.
//
// Everything the SDK does NOT pin is certified here ONLY as a bounded NEXUSAI-derived choice
// (see AGG_CONTRACT) — the suite never claims these are Base44 behavior.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb } from "../../shared/appData.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { appAgentPace, makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

// The certified contract, pinned so the suite states its own boundary.
const AGG_CONTRACT = {
  surface: "DOCUMENTED (SDK 0.8.51) — aggregate(spec) verbatim, result { rows, truncated }",
  group_by: "DOCUMENTED — field or array, max 4; omitted = one total row",
  date_bucket: "DOCUMENTED — day/week/month/year; week only for created_date/updated_date; schema date fields day/month/year",
  measures: "DOCUMENTED — count default true; sum/avg/min/max field or array; countDistinct exactly one field; confirmed output names",
  having_sort_limit: "DOCUMENTED — having filters computed fields post-group; sort one string '-' desc; limit default/cap 1,000; truncated = groups exceed limit",
  pipeline: "NOT part of 0.8.51 — NOT implemented; unknown spec keys are IGNORED (NEXUSAI-derived, non-parity)",
  cursor: "NOT exposed — no aggregate cursor pagination; the result carries only rows/truncated",
  // ---- NEXUSAI-derived, explicitly NON-PARITY (never claimed as Base44 behavior) ----
  scan_ceiling: "NEXUSAI-derived, non-parity — explicit refusal past 50,000 matched records (DATABASE_AGG_SCAN_EXCEEDED), never a partial answer",
  numeric_null: "NEXUSAI-derived, non-parity — only finite numbers aggregate; null/undefined/non-numeric are skipped; empty set: sum 0, avg/min/max null",
  count_distinct_null_array: "NEXUSAI-derived, non-parity — null/undefined are not distinct; an array counts as ONE value",
  having_ops: "NEXUSAI-derived, non-parity — the EXISTING query operator set via matches(); malformed conditions drop the group (fail-closed)",
  week_utc_iso: "NEXUSAI-derived, non-parity — buckets are UTC ISO prefixes; week is ISO-8601 Monday-start YYYY-Www",
  datebucket_groupby_collision: "NEXUSAI-derived, fail-closed — a dateBucket field that is ALSO a groupBy field is refused (upstream semantics UNKNOWN)",
  invalid_field: "NEXUSAI-derived, fail-closed — fields outside the schema (+ built-ins) are refused with DATABASE_VALIDATION_FAILED",
  limit_clamp: "NEXUSAI-derived, non-parity — a limit above 1,000 CLAMPS to 1,000 (clamp-vs-reject is UNKNOWN upstream)",
  unsorted_order: "NEXUSAI-derived, non-parity — no sort = first-seen scan order",
  key_order: "NEXUSAI-derived, non-parity — group fields in spec order, then the bucket field, then count, then measures",
};

const ENTITIES = [
  { name: "Task", fields: { title: { type: "string" }, status: { type: "string" }, n: { type: "number" }, due: { type: "date" }, tags: { type: "array" } } },
  { name: "Sealed", fields: { body: { type: "string" } }, rls: { create: true, read: false, update: true, delete: true } },
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
    const plan = await makeBillingPlan(db, created, `p9xa${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9xa${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p9xa");
    await grant(A.ws.id, "message", 50);
    await grant(A.ws.id, "integration", 50);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const P1 = await makeAgentProject(db, projectIds, A, stamp, "p9xa");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p9xa");
    const PR = await makeAgentProject(db, projectIds, A, stamp, "p9xa");
    await db.entities.Project.update(PR.id, { rls_enabled: true });
    const userA1 = { id: `p9xa_userA1_${stamp}`, email: "a1@p9xa.test" };
    const userA2 = { id: `p9xa_userA2_${stamp}`, email: "a2@p9xa.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbR1 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });
    const dbR2 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA2 });

    // Seed: batch A (older, status done), then a pause, then batch B (newer, status open) —
    // so the -created_date scan order and therefore the unsorted first-seen order is known.
    await db1.Task.bulkCreate([
      { title: "a1", status: "done", n: 10, due: "2026-01-15" },
      { title: "a2", status: "done", n: 20, due: "2026-01-20" },
      { title: "a3", status: "done", n: 30, due: "2026-02-10" },
      { title: "a4", status: "done" },
    ]);
    await pace(700);
    await db1.Task.bulkCreate([
      { title: "b1", status: "open", n: 5, due: "2026-03-05" },
      { title: "b2", status: "open", n: 15, due: "2026-03-25" },
      { title: "b3", status: "open", tags: ["x", "y"] },
      { title: "b4", status: "open", n: 25, tags: ["x", "z"] },
    ]);

    // ---- 1/4/5/12. dispatch, total row, count default, response shape --------------------
    const total = await db1.Task.aggregate({});
    harness.check("dispatch: aggregate is reachable through the REAL createServerDb funnel; result is exactly { rows, truncated }",
      Object.keys(total).join(",") === "rows,truncated" && Array.isArray(total.rows)
        && total.rows.length === 1 && total.rows[0].count === 8 && total.truncated === false
        && !("next_cursor" in total) && !("has_more" in total),
      JSON.stringify(total));
    harness.check("no groupBy: ONE aggregate row, keys exactly [count] (count default true)",
      total.rows.length === 1 && Object.keys(total.rows[0]).join(",") === "count",
      JSON.stringify(total.rows[0]));

    // ---- 2. query filters BEFORE grouping -------------------------------------------------
    const qAgg = await db1.Task.aggregate({ query: { status: "open" }, groupBy: "status" });
    harness.check("query: filters BEFORE grouping (exact match)",
      qAgg.rows.length === 1 && qAgg.rows[0].status === "open" && qAgg.rows[0].count === 4,
      JSON.stringify(qAgg.rows));
    const qAggOp = await db1.Task.aggregate({ query: { n: { $gt: 15 } }, groupBy: "status" });
    harness.check("query: carries the documented filter-operator form (field operators apply pre-group)",
      qAggOp.rows.length === 2
        && qAggOp.rows.find((r) => r.status === "done").count === 2
        && qAggOp.rows.find((r) => r.status === "open").count === 1,
      JSON.stringify(qAggOp.rows));

    // ---- 3. groupBy string and array ------------------------------------------------------
    const byStatus = await db1.Task.aggregate({ groupBy: "status" });
    const counts = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count]));
    harness.check("groupBy string: one row per group with per-group count",
      byStatus.rows.length === 2 && counts.open === 4 && counts.done === 4,
      JSON.stringify(byStatus.rows));
    harness.check("unsorted: rows keep first-seen scan order (NEXUSAI-derived, non-parity)",
      byStatus.rows.map((r) => r.status).join(",") === "open,done",
      JSON.stringify(byStatus.rows.map((r) => r.status)));
    const byTwo = await db1.Task.aggregate({ groupBy: ["status", "due"] });
    const openNull = byTwo.rows.find((r) => r.status === "open" && r.due === null);
    harness.check("groupBy array: groups over both fields; a missing field groups as null (derived)",
      byTwo.rows.length === 7 && !!openNull && openNull.count === 2,
      JSON.stringify(byTwo.rows.map((r) => `${r.status}/${r.due}:${r.count}`)));
    harness.check("key order: group fields in spec order, then count (NEXUSAI-derived, non-parity)",
      byTwo.rows.every((r) => Object.keys(r).join(",") === "status,due,count"),
      JSON.stringify(Object.keys(byTwo.rows[0])));

    // ---- 5. count default / count:false ---------------------------------------------------
    const noCount = await db1.Task.aggregate({ groupBy: "status", count: false });
    harness.check("count:false: the count key is omitted from every row (derived, non-parity)",
      noCount.rows.length === 2 && noCount.rows.every((r) => Object.keys(r).join(",") === "status"),
      JSON.stringify(noCount.rows[0]));

    // ---- 6. sum/avg/min/max ---------------------------------------------------------------
    const doneAgg = await db1.Task.aggregate({ query: { status: "done" }, sum: "n", avg: "n", min: "n", max: "n" });
    harness.check("sum/avg/min/max: confirmed output names and values; non-numeric records are skipped (derived)",
      doneAgg.rows.length === 1 && doneAgg.rows[0].count === 4
        && doneAgg.rows[0].sum_n === 60 && doneAgg.rows[0].avg_n === 20
        && doneAgg.rows[0].min_n === 10 && doneAgg.rows[0].max_n === 30
        && Object.keys(doneAgg.rows[0]).join(",") === "count,sum_n,avg_n,min_n,max_n",
      JSON.stringify(doneAgg.rows[0]));
    const emptyAgg = await db1.Task.aggregate({ query: { title: "a4" }, sum: "n", avg: "n", min: "n", max: "n" });
    harness.check("empty measure set: sum 0, avg/min/max null — never coerced (NEXUSAI-derived, non-parity)",
      emptyAgg.rows.length === 1 && emptyAgg.rows[0].count === 1 && emptyAgg.rows[0].sum_n === 0
        && emptyAgg.rows[0].avg_n === null && emptyAgg.rows[0].min_n === null && emptyAgg.rows[0].max_n === null,
      JSON.stringify(emptyAgg.rows[0]));

    // ---- 7. countDistinct -----------------------------------------------------------------
    const cd = await db1.Task.aggregate({ groupBy: "status", countDistinct: "n" });
    const cdBy = Object.fromEntries(cd.rows.map((r) => [r.status, r.count_distinct_n]));
    harness.check("countDistinct: count_distinct_<field>; null/undefined are not distinct values (derived)",
      cd.rows.every((r) => Object.keys(r).join(",") === "status,count,count_distinct_n")
        && cdBy.done === 3 && cdBy.open === 3,
      JSON.stringify(cd.rows));
    const cdTags = await db1.Task.aggregate({ groupBy: "status", countDistinct: "tags" });
    const cdTagsBy = Object.fromEntries(cdTags.rows.map((r) => [r.status, r.count_distinct_tags]));
    harness.check("countDistinct: an array value counts as ONE value, no element explosion (derived, non-parity)",
      cdTagsBy.done === 0 && cdTagsBy.open === 2,
      JSON.stringify(cdTagsBy));
    const cdTwo = await captureCall(() => db1.Task.aggregate({ countDistinct: ["n", "title"] }));
    harness.check("countDistinct: refuses more than one field (documented single field)",
      cdTwo.threw && cdTwo.code === "DATABASE_VALIDATION_FAILED", JSON.stringify(cdTwo));

    // ---- 8. dateBucket ---------------------------------------------------------------------
    const byMonth = await db1.Task.aggregate({ dateBucket: { field: "due", unit: "month" } });
    const mBy = Object.fromEntries(byMonth.rows.map((r) => [String(r.due), r.count]));
    harness.check("dateBucket month on a schema date field: UTC YYYY-MM buckets; unparsable/missing date groups as null (derived)",
      byMonth.rows.length === 4 && mBy["2026-01"] === 2 && mBy["2026-02"] === 1 && mBy["2026-03"] === 2 && mBy["null"] === 3
        && byMonth.rows.every((r) => Object.keys(r).join(",") === "due,count"),
      JSON.stringify(mBy));
    const byDay = await db1.Task.aggregate({ query: { title: "a1" }, dateBucket: { field: "due", unit: "day" } });
    harness.check("dateBucket day on a schema date field: UTC YYYY-MM-DD bucket",
      byDay.rows.length === 1 && byDay.rows[0].due === "2026-01-15", JSON.stringify(byDay.rows));
    const byWeek = await db1.Task.aggregate({ dateBucket: { field: "created_date", unit: "week" } });
    harness.check("dateBucket week on created_date: ISO-8601 Monday-start YYYY-Www label in UTC (derived, non-parity)",
      byWeek.rows.length === 1 && byWeek.rows[0].count === 8 && /^2\d{3}-W\d{2}$/.test(byWeek.rows[0].created_date),
      JSON.stringify(byWeek.rows[0]));
    const weekCustom = await captureCall(() => db1.Task.aggregate({ dateBucket: { field: "due", unit: "week" } }));
    harness.check("dateBucket: week is refused on a schema date field (confirmed restriction)",
      weekCustom.threw && weekCustom.code === "DATABASE_VALIDATION_FAILED", JSON.stringify(weekCustom));
    const bucketNonDate = await captureCall(() => db1.Task.aggregate({ dateBucket: { field: "status", unit: "day" } }));
    harness.check("dateBucket: a non-date field is refused fail-closed (derived)",
      bucketNonDate.threw && bucketNonDate.code === "DATABASE_VALIDATION_FAILED", JSON.stringify(bucketNonDate));
    const collide = await captureCall(() => db1.Task.aggregate({ groupBy: "due", dateBucket: { field: "due", unit: "month" } }));
    harness.check("dateBucket+groupBy: the same field in both is refused — output-key collision (derived fail-closed)",
      collide.threw && collide.code === "DATABASE_VALIDATION_FAILED", JSON.stringify(collide));

    // ---- 9. having -------------------------------------------------------------------------
    const hv = await db1.Task.aggregate({ groupBy: "due", having: { count: { $gt: 1 } } });
    harness.check("having: filters computed fields AFTER grouping (documented example: { count: { $gt: 1 } })",
      hv.rows.length === 1 && hv.rows[0].due === null && hv.rows[0].count === 3,
      JSON.stringify(hv.rows));
    const hvBad = await db1.Task.aggregate({ groupBy: "due", having: { count: { $bogus: 1 } } });
    harness.check("having: an unknown operator drops the group fail-closed (derived, non-parity)",
      hvBad.rows.length === 0 && hvBad.truncated === false, JSON.stringify(hvBad));

    // ---- 10. single-field sort, ascending and descending -------------------------------------
    const sDesc = await db1.Task.aggregate({ groupBy: "due", sort: "-count" });
    harness.check("sort: '-count' orders the computed count descending (null group first)",
      sDesc.rows[0].count === 3 && sDesc.rows[0].due === null && sDesc.rows[1].count === 1,
      JSON.stringify(sDesc.rows.map((r) => `${r.due}:${r.count}`)));
    const sAsc = await db1.Task.aggregate({ groupBy: "due", sort: "count" });
    harness.check("sort: 'count' orders ascending (the null-due group is last)",
      sAsc.rows[sAsc.rows.length - 1].due === null && sAsc.rows[sAsc.rows.length - 1].count === 3
        && sAsc.rows[0].count === 1,
      JSON.stringify(sAsc.rows.map((r) => `${r.due}:${r.count}`)));
    const sBad = await captureCall(() => db1.Task.aggregate({ groupBy: "due", sort: "nope" }));
    const sArr = await captureCall(() => db1.Task.aggregate({ groupBy: "due", sort: ["count"] }));
    harness.check("sort: exactly one string; a non-group/computed field or a non-string is refused (derived fail-closed)",
      sBad.threw && sBad.code === "DATABASE_VALIDATION_FAILED" && sArr.threw && sArr.code === "DATABASE_VALIDATION_FAILED",
      JSON.stringify({ sBad: sBad.code, sArr: sArr.code }));

    // ---- 11. limit and truncated -------------------------------------------------------------
    const lim = await db1.Task.aggregate({ groupBy: "due", limit: 2, sort: "due" });
    harness.check("limit: returns the first N rows after sort; truncated is true when groups exceed the limit",
      lim.rows.length === 2 && lim.truncated === true
        && lim.rows.map((r) => r.due).join(",") === "2026-01-15,2026-01-20",
      JSON.stringify(lim));
    const noLim = await db1.Task.aggregate({ groupBy: "due", limit: 10 });
    harness.check("limit: no truncation when groups fit; omitted limit covers every group (default 1,000)",
      noLim.rows.length === 6 && noLim.truncated === false, JSON.stringify({ rows: noLim.rows.length, truncated: noLim.truncated }));

    // ---- 14. raw Mongo pipeline: NOT supported ------------------------------------------------
    const pipe = await captureCall(() => db1.Task.aggregate({ pipeline: [{ $group: { _id: null, t: { $sum: "$n" } } }] }));
    harness.check("raw pipeline: NOT part of 0.8.51 — an unknown spec key has NO effect; the total row returns unchanged",
      !pipe.threw && pipe.value.rows.length === 1 && pipe.value.rows[0].count === 8
        && !("_id" in pipe.value.rows[0]) && Object.keys(pipe.value).join(",") === "rows,truncated",
      JSON.stringify(pipe.threw ? pipe : pipe.value));

    // ---- 15. no aggregate cursor ----------------------------------------------------------------
    harness.check("cursor: aggregate exposes no cursor pagination — every result carries only rows/truncated",
      Object.keys(total).join(",") === "rows,truncated" && !("next_cursor" in total) && !("has_more" in total)
        && Object.keys(lim).join(",") === "rows,truncated",
      "rows,truncated only");

    // ---- invalid spec/fields (derived fail-closed) -----------------------------------------------
    const specBad = await captureCall(() => db1.Task.aggregate("nope"));
    const qBad = await captureCall(() => db1.Task.aggregate({ query: "nope" }));
    const hvArr = await captureCall(() => db1.Task.aggregate({ having: [1] }));
    const cntBad = await captureCall(() => db1.Task.aggregate({ count: "yes" }));
    harness.check("invalid spec: non-object spec/query/having/count are refused with a structured validation error",
      specBad.threw && qBad.threw && hvArr.threw && cntBad.threw
        && [specBad, qBad, hvArr, cntBad].every((c) => c.code === "DATABASE_VALIDATION_FAILED"),
      JSON.stringify({ spec: specBad.code, query: qBad.code, having: hvArr.code, count: cntBad.code }));
    const gbBad = await captureCall(() => db1.Task.aggregate({ groupBy: "nope" }));
    const smBad = await captureCall(() => db1.Task.aggregate({ sum: "nope" }));
    const gb5 = await captureCall(() => db1.Task.aggregate({ groupBy: ["title", "status", "n", "due", "tags"] }));
    harness.check("invalid fields: groupBy/measure fields outside the schema, and >4 groupBy fields, are refused",
      gbBad.threw && smBad.threw && gb5.threw
        && [gbBad, smBad, gb5].every((c) => c.code === "DATABASE_VALIDATION_FAILED"),
      JSON.stringify({ groupBy: gbBad.code, sum: smBad.code, five: gb5.code }));

    // ---- 13. project isolation, RLS and the read gate ---------------------------------------------
    await db2.Task.create({ title: "p2-only", status: "open", n: 99 });
    const p2Agg = await db2.Task.aggregate({ groupBy: "status" });
    const p1Still = await db1.Task.aggregate({});
    harness.check("isolation: an aggregate in one project never sees another project's records",
      p2Agg.rows.length === 1 && p2Agg.rows[0].count === 1 && p1Still.rows[0].count === 8,
      JSON.stringify({ p2: p2Agg.rows, p1: p1Still.rows[0].count }));
    await dbR1.Ledger.create({ owner: userA1.id, body: "mine" });
    await dbR2.Ledger.create({ owner: userA2.id, body: "theirs" });
    const r1Agg = await dbR1.Ledger.aggregate({ groupBy: "body" });
    const r2Agg = await dbR2.Ledger.aggregate({ groupBy: "body" });
    harness.check("RLS: aggregate keeps per-owner isolation — each user sees only their own groups",
      r1Agg.rows.length === 1 && r1Agg.rows[0].body === "mine"
        && r2Agg.rows.length === 1 && r2Agg.rows[0].body === "theirs",
      JSON.stringify({ r1: r1Agg.rows, r2: r2Agg.rows }));
    await db1.Sealed.create({ body: "sealed" });
    const sealedAgg = await db1.Sealed.aggregate({ groupBy: "body" });
    harness.check("read gate: an entity with a deny read rule aggregates NOTHING — { rows: [], truncated: false }",
      sealedAgg.rows.length === 0 && sealedAgg.truncated === false, JSON.stringify(sealedAgg));
    const unknownAgg = await captureCall(() => db1.NotAnEntity.aggregate({}));
    harness.check("isolation: an unknown entity is refused fail-closed, naming the aggregate operation",
      unknownAgg.threw && unknownAgg.code === "DATABASE_ENTITY_NOT_FOUND" && /aggregate/.test(unknownAgg.message || ""),
      JSON.stringify(unknownAgg));

    // ---- billing neutrality ------------------------------------------------------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: the aggregate surface moves no credits in either pool",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);

    // ---- boundary pins ------------------------------------------------------------------------------
    harness.check("boundary: raw pipeline NOT implemented, no cursor pagination — neither is claimed",
      AGG_CONTRACT.pipeline.includes("NOT implemented") && AGG_CONTRACT.cursor.includes("no aggregate cursor"),
      JSON.stringify({ pipeline: AGG_CONTRACT.pipeline, cursor: AGG_CONTRACT.cursor }));
    harness.check("boundary: derived choices pinned NON-PARITY — scan ceiling, null/non-numeric, countDistinct, having ops, UTC/ISO week",
      [AGG_CONTRACT.scan_ceiling, AGG_CONTRACT.numeric_null, AGG_CONTRACT.count_distinct_null_array, AGG_CONTRACT.having_ops, AGG_CONTRACT.week_utc_iso]
        .every((s) => s.includes("NEXUSAI-derived, non-parity")),
      "5 derived choices pinned");
    harness.check("boundary: derived choices pinned fail-closed/non-parity — dateBucket+groupBy collision, invalid fields, limit clamp, unsorted order, key order",
      [AGG_CONTRACT.datebucket_groupby_collision, AGG_CONTRACT.invalid_field, AGG_CONTRACT.limit_clamp, AGG_CONTRACT.unsorted_order, AGG_CONTRACT.key_order]
        .every((s) => /NEXUSAI-derived/.test(s)),
      "5 derived choices pinned");
    harness.check("surface: the `db` export remains registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("db"), "db present");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p9xa-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p9xa" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p9xa_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p9xa[0-9]+$" } }).catch(() => {});
  }
}