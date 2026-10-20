// Targeted certification for the one-time design-system restyle eligibility
// (base44/shared/designSystemApply.ts). Pure: runs against an in-memory entity stub that
// implements the exact filter operators the function uses ($lt/$gt/$ne, equality, sort, limit).
import { designRestylePending } from "../../shared/designSystemApply.ts";

export const config = { method: "POST" };

function match(row, q) {
  return Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object") {
      if ("$lt" in v && !(row[k] < v.$lt)) return false;
      if ("$gt" in v && !(row[k] > v.$gt)) return false;
      if ("$ne" in v && row[k] === v.$ne) return false;
      return true;
    }
    return row[k] === v;
  });
}
function stub(tables) {
  const entities = {};
  for (const [name, rows] of Object.entries(tables)) {
    entities[name] = { filter: async (q, _sort, limit) => rows.filter((r) => match(r, q)).sort((a, b) => (a.created_date < b.created_date ? 1 : -1)).slice(0, limit) };
  }
  return { entities };
}

const P = { id: "p1", design_system_id: "shadcn" };
const SEL = { project_id: "p1", action: "project_builder_settings.design_system_set", created_date: "2026-01-02T00:00:00" };
const run = (id, created_date, status = "RUNNING", mode = "default", project_id = "p1") => ({ id, project_id, created_date, status, mode });

Deno.serve(async () => {
  const cur = run("cur", "2026-01-03T00:00:00");
  const cases = [
    ["new app first build: no restyle", { AuditLog: [SEL], AIRun: [cur] }, cur, false],
    ["existing app after selection: restyle", { AuditLog: [SEL], AIRun: [run("old", "2026-01-01T00:00:00", "COMPLETED"), cur] }, cur, true],
    ["pre-selection run: no restyle", { AuditLog: [SEL], AIRun: [run("old", "2026-01-01T00:00:00", "COMPLETED"), run("early", "2026-01-01T12:00:00")] }, run("early", "2026-01-01T12:00:00"), false],
    ["failed build retries", { AuditLog: [SEL], AIRun: [run("old", "2026-01-01T00:00:00", "COMPLETED"), run("f", "2026-01-02T06:00:00", "FAILED"), run("c", "2026-01-02T07:00:00", "CANCELLED"), cur] }, cur, true],
    ["completed build consumes", { AuditLog: [SEL], AIRun: [run("old", "2026-01-01T00:00:00", "COMPLETED"), run("done", "2026-01-02T06:00:00", "COMPLETED"), cur] }, cur, false],
    ["discuss does not consume", { AuditLog: [SEL], AIRun: [run("old", "2026-01-01T00:00:00", "COMPLETED"), run("d", "2026-01-02T06:00:00", "COMPLETED", "discuss"), cur] }, cur, true],
    ["discuss-only history is not 'built'", { AuditLog: [SEL], AIRun: [run("d0", "2026-01-01T00:00:00", "COMPLETED", "discuss"), cur] }, cur, false],
    ["other project's builds ignored", { AuditLog: [SEL], AIRun: [run("x", "2026-01-01T00:00:00", "COMPLETED", "default", "p2"), cur] }, cur, false],
  ];
  const results = [];
  for (const [name, tables, r, expected] of cases) {
    const got = await designRestylePending(stub(tables), r, P);
    results.push({ name, ok: got === expected, detail: `expected ${expected}, got ${got}` });
  }
  const failed = results.filter((x) => !x.ok);
  return Response.json({ ok: !failed.length, passed: results.length - failed.length, failed: failed.length, results });
});