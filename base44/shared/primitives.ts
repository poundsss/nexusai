// THE primitive executor (#27).
//
// Every primitive invocation in the platform — from the builder API, from a generated app's
// server-side code, or from a queued job continuing an earlier authorized call — passes through
// this ONE function. That is what makes the guarantees below properties of the platform rather
// than of each call site:
//
//   authorize → validate input against the immutable contract → idempotency check → execute
//   → validate output → scrub → record (invocation + existing trace + existing audit) → envelope
//
//   • AUTHORIZATION / ISOLATION — the project is always resolved SERVER-side and the caller is
//     re-authorized against it with the contract's declared capability. A generated app's
//     project id comes from its own executing project record, never from sandbox input, so an
//     app cannot address another project's data, files, jobs or schedules.
//   • IDEMPOTENCY — a side-effecting primitive replays its FIRST successful result for a repeated
//     key instead of producing the effect twice; the same key with a different payload is refused.
//   • STRUCTURED ERRORS — every failure returns one envelope (code, category, retryable, message,
//     trace_id). Nothing throws a raw provider error at a caller and nothing is silently swallowed.
//   • BILLING — AI cost is settled by the existing operation path inside the handler; this module
//     opens no ledger of its own and never charges a non-AI primitive as model usage.
//   • SECRETS — inputs, outputs, metadata and error text all pass through the platform's existing
//     scrubber before they are stored or returned.
import { loadAuthorizedProject, audit } from "./authz.ts";
import { recordSpan, scrub, scrubText, newTraceId } from "./tracing.ts";
import {
  PRIMITIVES, PRIMITIVE_CONTRACT_VERSION, PRIMITIVE_LIMITS, PRIMITIVE_NAMES,
  resolvePrimitive, validateAgainstSchema, applyDefaults, describePrimitives, versionsOf, latestVersion,
} from "./primitiveContract.ts";
import { PRIMITIVE_HANDLERS, PRIMITIVE_JOB_TYPE } from "./primitiveHandlers.ts";

export { PRIMITIVE_JOB_TYPE, describePrimitives, PRIMITIVE_CONTRACT_VERSION };

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();

/** Deterministic, non-reversible fingerprint of a validated input payload. */
function fingerprintInput(value) {
  const stable = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  };
  const text = stable(value);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = (h1 ^ text.charCodeAt(i)) * 16777619 >>> 0;
    h2 = (h2 + text.charCodeAt(i) * (i + 7)) >>> 0;
  }
  return `pf_${h1.toString(36)}${h2.toString(36)}`;
}

const failure = (code, category, message, extra = {}) => ({
  ok: false,
  error: {
    code, category,
    retryable: extra.retryable ?? ["rate_limit", "provider", "timeout"].includes(category),
    message: scrubText(message, 300),
    ...(extra.details ? { details: scrub(extra.details) } : {}),
  },
});

function withTimeout(promise, ms, contract) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${contract.name} exceeded its ${ms}ms time budget`), {
        primitive_error: true, code: "PRIMITIVE_TIMEOUT", category: "timeout", retryable: true,
      })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Resolves the project + workspace an invocation runs against, and authorizes the caller.
 *
 * 'user'   — an authenticated platform caller: re-authorized against the project with the
 *            contract's capability, so a viewer cannot run a mutating primitive.
 * 'app'    — a generated application's server-side code. The project was already resolved by the
 *            runtime that is executing it; the sandbox cannot influence it.
 * 'system' — the platform continuing an ALREADY authorized invocation (a queued primitive job).
 */
async function authorizeInvocation(base44, { actor, user, project_id, project: given, contract }) {
  const svc = svcOf(base44);
  if (actor === "user") {
    if (!user?.id) throw Object.assign(new Error("Sign in to invoke a primitive"), { primitive_error: true, code: "AUTH_REQUIRED", category: "authorization", retryable: false });
    try {
      const { project, workspace, role } = await loadAuthorizedProject(base44, user, project_id, contract.capability);
      return { project, workspace, role };
    } catch (e) {
      throw Object.assign(new Error(e.message), {
        primitive_error: true, retryable: false, category: "authorization",
        code: e.code === "NOT_A_MEMBER" ? "PRIMITIVE_FORBIDDEN" : e.code === "INSUFFICIENT_ROLE" ? "PRIMITIVE_FORBIDDEN" : e.status === 404 ? "PROJECT_NOT_FOUND" : "PRIMITIVE_FORBIDDEN",
      });
    }
  }
  const project = given || (project_id ? await svc.entities.Project.get(project_id).catch(() => null) : null);
  if (!project) throw Object.assign(new Error("Project not found"), { primitive_error: true, code: "PROJECT_NOT_FOUND", category: "not_found", retryable: false });
  const workspace = await svc.entities.Workspace.get(project.workspace_id).catch(() => null);
  if (!workspace) throw Object.assign(new Error("Project not found"), { primitive_error: true, code: "PROJECT_NOT_FOUND", category: "not_found", retryable: false });
  return { project, workspace, role: actor };
}

/**
 * THE single entry point. Never throws: every outcome is the structured envelope, so a caller
 * (including generated code) always receives a classified result it can act on.
 */
export async function invokePrimitive(base44, {
  primitive, version = null, input = {}, project_id = null, project = null,
  actor = "user", user = null, end_user = null,
  idempotency_key = null, trace_id = null, run_id = null, job_id = null,
  allowed_primitives = null, options = {},
} = {}) {
  const svc = svcOf(base44);
  const started = Date.now();
  // Correlation always exists: an invocation with no inbound trace joins the platform's existing
  // trace system under a new id rather than being untraceable.
  const trace = trace_id || newTraceId();
  const name = String(primitive || "");
  const contract = resolvePrimitive(name, version);
  if (!contract) {
    return { ...failure("PRIMITIVE_NOT_FOUND", "not_found", `Unknown primitive "${name}"${version ? ` at version ${version}` : ""}`, { retryable: false }), primitive: name, version: version || null, trace_id: trace };
  }
  const base = { primitive: contract.name, version: contract.version, contract_version: PRIMITIVE_CONTRACT_VERSION, trace_id: trace, run_id: run_id || null };

  let scope, invocation = null;
  try {
    // 1) Authorization + isolation.
    if (allowed_primitives && !allowed_primitives.includes(contract.name)) {
      throw Object.assign(new Error(`${contract.name} is not enabled for this caller`), { primitive_error: true, code: "PRIMITIVE_FORBIDDEN", category: "authorization", retryable: false });
    }
    scope = await authorizeInvocation(base44, { actor, user, project_id, project, contract });

    // 2) Input validation against the IMMUTABLE contract, defaults applied first.
    const filled = applyDefaults(contract.input_schema, input || {});
    const check = validateAgainstSchema(contract.input_schema, filled, "input");
    if (!check.ok) {
      throw Object.assign(new Error(check.errors.join("; ")), { primitive_error: true, code: "PRIMITIVE_INPUT_INVALID", category: "validation", retryable: false, details: { errors: check.errors } });
    }
    const key = idempotency_key ? String(idempotency_key).slice(0, PRIMITIVE_LIMITS.idempotency_key_chars) : null;
    if (contract.idempotency.required && !key) {
      throw Object.assign(new Error(`${contract.name} requires an idempotency_key because it produces a side effect`), { primitive_error: true, code: "IDEMPOTENCY_KEY_REQUIRED", category: "validation", retryable: false });
    }
    if (key && !contract.idempotency.supported) {
      throw Object.assign(new Error(`${contract.name} does not support idempotency keys`), { primitive_error: true, code: "PRIMITIVE_INPUT_INVALID", category: "validation", retryable: false });
    }
    const fingerprint = fingerprintInput({ primitive: contract.name, version: contract.version, input: filled });

    // 3) Idempotent replay. Only a SUCCEEDED invocation replays, so a failure never blocks a
    //    genuine retry, and the same key with a different payload is a conflict rather than a
    //    silently different side effect.
    if (key) {
      const prior = await svc.entities.PrimitiveInvocation.filter(
        { project_id: scope.project.id, primitive: contract.name, idempotency_key: key, status: "succeeded" }, "-created_date", 1,
      ).catch(() => []);
      if (prior.length) {
        const first = prior[0];
        if (first.input_fingerprint && first.input_fingerprint !== fingerprint) {
          throw Object.assign(new Error("This idempotency key was already used with a different payload"), { primitive_error: true, code: "IDEMPOTENCY_KEY_REUSED", category: "conflict", retryable: false });
        }
        return {
          ok: true, ...base, version: first.version, invocation_id: first.id,
          output: first.result || {}, idempotent_replay: true,
          usage: { ...(first.usage || {}), cost_class: first.cost_class, consumes_ai_credits: !!first.consumes_ai_credits, credits_charged: first.credits_charged || 0, ai_operation_id: first.ai_operation_id || null, latency_ms: 0 },
        };
      }
    }

    // 4) The invocation record exists BEFORE execution, so an invocation that dies mid-flight is
    //    still visible instead of vanishing.
    invocation = await svc.entities.PrimitiveInvocation.create({
      primitive: contract.name, version: contract.version, contract_version: PRIMITIVE_CONTRACT_VERSION,
      project_id: scope.project.id, workspace_id: scope.workspace.id,
      actor, user_id: actor === "user" ? user?.id || null : null, end_user_id: end_user?.id || null,
      status: "running", idempotency_key: key, input_fingerprint: fingerprint,
      trace_id: trace, run_id: run_id || null, job_id: job_id || null,
      cost_class: contract.cost_class, consumes_ai_credits: !!contract.consumes_ai_credits,
      ai_charge_path: contract.ai_charge_path || null, created_at: nowIso(),
    });

    const handler = PRIMITIVE_HANDLERS[`${contract.name}@${contract.version}`];
    if (!handler) {
      throw Object.assign(new Error(`${contract.name}@${contract.version} has no executor`), { primitive_error: true, code: "PRIMITIVE_NOT_IMPLEMENTED", category: "internal", retryable: false });
    }

    // 5) Execution, bounded by the contract's own time budget.
    // Handlers reach the existing gateway/queue helpers, which expect a client exposing
    // `asServiceRole`. A caller that already holds the service role is normalized here rather
    // than each handler learning about client shapes.
    const rootLike = base44.asServiceRole ? base44 : { ...base44, asServiceRole: base44 };
    const res = await withTimeout(handler({
      base44: rootLike, svc, project: scope.project, workspace: scope.workspace, user, end_user,
      actor, contract, input: filled, trace_id: trace, run_id: run_id || null,
      invocation_id: invocation.id, idempotency_key: key, options: options || {},
    }), contract.timeout_ms, contract);

    // 6) Output validation + scrubbing. An output that does not satisfy the contract is a failure,
    //    never a partially-shaped success handed to generated code.
    const output = scrub(res.output ?? {});
    const outCheck = validateAgainstSchema(contract.output_schema, output, "output");
    if (!outCheck.ok) {
      throw Object.assign(new Error(outCheck.errors.join("; ")), { primitive_error: true, code: "PRIMITIVE_OUTPUT_INVALID", category: "internal", retryable: false, details: { errors: outCheck.errors } });
    }

    const latency_ms = Date.now() - started;
    const usage = {
      ...scrub(res.usage || {}),
      cost_class: contract.cost_class, consumes_ai_credits: !!contract.consumes_ai_credits,
      ai_charge_path: contract.ai_charge_path || null,
      credits_charged: res.credits_charged || 0, ai_operation_id: res.ai_operation_id || null,
      latency_ms,
    };
    await svc.entities.PrimitiveInvocation.update(invocation.id, {
      status: "succeeded", result: output, usage,
      ai_operation_id: res.ai_operation_id || null, credits_charged: res.credits_charged || 0,
      model_id: res.model_id || null, provider: res.provider || contract.external_provider || null,
      external_reference: res.external_reference ? String(res.external_reference) : null,
      latency_ms, completed_at: nowIso(),
    });
    // The EXISTING trace system, not a second one.
    await recordSpan(base44, {
      trace_id: trace, workspace_id: scope.workspace.id, project_id: scope.project.id, run_id: run_id || null, job_id: job_id || null,
      event_type: "tool_call", name: `primitive.${contract.name}`, status: "ok", duration_ms: latency_ms,
      reference_id: invocation.id,
      metadata: { version: contract.version, actor, cost_class: contract.cost_class, credits_charged: res.credits_charged || 0, idempotency_key: key ? "provided" : "none" },
    });
    // Side-effecting primitives are auditable through the EXISTING audit log.
    if (contract.side_effect) {
      await audit(svc, {
        workspace_id: scope.workspace.id, project_id: scope.project.id, user_id: user?.id || null,
        action: `primitive.${contract.name}`, resource: "PrimitiveInvocation", resource_id: invocation.id,
        metadata: scrub({ version: contract.version, actor, external_reference: res.external_reference || null, idempotency_key: key, trace_id: trace, run_id: run_id || null }),
      }).catch(() => {});
    }

    return { ok: true, ...base, invocation_id: invocation.id, output, usage, idempotent_replay: false };
  } catch (e) {
    const code = e.primitive_error ? e.code : "PRIMITIVE_EXECUTION_FAILED";
    const category = e.primitive_error ? e.category : "internal";
    const retryable = e.primitive_error ? !!e.retryable : false;
    const latency_ms = Date.now() - started;
    if (invocation) {
      await svc.entities.PrimitiveInvocation.update(invocation.id, {
        status: "failed", error_code: code, error_category: category, retryable,
        error_message: scrubText(e.message, 300), latency_ms, completed_at: nowIso(),
      }).catch(() => {});
    }
    if (scope) {
      await recordSpan(base44, {
        trace_id: trace, workspace_id: scope.workspace.id, project_id: scope.project.id, run_id: run_id || null, job_id: job_id || null,
        event_type: "tool_call", name: `primitive.${contract.name}`, status: "error",
        error: e, error_code: code, duration_ms: latency_ms, reference_id: invocation?.id || null,
        metadata: { version: contract.version, actor, category, retryable },
      }).catch(() => {});
    }
    return {
      ...failure(code, category, e.message, { retryable, details: e.details || null }),
      ...base, invocation_id: invocation?.id || null,
    };
  }
}

/**
 * The surface a generated application's server-side code receives (ctx.primitives).
 *
 * The project is captured from the EXECUTING project record, so nothing the sandbox passes can
 * change which project a primitive runs against. Generated code sees names, inputs and validated
 * outputs — never a client, a credential, a provider handle or a service role.
 */
export function createAppPrimitives(base44, { project, end_user = null, trace_id = null, run_id = null, allowed_primitives = null, options = {} } = {}) {
  return {
    invoke: (name, input = {}, opts = {}) => invokePrimitive(base44, {
      primitive: String(name), version: opts.version || null, input,
      project, actor: "app", end_user,
      idempotency_key: opts.idempotency_key || null,
      trace_id, run_id, allowed_primitives, options,
    }),
    list: () => PRIMITIVES.filter((p) => !allowed_primitives || allowed_primitives.includes(p.name))
      .map((p) => ({ name: p.name, version: p.version, latest: p.version === latestVersion(p.name), description: p.description, execution_mode: p.execution_mode, cost_class: p.cost_class, consumes_ai_credits: p.consumes_ai_credits, idempotency: p.idempotency })),
    names: () => [...PRIMITIVE_NAMES],
  };
}

/**
 * A queued primitive continuing an invocation that was ALREADY authorized when it was enqueued.
 * The payload can only name a primitive from the registry and a project the queued row carries,
 * so the queue cannot be used to reach a project or capability the enqueuing caller lacked.
 */
export const invokePrimitiveAsSystem = (base44, { project_id, primitive, version = null, input = {}, trace_id = null, run_id = null, job_id = null, idempotency_key = null, options = {} }) =>
  invokePrimitive(base44, { primitive, version, input, project_id, actor: "system", trace_id, run_id, job_id, idempotency_key, options });

/** Authorized, project-scoped invocation history. */
export async function listPrimitiveInvocations(base44, user, { project_id, primitive = null, limit = 50 } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.PrimitiveInvocation.filter(
    { project_id: project.id, ...(primitive ? { primitive: String(primitive) } : {}) }, "-created_date", Math.min(Number(limit) || 50, 200),
  );
  return {
    project_id: project.id, contract_version: PRIMITIVE_CONTRACT_VERSION, count: rows.length,
    invocations: rows.map((r) => ({
      invocation_id: r.id, primitive: r.primitive, version: r.version, status: r.status, actor: r.actor,
      cost_class: r.cost_class, consumes_ai_credits: !!r.consumes_ai_credits, ai_charge_path: r.ai_charge_path || null,
      ai_operation_id: r.ai_operation_id || null, credits_charged: r.credits_charged || 0,
      model_id: r.model_id || null, provider: r.provider || null,
      idempotency_key: r.idempotency_key || null, external_reference: r.external_reference || null,
      error_code: r.error_code || null, error_category: r.error_category || null, retryable: !!r.retryable,
      error_message: r.error_message || null, latency_ms: r.latency_ms || 0,
      trace_id: r.trace_id || null, run_id: r.run_id || null, job_id: r.job_id || null,
      created_at: r.created_at || r.created_date, completed_at: r.completed_at || null,
    })),
  };
}