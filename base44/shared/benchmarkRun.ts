// NexusAI Benchmark Harness — CONTROLLED EXECUTION, SCORING and AGGREGATION.
//
// Every candidate is measured through the platform's REAL execution path — there is no simulator
// here. A benchmark attempt starts a real AIRun (or a real AgentRun, which delegates its mutations
// to that same pipeline), so the measurement flows through the existing Model Gateway → Agent Loop
// / run pipeline → Tool Router → Runtime → Build & runtime verification → Trajectory (#18), and is
// then judged by the existing Judge (#19) and, where available, the existing Reward engine (#20).
// This module adds no second execution engine, no second retry system and no second trace system.
//
// Equal conditions are structural, not promised:
//   • every candidate of a task gets its OWN scratch project seeded from the SAME fixture, and the
//     fingerprint of the state it received is stored on the result, so equivalence is checkable;
//   • the tool profile, evaluator version, reward policy, runtime contract and budgets are
//     properties of the BENCHMARK, so no candidate can be handed a hidden advantage;
//   • the only thing that varies between candidates is the candidate configuration itself.
//
// Isolation: a benchmark attempt NEVER touches a user/production project or the fixture. It
// executes in a throwaway project created inside the benchmark's own workspace.
//
// Failure honesty: an infrastructure, fixture, authorization or ineligibility failure is recorded
// with its own classification and marked UNSCORED, so an environment problem can never be reported
// as a model deficiency.
import {
  BENCHMARK_LIMITS, BENCHMARK_HARNESS_VERSION, RUNTIME_CONTRACT_VERSION,
  authorizeBenchmark, assertMutable, currentTaskSet, publicBenchmark, publicTask,
  fingerprint, initialStateFingerprint, refreshDefinition,
} from "./benchmark.ts";
import { enqueueRun } from "./runEnqueue.ts";
import { startClaim, canonicalResults, isStartOrphan } from "./benchmarkRunIdentity.ts";
import { evaluateTrajectory } from "./evaluation.ts";
import { calculateReward } from "./reward.ts";
import { trajectoryForRun } from "./trajectory.ts";
import { scrub, scrubText, recordSpan } from "./tracing.ts";
import { audit } from "./authz.ts";
import { AGENT_TERMINAL } from "./agentLoop.ts";
// Reliability, tool-call success, real provider cost, context handling and structured-output
// quality. Every value is READ from an authoritative record; nothing there prices or estimates.
import { extendedMeasurements, extendedBucket } from "./benchmarkMetrics.ts";
import { TERMINAL_STATUSES as RUN_TERMINAL } from "./runPipeline.ts";

export const RESULT_TERMINAL = ["COMPLETED", "FAILED", "SKIPPED", "INELIGIBLE"];
export const FAILURE_CLASSES = [
  "none", "model_provider_failure", "timeout", "tool_failure", "build_failure",
  "runtime_failure", "authorization_failure", "infrastructure_failure", "benchmark_fixture_failure",
];
// Failures that are NOT the candidate's doing. Recorded in full, excluded from every model rate.
export const UNSCORED_FAILURES = ["infrastructure_failure", "benchmark_fixture_failure", "authorization_failure"];

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const round = (n) => (n == null ? null : Math.round(n * 1e6) / 1e6);
const rate = (hits, total) => (total ? round(hits / total) : null);
const avg = (values) => { const v = values.filter((x) => x != null); return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null; };

// --- deterministic measurement identity ---------------------------------------

/**
 * The identity of ONE measurement. Repeated execution with the same benchmark version, task
 * version, candidate configuration and environment fingerprint resolves this same key, which is
 * what makes a rebuild idempotent instead of appending a second, conflicting result.
 */
export function resultRunKey({ benchmark, task, candidate }) {
  return fingerprint("brun", {
    benchmark_name: benchmark.name, benchmark_version: benchmark.version, scope: benchmark.scope,
    task_key: task.task_key, task_version: task.task_version, task_checksum: task.checksum,
    candidate_config: candidate.config_checksum, execution_path: candidate.execution_path,
    environment: benchmark.environment_fingerprint,
  });
}

const reproducibility = (benchmark, task, candidate) => ({
  harness_version: BENCHMARK_HARNESS_VERSION,
  benchmark_version: benchmark.version, definition_checksum: benchmark.definition_checksum,
  task_set_version: benchmark.task_set_version, task_set_fingerprint: benchmark.task_set_fingerprint,
  task_version: task.task_version, task_checksum: task.checksum,
  evaluator_version: benchmark.evaluation_policy_version,
  reward_policy_version: benchmark.reward_policy_version || null,
  candidate_version: candidate.candidate_version, candidate_config_checksum: candidate.config_checksum,
  runtime_environment_version: benchmark.runtime_environment_version || RUNTIME_CONTRACT_VERSION,
  tool_config_fingerprint: benchmark.tool_config_fingerprint,
  environment_fingerprint: benchmark.environment_fingerprint,
  dataset_fingerprint: benchmark.dataset_reference?.checksum || null,
});

export const resultChecksum = (r) => fingerprint("bres", {
  run_key: r.run_key, status: r.status, scored: r.scored !== false, failure_class: r.failure_class || "none",
  metrics: r.metrics || {}, task_key: r.task_key, task_version: r.task_version, candidate_id: r.candidate_id,
  initial_state_fingerprint: r.initial_state_fingerprint || null,
});

export const publicResult = (r) => ({
  result_id: r.id, benchmark_id: r.benchmark_id, benchmark_version: r.benchmark_version,
  task_id: r.task_id, task_key: r.task_key, task_version: r.task_version,
  task_category: r.task_category || null, task_difficulty: r.task_difficulty || null,
  candidate_id: r.candidate_id, candidate_name: r.candidate_name, candidate_version: r.candidate_version,
  model_id: r.model_id, provider: r.provider, execution_path: r.execution_path,
  run_key: r.run_key, status: r.status, scored: r.scored !== false,
  benchmark_project_id: r.benchmark_project_id || null, initial_state_fingerprint: r.initial_state_fingerprint || null,
  run_id: r.run_id || null, agent_run_id: r.agent_run_id || null, trace_id: r.trace_id || null,
  trajectory_id: r.trajectory_id || null, evaluation_id: r.evaluation_id || null, reward_id: r.reward_id || null,
  build_id: r.build_id || null, version_id: r.version_id || null,
  metrics: r.metrics || {}, usage: r.usage || null, retries: r.retries || {},
  failure_class: r.failure_class || "none", failure_detail: r.failure_detail || null,
  result_checksum: r.result_checksum || null, reproducibility: r.reproducibility || {},
  started_at: r.started_at || null, completed_at: r.completed_at || null, latency_ms: r.latency_ms ?? null,
});

// --- isolated benchmark state -------------------------------------------------

/**
 * Seeds ONE throwaway project from the task fixture. The fixture itself is only read; the project
 * lives in the benchmark's own workspace and is never a user or production project, so a candidate
 * can neither see nor damage real state.
 */
async function seedBenchmarkProject(svc, { benchmark, task, candidate }) {
  const state = task.initial_state || {};
  const project = await svc.entities.Project.create({
    workspace_id: benchmark.workspace_id,
    name: `bm-${String(benchmark.id).slice(-6)}-${task.task_key}-${String(candidate.candidate_id).slice(-6)}`.slice(0, 120),
    description: `Isolated benchmark scratch project — benchmark ${benchmark.id} v${benchmark.version}, task ${task.task_key} v${task.task_version}, candidate ${candidate.name}. Created by the benchmark harness; not a user project.`,
    framework: "preact-htm", status: "draft", version_count: 1, last_build_status: "success",
  });
  const files = (state.files || []).map((f) => ({ project_id: project.id, path: f.path, content: f.content, frozen: false }));
  if (files.length) await svc.entities.ProjectFile.bulkCreate(files);
  for (const e of state.entities || []) {
    await svc.entities.AppEntity.create({ project_id: project.id, name: e.name, fields: e.fields || {} });
  }
  await svc.entities.ProjectVersion.create({
    project_id: project.id, number: 1, message: `Benchmark fixture ${task.task_key} v${task.task_version}`,
    changed_files: files.map((f) => ({ path: f.path, change: "added" })),
    snapshot: { files: (state.files || []), entities: state.entities || [] },
  });
  return project;
}

// --- execution ----------------------------------------------------------------

const capabilitiesOf = (candidate) => (candidate.candidate_config?.capabilities || []).map(String);
const missingCapabilities = (task, candidate) => (task.required_capabilities || []).filter((c) => !capabilitiesOf(candidate).includes(String(c)));

/**
 * Starts (or resumes) every task × candidate execution of a benchmark.
 *
 * Idempotent: an execution whose deterministic run key already has a terminal result is SKIPPED
 * rather than re-run, and one that is still in flight is re-attached to. Repeated calls therefore
 * cannot corrupt or duplicate a result set.
 */
export async function startBenchmark(base44, user, { benchmark_id } = {}) {
  const { benchmark, project: owner, workspace } = await authorizeBenchmark(base44, user, benchmark_id, "project.write");
  assertMutable(benchmark);
  if (!["DRAFT", "RUNNING", "COMPLETED", "FAILED"].includes(benchmark.status)) fail(409, "BENCHMARK_NOT_RUNNABLE", `A benchmark in status ${benchmark.status} cannot be run`);
  const svc = svcOf(base44);
  const tasks = await currentTaskSet(svc, benchmark.id);
  const candidates = benchmark.candidates || [];
  if (!tasks.length) fail(409, "NO_TASKS", "Define at least one benchmark task before running");
  if (!candidates.length) fail(409, "NO_CANDIDATES", "Register at least one model candidate before running");

  // The definition is frozen for this execution, so every result's reproducibility block names the
  // exact configuration that produced it.
  const { benchmark: frozen } = await refreshDefinition(svc, benchmark);
  const out = { started: 0, resumed: 0, skipped: 0, ineligible: 0, fixture_failures: 0, results: [] };

  for (const task of tasks) {
    for (const candidate of candidates) {
      const run_key = resultRunKey({ benchmark: frozen, task, candidate });
      const [existing] = canonicalResults(await svc.entities.BenchmarkResult.filter({ benchmark_id: frozen.id, run_key }, "created_date", 5)).canonical;
      if (existing && RESULT_TERMINAL.includes(existing.status)) { out.skipped++; out.results.push(publicResult(existing)); continue; }
      if (existing) { out.resumed++; out.results.push(publicResult(existing)); continue; }
      // Another start owns this run key right now: never execute the same measurement twice.
      if (!(await startClaim(svc, frozen.id, run_key))) { out.resumed++; continue; }

      const base = {
        benchmark_id: frozen.id, workspace_id: frozen.workspace_id, benchmark_version: frozen.version,
        task_id: task.id, task_key: task.task_key, task_version: task.task_version,
        task_category: task.category || undefined, task_difficulty: task.difficulty || undefined,
        candidate_id: candidate.candidate_id, candidate_name: candidate.name, candidate_version: candidate.candidate_version,
        model_id: candidate.model_id, provider: candidate.provider, execution_path: candidate.execution_path,
        run_key, initial_state_fingerprint: task.initial_state_fingerprint || initialStateFingerprint(task.initial_state),
        reproducibility: reproducibility(frozen, task, candidate), started_at: nowIso(),
      };

      // A candidate that cannot support the task's declared capabilities is recorded as INELIGIBLE
      // and left unscored — measuring it would report a capability gap as a quality failure.
      const missing = missingCapabilities(task, candidate);
      if (missing.length) {
        const row = await svc.entities.BenchmarkResult.create({
          ...base, status: "INELIGIBLE", scored: false, failure_class: "none",
          failure_detail: `Candidate does not support required capabilities: ${missing.join(", ")}`,
          metrics: {}, completed_at: nowIso(), latency_ms: 0,
        });
        await svc.entities.BenchmarkResult.update(row.id, { result_checksum: resultChecksum(row) });
        out.ineligible++; out.results.push(publicResult(row));
        continue;
      }

      // The measurement row is persisted BEFORE any side effect, so a start that dies mid-way leaves
      // a visible PENDING row (resolved by advance as outcome-unknown) instead of an invisible orphan.
      let row = await svc.entities.BenchmarkResult.create({ ...base, status: "PENDING", scored: true, metrics: {} });
      try {
        const scratch = await seedBenchmarkProject(svc, { benchmark: frozen, task, candidate });
        const goal = task.definition?.goal || "";
        if (candidate.execution_path === "agent") {
          // The REAL agent loop: the existing Agent Executor workflow drives it, and its mutations
          // are delegated to the same AI run pipeline every other candidate uses.
          const agentRun = await svc.entities.AgentRun.create({
            project_id: scratch.id, workspace_id: frozen.workspace_id, user_id: user.id, goal,
            status: "QUEUED", current_phase: "queued", current_step: 0,
            max_steps: Math.min(task.max_steps || 6, 20), cancel_requested: false,
            started_at: nowIso(), heartbeat_at: nowIso(),
          });
          row = await svc.entities.BenchmarkResult.update(row.id, { status: "RUNNING", benchmark_project_id: scratch.id, agent_run_id: agentRun.id });
        } else {
          // The REAL AI run pipeline. `modelId` is the candidate's model, handed to the existing
          // router as a preference — the router still validates capability and budget and records
          // any fallback, which is exactly the production behaviour being measured.
          const enq = await enqueueRun(svc, { project: scratch, prompt: goal, mode: "default", modelId: candidate.model_id });
          // Run identity: a result row without a run id could never resolve and would stay RUNNING.
          if (!enq?.run_id) throw new Error("The AI run pipeline returned no run id");
          row = await svc.entities.BenchmarkResult.update(row.id, { status: "RUNNING", benchmark_project_id: scratch.id, run_id: enq.run_id, trace_id: enq.trace_id || undefined });
        }
        // Correlation only, through the platform's existing tracing system.
        if (row.trace_id) {
          await recordSpan(svc, {
            trace_id: row.trace_id, workspace_id: frozen.workspace_id, project_id: scratch.id, run_id: row.run_id || null,
            event_type: "background_job", name: "benchmark.execution_started", status: "running",
            reference_id: row.id,
            metadata: { benchmark_id: frozen.id, benchmark_version: frozen.version, task_key: task.task_key, task_version: task.task_version, candidate_id: candidate.candidate_id, model_id: candidate.model_id, run_key },
          }).catch(() => {});
        }
        out.started++; out.results.push(publicResult(row));
      } catch (e) {
        // The fixture (or its isolated project) could not be prepared. That is a HARNESS failure,
        // recorded as such on the SAME row and never charged to the candidate.
        // A refusal (e.g. the plan's model-selection gate) is an authorization outcome, still unscored.
        const auth = e?.status === 401 || e?.status === 403;
        row = await svc.entities.BenchmarkResult.update(row.id, {
          status: "FAILED", scored: false, failure_class: auth ? "authorization_failure" : "benchmark_fixture_failure",
          failure_detail: scrubText(e.message, 300), completed_at: nowIso(),
        });
        await svc.entities.BenchmarkResult.update(row.id, { result_checksum: resultChecksum(row) });
        out.fixture_failures++; out.results.push(publicResult(row));
      }
    }
  }

  const updated = await svc.entities.Benchmark.update(frozen.id, {
    status: "RUNNING", started_at: frozen.started_at || nowIso(), error: null,
    item_count: tasks.length * candidates.length,
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: owner.id, user_id: user.id,
    action: "benchmark.run.started", resource: "Benchmark", resource_id: frozen.id,
    metadata: { tasks: tasks.length, candidates: candidates.length, started: out.started, skipped: out.skipped, ineligible: out.ineligible },
  });
  return { benchmark: publicBenchmark(updated), ...out };
}

// --- failure classification ---------------------------------------------------

const PROVIDER_RE = /(provider|model|rate limit|overloaded|unavailable|429|50[0234])/i;
const TIMEOUT_RE = /(timed out|timeout|deadline)/i;
const TOOL_RE = /(tool|mcp|function call|invalid arguments)/i;
const AUTH_RE = /(unauthorized|forbidden|not a member|not authorized|budget|insufficient credits|quota)/i;

/**
 * Classifies a failed attempt from the authoritative execution records. The ordering matters: a
 * provider/timeout/authorization problem is decided BEFORE build/runtime, so an outage is never
 * relabelled as a quality failure, and vice versa.
 *
 * `measurable` says the execution actually ran to a terminal, evaluated state. Such an attempt that
 * simply did not satisfy the task's criteria is NOT a system failure: it is recorded with no failure
 * class and stays SCORED, because that is exactly the model deficiency a benchmark exists to expose.
 */
export function classifyFailure({ run, trajectory, evaluation, measurable = false }) {
  const outcomes = trajectory?.outcomes || {};
  const scores = evaluation?.scores || {};
  const text = `${run?.error || ""} ${run?.phase_error_code || ""} ${outcomes.error || ""}`.trim();
  if (run?.status === "CANCELLED" || trajectory?.status === "CANCELLED") return { failure_class: "infrastructure_failure", scored: false, detail: "Execution was cancelled before it could be measured" };
  if (run?.status === "STALE") return { failure_class: "infrastructure_failure", scored: false, detail: "Execution worker went stale; the attempt never produced a measurable outcome" };
  if (TIMEOUT_RE.test(text)) return { failure_class: "timeout", scored: true, detail: text };
  if (AUTH_RE.test(text)) return { failure_class: "authorization_failure", scored: false, detail: text };
  if (PROVIDER_RE.test(text)) return { failure_class: "model_provider_failure", scored: true, detail: text };
  if (TOOL_RE.test(text)) return { failure_class: "tool_failure", scored: true, detail: text };
  if (outcomes.runtime_ok === false || scores.runtime_score === 0) return { failure_class: "runtime_failure", scored: true, detail: `Runtime verification failed${outcomes.runtime_category ? `: ${outcomes.runtime_category}` : ""}` };
  if (outcomes.build_status && outcomes.build_status !== "success") return { failure_class: "build_failure", scored: true, detail: `Build did not succeed (${outcomes.build_status})` };
  if (scores.build_score === 0) return { failure_class: "build_failure", scored: true, detail: "Build score 0 from the authoritative build record" };
  if (measurable) return { failure_class: "none", scored: true, detail: "Execution completed and was measured, but the task's verification criteria were not met" };
  if (text) return { failure_class: "infrastructure_failure", scored: false, detail: text };
  return { failure_class: "infrastructure_failure", scored: false, detail: "Execution failed without a classifiable cause" };
}

// --- scoring ------------------------------------------------------------------

/**
 * Derives the SEPARATE metrics of one attempt. Every quality signal is read from the Judge's
 * evaluation (#19) and the fixture's own verification criteria; nothing is inferred from the model's
 * own account of what it did, and an unmeasurable signal stays null rather than becoming zero.
 */
export async function scoreResult(svc, { task, trajectory, evaluation, reward, run, benchmark_project_id, workspace_id = null, model_id = null }) {
  const scores = evaluation?.scores || {};
  const criteria = task.verification_criteria || {};
  const m = evaluation?.metrics || {};

  // Fixture verification, applied identically to every candidate: the expected entities and files
  // must actually exist in the isolated project the attempt ran in.
  let expectations_met = null;
  const missing = [];
  if (benchmark_project_id && ((criteria.expect_entities || []).length || (criteria.expect_files || []).length)) {
    const [entities, files] = await Promise.all([
      svc.entities.AppEntity.filter({ project_id: benchmark_project_id }, "name", 200).catch(() => []),
      svc.entities.ProjectFile.filter({ project_id: benchmark_project_id }, "path", 500).catch(() => []),
    ]);
    const names = new Set(entities.map((e) => e.name));
    const paths = new Set(files.map((f) => f.path));
    for (const e of criteria.expect_entities || []) if (!names.has(e)) missing.push(`entity:${e}`);
    for (const p of criteria.expect_files || []) if (!paths.has(p)) missing.push(`file:${p}`);
    expectations_met = missing.length === 0;
  }

  const buildOk = scores.build_score == null ? null : scores.build_score === 1;
  const runtimeOk = scores.runtime_score == null ? null : scores.runtime_score === 1;
  const completionOk = scores.task_completion_score == null ? null : scores.task_completion_score === 1;
  // Task success requires the episode to have completed AND the fixture's own criteria to hold.
  const gates = [completionOk];
  if (criteria.must_build !== false) gates.push(buildOk);
  if (criteria.must_pass_runtime !== false) gates.push(runtimeOk);
  if (expectations_met != null) gates.push(expectations_met);
  const task_success = gates.some((g) => g === false) ? 0 : gates.every((g) => g === true) ? 1 : null;

  // The dimensions that come from the execution's own accounting and episode evidence rather than
  // from the Judge: reliability inputs, tool-call success, real cost, context and structured output.
  const extended = await extendedMeasurements(svc, { run, trajectory, workspace_id, model_id: model_id || run?.model || null });

  return {
    metrics: scrub({
      extended: extended.metrics,
      task_success, build_success: buildOk == null ? null : buildOk ? 1 : 0, runtime_success: runtimeOk == null ? null : runtimeOk ? 1 : 0,
      regression: scores.regression_score == null ? null : scores.regression_score === 0 ? 1 : 0,
      repair_count: m.repair_attempts ?? null, repair_needed: (m.repair_attempts ?? 0) > 0 ? 1 : 0,
      expectations_met, missing_expectations: missing.slice(0, 20),
      judge_scores: scores, judge_findings: (evaluation?.findings || []).slice(0, 10),
      reward_score: reward?.final_reward ?? null, reward_objective: reward?.objective_reward ?? null,
      files_changed: m.files_changed ?? null, entities_changed: m.entities_changed ?? null,
      tool_calls: m.tool_calls ?? null, failed_tool_calls: m.failed_tool_calls ?? null,
      duration_ms: m.duration_ms ?? trajectory?.duration_ms ?? null,
    }),
    // Usage/cost only where the execution actually reported it — never fabricated.
    // Numeric counts are copied verbatim; only the free-text identifiers pass through the scrubber,
    // because a key-based redaction would otherwise destroy the token counts themselves.
    usage: run && (run.input_tokens || run.output_tokens || run.credits_charged || run.model)
      ? {
        model_used: run.model ? scrubText(String(run.model), 120) : null,
        provider: run.provider ? scrubText(String(run.provider), 120) : null,
        input_tokens: run.input_tokens ?? null, output_tokens: run.output_tokens ?? null,
        credits_charged: run.credits_charged ?? null,
        operation_id: run.operation_id ? scrubText(String(run.operation_id), 120) : null,
        fallback_used: (trajectory?.fallbacks || []).length > 0,
      }
      : null,
    retries: {
      retry_count: trajectory?.retries ?? run?.repair_attempts ?? 0,
      final_attempt: (trajectory?.retries ?? 0) + 1,
      changed_outcome: (trajectory?.retries ?? 0) > 0 ? task_success === 1 : false,
    },
  };
}

/**
 * Resolves every in-flight attempt whose execution has reached a terminal state, judging it with
 * the benchmark's pinned evaluator and, when possible, the pinned reward policy. Safe to call
 * repeatedly: an already-terminal result is left untouched.
 */
export async function advanceBenchmark(base44, user, { benchmark_id } = {}) {
  const { benchmark, project: owner, workspace } = await authorizeBenchmark(base44, user, benchmark_id, "project.write");
  const svc = svcOf(base44);
  if (benchmark.finalized) return { benchmark: publicBenchmark(benchmark), resolved: 0, pending: 0, finalized: true };

  const all = await svc.entities.BenchmarkResult.filter({ benchmark_id: benchmark.id }, "created_date", BENCHMARK_LIMITS.results_page);
  const { canonical: rows, duplicates } = canonicalResults(all);
  const tasks = new Map((await currentTaskSet(svc, benchmark.id)).map((t) => [t.id, t]));
  let resolved = 0, pending = 0;

  // A later row for an already-measured run key is a duplicate: closed as SKIPPED, never measured.
  for (const { row, canonical_id } of duplicates) {
    if (RESULT_TERMINAL.includes(row.status)) continue;
    const saved = await svc.entities.BenchmarkResult.update(row.id, { status: "SKIPPED", scored: false, failure_detail: `duplicate of result ${canonical_id}`, completed_at: nowIso() });
    await svc.entities.BenchmarkResult.update(row.id, { result_checksum: resultChecksum(saved) });
  }

  for (const row of rows) {
    if (RESULT_TERMINAL.includes(row.status)) continue;
    // A start that died before recording its execution: outcome unknown, NEVER re-run.
    if (isStartOrphan(row)) {
      const saved = await svc.entities.BenchmarkResult.update(row.id, { status: "FAILED", scored: false, failure_class: "infrastructure_failure", failure_detail: "The execution start did not record a run; its outcome is unknown and it was not re-run", completed_at: nowIso() });
      await svc.entities.BenchmarkResult.update(row.id, { result_checksum: resultChecksum(saved) });
      resolved++; continue;
    }
    const task = tasks.get(row.task_id);
    if (!task) { pending++; continue; }

    // Resolve the execution this attempt is waiting on.
    let run_id = row.run_id || null;
    if (row.execution_path === "agent" && row.agent_run_id) {
      const agentRun = await svc.entities.AgentRun.get(row.agent_run_id).catch(() => null);
      if (!agentRun || !AGENT_TERMINAL.includes(agentRun.status)) { pending++; continue; }
      run_id = run_id || (agentRun.ai_run_ids || [])[(agentRun.ai_run_ids || []).length - 1] || null;
      if (!run_id) {
        // The agent finished without delegating a builder run: nothing was executed to measure.
        const patch = { status: "FAILED", scored: false, failure_class: "infrastructure_failure", failure_detail: scrubText(agentRun.error || "Agent produced no builder run to measure", 300), completed_at: nowIso() };
        const saved = await svc.entities.BenchmarkResult.update(row.id, patch);
        await svc.entities.BenchmarkResult.update(row.id, { result_checksum: resultChecksum(saved) });
        resolved++; continue;
      }
    }
    if (!run_id) { pending++; continue; }

    const run = await svc.entities.AIRun.get(run_id).catch(() => null);
    if (!run || !RUN_TERMINAL.includes(run.status)) { pending++; continue; }

    const trajectory = await trajectoryForRun(svc, run.id);
    const started = Date.parse(row.started_at || run.started_at || run.created_date) || null;
    const finished = Date.parse(run.completed_at || nowIso());
    const latency_ms = run.duration_ms ?? (started ? finished - started : null);
    const commonPatch = {
      run_id: run.id, trace_id: run.trace_id || row.trace_id || undefined,
      build_id: run.build_id || undefined, version_id: run.version_id || undefined,
      trajectory_id: trajectory?.id || undefined, latency_ms, completed_at: nowIso(),
    };

    // No sealed episode ⇒ no authoritative evidence to judge. That is an infrastructure gap, not a
    // model verdict.
    if (!trajectory || !trajectory.sealed) {
      const patch = { ...commonPatch, status: "FAILED", scored: false, failure_class: "infrastructure_failure", failure_detail: scrubText(run.error || "Execution produced no sealed episode to evaluate", 300) };
      const saved = await svc.entities.BenchmarkResult.update(row.id, patch);
      await svc.entities.BenchmarkResult.update(row.id, { result_checksum: resultChecksum(saved) });
      resolved++; continue;
    }

    // The Judge — the benchmark's pinned evaluator, identical for every candidate.
    let evaluation = null, reward = null, harnessError = null;
    try {
      evaluation = (await evaluateTrajectory(svc, { trajectory, evaluator_version: benchmark.evaluation_policy_version })).evaluation;
    } catch (e) { harnessError = e; }
    if (evaluation && benchmark.reward_policy_version) {
      // A reward is optional evidence: its absence is recorded, never treated as a zero score.
      try {
        reward = (await calculateReward(svc, { trajectory, reward_policy_version: benchmark.reward_policy_version, evaluator_version: benchmark.evaluation_policy_version })).reward;
      } catch { reward = null; }
    }
    if (!evaluation) {
      const patch = { ...commonPatch, status: "FAILED", scored: false, failure_class: "infrastructure_failure", failure_detail: scrubText(harnessError?.message || "Evaluation could not be produced", 300) };
      const saved = await svc.entities.BenchmarkResult.update(row.id, patch);
      await svc.entities.BenchmarkResult.update(row.id, { result_checksum: resultChecksum(saved) });
      resolved++; continue;
    }

    const scored = await scoreResult(svc, { task, trajectory, evaluation, reward, run, benchmark_project_id: row.benchmark_project_id });
    const succeeded = run.status === "COMPLETED" && scored.metrics.task_success === 1;
    const classification = succeeded
      ? { failure_class: "none", scored: true, detail: null }
      : classifyFailure({ run, trajectory, evaluation, measurable: run.status === "COMPLETED" });
    const patch = {
      ...commonPatch, status: succeeded ? "COMPLETED" : "FAILED",
      evaluation_id: evaluation.id, reward_id: reward?.id || undefined,
      metrics: scored.metrics, usage: scored.usage || undefined, retries: scored.retries,
      failure_class: classification.failure_class, failure_detail: classification.detail ? scrubText(classification.detail, 300) : undefined,
      scored: classification.scored !== false,
    };
    const saved = await svc.entities.BenchmarkResult.update(row.id, patch);
    await svc.entities.BenchmarkResult.update(row.id, { result_checksum: resultChecksum(saved) });
    resolved++;
  }

  const fresh = canonicalResults(await svc.entities.BenchmarkResult.filter({ benchmark_id: benchmark.id }, "created_date", BENCHMARK_LIMITS.results_page)).canonical;
  const terminal = fresh.filter((r) => RESULT_TERMINAL.includes(r.status));
  let updated = benchmark;
  if (terminal.length === fresh.length && fresh.length) {
    const { summary, failure_summary, checksum } = aggregateResults(benchmark, terminal);
    const anyScored = terminal.some((r) => r.scored !== false && ["COMPLETED", "FAILED"].includes(r.status));
    updated = await svc.entities.Benchmark.update(benchmark.id, {
      status: anyScored ? "COMPLETED" : "FAILED", summary, failure_summary, checksum,
      completed_count: terminal.length, completed_at: nowIso(),
      error: anyScored ? null : "No candidate execution produced a measurable result",
    });
    await audit(svc, {
      workspace_id: workspace.id, project_id: owner.id, user_id: user.id,
      action: "benchmark.run.completed", resource: "Benchmark", resource_id: benchmark.id,
      metadata: { results: terminal.length, checksum, status: updated.status },
    });
  } else {
    updated = await svc.entities.Benchmark.update(benchmark.id, { completed_count: terminal.length });
  }
  return { benchmark: publicBenchmark(updated), resolved, pending, total: fresh.length, terminal: terminal.length };
}

// --- aggregation --------------------------------------------------------------

// One metric bucket. Rates are computed over SCORED results only, and the unscored count is kept
// beside them so an excluded infrastructure failure stays visible instead of disappearing.
function bucket(results) {
  const scored = results.filter((r) => r.scored !== false && ["COMPLETED", "FAILED"].includes(r.status));
  const val = (f) => scored.map((r) => (r.metrics || {})[f]).filter((v) => v != null);
  const ones = (f) => val(f).filter((v) => v === 1).length;
  const rewards = scored.map((r) => (r.metrics || {}).reward_score).filter((v) => v != null);
  const judge = scored.map((r) => (r.metrics || {}).judge_scores || {});
  const judgeAvg = (k) => avg(judge.map((s) => s[k]));
  return {
    executions: results.length, scored: scored.length,
    unscored: results.length - scored.length,
    ineligible: results.filter((r) => r.status === "INELIGIBLE").length,
    skipped: results.filter((r) => r.status === "SKIPPED").length,
    task_success_rate: rate(ones("task_success"), val("task_success").length),
    build_success_rate: rate(ones("build_success"), val("build_success").length),
    runtime_success_rate: rate(ones("runtime_success"), val("runtime_success").length),
    regression_rate: rate(ones("regression"), val("regression").length),
    repair_rate: rate(ones("repair_needed"), val("repair_needed").length),
    avg_repair_count: avg(val("repair_count")),
    avg_latency_ms: avg(scored.map((r) => r.latency_ms)),
    total_latency_ms: scored.reduce((a, r) => a + (r.latency_ms || 0), 0),
    avg_judge_task_completion: judgeAvg("task_completion_score"),
    avg_judge_build: judgeAvg("build_score"),
    avg_judge_runtime: judgeAvg("runtime_score"),
    avg_reward: rewards.length ? avg(rewards) : null,
    reward_coverage: rate(rewards.length, scored.length),
    usage: {
      input_tokens: scored.reduce((a, r) => a + ((r.usage || {}).input_tokens || 0), 0),
      output_tokens: scored.reduce((a, r) => a + ((r.usage || {}).output_tokens || 0), 0),
      credits_charged: round(scored.reduce((a, r) => a + ((r.usage || {}).credits_charged || 0), 0)),
      reported_for: scored.filter((r) => r.usage).length,
    },
  };
}

const groupBy = (rows, keyFn) => rows.reduce((acc, r) => { const k = keyFn(r) ?? "unknown"; (acc[k] = acc[k] || []).push(r); return acc; }, {});
const mapBuckets = (grouped, extra = () => ({})) =>
  Object.keys(grouped).sort().map((k) => ({ key: k, ...extra(grouped[k][0], k), ...bucket(grouped[k]) }));

/**
 * Aggregates raw task-level results. Deliberately NOT one opaque number: per-model, per-task and
 * per-category buckets each keep their own separate metrics, and the raw BenchmarkResult rows are
 * preserved so every aggregate here can be recomputed from them.
 */
export function aggregateResults(benchmark, results) {
  const rows = [...results].sort((a, b) => String(a.run_key).localeCompare(String(b.run_key)));
  const summary = {
    harness_version: BENCHMARK_HARNESS_VERSION,
    evaluator_version: benchmark.evaluation_policy_version,
    reward_policy_version: benchmark.reward_policy_version || null,
    environment_fingerprint: benchmark.environment_fingerprint,
    aggregate: bucket(rows),
    per_model: mapBuckets(groupBy(rows, (r) => r.candidate_id), (r) => ({ candidate_name: r.candidate_name, candidate_version: r.candidate_version, model_id: r.model_id, provider: r.provider, execution_path: r.execution_path })),
    per_task: mapBuckets(groupBy(rows, (r) => `${r.task_key}@${r.task_version}`), (r) => ({ task_key: r.task_key, task_version: r.task_version, category: r.task_category || null, difficulty: r.task_difficulty || null })),
    per_category: mapBuckets(groupBy(rows, (r) => r.task_category || "general")),
    raw_result_keys: rows.map((r) => r.run_key),
  };
  const failure_summary = {
    total_failures: rows.filter((r) => (r.failure_class || "none") !== "none").length,
    scored_failures: rows.filter((r) => (r.failure_class || "none") !== "none" && r.scored !== false).length,
    unscored_failures: rows.filter((r) => (r.failure_class || "none") !== "none" && r.scored === false).length,
    by_class: Object.fromEntries(FAILURE_CLASSES.map((c) => [c, rows.filter((r) => (r.failure_class || "none") === c).length]).filter(([, n]) => n > 0)),
    unscored_classes: UNSCORED_FAILURES,
  };
  const checksum = fingerprint("bchk", rows.map((r) => ({ run_key: r.run_key, result_checksum: r.result_checksum || resultChecksum(r) })));
  return { summary, failure_summary, checksum };
}

// --- finalization -------------------------------------------------------------

/**
 * Finalizes a COMPLETED benchmark. The aggregate and the checksum are RECOMPUTED from the stored
 * rows and compared with what the benchmark claims, so a result altered behind the benchmark's back
 * blocks finalization instead of shipping silently. After this, the benchmark, its task versions
 * and its results are immutable.
 */
export async function finalizeBenchmark(base44, user, { benchmark_id } = {}) {
  const { benchmark, project: owner, workspace } = await authorizeBenchmark(base44, user, benchmark_id, "project.write");
  if (benchmark.finalized) return { benchmark: publicBenchmark(benchmark), already_finalized: true };
  if (benchmark.status !== "COMPLETED") fail(409, "BENCHMARK_NOT_COMPLETED", `Only a COMPLETED benchmark can be finalized (current status: ${benchmark.status})`);
  const svc = svcOf(base44);
  const rows = canonicalResults(await svc.entities.BenchmarkResult.filter({ benchmark_id: benchmark.id }, "created_date", BENCHMARK_LIMITS.results_page)).canonical;
  const nonTerminal = rows.filter((r) => !RESULT_TERMINAL.includes(r.status));
  if (nonTerminal.length) fail(409, "RESULTS_NOT_TERMINAL", `${nonTerminal.length} execution(s) are still in flight`);

  const { summary, failure_summary, checksum } = aggregateResults(benchmark, rows);
  if (benchmark.checksum && benchmark.checksum !== checksum) {
    fail(409, "CHECKSUM_MISMATCH", "The recomputed result-set checksum does not match the benchmark's recorded checksum; the results changed after completion");
  }
  const updated = await svc.entities.Benchmark.update(benchmark.id, {
    status: "FINALIZED", finalized: true, finalized_at: nowIso(), summary, failure_summary, checksum, completed_count: rows.length,
  });
  // Task versions freeze with the benchmark: a finalized measurement always names the exact task it measured.
  for (const t of await svc.entities.BenchmarkTask.filter({ benchmark_id: benchmark.id }, "task_version", BENCHMARK_LIMITS.tasks * 4)) {
    if (!t.finalized) await svc.entities.BenchmarkTask.update(t.id, { finalized: true }).catch(() => {});
  }
  await audit(svc, {
    workspace_id: workspace.id, project_id: owner.id, user_id: user.id,
    action: "benchmark.finalized", resource: "Benchmark", resource_id: benchmark.id,
    metadata: { checksum, results: rows.length, definition_checksum: benchmark.definition_checksum },
  });
  return { benchmark: publicBenchmark(updated), checksum, result_count: rows.length };
}

// --- authorized reads ---------------------------------------------------------

export async function listResults(base44, user, { benchmark_id, task_key = null, candidate_id = null, limit = 100, offset = 0 } = {}) {
  const { benchmark } = await authorizeBenchmark(base44, user, benchmark_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.BenchmarkResult.filter(
    { benchmark_id: benchmark.id, ...(task_key ? { task_key: String(task_key) } : {}), ...(candidate_id ? { candidate_id: String(candidate_id) } : {}) },
    "created_date", Math.min(limit, BENCHMARK_LIMITS.results_page), offset,
  );
  return { benchmark_id: benchmark.id, count: rows.length, offset, results: rows.map(publicResult) };
}

/** Aggregate view. Recomputed from the raw rows, so it is reproducible rather than merely stored. */
export async function getAggregate(base44, user, { benchmark_id } = {}) {
  const { benchmark } = await authorizeBenchmark(base44, user, benchmark_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.BenchmarkResult.filter({ benchmark_id: benchmark.id }, "created_date", BENCHMARK_LIMITS.results_page);
  const terminal = canonicalResults(rows).canonical.filter((r) => RESULT_TERMINAL.includes(r.status));
  const recomputed = aggregateResults(benchmark, terminal);
  return {
    benchmark: publicBenchmark(benchmark),
    stored_checksum: benchmark.checksum || null,
    recomputed_checksum: recomputed.checksum,
    checksum_matches: !benchmark.checksum || benchmark.checksum === recomputed.checksum,
    summary: recomputed.summary, failure_summary: recomputed.failure_summary,
    result_count: terminal.length, pending: rows.length - terminal.length,
  };
}

export async function listFailures(base44, user, { benchmark_id } = {}) {
  const { benchmark } = await authorizeBenchmark(base44, user, benchmark_id, "project.read");
  const svc = svcOf(base44);
  const rows = await svc.entities.BenchmarkResult.filter({ benchmark_id: benchmark.id }, "created_date", BENCHMARK_LIMITS.results_page);
  const failures = rows.filter((r) => (r.failure_class || "none") !== "none" || r.status === "FAILED");
  return {
    benchmark_id: benchmark.id, count: failures.length,
    scored_failures: failures.filter((r) => r.scored !== false).length,
    unscored_failures: failures.filter((r) => r.scored === false).length,
    failures: failures.map((r) => ({
      result_id: r.id, run_key: r.run_key, task_key: r.task_key, task_version: r.task_version,
      candidate_name: r.candidate_name, model_id: r.model_id, status: r.status,
      failure_class: r.failure_class || "none", failure_detail: r.failure_detail || null, scored: r.scored !== false,
      run_id: r.run_id || null, trace_id: r.trace_id || null, trajectory_id: r.trajectory_id || null, evaluation_id: r.evaluation_id || null,
    })),
  };
}