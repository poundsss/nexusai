// Regression test for "Cannot create property 'files' on string" in the Builder planning phase.
import { normalizePlanOutput } from "../../shared/planOutput.ts";

export const config = { method: "POST" };

export default async function () {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 200) });
  const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  const fromString = normalizePlanOutput('{"plan":["a"],"files":[{"path":"src/App.jsx","action":"create"}],"message":"m"}');
  check("string: parsed into object", typeof fromString === "object" && fromString.files[0].path === "src/App.jsx", JSON.stringify(fromString));
  fromString.entities = [];
  check("string: result is mutable like the pipeline does", Array.isArray(fromString.entities), "ok");

  const fenced = normalizePlanOutput('```json\n{"files":[]}\n```');
  check("string: fenced JSON parsed", Array.isArray(fenced.files), JSON.stringify(fenced));

  const obj = { plan: [], files: [], message: "x" };
  check("object: passed through unchanged (same reference)", normalizePlanOutput(obj) === obj, "same");

  const bad = throws(() => normalizePlanOutput("not json {"));
  check("invalid JSON: rejected with clear error", bad?.code === "PLAN_INVALID_JSON" && bad.message.startsWith("Planner returned invalid JSON"), bad?.message);
  const arr = throws(() => normalizePlanOutput("[1,2]"));
  check("array JSON: rejected", arr?.code === "PLAN_INVALID_SHAPE", arr?.message);
  const nul = throws(() => normalizePlanOutput(null));
  check("null: rejected", nul?.code === "PLAN_INVALID_SHAPE" && nul.message.includes("empty result"), nul?.message);

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results });
}