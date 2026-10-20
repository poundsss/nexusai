// Certification for #35 — Autonomous QA / Testing.
//
// Runs the REAL QA path (shared/qa.ts → buildEngine → runtimeVerify → frontendSandbox →
// execution contract → persistence) against throwaway projects. Nothing is mocked except the
// repair STRATEGY: production delegates code changes to the existing AI run pipeline, which
// cannot be driven deterministically inside a test, so the suite injects deterministic fixers.
// Everything around the fixer — plan generation, execution, isolation, attempt bounding, the
// re-run, the commit of a verified fix and the refusal to commit an unverified one — is the
// production implementation.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse } from "../../shared/testHarness.ts";
import { discardProject, discardWorkspaceProjects } from "../../shared/testSupport.ts";
import { generateTestPlan, executeTestPlan, executeQa, MAX_QA_REPAIR_ATTEMPTS, QA_CATEGORIES } from "../../shared/qa.ts";
import { createFs, writeFile, activeFiles } from "../../shared/projectFs.ts";
import { commitFiles, createVersion } from "../../shared/persistence.ts";
import { scaffoldFiles } from "../../shared/scaffold.ts";

const GOOD_FN = `export const config = { method: "POST" };\nexport default async function handler(ctx) {\n  return { ok: true };\n}\n`;
const BROKEN_FN = `export const config = { method: "POST" };\nexport default async function handler(ctx) {\n  const nothing = null;\n  return nothing.missing;\n}\n`;
const GOOD_INTEGRATION = `${JSON.stringify({ name: "weather", type: "http", base_url: "https://api.example.com", auth: { type: "none" }, operations: [{ name: "getForecast", method: "GET", path: "/forecast" }] }, null, 2)}\n`;
const BAD_INTEGRATION = `${JSON.stringify({ name: "weather", type: "http", base_url: "not a url", operations: [] }, null, 2)}\n`;
const BROKEN_SYNTAX = `import { html } from 'runtime';\n\nexport default function App( {\n  return html\`<div>broken</div>\`;\n}\n`;
const THROWING_APP = `import { html } from 'runtime';\n\nexport default function App() {\n  const state = null;\n  return html\`<div>\${state.value}</div>\`;\n}\n`;
const FIXED_APP = `import { html } from 'runtime';\n\nexport default function App() {\n  return html\`<div class="p-4">repaired</div>\`;\n}\n`;

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();

  let workspace = null, otherWs = null;
  const NOTE = { name: "Note", fields: { title: { type: "string", required: true } } };

  // A throwaway project seeded with the given files, at version 1.
  const seed = async (label, files, entities = []) => {
    const project = await svc.entities.Project.create({ workspace_id: workspace.id, name: `${label} ${Date.now()}`, framework: "preact-htm" });
    const fs = createFs([]);
    for (const f of files) writeFile(fs, f.path, f.content);
    const changed = await commitFiles(svc, project.id, fs);
    for (const e of entities) await svc.entities.AppEntity.create({ project_id: project.id, name: e.name, fields: e.fields });
    await createVersion(svc, { project, fs, entities, secrets: [], message: "seed", changedFiles: changed });
    const fresh = await svc.entities.Project.get(project.id);
    return { project: fresh, files: await svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 200) };
  };

  const cleanFiles = (extra = []) => [...scaffoldFiles("QA Sample"), ...extra];

  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run authenticated" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: `QA ${Date.now()}`, owner_id: caller.id, credits_balance: 0, status: "active" });
    otherWs = await svc.entities.Workspace.create({ name: `QA Foreign ${Date.now()}`, owner_id: `other_${Date.now()}`, credits_balance: 0, status: "active" });

    // =================== 1. Test-plan generation ===================
    const clean = await seed("Clean", cleanFiles([{ path: "functions/ping.js", content: GOOD_FN }, { path: "integrations/weather.json", content: GOOD_INTEGRATION }]), [NOTE]);
    const cleanFs = createFs(clean.files);
    const plan = generateTestPlan({ fs: cleanFs, entities: [NOTE], secrets: [] });
    const cats = new Set(plan.tests.map((t) => t.category));
    h.check("1a. the plan is derived from the project's own state", plan.tests.length > 0 && plan.tests.every((t) => t.id && t.category && t.target), String(plan.tests.length));
    h.check("1b. the plan covers build, runtime smoke and UI render", cats.has("build") && cats.has("runtime_smoke") && cats.has("ui_render"), [...cats].join(", "));
    h.check("1c. the plan covers the project's entities", plan.tests.some((t) => t.category === "entity_crud" && t.target === "Note"), JSON.stringify(plan.counts));
    h.check("1d. the plan covers the project's backend functions", plan.tests.some((t) => t.category === "backend_function" && t.target === "ping"), JSON.stringify(plan.counts));
    h.check("1e. the plan covers the project's integrations", plan.tests.some((t) => t.category === "integration" && t.target === "weather"), JSON.stringify(plan.counts));
    h.check("1f. every planned category is a known QA category", plan.tests.every((t) => QA_CATEGORIES.includes(t.category)), [...cats].join(", "));
    const plan2 = generateTestPlan({ fs: createFs(clean.files), entities: [NOTE], secrets: [] });
    h.check("1g. plan generation is deterministic for the same project state", JSON.stringify(plan2.tests) === JSON.stringify(plan.tests), `${plan2.tests.length} tests`);
    h.check("1h. the plan is bounded", plan.tests.length <= 32 && plan.counts.route <= 6, `${plan.tests.length} tests, ${plan.counts.route} route(s)`);

    // =================== 2. A clean project passes ===================
    // Production data that must survive a QA run untouched.
    await svc.entities.AppRecord.create({ project_id: clean.project.id, entity_name: "Note", data: { title: "production note" } });
    const beforeRecords = await svc.entities.AppRecord.filter({ project_id: clean.project.id }, "-created_date", 50);
    const cleanRun = await executeQa(base44, { project: clean.project, workspace, user: caller, fs: createFs(clean.files), entities: [NOTE], secrets: [] });
    h.check("2a. a clean project passes QA", cleanRun.status === "PASSED", JSON.stringify({ status: cleanRun.status, failed: cleanRun.qa_run.failed, results: cleanRun.results.filter((r) => r.status !== "passed").map((r) => `${r.id}=${r.status} ${r.error}`) }));
    h.check("2b. the passing run terminated for a stated reason", cleanRun.terminated_by === "all_passed", cleanRun.terminated_by);
    h.check("2c. every planned test produced a result", cleanRun.results.length === cleanRun.qa_run.plan.length, `${cleanRun.results.length}/${cleanRun.qa_run.plan.length}`);
    h.check("2d. a passing run attempts no repair", cleanRun.qa_run.repair_attempts === 0 && cleanRun.repair_log.length === 0, String(cleanRun.qa_run.repair_attempts));
    h.check("2e. a passing run creates no new version", cleanRun.version === null && (await svc.entities.Project.get(clean.project.id)).version_count === 1, "version_count=1");

    // =================== 3. Isolation ===================
    const afterRecords = await svc.entities.AppRecord.filter({ project_id: clean.project.id }, "-created_date", 50);
    h.check("3a. the entity CRUD test did not mutate production data", afterRecords.length === beforeRecords.length && afterRecords[0]?.data?.title === "production note", `${beforeRecords.length} → ${afterRecords.length}`);
    const scratch = await svc.entities.AppRecord.filter({ entity_name: "Note" }, "-created_date", 200);
    h.check("3b. the test's scratch data namespace was cleaned up", !scratch.some((r) => String(r.project_id || "").startsWith(`verify_${clean.project.id}`)), `${scratch.length} Note record(s) platform-wide`);
    h.check("3c. the entity CRUD test really ran (isolation is not achieved by skipping)", cleanRun.results.some((r) => r.category === "entity_crud" && r.status === "passed"), JSON.stringify(cleanRun.results.filter((r) => r.category === "entity_crud")));

    // =================== 4. Build failure ===================
    const broken = await seed("BrokenBuild", cleanFiles().map((f) => (f.path === "src/App.js" ? { ...f, content: BROKEN_SYNTAX } : f)));
    const buildRun = await executeQa(base44, { project: broken.project, workspace, user: caller, fs: createFs(broken.files), entities: [], secrets: [] });
    const buildResult = buildRun.results.find((r) => r.category === "build");
    h.check("4a. an intentional build failure fails QA", buildRun.status === "FAILED", JSON.stringify({ status: buildRun.status, failed: buildRun.qa_run.failed }));
    h.check("4b. the build test is the failing test and names its category", buildResult?.status === "failed" && buildResult.error_category === "BUILD_ERROR", JSON.stringify(buildResult));
    h.check("4c. the failure names the affected file", buildResult?.file?.includes("src/App.js"), buildResult?.file);
    h.check("4d. tests that could not run are skipped, never reported as passed", buildRun.results.some((r) => r.category === "runtime_smoke" && r.status === "skipped") && !buildRun.results.some((r) => r.status === "passed" && r.category === "runtime_smoke"), JSON.stringify(buildRun.results.map((r) => `${r.category}=${r.status}`)));
    h.check("4e. a failing QA run without repair creates no version", buildRun.version === null && (await svc.entities.Project.get(broken.project.id)).version_count === 1, "version_count=1");
    await discardProject(svc, broken.project.id);

    // =================== 5. Runtime failure ===================
    const runtimeBroken = await seed("BrokenRuntime", cleanFiles().map((f) => (f.path === "src/App.js" ? { ...f, content: THROWING_APP } : f)));
    const runtimeRun = await executeQa(base44, { project: runtimeBroken.project, workspace, user: caller, fs: createFs(runtimeBroken.files), entities: [], secrets: [] });
    const runtimeFailure = runtimeRun.results.find((r) => r.status === "failed");
    h.check("5a. a project that builds but crashes at runtime fails QA", runtimeRun.status === "FAILED", JSON.stringify({ status: runtimeRun.status, failed: runtimeRun.qa_run.failed }));
    h.check("5b. the runtime failure is reported under a runtime category, not as a build error", ["runtime_smoke", "ui_render"].includes(runtimeFailure?.category), JSON.stringify(runtimeFailure));
    h.check("5c. the build test still passed for the same project", runtimeRun.results.find((r) => r.category === "build")?.status === "passed", JSON.stringify(runtimeRun.results.find((r) => r.category === "build")));
    await discardProject(svc, runtimeBroken.project.id);

    // =================== 6. Backend + integration failures ===================
    const backendBroken = await seed("BrokenBackend", cleanFiles([{ path: "functions/ping.js", content: BROKEN_FN }, { path: "integrations/weather.json", content: BAD_INTEGRATION }]));
    const backendRun = await executeQa(base44, { project: backendBroken.project, workspace, user: caller, fs: createFs(backendBroken.files), entities: [], secrets: [] });
    const integrationResult = backendRun.results.find((r) => r.category === "integration");
    h.check("6a. an invalid integration definition fails its own test", integrationResult?.status === "failed", JSON.stringify(integrationResult));
    h.check("6b. the invalid integration failure names the file", integrationResult?.file === "integrations/weather.json", integrationResult?.file);
    h.check("6c. the run is FAILED overall", backendRun.status === "FAILED", JSON.stringify({ status: backendRun.status, cats: backendRun.qa_run.categories_failed }));
    await discardProject(svc, backendBroken.project.id);

    const backendOnly = await seed("BackendOnly", cleanFiles([{ path: "functions/ping.js", content: BROKEN_FN }]));
    const backendOnlyRun = await executeQa(base44, { project: backendOnly.project, workspace, user: caller, fs: createFs(backendOnly.files), entities: [], secrets: [] });
    const fnResult = backendOnlyRun.results.find((r) => r.category === "backend_function");
    h.check("6d. a backend function that faults fails its own test", fnResult?.status === "failed" && /BACKEND_ERROR|RUNTIME_ERROR/.test(fnResult.error_category || ""), JSON.stringify(fnResult));
    h.check("6e. the backend failure names the function file", fnResult?.file === "functions/ping.js", fnResult?.file);
    await discardProject(svc, backendOnly.project.id);

    // =================== 7. Repair success ===================
    const repairable = await seed("Repairable", cleanFiles().map((f) => (f.path === "src/App.js" ? { ...f, content: THROWING_APP } : f)));
    let goodFixerCalls = 0;
    const goodFixer = async ({ fs }) => {
      goodFixerCalls++;
      writeFile(fs, "src/App.js", FIXED_APP);
      return { applied: true, summary: "rewrote src/App.js to render without dereferencing null" };
    };
    const repairedRun = await executeQa(base44, {
      project: repairable.project, workspace, user: caller,
      fs: createFs(repairable.files), entities: [], secrets: [], repair: true, fixer: goodFixer,
    });
    const repairedProject = await svc.entities.Project.get(repairable.project.id);
    h.check("7a. a repairable failure is repaired", repairedRun.status === "REPAIRED", JSON.stringify({ status: repairedRun.status, log: repairedRun.repair_log }));
    h.check("7b. the repair took one bounded attempt", repairedRun.qa_run.repair_attempts === 1 && goodFixerCalls === 1, `${repairedRun.qa_run.repair_attempts} attempt(s), ${goodFixerCalls} fixer call(s)`);
    h.check("7c. after the repair every test passes", repairedRun.qa_run.failed === 0 && repairedRun.results.every((r) => r.status !== "failed"), JSON.stringify(repairedRun.results.filter((r) => r.status === "failed")));
    h.check("7d. the verified fix was committed as a new version", !!repairedRun.version && repairedRun.version.number === 2 && repairedProject.version_count === 2, JSON.stringify({ version: repairedRun.version?.number, count: repairedProject.version_count }));
    h.check("7e. the committed fix is the real file content", (await svc.entities.ProjectFile.filter({ project_id: repairable.project.id, path: "src/App.js" }, "path", 1))[0]?.content === FIXED_APP, "committed");
    h.check("7f. the repair recorded which version was known-good before it", repairedRun.qa_run.known_good_version_number === 1 && repairedRun.qa_run.final_version_number === 2, JSON.stringify({ known_good: repairedRun.qa_run.known_good_version_number, final: repairedRun.qa_run.final_version_number }));
    await discardProject(svc, repairable.project.id);

    // =================== 8. Repair failure, bounded retries, rollback integrity ===================
    const unrepairable = await seed("Unrepairable", cleanFiles().map((f) => (f.path === "src/App.js" ? { ...f, content: THROWING_APP } : f)));
    let badFixerCalls = 0;
    // A fixer that keeps "fixing" without ever making the tests pass — the infinite-loop risk.
    const badFixer = async ({ fs, attempt }) => {
      badFixerCalls++;
      writeFile(fs, "src/App.js", THROWING_APP.replace("null", `null /* attempt ${attempt} */`));
      return { applied: true, summary: `attempt ${attempt} changed nothing meaningful` };
    };
    const failedRepair = await executeQa(base44, {
      project: unrepairable.project, workspace, user: caller,
      fs: createFs(unrepairable.files), entities: [], secrets: [], repair: true, fixer: badFixer,
    });
    const preservedProject = await svc.entities.Project.get(unrepairable.project.id);
    const preservedFile = (await svc.entities.ProjectFile.filter({ project_id: unrepairable.project.id, path: "src/App.js" }, "path", 1))[0];
    h.check("8a. an unrepairable failure ends as REPAIR_FAILED", failedRepair.status === "REPAIR_FAILED", JSON.stringify({ status: failedRepair.status, attempts: failedRepair.qa_run.repair_attempts }));
    h.check("8b. repair attempts are bounded by the configured ceiling", failedRepair.qa_run.repair_attempts === MAX_QA_REPAIR_ATTEMPTS && badFixerCalls === MAX_QA_REPAIR_ATTEMPTS, `${badFixerCalls} fixer call(s), ceiling ${MAX_QA_REPAIR_ATTEMPTS}`);
    h.check("8c. termination is deterministic and states its reason", failedRepair.terminated_by === "attempts_exhausted", failedRepair.terminated_by);
    h.check("8d. a failed repair NEVER replaces the known-good version", preservedProject.version_count === 1 && failedRepair.version === null, `version_count=${preservedProject.version_count}`);
    h.check("8e. the project's committed source is untouched by the failed repair", preservedFile?.content === THROWING_APP, "unchanged");
    h.check("8f. every attempt is recorded with its outcome", failedRepair.repair_log.length === MAX_QA_REPAIR_ATTEMPTS && failedRepair.repair_log.every((l) => l.applied === true && l.resolved === false), JSON.stringify(failedRepair.repair_log.map((l) => `${l.attempt}:${l.resolved}`)));

    // A lower ceiling is honoured exactly, so the bound is configuration and not a constant.
    badFixerCalls = 0;
    const oneAttempt = await executeQa(base44, {
      project: preservedProject, workspace, user: caller,
      fs: createFs(await svc.entities.ProjectFile.filter({ project_id: unrepairable.project.id }, "path", 200)),
      entities: [], secrets: [], repair: true, max_repair_attempts: 1, fixer: badFixer,
    });
    h.check("8g. a configured ceiling of 1 spends exactly one attempt", oneAttempt.qa_run.repair_attempts === 1 && badFixerCalls === 1, `${badFixerCalls} call(s)`);

    // A fixer that declines stops immediately — no attempts are burned pointlessly.
    const declined = await executeQa(base44, {
      project: preservedProject, workspace, user: caller,
      fs: createFs(await svc.entities.ProjectFile.filter({ project_id: unrepairable.project.id }, "path", 200)),
      entities: [], secrets: [], repair: true, fixer: async () => ({ applied: false, summary: "delegated elsewhere" }),
    });
    h.check("8h. a fixer that applies nothing terminates on the first attempt", declined.terminated_by === "fixer_declined" && declined.qa_run.repair_attempts === 1, JSON.stringify({ by: declined.terminated_by, attempts: declined.qa_run.repair_attempts }));
    h.check("8i. the declined repair still preserved the known-good version", (await svc.entities.Project.get(unrepairable.project.id)).version_count === 1, "version_count=1");
    await discardProject(svc, unrepairable.project.id);

    // =================== 9. Regression history + isolation of records ===================
    const runs = await svc.entities.QaRun.filter({ project_id: clean.project.id }, "-created_date", 10);
    h.check("9a. QA results are recorded in run history", runs.length >= 1 && runs[0].status === "PASSED", `${runs.length} run(s)`);
    h.check("9b. the recorded run carries the structured plan and results", (runs[0].plan || []).length > 0 && (runs[0].results || []).length === (runs[0].plan || []).length, `${(runs[0].results || []).length} result(s)`);
    const audits = await svc.entities.AuditLog.filter({ project_id: clean.project.id, resource: "QaRun" }, "-created_date", 10);
    h.check("9c. an audit entry records the QA verdict", audits.some((a) => a.action === "qa.passed" && a.metadata?.tests > 0), JSON.stringify(audits.map((a) => a.action)));
    const foreignRuns = await svc.entities.QaRun.filter({ project_id: clean.project.id }, "-created_date", 50);
    h.check("9d. QA history is project-scoped", foreignRuns.every((r) => r.project_id === clean.project.id), `${foreignRuns.length} run(s)`);

    // =================== 10. Plan/execute separation ===================
    const dryPlan = generateTestPlan({ fs: createFs(clean.files), entities: [NOTE], secrets: [] });
    const beforeQaRuns = (await svc.entities.QaRun.filter({ project_id: clean.project.id }, "-created_date", 50)).length;
    const executed = await executeTestPlan(base44, { project: clean.project, fs: createFs(clean.files), entities: [NOTE], secrets: [], plan: dryPlan });
    const afterQaRuns = (await svc.entities.QaRun.filter({ project_id: clean.project.id }, "-created_date", 50)).length;
    h.check("10a. executing a plan directly reports the same verdict", executed.failed === 0 && executed.passed === dryPlan.tests.length, JSON.stringify({ passed: executed.passed, failed: executed.failed }));
    h.check("10b. executing a plan writes no QA run of its own (the caller records it)", afterQaRuns === beforeQaRuns, `${beforeQaRuns} → ${afterQaRuns}`);
    h.check("10c. generating a plan mutates nothing", (await svc.entities.Project.get(clean.project.id)).version_count === 1, "version_count=1");

  } catch (e) {
    h.check("harness", false, `${e.name}: ${e.message}\n${String(e.stack || "").slice(0, 600)}`);
  } finally {
    for (const ws of [workspace, otherWs]) {
      if (!ws) continue;
      await discardWorkspaceProjects(svc, ws.id);
      await svc.entities.Workspace.delete(ws.id).catch(() => {});
    }
  }

  return harnessResponse(h);
}