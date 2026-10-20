// Durable single-agent control loop.
//
// This is an ORCHESTRATION layer, not a second execution engine. It owns only the loop:
// observe → decide → act → observe → verify → finish. Everything it acts through already
// exists:
//   • project state ...... authz.loadProjectState + projectFs
//   • read tools ......... tools.executeTool (invoked in read-only "discuss" permission set)
//   • MCP ................ mcp.invokeMcpTool (account-scoped, read-only tools only)
//   • mutations .......... runEnqueue.enqueueRun → the existing AI run pipeline, which owns
//                          planning, file writes, build, repair, commit, versioning, atomicity
//   • build verification . buildEngine.runBuild over the canonical persisted state
//   • models ............. modelGateway (routeModel / createGateway)
//   • billing ............ UsageEvent + CreditService
//   • audit .............. authz.audit
import { createFs, buildIndex, activeFiles } from "./projectFs.ts";
import { runBuild } from "./buildEngine.ts";
// THE runtime verifier the Builder build phase uses (startup, routes, backend, database), reused
// as-is so Agent completion is held to the same bar. No second validation system.
import { verifyProjectRuntime } from "./runtimeVerify.ts";
import { createGateway, routeModel, pickModel, pinnedModel, budgetAwareExecutionChain } from "./modelGateway.ts";
import { loadCreditPolicy } from "./economics.ts";
import { loadCatalog } from "./modelCatalog.ts";
import { describeFunctions, secretsView, integrationsView } from "./tools.ts";
// THE Builder tool execution boundary — agent read/MCP tools are routed through it too.
import { createAgentToolSession, openaiToolDefinitions } from "./toolRouter.ts";
import { newTraceId } from "./tracing.ts";
import { loadProjectState, audit } from "./authz.ts";
import { createAgentSchedule, updateAgentSchedule, pauseAgentSchedule, resumeAgentSchedule, archiveAgentSchedule, restoreAgentSchedule } from "./agentSchedules.ts";
import { delegateSubagents, subagentsStatus, cancelSubagentsOf } from "./agentSubagents.ts";
import { loadWorkspaceConnections, invokeMcpTool } from "./mcp.ts";
import { describeMcpBlock, describeIntegrationsBlock, withCustomInstructions } from "./prompts.ts";
import { enqueueRun } from "./runEnqueue.ts";
import { TERMINAL_STATUSES as AI_RUN_TERMINAL } from "./runPipeline.ts";
import { settleUsage, beginOperation, findOperation, finalizeOperation, addModelUsage, spendableCredits, ensureRunBudget, accumulateCallUsage } from "./aiOperations.ts";
import { resolveModelAccess } from "./subscriptions.ts";
import { stampUsageEvent } from "./usageEventStamp.ts";
// Runtime memory: a BOUNDED, READ-ONLY, authorized retrieval the agent sees before deciding. It
// mints no trace of its own (the run's trace_id/run_id are carried through) and fails safe — an
// unavailable memory layer yields no memory and the run proceeds unchanged.
import { retrieveMemoryForRun, memoryContextBlock } from "./memory.ts";
// Architecture Intelligence (#25): the certified, safe-failing read path into the project's versioned
// dependency graph. Additive reference context only; empty when no finalized architecture exists, so
// an agent run without one is unchanged.
import { retrieveArchitectureForRun, architectureContextBlock } from "./architecture.ts";
// E9/E10/E11: a run may execute AS one of the project's declared agents. The agent, its tool grants
// and its skills are resolved from the project's OWN files at every iteration — never from the
// caller — and the grant gate runs BEFORE any tool executes. No agent named = unchanged behaviour.
import { resolveAgent, agentPermissionGate, agentContextBlock } from "./agentResource.ts";
import { resolveAgentSkills, agentSkillsBlock } from "./agentSkillResource.ts";

import { AGENT_TERMINAL } from "./agentConstants.ts";
// Backwards-compatible re-export: every surface that reads agent-run terminality from the loop
// keeps working, but the constant itself now lives in the leaf module (no agentSchedules cycle).
export { AGENT_TERMINAL } from "./agentConstants.ts";
const ITERATION_BUDGET_MS = 85000;
// Exactly one worker may advance a run. Without this, a retried or overlapping invocation
// interleaves steps and its delegated builder runs collide on the project version.
const LEASE_MS = 150000;
const MAX_REPEATED_SIGNATURE = 3;
const SUMMARY_CHARS = 600;
const HISTORY_STEPS = 14;
// An observation is only useful if the agent can actually SEE it. Recent results are fed
// back in full-ish; older ones collapse to a short trace so the context stays bounded.
const OBSERVATION_CHARS = 12000;
const RECENT_FULL_STEPS = 3;

const trunc = (v, n = SUMMARY_CHARS) => String(v ?? "").slice(0, n);

// The agent's own reasoning is ONE billable operation, keyed by the agent run. The same key is
// what finalize() settles through settleUsage, so the reservation opened here is the operation
// that later gets charged and released — never a second one.
const agentOperationKey = (run) => `agent:${run.id}`;
// Worst-case hold for the agent's reasoning, sized like a Builder run's reservation.
const AGENT_RESERVATION_ESTIMATE = { max_input_tokens: 60000, max_output_tokens: 12000 };
const AGENT_ROUTE_ESTIMATE = { ...AGENT_RESERVATION_ESTIMATE, operation_type: "agent" };

// Budget ceiling for the agent's routing, from the same source the Builder uses. This run's own
// open hold is spendable BY this run, so it is added back.
async function agentCeiling(svc, run) {
  const spendable = await spendableCredits(svc, { workspace_id: run.workspace_id, user_id: run.user_id, project_id: run.project_id, run_id: run.id }, "message").catch(() => null);
  if (spendable == null) return null;
  const op = await findOperation(svc, { workspace_id: run.workspace_id, idempotency_key: agentOperationKey(run) }).catch(() => null);
  return spendable + (op && !op.finalized_at ? Number(op.credits_reserved) || 0 : 0);
}

// One step's model and its approved fallbacks: the router's budget-checked candidates for a routed
// choice, the catalog chain for a tier pick (every one of which the reservation covers).
function chooseAgentModel({ recovering, agent, goal, fileCount, ceiling, modelAccess = null, triggerSource = null }) {
  // P-8.4: every tier pick and every routed pick is plan-checked — a declared agent tier or a
  // recovery upgrade can never admit a model the workspace's plan does not include.
  const pickAllowed = (tier) => {
    const m = pickModel(tier);
    return modelAccess ? modelAccess.check(m) : m;
  };
  if (recovering) return { model: pickAllowed("standard"), fallbacks: null };
  // Superagent parity: a scheduled run (trigger_source 'schedule') serves with the agent's
  // AUTOMATIONS model pin, in preference to the General-model tier/routing. A stale pin
  // (unknown or disabled model — save-time validation should prevent both) falls through to
  // the ordinary choice instead of failing a background run.
  if (triggerSource === "schedule" && agent?.automations_model) {
    const pinned = pinnedModel(agent.automations_model);
    if (pinned) return { model: modelAccess ? modelAccess.check(pinned) : pinned, fallbacks: null };
  }
  if (agent?.model_tier) return { model: pickAllowed(agent.model_tier), fallbacks: null };
  const { model, decision } = routeModel({ mode: "default", prompt: goal, fileCount, budget_credits: ceiling, estimate: AGENT_ROUTE_ESTIMATE, modelAccess });
  return { model, fallbacks: decision.fallbacks || [] };
}

// Worst case of ONE agent call, as the budget guard and the chain filter both estimate it.
const agentCallEstimate = (run) => ({ ...AGENT_RESERVATION_ESTIMATE, max_reasoning_tokens: AGENT_RESERVATION_ESTIMATE.max_output_tokens, image_count: (run.image_urls || []).length });

// A model's budget-aware execution chain for this run. If even the primary does not fit, the chain
// is the primary alone, so the existing reservation/guard refusal handles it. The result is handed
// to the gateway as `fallbacks` (it drops the primary), so it is never widened to catalog defaults.
function agentChain(run, model, fallbacks, available, policy, catalog = null, modelAccess = null) {
  const chain = budgetAwareExecutionChain(model, fallbacks, available, { estimate: agentCallEstimate(run), operation_type: "agent", policy, catalog, modelAccess });
  return chain.length ? chain : [model.model_id || model.id];
}

// THE per-call resolver: the runtime guard checks the primary against the run's remaining headroom
// (hold + spendable − consumed), then the chain is filtered against that same headroom, so every
// model the gateway may run for this call fits. Read-only; `guard.ok === false` means stop.
async function resolveAgentCallChain(svc, run, model, fallbacks, usage, policy, catalog = null, modelAccess = null) {
  const primary = model.model_id || model.id;
  // Before every agent model call: if the call fits capacity but not the current hold, the hold is
  // extended under a deterministic step-based key and the guard re-checked.
  const guard = await ensureRunBudget(svc, {
    workspace_id: run.workspace_id, user_id: run.user_id, project_id: run.project_id, run_id: run.id,
    idempotency_key: agentOperationKey(run), operation_type: "agent", usage_by_model: usage.by_model,
    usage_totals: { input_tokens: usage.input, output_tokens: usage.output, cached_input_tokens: usage.cached, reasoning_tokens: usage.reasoning },
    next_model_ids: [primary], estimate: agentCallEstimate(run), catalog,
  }, `step:${run.current_step}`);
  if (!guard.ok) return { guard, chain: [primary] };
  const headroom = guard.capacity == null ? null : guard.capacity - guard.consumed;
  return { guard, chain: agentChain(run, model, fallbacks, headroom, policy, catalog, modelAccess) };
}

// Every model_id this agent run may execute: fast, standard, the declared tier, the router's pick,
// and each one's budget-aware chain — exactly the chains the loop will hand the gateway.
async function agentCandidateModelIds(svc, run, policy, catalog = null, modelAccess = null) {
  const state = await loadProjectState(svc, run.project_id);
  const declared = run.agent_name ? resolveAgent(state.files, run.agent_name) : null;
  const available = await agentCeiling(svc, run);
  const routed = chooseAgentModel({ recovering: false, agent: null, goal: run.goal, fileCount: activeFiles(createFs(state.files)).length, ceiling: available, modelAccess });
  // P-8.4: a model the plan does not include is never a reservation candidate — the hold only
  // ever covers models the run may actually execute.
  const tierPick = (tier) => { const m = pickModel(tier); return !modelAccess || modelAccess.allows(m) ? [[m, null]] : []; };
  // A scheduled run under an AUTOMATIONS pin may execute the pinned model, so its chain belongs
  // in the reservation candidates too (plan-checked like every other candidate).
  const pinned = run.trigger_source === "schedule" && declared?.automations_model ? pinnedModel(declared.automations_model) : null;
  const pinnedPick = pinned && (!modelAccess || modelAccess.allows(pinned)) ? [[pinned, null]] : [];
  const picks = [...tierPick("fast"), ...tierPick("standard"), ...(declared?.model_tier ? tierPick(declared.model_tier) : []), ...pinnedPick, [routed.model, routed.fallbacks]];
  return [...new Set(picks.flatMap(([m, f]) => agentChain(run, m, f, available, policy, catalog, modelAccess)))];
}

/**
 * Settles an agent run's still-open operation on the failure/cancel/stale paths. Usage the run
 * already consumed (durable per-call usage on the operation, or the totals persisted on the
 * AgentRun) is charged through settleUsage under the same agent operation key; a run with no usage
 * anywhere only has its reservation released, uncharged, exactly as before.
 */
export async function releaseAgentReservation(svc, run, status = "FAILED") {
  const op = await findOperation(svc, { workspace_id: run.workspace_id, idempotency_key: agentOperationKey(run) }).catch(() => null);
  if (!op || op.finalized_at) return;
  const usage = {
    input_tokens: run.input_tokens || 0, output_tokens: run.output_tokens || 0,
    cached_input_tokens: run.cached_input_tokens || 0, reasoning_tokens: run.reasoning_tokens || 0,
  };
  const runUsage = Object.values(usage).some((v) => v > 0);
  const opUsage = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens"].some((f) => (Number(op[f]) || 0) > 0);
  if (!runUsage && !opUsage) {
    await finalizeOperation(svc, { operation_id: op.id, status: status === "CANCELLED" ? "cancelled" : "failed", error: `Agent run ${String(status).toLowerCase()}` });
    return;
  }
  // settleUsage reconciles these totals with the operation's persisted per-call usage (max, never
  // summed) and bills consumed usage whatever the run's outcome.
  const settled = await settleUsage(svc, {
    workspace_id: run.workspace_id, project_id: run.project_id, run_id: run.id, user_id: run.user_id,
    operation_type: "agent", model: null, usage, usage_source: "estimated",
    idempotency_key: agentOperationKey(run),
    usage_by_model: run.usage_by_model && Object.keys(run.usage_by_model).length ? run.usage_by_model : null,
    status: status === "COMPLETED" ? "completed" : status === "CANCELLED" ? "cancelled" : "failed",
  });
  // UsageEvent parity with Builder settlement — recovery runs (FAILED/STALE/COMPLETED) leave the
  // same usage-analytics record the Builder's settle() does. Cancels skip it, exactly like the
  // Builder cancel path. Same usage_event_id guard pattern as Builder, so a replayed recovery
  // settlement never creates a second event.
  if (status !== "CANCELLED") {
    const fresh = await svc.entities.AgentRun.get(run.id).catch(() => null);
    if (fresh && !fresh.usage_event_id) {
      const startedMs = Date.parse(fresh.started_at || fresh.created_date);
      const duration = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;
      // The helper's atomic claim makes this fresh-read guard an optimization, not the race guard.
      await stampUsageEvent(svc, {
        run_entity: "AgentRun", run_id: fresh.id,
        operation_id: settled.operation?.id || null, credits_charged: settled.credits_charged || 0,
        event: {
          workspace_id: fresh.workspace_id, project_id: fresh.project_id, run_id: fresh.id, user_id: fresh.user_id,
          model: fresh.model || null, provider: null,
          input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
          tokens_estimated: true, tool_calls: fresh.current_step || 0, duration_ms: duration,
          estimated_cost: settled.provider_cost || 0,
        },
      });
    }
  }
}

// Read-only actions run through the existing tool executor with the DISCUSS permission set,
// so the agent physically cannot mutate the project outside the AI run pipeline.
const READ_TOOL = { inspect_project: "get_project_state", read_file: "read_file", search_project: "search_project", list_mcp_connections: "list_mcp_connections", mcp_call: "mcp_call" };

// Native tool-calling surface for the decision loop (documented Base44 behavior: the platform's
// AI Gateway speaks OpenAI chat completions and carries tool definitions). The registry-backed
// read tools keep their EXACT toolContracts() names and converted schemas; the loop-native
// actions keep their existing action names and the same fields the ACTION_SCHEMA decision
// carried. No new tool is invented, no name or contract is changed.
const TOOL_TO_ACTION = Object.fromEntries(Object.entries(READ_TOOL).map(([action, tool]) => [tool, action]));
const NATIVE_ACTION_TOOLS = {
  edit_project: { instruction: "edit_project: the precise change request handed to the builder pipeline, grounded in what you observed (real file paths, real entity fields)." },
  verify_build: {},
  finish: { result_summary: "finish: concise summary of what was accomplished, for the user." },
  create_schedule: { schedule_goal: "create_schedule: the fixed instruction the schedule hands to the agent on every fire.", schedule_json: "create_schedule: { \"cron\" } or { \"interval_seconds\" } or { \"one_time_at\" }, optionally \"timezone\" and ends_type/ends_on_date/ends_after_count.", agent_name: "Optional: the declared agent the schedule runs as." },
  update_schedule: { schedule_id: "update_schedule: the AgentSchedule id.", schedule_goal: "Optional: the fixed instruction to change.", schedule_json: "Optional: only the schedule fields to change.", agent_name: "Optional: the declared agent the schedule runs as." },
  pause_schedule: { schedule_id: "pause_schedule: the AgentSchedule id." },
  resume_schedule: { schedule_id: "resume_schedule: the AgentSchedule id." },
  archive_schedule: { schedule_id: "archive_schedule: the AgentSchedule id." },
  restore_schedule: { schedule_id: "restore_schedule: the AgentSchedule id." },
  delegate_subagents: { tasks_json: "delegate_subagents: JSON array (max 5) of independent background tasks, each { \"goal\": \"...\" }. Omit it to observe the already-delegated sub-agents instead." },
};
const NATIVE_TOOL_DESCRIPTIONS = {
  edit_project: "Hand a precise instruction to the builder pipeline; it plans, edits files, builds, repairs and commits a version. You then observe the result.",
  verify_build: "Re-check the current build state of the project.",
  finish: "End the run: the goal is achieved AND the project state supports that claim. Do not finish while the last build is failing and steps remain.",
  create_schedule: "Create this project's Scheduled Superagent automation.",
  update_schedule: "Update one Scheduled Superagent automation.",
  pause_schedule: "Pause one Scheduled Superagent automation.",
  resume_schedule: "Resume one Scheduled Superagent automation.",
  archive_schedule: "Archive one Scheduled Superagent automation.",
  restore_schedule: "Restore one archived Scheduled Superagent automation.",
  delegate_subagents: "Delegate independent background tasks to sub-agents: they run in parallel while you continue. Call this same action WITHOUT tasks_json to observe their statuses; finish only once every task is terminal, then combine their results into your finish summary.",
};
const AGENT_TOOLS = [
  ...openaiToolDefinitions("discuss").filter((t) => Object.values(READ_TOOL).includes(t.function.name)),
  ...Object.entries(NATIVE_ACTION_TOOLS).map(([name, fields]) => ({
    type: "function",
    function: {
      name,
      description: NATIVE_TOOL_DESCRIPTIONS[name],
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "ONE short user-facing sentence naming what you are doing, e.g. 'Reading the Customer schema'. Never internal reasoning." },
          ...Object.fromEntries(Object.entries(fields).map(([field, description]) => [field, { type: "string", description }])),
        },
      },
    },
  })),
];

export const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["inspect_project", "read_file", "search_project", "list_mcp_connections", "mcp_call", "verify_build", "edit_project", "create_schedule", "update_schedule", "pause_schedule", "resume_schedule", "archive_schedule", "restore_schedule", "delegate_subagents", "finish"] },
    summary: { type: "string", description: "ONE short user-facing sentence naming what you are doing, e.g. 'Reading the Customer schema'. Never internal reasoning." },
    path: { type: "string", description: "read_file: exact project file path." },
    query: { type: "string", description: "search_project: text to search for." },
    connection: { type: "string", description: "mcp_call: MCP connection name." },
    tool: { type: "string", description: "mcp_call: MCP tool name." },
    arguments_json: { type: "string", description: "mcp_call: arguments as JSON text." },
    instruction: { type: "string", description: "edit_project: the precise change request handed to the builder pipeline, grounded in what you observed (real file paths, real entity fields)." },
    schedule_goal: { type: "string", description: "create_schedule / update_schedule: the fixed instruction the schedule hands to the agent on every fire." },
    schedule_json: { type: "string", description: "create_schedule: { \"cron\" } or { \"interval_seconds\" } or { \"one_time_at\" }, optionally \"timezone\" and ends_type/ends_on_date/ends_after_count. update_schedule: only the schedule fields to change." },
    schedule_id: { type: "string", description: "update/pause/resume/archive/restore_schedule: the AgentSchedule id." },
    tasks_json: { type: "string", description: "delegate_subagents: JSON array (max 5) of { \"goal\": \"...\" } background tasks; omit for a status check." },
    result_summary: { type: "string", description: "finish: concise summary of what was accomplished, for the user." },
  },
  required: ["action", "summary", "path", "query", "connection", "tool", "arguments_json", "instruction", "schedule_goal", "schedule_json", "schedule_id", "tasks_json", "result_summary"],
  additionalProperties: false,
};

// Which read action each granted tool unlocks; 'edit_project' additionally needs a write grant.
// Scheduled-workflow actions map onto the SAME registry names the agent may be granted (E10):
// creating/updating/pausing/resuming/archiving/restoring a Scheduled Superagent automation
// requires the explicit agent_schedule_* grant, fail-closed for declared agents.
const ACTION_TOOL = { inspect_project: "get_project_state", read_file: "read_file", search_project: "search_project", list_mcp_connections: "list_mcp_connections", mcp_call: "mcp_call", create_schedule: "agent_schedule_create", update_schedule: "agent_schedule_update", pause_schedule: "agent_schedule_pause", resume_schedule: "agent_schedule_resume", archive_schedule: "agent_schedule_archive", restore_schedule: "agent_schedule_restore" };

// The schedule actions' executors: the member-authorized lifecycle in agentSchedules.ts — the
// Base44-evidenced Superagent surface (create/edit/pause/resume/archive/restore in chat).
const SCHEDULE_OPS = {};
export const SCHEDULE_ACTION_TOOL = {};
for (const [action, toolName] of Object.entries(ACTION_TOOL)) {
  if (!toolName.startsWith("agent_schedule_")) continue;
  SCHEDULE_ACTION_TOOL[action] = toolName;
  SCHEDULE_OPS[action] = { agent_schedule_create: createAgentSchedule, agent_schedule_update: updateAgentSchedule, agent_schedule_pause: pauseAgentSchedule, agent_schedule_resume: resumeAgentSchedule, agent_schedule_archive: archiveAgentSchedule, agent_schedule_restore: restoreAgentSchedule }[toolName];
}

// Fail-closed gate for ONE decided action, evaluated BEFORE anything executes. `null` = allowed.
export function gateAction(gate, action) {
  if (!gate) return null;
  // Sub-agents are the documented Superagent capability of the app owner's own runs (docs:
  // "Sub-agents are available to app owners"), so the platform issues the action like
  // finish/verify_build. Each spawned child is still gated by its OWN loop's grants.
  if (action === "finish" || action === "verify_build" || action === "delegate_subagents") return null;
  if (action === "edit_project") {
    return gate.canWrite ? null : { code: "AGENT_TOOL_NOT_GRANTED", reason: `agent '${gate.agent_name}' holds no write grant, so it cannot edit the project (granted: ${gate.granted.join(", ") || "none"})` };
  }
  const tool = ACTION_TOOL[action];
  if (!tool) return null;   // unknown actions are already refused downstream
  const d = gate(tool);
  return d.allowed ? null : { code: d.code, reason: d.reason };
}

export function systemPrompt(agentBlock = "") {
  return `${agentBlock ? `${agentBlock}\n\n` : ""}You are the AGENT of an application builder. You pursue ONE goal on ONE existing project by taking ONE action at a time, observing the real result, and deciding the next action.

RULES:
- Respond with tool calls: one action per turn, or several independent read calls together. Never a plan of several dependent actions.
- 'summary' is shown to the user: one short sentence describing the action. NEVER include internal reasoning, deliberation or hidden thoughts.
- OBSERVE before you change: inspect the project state, the relevant files and the real entity fields. Never assume a field, page, function or integration exists — the observations you are given are the truth.
- Mutations go through 'edit_project': you hand the builder pipeline a precise instruction and it plans, edits files, builds, repairs and commits a version. You then observe the result. Never assume an edit succeeded.
- After a mutation, check the outcome (the run result you are shown, and 'verify_build' when you need the current build state).
- If something failed, diagnose from the observed error and choose a DIFFERENT approach or a more precise instruction. Do not repeat an identical failing action — repeated identical actions abort the run.
- Use 'mcp_call' only for read-only external lookups when the goal needs real external data.
- SCHEDULED AUTOMATIONS: when the goal needs this project's agent to run again in the future (recurring or once at a set time), manage the project's Scheduled Superagent automations with the schedule actions. create_schedule takes 'schedule_goal' (the fixed instruction to run each time) and 'schedule_json' ({ "cron" } or { "interval_seconds" } or { "one_time_at" }, optionally "timezone"); every other schedule action needs 'schedule_id'. When the user asks to stop, change the timing, or archive one, use pause/resume/update/archive/restore — never recreate an existing schedule.
- 'finish' when the goal is achieved AND the project state supports that claim; supply result_summary. Do not finish while the last build is failing and steps remain.
- Be economical: each action costs a step from a hard budget.`;
}

async function observationBlock(svc, run, project) {
  const state = await loadProjectState(svc, project.id);
  const fs = createFs(state.files);
  const index = buildIndex(fs);
  const ctx = { fs, entities: state.entities, secrets: state.secrets, deletes: 0 };
  const builds = await svc.entities.Build.filter({ project_id: project.id }, "-created_date", 1);
  const connections = await loadWorkspaceConnections(svc, run.workspace_id).catch(() => []);
  const steps = (await svc.entities.AgentStep.filter({ agent_run_id: run.id }, "-step_number", HISTORY_STEPS)).reverse();
  const memory = await retrieveMemoryForRun(svc, { project, user_id: run.user_id, query: run.goal, trace_id: run.trace_id || null, run_id: run.id });
  const history = steps.map((s, i) => {
    const recent = i >= steps.length - RECENT_FULL_STEPS;
    const result = s.result_summary ? (recent ? s.result_summary : trunc(s.result_summary, 300)) : "";
    return `${s.step_number}. [${s.status}] ${s.action_type}${s.tool ? ` (${s.tool})` : ""} — ${s.summary || ""}${s.error_code ? ` [${s.error_code}]` : ""}${result ? `\n   OBSERVED: ${result}` : ""}`;
  });

  const memoryBlock = memoryContextBlock(memory.items);
  // Architecture Intelligence: bounded relevant-subgraph for this goal, safe-failing by contract.
  const arch = await retrieveArchitectureForRun(svc, { project, user_id: run.user_id, query: run.goal, trace_id: run.trace_id || null, run_id: run.id });
  const archBlock = architectureContextBlock(arch);
  const block = `GOAL:\n${run.goal}
${memoryBlock ? `\n${memoryBlock}\n` : ""}
${archBlock ? `\n${archBlock}\n` : ""}
PROJECT: ${project.name} · version ${project.version_count || 0} · last build ${project.last_build_status || "none"}
STEP ${run.current_step + 1} of ${run.max_steps}

FILES:
${index.map((f) => `- ${f.path} (${f.size} chars)${f.exports.length ? " exports: " + f.exports.join(", ") : ""}`).join("\n") || "- none"}

ENTITIES (authoritative schema — never invent fields):
${state.entities.map((e) => `- ${e.name}: ${JSON.stringify(e.fields)}`).join("\n") || "- none"}

BACKEND FUNCTIONS:
${describeFunctions(fs).map((f) => `- ${f.name} (${f.path}) secrets: ${f.secrets.join(", ") || "none"} · integrations: ${f.integrations.join(", ") || "none"}`).join("\n") || "- none"}

INTEGRATIONS:
${describeIntegrationsBlock(integrationsView(ctx))}

SECRETS (names only):
${secretsView(ctx).map((s) => `- ${s.name}${s.is_set ? "" : " (not set)"}`).join("\n") || "- none"}

MCP CONNECTIONS (read-only tools only):
${describeMcpBlock(connections)}

LATEST BUILD: ${builds[0] ? `${builds[0].status}, ${builds[0].error_count || 0} error(s)${(builds[0].logs || []).filter((l) => l.startsWith("error")).slice(0, 5).map((l) => `\n  ${l}`).join("")}` : "none"}

WHAT YOU HAVE DONE SO FAR (the OBSERVED text below is the real result — read it instead of repeating the action):
${history.join("\n") || "(nothing yet — start by observing what you need)"}`;

  return { block, ctx, fs, state, connections, buildRecord: builds[0] || null };
}

// --- step + run persistence --------------------------------------------------

// Step numbers come from what is already persisted, not from current_step: a worker killed
// after a step was written but before current_step advanced must not reuse its number.
async function nextStepNumber(svc, run) {
  const [last] = await svc.entities.AgentStep.filter({ agent_run_id: run.id }, "-step_number", 1);
  return Math.max(last?.step_number || 0, run.current_step) + 1;
}

async function recordStep(svc, run, data) {
  return svc.entities.AgentStep.create({
    agent_run_id: run.id, project_id: run.project_id, step_number: await nextStepNumber(svc, run),
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(), ...data,
  });
}

// Claim the run for this worker. Returns null when another live worker already holds it.
async function claimLease(svc, run) {
  const now = Date.now();
  const held = Date.parse(run.lease_expires_at || "");
  if (Number.isFinite(held) && held > now) return null;
  const token = `${now}-${Math.random().toString(36).slice(2, 10)}`;
  await svc.entities.AgentRun.update(run.id, { lease_token: token, lease_expires_at: new Date(now + LEASE_MS).toISOString() });
  // Re-read: if two workers wrote at once, only the one that persisted last continues.
  const check = await svc.entities.AgentRun.get(run.id);
  return check.lease_token === token ? token : null;
}

const releaseLease = (svc, runId) => svc.entities.AgentRun.update(runId, { lease_token: null, lease_expires_at: null }).catch(() => {});

// Running token totals as persisted on the run (all four canonical counts).
const usageFields = (usage) => ({
  input_tokens: usage.input, output_tokens: usage.output,
  cached_input_tokens: usage.cached, reasoning_tokens: usage.reasoning,
  usage_by_model: usage.by_model || null,
});

// Persists this worker's running totals when an iteration ends WITHOUT finalizing, so the next
// iteration (resume, Builder wait, budget pause) starts from them instead of losing them. Only
// the lease holder of a still-open run writes: a finalized run already recorded its totals, and
// a worker that lost its lease must not overwrite the new owner's totals.
async function persistUsage(svc, runId, token, usage) {
  const cur = await svc.entities.AgentRun.get(runId).catch(() => null);
  if (!cur || AGENT_TERMINAL.includes(cur.status) || cur.lease_token !== token) return;
  await svc.entities.AgentRun.update(runId, usageFields(usage)).catch(() => {});
}

function patcher(svc, run, token) {
  return async (data) => {
    const saved = await svc.entities.AgentRun.update(run.id, { ...data, heartbeat_at: new Date().toISOString(), ...(token ? { lease_expires_at: new Date(Date.now() + LEASE_MS).toISOString() } : {}) });
    Object.assign(run, saved || data);
    return run;
  };
}

// Terminal accounting for the agent's OWN reasoning tokens. Delegated AI runs bill
// themselves through the existing pipeline, so nothing is charged twice and no second
// ledger exists.
async function finalize(svc, run, { status, failure_code, error, result_summary, usage, model, extra }) {
  const startedMs = Date.parse(run.started_at || run.created_date);
  const duration = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;
  if (!run.usage_event_id && usage && (usage.input || usage.output)) {
    // One billable operation for the agent's own reasoning, priced by the economics engine and
    // settled on the authoritative ledger. Keyed by the agent run, so a retried worker or a
    // re-driven finalize settles the same operation instead of charging again.
    const settled = await settleUsage(svc, {
      workspace_id: run.workspace_id, project_id: run.project_id, run_id: run.id, user_id: run.user_id,
      operation_type: "agent", model,
      // Same canonical usage structure the Builder settles with.
      usage: { input_tokens: usage.input, output_tokens: usage.output, cached_input_tokens: usage.cached || 0, reasoning_tokens: usage.reasoning || 0 },
      usage_source: usage.estimated === false ? "provider" : "estimated",
      idempotency_key: `agent:${run.id}`,
      usage_by_model: usage.by_model || null,
      status: status === "COMPLETED" ? "completed" : "failed",
      duration_ms: duration,
    });
    // Idempotent stamping: the run row's usage_event_id is claimed atomically, so concurrent
    // finalize/recovery workers converge on ONE event even when this in-memory check is stale.
    await stampUsageEvent(svc, {
      run_entity: "AgentRun", run_id: run.id,
      operation_id: settled.operation?.id || null, credits_charged: settled.credits_charged || 0,
      event: {
        workspace_id: run.workspace_id, project_id: run.project_id, run_id: run.id, user_id: run.user_id,
        model: model?.name, provider: model?.provider, input_tokens: usage.input, output_tokens: usage.output,
        tokens_estimated: usage.estimated !== false, tool_calls: run.current_step, duration_ms: duration, estimated_cost: settled.provider_cost || 0,
      },
    });
  } else if (!run.usage_event_id) {
    // No reasoning usage to settle: just hand back any credits the reservation still holds.
    await releaseAgentReservation(svc, run, status);
  }
  await svc.entities.AgentRun.update(run.id, {
    status, failure_code: failure_code || null, error: error ? trunc(error, 1000) : null,
    result_summary: trunc(result_summary || "", 2000), current_phase: status.toLowerCase(),
    input_tokens: usage?.input || run.input_tokens || 0, output_tokens: usage?.output || run.output_tokens || 0,
    cached_input_tokens: usage?.cached || run.cached_input_tokens || 0, reasoning_tokens: usage?.reasoning || run.reasoning_tokens || 0,
    usage_by_model: usage?.by_model || run.usage_by_model || null,
    completed_at: new Date().toISOString(), duration_ms: duration, heartbeat_at: new Date().toISOString(), ...(extra || {}),
  });
  await audit(svc, {
    workspace_id: run.workspace_id, project_id: run.project_id, user_id: run.user_id,
    action: `agent.run.${status.toLowerCase()}`, resource: "AgentRun", resource_id: run.id,
    metadata: { goal: trunc(run.goal, 200), steps: run.current_step, failure_code: failure_code || null, version_id: extra?.version_id || run.version_id || null },
  });
  return { done: true, status, failure_code: failure_code || null };
}

// --- the loop ----------------------------------------------------------------

// Executes as many iterations as fit in ONE request window, then returns so the workflow
// can call again. All progress is persisted, so a killed worker resumes exactly here.
export async function runAgentIterations(svc, agentRunId) {
  let run = await svc.entities.AgentRun.get(agentRunId);
  if (!run) throw new Error(`Agent run not found: ${agentRunId}`);
  if (AGENT_TERMINAL.includes(run.status)) return { agent_run_id: agentRunId, done: true, status: run.status };

  const token = await claimLease(svc, run);
  if (!token) return { agent_run_id: agentRunId, done: false, busy: true, status: run.status };
  const patch = patcher(svc, run, token);
  // ONE trace per agent run, back-filled once and reused by every later iteration.
  const traceId = run.trace_id || newTraceId();
  if (!run.trace_id) await svc.entities.AgentRun.update(run.id, { trace_id: traceId }).catch(() => {});
  const gateway = createGateway(svc);
  // Credit policy for the budget-aware chain filter (the same one the budget guard prices with).
  const policy = await loadCreditPolicy(svc, run.workspace_id);
  // ONE loaded catalog (the source the guard's pricing uses) for every chain filter and guard estimate.
  const catalog = await loadCatalog(svc);
  // P-8.4: plan-based model access for this workspace, resolved BEFORE any agent model call. The
  // router's pool, the reservation candidates and every fallback chain only ever see models the
  // current plan allows; a lapsed subscription or a suspended workspace fails closed here.
  const modelAccess = await resolveModelAccess(svc, { workspace_id: run.workspace_id });
  // Running totals are loaded from the run, so every earlier iteration's usage is carried forward.
  // Counts carried in from an earlier iteration have no per-call source, so they start the run
  // labelled estimated; a fresh iteration is "provider" only while every call reports usage.
  const usage = {
    input: run.input_tokens || 0, output: run.output_tokens || 0,
    cached: run.cached_input_tokens || 0, reasoning: run.reasoning_tokens || 0,
    estimated: !!(run.input_tokens || run.output_tokens || run.cached_input_tokens || run.reasoning_tokens),
    // Per-model breakdown carried forward from earlier iterations (attribution only).
    by_model: { ...(run.usage_by_model || {}) },
  };
  let model = modelAccess.check(pickModel("fast"));
  // Explicit, approved fallback chain for the current model — never left to the gateway's default.
  // Holds the FULL chain (primary first); the gateway drops the primary from `fallbacks`.
  // Replaced by the per-call resolver before every decision call.
  let modelFallbacks = agentChain(run, model, null, null, policy, catalog, modelAccess);
  const started = Date.now();
  const overBudget = () => Date.now() - started > ITERATION_BUDGET_MS;
  // The agent's billable operation (set by beginOperation below, before any model call).
  let agentOperationId = null;
  // The native-tool conversation for THIS invocation: seeded from a full observation block, then
  // CONTINUED with appended tool results instead of rebuilding the whole context per step.
  // Between invocations it is rebuilt from persisted state (whose history carries the results).
  let conversation = null, systemText = null, ctx = null, fs = null, state = null, project = null, gate = null, choice = null, agent = null, agentBlock = "";

  // Reference images the user attached to the goal travel with every decision call, so the agent
  // reasons about what it can actually see. Omitted entirely for a text-only goal.
  const fileUrls = run.image_urls || null;
  // One decision call, now native: executed through the AI Gateway adapter with the agent's tool
  // definitions, because InvokeLLM is a single call with no tools by contract and would silently
  // drop them. Same fallback chain, budget guard (run per call by the loop) and durable usage
  // accounting as before. Returns the full result (output + normalized tool_calls).
  const llm = async (system, messages, tools) => {
    const res = await gateway.generateTools(model, { system, messages, tools, timeoutMs: 60000, fallbacks: modelFallbacks, modelAccess, ...(fileUrls?.length ? { fileUrls } : {}) });
    // Durable first, exactly like Builder runs: the call already happened, so its usage lands on the
    // agent's operation before anything else can fail. A failed write is logged, never fatal — the
    // in-memory totals remain the settlement fallback.
    if (agentOperationId) {
      await accumulateCallUsage(svc, agentOperationId, {
        model_id: res.model_used?.model_id || model.model_id || model.id,
        input_tokens: res.inputTokens || 0, output_tokens: res.outputTokens || 0,
        cached_input_tokens: res.usage?.cached_input_tokens || 0, reasoning_tokens: res.usage?.reasoning_tokens || 0,
      }).catch((e) => console.error(`accumulateCallUsage failed for agent run ${agentRunId}: ${e?.message || e}`));
    }
    usage.input += res.inputTokens; usage.output += res.outputTokens;
    usage.cached += res.usage?.cached_input_tokens || 0;
    usage.reasoning += res.usage?.reasoning_tokens || 0;
    addModelUsage(usage.by_model, res.model_used?.model_id || model.model_id || model.id, res);
    if (res.tokensEstimated) usage.estimated = true;
    return res;
  };

  try {
    // Message-credit reservation BEFORE any agent model call, through the SAME flow Builder runs
    // use: balance + budget limits are checked and the worst case is held on the ledger. Keyed by
    // the agent run, so every later iteration re-attaches to this operation instead of reserving again.
    // Candidates are only resolved when the hold does not exist yet; later iterations re-attach.
    const openOp = await findOperation(svc, { workspace_id: run.workspace_id, idempotency_key: agentOperationKey(run) }).catch(() => null);
    const { operation: agentOperation } = await beginOperation(svc, {
      workspace_id: run.workspace_id, user_id: run.user_id, project_id: run.project_id, run_id: run.id,
      operation_type: "agent", model_id: model.model_id, gateway_provider: model.provider,
      idempotency_key: agentOperationKey(run), estimate: AGENT_RESERVATION_ESTIMATE, creditType: "message",
      ...(openOp ? {} : { candidate_model_ids: await agentCandidateModelIds(svc, run, policy, catalog, modelAccess) }),
    });
    agentOperationId = agentOperation?.id || null;
    while (true) {
      // Cooperative cancellation checkpoint: re-read the durable flag before every action,
      // so no new step (least of all a mutating one) starts after the user cancels.
      run = await svc.entities.AgentRun.get(agentRunId);
      if (AGENT_TERMINAL.includes(run.status)) return { agent_run_id: agentRunId, done: true, status: run.status };
      // Lost the lease (e.g. this worker stalled past its expiry): stop rather than
      // interleave steps with whoever took over.
      if (run.lease_token !== token) return { agent_run_id: agentRunId, done: false, busy: true, status: run.status };
      if (run.cancel_requested) {
        // Sub-agent propagation: a cancelled parent stops its background tasks at their next
        // safe checkpoint; their already-finished work is kept (terminal children untouched).
        await cancelSubagentsOf(svc, run.id).catch(() => null);
        await recordStep(svc, run, { action_type: "observe", source: "native", status: "cancelled", summary: "Cancelled by the user at a safe checkpoint." });
        return finalize(svc, run, { status: "CANCELLED", failure_code: "CANCELLED", result_summary: "The agent was cancelled before completing the goal. No further changes were made.", usage, model });
      }

      // Waiting on a delegated AI run: the pipeline owns build/repair/commit, the agent
      // only observes its outcome.
      if (run.parent_ai_run_id) {
        const child = await svc.entities.AIRun.get(run.parent_ai_run_id).catch(() => null);
        if (child && !AI_RUN_TERMINAL.includes(child.status)) {
          await patch({ status: "EXECUTING", current_phase: `builder run ${child.status.toLowerCase()}` });
          return { agent_run_id: agentRunId, done: false, waiting: true, status: run.status };
        }
        const changed = (child?.changed_files || []).map((c) => c.path);
        const ok = child?.status === "COMPLETED";
        await recordStep(svc, run, {
          action_type: "observe", source: "ai_run", tool: "aiRun", status: ok ? "done" : "failed", ai_run_id: run.parent_ai_run_id,
          summary: ok ? `Builder run finished${child.version_number ? ` as version ${child.version_number}` : " with no changes needed"}.` : "Builder run failed; nothing was committed.",
          result_summary: trunc(ok ? `changed: ${changed.join(", ") || "none"}` : `error: ${child?.error || "unknown"}`),
          error_code: ok ? null : "AI_RUN_FAILED",
        });
        await patch({
          parent_ai_run_id: null, status: "OBSERVING", current_step: run.current_step + 1,
          ...(child?.version_id ? { version_id: child.version_id, version_number: child.version_number } : {}),
        });
        if (overBudget()) return { agent_run_id: agentRunId, done: false, status: run.status };
        continue;
      }

      if (run.current_step >= run.max_steps) {
        return finalize(svc, run, { status: "FAILED", failure_code: "MAX_STEPS_EXCEEDED", error: `The agent reached its ${run.max_steps}-step limit`, result_summary: `Stopped after ${run.max_steps} steps without completing the goal. Committed project state is unchanged apart from any versions already created by completed builder runs.`, usage, model });
      }

      // Conversation seeding: the full observation block is built only when this invocation has no
      // live conversation (first decision of the invocation, or resumption after a delegated
      // builder run). A live conversation is CONTINUED — tool results were appended below — and
      // the per-call budget guard still runs for every decision call.
      if (!conversation) {
        project = await svc.entities.Project.get(run.project_id);
        const obs = await observationBlock(svc, run, project);
        ctx = obs.ctx; fs = obs.fs; state = obs.state;

        // E9: resolve the declared agent from the project's canonical files. A run naming an agent
        // the project does not declare fails closed instead of running unrestricted.
        agent = null; gate = null; agentBlock = "";
        if (run.agent_name) {
          agent = resolveAgent(state.files, run.agent_name);
          if (!agent) {
            return finalize(svc, run, { status: "FAILED", failure_code: "AGENT_NOT_FOUND", error: `The project declares no agent named '${run.agent_name}'`, result_summary: `The agent '${run.agent_name}' is not declared in this project (base44/agents/${run.agent_name}.jsonc), so nothing was run.`, usage, model });
          }
          gate = agentPermissionGate(agent);
          agentBlock = agentContextBlock(agent, agentSkillsBlock(resolveAgentSkills(state.files, agent)));   // E11
        }
        await patch({ status: run.current_step === 0 ? "PLANNING" : "RUNNING", current_phase: "deciding next action" });

        // Recovery reasoning gets the stronger tier; routine observation stays on fast.
        const lastStep = (await svc.entities.AgentStep.filter({ agent_run_id: run.id }, "-step_number", 1))[0];
        const recovering = lastStep && lastStep.status === "failed";
        // Routed choices use the same budget ceiling as the Builder, so no model beyond spendable credits is picked.
        const available = await agentCeiling(svc, run);
        choice = chooseAgentModel({ recovering, agent, goal: run.goal, fileCount: activeFiles(fs).length, ceiling: recovering || agent?.model_tier || (run.trigger_source === "schedule" && agent?.automations_model) ? null : available, modelAccess, triggerSource: run.trigger_source || null });
        model = choice.model;
        await patch({ model: model.name });
        // Custom Instructions (documented Base44: applies to EVERY interaction in this app):
        // the project's app-level guidance also rides the agent's own decision loop, appended
        // after the agent prompt. PROMPT GUIDANCE ONLY — gateAction, agentPermissionGate and
        // every tool authorization are unchanged, so the guidance can never lift a grant.
        // Mutations are delegated to Build runs, which carry the guidance through runPipeline.
        systemText = withCustomInstructions(systemPrompt(agentBlock), project.custom_instructions);
        conversation = [{ role: "user", content: obs.block }];
      }
      // Runtime budget guard + budget-aware chain, recomputed for EVERY decision call: the usage
      // so far plus the call's worst case must fit in the hold + what is still spendable, or the
      // run stops here and settles what it already used. The chain becomes the gateway's fallbacks.
      const resolved = await resolveAgentCallChain(svc, run, model, choice?.fallbacks || modelFallbacks, usage, policy, catalog, modelAccess);
      const guard = resolved.guard;
      modelFallbacks = resolved.chain;
      if (!guard.ok) {
        return finalize(svc, run, { status: "FAILED", failure_code: "BUDGET_EXHAUSTED", error: `Credit budget exhausted: ${guard.consumed} used + ${guard.next} for the next call exceeds ${guard.capacity} available`, result_summary: "The agent stopped because there are not enough credits left for its next step. Work already committed by completed builder runs is kept.", usage, model });
      }
      const res = await llm(systemText, conversation, AGENT_TOOLS);
      const calls = res.tool_calls || [];
      if (!calls.length) {
        // Fail closed: a tools request answered with no tool call is an unsupported shape, not an
        // action — the run stops instead of guessing an action from plain content.
        await recordStep(svc, run, { action_type: "observe", status: "failed", summary: trunc(res.output || "no action", 240), error_code: "TOOL_CALL_REQUIRED", result_summary: "the model returned no tool call for a tools request" });
        return finalize(svc, run, { status: "FAILED", failure_code: "TOOL_CALL_REQUIRED", error: "The AI Gateway returned no tool call for a tools request", result_summary: "The agent stopped because its model response carried no tool call.", usage, model });
      }
      // The assistant turn is appended ONCE, then every returned tool call executes in order and
      // its observed result is appended as the tool message — the conversation continues with
      // results instead of each action becoming a fresh full-context decision call.
      conversation.push({ role: "assistant", content: res.output || "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) });

      for (const call of calls) {
        if (run.current_step >= run.max_steps) break;   // the loop top finalizes MAX_STEPS_EXCEEDED
        const action = TOOL_TO_ACTION[call.name] || call.name;
        const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
        const summary = trunc(res.output || action, 240);
        const pushToolResult = (content) => conversation.push({ role: "tool", tool_call_id: call.id, content: String(content || "").slice(0, OBSERVATION_CHARS) });

        // E10: the agent's tool grants are enforced HERE, before any action executes. A refused
        // action is recorded as a failed step the agent observes, so it can choose a granted one.
        const denied = gateAction(gate, action);
        if (denied) {
          await recordStep(svc, run, { action_type: action || "observe", status: "failed", summary, error_code: denied.code, result_summary: trunc(denied.reason) });
          await patch({ current_step: run.current_step + 1, status: "OBSERVING" });
          pushToolResult(`REFUSED ${denied.code}: ${denied.reason}`);
          if (overBudget()) return { agent_run_id: agentRunId, done: false, status: run.status };
          continue;
        }

        const signature = JSON.stringify([action, args.path || "", args.query || "", args.connection || "", args.tool || "", trunc(args.instruction || "", 200), args.schedule_id || "", trunc(args.schedule_goal || "", 100), trunc(args.schedule_json || "", 100), trunc(args.tasks_json || "", 200)]);
        const prior = await svc.entities.AgentStep.filter({ agent_run_id: run.id, signature }, "-step_number", MAX_REPEATED_SIGNATURE);
        if (prior.length >= MAX_REPEATED_SIGNATURE) {
          await recordStep(svc, run, { action_type: action || "observe", status: "failed", summary, error_code: "AGENT_LOOP_DETECTED", signature, result_summary: "identical action already attempted 3 times" });
          return finalize(svc, run, { status: "FAILED", failure_code: "AGENT_LOOP_DETECTED", error: `The agent repeated the same action (${action}) without progress`, result_summary: "The agent kept repeating the same action without making progress, so it was stopped to avoid spending further credits.", usage, model });
        }

        if (action === "finish") {
          // Sub-agent combination (documented: "when all sub-agents finish, your Superagent
          // combines their work into a single response"): a finish while any background task
          // still runs is DEFERRED — the parent observes their outcomes instead of dropping them.
          const subsEarly = await subagentsStatus(svc, run).catch(() => null);
          if (subsEarly && subsEarly.running > 0) {
            await recordStep(svc, run, { action_type: "finish", source: "native", tool: "agentSubagents", status: "failed", signature, summary, error_code: "SUBAGENTS_RUNNING", result_summary: trunc(subsEarly.block, 600) });
            pushToolResult(trunc(`Sub-agents are still running (do not re-delegate the same tasks):\n${subsEarly.block}\nCall 'delegate_subagents' WITHOUT tasks_json to observe them; finish only once every task is terminal.`, 1000));
            break;
          }
          await patch({ status: "VERIFYING", current_phase: "verifying final state" });
          const verify = runBuild(fs, state.entities, state.secrets);
          const clean = verify.status === "success";
          await recordStep(svc, run, {
            action_type: "finish", source: "build", tool: "verify_build", status: clean ? "done" : "failed", signature,
            summary: clean ? "Verified the final project state builds cleanly." : "Verification found build errors.",
            result_summary: trunc(clean ? `${verify.file_count} files, 0 errors` : verify.logs.filter((l) => l.startsWith("error")).slice(0, 5).join(" | ")),
            error_code: clean ? null : "VERIFICATION_FAILED",
          });
          await patch({ current_step: run.current_step + 1, build_status: clean ? "success" : "failed", verification: clean ? `Build clean: ${verify.file_count} files, 0 errors` : `${verify.errors} build error(s)` });
          // A dirty final state is not a completion: keep working while budget remains.
          if (!clean && run.current_step < run.max_steps) {
            pushToolResult(trunc(verify.logs.filter((l) => l.startsWith("error")).slice(0, 5).join(" | "), 1000));
            break;
          }
          if (!clean) {
            return finalize(svc, run, { status: "FAILED", failure_code: "VERIFICATION_FAILED", error: `${verify.errors} build error(s) remain`, result_summary: trunc(args.result_summary || "", 1200) + `\n\nVerification failed: ${verify.errors} build error(s) remain in the committed project.`, usage, model, extra: { build_status: "failed" } });
          }
          // Runtime verification — the SAME verifier, call shape and condition as the Builder build
          // phase: it runs whenever the static build is clean, for every project, over the committed state.
          let runtimeNote = "";
          {
            await patch({ current_phase: "verifying runtime" });
            const runtime = await verifyProjectRuntime(svc, { project, fs, entities: state.entities, secrets: state.secrets, trace_id: traceId, run_id: run.id }).catch((e) => ({
              ok: false, category: "RUNTIME_ERROR", diagnostics: [`RUNTIME_ERROR verifier: ${e.message}`], checks: [],
            }));
            const runtimeDetail = (runtime.diagnostics || []).slice(0, 5).join(" | ");
            await recordStep(svc, run, {
              action_type: "finish", source: "build", tool: "verify_runtime", status: runtime.ok ? "done" : "failed", trace_id: traceId,
              summary: runtime.ok ? "Verified the final project state runs." : "Runtime verification found failures.",
              result_summary: trunc(runtime.ok ? `${(runtime.checks || []).length} runtime check(s) passed` : runtimeDetail),
              error_code: runtime.ok ? null : "RUNTIME_VERIFICATION_FAILED",
            });
            if (!runtime.ok) {
              return finalize(svc, run, {
                status: "FAILED", failure_code: "RUNTIME_VERIFICATION_FAILED", error: trunc(runtimeDetail || runtime.category || "runtime verification failed", 1000),
                result_summary: `${trunc(args.result_summary || summary, 1000)}\n\nThe project builds, but runtime verification failed (${runtime.category || "RUNTIME_ERROR"}), so the goal is not reported as complete.\n${runtimeDetail}`,
                usage, model, extra: { build_status: "failed", verification: trunc(`Build clean, runtime failed: ${runtimeDetail}`, 1000) },
              });
            }
            runtimeNote = ` · ${(runtime.checks || []).length} runtime check(s) passed`;
          }
          // Delegated Builder outcomes: the agent may only claim completion when every builder run
          // it delegated actually completed. Read-only — builder run states are never changed here.
          const children = (await Promise.all((run.ai_run_ids || []).map((id) => svc.entities.AIRun.get(id).catch(() => null)))).filter(Boolean);
          const succeeded = children.filter((c) => c.status === "COMPLETED");
          const unsuccessful = children.filter((c) => ["FAILED", "CANCELLED", "STALE"].includes(c.status));
          if (unsuccessful.length) {
            const partial = succeeded.length > 0;
            const reasons = unsuccessful.map((c) => `builder run ${c.id} ${c.status.toLowerCase()}${c.error ? `: ${trunc(c.error, 200)}` : ""}`).join("\n");
            return finalize(svc, run, {
              status: "FAILED", failure_code: partial ? "PARTIALLY_FAILED" : "BUILDER_RUN_FAILED",
              error: trunc(reasons, 1000),
              result_summary: `${trunc(args.result_summary || summary, 1000)}\n\n${partial ? `Partially completed: ${succeeded.length} of ${children.length} builder run(s) succeeded.` : `None of the ${children.length} builder run(s) succeeded.`}\n${reasons}`,
              usage, model, extra: { build_status: "success" },
            });
          }
          // Sub-agent outcome propagation at completion: failed/cancelled background tasks are
          // reported in the parent's result (kept work is not lost); an ALL-failed delegation
          // fails the parent instead of claiming completion.
          const subs = await subagentsStatus(svc, run).catch(() => null);
          if (subs && subs.total > 0 && !subs.completed && (subs.failed || subs.cancelled)) {
            return finalize(svc, run, { status: "FAILED", failure_code: "SUBAGENT_FAILED", error: `all ${subs.total} sub-agent task(s) ended without completing`, result_summary: `${trunc(args.result_summary || summary, 1000)}\n\n${subs.block}`, usage, model });
          }
          const subNote = subs && subs.total
            ? `\n\nSub-agents: ${subs.completed}/${subs.total} completed${subs.failed ? `, ${subs.failed} failed` : ""}${subs.cancelled ? `, ${subs.cancelled} cancelled` : ""}${subs.failed ? `\n${subs.block}` : ""}`
            : "";
          const finalProject = await svc.entities.Project.get(run.project_id);
          return finalize(svc, run, {
            status: "COMPLETED", result_summary: trunc(`${args.result_summary || summary}${subNote}`, 2000), usage, model,
            extra: { build_status: "success", verification: `Build clean: ${verify.file_count} files, 0 errors${runtimeNote}`, version_number: finalProject.version_count || run.version_number || null },
          });
        }

        if (action === "verify_build") {
          const verify = runBuild(fs, state.entities, state.secrets);
          await recordStep(svc, run, {
            action_type: "verify_build", source: "build", tool: "buildEngine", status: "done", signature, summary,
            result_summary: trunc(verify.status === "success" ? `build success, ${verify.file_count} files` : verify.logs.filter((l) => l.startsWith("error")).slice(0, 6).join(" | ")),
          });
          await patch({ current_step: run.current_step + 1, build_status: verify.status === "success" ? "success" : "failed", status: "OBSERVING" });
          pushToolResult(trunc(verify.status === "success" ? `build success, ${verify.file_count} files` : verify.logs.filter((l) => l.startsWith("error")).slice(0, 6).join(" | ")));
          if (overBudget()) return { agent_run_id: agentRunId, done: false, status: run.status };
          continue;
        }

        // Sub-agents (docs.base44.com/superagents/subagents): the documented parallel background
        // delegation. Children are REAL AgentRun rows driven by the SAME executor, lease and
        // per-run usage settlement — this action only creates or observes them.
        if (action === "delegate_subagents") {
          const outcome = await delegateSubagents(svc, { run, tasksJson: args.tasks_json || "", traceId });
          await recordStep(svc, run, {
            action_type: "delegate_subagents", source: "native", tool: "agentSubagents",
            status: outcome.ok ? "done" : "failed", signature, summary,
            result_summary: trunc(outcome.summary || (outcome.ok ? "" : `refused ${outcome.code}`), 600),
            error_code: outcome.ok ? null : (outcome.code || "DELEGATION_FAILED"),
          });
          await patch({ current_step: run.current_step + 1, status: "OBSERVING" });
          pushToolResult(trunc(outcome.summary || `REFUSED ${outcome.code}: ${outcome.message || ""}`, 1000));
          if (overBudget()) return { agent_run_id: agentRunId, done: false, status: run.status };
          continue;
        }

        if (action === "edit_project") {
          const instruction = trunc(args.instruction || "", 6000);
          if (!instruction) {
            await recordStep(svc, run, { action_type: "edit_project", source: "ai_run", status: "failed", signature, summary, error_code: "MISSING_INSTRUCTION", result_summary: "no instruction supplied" });
            await patch({ current_step: run.current_step + 1 });
            pushToolResult("edit_project refused: no instruction supplied");
            continue;
          }
          // Delegation point: the existing pipeline performs the mutation, build, repair,
          // commit and versioning, with its own concurrency guard and credit accounting.
          try {
            // A worker killed between enqueue and checkpoint leaves an orphaned builder run.
            // Adopt it instead of queueing a second mutation for the same logical step.
            // Only runs THIS agent run delegated are adoptable — never an unrelated Builder run.
            const orphan = (await svc.entities.AIRun.filter({ project_id: project.id, parent_agent_run_id: run.id }, "-created_date", 5)).find((r) => !AI_RUN_TERMINAL.includes(r.status));
            const child = orphan
              ? { run_id: orphan.id, reused_existing: true }
              // The same validated reference images are handed to every delegated builder run, so the
              // visual reference survives the whole episode instead of stopping at the agent.
              : await enqueueRun(svc, { project, prompt: instruction, mode: "default", initiatedByUserId: run.user_id || null, parentAgentRunId: run.id, ...(run.image_urls?.length ? { imageUrls: run.image_urls } : {}) });
            await recordStep(svc, run, {
              action_type: "edit_project", source: "ai_run", tool: "aiRun", status: "running", signature, ai_run_id: child.run_id,
              summary, input_summary: trunc(instruction, 400), result_summary: child.reused_existing ? "reused the in-flight builder run for this instruction" : "builder run queued",
            });
            await patch({ parent_ai_run_id: child.run_id, ai_run_ids: [...(run.ai_run_ids || []), child.run_id], status: "EXECUTING", current_phase: "builder run queued" });
            pushToolResult(child.reused_existing ? "reused the in-flight builder run for this instruction" : "builder run queued");
          } catch (e) {
            await recordStep(svc, run, { action_type: "edit_project", source: "ai_run", status: "failed", signature, summary, error_code: e.code || "ENQUEUE_FAILED", result_summary: trunc(e.message) });
            await patch({ current_step: run.current_step + 1 });
            pushToolResult(`builder run enqueue failed: ${trunc(e.message, 200)}`);
          }
          return { agent_run_id: agentRunId, done: false, waiting: true, status: run.status };
        }

        // Scheduled Superagent automations (Phase 16C-4D): the Base44-evidenced surface — the
        // agent itself creates, edits, pauses, resumes, archives and restores the project's
        // schedules in chat. Execution is the member-authorized lifecycle in agentSchedules.ts,
        // resolved from the run's persisted owner identity — the same trust model the tool
        // session re-derives, with the same audit primitive and no second CRUD architecture.
        if (SCHEDULE_ACTION_TOOL[action]) {
          const input = {};
          let outcome = null, failure = null;
          try {
            let def = {};
            if (args.schedule_json) {
              try { def = JSON.parse(args.schedule_json); } catch { throw Object.assign(new Error("schedule_json must be valid JSON"), { code: "SCHEDULE_INVALID" }); }
              if (!def || typeof def !== "object" || Array.isArray(def)) throw Object.assign(new Error("schedule_json must be a JSON object"), { code: "SCHEDULE_INVALID" });
            }
            input.project_id = run.project_id;
            if (action === "create_schedule") {
              input.goal = String(args.schedule_goal || "").trim();
              Object.assign(input, def);
              if (args.agent_name) input.agent_name = args.agent_name;
            } else {
              if (!args.schedule_id) throw Object.assign(new Error("schedule_id is required"), { code: "SCHEDULE_INVALID" });
              input.schedule_id = String(args.schedule_id);
              if (action === "update_schedule") {
                if (args.schedule_goal) input.goal = args.schedule_goal;
                if (args.agent_name) input.agent_name = args.agent_name;
                Object.assign(input, def);
              }
            }
            outcome = await SCHEDULE_OPS[action](svc, { id: run.user_id ?? null, email: null }, input);
          } catch (e) {
            failure = { code: e.code || "SCHEDULE_OP_FAILED", message: e.message };
          }
          await recordStep(svc, run, {
            action_type: action, source: "native", tool: SCHEDULE_ACTION_TOOL[action], trace_id: traceId,
            status: failure ? "failed" : "done", signature, summary,
            input_summary: trunc(JSON.stringify(input), 300),
            result_summary: failure ? trunc(failure.message) : trunc(JSON.stringify(outcome), OBSERVATION_CHARS),
            error_code: failure ? failure.code : null,
          });
          await patch({ current_step: run.current_step + 1, status: "OBSERVING", current_phase: summary });
          pushToolResult(failure ? `${failure.code}: ${failure.message}` : trunc(JSON.stringify(outcome), OBSERVATION_CHARS));
          if (overBudget()) return { agent_run_id: agentRunId, done: false, status: run.status };
          continue;
        }

        const toolName = READ_TOOL[action];
        if (!toolName) {
          await recordStep(svc, run, { action_type: action || "observe", status: "failed", summary, error_code: "UNKNOWN_ACTION", result_summary: `unsupported action '${action}'` });
          await patch({ current_step: run.current_step + 1 });
          pushToolResult(`unsupported action '${action}'`);
          continue;
        }

        // Every agent tool call goes through the SAME Tool Router boundary as Builder runs: project/
        // workspace ownership, the initiating user's current role, the read-only "discuss" mode and the
        // tool's capability are all checked before the handler runs, and the same span/audit rows are
        // written. The session's tool span becomes ctx.trace.parent_span_id for any MCP child call.
        const workspace = await svc.entities.Workspace.get(project.workspace_id);
        const session = await createAgentToolSession(svc, { agentRun: run, project, workspace, trace: { trace_id: traceId } });
        // MCP goes through the existing account-scoped client with mode "discuss", which
        // enforces read-only tools — mutating external actions stay behind approval.
        if (action === "mcp_call") {
          ctx.mcp = {
            connections: [],
            call: (a) => invokeMcpTool(svc, { workspace_id: run.workspace_id, project_id: run.project_id, run_id: run.id, user_id: run.user_id, mode: "discuss", trigger: "builder_run", trace_id: traceId, parent_span_id: ctx.trace?.parent_span_id || null }, a),
          };
        }
        const input = { path: args.path, query: args.query, connection: args.connection, tool: args.tool, arguments_json: args.arguments_json };
        const toolRes = await session.call(toolName, input, ctx);
        const resultText = toolRes.ok ? JSON.stringify(toolRes.result) : toolRes.error;
        await recordStep(svc, run, {
          action_type: action, source: action === "mcp_call" ? "mcp" : "native", tool: toolName, status: toolRes.ok ? "done" : "failed", trace_id: traceId,
          signature, summary, input_summary: trunc(JSON.stringify(input), 300), result_summary: trunc(resultText, OBSERVATION_CHARS),
          error_code: toolRes.ok ? null : (toolRes.code || "TOOL_FAILED"),
        });
        await patch({ current_step: run.current_step + 1, status: "OBSERVING", current_phase: summary });
        pushToolResult(toolRes.ok ? resultText : `TOOL_FAILED: ${resultText}`);
        if (overBudget()) return { agent_run_id: agentRunId, done: false, status: run.status };
      }

      if (overBudget()) return { agent_run_id: agentRunId, done: false, status: run.status };
    }
  } catch (e) {
    return finalize(svc, run, { status: "FAILED", failure_code: "AGENT_ERROR", error: e.message, result_summary: `The agent stopped because of an internal error: ${trunc(e.message, 300)}`, usage, model });
  } finally {
    // Every early return (Builder wait, budget pause, lost lease, busy) passes through here, so
    // the running totals are persisted BEFORE the lease is handed back.
    await persistUsage(svc, agentRunId, token, usage);
    // Always hand the run back: the next workflow invocation (or a retry) can claim it.
    await releaseLease(svc, agentRunId);
  }
}