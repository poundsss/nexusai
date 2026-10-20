// P-9.x — `entities.<Entity>.importEntities(file)` (Base44 SDK parity surface).
//
// DOCUMENTED (Base44 SDK reference, entities): importEntities(file) — "Imports records from a
// file, typically CSV. Requires a browser environment." Returns ImportResult<T> ({ status,
// output }).
//
// Every semantic Base44 does NOT publish is a NEXUSAI-DERIVED bounded choice, marked DERIVED
// below — never claimed as parity (UNKNOWN in the docs):
//   • accepted input ........ text/csv (or an untyped file named *.csv — browsers often report
//                            no MIME type for .csv); DERIVED;
//   • size cap .............. the EXISTING private-file primitive's decoded-bytes cap (5 MB);
//                            DERIVED — Base44 publishes no import size limit;
//   • delimiter ............. DOCUMENTED (Base44, Import entity records from CSV): commas,
//                            semicolons and tabs all work; sniffed per file (first non-empty
//                            row, unquoted occurrences; ties → , > ; > tab); quoted fields,
//                            "" escapes, LF/CRLF/CR rows;
//   • encoding .............. UTF-8, decoded server-side from the uploaded bytes; DERIVED;
//   • cell coercion .......... a cell that IS a JSON number or the literal true/false becomes
//                            that scalar — everything else stays a string (Base44 coercion
//                            semantics: UNKNOWN);
//   • header ................. the first row is REQUIRED and names the fields; every header
//                            cell must be non-empty; DERIVED;
//   • malformed rows ........ a structural parse error or a column-count mismatch fails the
//                            WHOLE import BEFORE any write — the existing bulkCreate fail-fast
//                            contract; no partial import is invented (partial-vs-atomic in
//                            Base44: UNKNOWN);
//   • duplicates ............ none: every parsed row is a plain create through bulkCreate —
//                            no upsert or id-collision semantics are invented (UNKNOWN);
//   • row ceiling ............ one bulkCreate call's 500-record bound; DERIVED;
//   • status values .......... "success" on the documented shape; failures raise the existing
//                            structured DatabaseError contract (exact Base44 values: UNKNOWN);
//   • service role ........... NOT implemented — this is the browser runtime surface only
//                            (Base44 service-role import semantics: UNKNOWN);
//   • billing ................ NONE. Base44 publishes no import charge and none is invented;
//                            no storage upload happens — the bytes travel inside the authorized
//                            db bridge call like every other write, so the upload primitive's
//                            1-credit charge does not apply.
//
// Validation, RLS gates, relations and per-record Stage-B events are the EXISTING bulkCreate
// machine's, unchanged. No new entity, schema, migration or write path exists here.
import { decodeBase64, MAX_FILE_BYTES } from "./appFiles.ts";
import { dbError } from "./appData.ts";

// Keep in lockstep with MAX_BULK in appData.ts — a larger import would fail inside bulkCreate
// with DATABASE_BULK_LIMIT anyway; refusing it up front keeps the error explicit.
const MAX_IMPORT_ROWS = 500;

/** RFC-4180-shaped deterministic CSV parser for ONE delimiter: quoted fields, "" escapes. */
function parseCsvRows(text, delim) {
  const rows = [];
  let cells = [], cell = "", quoted = false;
  const pushCell = () => { cells.push(cell); cell = ""; };
  const pushRow = () => { pushCell(); rows.push(cells); cells = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      pushCell();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || cells.length) pushRow();
  // Fully-empty rows (blank lines) are skipped; a row with any content is kept.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// DERIVED scalar coercion (Base44 semantics UNKNOWN): every CSV cell is a string, but entity
// fields are typed — a cell that round-trips exactly as a number, or the literal true/false,
// becomes that scalar so a typed field never receives a stringified value it must refuse.
function coerceCell(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v) return Number(v);
  return v;
}

// DOCUMENTED (Base44, Import entity records from CSV): commas, semicolons and tabs all work as
// the delimiter. The delimiter is sniffed per file: unquoted occurrences counted in the FIRST
// non-empty row (quote-aware, so a quoted field's embedded commas are never counted), highest
// count wins, ties resolved deterministically to , then ; then tab; a tie-free absence falls
// back to comma. No other delimiter is ever accepted — the three are the documented set.
const CSV_DELIMITERS = [",", ";", "\t"];
function sniffDelimiter(text) {
  const firstLine = (text.split(/\r?\n/).find((l) => l.trim() !== "") || "").split(/\r/)[0] || "";
  const counts = CSV_DELIMITERS.map(() => 0);
  let quoted = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (quoted) { if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else { const idx = CSV_DELIMITERS.indexOf(ch); if (idx >= 0) counts[idx]++; }
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
  return CSV_DELIMITERS[best];
}

function csvToRecords(text) {
  const rows = parseCsvRows(text, sniffDelimiter(text));
  if (!rows.length) throw dbError("IMPORT_CSV_PARSE_FAILED", "Import failed: the file contains no CSV rows", { operation: "importEntities" });
  const header = rows[0].map((h) => h.trim());
  if (!header.length || header.some((h) => !h)) {
    throw dbError("IMPORT_CSV_PARSE_FAILED", "Import failed: the first row must be a header of non-empty column names", { operation: "importEntities" });
  }
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length !== header.length) {
      throw dbError("IMPORT_CSV_PARSE_FAILED", `Import failed: row ${i + 1} has ${row.length} column(s), expected ${header.length}`, { operation: "importEntities", row: i + 1 });
    }
    const record = {};
    for (let c = 0; c < header.length; c++) if (row[c] !== "") record[header[c]] = coerceCell(row[c]);
    records.push(record);
  }
  return records;
}

/**
 * The importEntities op, shared by the preview bridge and the deployed runtime. `db` is an
 * EXISTING createServerDb accessor — parsing happens here, everything else (validation, RLS,
 * relations, per-record events) is bulkCreate's, unchanged.
 */
export async function importEntitiesIntoDb(db, entityName, { filename, content_type, content_base64 } = {}) {
  const type = String(content_type || "").toLowerCase().split(";")[0].trim();
  const name = String(filename || "");
  if (type !== "text/csv" && !(type === "" && /\.csv$/i.test(name))) {
    throw dbError("IMPORT_INVALID_FILE", `Import failed: "${type || name || "file"}" is not a CSV file`, { operation: "importEntities", content_type: type });
  }
  let bytes;
  try { bytes = decodeBase64(content_base64); }
  catch (e) { throw dbError("IMPORT_INVALID_FILE", `Import failed: ${e.message}`, { operation: "importEntities" }); }
  if (!bytes.length) throw dbError("IMPORT_INVALID_FILE", "Import failed: the file is empty", { operation: "importEntities" });
  if (bytes.length > MAX_FILE_BYTES) {
    throw dbError("IMPORT_INVALID_FILE", `Import failed: file exceeds the ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB limit`, { operation: "importEntities", size: bytes.length });
  }
  const records = csvToRecords(new TextDecoder("utf-8").decode(bytes));
  if (!records.length) throw dbError("IMPORT_INVALID_FILE", "Import failed: the file has a header but no data rows", { operation: "importEntities" });
  if (records.length > MAX_IMPORT_ROWS) {
    throw dbError("IMPORT_TOO_MANY_ROWS", `Import failed: ${records.length} rows exceed the ${MAX_IMPORT_ROWS}-row import limit`, { operation: "importEntities", limit: MAX_IMPORT_ROWS, rows: records.length });
  }
  // The EXISTING machine: schema validation, RLS ownership/gates, relation enforcement and
  // per-record Stage-B events — all unchanged, one fail-fast atomic call.
  const items = await db[entityName].bulkCreate(records);
  // DOCUMENTED return shape (ImportResult: status/output). The status VALUE is DERIVED;
  // a failure never reaches here as a payload — it raises the structured db error contract.
  // B6: bulkCreate resolves with the created records array — the import output shape is kept
  // by adapting at this boundary.
  return { status: "success", output: { imported: items.length, items } };
}