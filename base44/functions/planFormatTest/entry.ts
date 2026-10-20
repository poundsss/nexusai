// Regression: planner responses in Markdown/text are refused with a stable code; JSON forms still work.
import { normalizePlanOutput, normalizeFileOutput, normalizePatchOutput } from "../../shared/planOutput.ts";
import { PLANNER_JSON_ONLY, PLANNING_CALL, finalizePlanManifest, truncationNote, normalizePlanFileExports } from "../../shared/runPipeline.ts";
import { buildGeneratorPrompt, buildPatcherPrompt } from "../../shared/prompts.ts";

export const config = { method: "POST" };

export default async function () {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 200) });
  const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  const md = throws(() => normalizePlanOutput("# Plan\n\n1. Rewrite Home\n2. Add component"));
  check("markdown '#': PLAN_NOT_JSON", md?.code === "PLAN_NOT_JSON" && md.message === "Planner returned non-JSON text instead of a JSON plan object", `${md?.code} ${md?.message}`);
  const prose = throws(() => normalizePlanOutput("Sure! Here is the plan: ..."));
  check("prose: PLAN_NOT_JSON (no heuristic conversion)", prose?.code === "PLAN_NOT_JSON", prose?.code);

  check("valid JSON text parsed", normalizePlanOutput('{"files":[{"path":"a"}]}').files.length === 1, "ok");
  check("fenced JSON parsed", Array.isArray(normalizePlanOutput('```json\n{"files":[]}\n```').files), "ok");
  const obj = { files: [] };
  check("object passthrough", normalizePlanOutput(obj) === obj, "same");

  const inv = throws(() => normalizePlanOutput("{not json"));
  check("compat: invalid JSON message", inv?.code === "PLAN_INVALID_JSON" && inv.message.startsWith("Planner returned invalid JSON:"), inv?.message);
  const arr = throws(() => normalizePlanOutput("[1]"));
  check("compat: array message", arr?.message === "Planner returned an array instead of a plan object", arr?.message);
  const nul = throws(() => normalizePlanOutput(null));
  check("compat: empty message", nul?.message === "Planner returned an empty result (no plan)", nul?.message);

  check("prompt reinforcement present", /ONLY a single JSON object/.test(PLANNER_JSON_ONLY) && /no code fences/i.test(PLANNER_JSON_ONLY), "ok");
  check("planning timeout unchanged", PLANNING_CALL.timeoutMs === 90000 && PLANNING_CALL.maxAttempts === 1, JSON.stringify(PLANNING_CALL));
  check("file/patch normalizers intact", normalizeFileOutput('{"content":"x"}').content === "x" && normalizePatchOutput({ patches: [{ find: "a", replace: "b" }] }).patches.length === 1, "ok");

  const gen = buildGeneratorPrompt();
  const pat = buildPatcherPrompt();
  check("generator prompt requires {content} JSON envelope", gen.includes('Respond with ONLY a JSON object {"content":"<complete file content>"}') && gen.includes("No Markdown, code fences, or commentary.") && !gen.includes("Output only the complete file content"), gen.slice(0, 160));
  check("patcher prompt requires {patches} JSON envelope", pat.includes('Respond with ONLY a JSON object {"patches":[{"find":"<exact substring>","replace":"<new text>"}]}') && pat.includes("No Markdown, code fences, or commentary."), pat.slice(0, 200));
  const raw = throws(() => normalizeFileOutput("export default function Home() { return null; }"));
  check("raw source rejected", raw?.code === "FILE_OUTPUT_INVALID_JSON", raw?.code);

  const mk = (n, extra = {}) => ({ files: Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.js`, action: "create" })), entities: [], integrations: [], secrets: [], ...extra });
  const e1 = finalizePlanManifest(mk(0), "default");
  check("empty build plan flagged PLAN_EMPTY", e1.empty && !e1.truncated.length, JSON.stringify(e1));
  check("empty plan with entity is not empty", !finalizePlanManifest(mk(0, { entities: [{ name: "X" }] }), "default").empty, "ok");
  check("styles.css-only plan is empty", finalizePlanManifest({ ...mk(0), files: [{ path: "styles.css" }] }, "default").empty, "ok");
  const tp = mk(17); const t = finalizePlanManifest(tp, "default");
  check("truncated plan keeps 14 and records dropped", tp.files.length === 14 && t.truncated.join() === "src/f14.js,src/f15.js,src/f16.js" && !t.empty, t.truncated.join());
  check("truncation note lists dropped paths", truncationNote(t.truncated).includes("src/f16.js") && truncationNote([]) === "", "ok");
  const np = mk(3); const n = finalizePlanManifest(np, "default");
  check("normal plan unchanged", np.files.length === 3 && !n.truncated.length && !n.empty, JSON.stringify(n));

  {
    const s = normalizePlanFileExports([{ path: "src/pages/Home.js", exports: "default Home" }]);
    check("exports string -> one-item array", Array.isArray(s[0].exports) && s[0].exports.join() === "default Home", JSON.stringify(s[0].exports));
    const m = normalizePlanFileExports([{ path: "a" }]);
    check("exports missing stays missing", !("exports" in m[0]), JSON.stringify(m[0]));
    const arr = ["default A", "B"]; const a = normalizePlanFileExports([{ path: "a", exports: arr }]);
    check("exports string array unchanged", a[0].exports === arr && arr.length === 2, JSON.stringify(a[0].exports));
    for (const [label, bad] of [["number", 5], ["object", { a: 1 }], ["null", null], ["mixed array", ["ok", 3]]]) {
      const e = throws(() => normalizePlanFileExports([{ path: "x.js", exports: bad }]));
      check(`exports ${label} rejected PLAN_INVALID_EXPORTS`, e?.code === "PLAN_INVALID_EXPORTS" && e.retryable === false && e.message.includes("x.js"), e?.code);
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed });
}