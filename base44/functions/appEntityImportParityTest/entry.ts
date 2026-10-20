// Certification suite for the DOCUMENTED browser-only import surface:
// entities.<Entity>.importEntities(file) — "Imports records from a file, typically CSV.
// Requires a browser environment." Returns ImportResult<T> ({ status, output }).
//
// Certified: the deterministic CSV→records parser and its routing onto the EXISTING bulkCreate
// machine — schema validation, RLS ownership/gates, relations and per-record Stage-B events are
// that machine's, unchanged, and the import is ONE atomic fail-fast call. Every semantic Base44
// does NOT publish is pinned below as UNKNOWN with this suite's bounded DERIVED choice; none is
// claimed as parity. The browser bridge / preview / deployed-runtime forwarding of the op is
// pass-through and is covered by the runtime surface suites.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, captureCall, harnessResponse } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createServerDb, readEntityEvents } from "../../shared/appData.ts";
import { importEntitiesIntoDb } from "../../shared/appImport.ts";
import { makeAgentPoolTools, makeAgentProject, appAgentPace } from "../../shared/appAgentTestFixtures.ts";
import { RUNTIME_EXPORTS } from "../../shared/runtimeExports.ts";

// The certified contract, pinned so the suite states its own boundary.
const IMPORT_CONTRACT = {
  signature: "DOCUMENTED — importEntities(file), browser-only, returns ImportResult { status, output }",
  parsing: "DETERMINISTIC CSV only — NO AI extraction (AI path exists in ExtractStructuredData but is NOT used here)",
  delimiter: "DOCUMENTED — commas, semicolons and tabs all work; sniffed per file; RFC-4180 quoted fields, \"\" escapes",
  encoding: "UNKNOWN in Base44 docs — DERIVED: UTF-8 decoded server-side",
  header: "UNKNOWN in Base44 docs — DERIVED: required non-empty first row naming entity fields",
  cell_coercion: "UNKNOWN in Base44 docs — DERIVED: exact-number and true/false cells become scalars",
  size_limit: "UNKNOWN in Base44 docs — DERIVED: the existing 5MB decoded-bytes file cap",
  malformed_rows: "UNKNOWN in Base44 docs — DERIVED: whole-import refuse before any write (bulkCreate fail-fast)",
  duplicates: "UNKNOWN in Base44 docs — NOT implemented: plain creates, no upsert",
  partial_vs_atomic: "UNKNOWN in Base44 docs — DERIVED: one atomic bulkCreate call",
  status_values: "UNKNOWN in Base44 docs — DERIVED: 'success'; failures raise the structured db error contract",
  service_role: "UNKNOWN in Base44 docs — NOT implemented: browser runtime surface only",
  billing: "Base44 publishes NO import charge — none invented; no credits move in either pool",
};

const ENTITIES = [
  { name: "Task", fields: { title: { type: "string" }, status: { type: "string" }, done: { type: "boolean" }, n: { type: "number" } } },
  { name: "Ledger", fields: { owner: { type: "string" }, body: { type: "string" } }, rls: { create: true, read: { "data.owner": "{{user.id}}" }, update: true, delete: true } },
];

const csvFile = (text, { name = "import.csv", type = "text/csv" } = {}) =>
  ({ filename: name, content_type: type, content_base64: btoa(text) });

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const wsIds = [];
  const projectIds = [];
  const pace = (ms) => appAgentPace(ms || 400);

  try {
    const plan = await makeBillingPlan(db, created, `p9xi${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9xi${stamp}`, { plan });
    wsIds.push(A.ws.id);
    const { grant, msgOf, intOf } = makeAgentPoolTools(db, stamp, "p9xi");
    await grant(A.ws.id, "message", 50);
    await grant(A.ws.id, "integration", 50);
    const msg0 = await msgOf(A.ws.id);
    const int0 = await intOf(A.ws.id);

    const P1 = await makeAgentProject(db, projectIds, A, stamp, "p9xi"); await pace();
    const P2 = await makeAgentProject(db, projectIds, A, stamp, "p9xi"); await pace();
    const PR = await makeAgentProject(db, projectIds, A, stamp, "p9xi"); await pace();
    await db.entities.Project.update(PR.id, { rls_enabled: true });
    const userA1 = { id: `p9xi_userA1_${stamp}`, email: "a1@p9xi.test" };
    const userA2 = { id: `p9xi_userA2_${stamp}`, email: "a2@p9xi.test" };

    const db1 = createServerDb(db, P1.id, ENTITIES);
    const db2 = createServerDb(db, P2.id, ENTITIES);
    const dbR1 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA1 });
    const dbR2 = createServerDb(db, PR.id, ENTITIES, { rls: true, user: userA2 });
    const dbRAnon = createServerDb(db, PR.id, ENTITIES, { rls: true, user: null });

    // ---- 1. happy path: DOCUMENTED ImportResult + CRLF rows + blank-line skipping --------
    const res = await importEntitiesIntoDb(db1, "Task", csvFile("title,status,done,n\r\nalpha,open,true,1\r\n\r\nbeta,done,false,2\r\n"));
    const rows1 = await db1.Task.filter({}, "-created_date", 10);
    harness.check("import: returns the DOCUMENTED ImportResult shape ({ status, output })",
      !!res && res.status === "success" && typeof res.output === "object" && Object.keys(res).sort().join(",") === "output,status",
      JSON.stringify(res && Object.keys(res)));
    harness.check("import: every parsed data row is created; blank lines are skipped (DERIVED)",
      res.output.imported === 2 && rows1.length === 2,
      JSON.stringify({ imported: res.output.imported, rows: rows1.length }));
    harness.check("import: cells are coerced deterministically — numbers/booleans, not strings (DERIVED)",
      rows1.every((r) => typeof r.n === "number" && typeof r.done === "boolean")
        && rows1.some((r) => r.title === "alpha" && r.status === "open"),
      JSON.stringify(rows1));
    harness.check("import: created records carry the full record shape (id, created_date, ...)",
      rows1.every((r) => r.id && r.created_date), JSON.stringify(rows1[0] && Object.keys(rows1[0])));

    // ---- 2. RFC-4180 field shape: quoted commas, "" escapes, embedded newline -------------
    await importEntitiesIntoDb(db1, "Task", csvFile('title,status,n\n"ga, ""ma""",open,3\n"mu\nlti",open,4\n'));
    const rows2 = await db1.Task.filter({ status: "open" }, "-created_date", 10);
    harness.check("csv: quoted fields preserve commas, doubled quotes and embedded newlines (DERIVED RFC-4180 shape)",
      rows2.some((r) => r.title === 'ga, "ma"') && rows2.some((r) => r.title === "mu\nlti"),
      JSON.stringify(rows2.map((r) => r.title)));

    // ---- 2b. DOCUMENTED delimiters: comma, semicolon and tab, with quoted delimiters -----
    // DOCUMENTED (Base44, Import entity records from CSV): "Commas, semicolons, and tabs all
    // work as the delimiter". Re-import creates duplicates — also DOCUMENTED there.
    await importEntitiesIntoDb(db1, "Task", csvFile("title;status;n\nsemi;open;6\n"));
    const semiRows = await db1.Task.filter({ title: "semi" }, "-created_date", 5);
    harness.check("delimiter: a semicolon-delimited file parses as multi-column (DOCUMENTED)",
      semiRows.length === 1 && semiRows[0].n === 6 && semiRows[0].status === "open",
      JSON.stringify(semiRows));
    await importEntitiesIntoDb(db1, "Task", csvFile("title\tstatus\tn\ntabby\topen\t7\n"));
    const tabRows = await db1.Task.filter({ title: "tabby" }, "-created_date", 5);
    harness.check("delimiter: a tab-delimited file parses as multi-column (DOCUMENTED)",
      tabRows.length === 1 && tabRows[0].n === 7 && tabRows[0].status === "open",
      JSON.stringify(tabRows));
    await importEntitiesIntoDb(db1, "Task", csvFile('title;status;n\n"has, comma";open;8\n"has; semi";open;9\n'));
    const quotedRows = await db1.Task.filter({ status: "open" }, "-created_date", 10);
    harness.check("delimiter: quoted values keep embedded , and ; across the sniffed delimiter",
      quotedRows.some((r) => r.title === "has, comma" && r.n === 8) && quotedRows.some((r) => r.title === "has; semi" && r.n === 9),
      JSON.stringify(quotedRows.map((r) => r.title)));
    await importEntitiesIntoDb(db1, "Task", csvFile('title,status,n\n"ta;b",open,10\n'));
    const commaQuoted = await db1.Task.filter({ title: "ta;b" }, "-created_date", 5);
    harness.check("delimiter: a comma file whose quoted field holds a ; stays comma-sniffed",
      commaQuoted.length === 1 && commaQuoted[0].n === 10, JSON.stringify(commaQuoted));
    const twice = csvFile("title,status,n\nreimported,open,1\n");
    await importEntitiesIntoDb(db2, "Task", twice);
    const reimport = await importEntitiesIntoDb(db2, "Task", twice);
    await new Promise((r) => setTimeout(r, 1500));
    const reimportRows = await db2.Task.filter({ title: "reimported" }, "-created_date", 10);
    harness.check("delimiter: re-importing the same file creates DUPLICATES (DOCUMENTED)",
      reimport.output.imported === 1 && reimportRows.length === 2,
      JSON.stringify({ imported: reimport.output.imported, rows: reimportRows.length }));

    // ---- 3. input file boundaries (all DERIVED — Base44 publishes none) ------------------
    const headerOnly = await captureCall(() => importEntitiesIntoDb(db1, "Task", csvFile("title,status,n\r\n")));
    harness.check("boundary: a header-only file is refused and writes nothing",
      headerOnly.threw && headerOnly.code === "IMPORT_INVALID_FILE", JSON.stringify(headerOnly));
    const badMime = await captureCall(() => importEntitiesIntoDb(db1, "Task", csvFile("title\nx\n", { type: "application/json" })));
    harness.check("boundary: a non-CSV declared type is refused (DERIVED)",
      badMime.threw && badMime.code === "IMPORT_INVALID_FILE", JSON.stringify(badMime));
    const untyped = await importEntitiesIntoDb(db1, "Task", csvFile("title,status,n\ngamma,open,5\n", { type: "", name: "rows.csv" }));
    harness.check("boundary: an untyped *.csv file is accepted — browsers report no MIME for .csv (DERIVED)",
      untyped.output.imported === 1, JSON.stringify(untyped.output.imported));
    const emptyFile = await captureCall(() => importEntitiesIntoDb(db1, "Task", { filename: "e.csv", content_type: "text/csv", content_base64: "" }));
    harness.check("boundary: an empty file is refused before any write",
      emptyFile.threw && emptyFile.code === "IMPORT_INVALID_FILE", JSON.stringify(emptyFile));

    // ---- 4. malformed rows: whole-import refuse, nothing written (DERIVED fail-fast) -------
    const before = await db1.Task.count({});
    const mismatch = await captureCall(() => importEntitiesIntoDb(db1, "Task", csvFile("title,status,n\r\nalpha,open\r\n")));
    const afterMismatch = await db1.Task.count({});
    harness.check("boundary: a column-count mismatch refuses the WHOLE import (partial-vs-atomic: Base44 UNKNOWN)",
      mismatch.threw && mismatch.code === "IMPORT_CSV_PARSE_FAILED" && afterMismatch === before,
      JSON.stringify({ code: mismatch.code, before, after: afterMismatch }));

    // ---- 5. validation is the EXISTING bulkCreate machine's, unchanged -------------------
    const badNumber = await captureCall(() => importEntitiesIntoDb(db1, "Task", csvFile("title,status,n\r\nalpha,open,not-a-number\r\n")));
    const afterBadNumber = await db1.Task.count({});
    harness.check("validation: an invalid row fails through the EXISTING schema validation, atomically",
      badNumber.threw && badNumber.code === "DATABASE_VALIDATION_FAILED" && afterBadNumber === before,
      JSON.stringify({ code: badNumber.code }));
    const unknownCol = await captureCall(() => importEntitiesIntoDb(db1, "Task", csvFile("title,status,bogus\r\nalpha,open,x\r\n")));
    harness.check("validation: an unknown header column is refused — no field is silently dropped",
      unknownCol.threw && unknownCol.code === "DATABASE_VALIDATION_FAILED", JSON.stringify({ code: unknownCol.code }));
    const dup = await importEntitiesIntoDb(db1, "Task", csvFile("title,status,n\r\nsame,open,1\r\nsame,open,1\r\n"));
    harness.check("boundary: duplicates are plain creates — NO upsert is invented (Base44 semantics UNKNOWN)",
      dup.output.imported === 2 && (await db1.Task.filter({ title: "same" })).length === 2,
      JSON.stringify(dup.output.imported));

    // ---- 6. per-record Stage-B events fire through the SAME funnel -----------------------
    const imported = await importEntitiesIntoDb(db1, "Task", csvFile("title,status,n\r\ndelta,open,9\r\neps,done,10\r\n"));
    const evs = (await readEntityEvents(db, P1.id, ENTITIES, {}, { entity: "Task" })).events;
    const evCreated = new Set(evs.filter((e) => e.type === "create").map((e) => e.id));
    harness.check("events: every imported record emits a Stage-B create event through the existing funnel",
      imported.output.items.every((it) => evCreated.has(it.id)),
      JSON.stringify({ imported: imported.output.imported, event_creates: evCreated.size }));

    // ---- 7. RLS: ownership stamping, isolation, anonymous refusal --------------------------
    const r1 = await importEntitiesIntoDb(dbR1, "Ledger", csvFile(`owner,body\r\n${userA1.id},row-1\r\n`));
    const mine = await dbR1.Ledger.filter({ body: "row-1" });
    const theirs = await dbR2.Ledger.filter({ body: "row-1" });
    harness.check("RLS: imported rows are stamped to the importing user and hidden from another user",
      r1.output.imported === 1 && mine.length === 1 && theirs.length === 0,
      JSON.stringify({ imported: r1.output.imported, mine: mine.length, theirs: theirs.length }));
    const anon = await captureCall(() => importEntitiesIntoDb(dbRAnon, "Ledger", csvFile("owner,body\r\nx,y\r\n")));
    harness.check("RLS: an anonymous import on an RLS project is refused with AUTH_REQUIRED before any write",
      anon.threw && anon.code === "AUTH_REQUIRED", JSON.stringify(anon));

    // ---- 8. row ceiling + unknown entity ---------------------------------------------------
    const bigRows = ["title,status,n"];
    for (let i = 0; i < 501; i++) bigRows.push(`row-${i},open,${i}`);
    const big = await captureCall(() => importEntitiesIntoDb(db1, "Task", csvFile(bigRows.join("\r\n"))));
    harness.check("boundary: the 500-row bulk ceiling is enforced up front (DERIVED — Base44 limit UNKNOWN)",
      big.threw && big.code === "IMPORT_TOO_MANY_ROWS", JSON.stringify(big.code));
    const unknownEntity = await captureCall(() => importEntitiesIntoDb(db1, "Nope", csvFile("title\nx\n")));
    harness.check("isolation: an unknown entity is refused fail-closed",
      unknownEntity.threw && unknownEntity.code === "DATABASE_ENTITY_NOT_FOUND", JSON.stringify(unknownEntity.code));

    // ---- 9. cross-project isolation ---------------------------------------------------------
    const count2 = await db2.Task.count({});
    await importEntitiesIntoDb(db1, "Task", csvFile("title,status,n\r\nzeta,open,11\r\n"));
    const count2After = await db2.Task.count({});
    harness.check("isolation: an import into one project never touches another project's records",
      count2After === count2, JSON.stringify({ before: count2, after: count2After }));

    // ---- 10. billing neutrality --------------------------------------------------------------
    const msg1 = await msgOf(A.ws.id);
    const int1 = await intOf(A.ws.id);
    harness.check("billing: import moves no credits in either pool (Base44 publishes no import charge — none invented)",
      msg1 === msg0 && int1 === int0, `msg ${msg0}→${msg1}; int ${int0}→${int1}`);

    // ---- 11. certification boundary pinned ---------------------------------------------------
    harness.check("boundary: every undocumented semantic is pinned UNKNOWN with its DERIVED bounded choice",
      IMPORT_CONTRACT.delimiter.includes("DOCUMENTED") && IMPORT_CONTRACT.encoding.includes("UNKNOWN")
      && IMPORT_CONTRACT.header.includes("UNKNOWN") && IMPORT_CONTRACT.size_limit.includes("UNKNOWN")
      && IMPORT_CONTRACT.malformed_rows.includes("UNKNOWN") && IMPORT_CONTRACT.duplicates.includes("UNKNOWN")
      && IMPORT_CONTRACT.partial_vs_atomic.includes("UNKNOWN") && IMPORT_CONTRACT.status_values.includes("UNKNOWN")
      && IMPORT_CONTRACT.service_role.includes("UNKNOWN") && IMPORT_CONTRACT.billing.includes("none invented")
      && IMPORT_CONTRACT.parsing.includes("NO AI extraction"),
      JSON.stringify(IMPORT_CONTRACT));
    harness.check("surface: the `db` and `files` exports remain registered in the runtime export surface",
      RUNTIME_EXPORTS.includes("db") && RUNTIME_EXPORTS.includes("files"), "db+files present");

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    // Bulk cleanup — also sweeps scratch rows left behind by earlier interrupted runs of this suite.
    const scratchProjects = await db.entities.Project.filter({ name: { $regex: "^p9xi-proj-" } }, "created_date", 200).catch(() => []);
    const scratchWorkspaces = await db.entities.Workspace.filter({ name: { $regex: "^billing-test p9xi" } }, "created_date", 200).catch(() => []);
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
      await db.entities.RateLimitBucket.deleteMany({ identity: { $regex: "^user:p9xi_" } }).catch(() => {});
    }
    for (const planId of created.plans) await db.entities.BillingPlan.delete(planId).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p9xi" } }).catch(() => {});
  }
}