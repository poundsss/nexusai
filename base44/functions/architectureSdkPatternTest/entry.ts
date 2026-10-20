// Targeted certification that the Architecture file-reference parser recognizes the `base44.*` SDK
// patterns generated apps actually use, producing the SAME reads/writes/calls signals the existing
// db./server. grammars do — and that the existing db./server. extraction is unchanged.
//
// Pure, no database: it exercises the REAL `fileReferences` against hand-built file content. The
// reads/writes/calls edges are wired from these signals by existing, unchanged code in
// deriveArchitecture, so a correct signal is a correct edge.
import { fileReferences } from "../../shared/architectureGraph.ts";

export default async function () {
  try {
    const checks = [];

    // 1. base44.entities.Entity.list/get → reads
    const refRead = fileReferences(`const rows = await base44.entities.Todo.list('-created_date', 10); const one = await base44.entities.Todo.get(id);`);
    checks.push({
      name: "base44.entities read ops → reads flag",
      passed: refRead.entities.some((e) => e.name === "Todo" && e.reads && !e.writes),
      detail: JSON.stringify(refRead.entities),
    });

    // 2. base44.entities.Entity.create/update/delete → writes
    const refWrite = fileReferences(`await base44.entities.Todo.create({ title: 'x' }); await base44.entities.Todo.update(id, { done: true }); await base44.entities.Todo.delete(id);`);
    checks.push({
      name: "base44.entities write ops → writes flag",
      passed: refWrite.entities.some((e) => e.name === "Todo" && e.writes && !e.reads),
      detail: JSON.stringify(refWrite.entities),
    });

    // 3. base44.functions.invoke("fn") → function call ref
    const refFn = fileReferences(`const res = await base44.functions.invoke("getWeather", { city: 'NYC' });`);
    checks.push({
      name: "base44.functions.invoke → function name",
      passed: refFn.functions.includes("getWeather"),
      detail: JSON.stringify(refFn.functions),
    });

    // 4. base44.entities read+write on the same identifier → both flags (mirrors db.* transform path)
    const refBoth = fileReferences(`const rows = await base44.entities.Todo.list(); await base44.entities.Todo.create({ title: rows[0]?.title });`);
    checks.push({
      name: "base44.entities read+write → reads AND writes",
      passed: refBoth.entities.some((e) => e.name === "Todo" && e.reads && e.writes),
      detail: JSON.stringify(refBoth.entities),
    });

    // 5. existing db.* / server.* extraction unchanged
    const refLegacy = fileReferences(`const rows = await db.Customer.list(); await server.reportSummary({}); await db.Customer.create({});`);
    const legacyDbRead = refLegacy.entities.some((e) => e.name === "Customer" && e.reads && e.writes);
    const legacyFn = refLegacy.functions.includes("reportSummary");
    checks.push({
      name: "db.* read+write and server.* call unchanged",
      passed: legacyDbRead && legacyFn,
      detail: JSON.stringify({ entities: refLegacy.entities, functions: refLegacy.functions }),
    });

    // 6. mixed styles in one file both resolve
    const refMixed = fileReferences(`const a = await base44.entities.Todo.list(); const b = await db.Customer.list(); await base44.functions.invoke("reportSummary", {});`);
    checks.push({
      name: "mixed base44.* and db.* in one file both resolve",
      passed: refMixed.entities.some((e) => e.name === "Todo" && e.reads) && refMixed.entities.some((e) => e.name === "Customer" && e.reads) && refMixed.functions.includes("reportSummary"),
      detail: JSON.stringify({ entities: refMixed.entities, functions: refMixed.functions }),
    });

    const failed = checks.filter((c) => !c.passed);
    if (failed.length) {
      return { passed: false, failures: failed, checks };
    }
    return { passed: true, checks };
  } catch (e) {
    return { passed: false, error: String(e?.message || e), stack: String(e?.stack || "").split("\n").slice(0, 8) };
  }
}
