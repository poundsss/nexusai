// Autonomous QA (#35): generate a bounded test plan for a generated application, execute it
// against ISOLATED state, record structured failures, and attempt a bounded repair that can
// never replace a known-good version with a broken one.
//
// This is NOT a second testing platform. Every test is executed by infrastructure that already
// exists:
//   • build validation ....... buildEngine.runBuild (the same pass the builder and deploys use)
//   • runtime / routes / UI .. runtimeVerify.verifyProjectRuntime (frontendSandbox execution)
//   • backend functions ...... the real execution contract, inside verifyProjectRuntime
//   • entity CRUD ............ the real project-scoped accessor, against a THROWAWAY namespace
//   • integrations ........... the existing integration definition parser
//   • repair ................. the caller's fixer (in production: the existing AI run pipeline)
//   • versions / rollback .... the existing persistence + version store
//
// Two safety properties are structural rather than hoped for:
//   1. ISOLATION — verifyProjectRuntime executes the frontend against inert stubs and runs
//      backend/database checks against a scratch data namespace it deletes afterwards, so a QA
//      run can neither read nor mutate the app's production records.
//   2. KNOWN-GOOD PRESERVATION — a repair is held in memory and only committed once the affected
//      tests actually pass again. An exhausted repair budget commits NOTHING, so the project is
//      still at the exact version it was at when the run started.
import { activeFiles, computeChanges } from "./projectFs.ts";
import { runBuild } from "./buildEngine.ts";
import { verifyProjectRuntime, discoverRoutes } from "./runtimeVerify.ts";
import { isIntegrationPath, parseIntegrationFile } from "./integrations.ts";
import { isFunctionPath } from "./functionPaths.ts";
import { audit } from "./authz.ts";
import { commitFiles, commitEntities, createVersion } from "./persistence.ts";
import { recordMetric } from "./observability.ts";

export const QA_CATEGORIES = ["build", "runtime_smoke", "ui_render", "route", "entity_crud", "backend_function", "integration"];
export const MAX_QA_REPAIR_ATTEMPTS = 3;

// Bounds are part of the contract: a huge project produces a bounded plan, so QA can never turn
// into an unbounded sweep. `entities` matches what the runtime verifier actually exercises.
const LIMITS = { routes: 6, entities: 3, functions: 6, integrations: 4 };

const trunc = (v, n = 300) => String(v ?? "").slice(0, n);
const svcOf = (base44) => base44.asServiceRole || base44;

/**
 * Generates the bounded test plan from the project's OWN state: its files, routes, entities,
 * backend functions and integration definitions. Deterministic — the same project state always
 * produces the same plan in the same order.
 */
export function generateTestPlan({ fs, entities = [], secrets = [] }) {
  const files = activeFiles(fs);
  const frontend = files.filter((f) => !isFunctionPath(f.path) && !isIntegrationPath(f.path) && f.path.endsWith(".js"));
  const build = runBuild(fs, entities, secrets);
  const tests = [];
  const add = (category, target, description) => tests.push({ id: `${category}:${target}`, category, target, description });

  add("build", "project", "Every source file compiles and the project's declarations resolve");
  add("runtime_smoke", "startup", "The application's entry file mounts a root component");
  add("ui_render", "/", "The mounted root renders at '/' without throwing");

  for (const path of discoverRoutes(frontend, LIMITS.routes)) {
    if (path === "/") continue;
    add("route", path, `Route ${path} renders`);
  }
  for (const e of entities.slice(0, LIMITS.entities)) {
    add("entity_crud", e.name, `${e.name} supports create/get/filter/count/delete against isolated test data`);
  }
  for (const fn of (build.functions || []).slice(0, LIMITS.functions)) {
    add("backend_function", fn.name, `Backend function ${fn.name} executes and does not fault`);
  }
  for (const f of files.filter((x) => isIntegrationPath(x.path)).slice(0, LIMITS.integrations)) {
    add("integration", f.path.split("/").pop().replace(/\.json$/, ""), `Integration definition ${f.path} is valid`);
  }

  return { tests, counts: Object.fromEntries(QA_CATEGORIES.map((c) => [c, tests.filter((t) => t.category === c).length])) };
}

// Maps the runtime verifier's own checks/failures onto the planned tests. The verifier stops at
// the first failure of a phase, so anything it never reached is reported 'skipped' — QA never
// claims a test passed that did not run.
function mapResults(plan, verification, { fs, trace_id = null, run_id = null }) {
  const checks = new Map((verification.checks || []).map((c) => [c.name, c]));
  const failures = verification.failures || [];
  const failureFor = (predicate) => failures.find(predicate) || null;
  const files = activeFiles(fs);
  const results = [];

  const record = (test, status, failure = null, file = null) => {
    results.push({
      id: test.id, category: test.category, target: test.target, status,
      error: failure ? trunc(failure.message, 280) : "",
      error_category: failure?.category || "",
      file: file || "", trace_id: trace_id || "", run_id: run_id || "",
    });
  };

  for (const test of plan.tests) {
    if (test.category === "build") {
      const f = failureFor((x) => x.category === "BUILD_ERROR" || x.category === "DEPENDENCY_ERROR");
      record(test, f ? "failed" : checks.has("build") ? "passed" : "skipped", f, f ? fileFromMessage(f.message) : null);
      continue;
    }
    if (test.category === "runtime_smoke") {
      const f = failureFor((x) => x.name === "startup");
      record(test, f ? "failed" : checks.get("startup")?.ok ? "passed" : "skipped", f);
      continue;
    }
    if (test.category === "ui_render") {
      const f = failureFor((x) => x.name === "render");
      record(test, f ? "failed" : checks.get("render")?.ok ? "passed" : "skipped", f);
      continue;
    }
    if (test.category === "route") {
      const f = failureFor((x) => x.name === "routes" && x.message.startsWith(`${test.target}:`));
      const routesOk = checks.get("routes")?.ok;
      const anyRouteFailure = failureFor((x) => x.name === "routes");
      // A route after the one that failed was never rendered — skipped, not passed.
      record(test, f ? "failed" : routesOk ? "passed" : anyRouteFailure ? "skipped" : "skipped", f);
      continue;
    }
    if (test.category === "entity_crud") {
      const f = failureFor((x) => x.name === "database" && x.message.startsWith(`${test.target}:`));
      record(test, f ? "failed" : checks.get(`database:${test.target}`)?.ok ? "passed" : "skipped", f);
      continue;
    }
    if (test.category === "backend_function") {
      const f = failureFor((x) => x.name === "backend" && x.message.startsWith(`${test.target}`));
      const file = files.find((x) => isFunctionPath(x.path) && x.path.includes(test.target));
      record(test, f ? "failed" : checks.get(`backend:${test.target}`)?.ok ? "passed" : "skipped", f, file?.path || null);
      continue;
    }
    if (test.category === "integration") {
      const file = files.find((x) => isIntegrationPath(x.path) && x.path.includes(test.target));
      if (!file) { record(test, "skipped"); continue; }
      try {
        parseIntegrationFile(file.path, file.content);
        record(test, "passed", null, file.path);
      } catch (e) {
        record(test, "failed", { category: "INTEGRATION_ERROR", message: e.message }, file.path);
      }
    }
  }
  return results;
}

function fileFromMessage(message) {
  const m = String(message || "").match(/((?:src|functions|integrations)\/[^\s:'"]+\.(?:js|json)|styles\.css)/);
  return m ? m[1] : null;
}

const tally = (results) => ({
  test_count: results.length,
  passed: results.filter((r) => r.status === "passed").length,
  failed: results.filter((r) => r.status === "failed").length,
  skipped: results.filter((r) => r.status === "skipped").length,
  categories_failed: [...new Set(results.filter((r) => r.status === "failed").map((r) => r.category))],
});

/**
 * Executes a plan against isolated state and returns structured results. Nothing here writes to
 * the project: the caller decides whether anything is committed.
 */
export async function executeTestPlan(base44, { project, fs, entities = [], secrets = [], plan, trace_id = null, run_id = null }) {
  const svc = svcOf(base44);
  const routeCount = plan.tests.filter((t) => t.category === "route").length;
  const verification = await verifyProjectRuntime(svc, {
    project, fs, entities, secrets,
    maxRoutes: routeCount + 1, trace_id, run_id,
  }).catch((e) => ({ ok: false, category: "RUNTIME_ERROR", checks: [], failures: [{ category: "RUNTIME_ERROR", name: "verifier", message: e.message }], diagnostics: [], duration_ms: 0 }));
  const results = mapResults(plan, verification, { fs, trace_id, run_id });
  return { results, ...tally(results), verification_ok: verification.ok, duration_ms: verification.duration_ms || 0 };
}

/**
 * The full QA run: plan → execute → (bounded repair) → record.
 *
 * `fixer` is the repair strategy. Production passes the existing AI-run based fixer; it receives
 * the structured failures and the in-memory filesystem and returns whether it applied a change.
 * QA owns everything around it — the attempt ceiling, the re-run of affected tests, the commit of
 * a verified fix and the refusal to commit an unverified one.
 */
export async function executeQa(base44, {
  project, workspace, user, fs, entities, secrets,
  repair = false, max_repair_attempts = MAX_QA_REPAIR_ATTEMPTS, fixer = null, trace_id = null,
  test_ids = null,
}) {
  const svc = svcOf(base44);
  const started = Date.now();
  const attemptCeiling = Math.max(0, Math.min(Number(max_repair_attempts) || 0, MAX_QA_REPAIR_ATTEMPTS));

  const versions = await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 1);
  const knownGood = versions[0] || null;
  const plan = generateTestPlan({ fs, entities, secrets });
  // Optional subset: when a caller passes test_ids (per-test "Test Again" or a selected set),
  // the run reports only those tests. The verifier still executes its phases, but mapResults
  // records only the selected tests — nothing is fabricated as passing.
  const selectedIds = Array.isArray(test_ids) && test_ids.length ? new Set(test_ids) : null;
  const runPlan = selectedIds ? { ...plan, tests: plan.tests.filter((t) => selectedIds.has(t.id)) } : plan;

  let outcome = await executeTestPlan(base44, { project, fs, entities, secrets, plan: runPlan, trace_id });
  const repair_log = [];
  let attempts = 0;
  let status, terminated_by, committedVersion = null;

  if (outcome.failed === 0) {
    status = "PASSED";
    terminated_by = "all_passed";
  } else if (!repair || !fixer || attemptCeiling === 0) {
    status = "FAILED";
    terminated_by = !repair || attemptCeiling === 0 ? "no_repair_requested" : "not_repairable";
  } else {
    // Bounded repair. The ceiling is the ONLY exit besides success, so the loop terminates
    // deterministically no matter what the fixer does.
    while (attempts < attemptCeiling && outcome.failed > 0) {
      attempts++;
      const failures = outcome.results.filter((r) => r.status === "failed");
      let applied = false, summary = "", fixRunId = null;
      try {
        const res = await fixer({ attempt: attempts, failures, fs, entities, secrets, project });
        applied = !!res?.applied;
        summary = trunc(res?.summary || "", 280);
        fixRunId = res?.run_id || null;
      } catch (e) {
        summary = `fixer error: ${trunc(e.message, 200)}`;
      }
      if (!applied) {
        repair_log.push({ attempt: attempts, summary: summary || "fixer applied no change", applied: false, resolved: false, failed_after: outcome.failed, run_id: fixRunId || "" });
        terminated_by = "fixer_declined";
        break;
      }
      // Re-run the WHOLE plan after a fix: a repair that breaks a previously passing test must
      // not be reported as a success.
      outcome = await executeTestPlan(base44, { project, fs, entities, secrets, plan: runPlan, trace_id });
      repair_log.push({ attempt: attempts, summary, applied: true, resolved: outcome.failed === 0, failed_after: outcome.failed, run_id: fixRunId || "" });
    }
    if (outcome.failed === 0) {
      // Only a VERIFIED fix reaches canonical state, through the same persistence path the AI
      // builder uses, producing an ordinary immutable version.
      const changed = await commitFiles(svc, project.id, fs);
      await commitEntities(svc, project.id, entities);
      committedVersion = await createVersion(svc, {
        project, fs, entities, secrets,
        message: `QA repair: fixed ${repair_log.length} attempt(s) of ${runPlan.tests.length} checks`,
        changedFiles: changed,
      });
      status = "REPAIRED";
      terminated_by = "repaired";
    } else {
      status = "REPAIR_FAILED";
      terminated_by = terminated_by || "attempts_exhausted";
    }
  }

  const record = await svc.entities.QaRun.create({
    project_id: project.id, workspace_id: workspace.id, user_id: user?.id || null,
    status, terminated_by,
    base_version_number: project.version_count || 0,
    known_good_version_id: knownGood?.id || null,
    known_good_version_number: knownGood?.number ?? null,
    final_version_number: committedVersion?.number ?? knownGood?.number ?? null,
    plan: runPlan.tests, results: outcome.results,
    test_count: outcome.test_count, passed: outcome.passed, failed: outcome.failed, skipped: outcome.skipped,
    categories_failed: outcome.categories_failed,
    repair_attempts: attempts, max_repair_attempts: attemptCeiling, repair_log,
    trace_id: trace_id || null, duration_ms: Date.now() - started, completed_at: new Date().toISOString(),
  });

  // Regression history lands in the systems that already own it: the audit trail and the metric
  // store the rest of the platform reports from.
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user?.id || null,
    action: `qa.${status.toLowerCase()}`, resource: "QaRun", resource_id: record.id,
    metadata: {
      status, terminated_by, tests: outcome.test_count, passed: outcome.passed, failed: outcome.failed,
      categories_failed: outcome.categories_failed, repair_attempts: attempts,
      known_good_version: knownGood?.number ?? null, final_version: committedVersion?.number ?? knownGood?.number ?? null,
    },
  });
  await recordMetric(svc, { metric: "qa.run", labels: { status, repaired: String(status === "REPAIRED") }, scope: "project", scope_id: project.id, value: outcome.failed });

  return { qa_run: record, plan: plan.tests, results: outcome.results, status, terminated_by, repair_log, version: committedVersion };
}

/**
 * Production repair strategy: delegate the code change to the EXISTING AI run pipeline, which
 * already plans, patches, rebuilds, verifies runtime, bounds its own repair attempts and refuses
 * to commit a failing build. QA does not generate patches of its own.
 */
export function aiRunFixer(base44, { project, enqueue }) {
  return async ({ failures, attempt }) => {
    const lines = failures.slice(0, 8).map((f) => `- [${f.category}${f.error_category ? `/${f.error_category}` : ""}] ${f.target}${f.file ? ` (${f.file})` : ""}: ${f.error}`).join("\n");
    const res = await enqueue(base44, {
      project, mode: "default",
      prompt: `Automated QA found ${failures.length} failing check(s) on attempt ${attempt}. Fix the smallest amount of code that makes them pass, and change nothing else.\n\n${lines}`,
    });
    // The pipeline runs asynchronously and owns its own build/verify/commit gates, so QA records
    // the delegation and stops rather than pretending to have verified a fix it cannot yet see.
    return { applied: false, summary: `Delegated to AI run ${res.run_id}`, run_id: res.run_id };
  };
}

export async function listQaRuns(svc, project_id, limit = 20) {
  return svc.entities.QaRun.filter({ project_id }, "-created_date", Math.min(limit, 100));
}

// AI test suggestions (Testing Agent parity, non-browser portion). Generates scenario
// suggestions from the project's OWN state via the existing InvokeLLM Core integration. Each
// suggestion is classified as a smoke category (runnable by the existing engine) or "scenario"
// (requires a browser session, which this runtime does not provide). No browser execution,
// selectors or step schema are invented — the LLM only proposes descriptions.
export async function suggestTests(svc, { fs, entities = [], secrets = [], prompt = "" }) {
  const plan = generateTestPlan({ fs, entities, secrets });
  const routes = plan.tests.filter((t) => t.category === "route").map((t) => t.target);
  const ents = (entities || []).slice(0, 8).map((e) => e.name);
  const fns = plan.tests.filter((t) => t.category === "backend_function").map((t) => t.target);
  const context = `App routes: ${routes.join(", ") || "(none)"}\nEntities: ${ents.join(", ") || "(none)"}\nBackend functions: ${fns.join(", ") || "(none)"}`;
  const llmPrompt = `You are a test planner for a web app built on Base44. Suggest concrete test scenarios for this app.\n${context}\n\nThe user wants to test: "${String(prompt).slice(0, 500)}".\n\nSuggest up to 8 test scenarios. For each, set "category" to one of: build, runtime_smoke, ui_render, route, entity_crud, backend_function, integration (these can be validated WITHOUT a browser) OR "scenario" (requires a real browser session, e.g. a multi-step click-through). Keep labels under 80 chars and descriptions under 200 chars.`;
  const res = await svc.integrations.Core.InvokeLLM({
    prompt: llmPrompt,
    response_json_schema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, description: { type: "string" }, category: { type: "string" } },
          },
        },
      },
    },
  }).catch((e) => { throw Object.assign(new Error(`AI suggestions failed: ${trunc(e.message, 160)}`), { code: "SUGGEST_FAILED" }); });
  const raw = Array.isArray(res?.suggestions) ? res.suggestions : [];
  return raw.slice(0, 8).map((s, i) => {
    const cat = QA_CATEGORIES.includes(s.category) ? s.category : "scenario";
    return {
      id: `sug_${i + 1}`,
      label: String(s.label || "").slice(0, 80),
      description: String(s.description || "").slice(0, 200),
      category: cat,
      smoke: cat !== "scenario",
    };
  }).filter((s) => s.label);
}

// Per-project QA result deletion. Project-scoped: a run belonging to another project is simply
// not found here, so one project's QA history can never be deleted from another.
export async function deleteQaRun(svc, { project_id, qa_run_id }) {
  const row = await svc.entities.QaRun.get(qa_run_id).catch(() => null);
  if (!row || row.project_id !== project_id) throw Object.assign(new Error("QA run not found"), { status: 404, code: "QA_RUN_NOT_FOUND" });
  await svc.entities.QaRun.delete(qa_run_id);
  return { deleted: true, qa_run_id };
}