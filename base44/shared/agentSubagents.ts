// Superagent sub-agents — Batch 2. Evidence-driven (READ-ONLY audit of docs.base44.com before
// any edit), never assumptions:
//   • VERIFIED (docs.base44.com, Working with sub-agents): a Superagent "handle[s] complex
//     requests by working on multiple tasks at the same time" in the background; the member
//     keeps chatting and follows each task in the task panel; "when all sub-agents finish,
//     your Superagent combines their work into a single response"; stopping the work keeps
//     "any work the sub-agents already finished"; "Running several sub-agents at the same time
//     can use more credits because your Superagent completes multiple parts of your request in
//     parallel"; sub-agents don't automatically save their work (results stay in chat).
//   • Base44 publishes NO sub-agent protocol beyond that UX (UNKNOWN: the model-facing action
//     name, the internal run shape, the panel transport). What IS certified here is therefore
//     the NexusAI-native form the user contract requires: parent/child AGENTRUN lifecycle on
//     the EXISTING AgentRun/AgentStep/executor contracts — children are real AgentRun rows the
//     deployed "Agent Executor" workflow drives with its own lease, step budget and per-run
//     usage settlement, so delegation is real parallel background execution with credit and
//     lease isolation and NO new execution engine. Nothing here touches the certified Agent
//     Executor, scheduler, Files, Data, MCP or Voice contracts.
import { AGENT_TERMINAL } from "./agentConstants.ts";
import { audit } from "./authz.ts";
import { scrubText } from "./tracing.ts";

export const SUBAGENT_MAX_TASKS = 5;               // one delegation = at most 5 parallel tasks
export const SUBAGENT_MAX_DELEGATION_DEPTH = 1;    // children may NOT delegate further
export const SUBAGENT_GOAL_MAX_CHARS = 500;        // one task's goal, scrubbed

const trunc = (s, n) => scrubText(String(s ?? ""), n);
const childLine = (c) =>
  `#${String(c.id || "").slice(-6)} [${c.status}] ${trunc(c.goal, 120)}${c.result_summary ? ` — ${trunc(c.result_summary, 200)}` : ""}`;

/**
 * Delegates independent background tasks as CHILD AgentRun rows, or (without tasks) reports the
 * parent's sub-agent statuses. NEVER throws for input problems — the loop turns a refusal into
 * a failed step observation: { ok: false, code, message }. Delegating returns
 * { ok: true, mode: "delegated", tasks: [{ id, goal }], summary }.
 */
export async function delegateSubagents(svc, { run, tasksJson, traceId = null } = {}) {
  const depth = Number(run?.delegation_depth) || 0;
  // Recursion guard: the documented capability is a Superagent splitting ONE request into
  // parallel tasks — a sub-agent delegating further is refused deterministically.
  if (depth >= SUBAGENT_MAX_DELEGATION_DEPTH) {
    return { ok: false, code: "DELEGATION_DEPTH_EXCEEDED", message: "a sub-agent cannot delegate further tasks" };
  }
  const raw = String(tasksJson ?? "").trim();
  // Status mode: no tasks requested — the parent observes its already-delegated tasks.
  if (!raw) {
    const st = await subagentsStatus(svc, run);
    const summary = st.total
      ? `sub-agents (${st.total}): ${st.completed} completed, ${st.failed} failed, ${st.cancelled} cancelled, ${st.running} running${st.block ? `\n${st.block}` : ""}`
      : "no sub-agent tasks delegated yet";
    return { ok: true, mode: "status", ...st, summary };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const tasks = Array.isArray(parsed) ? parsed : null;
  if (!tasks || !tasks.length || tasks.length > SUBAGENT_MAX_TASKS) {
    return { ok: false, code: "SUBAGENT_TASKS_INVALID", message: `delegate 1–${SUBAGENT_MAX_TASKS} tasks as a JSON array of { "goal": "..." }` };
  }
  const goals = tasks.map((t) => trunc(typeof t === "string" ? t : t?.goal, SUBAGENT_GOAL_MAX_CHARS).trim());
  if (goals.some((g) => !g)) {
    return { ok: false, code: "SUBAGENT_TASKS_INVALID", message: "every task needs a non-empty goal" };
  }
  const now = new Date().toISOString();
  const children = await svc.entities.AgentRun.bulkCreate(goals.map((goal) => ({
    project_id: run.project_id, workspace_id: run.workspace_id, user_id: run.user_id,
    ...(run.agent_name ? { agent_name: run.agent_name } : {}),
    goal, status: "QUEUED", current_phase: "queued (sub-agent)", current_step: 0,
    max_steps: Math.min(Number(run.max_steps) || 20, 20),
    cancel_requested: false, started_at: now, heartbeat_at: now,
    trace_id: run.trace_id || traceId || null,
    parent_agent_run_id: run.id, delegation_depth: depth + 1,
  })));
  for (const child of children) {
    await audit(svc, {
      workspace_id: run.workspace_id, project_id: run.project_id, user_id: run.user_id,
      action: "agent.subagents.delegated", resource: "AgentRun", resource_id: child.id,
      metadata: { parent: run.id, depth: depth + 1, goal: goal_preview(child.goal) },
    }).catch(() => null);
  }
  return {
    ok: true, mode: "delegated",
    tasks: children.map((c) => ({ id: c.id, goal: trunc(c.goal, 120) })),
    summary: `delegated ${children.length} background task(s) to sub-agents:\n${children.map(childLine).join("\n")}\nThey run in parallel; observe them with 'delegate_subagents' (no tasks_json) and finish only once every task is terminal.`,
  };
}

const goal_preview = (g) => trunc(g, 200);

/** The parent's sub-agent task panel, persisted: child rows + terminal counts + a bounded block. */
export async function subagentsStatus(svc, run) {
  const children = await svc.entities.AgentRun.filter(
    { parent_agent_run_id: run.id }, "created_date", SUBAGENT_MAX_TASKS,
  ).catch(() => []);
  const completed = children.filter((c) => c.status === "COMPLETED");
  const failed = children.filter((c) => c.status === "FAILED" || c.status === "STALE");
  const cancelled = children.filter((c) => c.status === "CANCELLED");
  const running = children.filter((c) => !AGENT_TERMINAL.includes(c.status));
  return {
    total: children.length, completed: completed.length, failed: failed.length,
    cancelled: cancelled.length, running: running.length,
    block: children.map(childLine).join("\n"), children,
  };
}

/**
 * Stop propagation (the documented stop icon): the parent's NON-TERMINAL sub-agents are marked
 * cancel_requested — each is stopped by its own loop at the next safe checkpoint, and any work
 * already finished is kept (their terminal rows are never touched).
 */
export async function cancelSubagentsOf(svc, parentRunId) {
  const children = await svc.entities.AgentRun.filter(
    { parent_agent_run_id: String(parentRunId || "") }, "created_date", SUBAGENT_MAX_TASKS,
  ).catch(() => []);
  let stopped = 0;
  for (const child of children) {
    if (AGENT_TERMINAL.includes(child.status)) continue;
    await svc.entities.AgentRun.update(child.id, { cancel_requested: true, current_phase: "cancelling" }).catch(() => null);
    stopped++;
  }
  return { stopped, total: children.length };
}