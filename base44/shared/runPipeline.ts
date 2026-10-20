// Background AI run pipeline.
//
// The orchestration below is the same pipeline the synchronous endpoint used to run inline;
// it is now split into four resumable phases (plan → generate → build → commit). Each phase
// executes in its own request, so total run time is bounded by the persisted job lifecycle
// rather than by one HTTP request. Between phases the in-flight state (virtual FS, entities,
// plan, build result) is parked in storage and the run record carries the phase pointer.
import { createFs, buildIndex, selectContext, computeChanges, readFile, writeFile, activeFiles, serializeFs, deserializeFs } from "./projectFs.ts";
// Generated declarations: a projection of the FINAL entity + function set, emitted once per snapshot.
import { CONFIG_FILE, typesFilePath } from "./base44Layout.ts";
import { resolveEffectivePolicy } from "./routingPolicy.ts";
import { normalizePlanOutput, normalizeFileOutput, normalizePatchOutput } from "./planOutput.ts";
import { failureRecord, failureDetail, diagnosticLogLines, unappliedPlannedPaths, describeFailure } from "./runDiagnostics.ts";
import { selectModel } from "./selfImprovingRouter.ts";
import { MAX_FILES_PER_RUN, finalizePlanManifest, normalizePlanFileExports, truncationNote, gateExcludedFailures, buildGateFailures } from "./planManifest.ts";
import { emitProjectTypes } from "./typeEmit.ts";
import { runBuild } from "./buildEngine.ts";
import { verifyProjectRuntime } from "./runtimeVerify.ts";
import { createGateway, routeModel, executionChainIds, budgetAwareExecutionChain, worstCaseCallCredits, preferredModelIdFor } from "./modelGateway.ts";
import { loadCreditPolicy } from "./economics.ts";
import { loadCatalog } from "./modelCatalog.ts";
import { allowedTools, summarizeToolCall, describeFunctions, secretsView, integrationsView } from "./tools.ts";
// THE Builder execution boundary. Every tool call in every phase is routed through it.
import { createRunToolSession } from "./toolRouter.ts";
import { PLAN_SCHEMA, ANSWER_SCHEMA, FILE_SCHEMA, PATCH_SCHEMA, RESPONSE_SCHEMA, buildPlannerPrompt, buildAnswerPrompt, buildGeneratorPrompt, buildPatcherPrompt, buildSystemPrompt, buildContextBlock, buildRepairPrompt, fileTaskBlock, visualReferenceBlock, customInstructionsBlock, withCustomInstructions } from "./prompts.ts";
import { loadProjectState, audit } from "./authz.ts";
import { resolveRole, requireCapability, requireActiveWorkspace } from "./rbac.ts";
import { prepareRunConnections, invokeMcpTool } from "./mcp.ts";
import { recordBuild } from "./persistence.ts";
// Delegated Agent runs: the executing agent's own policy files are immutable while its run is live.
import { activePolicyAgentName, activeAgentNames } from "./agentPolicyGuard.ts";
// The parent agent's effective grants, inherited by delegated Builder runs.
import { resolveAgent, agentPermissionGate } from "./agentResource.ts";
// Canonical state is written through a journalled, recoverable commit: the previous and target
// states are durable BEFORE anything is mutated, so a worker crash is always resolvable into
// exactly one of the two states — never a half-committed project.
import { prepareCommit, finalizeCommit, rollbackCommit } from "./commitJournal.ts";
// Cooperative cancellation: the worker's gate on the run's durable cancel flag.
import { cancelIfRequested } from "./runCancel.ts";
// Phase leasing + bounded, persisted phase retries: at most one worker per phase, and a worker
// that lost its lease can never commit behind the winner's back.
import { acquirePhaseLease, assertPhaseLease, releasePhaseLease, schedulePhaseRetry, isRetryablePhaseError, PhaseLeaseLost } from "./runLease.ts";
// Commercial layer: one billable operation per run, priced by the economics engine and settled
// against the authoritative credit ledger, with budget-aware model selection.
import { settleUsage, spendableCredits, beginOperation, addModelUsage, mergeUsageByModel, ensureRunBudget, accumulateCallUsage } from "./aiOperations.ts";
import { resolveModelAccess } from "./subscriptions.ts";
import { stampUsageEvent } from "./usageEventStamp.ts";
import { packJson, unpackJson } from "./blobStore.ts";
import { hybridSearch, assembleContext, safeSyncProjectIndex } from "./projectIndex.ts";
import { retrieveMemories, extractMemories, safeStoreMemories, memoryBlock, retrievalBlock } from "./projectMemory.ts";
// Architecture Intelligence (#25): the certified, safe-failing read path into the project's versioned
// dependency graph. Additive reference context only — never an instruction — and it returns empty
// when no finalized architecture exists, so a run without one is byte-identical to before.
import { retrieveArchitectureForRun, architectureContextBlock } from "./architecture.ts";
import { reconcileArchitectureAfterMutation } from "./architectureReconcile.ts";
import { loadDesignSystem, saveDesignSystem, mergeTokens, tokensToCss, discoverComponents, designBlock, designIndexObjects, lintDesign, designPatchToObject } from "./designSystem.ts";
import { designSystemLibraryBlock } from "./designSystemPresets.ts";
import { loadImportedDesignRow, importedDesignSystemBlock } from "./designSystemImport.ts";
import { designRestylePending, designRestyleBlock } from "./designSystemApply.ts";
// Correlation only: one span per execution boundary, pointing at the records that already own
// the detail. Nothing here changes what the pipeline does or what it logs.
import { ensureRunTrace, recordSpan, newSpanId } from "./tracing.ts";
// Skills: deterministic specialist guidance selected per request, sitting between routing/prompt
// composition and tool execution. Additive prompt blocks only — the mode contracts and the Tool
// Router's authorization are untouched, and the strategy is recorded on the routing decision.
import { selectSkills, skillGuidanceBlock, skillStrategyRecord, loadEnabledWorkspaceSkills, workspaceSkillsBlock } from "./skills.ts";
// Learning data layer. The pipeline only EMITS into it — references, counts and concise structured
// metadata pointing at the records it already writes. Every call is best-effort (`emit` swallows
// and logs), so trajectory capture can never fail, slow or alter a run.
import {
  startTrajectory, trajectoryForRun, recordModelSelection, recordPlan, recordPhase, recordToolCalls,
  recordRetry, recordFallbacks, recordBuildResult, recordRuntimeResult, recordRepairAttempt,
  recordMutations, finalizeTrajectory, emit,
} from "./trajectory.ts";

const MAX_CONTEXT_ROUNDS = 2;
// Planning call budget. The gateway splits timeoutMs across attempts × min(chain, 2), so 90s with
// 2 attempts gave each attempt only 22.5s — below the 45s expected latency of the slow tier.
// One attempt per model keeps 45s each for the primary and its first fallback, inside 90s total;
// the fallback (in the router's order) takes the place of the same-model retry.
export const PLANNING_CALL = { timeoutMs: 90000, maxAttempts: 1 };
// Appended to the planner system prompt: the response is parsed strictly as a JSON plan object.
export const PLANNER_JSON_ONLY = "OUTPUT FORMAT: Respond with ONLY a single JSON object that matches the required plan schema. No Markdown, no code fences, no headings, no commentary before or after the JSON.";
const MAX_REPAIR_ATTEMPTS = 3;
// Per-phase guard only. It exists so a single phase always reaches an explicit persisted
// state inside its own request window — it is NOT the run's overall time limit.
const PHASE_BUDGET_MS = 100000;

export const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED", "STALE"];
export const NON_TERMINAL_STATUSES = ["QUEUED", "RUNNING", "CONTEXT_LOADING", "PLANNING", "EXECUTING", "VALIDATING", "REPAIRING"];

export { finalizePlanManifest, normalizePlanFileExports, truncationNote, gateExcludedFailures, buildGateFailures };

function assertTransition(from, to) {
  if (from && TERMINAL_STATUSES.includes(from) && to !== from) {
    throw new Error(`Invalid run transition ${from} -> ${to}: the run already reached a terminal state`);
  }
}

// --- shared phase scaffolding ------------------------------------------------

// Cached/reasoning totals carried between phases in staging. Staging written before these totals
// existed falls back to the per-model breakdown's sum, so the two stay in sync.
function stagedUsageTotal(staging, field) {
  const saved = staging?.[`usage_${field}`];
  if (Number.isFinite(saved)) return saved;
  return Object.values(staging?.usage_by_model || {}).reduce((n, u) => n + (Number(u?.[field]) || 0), 0);
}

function makeRunner(base44, run, trace = {}, staging = null, lease_token = null) {
  const steps = run.steps || [];
  const toolLog = run.tool_log || [];
  const usage = { input: run.input_tokens || 0, output: run.output_tokens || 0, cached: stagedUsageTotal(staging, "cached_input_tokens"), reasoning: stagedUsageTotal(staging, "reasoning_tokens"), calls: run.tool_calls || 0, estimated: false, fallbacks: [], by_model: {} };
  const phaseStart = Date.now();

  // Lease ownership: this worker's phase lease token, verified before EVERY runner write. A
  // worker whose lease expired and was reclaimed by another worker is a zombie: it must not
  // update phase status, append usage, mutate the staging pointer or finalize the phase, so
  // the check throws PHASE_LEASE_LOST and the executor treats it as a skipped duplicate —
  // the lease's current owner owns the run.
  const assertLeaseOwned = async () => {
    if (!lease_token) return;
    const fresh = await base44.entities.AIRun.get(run.id);
    if (fresh.phase_lease_token !== lease_token) throw new PhaseLeaseLost(run.id, run.phase || "phase");
  };

  // Every progress write doubles as a heartbeat, so a worker that dies mid-phase is reapable.
  const patch = async (data) => {
    await assertLeaseOwned();
    if (data.status) assertTransition(run.status, data.status);
    const saved = await base44.entities.AIRun.update(run.id, { ...data, heartbeat_at: new Date().toISOString() });
    if (data.status) run.status = data.status;
    return saved;
  };
  const checkBudget = (stage) => {
    if (Date.now() - phaseStart > PHASE_BUDGET_MS) throw new Error(`Phase exceeded its ${Math.round(PHASE_BUDGET_MS / 1000)}s window at "${stage}". No changes were saved.`);
  };
  // The step's span carries the run's trace and the phase span as its parent, and the repair
  // counter as its attempt — so a re-run of the same step after a repair is visibly attempt 2 of
  // one operation rather than a second unrelated step.
  const spanFor = (extra) => ({
    trace_id: trace.trace_id, parent_span_id: trace.span_id || null, workspace_id: trace.workspace_id || null,
    project_id: run.project_id, run_id: run.id, attempt: (run.repair_attempts || 0) + 1, ...extra,
  });
  const step = async (label, status, fn) => {
    const s = { label, status: "running", detail: "" };
    steps.push(s);
    await patch({ steps: [...steps], status });
    const started = Date.now();
    try {
      s.detail = (await fn()) || "";
      s.status = "done";
    } catch (e) {
      s.status = "failed"; s.detail = e.message;
      await patch({ steps: [...steps] });
      if (trace.trace_id) await recordSpan(base44, spanFor({ event_type: "ai_run_step", name: label, status: "error", error: e, error_code: e.code || "STEP_FAILED", duration_ms: Date.now() - started, metadata: { phase: run.phase || null, run_status: status } }));
      throw e;
    }
    await patch({ steps: [...steps] });
    if (trace.trace_id) await recordSpan(base44, spanFor({ event_type: "ai_run_step", name: label, status: "ok", duration_ms: Date.now() - started, metadata: { phase: run.phase || null, run_status: status, detail: s.detail } }));
  };
  const say = async (content) => { await assertLeaseOwned(); return base44.entities.Message.create({ project_id: run.project_id, conversation_id: run.conversation_id, run_id: run.id, role: "assistant", content }); };

  return { steps, toolLog, usage, patch, step, say, checkBudget, trace, spanFor };
}

const gatewayFor = (base44) => createGateway(base44);

// Delegated Builder runs inherit the parent agent's effective grants, resolved from the SAME
// project files this phase executes against — the agent's own per-iteration re-resolution. A
// missing or unresolvable agent document grants NOTHING (fail closed). Null (no parent agent)
// contributes nothing, exactly as before for human-initiated runs.
function delegatedPolicyContext(policyAgentName, files) {
  if (!policyAgentName) return null;
  const agent = resolveAgent(files, policyAgentName);
  return { agent_policy_agent_name: policyAgentName, agent_policy_grants: agent ? agentPermissionGate(agent).granted : [] };
}

// `fallbacks` are the router's own ordered, compatible, affordable alternatives, and `trace` is
// the run's correlation context — both are handed to the gateway so a retry or provider fallback
// stays inside this operation's trail instead of appearing as unrelated work.
// `fileUrls` are the run's stored reference-image URLs. They ride along on the same provider call
// as the prompt and are omitted entirely for a text-only run, so nothing about the existing
// prompt composition, model selection, retry or fallback behaviour changes.
// `guard` (optional) is the run's budget guard, consulted immediately before EVERY provider call
// with the same execution chain the gateway will run. Admissions are serialized and each admitted
// call's worst case stays counted as in-flight until it returns, so parallel calls (file
// generation) cannot all pass against the same headroom.
// `recordUsage` (optional) durably adds each successful call's canonical usage to the run's
// AIOperation the moment the model returns, independent of whether the phase later succeeds.
function makeLlm(gateway, model, usage, { fallbacks = null, trace = null, fileUrls = null, guard = null, recordUsage = null, modelAccess = null } = {}) {
  // Without a guard the chain is the unfiltered execution chain (full chain; the gateway drops the primary).
  const baseChain = executionChainIds(model, fallbacks);
  let inFlight = 0;
  let admission = Promise.resolve();
  // The guard recomputes the budget-aware chain for EVERY call and returns it with its worst case.
  const admit = () => {
    const turn = admission.then(async () => { const a = await guard(inFlight); inFlight += a.held; return a; });
    admission = turn.catch(() => {});
    return turn;
  };
  return async (system, messages, jsonSchema, timeoutMs, maxAttempts) => {
    const { chain, held } = guard ? await admit() : { chain: baseChain, held: 0 };
    let res;
    try {
      res = await gateway.generate(model, { system, messages, jsonSchema, timeoutMs, maxAttempts, fallbacks: chain, trace, ...(modelAccess ? { modelAccess } : {}), ...(fileUrls?.length ? { fileUrls } : {}) });
      // Durable first: the call already happened, so its usage is persisted before anything else can
      // fail — and before its in-flight hold is dropped, so the budget guard (which reads persisted
      // usage) never sees the call as neither in flight nor consumed. A write failure is logged only;
      // the in-memory totals remain the settlement fallback.
      if (recordUsage) {
        await recordUsage({
          model_id: res.model_used?.model_id || model?.model_id || model?.id,
          input_tokens: res.inputTokens || 0, output_tokens: res.outputTokens || 0,
          cached_input_tokens: res.usage?.cached_input_tokens || 0, reasoning_tokens: res.usage?.reasoning_tokens || 0,
        }).catch((e) => console.error(`accumulateCallUsage failed for run ${trace?.run_id || ""}: ${e?.message || e}`));
      }
    } finally { inFlight -= held; }
    if (res.fallback_from) usage.fallbacks.push({ from: res.fallback_from, to: res.model_used?.model_id || null });
    usage.input += res.inputTokens; usage.output += res.outputTokens;
    // Cached and reasoning tokens are priced separately by the economics engine, so they are
    // carried through the run rather than folded into the input/output totals.
    usage.cached += res.usage?.cached_input_tokens || 0;
    usage.reasoning += res.usage?.reasoning_tokens || 0;
    // Attributed to the model that actually served the call (after any fallback).
    addModelUsage(usage.by_model, res.model_used?.model_id || model?.model_id || model?.id, res);
    if (res.tokensEstimated) usage.estimated = true;
    return res.output || {};
  };
}

// Tool execution goes through the Tool Router session, which is THE execution boundary: it
// re-checks the run's authorization (project, workspace role, run-mode, tool capability) before
// each call and owns the audit row + correlation span. The run's own tool_log stays authoritative
// and unchanged, so nothing about the run's reported behaviour moves.
function makeTool(session, ctx, usage, toolLog) {
  return async (name, input) => {
    const res = await session.call(name, input, ctx);
    usage.calls++;
    toolLog.push({ tool: name, ok: res.ok, summary: summarizeToolCall(name, input, res) });
    return res;
  };
}

const usageFields = (usage) => ({ input_tokens: usage.input, output_tokens: usage.output, tool_calls: usage.calls });

async function saveStaging(base44, run, staging) {
  return packJson(base44, `run_${run.id}_staging.json`, staging);
}

// Terminal accounting. The run is one billable AIOperation, settled exactly once through the
// economics engine: real accumulated usage → catalog pricing version → credit policy →
// authoritative ledger. Guarded by usage_event_id AND by the operation's own idempotency key,
// so a retried or duplicated worker can never double-charge.
// Whether ANY model call of this run so far used locally estimated counts. The flag is carried
// between phases in staging; a missing flag (legacy staging, or no staging) is treated as
// estimated, so usage is only ever labelled "provider" when every call was provider-measured.
const usageEstimatedSoFar = (staging, usage) => staging?.usage_estimated !== false || !!usage?.estimated;
// Per-model breakdown so far: earlier phases (carried in staging) + this phase's calls.
const usageByModelSoFar = (staging, usage) => mergeUsageByModel(staging?.usage_by_model, usage?.by_model);

async function settle(base44, run, { workspace, model, usage, status, extra, refundReason, usageEstimated = true, usageByModel = null, lease_token = null }) {
  // Settlement is a terminal state mutation too: a worker that lost its phase lease must not
  // be the one to complete or fail the run — this same write clears phase_lease_token, so a
  // zombie settling here would also destroy the winner's lease. No token (recovery paths)
  // keeps the previous behaviour exactly.
  if (lease_token) {
    const fresh = await base44.entities.AIRun.get(run.id);
    if (fresh.phase_lease_token !== lease_token) throw new PhaseLeaseLost(run.id, run.phase || "phase");
  }
  const startedMs = Date.parse(run.started_at || run.created_date);
  const duration = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;
  let usageEventId = run.usage_event_id;
  if (!usageEventId) {
    const settled = await settleUsage(base44, {
      workspace_id: workspace.id, project_id: run.project_id, run_id: run.id, user_id: run.created_by_id,
      operation_type: "ai_run", model,
      // P-16C1 (documented): a Discuss message costs a FIXED 0.3 credits, independently of the
      // model that served it. Build runs keep token-derived pricing (null).
      fixed_credits: run.mode === "discuss" ? 0.3 : null,
      usage: { input_tokens: usage.input, output_tokens: usage.output, cached_input_tokens: usage.cached || 0, reasoning_tokens: usage.reasoning || 0 },
      // The gateway reports no usage block, so counts are locally derived and stay labelled
      // estimated end-to-end rather than being presented as measured provider usage.
      usage_source: usageEstimated ? "estimated" : "provider",
      idempotency_key: `run:${run.id}`,
      usage_by_model: usageByModel,
      routing: run.routing_decision || null,
      status: status === "COMPLETED" ? "completed" : "failed",
      duration_ms: duration, refundReason,
    });
    // Idempotent stamping: the run row's usage_event_id is claimed atomically, so a stale
    // in-memory run.usage_event_id can no longer let two workers create two events.
    const stamped = await stampUsageEvent(base44, {
      run_entity: "AIRun", run_id: run.id,
      operation_id: settled.operation?.id || null, credits_charged: settled.credits_charged || 0,
      event: {
        workspace_id: workspace.id, project_id: run.project_id, run_id: run.id, user_id: run.created_by_id, model: model?.name, provider: model?.provider,
        input_tokens: usage.input, output_tokens: usage.output, tokens_estimated: !!usageEstimated, tool_calls: usage.calls, duration_ms: duration,
        estimated_cost: settled.provider_cost || 0,
      },
    });
    usageEventId = stamped.usage_event_id || usageEventId;
  }
  assertTransition(run.status, status);
  await base44.entities.AIRun.update(run.id, {
    status, phase: "done", ...usageFields(usage), heartbeat_at: new Date().toISOString(),
    // The run is terminal, so its phase lease is released with the same write.
    phase_lease_token: null, phase_lease_expires_at: null,
    completed_at: new Date().toISOString(), duration_ms: duration,
    // Provider fallbacks that actually executed are recorded on the routing decision, so the
    // charge can still be traced to what ran.
    ...(usage.fallbacks?.length ? { routing_decision: { ...(run.routing_decision || {}), fallbacks_used: usage.fallbacks } } : {}),
    ...extra,
  });
  // The episode is sealed on the SAME single terminal path every outcome already goes through, so
  // completion, failure and version-conflict all produce exactly one finalized trajectory.
  await emit(() => finalizeTrajectory(base44, {
    run_id: run.id, status, error: extra?.error || null, duration_ms: duration,
    version_id: extra?.version_id || run.version_id || null, version_number: extra?.version_number ?? run.version_number ?? null,
    build_id: extra?.build_id || run.build_id || null, credits_charged: run.credits_charged ?? null,
    repair_attempts: run.repair_attempts || 0,
  }), "settle");
  return { done: true, status };
}

// Guard-only worst case of one Builder call (input/output as reserved, plus a reasoning allowance
// for reasoning models; the image allowance is added per attached image). Pricing is unaffected.
const GUARD_ESTIMATE = { max_input_tokens: 60000, max_output_tokens: 12000, max_reasoning_tokens: 12000 };

// Runtime budget guard (read-only) for makeLlm: usage so far + calls in flight + the next call's
// worst case across its execution chain must fit in the run's hold + what is still spendable.
// Returns { chain, held }: the call's freshly recomputed budget-aware chain and its worst case
// (kept counted as in-flight until the call returns); otherwise throws BUDGET_EXHAUSTED carrying `stop`, which
// settles exactly the usage the run already has (nothing is committed). Writes nothing itself.
function makeCallGuard(base44, run, { workspace, staging, r, model, fallbacks = null, catalog = null, lease_token = null, modelAccess = null }) {
  const estimate = { ...GUARD_ESTIMATE, image_count: (run.image_urls || []).length };
  const primary = model.model_id || model.id;
  let policy = null;
  return async (inFlight) => {
    // Consulted immediately before EVERY provider call: a zombie worker whose lease was
    // reclaimed must not start new model calls — the source of duplicate provider usage.
    if (lease_token) {
      const fresh = await base44.entities.AIRun.get(run.id);
      if (fresh.phase_lease_token !== lease_token) throw new PhaseLeaseLost(run.id, run.phase || "phase");
    }
    policy = policy || (await loadCreditPolicy(base44, workspace.id));
    // ONE loaded catalog per phase for the guard estimate, the chain filter and the held amount.
    catalog = catalog || (await loadCatalog(base44));
    // The primary is checked first; the rest of the chain is then filtered against the remaining
    // headroom, so every model the gateway may run for this call fits (the chain's max fits too).
    // Every Builder model call (plan rounds, discuss, file generation, repair) passes here; when the
    // call fits capacity but not the current hold, the hold is extended first under a key that is
    // deterministic per phase + repair attempt + target, so a re-driven phase never double-holds.
    const g = await ensureRunBudget(base44, {
      workspace_id: workspace.id, user_id: run.created_by_id, project_id: run.project_id, run_id: run.id,
      idempotency_key: `run:${run.id}`, operation_type: "ai_run",
      usage_by_model: usageByModelSoFar(staging, r.usage),
      usage_totals: { input_tokens: r.usage.input, output_tokens: r.usage.output, cached_input_tokens: r.usage.cached, reasoning_tokens: r.usage.reasoning },
      next_model_ids: [primary], in_flight_credits: inFlight, estimate, catalog,
    }, `${run.phase || "plan"}:r${run.repair_attempts || 0}`);
    if (g.ok) {
      // Unknown capacity (fail-open guard) → unfiltered chain, exactly as the guard behaves.
      const headroom = g.capacity == null ? null : g.capacity - g.consumed - (g.in_flight || 0);
      const filtered = budgetAwareExecutionChain(model, fallbacks, headroom, { estimate, operation_type: "ai_run", policy, catalog, modelAccess });
      const chain = filtered.length ? filtered : [primary];
      const held = chain.reduce((mx, id) => Math.max(mx, worstCaseCallCredits(id, estimate, { operation_type: "ai_run", policy, catalog }) ?? 0), 0);
      return { chain, held };
    }
    const error = `Credit budget exhausted: ${g.consumed} used + ${g.in_flight} in flight + ${g.next} for the next call exceeds ${g.capacity} available`;
    throw Object.assign(new Error(error), {
      code: "BUDGET_EXHAUSTED", retryable: false,
      stop: async () => {
        await r.say(`There are not enough credits left to continue (${run.phase || "plan"}), so the run stopped and no changes were saved to the project.`);
        return settle(base44, run, { workspace, model, usage: r.usage, status: "FAILED", lease_token, usageEstimated: usageEstimatedSoFar(staging, r.usage), usageByModel: usageByModelSoFar(staging, r.usage), extra: { error, phase_error_code: "BUDGET_EXHAUSTED" } });
      },
    });
  };
}

async function loadContext(base44, run) {
  const project = await base44.entities.Project.get(run.project_id);
  const workspace = await base44.entities.Workspace.get(project.workspace_id);
  const staging = run.staging_url ? await unpackJson(run.staging_url) : null;
  return { project, workspace, staging };
}

// --- phases ------------------------------------------------------------------

async function planPhase(base44, run, trace = {}, lease_token = null) {
  const { project, workspace } = await loadContext(base44, run);
  const r = makeRunner(base44, run, { ...trace, workspace_id: workspace.id }, null, lease_token);
  const gateway = gatewayFor(base44);

  let fs, entities, secrets, context, index, mcpConnections = [], mcpDiscovery = { discovered: 0, failures: [], tool_count: 0 };
  let memories = [], hits = [], design = null, designComponents = [], archContext = null;
  await r.step("Reading project context", "CONTEXT_LOADING", async () => {
    const state = await loadProjectState(base44, run.project_id);
    // Account-level MCP connections join the run's tool surface here: the ENABLED ones are
    // loaded and their tools are discovered from the live servers (metadata only — credentials
    // stay server-side). Disabled or deleted connections contribute nothing to the run.
    const prepared = await prepareRunConnections(base44, workspace.id).catch(() => null);
    if (prepared) { mcpConnections = prepared.connections; mcpDiscovery = prepared; }
    fs = createFs(state.files);
    entities = state.entities;
    // Metadata only — loadProjectState never returns secret values.
    secrets = state.secrets;
    index = buildIndex(fs);
    // Project intelligence: durable memory of earlier runs + hybrid (semantic + lexical)
    // retrieval over this project's index, then a budgeted, dependency-expanded context.
    // Both are best-effort: a cold or failed index falls back to keyword selection, so a run
    // never depends on retrieval succeeding.
    memories = await retrieveMemories(base44, run.project_id, run.prompt).catch(() => []);
    hits = await hybridSearch(base44, run.project_id, run.prompt, { limit: 12 }).catch(() => []);
    context = hits.length ? assembleContext(fs, hits) : selectContext(fs, run.prompt);
    // Design intelligence: the project's persistent visual language plus its live component
    // inventory. A project created before the design engine gets the defaults, so no existing
    // project has to be rebuilt to gain one.
    design = await loadDesignSystem(base44, run.project_id);
    designComponents = discoverComponents(fs);
    // Architecture Intelligence: bounded relevant-subgraph context for this run, authorized through
    // the run's own project/user and correlated with the run's trace. Safe-failing by contract — a
    // missing, stale or errored architecture layer yields empty context and the run proceeds unchanged.
    archContext = await retrieveArchitectureForRun(base44, { project, user_id: run.initiated_by_user_id || run.created_by_id, query: run.prompt, trace_id: r.trace.trace_id, run_id: run.id });
    return `${index.length} files indexed, ${hits.length} retrieved, ${context.included.length} included, ${memories.length} memor${memories.length === 1 ? "y" : "ies"}, ${entities.length} entities, ${secrets.length} secret(s)${mcpConnections.length ? `, ${mcpConnections.length} MCP connection(s) offering ${mcpDiscovery.tool_count} tool(s)${mcpDiscovery.discovered ? ` (${mcpDiscovery.discovered} rediscovered)` : ""}${mcpDiscovery.failures.length ? `, ${mcpDiscovery.failures.length} unreachable` : ""}` : ""}${archContext && !archContext.degraded ? `, architecture v${archContext.architecture?.version}` : ""}`;
  });

  // The episode opens here, once the run's real execution context is known. Idempotent by run id,
  // so a re-driven plan phase re-attaches to the SAME trajectory instead of creating a second one.
  const traj = (await emit(() => startTrajectory(base44, {
    run, project, workspace, trace_id: r.trace.trace_id,
    tools: allowedTools(run.mode).map((t) => t.name),
    context: {
      base_version_number: run.base_version_number ?? null, base_version_id: project.current_version_id || null,
      file_count: index.length, entity_count: entities.length, secret_count: secrets.length,
      retrieved: hits.length, included: context.included.length, memories: memories.length,
      mcp_connections: mcpConnections.length, mcp_tools: mcpDiscovery.tool_count || 0,
      design_revision: design?.revision ?? 0, component_count: designComponents.length,
      architecture_version: archContext && !archContext.degraded ? archContext.architecture?.version ?? null : null,
      architecture_nodes: archContext && !archContext.degraded ? (archContext.subgraph?.nodes?.length || 0) : 0,
      file_paths: index.map((f) => f.path || f).slice(0, 200),
    },
  }), "start"))?.trajectory || null;

  // Budget-aware routing: the ceiling is the strictest of the workspace's spendable credits and
  // every applicable user/project/run limit, so an expensive model is refused BEFORE it runs and
  // a compatible cheaper model is chosen where one fits.
  const ceiling = await spendableCredits(base44, { workspace_id: workspace.id, user_id: run.created_by_id, project_id: run.project_id, run_id: run.id }, "message").catch(() => null);
  // P-8.4: plan-based model access resolved BEFORE routing. The router's candidate pool, the
  // reservation's candidate chain and every gateway fallback only ever see models this plan
  // allows — a client's preferred model is honored only within that boundary, and a lapsed
  // subscription or a suspended workspace fails closed before any provider call.
  const modelAccess = await resolveModelAccess(base44, { workspace_id: workspace.id });
  // Learning loop: a project's ACTIVE (promoted, rollback-able) routing policy suggests the model
  // only when the member expressed no preference. It enters as a preference, so plan access, budget
  // and health gates in routeModel still decide; no active project policy changes nothing.
  const memberPref = preferredModelIdFor(run);
  const learned = memberPref ? null : await resolveEffectivePolicy(base44.asServiceRole || base44, { project_id: run.project_id })
    .then((p) => p.resolved_from === "project"
      ? selectModel(base44, { project_id: run.project_id, workspace_id: workspace.id, run_id: run.id, policy: p.policy, budget_credits: ceiling, inputs: { mode: run.mode, prompt: run.prompt, fileCount: index.length } })
      : null)
    .catch(() => null);
  const { model, reason, decision } = routeModel({
    mode: run.mode, prompt: run.prompt, fileCount: index.length,
    budget_credits: ceiling, estimate: { max_input_tokens: 60000, max_output_tokens: 12000, operation_type: "ai_run" },
    prefer_model_id: memberPref || learned?.decision?.selected_model_id || null,
    modelAccess,
  });
  if (learned) decision.learned_policy = { policy_version: learned.decision.policy_version, suggested_model_id: learned.decision.selected_model_id, routing_decision_id: learned.decision_id };
  // Skills fill the (model + skill strategy) slot the router already reserves: selected from this
  // request's mode, prompt, project paths and real signals, and recorded with the decision.
  const skillStrategy = selectSkills({
    mode: run.mode, prompt: run.prompt, phase: "plan", paths: index.map((f) => f.path || f),
    signals: { entities_present: entities.length > 0, mcp_tools_available: (mcpDiscovery.tool_count || 0) > 0 },
  });
  decision.skill_strategy = skillStrategyRecord(skillStrategy);
  // Phase 16A: the workspace's ENABLED skills join the guidance in Build (default) mode only —
  // Discuss-mode behavior is deliberately untouched. A failed or malformed load injects nothing.
  const wsSkillsBlock = run.mode === "default" ? workspaceSkillsBlock(await loadEnabledWorkspaceSkills(base44, workspace.id)) : "";
  // Budget-aware chain for the RESERVATION candidates only (models this run may execute, as of now).
  // Model calls do not reuse it: each call recomputes its chain in the guard. If even the primary
  // does not fit, the candidates are the primary alone, so the existing reservation refusal handles it.
  const policy = await loadCreditPolicy(base44, workspace.id);
  // The SAME loaded catalog is shared by these candidates and this phase's per-call guard.
  const catalog = await loadCatalog(base44);
  const affordable = budgetAwareExecutionChain(model, decision.fallbacks, ceiling, { estimate: { ...GUARD_ESTIMATE, image_count: (run.image_urls || []).length }, operation_type: "ai_run", policy, catalog, modelAccess });
  const runChain = affordable.length ? affordable : [model.model_id];
  await r.patch({ model: model.name, provider: model.provider, routing_decision: decision });
  if (traj) await emit(() => recordModelSelection(base44, traj, { model_id: model.model_id || model.name, provider: model.provider, reason, routing_decision: decision }), "model");

  // Reservation BEFORE the first provider call. The worst-case charge is held on the ledger, so
  // concurrent runs compete for the same pool up front instead of discovering the shortfall
  // after both already ran, and an unaffordable run is refused here rather than mid-flight.
  // Keyed by the run, so a re-driven plan phase re-attaches to the SAME operation instead of
  // reserving twice — and that one operation is what `settle` later charges real usage to and
  // releases, in every terminal path (success, failure, cancellation, version conflict).
  const { operation } = await beginOperation(base44, {
    workspace_id: workspace.id, user_id: run.created_by_id, project_id: run.project_id, run_id: run.id,
    operation_type: "ai_run", model_id: model.model_id, gateway_provider: model.provider,
    idempotency_key: `run:${run.id}`, routing: decision,
    estimate: { max_input_tokens: 60000, max_output_tokens: 12000 },
    // The hold covers every model the gateway may execute for this run (budget-aware chain).
    candidate_model_ids: runChain,
  });
  await r.patch({ operation_id: operation.id });

  const llmTrace = { ...r.trace, parent_span_id: r.trace.span_id || null, project_id: project.id, workspace_id: workspace.id };
  const llm = makeLlm(gateway, model, r.usage, { fallbacks: decision.fallbacks || null, trace: llmTrace, fileUrls: run.image_urls || null, guard: makeCallGuard(base44, run, { workspace, staging: null, r, model, fallbacks: decision.fallbacks || null, catalog, lease_token, modelAccess }), recordUsage: (u) => accumulateCallUsage(base44, operation.id, u), modelAccess });
  // MCP invocation runs through the existing tool-execution layer: same tool log, same
  // usage accounting, same phase budget. It never mutates project state.
  const policyAgentName = await activePolicyAgentName(base44, run);
  // Agents with a LIVE run in this project: their policy files are immutable for every run,
  // including human-initiated Builder runs (edit_project over MCP or the Builder UI).
  const activeAgents = await activeAgentNames(base44, project.id);
  const ctx = {
    fs, entities, secrets, deletes: 0,
    ...(delegatedPolicyContext(policyAgentName, activeFiles(fs))),
    ...(activeAgents.length ? { agent_policy_active_names: activeAgents } : {}),
    mcp: {
      connections: mcpConnections,
      // The run's trace — and the span of the tool that triggered this call — travel with the
      // invocation, so an external MCP failure stays attributable to this operation.
      call: (a) => invokeMcpTool(base44, {
        workspace_id: workspace.id, project_id: project.id, run_id: run.id, user_id: run.initiated_by_user_id ?? run.created_by_id,
        mode: run.mode, trigger: "builder_run",
        trace_id: r.trace.trace_id || null, parent_span_id: ctx.trace?.parent_span_id || r.trace.span_id || null,
      }, a),
    },
  };
  const session = await createRunToolSession(base44, { run, project, workspace, mode: run.mode, trace: r.trace });
  const tool = makeTool(session, ctx, r.usage, r.toolLog);

  // The attached images are delivered to the model as real image input by the gateway; this block
  // is what states they are the authoritative design source and what to read out of them. Empty
  // string for a text-only run, so the prompt is byte-identical to before.
  const visualRef = visualReferenceBlock((run.image_urls || []).length);
  const intelligence = [memoryBlock(memories), retrievalBlock(hits), visualRef, architectureContextBlock(archContext), skillGuidanceBlock(skillStrategy, "planner", { mode: run.mode }), wsSkillsBlock].filter(Boolean).join("\n\n");
  // Phase 2: an imported design system (DesignSystem row owned by this project, referenced by
  // design_system_id) rides the SAME design slot as a static preset — NEW Build output only,
  // never a rewrite of existing files (the block itself states and enforces that).
  const importedDesign = await loadImportedDesignRow(base44, project);
  const designPrompt = `${designBlock({ tokens: design.tokens, components: designComponents, revision: design.revision })}${designSystemLibraryBlock(project.design_system_id)}${importedDesignSystemBlock(importedDesign)}${designRestyleBlock(await designRestylePending(base44, run, project))}`;
  const messages = [{ role: "user", content: `${buildContextBlock({ index, entities, included: context.included, omitted: context.omitted, functions: describeFunctions(fs), secrets, integrations: integrationsView(ctx), mcp: mcpConnections, design: designPrompt })}${intelligence ? `\n\n${intelligence}` : ""}\n\nUSER REQUEST:\n${run.prompt}` }];
  const readMore = async (reads) => {
    for (const a of reads) {
      const res = await tool(a.tool, a.input);
      messages.push({ role: "user", content: `TOOL RESULT ${a.tool} ${JSON.stringify(a.input || {})}:\n${res.ok ? JSON.stringify(res.result).slice(0, 20000) : "ERROR: " + res.error}` });
    }
  };

  // Discuss mode is a read-only question-answering path with its own answer-oriented
  // contract: it never touches the planner schema, so it cannot emit a mutation plan,
  // and it terminates here without a build, a commit or a version.
  if (run.mode === "discuss") {
    let out;
    await r.step("Answering", "PLANNING", async () => {
      for (let round = 0; round <= MAX_CONTEXT_ROUNDS; round++) {
        r.checkBudget("answering");
        // Custom Instructions (documented Base44: applies to EVERY interaction in this app):
        // the app-level guidance also rides the Discuss answer prompt, appended with the same
        // shared composition — guidance only, the read-only Discuss contract is unchanged.
        out = await llm(withCustomInstructions(buildAnswerPrompt(), project.custom_instructions), messages, ANSWER_SCHEMA, 80000);
        const reads = Array.isArray(out.read_actions) ? out.read_actions : [];
        if (!(out.request_more_context && reads.length && round < MAX_CONTEXT_ROUNDS)) break;
        await readMore(reads);
        messages.push({ role: "user", content: "Context provided above. Now answer the question directly, with no plan and no steps (request_more_context=false)." });
      }
      return `${model.name} (${reason}) · answered from ${(out.context_used || []).length || context.included.length} artifact(s)`;
    });
    await r.say((out.answer || "").trim() || "I could not determine that from this project's current state.");
    await r.patch({ tool_log: r.toolLog.slice(-100), steps: [...r.steps] });
    // Discuss settles inside its first phase; counts carried in from an earlier attempt of this
    // phase have no per-call source, so they keep the run labelled estimated.
    return settle(base44, run, { workspace, model, usage: r.usage, status: "COMPLETED", extra: {}, lease_token, usageEstimated: r.usage.estimated || !!run.input_tokens, usageByModel: usageByModelSoFar(null, r.usage) });
  }

  let plan;
  await r.step("Planning", "PLANNING", async () => {
    for (let round = 0; round <= MAX_CONTEXT_ROUNDS; round++) {
      r.checkBudget("planning");
      // Planning is the heaviest LLM call in the pipeline (full context + structured output).
      // 45s per model (primary, then first fallback), 90s total — see PLANNING_CALL.
      // Custom Instructions (documented Base44: applies to EVERY interaction in this app): the
      // project's app-level guidance is appended to the planner system prompt on every Build
      // turn, through the ONE shared composition (byte-identical to the previous inline form).
      // Empty → no injection. Agent runs receive the guidance on their own decision loop
      // (agentLoop.systemPrompt) and on every delegated Build run through this same path.
      const plannerSystem = run.mode === "default"
        ? withCustomInstructions(buildPlannerPrompt(run.mode), project.custom_instructions)
        : buildPlannerPrompt(run.mode);
      plan = normalizePlanOutput(await llm(`${plannerSystem}\n\n${PLANNER_JSON_ONLY}`, messages, PLAN_SCHEMA, PLANNING_CALL.timeoutMs, PLANNING_CALL.maxAttempts));
      plan.files = Array.isArray(plan.files) ? plan.files : [];
      normalizePlanFileExports(plan.files);
      plan.entities = Array.isArray(plan.entities) ? plan.entities : [];
      plan.secrets = Array.isArray(plan.secrets) ? plan.secrets : [];
      plan.integrations = Array.isArray(plan.integrations) ? plan.integrations : [];
      plan.plan = Array.isArray(plan.plan) ? plan.plan : [];
      const reads = Array.isArray(plan.read_actions) ? plan.read_actions : [];
      if (!(plan.request_more_context && reads.length && round < MAX_CONTEXT_ROUNDS)) break;
      await readMore(reads);
      messages.push({ role: "user", content: "Context provided above. Now return the final plan, entities and file manifest (request_more_context=false)." });
    }
    return `${model.name} (${reason}) · ${plan.files.length} file(s), ${plan.entities.length} entit${plan.entities.length === 1 ? "y" : "ies"}${plan.integrations.length ? `, ${plan.integrations.length} integration(s)` : ""}`;
  });

  // Integration definitions are declared structurally (plan.integrations), never generated as
  // files; styles.css is emitted from the design tokens, so the model may not hand-write it.
  const manifest = finalizePlanManifest(plan, run.mode);

  if (manifest.empty) {
    await assertPhaseLease(base44, run, lease_token, "plan");
    await r.say("The planner returned an empty plan (no files or entities to change), so no changes were made to the project. Please rephrase the request with the specific change you want.");
    return settle(base44, run, { workspace, model, usage: r.usage, status: "FAILED", lease_token, usageEstimated: r.usage.estimated || !!run.input_tokens, usageByModel: usageByModelSoFar(null, r.usage), extra: { error: "Planner returned an empty plan; no changes were made", phase_error_code: "PLAN_EMPTY" } });
  }

  if (traj) {
    await emit(() => recordPlan(base44, traj, plan), "plan");
    await emit(() => recordToolCalls(base44, traj, { phase: "plan", calls: r.toolLog }), "plan_tools");
    if (r.usage.fallbacks.length) await emit(() => recordFallbacks(base44, traj, r.usage.fallbacks), "plan_fallbacks");
  }

  // A worker that lost its lease writes neither staging nor AIRun usage (its calls are already on the operation).
  await assertPhaseLease(base44, run, lease_token, "plan");
  const staging_url = await saveStaging(base44, run, { fs: serializeFs(fs), entities, secrets, plan, model, fallbacks: decision.fallbacks || [], failures: [], plan_truncated_paths: manifest.truncated, design, designComponents, skill_strategy: skillStrategyRecord(skillStrategy), usage_estimated: r.usage.estimated || !!run.input_tokens, usage_by_model: usageByModelSoFar(null, r.usage), usage_cached_input_tokens: r.usage.cached, usage_reasoning_tokens: r.usage.reasoning });
  await r.patch({ plan: plan.plan, phase: "generate", status: "EXECUTING", staging_url, tool_log: r.toolLog.slice(-100), ...usageFields(r.usage) });
  return { done: false, status: "EXECUTING", phase: "generate", project_id: project.id };
}

async function generatePhase(base44, run, trace = {}, lease_token = null) {
  const { project, workspace, staging } = await loadContext(base44, run);
  const r = makeRunner(base44, run, { ...trace, workspace_id: workspace.id }, staging, lease_token);
  const gateway = gatewayFor(base44);
  // P-8.4: plan access re-resolved per phase; the guard's chain and the gateway's fallbacks only
  // ever see models the CURRENT plan allows — a mid-run plan change fails closed, not silently.
  const modelAccess = await resolveModelAccess(base44, { workspace_id: workspace.id });
  const model = staging.model;
  const plan = staging.plan;
  const fs = deserializeFs(staging.fs);
  const entities = staging.entities;
  const secrets = staging.secrets || [];
  const policyAgentName = await activePolicyAgentName(base44, run);
  const activeAgents = await activeAgentNames(base44, project.id);
  const ctx = { fs, entities, secrets, deletes: 0, ...(delegatedPolicyContext(policyAgentName, activeFiles(fs))), ...(activeAgents.length ? { agent_policy_active_names: activeAgents } : {}) };
  const session = await createRunToolSession(base44, { run, project, workspace, mode: run.mode, trace: r.trace });
  const tool = makeTool(session, ctx, r.usage, r.toolLog);
  const llm = makeLlm(gateway, model, r.usage, { fallbacks: staging.fallbacks || null, trace: { ...r.trace, parent_span_id: r.trace.span_id || null, project_id: project.id, workspace_id: workspace.id }, fileUrls: run.image_urls || null, guard: makeCallGuard(base44, run, { workspace, staging, r, model, fallbacks: staging.fallbacks || null, lease_token, modelAccess }), recordUsage: run.operation_id ? (u) => accumulateCallUsage(base44, run.operation_id, u) : null, modelAccess });
  const failures = [];
  // Structured, durable copy of each generate-phase failure (diagnostics only).
  const genDiag = [];
  const note = (stage, path, operation, error) => genDiag.push(failureRecord(stage, path, operation, error));
  const design = staging.design || { id: null, tokens: {}, components: [], revision: 0, exists: false };

  // Design tokens are mutated BEFORE any file is written, so every generated file in this run
  // is authored against the design system it will actually ship with. styles.css is then
  // emitted from the tokens — deterministically, never by the model.
  await r.step("Applying design system", "EXECUTING", async () => {
    const patch = staging.plan.design || null;
    const patchObj = designPatchToObject(patch);
    const merged = mergeTokens(design.tokens, patchObj);
    design.tokens = merged.tokens;
    for (const bad of merged.rejected) { failures.push(`design ${bad.path}: ${bad.reason}`); note("design", bad.path, "token", bad.reason); }
    let stylesheet = null;
    try { stylesheet = readFile(fs, "styles.css"); } catch { /* not emitted yet */ }
    const css = tokensToCss(design.tokens);
    if (stylesheet !== css) { const res = await tool("write_file", { path: "styles.css", content: css }); if (!res.ok) { failures.push(`styles.css: ${res.error}`); note("design", "styles.css", "write_file", res.error); } }
    design.changed = merged.changed || stylesheet !== css;
    return patch
      ? `${merged.applied.length} token(s) changed${merged.rejected.length ? `, ${merged.rejected.length} rejected` : ""}${patch?.rationale ? ` · ${patch.rationale}` : ""}`
      : design.changed ? "stylesheet re-emitted from existing tokens" : "unchanged";
  });

  // Entities are declared through the SAME create_entity/update_entity tools the model uses, so
  // there is exactly one entity write path: the tool validates the fields, updates the AppEntity
  // runtime projection in ctx.entities, and — only for a project carrying base44/config.jsonc —
  // emits the canonical base44/entities/<Name>.jsonc declaration from those same normalized fields.
  // A legacy project (no manifest) gets no entity file. The pipeline adds no serialization of its own.
  await r.step("Declaring entities", "EXECUTING", async () => {
    for (const e of plan.entities) {
      const exists = entities.some((x) => x.name === e.name);
      const res = await tool(exists ? "update_entity" : "create_entity", { name: e.name, fields: e.fields });
      if (!res.ok) { failures.push(`entity ${e.name}: ${res.error}`); note("tool", e.name, exists ? "update_entity" : "create_entity", res.error); }
    }
    return `${plan.entities.length} declared`;
  });

  if ((plan.secrets || []).length) {
    await r.step("Declaring required secrets", "EXECUTING", async () => {
      for (const s of plan.secrets) {
        const res = await tool("declare_secret", { name: s.name, description: s.description, required: s.required });
        if (!res.ok) { failures.push(`secret ${s.name}: ${res.error}`); note("tool", s.name, "declare_secret", res.error); }
      }
      return plan.secrets.map((s) => s.name).join(", ");
    });
  }

  // Integrations are configured through the integration tools (validated definitions), so a
  // malformed definition is a run failure here rather than an opaque runtime error later.
  if ((plan.integrations || []).length) {
    await r.step("Configuring integrations", "EXECUTING", async () => {
      const summaries = [];
      for (const i of plan.integrations) {
        const exists = integrationsView(ctx).some((x) => x.name === i.name);
        const res = i.openapi_url
          ? await tool("import_openapi", { name: i.name, url: i.openapi_url, description: i.description, base_url: i.base_url || undefined, secret: i.auth?.secret || undefined })
          : await tool(exists ? "update_integration" : "create_integration", i);
        if (!res.ok) { failures.push(`integration ${i.name}: ${res.error}`); note("tool", i.name, "integration", res.error); }
        else summaries.push(`${i.name}${res.result?.imported != null ? ` (${res.result.imported} imported)` : ""}`);
      }
      return summaries.join(", ") || "none";
    });
  }

  const manifest = plan.files;
  // Every generator call receives the same design contract, which is what keeps a multi-file
  // run visually consistent instead of styling each page independently.
  const designPrompt = `${designBlock({ tokens: design.tokens, components: staging.designComponents || [], revision: design.revision })}${designSystemLibraryBlock(project.design_system_id)}${importedDesignSystemBlock(await loadImportedDesignRow(base44, project))}${designRestyleBlock(await designRestylePending(base44, run, project))}`;
  // Generator-phase guidance from the SAME strategy the plan phase selected and recorded.
  const skillPrompt = skillGuidanceBlock(staging.skill_strategy || null, "generator", { mode: run.mode });
  // Phase 16A: workspace skills ride the SAME generator guidance slot, Build (default) mode only.
  const wsSkillPrompt = run.mode === "default" ? workspaceSkillsBlock(await loadEnabledWorkspaceSkills(base44, workspace.id)) : "";
  // Every generated file is authored against the same visual reference the plan was made from.
  const visualPrompt = visualReferenceBlock((run.image_urls || []).length);
  const existingPaths = activeFiles(fs).map((f) => f.path).filter((p) => !manifest.some((m) => m.path === p));
  const entityDefs = () => entities.map((e) => ({ name: e.name, fields: e.fields }));
  const generateOne = async (spec) => {
    if (spec.action === "delete") { const d = await tool("delete_file", { path: spec.path }); if (!d.ok) { failures.push(`delete ${spec.path}: ${d.error}`); note("tool", spec.path, "delete_file", d.error); } return; }
    // A rename/relocation keeps the project wired (imports + server.<fn> call sites are
    // rewritten by the tool), so it is one operation rather than create + delete.
    if (spec.action === "move") {
      const m = await tool("move_file", { from: spec.path, to: spec.to });
      if (!m.ok) { failures.push(`move ${spec.path} -> ${spec.to}: ${m.error}`); note("tool", spec.path, "move_file", m.error); }
      return;
    }
    let current = null;
    try { current = readFile(fs, spec.path); } catch { /* new file */ }
    if (spec.action === "patch" && current == null) spec.action = "create";
    if (spec.action === "create" && current != null) spec.action = "rewrite";
    const task = `${fileTaskBlock({ plan: plan.plan, entities: entityDefs(), manifest, existingPaths, spec, current: spec.action === "create" ? null : current, functions: describeFunctions(fs), secrets: secretsView(ctx), integrations: integrationsView(ctx), design: designPrompt })}${visualPrompt ? `\n\n${visualPrompt}` : ""}${skillPrompt ? `\n\n${skillPrompt}` : ""}${wsSkillPrompt ? `\n\n${wsSkillPrompt}` : ""}`;
    if (spec.action === "patch") {
      let out;
      try { out = normalizePatchOutput(await llm(buildPatcherPrompt(), [{ role: "user", content: task }], PATCH_SCHEMA, 60000)); }
      catch (e) { if (!String(e.code || "").startsWith("PATCH_OUTPUT")) throw e; failures.push(`patch ${spec.path}: ${e.message}`); note("model_output", spec.path, spec.action, e); return; }
      for (const p of out.patches) { const res = await tool("patch_file", { path: spec.path, find: p.find, replace: p.replace }); if (!res.ok) { failures.push(`patch ${spec.path}: ${res.error}`); note("tool", spec.path, "patch_file", res.error); } }
    } else {
      let out;
      try { out = normalizeFileOutput(await llm(buildGeneratorPrompt(), [{ role: "user", content: task }], FILE_SCHEMA, 75000)); }
      catch (e) { if (!String(e.code || "").startsWith("FILE_OUTPUT")) throw e; failures.push(`generate ${spec.path}: ${e.message}`); note("model_output", spec.path, spec.action, e); return; }
      const res = await tool("write_file", { path: spec.path, content: out.content });
      if (!res.ok) { failures.push(`write ${spec.path}: ${res.error}`); note("tool", spec.path, "write_file", res.error); }
    }
  };

  await r.step(`Writing ${manifest.length} file(s)`, "EXECUTING", async () => {
    // Structural operations (move/delete) run FIRST and sequentially: they rewrite other
    // files' imports, so they must not race the parallel content generation below.
    for (const spec of manifest.filter((f) => f.action === "move" || f.action === "delete")) await generateOne(spec).catch((e) => { failures.push(e.message); note("model_call", spec.path, spec.action, e); });
    const contentSpecs = manifest.filter((f) => f.action !== "move" && f.action !== "delete");
    const results = await Promise.allSettled(contentSpecs.map(generateOne));
    // A refused file call stops the run instead of becoming an ordinary per-file failure.
    const exhausted = results.find((x) => x.status === "rejected" && x.reason?.code === "BUDGET_EXHAUSTED");
    if (exhausted) throw exhausted.reason;
    // A lease-lost rejection (the call guard blocked a zombie worker's provider call) aborts
    // the phase instead of being recorded as an ordinary per-file failure.
    const lostLease = results.find((x) => x.status === "rejected" && x.reason?.code === "PHASE_LEASE_LOST");
    if (lostLease) throw lostLease.reason;
    results.forEach((res, i) => { if (res.status === "rejected") { failures.push(res.reason?.message || String(res.reason)); note("model_call", contentSpecs[i].path, contentSpecs[i].action, res.reason); } });
    return `${computeChanges(fs).length} change(s)${failures.length ? `, ${failures.length} failure(s)` : ""}${genDiag.length ? ` · ${failureDetail(genDiag)}` : ""}`;
  });

  const generateTraj = await trajectoryForRun(base44, run.id).catch(() => null);
  if (generateTraj) {
    await emit(() => recordToolCalls(base44, generateTraj, { phase: "generate", calls: r.toolLog }), "generate_tools");
    if (r.usage.fallbacks.length) await emit(() => recordFallbacks(base44, generateTraj, r.usage.fallbacks), "generate_fallbacks");
  }

  await assertPhaseLease(base44, run, lease_token, "generate");
  const staging_url = await saveStaging(base44, run, { ...staging, fs: serializeFs(fs), entities, secrets, failures, generation_failures: genDiag, design, usage_estimated: usageEstimatedSoFar(staging, r.usage), usage_by_model: usageByModelSoFar(staging, r.usage), usage_cached_input_tokens: r.usage.cached, usage_reasoning_tokens: r.usage.reasoning });
  await r.patch({ phase: "build", status: "VALIDATING", staging_url, tool_log: r.toolLog.slice(-100), ...usageFields(r.usage) });
  return { done: false, status: "VALIDATING", phase: "build" };
}

// Builds, and on failure performs ONE repair attempt per invocation. The run stays in the
// build phase until it succeeds or the existing repair budget is exhausted, so each attempt
// gets a fresh request window instead of competing for one.
async function buildPhase(base44, run, trace = {}, lease_token = null) {
  const { project, workspace, staging } = await loadContext(base44, run);
  const r = makeRunner(base44, run, { ...trace, workspace_id: workspace.id }, staging, lease_token);
  const gateway = gatewayFor(base44);
  // P-8.4: plan access re-resolved per phase; the guard's chain and the gateway's fallbacks only
  // ever see models the CURRENT plan allows — a mid-run plan change fails closed, not silently.
  const modelAccess = await resolveModelAccess(base44, { workspace_id: workspace.id });
  const model = staging.model;
  const fs = deserializeFs(staging.fs);
  const entities = staging.entities;
  const secrets = staging.secrets || [];
  // Generation failures are never overwritten; repair state is tracked beside them.
  const failures = staging.failures || [];
  let repairLines = staging.repair_failure_lines || [];
  const repairedTargets = new Set(staging.repaired_targets || []);
  let repaired = !!staging.repaired;
  // Original generate-phase failures are kept as-is; repair failures are recorded separately.
  const genDiag = staging.generation_failures || [];
  let repairDiag = staging.repair_failures || [];
  const policyAgentName = await activePolicyAgentName(base44, run);
  const activeAgents = await activeAgentNames(base44, project.id);
  const ctx = { fs, entities, secrets, deletes: 0, ...(delegatedPolicyContext(policyAgentName, activeFiles(fs))), ...(activeAgents.length ? { agent_policy_active_names: activeAgents } : {}) };
  const session = await createRunToolSession(base44, { run, project, workspace, mode: run.mode, trace: r.trace });
  const tool = makeTool(session, ctx, r.usage, r.toolLog);
  const llm = makeLlm(gateway, model, r.usage, { fallbacks: staging.fallbacks || null, trace: { ...r.trace, parent_span_id: r.trace.span_id || null, project_id: project.id, workspace_id: workspace.id }, fileUrls: run.image_urls || null, guard: makeCallGuard(base44, run, { workspace, staging, r, model, fallbacks: staging.fallbacks || null, lease_token, modelAccess }), recordUsage: run.operation_id ? (u) => accumulateCallUsage(base44, run.operation_id, u) : null, modelAccess });
  const entityDefs = () => entities.map((e) => ({ name: e.name, fields: e.fields }));

  let build;
  let verification = null;
  // Static build + REAL runtime verification. A project that compiles but crashes on startup,
  // on a route, in a backend function or against the database is a failed build here, so the
  // existing repair loop sees runtime defects exactly like syntax errors and nothing is
  // committed until the app actually runs.
  const doBuild = async () => {
    build = runBuild(fs, entities, secrets);
    const gate = buildGateFailures({ generationLines: failures, generationRecords: genDiag, repairLines, repairedTargets: [...repairedTargets], repaired });
    if (gate.length) { build.status = "failed"; build.errors += gate.length; build.logs = [...gate.map((f) => `error: ${f}`), ...build.logs]; }
    const excluded = gateExcludedFailures(genDiag, repaired);
    build.diagnostics = { generation_failures: genDiag, repair_failures: repairDiag, ...(excluded.length ? { gate_excluded: excluded } : {}) };
    build.logs = [...build.logs, ...diagnosticLogLines({ generation: genDiag, repair: repairDiag }), ...excluded.map((f) => `diag gate-excluded (rejected design token, not repairable): ${describeFailure(f)}`)];
    // Design + accessibility enforcement, scoped to the frontend files this run touched: a
    // legacy project is never blocked by pre-existing violations, and new code cannot ship
    // hardcoded styling or inaccessible markup. Diagnostics flow into the same repair loop.
    if (build.status === "success") {
      const touched = computeChanges(fs).filter((c) => c.change !== "deleted").map((c) => c.path);
      const lint = lintDesign(fs, { paths: touched });
      build.design = { ok: lint.ok, violations: lint.violations.length };
      if (!lint.ok) {
        build.status = "failed";
        build.errors += lint.violations.length;
        build.logs = [...build.logs, ...lint.diagnostics.map((d) => `error: ${d}`)];
      }
    }
    if (build.status !== "success") return;
    // The verifier executes REAL generated backend functions; the run's trace and id go with
    // them, so their FunctionInvocation rows land inside this operation's trail.
    verification = await verifyProjectRuntime(base44, { project, fs, entities, secrets, trace_id: r.trace.trace_id || null, run_id: run.id }).catch((e) => ({
      ok: false, category: "RUNTIME_ERROR", diagnostics: [`RUNTIME_ERROR verifier: ${e.message}`], checks: [],
    }));
    build.verification = { ok: verification.ok, category: verification.category, checks: verification.checks };
    if (!verification.ok) {
      build.status = "failed";
      build.errors += verification.diagnostics.length;
      build.logs = [...build.logs, ...verification.diagnostics.map((d) => `error: ${d}`)];
    } else {
      build.logs = [...build.logs, `[runtime] ${verification.checks.length} runtime check(s) passed in ${verification.duration_ms}ms`];
    }
  };
  const attempted = run.repair_attempts || 0;
  const buildTraj = await trajectoryForRun(base44, run.id).catch(() => null);
  // Build + runtime outcomes are emitted as REFERENCES to the records this phase already writes,
  // once per attempt. The idempotency key carries the attempt number, so a re-driven build phase
  // resolves the existing event instead of appending a duplicate.
  const emitBuildOutcome = async (attempt) => {
    if (!buildTraj || !build) return;
    await emit(() => recordBuildResult(base44, buildTraj, { status: build.status, errors: build.errors, file_count: build.file_count, duration_ms: build.duration_ms, design: build.design || null, attempt }), "build");
    if (verification) await emit(() => recordRuntimeResult(base44, buildTraj, { ok: verification.ok, category: verification.category || null, checks: verification.checks || [], diagnostics: (verification.diagnostics || []).length, attempt }), "runtime");
  };

  await r.step(attempted ? `Rebuilding (after repair ${attempted})` : "Building, checking design and verifying runtime", "VALIDATING", async () => {
    await doBuild();
    if (build.status !== "success") throw new Error(`${build.errors} error(s)`);
    return `${build.file_count} files in ${build.duration_ms}ms · runtime verified`;
  }).catch(() => {});
  await emitBuildOutcome(attempted + 1);

  if (build.status !== "success" && attempted < MAX_REPAIR_ATTEMPTS) {
    const attempt = attempted + 1;
    const repairTools = allowedTools(run.mode).filter((t) => t.permission !== "read");
    await r.step(`Repairing build (attempt ${attempt}/${MAX_REPAIR_ATTEMPTS})`, "REPAIRING", async () => {
      const involved = new Set(computeChanges(fs).filter((c) => c.change !== "deleted").map((c) => c.path));
      for (const line of build.logs) { const m = line.match(/((?:src|functions|integrations)\/[^\s:'"]+\.(?:js|json)|styles\.css)/); if (m) involved.add(m[1]); }
      const filesInvolved = [...involved].map((p) => { try { return { path: p, content: readFile(fs, p) }; } catch { return null; } }).filter(Boolean);
      const integrationsSummary = integrationsView(ctx).map((i) => `${i.name}${i.error ? " (INVALID: " + i.error + ")" : ` → ${i.base_url} · ops: ${i.operations.map((o) => o.name).join(", ") || "none"}`}`).join("\n") || "none";
      // Repair guidance: the repair-phase skill plus whatever the run's recorded strategy carries
      // for repair, resolved from the files the failing build actually names.
      const repairPhase = selectSkills({ mode: run.mode, prompt: run.prompt, phase: "repair", paths: [...involved], signals: { entities_present: entities.length > 0 } });
      const repairSkills = skillGuidanceBlock({
        source: "skill_catalog",
        skills: [...(staging.skill_strategy?.skills || []), ...repairPhase.skills].filter((s, i, a) => a.findIndex((x) => x.skill_id === s.skill_id && x.version === s.version) === i),
      }, "repair", { mode: run.mode });
      // Phase 16A: workspace skills join repair guidance too, Build (default) mode only.
      const wsRepairBlock = run.mode === "default" ? workspaceSkillsBlock(await loadEnabledWorkspaceSkills(base44, workspace.id)) : "";
      const out = await llm(`${buildSystemPrompt(run.mode, repairTools)}${repairSkills ? `\n\n${repairSkills}` : ""}${wsRepairBlock ? `\n\n${wsRepairBlock}` : ""}`, [
        { role: "user", content: `ENTITIES:\n${JSON.stringify(entityDefs())}\n\nDECLARED SECRETS (names only): ${secretsView(ctx).map((s) => s.name).join(", ") || "none"}\n\nINTEGRATIONS:\n${integrationsSummary}\n\nALL FILES: ${activeFiles(fs).map((f) => f.path).join(", ")}\n\n${buildRepairPrompt(build.logs.filter((l) => l.startsWith("error")), filesInvolved)}` },
      ], RESPONSE_SCHEMA, 75000);
      repairLines = [];
      repaired = true;
      for (const a of out.actions || []) { const res = await tool(a.tool, a.input); if (res.ok && (a.input?.path || a.input?.name)) repairedTargets.add(a.input.path || a.input.name); if (!res.ok) { repairLines.push(`tool ${a.tool}(${a.input?.path || a.input?.name || ""}) failed: ${res.error}`); repairDiag = [...repairDiag, { ...failureRecord("repair", a.input?.path || a.input?.name, a.tool, res.error), attempt }]; } }
      await doBuild();
      if (build.status !== "success") throw new Error(`${build.errors} error(s) remain`);
      return "build succeeded";
    // The repair call's budget refusal stops the run; any other repair failure is handled as before.
    }).catch((e) => { if (e?.code === "BUDGET_EXHAUSTED") throw e; });
    if (buildTraj) {
      await emit(() => recordRepairAttempt(base44, buildTraj, { attempt, resolved: build.status === "success", error_codes: build.logs.filter((l) => l.startsWith("error")).slice(0, 10) }), "repair");
      await emit(() => recordToolCalls(base44, buildTraj, { phase: "repair", calls: r.toolLog }), "repair_tools");
      await emitBuildOutcome(attempt + 1);
    }
    await assertPhaseLease(base44, run, lease_token, "build");
    const staging_url = await saveStaging(base44, run, { ...staging, fs: serializeFs(fs), entities, secrets, failures, repair_failures: repairDiag, repair_failure_lines: repairLines, repaired_targets: [...repairedTargets], repaired, build, usage_estimated: usageEstimatedSoFar(staging, r.usage), usage_by_model: usageByModelSoFar(staging, r.usage), usage_cached_input_tokens: r.usage.cached, usage_reasoning_tokens: r.usage.reasoning });
    await r.patch({ repair_attempts: attempt, staging_url, tool_log: r.toolLog.slice(-100), ...usageFields(r.usage) });
    if (build.status !== "success") return { done: false, status: run.status, phase: "build" };
  }

  if (build.status !== "success") {
    await assertPhaseLease(base44, run, lease_token, "build");
    // Atomic failure: nothing was persisted to the project.
    const buildRec = await recordBuild(base44, run.project_id, run.id, build);
    await (base44.asServiceRole || base44).entities.Project.update(run.project_id, { last_build_status: "failed", status: "error" });
    const errText = build.logs.filter((l) => l.startsWith("error")).slice(0, 12).join("\n");
    await r.say(`${staging.plan?.message || ""}\n\nThe build failed after ${run.repair_attempts || 0} repair attempt(s), so no changes were saved to the project.\n\n\`\`\`\n${errText}\n\`\`\``);
    return settle(base44, run, { workspace, model, usage: r.usage, status: "FAILED", lease_token, usageEstimated: usageEstimatedSoFar(staging, r.usage), usageByModel: usageByModelSoFar(staging, r.usage), extra: { build_id: buildRec.id, error: `Build failed after ${MAX_REPAIR_ATTEMPTS} repair attempts` } });
  }

  // A passing build (including after repair) cannot complete the run if planned file changes
  // never landed: that would report success for work that was not done.
  const unapplied = unappliedPlannedPaths(staging.plan?.files || [], computeChanges(fs));
  if (unapplied.length) {
    await assertPhaseLease(base44, run, lease_token, "build");
    const reasons = unapplied.map((p) => { const f = genDiag.find((d) => d.path === p); return `${p}${f ? ` (${f.stage}: ${f.message})` : " (no change produced)"}`; });
    build = { ...build, status: "failed", logs: [...(build.logs || []), ...reasons.map((x) => `error: planned change not applied: ${x}`)] };
    const buildRec = await recordBuild(base44, run.project_id, run.id, build);
    await r.say(`The build passed, but ${unapplied.length} planned file change(s) were never applied, so nothing was saved:\n${reasons.map((x) => `- ${x}`).join("\n")}`);
    return settle(base44, run, { workspace, model, usage: r.usage, status: "FAILED", lease_token, usageEstimated: usageEstimatedSoFar(staging, r.usage), usageByModel: usageByModelSoFar(staging, r.usage), extra: { build_id: buildRec.id, error: `Planned changes not applied: ${unapplied.join(", ")}`, phase_error_code: "PLANNED_CHANGES_NOT_APPLIED" } });
  }

  await assertPhaseLease(base44, run, lease_token, "build");
  const staging_url = await saveStaging(base44, run, { ...staging, fs: serializeFs(fs), entities, secrets, failures, repair_failures: repairDiag, repair_failure_lines: repairLines, repaired_targets: [...repairedTargets], repaired, build, usage_estimated: usageEstimatedSoFar(staging, r.usage), usage_by_model: usageByModelSoFar(staging, r.usage), usage_cached_input_tokens: r.usage.cached, usage_reasoning_tokens: r.usage.reasoning });
  await r.patch({ phase: "commit", status: "EXECUTING", staging_url, tool_log: r.toolLog.slice(-100), ...usageFields(r.usage) });
  return { done: false, status: "EXECUTING", phase: "commit", project: project.id };
}

/**
 * G-4: commit-time authorization re-check. Membership and lifecycle were verified when the
 * run was enqueued, but the commit may execute much later, in its own worker request — so
 * the initiating user's CURRENT access is resolved again at the commit boundary, from the
 * same server-side facts every other surface uses (owner_id / active WorkspaceMember row →
 * role → capability → workspace lifecycle). Identity is the run's initiating user:
 * initiated_by_user_id for delegated (Agent-created) runs, created_by_id otherwise.
 *
 * Recovery paths (finalizeRecoveredRun, recoverPendingCommits) intentionally do NOT call
 * this: they resolve an operation that was already authorized and must never leave a
 * half-committed project behind them.
 */
export async function assertCommitAuthorization(base44, run, workspace) {
  const userId = run.initiated_by_user_id || run.created_by_id;
  const runUser = userId ? await base44.entities.User.get(userId).catch(() => null) : null;
  requireCapability(await resolveRole(base44, workspace, runUser), "project.write");
  requireActiveWorkspace(workspace, "project.write");
}

async function commitPhase(base44, run, trace = {}, lease_token = null) {
  const { project, workspace, staging } = await loadContext(base44, run);
  const r = makeRunner(base44, run, { ...trace, workspace_id: workspace.id }, staging, lease_token);
  const model = staging.model;
  const fs = deserializeFs(staging.fs);
  const entities = staging.entities;
  const secrets = staging.secrets || [];
  const plan = staging.plan;

  // Last cancellation gate BEFORE any mutating operation. Everything below this line writes to
  // the project (build record, files, entities, version), so a run cancelled up to this instant
  // leaves canonical state untouched and produces no version.
  const stopped = await cancelIfRequested(base44, run, "commit");
  if (stopped) return stopped;

  // Last ownership gate before anything is written. A worker whose lease was taken over (it
  // stalled, was resumed, or was presumed dead) stops here rather than committing on top of the
  // worker that now owns the run.
  await assertPhaseLease(base44, run, lease_token, "commit");

  // G-4: authorization re-check at the commit boundary. A member removed (or a workspace
  // suspended/terminated) between build and commit must not land a version. Refusal happens
  // before any journal is prepared, so nothing canonical is mutated and no version exists.
  try {
    await assertCommitAuthorization(base44, run, workspace);
  } catch (e) {
    await r.say("Your access to this workspace changed while this run was in progress, so the changes were not saved and no version was created.");
    return settle(base44, run, {
      workspace, model: staging.model, usage: r.usage, status: "FAILED", lease_token,
      usageEstimated: usageEstimatedSoFar(staging, r.usage), usageByModel: usageByModelSoFar(staging, r.usage),
      extra: { error: `Commit refused: ${e.message}`, phase_error_code: "AUTHORIZATION_REVOKED" },
    });
  }

  // Idempotent replay: this run already produced its version, so re-running the commit must not
  // create a second one.
  if (run.version_id) return { done: true, status: run.status, replayed: true, version_id: run.version_id };

  // Optimistic concurrency, unchanged: refuse to overwrite a concurrent run's work.
  if ((project.version_count || 0) !== (run.base_version_number || 0)) {
    await r.say(`This run started from version ${run.base_version_number} but the project is now at version ${project.version_count}. Another change landed while this run was working, so nothing was saved. Please re-run the request against the current state.`);
    return settle(base44, run, { workspace, model, usage: r.usage, status: "FAILED", lease_token, usageEstimated: usageEstimatedSoFar(staging, r.usage), usageByModel: usageByModelSoFar(staging, r.usage), refundReason: "Refund: AI run discarded due to version conflict", extra: { error: `Version conflict: started from v${run.base_version_number}, project is at v${project.version_count}` } });
  }

  // Generated declarations for the FINAL snapshot: the entity + function set is now settled, so ONE
  // base44/.types/types.d.ts is projected from it and becomes part of this commit's file changes.
  // Gated on the project's own manifest exactly like the canonical entity declarations, so a legacy
  // flat-layout project emits nothing. The file is an editor artifact — the build never reads it.
  if (activeFiles(fs).some((f) => f.path === CONFIG_FILE)) {
    const types = emitProjectTypes(fs, entities);
    let current = null;
    try { current = readFile(fs, typesFilePath()); } catch { /* not emitted yet */ }
    if (current !== types) writeFile(fs, typesFilePath(), types);
  }

  const changes = computeChanges(fs);
  const buildRec = await recordBuild(base44, run.project_id, run.id, staging.build);

  // A run that changed nothing must not pollute version history with an empty snapshot.
  let version = null;
  const mutated = changes.length > 0 || (plan.entities || []).length > 0 || secrets.some((s) => s.dirty);
  // Integration definitions are files, so their changes are already part of `changes`.
  if (mutated) {
    // ONE journalled transaction: entities, secret references, files and the immutable version
    // are all finalized together, or the journal's previous snapshot is restored. Nothing here
    // reports success unless the journal reached 'committed'.
    await r.step("Saving files, entities and version", "EXECUTING", async () => {
      const msg = (plan.message || run.prompt).split("\n")[0].slice(0, 120);
      const journal = await prepareCommit(base44, {
        project, workspace, run, message: msg, changedFiles: changes,
        target: {
          files: activeFiles(fs),
          // `rls` is ALWAYS recorded (null = no rules), so a rule removed during this run is an
          // explicit removal that applySnapshot clears, not a missing key that keeps the old rules.
          entities: entities.map((e) => ({ name: e.name, fields: e.fields, rls: e.rls ?? null })),
          // Secret REFERENCES only — an AI run never writes a value.
          secrets: secrets.map((s) => ({ name: s.name, description: s.description || "", required: s.required !== false })),
        },
      });
      try {
        const out = await finalizeCommit(base44, journal, { runId: run.id });
        version = out.version;
      } catch (e) {
        // Partial canonical state is undone before the failure surfaces.
        await rollbackCommit(base44, journal, e.message).catch(() => {});
        throw e;
      }
      return `${changes.length} file(s) saved · version ${version.number}`;
    });
  } else {
    await r.step("No changes to save", "EXECUTING", async () => "project already satisfied the request");
  }

  // Project intelligence update — AFTER the commit, so the index and the memory describe
  // state that actually landed. Both are best-effort and cannot fail the run.
  if (mutated) {
    await r.step("Updating project intelligence", "EXECUTING", () => updateProjectIntelligence(base44, { project, run, staging, fs, entities, secrets, plan, changes, version })).catch(() => {});
  }

  // Architecture reconciliation — AFTER the committed version, so the graph reflects the state
  // that actually landed. Best-effort and swallowed (via the shared wrapper): a reconciliation
  // failure NEVER fails the committed version. Idempotent (fingerprint check inside
  // reconcileArchitecture means an unchanged project reuses the existing finalized version) and
  // authorized through the run's initiating user — the same user the commit boundary just
  // re-authorized for project.write. Only a run that produced a version reconciles; failed/
  // cancelled runs never reach commitPhase (they are short-circuited by cancelIfRequested/
  // settled before any mutation), and the idempotent replay guard above returns before this
  // point, so a replayed commit reconciles once.
  if (mutated && version) {
    await r.step("Reconciling architecture", "EXECUTING", async () => {
      const userId = run.initiated_by_user_id || run.created_by_id;
      const runUser = userId ? await base44.entities.User.get(userId).catch(() => null) : null;
      if (!runUser) return "skipped (no user context)";
      const out = await reconcileArchitectureAfterMutation(base44, runUser, { project_id: project.id, trace_id: run.trace_id || null, run_id: run.id });
      return out.created ? `architecture v${out.version} reconciled` : `architecture unchanged (${out.reason || "unchanged"})`;
    }).catch(() => {});
  }

  await audit(base44, { workspace_id: workspace.id, project_id: project.id, user_id: run.initiated_by_user_id ?? run.created_by_id, action: "ai.run.completed", resource: "ProjectVersion", resource_id: version?.id || null, metadata: { run_id: run.id, changed: changes.length, model: model?.name } });

  // Mutations are recorded as REFERENCES: changed paths, changed entity names and the immutable
  // version a consumer resolves for exact contents. Keyed on the version, so a replayed commit
  // cannot append a second mutation record.
  const commitTraj = await trajectoryForRun(base44, run.id).catch(() => null);
  if (commitTraj) {
    await emit(() => recordMutations(base44, commitTraj, {
      changed_files: changes, entities_changed: (plan.entities || []).map((e) => e.name),
      version_id: version?.id || null, version_number: version?.number ?? null,
    }), "mutations");
    await emit(() => recordToolCalls(base44, commitTraj, { phase: "commit", calls: r.toolLog }), "commit_tools");
  }

  const assumptions = plan.assumptions?.length ? "\n\n**Assumptions**\n" + plan.assumptions.map((a) => `- ${a}`).join("\n") : "";
  const truncated = staging.plan_truncated_paths || [];
  await r.say(`${plan.message || "Done."}${assumptions}${truncationNote(truncated)}`);
  return settle(base44, run, {
    workspace, model, usage: r.usage, status: "COMPLETED", lease_token, usageEstimated: usageEstimatedSoFar(staging, r.usage), usageByModel: usageByModelSoFar(staging, r.usage),
    extra: { ...(truncated.length ? { phase_error_code: "PLAN_TRUNCATED", error: `Partial: ${truncated.length} planned file(s) dropped by the ${MAX_FILES_PER_RUN}-file limit: ${truncated.join(", ")}` } : {}), changed_files: changes, build_id: buildRec.id, tool_log: r.toolLog.slice(-100), ...(version ? { version_id: version.id, version_number: version.number } : {}) },
  });
}

// Post-commit intelligence update, shared by the normal commit phase and stale-run recovery.
async function updateProjectIntelligence(base44, { project, run, staging, fs, entities, secrets, plan, changes, version }) {
  const integrations = integrationsView({ fs, entities, secrets });
  // Design state is committed with the project version, and its tokens + component
  // inventory are indexed so the next run retrieves the real visual language.
  const design = staging.design || { id: null, tokens: {}, revision: 0 };
  const components = discoverComponents(fs);
  const savedDesign = await saveDesignSystem(base44, { project, design, components, runId: run.id, version_number: version?.number });
  const indexStats = await safeSyncProjectIndex(base44, {
    project, fs, entities, integrations,
    extraObjects: designIndexObjects({ tokens: design.tokens, components }),
    version_number: version?.number ?? project.version_count,
  });
  const memStats = await safeStoreMemories(base44, {
    project, runId: run.id,
    items: extractMemories({ plan, entities, integrations, secrets, changes, prompt: run.prompt }),
  });
  return `design rev ${savedDesign.revision} (${components.length} components) · index +${indexStats.created}/~${indexStats.updated}/-${indexStats.deleted} (${indexStats.unchanged} unchanged) · memory +${memStats.created}, ${memStats.reinforced} reinforced`;
}

/**
 * Stale-run recovery for a run whose save already committed `version`. Runs the SAME post-commit
 * finalization as commitPhase — intelligence update, completion audit, settlement — without
 * touching the save itself. Idempotent: the intelligence update + audit are skipped when the
 * completion audit already exists (it is written after them), and settle() is guarded by the
 * run's usage_event_id and the operation's `run:<id>` idempotency key.
 * Returns null when the run's project/workspace can no longer be loaded.
 */
export async function finalizeRecoveredRun(base44, run, version) {
  const { project, workspace, staging } = await loadContext(base44, run).catch(() => ({}));
  if (!project || !workspace) return null;
  const done = await base44.entities.AuditLog.filter({ project_id: project.id, action: "ai.run.completed", resource_id: version.id }, "-created_date", 1).catch(() => []);
  if (!done.length) {
    if (staging?.fs) {
      await updateProjectIntelligence(base44, {
        project, run, staging, fs: deserializeFs(staging.fs), entities: staging.entities || [], secrets: staging.secrets || [],
        plan: staging.plan || {}, changes: version.changed_files || [], version,
      }).catch(() => {});
    }
    await audit(base44, { workspace_id: workspace.id, project_id: project.id, user_id: run.initiated_by_user_id ?? run.created_by_id, action: "ai.run.completed", resource: "ProjectVersion", resource_id: version.id, metadata: { run_id: run.id, changed: (version.changed_files || []).length, model: staging?.model?.name, recovered: true } });
  }
  const usage = { input: run.input_tokens || 0, output: run.output_tokens || 0, cached: stagedUsageTotal(staging, "cached_input_tokens"), reasoning: stagedUsageTotal(staging, "reasoning_tokens"), calls: run.tool_calls || 0 };
  return settle(base44, run, {
    workspace, model: staging?.model || null, usage, status: "COMPLETED", usageEstimated: usageEstimatedSoFar(staging, null), usageByModel: usageByModelSoFar(staging, null),
    extra: { changed_files: version.changed_files || run.changed_files || [], version_id: version.id, version_number: version.number },
  });
}

/**
 * Terminal settlement for a run the reaper marks STALE — the SAME idempotent path a FAILED
 * run takes: settleUsage finalizes the run's one operation (releasing the credit hold /
 * charging accumulated usage exactly once, guarded by the operation's `run:<id>` idempotency
 * key), the usage-analytics event is stamped through the atomic usage_event_id claim, and
 * the run row reaches STALE with its phase lease released. Safe to call again on an
 * already-settled run: the guarded settlement is a no-op and the terminal write is
 * idempotent, so a replayed sweep can neither double-release credits nor duplicate the
 * usage event.
 */
export async function settleStaleRun(base44, run, { error } = {}) {
  const { workspace, staging } = await loadContext(base44, run).catch(() => ({ workspace: null, staging: null }));
  if (!workspace) {
    // Project/workspace no longer loadable: plain terminal write only, exactly like the
    // other no-context fallbacks — there is no ledger left to settle in this case.
    await base44.entities.AIRun.update(run.id, {
      status: "STALE", phase: "done", error: error || run.error || "Run stopped reporting progress and was terminated.",
      completed_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
      phase_lease_token: null, phase_lease_expires_at: null,
    }).catch(() => {});
    return { settled: false };
  }
  const usage = { input: run.input_tokens || 0, output: run.output_tokens || 0, cached: stagedUsageTotal(staging, "cached_input_tokens"), reasoning: stagedUsageTotal(staging, "reasoning_tokens"), calls: run.tool_calls || 0 };
  await settle(base44, run, {
    workspace, model: null, usage, status: "STALE",
    usageEstimated: usageEstimatedSoFar(staging, null), usageByModel: usageByModelSoFar(staging, null),
    extra: { error: error || run.error || "Run stopped reporting progress and was terminated." },
  });
  return { settled: true };
}

async function failRun(base44, run, message, phase, trace = {}) {
  const { workspace, staging } = await loadContext(base44, run).catch(() => ({ workspace: null, staging: null }));
  if (trace.trace_id) {
    await recordSpan(base44, {
      trace_id: trace.trace_id, parent_span_id: trace.span_id || null, workspace_id: workspace?.id || null,
      project_id: run.project_id, run_id: run.id, event_type: "ai_run", name: `phase ${phase} failed`,
      status: "error", error: message, error_code: "PHASE_FAILED", attempt: (run.repair_attempts || 0) + 1,
      metadata: { phase },
    });
  }
  const usage = { input: run.input_tokens || 0, output: run.output_tokens || 0, cached: stagedUsageTotal(staging, "cached_input_tokens"), reasoning: stagedUsageTotal(staging, "reasoning_tokens"), calls: run.tool_calls || 0 };
  if (workspace) {
    await settle(base44, run, { workspace, model: null, usage, status: "FAILED", usageByModel: usageByModelSoFar(staging, null), extra: { error: message } }).catch(() => {});
  } else {
    await base44.entities.AIRun.update(run.id, { status: "FAILED", phase: "done", error: message, completed_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() }).catch(() => {});
  }
  await base44.entities.Message.create({ project_id: run.project_id, conversation_id: run.conversation_id, run_id: run.id, role: "assistant", content: `The AI run failed during ${phase}: ${message}` }).catch(() => {});
}

// --- executor entry point ----------------------------------------------------

// Executes exactly one phase of a persisted run and reports whether more work remains.
// Safe to call again on the same run: terminal runs are a no-op, and each phase's effects
// are re-derived from the persisted staging state rather than appended blindly.
export async function executeRunPhase(base44, runId, { worker_id = `aw_${Math.random().toString(36).slice(2, 10)}` } = {}) {
  const run = await base44.entities.AIRun.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (TERMINAL_STATUSES.includes(run.status)) return { run_id: runId, done: true, status: run.status, phase: run.phase || "done" };

  const phase = run.phase || "plan";
  // Cancellation gate BETWEEN phases: a run cancelled while queued or mid-flight stops here,
  // before this phase does any work, and its credit reservation is released.
  const stopped = await cancelIfRequested(base44, run, phase);
  if (stopped) return { run_id: runId, phase, ...stopped };

  // A run that already produced its version has completed its commit; a replayed tick must
  // observe that and do nothing, so a recovered worker cannot create a second version.
  if (phase === "commit" && run.version_id) {
    return { run_id: runId, phase: "commit", done: true, status: run.status, replayed: true, version_id: run.version_id };
  }

  // AT-MOST-ONE worker per phase. The lease is persisted on the run and confirmed by re-reading,
  // so a duplicate workflow tick, an overlapping retry or a resumed worker walks away here
  // instead of executing the phase a second time.
  const lease = await acquirePhaseLease(base44, run, { worker_id, phase });
  if (!lease.ok) {
    return { run_id: runId, phase, done: false, status: run.status, skipped: lease.reason, lease_holder: lease.holder || null };
  }
  const lease_token = lease.lease_token;

  // ONE trace for the whole run, back-filled only if the run predates tracing. Each phase gets
  // its own span under it — a worker that picks the run up later, or picks it up again after a
  // crash, joins the SAME trace as a further attempt rather than starting a new one.
  const trace_id = await ensureRunTrace(base44, run);
  const span_id = newSpanId();
  const phaseStarted = Date.now();
  const trace = { trace_id, span_id };
  try {
    const out =
      phase === "plan" ? await planPhase(base44, run, trace, lease_token) :
      phase === "generate" ? await generatePhase(base44, run, trace, lease_token) :
      phase === "build" ? await buildPhase(base44, run, trace, lease_token) :
      phase === "commit" ? await commitPhase(base44, run, trace, lease_token) :
      (() => { throw new Error(`Unknown run phase: ${phase}`); })();
    await recordSpan(base44, {
      trace_id, span_id, project_id: run.project_id, run_id: run.id, event_type: "ai_run_phase",
      name: phase, status: out.done && out.status !== "COMPLETED" ? "error" : "ok",
      attempt: (run.repair_attempts || 0) + 1, duration_ms: Date.now() - phaseStarted,
      reference_id: run.version_id || null,
      metadata: { next_phase: out.phase || "done", run_status: out.status || null, done: !!out.done, attempt: lease.attempt },
    });
    // Phase metadata for the episode, from the ONE place every phase transition passes through.
    await emit(async () => {
      const traj = await trajectoryForRun(base44, runId);
      if (traj) await recordPhase(base44, traj, { phase, status: out.done && out.status !== "COMPLETED" ? "error" : "ok", attempt: lease.attempt, duration_ms: Date.now() - phaseStarted, next_phase: out.phase || "done" });
    }, "phase");
    // Releasing the lease as the phase ends lets the next phase be claimed immediately; a
    // terminal run has already had it cleared by settlement.
    if (!out.done) await releasePhaseLease(base44, runId, lease_token);
    return { run_id: runId, phase, trace_id, attempt: lease.attempt, ...out };
  } catch (e) {
    await recordSpan(base44, {
      trace_id, span_id, project_id: run.project_id, run_id: run.id, event_type: "ai_run_phase",
      name: phase, status: "error", error: e, error_code: e.code || "PHASE_FAILED",
      attempt: lease.attempt, duration_ms: Date.now() - phaseStarted,
    });
    // A worker that lost its lease must not touch the run at all: the winner owns it.
    if (e.code === "PHASE_LEASE_LOST") {
      return { run_id: runId, phase, trace_id, done: false, status: run.status, skipped: "lease_lost" };
    }
    // A model call refused by the budget guard: settle the usage this phase already has and stop.
    if (e.code === "BUDGET_EXHAUSTED" && typeof e.stop === "function") {
      let out;
      try { out = await e.stop(); }
      catch (e2) {
        // The budget stop settles the run; if this worker lost its lease while doing so, the
        // winner owns the run — this worker leaves without writing anything.
        if (e2?.code === "PHASE_LEASE_LOST") return { run_id: runId, phase, trace_id, done: false, status: run.status, skipped: "lease_lost" };
        throw e2;
      }
      return { run_id: runId, phase, trace_id, attempt: lease.attempt, ...out };
    }
    // Bounded retry for TRANSIENT failures only. The run stays in this phase with its persisted
    // attempt counter, so the executor workflow drives the same phase again and a worker restart
    // cannot hand it a fresh budget. Deterministic failures fail the run on the first attempt.
    if (isRetryablePhaseError(e)) {
      const retry = await schedulePhaseRetry(base44, run, phase, e);
      if (retry.retrying) {
        await emit(async () => {
          const traj = await trajectoryForRun(base44, runId);
          if (traj) await recordRetry(base44, traj, { phase, attempt: retry.attempt, error_code: e.code || "PHASE_FAILED" });
        }, "retry");
        return { run_id: runId, phase, trace_id, done: false, status: run.status, retry_scheduled: true, attempt: retry.attempt, max_attempts: retry.max_attempts, error: e.message };
      }
    }
    await releasePhaseLease(base44, runId, lease_token);
    await failRun(base44, run, e.message, phase, trace);
    return { run_id: runId, done: true, status: "FAILED", phase, trace_id, error: e.message };
  }
}