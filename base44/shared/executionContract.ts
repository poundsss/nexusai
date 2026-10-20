// THE execution contract for generated projects.
//
// A generated app is executed by the platform in three places: the Builder's verification
// runtime (smoke tests before a commit), the Builder's preview, and the deployed production /
// staging runtime. They legitimately differ in WHERE their inputs come from — the verifier uses
// the run's in-flight virtual filesystem, the preview the project's working files, production an
// immutable artifact — and in what they are allowed to touch. What they must NOT differ in is
// the SEMANTICS applied to those inputs.
//
// This module is that shared contract, and nothing more: it normalizes the inputs (files,
// entities, generated functions, integrations, environment/config, authorization context) into
// one shape, funnels function execution and data access through the SAME existing primitives in
// every environment, and normalizes runtime failures into one diagnostic shape. It does not
// re-implement a runtime, and it does not change what any runtime is allowed to reach:
//
//   • function execution → shared/functionRuntime.ts (the only sandbox; secrets are resolved
//     and redacted inside it and never reach a caller, a preview or generated frontend code);
//   • data access       → shared/appData.ts createServerDb, always bound to the context's own
//     data namespace, so no environment can address another project's records;
//   • correlation       → the caller's trace_id / run_id travel with the execution, so an
//     invocation lands in the operation's existing trail rather than as orphaned work.
import { executeProjectFunction } from "./functionRuntime.ts";
import { createServerDb } from "./appData.ts";
import { scrubText } from "./tracing.ts";
// The resolved dependency state is read from the SAME lockfile reader in every environment, so
// verification, preview, production and staging load exactly the same pinned packages.
import { resolvedDependencyState } from "./packageLock.ts";
// Function files are recognised through the shared path contract, so BOTH layout shapes
// (base44/functions/<name>/entry.ts and functions/<name>.js) execute identically in every runtime.
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";

export const RUNTIME_ENVIRONMENTS = ["verification", "preview", "production", "staging"];

// Per-environment defaults. These are the ONLY sanctioned differences between the runtimes:
// what a call is labelled as, and whether real messages may leave the platform.
const ENVIRONMENT_DEFAULTS = {
  // Verification runs against a throwaway data namespace and must never send a real email or
  // push, so its messaging transport records instead of delivering.
  verification: { trigger: "test", messagingTransport: "test" },
  preview: { trigger: "frontend", messagingTransport: "platform" },
  production: { trigger: "frontend", messagingTransport: "platform" },
  staging: { trigger: "frontend", messagingTransport: "platform" },
};

const svcOf = (base44) => base44.asServiceRole || base44;
const contractError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

/**
 * Normalizes one runtime's inputs into the shared contract.
 *
 * `dataProjectId` exists so verification can run against a scratch namespace; it defaults to the
 * project itself and is the ONLY thing that decides which records an execution can reach.
 * Secrets are deliberately absent from the contract: they are resolved inside the executor from
 * the project's own rows, so no caller — and no generated frontend — can supply or read one.
 */
export function createExecutionContext({
  environment, project, files = [], entities = [], functions = null, integrations = [],
  config = {}, dataProjectId = null, user = null, rls = null, trace = {},
}) {
  if (!RUNTIME_ENVIRONMENTS.includes(environment)) throw contractError("INVALID_ENVIRONMENT", `Unknown runtime environment "${environment}"`);
  if (!project?.id) throw contractError("INVALID_CONTEXT", "an execution context requires a resolved project");

  const fileList = files.map((f) => ({ path: f.path, content: f.content ?? "", frozen: !!f.frozen }));
  // Functions may be supplied explicitly (production serves them from the artifact) or derived
  // from the files (verification and preview). Either way they are named the same way.
  const fnList = (functions || fileList.filter((f) => isFunctionPath(f.path)).map((f) => ({ name: functionNameFromPath(f.path), source: f.content })))
    .map((f) => ({ name: String(f.name), source: f.source ?? "" }));

  // Resolved dependencies, derived from the file set's own lockfile — one loader, every environment.
  const dependencies = resolvedDependencyState(fileList);

  return {
    environment,
    project,
    files: fileList,
    dependencies,
    dependency_fingerprint: dependencies.dependency_fingerprint,
    entities: entities.map((e) => ({ id: e.id ?? null, name: e.name, fields: e.fields || {} })),
    functions: fnList,
    integrations,
    config,
    // Data namespace + isolation posture. Never taken from a client payload by any caller.
    data_project_id: dataProjectId || project.id,
    rls: rls == null ? !!project.rls_enabled : !!rls,
    // Authorization context: the END-USER of the generated app (or null when anonymous). The
    // platform builder identity is never handed to generated code.
    user: user || null,
    trace: { trace_id: trace.trace_id || null, run_id: trace.run_id || null },
    defaults: ENVIRONMENT_DEFAULTS[environment],
    /** The authoritative source of one generated function, or a coded failure. */
    source(name) {
      const fn = fnList.find((f) => f.name === String(name));
      if (!fn) throw contractError("FUNCTION_NOT_FOUND", `Backend function "${name}" is not part of this ${environment} runtime`, 404);
      return fn.source;
    },
    has(name) { return fnList.some((f) => f.name === String(name)); },
  };
}

/** The project-scoped data accessor for a context. One accessor, one namespace, every runtime. */
export function contractDb(base44, context) {
  return createServerDb(svcOf(base44), context.data_project_id, context.entities, { rls: context.rls, user: context.user, fieldRules: !!context.user });
}

/**
 * ONE function-execution path. Verification, preview and production all reach the sandbox
 * through here with identical semantics; only the context's environment defaults differ.
 */
export async function executeContractFunction(base44, context, { name, request = {}, trigger = null, quotas = {}, source = null }) {
  const result = await executeProjectFunction(svcOf(base44), {
    project: context.project,
    entities: context.entities,
    integrations: context.integrations,
    name: String(name),
    source: source ?? context.source(name),
    trigger: trigger || context.defaults.trigger,
    messagingTransport: context.defaults.messagingTransport,
    dataProjectId: context.data_project_id,
    requestId: crypto.randomUUID(),
    user: context.user,
    quotas,
    trace_id: context.trace.trace_id, run_id: context.trace.run_id,
    request: {
      method: String(request.method || "POST").toUpperCase(),
      query: request.query || {},
      headers: request.headers || {},
      body: request.body ?? null,
    },
  });
  return normalizeExecutionResult(context, name, result);
}

/**
 * The single diagnostic shape for a runtime outcome.
 *
 * Every field is safe to hand to a client: the message is scrubbed, and the sandbox has already
 * redacted secret values from the body and logs. `trace_id` is preserved so the failure stays
 * correlated with the operation that produced the code.
 */
export function normalizeExecutionResult(context, name, result) {
  const status = Number(result?.status) || 500;
  return {
    ok: status < 400,
    environment: context.environment,
    function_name: String(name),
    status,
    body: result?.body ?? null,
    logs: result?.logs || [],
    duration_ms: result?.duration_ms ?? null,
    invocation_id: result?.invocation_id || null,
    error_code: status < 400 ? null : (result?.body?.code || result?.errorClass || "FUNCTION_ERROR"),
    error_message: status < 400 ? null : scrubText(result?.body?.error || result?.error || `Function ${name} failed with ${status}`),
    trace_id: context.trace.trace_id,
    run_id: context.trace.run_id,
  };
}

/** The same shape for a failure that never reached the sandbox (missing function, bad input). */
export function normalizeRuntimeFailure(context, name, error) {
  return {
    ok: false,
    environment: context.environment,
    function_name: String(name || ""),
    status: error?.status || 500,
    body: null, logs: [], duration_ms: null, invocation_id: null,
    error_code: error?.code || error?.name || "RUNTIME_ERROR",
    error_message: scrubText(error?.message || String(error)),
    trace_id: context.trace.trace_id,
    run_id: context.trace.run_id,
  };
}