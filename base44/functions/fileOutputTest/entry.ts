// Regression: file-generation / patch output normalization and the "planned changes applied" gate.
import { normalizeFileOutput, normalizePatchOutput, normalizePlanOutput } from "../../shared/planOutput.ts";
import { unappliedPlannedPaths, failureRecord } from "../../shared/runDiagnostics.ts";

export const config = { method: "POST" };

export default async function () {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 200) });
  const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  check("file: string JSON parsed", normalizeFileOutput('{"content":"export default 1;"}').content === "export default 1;", "ok");
  check("file: fenced JSON parsed", normalizeFileOutput('```json\n{"content":"x"}\n```').content === "x", "ok");
  const obj = { content: "y" };
  check("file: object passthrough", normalizeFileOutput(obj) === obj, "same");
  const e1 = throws(() => normalizeFileOutput("not json {"));
  check("file: invalid JSON rejected", e1?.code === "FILE_OUTPUT_INVALID_JSON", e1?.message);
  const e2 = throws(() => normalizeFileOutput('{"path":"a"}'));
  check("file: missing content rejected", e2?.code === "FILE_OUTPUT_MISSING_CONTENT", e2?.message);
  const e3 = throws(() => normalizeFileOutput(""));
  check("file: empty output rejected", e3?.code === "FILE_OUTPUT_INVALID_SHAPE", e3?.message);

  check("patch: string JSON parsed", normalizePatchOutput('{"patches":[{"find":"a","replace":"b"}]}').patches.length === 1, "ok");
  const e4 = throws(() => normalizePatchOutput('{"patches":[]}'));
  check("patch: empty edit list rejected", e4?.code === "PATCH_OUTPUT_EMPTY", e4?.message);
  const e5 = throws(() => normalizePatchOutput({}));
  check("patch: missing patches rejected", e5?.code === "PATCH_OUTPUT_EMPTY", e5?.message);
  const e6 = throws(() => normalizePatchOutput({ patches: [{ find: "", replace: "x" }] }));
  check("patch: invalid edit rejected", e6?.code === "PATCH_OUTPUT_INVALID_EDIT", e6?.message);

  const rec = failureRecord("model_output", "src/pages/Home.js", "rewrite", e2);
  check("diagnostic keeps stage/path/code", rec.stage === "model_output" && rec.path === "src/pages/Home.js" && rec.code === "FILE_OUTPUT_MISSING_CONTENT", JSON.stringify(rec));

  const manifest = [{ path: "src/App.js", action: "patch" }, { path: "src/pages/Home.js", action: "rewrite" }, { path: "src/old.js", action: "delete" }];
  const missing = unappliedPlannedPaths(manifest, [{ path: "src/App.js", change: "modified" }]);
  check("gate: unapplied planned path detected", missing.length === 1 && missing[0] === "src/pages/Home.js", missing.join(","));
  check("gate: no changes at all → all content paths unapplied", unappliedPlannedPaths(manifest, []).length === 2, "ok");
  check("gate: all applied → none", unappliedPlannedPaths(manifest, [{ path: "src/App.js", change: "modified" }, { path: "src/pages/Home.js", change: "modified" }]).length === 0, "ok");

  const pe = throws(() => normalizePlanOutput(null));
  check("planner: empty message preserved", pe?.code === "PLAN_INVALID_SHAPE" && pe.message.includes("empty result"), pe?.message);
  const pa = throws(() => normalizePlanOutput("[1]"));
  check("planner: array message preserved", pa?.message === "Planner returned an array instead of a plan object", pa?.message);

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed });
}