// Minimal RFC-4180-ish CSV serializer extracted from the existing checkpoint-download
// escaping in useDataHistory.js (JSON.stringify per cell → handles commas, quotes, newlines,
// null/undefined ⇒ ""). No field mapping, no type coercion, no invented columns.

export function csvEscape(v) {
  return JSON.stringify(v ?? "");
}

export function recordsToCsv(fields, rows) {
  const header = (fields || []).map(csvEscape).join(",");
  const body = (rows || []).map((r) => (fields || []).map((f) => csvEscape(r[f])).join(","));
  return [header, ...body].join("\n");
}

export function downloadCsv(filename, fields, rows) {
  const csv = recordsToCsv(fields, rows);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}