// Certification suite for the IMPLEMENTED upsert surface (base44/shared/appData.ts), pinned
// against the DOCUMENTED Base44 SDK 0.8.51 contract (EntityHandler.upsert + EntityUpsertOptions /
// EntityUpsertResult, PR #287). The suite drives the REAL createServerDb funnel — the deployed
// runtime, the preview and backend functions all route db ops through it; the bridge/preview/runtime
// op registration is pass-through (records + key travel verbatim).
//
// CERTIFIED (DOCUMENTED, 0.8.51):
//   • upsert(records, { key }) — key is a field or array of fields and is REQUIRED;
//   • the result is exactly { created, updated, records }, where records are the PERSISTED
//     records as they now exist;
//   • UPSTREAM-PR-CONFIRMED (PR #287 — NOT the shipped types/JSDoc): at most 500 records per
//     call, refused fail-closed, never silently clamped;
//   • DOCUMENTED (0.8.52 JSDoc): duplicate keys within one call are accepted — the LAST
//     occurrence wins; surviving records keep their input order.
//   • no additional options: raw/extra option properties have no effect.
//
// Every behavior the SDK does NOT prove upstream is certified here ONLY as a bounded
// NEXUSAI-derived, non-parity choice (see UPSERT_CONTRACT) — the suite never claims these are
// Base44 behavior.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb, readEntityEvents } from "../../shared/appData.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";
import { makeAgentProject, makeAgentPoolTools } from "../../shared/appAgentTestFixtures.ts";

const UPSERT_CONTRACT = {
  surface: "DOCUMENTED (SDK 0.8.51) — upsert(records, { key }); key string|string[] REQUIRED; result exactly { created, updated, records } of PERSISTED records",
  cap: "UPSTREAM-PR-CONFIRMED (PR #287, NOT types/JSDoc) — at most 500 records per call, refused fail-closed (DATABASE_VALIDATION_FAILED), no silent clamp",
  extra_options: "DOCUMENTED — no additional options; raw/extra option properties have NO effect (NEXUSAI-derived: ignored, not errors)",
  // ---- NEXUSAI-derived, explicitly NON-PARITY (never claimed as Base44 behavior) ----
  key_schema_fields: "NEXUSAI-derived, non-parity — key fields must be declared schema fields; builtin keys (id/created_date/updated_date — keyof T admits them upstream) are REFUSED, because this storage assigns them itself",
  key_values: "NEXUSAI-derived, non-parity — key values must be non-null, non-empty-string primitives; matching is strict type-sensitive equality (5 never matches '5')",
  missing_key: "NEXUSAI-derived, fail-closed — a record missing any key field aborts the whole call before any write",
  empty_records: "NEXUSAI-derived, fail-closed — an empty (or non-array) records list is refused",
  dup_keys: "DOCUMENTED (SDK 0.8.52 JSDoc) — duplicate keys within one call are accepted; the LAST occurrence wins; surviving records keep their input order; the 500-record INPUT cap still counts the raw input",
  ambiguous_matches: "NEXUSAI-derived, fail-closed — a key matching more than one existing record is refused as ambiguous, before any write",
  visibility: "NEXUSAI-derived, non-parity — matches resolve only through the read path (read gate + legacy-RLS scoping); an existing record the caller cannot read is NOT a match and a new record is created (existence never leaks)",
  read_deny: "NEXUSAI-derived, fail-closed — an entity whose read rule is a flat deny refuses upsert entirely (403 DATABASE_RLS_DENIED)",
  merge: "NEXUSAI-derived, non-parity — an update MERGES the submitted fields over the existing record (exactly like update()), never a blind replace",
  events: "NEXUSAI-derived, non-parity — create/update entity events per written record, like the single ops",
  order: "NEXUSAI-derived, non-parity — records return in INPUT order; created/updated count the writes; system fields (id/created_date) are the existing storage ops'",
  atomicity: "NEXUSAI-derived, non-parity — the whole set is validated, gated, matched and relation-checked BEFORE the first write (no partial batch)",
};

const ENTITIES = [
  { name: "Item", fields: { sku: { type: "string", required: true }, region: { type: "string" }, label: { type: "string" }, qty: { type: "number" } } },
  { name: "Sealed", fields: { body: { type: "string" } }, rls: { create: true, read: false, update: true, delete: true } },
  { name: "Ledger", fields: { owner: { type: "string" }, body: { type: "string" } }, rls: { create: true, read: { "data.owner": "{{user.id}}" }, update: true, delete: true } },
  // NOTE: `create: false` is intentionally NOT a denied create gate — the RLS contract denies
  // `false` only for read/delete, leaving create/update open. To certify a real create-gate
  // failure the create rule is a filter that can never match the pending record.
  { name: "NoCreate", fields: { body: { type: "string" } }, rls: { create: { user_condition: { id: "p9up-nobody" } }, read: true, update: true, delete: true } },
];

// Storage round-trips timestamps at different precisions (a write response carries microseconds,
// a later read returns milliseconds) — the same INSTANT. Date fields compare instant-wise.
const tsEq = (a, b) => {
  const norm = (v) => String(v ?? "").replace(/Z$/, "").replace(/(\.\d{3})\d*$/, "$1");
  return norm(a) === norm(b);
};
const sameRecord = (a, b) => !!a && !!b
  && Object.keys(a).every((k) => (k.endsWith("_date") ? tsEq(a[k], b[k]) : a[k] === b[k]))
  && Object.keys(b).every((k) => (k.endsWith("_date") ? tsEq(a[k], b[k]) : a[k] === b[k]));

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];

  try {
    const plan = await makeBillingPlan(db, created, `p9up${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9up${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p9up");
    await grant(A.ws.id, "message", 50);
    await grant(A.ws.id, "integration", 50);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const P1 = await makeAgentProject(db, projectIds, A, stamp, "p9up");
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p9up");
    const PR = await makeAgentProject(db, projectIds, A, stamp, "p9up");
    await db.entities.Project.update(PR.id, { rls_enabled: true });
    const userA1 = { id: `p9up_userA1_${stamp}`, email: "a1@p9up.test" };
    const userA2 = { id: `p9up_userA2_${stamp}`, email: "a2@p9up.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbR1 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });
    const dbR2 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA2 });

    // ---- 1/2/5/6/10/24. dispatch, single-key create, exact shape, persisted record, system fields
    const first = await db1.Item.upsert([{ sku: "k1", label: "first", qty: 1 }], { key: "sku" });
    harness.check("dispatch: upsert is reachable through the REAL createServerDb funnel; result keys are EXACTLY created,updated,records — no cursor/pagination fields",
      Object.keys(first).join(",") === "created,updated,records" && !("next_cursor" in first) && !("has_more" in first) && !("items" in first),
      JSON.stringify(Object.keys(first)));
    harness.check("single-key create: a new record is created and persisted; created=1 updated=0; system fields generated",
      first.created === 1 && first.updated === 0 && first.records.length === 1
        && !!first.records[0].id && !!first.records[0].created_date && !!first.records[0].updated_date
        && first.records[0].sku === "k1",
      JSON.stringify(first));
    harness.check("returned records are the PERSISTED records (create): a fresh get returns the identical record",
      sameRecord(await db1.Item.get(first.records[0].id), first.records[0]),
      JSON.stringify(await db1.Item.get(first.records[0].id)));
    const pre = first.records[0];

    // ---- 3/6/9/10. single-key update, merge semantics, system fields preserved
    const second = await db1.Item.upsert([{ sku: "k1", qty: 9 }], { key: "sku" });
    harness.check("single-key update: the existing record is updated in place — created=0 updated=1; id and created_date are PRESERVED (system fields)",
      second.created === 0 && second.updated === 1 && second.records[0].id === pre.id
        && tsEq(second.records[0].created_date, pre.created_date) && !!second.records[0].updated_date,
      JSON.stringify(second));
    harness.check("merge semantics (NEXUSAI-derived, non-parity): submitted fields replace, untouched fields are preserved — never a blind replace",
      second.records[0].qty === 9 && second.records[0].label === "first",
      JSON.stringify(second.records[0]));
    harness.check("returned records are the PERSISTED records (update): a fresh get returns the identical merged record",
      sameRecord(await db1.Item.get(second.records[0].id), second.records[0]),
      JSON.stringify(await db1.Item.get(second.records[0].id)));

    // ---- 4. compound-key create and update
    const c1 = await db1.Item.upsert([{ sku: "c1", region: "eu", qty: 1 }], { key: ["sku", "region"] });
    const c2 = await db1.Item.upsert([{ sku: "c1", region: "eu", qty: 2 }], { key: ["sku", "region"] });
    const c3 = await db1.Item.upsert([{ sku: "c1", region: "us", qty: 3 }], { key: ["sku", "region"] });
    harness.check("compound key: key array — same compound updates in place, a differing component creates a NEW record",
      c1.created === 1 && c2.created === 0 && c2.updated === 1 && c2.records[0].id === c1.records[0].id
        && c3.created === 1 && c3.records[0].id !== c1.records[0].id,
      JSON.stringify({ c1: { created: c1.created }, c2: { created: c2.created, updated: c2.updated }, c3: { created: c3.created } }));

    // ---- 7/8. input ordering preserved + created/updated counts
    const countBefore = await db1.Item.count({});
    const mixed = await db1.Item.upsert([
      { sku: "o1", label: "new-1" },
      { sku: "k1", label: "k1-touched" },
      { sku: "o2", label: "new-2" },
    ], { key: "sku" });
    harness.check("order/counts: records return in INPUT order and created/updated count the writes (NEXUSAI-derived, non-parity)",
      mixed.records.map((r) => r.sku).join(",") === "o1,k1,o2"
        && mixed.created === 2 && mixed.updated === 1
        && (await db1.Item.count({})) === countBefore + 2,
      JSON.stringify({ order: mixed.records.map((r) => r.sku), created: mixed.created, updated: mixed.updated }));

    // ---- 17. ambiguous multiple existing matches
    await db1.Item.bulkCreate([{ sku: "amb", label: "d1" }, { sku: "amb", label: "d2" }]);
    const amb = await captureCall(() => db1.Item.upsert([{ sku: "amb", qty: 1 }], { key: "sku" }));
    const ambRows = await db1.Item.filter({ sku: "amb" });
    harness.check("ambiguous matches: a key matching MORE THAN ONE existing record is refused as ambiguous, and nothing is written or modified (NEXUSAI-derived, fail-closed)",
      amb.threw && amb.code === "DATABASE_VALIDATION_FAILED"
        && ambRows.length === 2 && ambRows.map((r) => r.label).sort().join(",") === "d1,d2",
      JSON.stringify({ amb: amb.code, rows: ambRows.length }));

    // ---- 13. missing key field
    const cnt13 = await db1.Item.count({});
    const miss = await captureCall(() => db1.Item.upsert([{ label: "no-sku" }], { key: "sku" }));
    harness.check("missing key field: refused fail-closed with a structured validation error, and NOTHING is written (NEXUSAI-derived, fail-closed)",
      miss.threw && miss.code === "DATABASE_VALIDATION_FAILED" && (await db1.Item.count({})) === cnt13,
      JSON.stringify(miss));

    // ---- 14. null/empty/invalid key values
    const badNull = await captureCall(() => db1.Item.upsert([{ sku: null, label: "x" }], { key: "sku" }));
    const badEmpty = await captureCall(() => db1.Item.upsert([{ sku: "", label: "x" }], { key: "sku" }));
    const badObj = await captureCall(() => db1.Item.upsert([{ sku: { a: 1 }, label: "x" }], { key: "sku" }));
    const badArr = await captureCall(() => db1.Item.upsert([{ sku: ["x"], label: "x" }], { key: "sku" }));
    const cnt14 = await db1.Item.count({});
    harness.check("key values: null, empty-string, object and array key values are ALL refused fail-closed; nothing is written (NEXUSAI-derived, non-parity)",
      badNull.threw && badEmpty.threw && badObj.threw && badArr.threw
        && [badNull, badEmpty, badObj, badArr].every((c) => c.code === "DATABASE_VALIDATION_FAILED")
        && cnt14 === cnt13,
      JSON.stringify({ null: badNull.code, empty: badEmpty.code, obj: badObj.code, arr: badArr.code }));

    // ---- 15. invalid key definitions + builtin key refusal (NEXUSAI-derived)
    const bId = await captureCall(() => db1.Item.upsert([{ sku: "x1" }], { key: "id" }));
    const bCd = await captureCall(() => db1.Item.upsert([{ sku: "x1" }], { key: "created_date" }));
    const bNoKey = await captureCall(() => db1.Item.upsert([{ sku: "x1" }], {}));
    const bNum = await captureCall(() => db1.Item.upsert([{ sku: "x1" }], { key: 123 }));
    const bEmptyKey = await captureCall(() => db1.Item.upsert([{ sku: "x1" }], { key: [] }));
    const bDupField = await captureCall(() => db1.Item.upsert([{ sku: "x1" }], { key: ["sku", "sku"] }));
    const bUnknown = await captureCall(() => db1.Item.upsert([{ sku: "x1" }], { key: "nope" }));
    harness.check("builtin keys: key 'id'/'created_date' are REFUSED although keyof T admits them upstream; missing/invalid key definitions all fail closed (NEXUSAI-derived, non-parity)",
      bId.threw && bCd.threw && bNoKey.threw && bNum.threw && bEmptyKey.threw && bDupField.threw && bUnknown.threw
        && [bId, bCd, bNoKey, bNum, bEmptyKey, bDupField, bUnknown].every((c) => c.code === "DATABASE_VALIDATION_FAILED"),
      JSON.stringify({ id: bId.code, created_date: bCd.code, none: bNoKey.code, num: bNum.code, empty: bEmptyKey.code, dup: bDupField.code, unknown: bUnknown.code }));

    // ---- 16. duplicate keys within one call — DOCUMENTED (SDK 0.8.52): last one wins
    const dk = await db1.Item.upsert([{ sku: "dk", label: "a" }, { sku: "dk", label: "b" }], { key: "sku" });
    const dkRows = await db1.Item.filter({ sku: "dk" });
    harness.check("duplicate keys in ONE call (create path): ACCEPTED — the LAST occurrence wins; result shape {created,updated,records} unchanged; the written record is the persisted one",
      dk.created === 1 && dk.updated === 0 && dk.records.length === 1
        && !("next_cursor" in dk) && !("has_more" in dk)
        && dkRows.length === 1 && dkRows[0].label === "b" && dkRows[0].id === dk.records[0].id
        && sameRecord(await db1.Item.get(dk.records[0].id), dk.records[0]),
      JSON.stringify({ created: dk.created, updated: dk.updated, label: dk.records[0].label, rows: dkRows.length }));

    const dkUp = await db1.Item.upsert([{ sku: "k1", label: "dupA" }, { sku: "k1", label: "dupB" }], { key: "sku" });
    harness.check("duplicate keys hitting an EXISTING record: updated=1 created=0 — merged ONCE with the LAST payload; id and created_date preserved (merge/update semantics unchanged)",
      dkUp.created === 0 && dkUp.updated === 1 && dkUp.records[0].id === pre.id
        && dkUp.records[0].label === "dupB" && tsEq(dkUp.records[0].created_date, pre.created_date)
        && (await db1.Item.get(pre.id)).label === "dupB",
      JSON.stringify({ created: dkUp.created, updated: dkUp.updated, label: dkUp.records[0].label }));

    const dkMix = await db1.Item.upsert([
      { sku: "mo1", label: "m-1" },
      { sku: "dk2", label: "m-x" },
      { sku: "dk2", label: "m-2" },
      { sku: "mo2", label: "m-3" },
    ], { key: "sku" });
    harness.check("duplicate + unique keys mixed: survivors keep their ORIGINAL input order (mo1, dk2, mo2); created counts the surviving writes; the superseded occurrence is never written",
      dkMix.records.map((r) => r.sku).join(",") === "mo1,dk2,mo2"
        && dkMix.created === 3 && dkMix.updated === 0
        && dkMix.records[1].label === "m-2"
        && (await db1.Item.filter({ label: "m-x" })).length === 0,
      JSON.stringify({ order: dkMix.records.map((r) => r.sku), created: dkMix.created, updated: dkMix.updated }));

    const ckDup = await db1.Item.upsert([
      { sku: "ck", region: "eu", qty: 1 },
      { sku: "ck", region: "eu", qty: 2 },
      { sku: "ck", region: "us", qty: 3 },
    ], { key: ["sku", "region"] });
    const ckEu = await db1.Item.filter({ sku: "ck", region: "eu" });
    const ckUs = await db1.Item.filter({ sku: "ck", region: "us" });
    harness.check("compound-key duplicates: the LAST occurrence per FULL tuple wins — (eu) keeps qty 2, (us) keeps qty 3, exactly two records created (compound-key behavior otherwise unchanged)",
      ckDup.created === 2 && ckDup.updated === 0
        && ckEu.length === 1 && ckEu[0].qty === 2 && ckUs.length === 1 && ckUs[0].qty === 3
        && ckDup.records.map((r) => r.qty).sort().join(",") === "2,3",
      JSON.stringify({ created: ckDup.created, eu: (ckEu[0] || {}).qty, us: (ckUs[0] || {}).qty }));

    const dupC = await db1.Item.bulkCreate([{ sku: "dupc", label: "c1" }, { sku: "dupc", label: "c2" }]);
    const dupCRows = await db1.Item.filter({ sku: "dupc" });
    harness.check("create duplicates unchanged: bulkCreate still persists BOTH same-key records — no dedupe (existing behavior)",
      dupC.length === 2 && dupCRows.length === 2 && dupCRows.map((r) => r.label).sort().join(",") === "c1,c2",
      JSON.stringify({ rows: dupCRows.length }));

    // ---- 18. empty / non-array records
    const empty = await captureCall(() => db1.Item.upsert([], { key: "sku" }));
    const nonArr = await captureCall(() => db1.Item.upsert("nope", { key: "sku" }));
    harness.check("empty records: an empty array and a non-array records value are both refused fail-closed (NEXUSAI-derived)",
      empty.threw && nonArr.threw && empty.code === "DATABASE_VALIDATION_FAILED" && nonArr.code === "DATABASE_VALIDATION_FAILED",
      JSON.stringify({ empty: empty.code, nonArray: nonArr.code }));

    // ---- 19. > 500 records: UPSTREAM-PR-CONFIRMED cap, fail-closed, no partial write
    const big = Array.from({ length: 501 }, (_, i) => ({ sku: `cap-${i}` }));
    const cap = await captureCall(() => db1.Item.upsert(big, { key: "sku" }));
    const capRows = await db1.Item.filter({ sku: { $regex: "^cap-" } });
    harness.check("cap 500 (UPSTREAM-PR-CONFIRMED, PR #287 — NOT types/JSDoc): 501 records are refused with DATABASE_VALIDATION_FAILED, never clamped — and NOTHING is written",
      cap.threw && cap.code === "DATABASE_VALIDATION_FAILED" && /500/.test(cap.message || "") && capRows.length === 0,
      JSON.stringify({ call: cap.code, message: (cap.message || "").slice(0, 80), rows: capRows.length }));

    // ---- 20. validation and gate failures occur BEFORE the first write
    const cnt20 = await db1.Item.count({});
    const mixedBad = await captureCall(() => db1.Item.upsert([{ sku: "pre-ok", label: "ok" }, { sku: "pre-bad", qty: "many" }], { key: "sku" }));
    const preOk = await db1.Item.filter({ sku: "pre-ok" });
    harness.check("atomicity: a validation failure in ANY record aborts the whole batch before the first write — no partial batch (NEXUSAI-derived, non-parity)",
      mixedBad.threw && mixedBad.code === "DATABASE_VALIDATION_FAILED"
        && (await db1.Item.count({})) === cnt20 && preOk.length === 0,
      JSON.stringify({ call: mixedBad.code, rows: preOk.length }));
    const gate = await captureCall(() => db1.NoCreate.upsert([{ body: "a" }, { body: "b" }], { key: "body" }));
    harness.check("atomicity: a create-GATE failure (a never-matching create rule) also aborts the whole batch before any write — nothing persisted",
      gate.threw && gate.code === "DATABASE_RLS_DENIED" && (await db1.NoCreate.count({})) === 0,
      JSON.stringify({ call: gate.code, rows: await db1.NoCreate.count({}) }));

    // ---- 12. read gate: flat deny refuses the whole operation
    const sealed = await captureCall(() => db1.Sealed.upsert([{ body: "x" }], { key: "body" }));
    harness.check("read gate: an entity whose read rule is a flat deny refuses upsert ENTIRELY (403 DATABASE_RLS_DENIED — NEXUSAI-derived, fail-closed)",
      sealed.threw && sealed.code === "DATABASE_RLS_DENIED" && sealed.status === 403,
      JSON.stringify(sealed));

    // ---- 22. strict type-sensitive key matching
    const numFirst = await db1.Item.upsert([{ sku: "t1", qty: 5, label: "num" }], { key: "qty" });
    const numUpd = await db1.Item.upsert([{ sku: "t1", qty: 5, label: "num-2" }], { key: "qty" });
    const numNew = await db1.Item.upsert([{ sku: "t2", qty: 6 }], { key: "qty" });
    const numType = await captureCall(() => db1.Item.upsert([{ sku: "t3", qty: "5" }], { key: "qty" }));
    harness.check("strict matching: key comparison is strict type-sensitive equality — 5 matches 5 (update in place), 6 creates a new record (NEXUSAI-derived, non-parity)",
      numFirst.created === 1 && numUpd.updated === 1 && numUpd.records[0].id === numFirst.records[0].id
        && numNew.created === 1,
      JSON.stringify({ first: numFirst.created, upd: numUpd.updated, nu: numNew.created }));
    harness.check("strict matching: a cross-type key value ('5' vs 5) is unreachable — schema typing refuses it before matching (derived boundary)",
      numType.threw && numType.code === "DATABASE_VALIDATION_FAILED",
      JSON.stringify(numType));

    // ---- 23. raw/extra options have NO effect
    const extra = await db1.Item.upsert([{ sku: "k1", label: "extra-touched" }],
      { key: "sku", raw: true, limit: 999, fields: ["sku"], sort: "-created_date", unknownOption: { x: 1 } });
    harness.check("options: extra/raw option properties have NO effect — the call behaves exactly like { key } alone (documented: no additional options)",
      extra.updated === 1 && extra.created === 0 && extra.records[0].id === pre.id && extra.records[0].label === "extra-touched",
      JSON.stringify({ updated: extra.updated, id_match: extra.records[0].id === pre.id }));

    // ---- 11/12. RLS: owner isolation and the inaccessible existing record
    const aFirst = await dbR1.Ledger.upsert([{ body: "d1", owner: userA1.id }], { key: "body" });
    const bUp = await dbR2.Ledger.upsert([{ body: "d1", owner: userA2.id }], { key: "body" });
    const aRows = await dbR1.Ledger.filter({ body: "d1" });
    const bRows = await dbR2.Ledger.filter({ body: "d1" });
    const aUpd = await dbR1.Ledger.upsert([{ body: "d1", owner: userA1.id }], { key: "body" });
    harness.check("RLS isolation: each user's upsert matches only THEIR OWN records; the other owner's same-key record is invisible — a NEW record is created, existence never leaks (NEXUSAI-derived, non-parity)",
      aFirst.created === 1 && bUp.created === 1
        && aRows.length === 1 && aRows[0].owner === userA1.id
        && bRows.length === 1 && bRows[0].owner === userA2.id
        && aRows[0].id !== bRows[0].id,
      JSON.stringify({ aFirst: aFirst.created, bUp: bUp.created, aRows: aRows.length, bRows: bRows.length }));
    harness.check("RLS update: the owning user's second same-key upsert UPDATES their own record in place",
      aUpd.updated === 1 && aUpd.records[0].id === aFirst.records[0].id,
      JSON.stringify({ updated: aUpd.updated }));

    // ---- 26. project cross-isolation
    const p2Up = await db2.Item.upsert([{ sku: "k1", label: "from-p2" }], { key: "sku" });
    const p1Row = await db1.Item.get(pre.id);
    const p1K1 = await db1.Item.filter({ sku: "k1" });
    harness.check("project isolation: the same key in ANOTHER project creates that project's own record — the first project's record is untouched and never matched",
      p2Up.created === 1 && p1Row.label === "extra-touched" && p1K1.length === 1 && p1K1[0].id === pre.id
        && p2Up.records[0].id !== pre.id,
      JSON.stringify({ p2: p2Up.created, p1_label: p1Row.label, p1_rows: p1K1.length }));

    // ---- 1b. unknown entity refusal
    const unknown = await captureCall(() => db1.NotAnEntity.upsert([{ sku: "x" }], { key: "sku" }));
    harness.check("isolation: an unknown entity is refused fail-closed, naming the upsert operation",
      unknown.threw && unknown.code === "DATABASE_ENTITY_NOT_FOUND" && /upsert/.test(unknown.message || ""),
      JSON.stringify(unknown));

    // ---- 21. create/update entity events
    const ev1 = await db1.Item.upsert([{ sku: "ev", label: "v1" }], { key: "sku" });
    const evId = ev1.records[0].id;
    await db1.Item.upsert([{ sku: "ev", label: "v2" }], { key: "sku" });
    const evBatch = await db1.Item.upsert([{ sku: "ev-a" }, { sku: "ev-b" }], { key: "sku" });
    const evs = await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Item", after: null, limit: 100 });
    const seq = evs.events.filter((e) => e.id === evId).map((e) => e.type);
    const batchIds = evBatch.records.map((r) => r.id);
    const batchEvents = evs.events.filter((e) => batchIds.includes(e.id)).map((e) => e.type);
    harness.check("events: an upsert-create then an upsert-update emit create,update for the record; a multi-record batch emits one event PER record (NEXUSAI-derived, non-parity)",
      seq.join(",") === "create,update" && batchEvents.length === 2 && batchEvents.every((t) => t === "create"),
      JSON.stringify({ seq, batchEvents }));

    // ---- 25. billing neutrality
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: the upsert surface moves no credits in either pool",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);

    // ---- boundary pins
    harness.check("boundary: the cap is pinned UPSTREAM-PR-CONFIRMED (PR #287, NOT types/JSDoc) — fail-closed, never clamped",
      UPSERT_CONTRACT.cap.includes("UPSTREAM-PR-CONFIRMED") && UPSERT_CONTRACT.cap.includes("fail-closed") && UPSERT_CONTRACT.cap.includes("no silent clamp"),
      UPSERT_CONTRACT.cap);
    harness.check("boundary: derived choices pinned NEXUSAI-derived, non-parity — key fields/values, missing key, empty records, ambiguity, visibility, merge, events, order, atomicity (duplicate keys are DOCUMENTED 0.8.52 parity, no longer derived)",
      [UPSERT_CONTRACT.key_schema_fields, UPSERT_CONTRACT.key_values, UPSERT_CONTRACT.missing_key, UPSERT_CONTRACT.empty_records,
        UPSERT_CONTRACT.ambiguous_matches, UPSERT_CONTRACT.visibility, UPSERT_CONTRACT.merge,
        UPSERT_CONTRACT.events, UPSERT_CONTRACT.order, UPSERT_CONTRACT.atomicity].every((s) => /NEXUSAI-derived/.test(s)),
      "10 derived choices pinned");
    harness.check("boundary: duplicate keys are pinned DOCUMENTED 0.8.52 parity — last occurrence wins, survivors keep input order, input cap unchanged",
      /DOCUMENTED \(SDK 0\.8\.52/.test(UPSERT_CONTRACT.dup_keys) && /LAST occurrence wins/.test(UPSERT_CONTRACT.dup_keys),
      UPSERT_CONTRACT.dup_keys);
    harness.check("boundary: read-deny refusal pinned fail-closed NON-PARITY — never claimed as Base44 behavior",
      UPSERT_CONTRACT.read_deny.includes("NEXUSAI-derived, fail-closed"),
      UPSERT_CONTRACT.read_deny);
    harness.check("surface: the `db` export remains registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("db"), "db present");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup (deleteMany, one request per entity) — also sweeps scratch rows left behind
    // by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p9up-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^p9up" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p9up_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^p9up[0-9]+$" } }).catch(() => {});
  }
}