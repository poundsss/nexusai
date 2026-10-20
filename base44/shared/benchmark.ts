// NexusAI Benchmark Harness — DEFINITION, VERSIONING and LIFECYCLE.
//
// Purpose: answer one question reproducibly — "given the same task, the same starting project
// state, the same tools, the same runtime and the same evaluation rules, which model/configuration
// performs better?"
//
// This module owns what a benchmark IS. Execution, scoring and aggregation live in
// benchmarkRun.ts. Nothing here measures anything, and nothing here trains, promotes or routes a
// model: the harness only measures.
//
// Boundaries this module keeps:
//   REUSE — evaluation rules come from #19 (evaluator registry), reward policy from #20, task
//     lineage may reference a finalized #22 dataset, and candidates resolve against the existing
//     Model Catalog / Model Gateway registry. None of those systems is modified or re-implemented.
//   FIXTURES ONLY — a task is an EXPLICITLY defined fixture. Nothing in the harness generates task
//     content, so no synthetic-task path exists to accidentally take.
//   VERSIONED + DETERMINISTIC — every benchmark-defining input is fingerprinted. Changing any of
//     them means a NEW benchmark version, never an edit of an existing measurement.
//   IMMUTABLE WHEN FINALIZED — a finalized benchmark, its task versions and its results refuse
//     every mutating path.
//   SERVER-AUTHORIZED + ISOLATED — the workspace is resolved server-side from an authorized owner
//     project, and every read is filtered by the benchmark's own id, so one workspace can never
//     read or run another's benchmark. A platform benchmark additionally requires platform-admin
//     rights and an explicit fixture whitelist.
//   SCRUBBED — every stored string passes the platform's existing secret scrubber.
import { scrub, scrubText } from "./tracing.ts";
import { loadAuthorizedProject, audit } from "./authz.ts";
import { requirePlatformAdmin } from "./platformAdmin.ts";
import { MODEL_REGISTRY } from "./modelGateway.ts";
import { EVALUATOR_VERSION, evaluatorVersions } from "./evaluation.ts";
import { REWARD_POLICY_VERSION, rewardPolicyVersions } from "./reward.ts";

/** Version of the harness contract itself: how a benchmark executes, scores and aggregates. */
export const BENCHMARK_HARNESS_VERSION = "1.0.0";
/** Version of the runtime/execution contract candidates are measured under. */
export const RUNTIME_CONTRACT_VERSION = "nexusai-run-pipeline-1";

export const BENCHMARK_STATUSES = ["DRAFT", "RUNNING", "COMPLETED", "FAILED", "FINALIZED"];
export const EXECUTION_PATHS = ["run", "agent"];
export const BENCHMARK_LIMITS = {
  tasks: 50, candidates: 8, results_page: 200, name: 120, goal: 4000,
  fixture_files: 40, fixture_file_chars: 20000, exclusions: 200,
};

// The tool profile every candidate of a benchmark receives. It is a property of the BENCHMARK, not
// of a candidate, which is what makes tool availability an equal condition rather than something
// one candidate could be given more of.
export const DEFAULT_TOOL_PROFILE = { surface: "builder_default", mode: "default", mcp_enabled: false, external_tools: false };

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

// --- deterministic fingerprints ------------------------------------------------

/** Stable stringify: object keys sorted at every depth, so a fingerprint cannot depend on insertion order. */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Deterministic, dependency-free content fingerprint. Same inputs ⇒ same value, always. */
export function fingerprint(prefix, value) {
  const text = stableStringify(value);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  let h2 = 52711;
  for (let i = text.length - 1; i >= 0; i--) h2 = ((h2 << 5) + h2 + text.charCodeAt(i)) | 0;
  return `${prefix}_${(h >>> 0).toString(36)}${(h2 >>> 0).toString(36)}_${text.length.toString(36)}`;
}

export const toolConfigFingerprint = (profile) => fingerprint("tool", profile || DEFAULT_TOOL_PROFILE);

/**
 * Fingerprint of the whole measurement environment. Part of every result's run key, so a result
 * produced under different evaluation rules, a different reward policy, a different runtime
 * contract or different tool availability can never be mistaken for a comparable one.
 */
export function environmentFingerprint({ evaluation_policy_version, reward_policy_version, tool_profile }) {
  return fingerprint("env", {
    harness: BENCHMARK_HARNESS_VERSION,
    runtime: RUNTIME_CONTRACT_VERSION,
    evaluator: evaluation_policy_version,
    reward_policy: reward_policy_version || null,
    tools: toolConfigFingerprint(tool_profile),
  });
}

export const taskChecksum = (task) => fingerprint("btask", {
  task_key: task.task_key, task_version: task.task_version, definition: task.definition,
  initial_state: task.initial_state, required_capabilities: task.required_capabilities || [],
  verification_criteria: task.verification_criteria || {}, category: task.category || null,
  difficulty: task.difficulty || null, time_budget_ms: task.time_budget_ms ?? null, max_steps: task.max_steps ?? null,
});

export const candidateChecksum = (c) => fingerprint("bcand", {
  name: c.name, candidate_version: c.candidate_version, model_id: c.model_id,
  candidate_config: c.candidate_config || {}, routing_config: c.routing_config || {}, execution_path: c.execution_path,
});

export const initialStateFingerprint = (state) => fingerprint("bstate", {
  files: (state?.files || []).map((f) => ({ path: f.path, content: f.content })).sort((a, b) => a.path.localeCompare(b.path)),
  entities: (state?.entities || []).map((e) => ({ name: e.name, fields: e.fields || {} })).sort((a, b) => a.name.localeCompare(b.name)),
});

// --- authorization -------------------------------------------------------------

/**
 * Resolves a benchmark for an authorized caller. The owner project is authorized through the
 * platform's EXISTING path, so a caller from another workspace is refused before any benchmark
 * field is read; a platform-scoped benchmark additionally requires platform-admin rights.
 */
export async function authorizeBenchmark(base44, user, benchmark_id, capability = "project.write") {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use benchmarks");
  if (!benchmark_id) fail(400, "INVALID_INPUT", "benchmark_id is required");
  const svc = svcOf(base44);
  const benchmark = await svc.entities.Benchmark.get(String(benchmark_id)).catch(() => null);
  if (!benchmark) fail(404, "BENCHMARK_NOT_FOUND", "Benchmark not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, benchmark.project_id, capability);
  // Defence in depth: the benchmark's own workspace must be the one the project authorized.
  if (benchmark.workspace_id && benchmark.workspace_id !== workspace.id) fail(403, "NOT_A_MEMBER", "Benchmark belongs to another workspace");
  if (benchmark.scope === "platform" && capability !== "project.read") await requirePlatformAdmin(base44, user);
  return { benchmark, project, workspace };
}

const assertMutable = (benchmark) => {
  if (benchmark.finalized || benchmark.status === "FINALIZED") fail(409, "BENCHMARK_FINALIZED", "A finalized benchmark is immutable; create a new benchmark version instead");
};
const assertDraft = (benchmark) => {
  assertMutable(benchmark);
  if (benchmark.status !== "DRAFT") fail(409, "BENCHMARK_NOT_DRAFT", `The benchmark definition can only change while it is a DRAFT (current status: ${benchmark.status})`);
};

// --- public projections --------------------------------------------------------

export const publicBenchmark = (b) => ({
  benchmark_id: b.id, name: b.name, description: b.description || null, version: b.version, status: b.status,
  scope: b.scope, workspace_id: b.workspace_id, project_id: b.project_id,
  approved_task_keys: b.approved_task_keys || [],
  task_set_reference: b.task_set_reference || {}, task_set_version: b.task_set_version || 1,
  task_set_fingerprint: b.task_set_fingerprint || null,
  candidates: (b.candidates || []).map((c) => ({ ...c })), candidate_set_fingerprint: b.candidate_set_fingerprint || null,
  evaluation_policy_version: b.evaluation_policy_version, reward_policy_version: b.reward_policy_version || null,
  runtime_environment_version: b.runtime_environment_version || null,
  tool_config_fingerprint: b.tool_config_fingerprint || null, environment_fingerprint: b.environment_fingerprint || null,
  dataset_reference: b.dataset_reference || null,
  definition_checksum: b.definition_checksum || null, checksum: b.checksum || null,
  item_count: b.item_count || 0, completed_count: b.completed_count || 0,
  summary: b.summary || {}, failure_summary: b.failure_summary || {},
  finalized: !!b.finalized, error: b.error || null, created_by: b.created_by || null,
  created_at: b.created_at || b.created_date, started_at: b.started_at || null,
  completed_at: b.completed_at || null, finalized_at: b.finalized_at || null,
});

export const publicTask = (t) => ({
  task_id: t.id, benchmark_id: t.benchmark_id, task_key: t.task_key, task_version: t.task_version,
  definition: t.definition || {}, initial_state: t.initial_state || {},
  initial_state_fingerprint: t.initial_state_fingerprint || null,
  required_capabilities: t.required_capabilities || [], verification_criteria: t.verification_criteria || {},
  category: t.category || null, difficulty: t.difficulty || null,
  time_budget_ms: t.time_budget_ms ?? null, max_steps: t.max_steps ?? null,
  checksum: t.checksum || null, finalized: !!t.finalized,
  created_at: t.created_at || t.created_date,
});

// --- definition ----------------------------------------------------------------

/** The current task set of a benchmark: the LATEST version of every task key, deterministically ordered. */
export async function currentTaskSet(base44, benchmark_id) {
  const svc = svcOf(base44);
  const rows = await svc.entities.BenchmarkTask.filter({ benchmark_id: String(benchmark_id) }, "task_key", BENCHMARK_LIMITS.tasks * 4);
  const latest = new Map();
  for (const t of rows) {
    const prev = latest.get(t.task_key);
    if (!prev || (t.task_version || 1) > (prev.task_version || 1)) latest.set(t.task_key, t);
  }
  return [...latest.values()].sort((a, b) => a.task_key.localeCompare(b.task_key));
}

function definitionChecksum(benchmark, tasks) {
  return fingerprint("bdef", {
    name: benchmark.name, scope: benchmark.scope, version: benchmark.version,
    tasks: tasks.map((t) => ({ task_key: t.task_key, task_version: t.task_version, checksum: t.checksum })),
    candidates: (benchmark.candidates || []).map((c) => ({ candidate_id: c.candidate_id, config_checksum: c.config_checksum })),
    evaluator: benchmark.evaluation_policy_version, reward_policy: benchmark.reward_policy_version || null,
    environment: benchmark.environment_fingerprint,
    dataset: benchmark.dataset_reference?.checksum || null,
  });
}

/**
 * Recomputes every derived fingerprint of a DRAFT benchmark from its current tasks and candidates.
 * Called after any definition change, so the stored definition checksum is never stale — which is
 * what makes "the same benchmark configuration" a checkable claim rather than a promise.
 */
export async function refreshDefinition(base44, benchmark, { bump_task_set = false } = {}) {
  const svc = svcOf(base44);
  const tasks = await currentTaskSet(svc, benchmark.id);
  const task_set_version = bump_task_set ? (benchmark.task_set_version || 1) + 1 : benchmark.task_set_version || 1;
  const task_set_fingerprint = fingerprint("btaskset", tasks.map((t) => ({ task_key: t.task_key, task_version: t.task_version, checksum: t.checksum })));
  const candidate_set_fingerprint = fingerprint("bcandset", (benchmark.candidates || []).map((c) => c.config_checksum));
  const task_set_reference = {
    task_set_version, task_set_fingerprint, task_count: tasks.length,
    tasks: tasks.map((t) => ({ task_id: t.id, task_key: t.task_key, task_version: t.task_version, checksum: t.checksum, category: t.category || null, difficulty: t.difficulty || null })),
  };
  const merged = { ...benchmark, task_set_version, task_set_fingerprint, candidate_set_fingerprint };
  const definition_checksum = definitionChecksum(merged, tasks);
  const updated = await svc.entities.Benchmark.update(benchmark.id, {
    task_set_version, task_set_fingerprint, task_set_reference, candidate_set_fingerprint,
    definition_checksum, item_count: tasks.length * (benchmark.candidates || []).length,
  });
  return { benchmark: updated, tasks, definition_checksum };
}

/**
 * Creates a benchmark. The workspace is resolved SERVER-side from the authorized owner project, the
 * version is the next one in the (name, scope) lineage, and the evaluation/reward policies are
 * validated against the existing registries — an unknown evaluator is refused rather than silently
 * defaulted, because it would make every result incomparable.
 */
export async function createBenchmark(base44, user, {
  project_id, name, description = null, scope = "project",
  evaluation_policy_version = EVALUATOR_VERSION, reward_policy_version = REWARD_POLICY_VERSION,
  tool_profile = null, approved_task_keys = null, dataset_id = null,
} = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to create a benchmark");
  const label = String(name || "").trim().slice(0, BENCHMARK_LIMITS.name);
  if (!label) fail(400, "INVALID_INPUT", "A benchmark name is required");
  if (!["project", "platform"].includes(scope)) fail(400, "INVALID_SCOPE", "scope must be 'project' or 'platform'");
  if (!evaluatorVersions().includes(evaluation_policy_version)) fail(400, "UNKNOWN_EVALUATOR", `Unknown evaluator version: ${evaluation_policy_version}`);
  if (reward_policy_version && !rewardPolicyVersions().includes(reward_policy_version)) fail(400, "UNKNOWN_REWARD_POLICY", `Unknown reward policy version: ${reward_policy_version}`);

  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  if (scope === "platform") {
    await requirePlatformAdmin(base44, user);
    if (!Array.isArray(approved_task_keys) || !approved_task_keys.length) {
      fail(400, "APPROVED_FIXTURES_REQUIRED", "A platform benchmark must name the explicitly approved benchmark fixture task keys");
    }
  }
  const svc = svcOf(base44);

  // A finalized dataset may supply fixture lineage. It is READ ONLY here: only its id, version and
  // checksum are recorded, and an unfinalized dataset is refused rather than half-referenced.
  let dataset_reference = null;
  if (dataset_id) {
    const ds = await svc.entities.Dataset.get(String(dataset_id)).catch(() => null);
    if (!ds) fail(404, "DATASET_NOT_FOUND", "Dataset not found");
    if (ds.status !== "FINALIZED") fail(409, "DATASET_NOT_FINALIZED", "Only a finalized dataset may be referenced by a benchmark");
    if (ds.scope === "project" && ds.project_id !== project.id) fail(403, "DATASET_NOT_AUTHORIZED", "That dataset belongs to another project");
    dataset_reference = { dataset_id: ds.id, name: ds.name, version: ds.version, dataset_type: ds.dataset_type, checksum: ds.checksum || null };
  }

  const siblings = await svc.entities.Benchmark.filter({ name: label, scope }, "-version", 50).catch(() => []);
  const owned = siblings.filter((b) => (scope === "platform" ? true : b.workspace_id === workspace.id));
  const version = Math.max(0, ...owned.map((b) => b.version || 0)) + 1;
  const profile = { ...DEFAULT_TOOL_PROFILE, ...(tool_profile || {}) };
  const environment_fingerprint = environmentFingerprint({ evaluation_policy_version, reward_policy_version, tool_profile: profile });

  const created = await svc.entities.Benchmark.create({
    name: label, description: description ? scrubText(description, 2000) : undefined,
    version, status: "DRAFT", scope, workspace_id: workspace.id, project_id: project.id,
    approved_task_keys: scope === "platform" ? approved_task_keys.map((k) => String(k).slice(0, 120)) : undefined,
    task_set_version: 1, candidates: [],
    evaluation_policy_version, reward_policy_version: reward_policy_version || undefined,
    runtime_environment_version: RUNTIME_CONTRACT_VERSION,
    tool_config_fingerprint: toolConfigFingerprint(profile), environment_fingerprint,
    dataset_reference: dataset_reference || undefined,
    item_count: 0, completed_count: 0, finalized: false, created_by: user.id, created_at: nowIso(),
  });
  const { benchmark } = await refreshDefinition(svc, created);
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "benchmark.created", resource: "Benchmark", resource_id: benchmark.id,
    metadata: { name: label, version, scope, evaluator: evaluation_policy_version, environment_fingerprint },
  });
  return { benchmark: publicBenchmark(benchmark) };
}

function validateFixture(initial_state) {
  const files = Array.isArray(initial_state?.files) ? initial_state.files : [];
  if (!files.length) fail(400, "INVALID_FIXTURE", "A benchmark task fixture must declare its initial project files");
  if (files.length > BENCHMARK_LIMITS.fixture_files) fail(400, "INVALID_FIXTURE", `A fixture may declare at most ${BENCHMARK_LIMITS.fixture_files} files`);
  for (const f of files) {
    if (!f?.path || typeof f.content !== "string") fail(400, "INVALID_FIXTURE", "Every fixture file needs a path and string content");
    if (f.content.length > BENCHMARK_LIMITS.fixture_file_chars) fail(400, "INVALID_FIXTURE", `Fixture file ${f.path} exceeds ${BENCHMARK_LIMITS.fixture_file_chars} characters`);
  }
  return {
    files: files.map((f) => ({ path: String(f.path).slice(0, 300), content: f.content })),
    entities: (Array.isArray(initial_state?.entities) ? initial_state.entities : []).map((e) => ({ name: String(e.name || "").slice(0, 120), fields: e.fields || {} })).filter((e) => e.name),
  };
}

/**
 * Defines a benchmark task, or the NEXT version of an existing task key. Explicit fixtures only:
 * the goal text and the starting state are supplied by the operator and stored verbatim (scrubbed),
 * never generated. Re-defining a key never edits the previous row, so a finalized benchmark keeps
 * the exact task text and fixture it measured.
 */
export async function addBenchmarkTask(base44, user, {
  benchmark_id, task_key, goal, success_criteria = null, initial_state,
  required_capabilities = [], verification_criteria = null,
  category = "general", difficulty = "medium", time_budget_ms = null, max_steps = null,
} = {}) {
  const { benchmark, project, workspace } = await authorizeBenchmark(base44, user, benchmark_id, "project.write");
  assertDraft(benchmark);
  const key = String(task_key || "").trim().slice(0, 120);
  if (!key) fail(400, "INVALID_INPUT", "task_key is required");
  const text = String(goal || "").trim().slice(0, BENCHMARK_LIMITS.goal);
  if (!text) fail(400, "INVALID_INPUT", "A task goal is required");
  if (benchmark.scope === "platform" && !(benchmark.approved_task_keys || []).includes(key)) {
    fail(403, "FIXTURE_NOT_APPROVED", "A platform benchmark may only use explicitly approved benchmark fixtures");
  }
  const svc = svcOf(base44);
  const existing = await svc.entities.BenchmarkTask.filter({ benchmark_id: benchmark.id, task_key: key }, "-task_version", 20);
  if (existing.length >= 1 && existing.some((t) => t.finalized)) fail(409, "TASK_FINALIZED", "This task version is finalized and immutable");
  const distinctKeys = (await currentTaskSet(svc, benchmark.id)).length;
  if (!existing.length && distinctKeys >= BENCHMARK_LIMITS.tasks) fail(400, "TOO_MANY_TASKS", `A benchmark may hold at most ${BENCHMARK_LIMITS.tasks} tasks`);

  const state = validateFixture(initial_state);
  const draft = {
    task_key: key, task_version: Math.max(0, ...existing.map((t) => t.task_version || 0)) + 1,
    definition: scrub({ goal: scrubText(text, BENCHMARK_LIMITS.goal), success_criteria: success_criteria ? scrubText(success_criteria, 1000) : null, fixture: true }),
    initial_state: scrub(state),
    required_capabilities: (required_capabilities || []).map((c) => String(c).slice(0, 60)).slice(0, 12),
    verification_criteria: scrub({
      must_build: verification_criteria?.must_build !== false,
      must_pass_runtime: verification_criteria?.must_pass_runtime !== false,
      expect_entities: (verification_criteria?.expect_entities || []).map((e) => String(e).slice(0, 120)).slice(0, 20),
      expect_files: (verification_criteria?.expect_files || []).map((f) => String(f).slice(0, 300)).slice(0, 40),
      required_dimensions: (verification_criteria?.required_dimensions || ["task_completion"]).slice(0, 6),
    }),
    category: String(category || "general").slice(0, 60), difficulty: String(difficulty || "medium").slice(0, 20),
    time_budget_ms: time_budget_ms == null ? null : Math.max(1000, Number(time_budget_ms)),
    max_steps: max_steps == null ? null : Math.max(1, Math.min(20, Number(max_steps))),
  };

  const record = await svc.entities.BenchmarkTask.create({
    benchmark_id: benchmark.id, workspace_id: workspace.id, ...draft,
    initial_state_fingerprint: initialStateFingerprint(draft.initial_state),
    checksum: taskChecksum(draft), finalized: false, created_by: user.id, created_at: nowIso(),
  });
  const { benchmark: refreshed } = await refreshDefinition(svc, benchmark, { bump_task_set: true });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "benchmark.task.defined", resource: "BenchmarkTask", resource_id: record.id,
    metadata: { benchmark_id: benchmark.id, task_key: key, task_version: record.task_version, checksum: record.checksum },
  });
  return { task: publicTask(record), benchmark: publicBenchmark(refreshed) };
}

/**
 * Registers a model/configuration candidate. Provider-neutral by construction: the candidate names
 * a catalog model id, and the provider is RESOLVED from the existing Model Catalog rather than
 * supplied — so nothing here hardcodes a provider and an unknown or disabled model is refused
 * instead of silently falling back to a different one.
 */
export async function registerCandidate(base44, user, {
  benchmark_id, name, model_id, candidate_version = "1", candidate_config = null, routing_config = null, execution_path = "run",
} = {}) {
  const { benchmark, project, workspace } = await authorizeBenchmark(base44, user, benchmark_id, "project.write");
  assertDraft(benchmark);
  const label = String(name || "").trim().slice(0, BENCHMARK_LIMITS.name);
  if (!label) fail(400, "INVALID_INPUT", "A candidate name is required");
  if (!EXECUTION_PATHS.includes(execution_path)) fail(400, "INVALID_EXECUTION_PATH", `execution_path must be one of ${EXECUTION_PATHS.join(", ")}`);
  const entry = MODEL_REGISTRY.find((m) => m.model_id === model_id || m.id === model_id);
  if (!entry) fail(400, "UNKNOWN_MODEL", `Unknown model id: ${model_id}`);
  if (!entry.enabled) fail(400, "MODEL_DISABLED", `Model ${model_id} is not active in the catalog`);

  const candidates = [...(benchmark.candidates || [])];
  if (candidates.length >= BENCHMARK_LIMITS.candidates) fail(400, "TOO_MANY_CANDIDATES", `A benchmark may compare at most ${BENCHMARK_LIMITS.candidates} candidates`);
  const draft = {
    candidate_id: fingerprint("cand", { label, model_id: entry.model_id, candidate_version, candidate_config: candidate_config || {}, routing_config: routing_config || {}, execution_path }),
    name: label, candidate_version: String(candidate_version).slice(0, 40),
    model_id: entry.model_id, provider: entry.upstream_provider, gateway_provider: entry.provider,
    candidate_config: scrub({ tier: entry.tier, capabilities: entry.capabilities || [], ...(candidate_config || {}) }),
    routing_config: scrub({ strategy: routing_config?.strategy || null, budget_credits: routing_config?.budget_credits ?? null, prefer_model_id: entry.model_id, ...(routing_config || {}) }),
    execution_path,
  };
  if (candidates.some((c) => c.candidate_id === draft.candidate_id)) fail(409, "CANDIDATE_EXISTS", "An identical candidate configuration is already registered");
  candidates.push({ ...draft, config_checksum: candidateChecksum(draft) });

  const svc = svcOf(base44);
  const saved = await svc.entities.Benchmark.update(benchmark.id, { candidates });
  const { benchmark: refreshed } = await refreshDefinition(svc, saved);
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "benchmark.candidate.registered", resource: "Benchmark", resource_id: benchmark.id,
    metadata: { candidate: label, model_id: entry.model_id, provider: entry.upstream_provider, execution_path },
  });
  return { benchmark: publicBenchmark(refreshed), candidate: candidates[candidates.length - 1] };
}

// --- authorized reads ----------------------------------------------------------

export async function getBenchmark(base44, user, { benchmark_id, include_tasks = true } = {}) {
  const { benchmark } = await authorizeBenchmark(base44, user, benchmark_id, "project.read");
  const tasks = include_tasks ? await currentTaskSet(svcOf(base44), benchmark.id) : [];
  return { benchmark: publicBenchmark(benchmark), tasks: tasks.map(publicTask) };
}

export async function listBenchmarks(base44, user, { project_id, limit = 20 } = {}) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.Benchmark.filter({ workspace_id: workspace.id, project_id: project.id }, "-created_date", Math.min(limit, 100));
  return { project_id: project.id, count: rows.length, benchmarks: rows.map(publicBenchmark) };
}

export async function listBenchmarkTaskVersions(base44, user, { benchmark_id, task_key } = {}) {
  const { benchmark } = await authorizeBenchmark(base44, user, benchmark_id, "project.read");
  const rows = await svcOf(base44).entities.BenchmarkTask.filter({ benchmark_id: benchmark.id, ...(task_key ? { task_key: String(task_key) } : {}) }, "task_version", 100);
  return { benchmark_id: benchmark.id, count: rows.length, tasks: rows.map(publicTask) };
}

export { assertDraft, assertMutable };