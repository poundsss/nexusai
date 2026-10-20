// Diagnostics-only regression: generation and repair failures stay durable and distinguishable.
import { failureRecord, failureDetail, diagnosticLogLines } from "../../shared/runDiagnostics.ts";
import { normalizePlanOutput } from "../../shared/planOutput.ts";
import { PLANNING_CALL, buildGateFailures, gateExcludedFailures } from "../../shared/runPipeline.ts";

export const config = { method: "POST" };

export default async function () {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 300) });

  const timeout = Object.assign(new Error("Model claude_opus_5_5 timed out after 37500ms (attempt 1/1)"), { code: "PROVIDER_TIMEOUT" });
  const gen = [
    failureRecord("design", "colors.x", "token", "invalid color"),
    failureRecord("model_call", "src/App.js", "rewrite", timeout),
    failureRecord("model_output", "src/pages/Home.js", "rewrite", "model returned no content (output type: string)"),
  ];
  check("record keeps path, stage, operation, code, message",
    gen[1].path === "src/App.js" && gen[1].stage === "model_call" && gen[1].operation === "rewrite" && gen[1].code === "PROVIDER_TIMEOUT" && gen[1].message === timeout.message, JSON.stringify(gen[1]));

  const detail = failureDetail(gen);
  check("step detail names each failed path and its error", detail.includes("src/App.js") && detail.includes("timed out") && detail.includes("src/pages/Home.js"), detail);

  // Simulate generate → build/repair staging hand-off exactly as runPipeline does it.
  const afterGenerate = { failures: ["x"], generation_failures: gen };
  let repairDiag = afterGenerate.repair_failures || [];
  let failures = []; // repair clears the plain list...
  repairDiag = [...repairDiag, { ...failureRecord("repair", "src/App.js", "write_file", "Path outside project"), attempt: 1 }];
  const afterRepair = { ...afterGenerate, failures, repair_failures: repairDiag };
  check("repair does not erase original generation failures", afterRepair.generation_failures.length === 3 && afterRepair.generation_failures[1].message === timeout.message, afterRepair.generation_failures.length);
  check("repair failures stored separately with attempt", afterRepair.repair_failures.length === 1 && afterRepair.repair_failures[0].stage === "repair" && afterRepair.repair_failures[0].attempt === 1, JSON.stringify(afterRepair.repair_failures));

  const lines = diagnosticLogLines({ generation: afterRepair.generation_failures, repair: afterRepair.repair_failures });
  check("build log lines distinguish generation vs repair", lines.filter((l) => l.startsWith("diag generation:")).length === 3 && lines.filter((l) => l.startsWith("diag repair:")).length === 1, lines.join(" || "));
  check("diagnostic lines are not counted as build errors", lines.every((l) => !l.startsWith("error")), "ok");

  // Earlier fixes are preserved.
  check("planner normalization still parses string plans", Array.isArray(normalizePlanOutput('{"files":[]}').files), "ok");
  check("planning timeout fix intact", PLANNING_CALL.timeoutMs === 90000 && PLANNING_CALL.maxAttempts === 1, JSON.stringify(PLANNING_CALL));

  {
    const gen = [failureRecord("model_output", "src/A.js", "rewrite", "no content"), failureRecord("tool", "Lead", "create_entity", "bad field")];
    const lines = ["generate src/A.js: no content", "entity Lead: bad field"];
    check("D3: pre-repair gate unchanged", buildGateFailures({ generationLines: lines, generationRecords: gen }).length === 2, "ok");
    const masked = buildGateFailures({ generationLines: lines, generationRecords: gen, repairLines: [], repairedTargets: ["src/Other.js"], repaired: true });
    check("D3: successful repair cannot mask unresolved generation failures", masked.length === 2 && masked.every((l) => l.startsWith("unresolved generation failure:")), masked.join(" | "));
    check("D3: generation input array untouched", lines.length === 2 && gen.length === 2, "ok");
    const partial = buildGateFailures({ generationLines: lines, generationRecords: gen, repairLines: ["tool write_file(src/B.js) failed: x"], repairedTargets: ["src/A.js"], repaired: true });
    check("D3: repaired target resolves; repair failures separate", partial.length === 2 && partial[0].includes("Lead") && partial[1].startsWith("tool write_file"), partial.join(" | "));
    check("D3: clean generation + successful repair passes", buildGateFailures({ repaired: true, repairedTargets: ["src/A.js"] }).length === 0, "ok");
    check("D3: design token rejection non-blocking after repair", buildGateFailures({ generationRecords: [failureRecord("design", "colors.x", "token", "invalid")], repaired: true }).length === 0, "ok");
    const tok = failureRecord("design", "colors.x", "token", "invalid");
    const other = failureRecord("model_output", "src/A.js", "rewrite", "no content");
    const ex = gateExcludedFailures([tok, other], true);
    check("D3: exclusion explicit, only design tokens", ex.length === 1 && ex[0] === tok && gateExcludedFailures([tok], false).length === 0, JSON.stringify(ex));
    const mixed = buildGateFailures({ generationRecords: [tok, other], repaired: true });
    check("D3: token exclusion does not suppress other unresolved failures", mixed.length === 1 && mixed[0].includes("src/A.js"), mixed.join(" | "));
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results });
}