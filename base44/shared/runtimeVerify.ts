// Runtime verification: proves a generated application actually RUNS, not merely that it
// builds. Composed entirely from existing primitives — buildEngine for static validation,
// frontendSandbox/jsInterp for execution, functionRuntime for backend calls, appData for the
// database path — so there is no second runtime and no second security model.
//
// Every failure is reported under one deterministic category, which is what lets the existing
// AI repair loop act on it:
//   BUILD_ERROR · DEPENDENCY_ERROR · STARTUP_ERROR · ROUTE_ERROR · RUNTIME_ERROR
//   BACKEND_ERROR · DATABASE_ERROR · TIMEOUT · RESOURCE_ERROR
//
// ISOLATION: frontend execution only ever sees inert stubs. Backend functions run in the real
// executor but against a THROWAWAY data namespace (dataProjectId), with the test messaging
// transport, so a smoke test can neither read nor mutate the project's real records and can
// never deliver a real email or push. The scratch namespace is deleted afterwards.
import { activeFiles } from "./projectFs.ts";
import { runBuild } from "./buildEngine.ts";
import { QuotaExceeded } from "./jsInterp.ts";
import { mountFrontend } from "./frontendSandbox.ts";
// Verification executes generated code through the SHARED execution contract, so a function that
// passes here runs under the same semantics in preview and production.
import { createExecutionContext, executeContractFunction, contractDb } from "./executionContract.ts";
import { isFunctionPath } from "./functionPaths.ts";
import { isIntegrationPath, parseIntegrationFile } from "./integrations.ts";
import { ENTRY_FILE } from "./runtimeExports.ts";

export const VERIFY_CATEGORIES = [
  "BUILD_ERROR", "DEPENDENCY_ERROR", "STARTUP_ERROR", "ROUTE_ERROR", "RUNTIME_ERROR",
  "BACKEND_ERROR", "DATABASE_ERROR", "TIMEOUT", "RESOURCE_ERROR",
];

const DEPENDENCY_RE = /(external import|cannot resolve import|has no export named|does not export|no default export|must point to a \.js file)/i;
const trunc = (v, n = 300) => String(v ?? "").slice(0, n);

// A sandbox quota kill is never "the app is broken" — it is a resource verdict, and the two
// kinds are distinguished so the repair loop does not chase a phantom code bug.
function quotaCategory(e) {
  if (e instanceof QuotaExceeded) return e.quota === "timeout" ? "TIMEOUT" : "RESOURCE_ERROR";
  const msg = String(e?.message || "");
  if (/time limit exceeded/.test(msg)) return "TIMEOUT";
  if (/step limit/.test(msg)) return "RESOURCE_ERROR";
  return null;
}

const errText = (e) => trunc(e?.value?.message || e?.message || String(e));

// Route candidates are taken from the app's own path literals — the same strings its router
// compares against — capped so a huge app cannot turn verification into an unbounded sweep.
export function discoverRoutes(files, max = 8) {
  const found = new Set(["/"]);
  for (const f of files) {
    for (const m of String(f.content).matchAll(/['"](\/[a-zA-Z0-9\-_/]{0,38})['"]/g)) {
      const p = m[1];
      if (p.startsWith("//") || /\.[a-z]{2,4}$/.test(p)) continue;
      found.add(p);
      if (found.size >= max) break;
    }
    if (found.size >= max) break;
  }
  return [...found];
}

function minimalRecord(entity) {
  const out = {};
  for (const [name, f] of Object.entries(entity.fields || {})) {
    if (!f?.required) continue;
    out[name] = f.type === "number" ? 1 : f.type === "boolean" ? true
      : f.type === "enum" ? (f.enum || ["x"])[0]
      : f.type === "date" ? new Date().toISOString().slice(0, 10)
      : `verify-${name}`;
  }
  return out;
}

export async function verifyProjectRuntime(svc, {
  // Integration definitions default to the project's own (already build-validated) files, so
  // a backend function that calls integrations.<name>.<op>() is verified against the real
  // definition instead of failing for a missing one.
  project, fs, entities = [], secrets = [], integrations = null,
  maxRoutes = 8, frontendSteps = 400000, frontendTimeoutMs = 15000,
  functionTimeoutMs = 8000, verifyBackend = true, verifyDatabase = true,
  // Correlation context of the operation being verified (an AI run). Passed straight through to
  // the real function executor, so the smoke-test invocations join that operation's trail
  // instead of appearing as orphaned executions.
  trace_id = null, run_id = null,
}) {
  const started = Date.now();
  const checks = [];
  const failures = [];
  const add = (name, ok, detail) => { checks.push({ name, ok, detail: trunc(detail, 240) }); };
  const fail = (category, name, message) => { add(name, false, message); failures.push({ category, name, message: trunc(message) }); };
  const done = () => ({
    ok: failures.length === 0,
    category: failures[0]?.category || null,
    failures, checks,
    diagnostics: failures.map((f) => `${f.category} ${f.name}: ${f.message}`),
    duration_ms: Date.now() - started,
  });

  // 1) Static validation — the same pass the builder and deployment already use.
  const build = runBuild(fs, entities, secrets);
  const buildErrors = build.logs.filter((l) => l.startsWith("error")).map((l) => l.slice(7));
  if (build.status !== "success") {
    const dependency = buildErrors.filter((e) => DEPENDENCY_RE.test(e));
    const other = buildErrors.filter((e) => !DEPENDENCY_RE.test(e));
    if (other.length) fail("BUILD_ERROR", "build", other.slice(0, 4).join(" | "));
    if (dependency.length) fail("DEPENDENCY_ERROR", "dependencies", dependency.slice(0, 4).join(" | "));
    return done();
  }
  add("build", true, `${build.file_count} file(s), ${build.functions.length} function(s)`);

  const files = activeFiles(fs);
  const integrationDocs = integrations || files.filter((f) => isIntegrationPath(f.path)).flatMap((f) => {
    try { return [parseIntegrationFile(f.path, f.content)]; } catch { return []; }
  });
  const frontend = files.filter((f) => !isFunctionPath(f.path) && !isIntegrationPath(f.path) && f.path.endsWith(".js"));

  // 2) Startup — link the module graph and mount the app.
  const state = { path: "/", params: {}, mounted: [], calls: [], navigations: [], effects: 0, componentCalls: 0, depth: 0 };
  let root = null;
  try {
    const res = await mountFrontend(frontend, ENTRY_FILE, state, entities, { maxSteps: frontendSteps, timeoutMs: frontendTimeoutMs });
    if (!res.mounted.length) throw new Error(`${ENTRY_FILE} never called render(App, ...), so the app never mounts`);
    root = res.mounted[res.mounted.length - 1].component;
    if (typeof root !== "function") throw new Error("render() was called with something that is not a component function");
    add("startup", true, `mounted from ${ENTRY_FILE} in ${res.steps} steps`);
  } catch (e) {
    fail(quotaCategory(e) || "STARTUP_ERROR", "startup", errText(e));
    return done();
  }

  // 3) Render the mounted root, then every discovered route branch.
  try {
    state.path = "/"; state.componentCalls = 0; state.effects = 0;
    const tree = await root({});
    if (tree == null) throw new Error("the app's root component rendered nothing at '/'");
    add("render", true, `root rendered, ${state.componentCalls} component(s), ${state.effects} effect(s)`);
  } catch (e) {
    fail(quotaCategory(e) || "RUNTIME_ERROR", "render", errText(e));
    return done();
  }

  const routes = discoverRoutes(frontend, maxRoutes);
  const routeResults = [];
  for (const path of routes) {
    if (path === "/") { routeResults.push(path); continue; }
    try {
      state.path = path; state.componentCalls = 0; state.effects = 0; state.depth = 0;
      const tree = await root({});
      if (tree == null) throw new Error(`route ${path} rendered nothing`);
      routeResults.push(path);
    } catch (e) {
      const q = quotaCategory(e);
      fail(q || "ROUTE_ERROR", "routes", `${path}: ${errText(e)}`);
      if (q) return done();
      break;
    }
  }
  if (!failures.length) add("routes", true, `${routeResults.length} route(s) render: ${routeResults.join(", ")}`);

  // Throwaway data namespace: everything the backend/database checks write lands here and is
  // deleted below, so the project's own records are never touched by a smoke test.
  const scratchId = `verify_${project.id}_${crypto.randomUUID().slice(0, 8)}`;
  // ONE contract for this verification: the run's files, entities and integrations, the scratch
  // data namespace, and the operation's trace. The backend and database checks below both go
  // through it, exactly as preview and production do.
  const context = createExecutionContext({
    environment: "verification", project, entities, integrations: integrationDocs, files,
    functions: build.functions.map((fn) => ({ name: fn.name, source: files.find((f) => f.path === fn.path)?.content || "" })),
    dataProjectId: scratchId, rls: false, trace: { trace_id, run_id },
  });
  try {
    // 4) Backend functions — executed in the real executor, against the scratch namespace.
    if (verifyBackend) {
      for (const fn of build.functions) {
        let res;
        try {
          res = await executeContractFunction(svc, context, {
            name: fn.name, quotas: { timeoutMs: functionTimeoutMs },
            request: { method: fn.method === "ANY" ? "POST" : fn.method, query: {}, headers: {}, body: {} },
          });
        } catch (e) {
          fail(quotaCategory(e) || "BACKEND_ERROR", "backend", `${fn.name}: ${errText(e)}`);
          break;
        }
        const code = res.body?.code || "";
        if (code === "FUNCTION_TIME_LIMIT") { fail("TIMEOUT", "backend", `${fn.name} exceeded its time limit`); break; }
        if (code === "FUNCTION_STEP_LIMIT" || code === "FUNCTION_OUTPUT_TOO_LARGE") { fail("RESOURCE_ERROR", "backend", `${fn.name}: ${code}`); break; }
        // A function whose secret is not configured yet is a project SETUP gap, not a code
        // defect — reported, never treated as a runtime failure.
        if (res.status === 503 && /secret/i.test(res.body?.error || "")) { add(`backend:${fn.name}`, true, `skipped: ${trunc(res.body.error, 120)}`); continue; }
        if (res.status >= 500) { fail("BACKEND_ERROR", "backend", `${fn.name} returned ${res.status}: ${trunc(res.body?.error, 160)}`); break; }
        add(`backend:${fn.name}`, true, `${res.status} in ${res.duration_ms}ms`);
      }
    }

    // 5) Database path — the real project-scoped accessor, scratch namespace.
    if (verifyDatabase && entities.length && !failures.length) {
      const db = contractDb(svc, context);
      for (const entity of entities.slice(0, 3)) {
        try {
          const created = await db[entity.name].create(minimalRecord(entity));
          await db[entity.name].get(created.id);
          await db[entity.name].filter({}, null, 5);
          await db[entity.name].count({});
          await db[entity.name].delete(created.id);
          add(`database:${entity.name}`, true, "create/get/filter/count/delete");
        } catch (e) {
          fail("DATABASE_ERROR", "database", `${entity.name}: ${errText(e)}`);
          break;
        }
      }
    }
  } finally {
    // Idempotent cleanup of the scratch namespace. Scoped to the generated id, so it can
    // never reach another project's rows.
    await svc.entities.AppRecord.deleteMany({ project_id: scratchId }).catch(() => {});
  }

  return done();
}