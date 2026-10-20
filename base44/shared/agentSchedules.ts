// Scheduled Superagent automations (Phase 16C-4): a THIN adapter that turns a schedule into an
// existing AgentRun, and nothing more.
//
//   AgentSchedule → (this sweep) → AgentRun QUEUED → THE certified Agent Executor
//
// Every primitive here is borrowed, never re-implemented:
//   • cron / timezone ........ shared/cron.ts (parseCron / nextRunInZone) — no second cron engine
//   • schedule semantics ..... mirrored from the CERTIFIED ScheduledTrigger sweep (one-time,
//     interval, ends never/on/after, enabled/pause/resume, next_run_at) — the shapes match so
//     the two schedulers behave identically; the certified scheduler.ts is untouched
//   • lifecycle gate ......... rbac.requireActiveWorkspace (G-2), re-checked at EVERY tick
//   • agent validation ....... agentResource.resolveAgent fail-closed, exactly like agentRun
//   • enqueue ................ AgentRun QUEUED — the ONE record the certified Agent Executor
//     triggers on; no second execution engine, no duplicate of AgentRun execution
//   • credits/model .......... nothing added here: the certified agentLoop owns the reservation,
//     budget guard, model access and settlement for the run it picks up
//   • failure pause .......... the DOCUMENTED (Base44, Superagent workflows) 5-consecutive-failure
//     pause + notification, written through the EXISTING audit primitive
//   • claim/idempotency ...... one conditional-update claim slot on AgentSchedule itself (the
//     certified deploy.ts claim pattern) — exactly one AgentRun per due occurrence
//
// SECURITY MODEL — a scheduled agent run is NEVER anonymous:
//   • the fire enqueues with user_id = owner_user_id (the DOCUMENTED background identity),
//     so the agent loop's credit, budget, model-access and audit gates all run as the owner;
//   • the workspace lifecycle gate fails closed: a suspended/terminated workspace records a
//     skipped, non-started occurrence and enqueues nothing.
import { parseCron, nextRunInZone } from "./cron.ts";
import { loadProjectState, loadAuthorizedProject, audit } from "./authz.ts";
import { requireActiveWorkspace } from "./rbac.ts";
import { resolveAgent } from "./agentResource.ts";
import { AGENT_TERMINAL } from "./agentConstants.ts";

const SWEEP_LIMIT = 500;          // maximum schedules examined per tick (query cap)
const SWEEP_BATCH = 20;           // schedules processed per tick
const SWEEP_DEADLINE_MS = 40000;  // wall-clock budget for one tick (mirrors the certified sweep)
// DOCUMENTED (Base44, Superagent workflows): workflows that fail repeatedly are paused
// automatically and the user is notified.
const FAILURE_PAUSE_THRESHOLD = 5;
// The same enqueue ceilings as the certified agentRun contract.
const MAX_STEPS_CEILING = 20;
const GOAL_MAX_CHARS = 4000;

const trunc = (v, n = 500) => String(v ?? "").slice(0, n);

// Next due time for a schedule, computed from `after` — the certified ScheduledTrigger shape,
// on top of the certified cron helpers. One-time fires at the fixed instant; interval adds
// seconds; cron is evaluated in the schedule's timezone.
export function computeNextRun(schedule, after) {
  if (schedule.one_time_at) {
    const t = Date.parse(schedule.one_time_at);
    if (!Number.isFinite(t)) return null;
    return t > after.getTime() ? new Date(t) : null;
  }
  const interval = Number(schedule.interval_seconds);
  if (Number.isFinite(interval) && interval > 0) {
    return new Date(after.getTime() + interval * 1000);
  }
  if (schedule.cron) {
    return nextRunInZone(parseCron(schedule.cron), after, schedule.timezone || "UTC");
  }
  return null; // no schedule configured
}

// Terminal bookkeeping, mirroring the certified scheduler's endPatch: the failure streak, the
// fired-run count, and the DOCUMENTED schedule lifecycle (one-time ends after it fires; ends
// on/after archive the schedule; 5 consecutive failures pause it). A skipped occurrence (e.g.
// AGENT_ALREADY_RUNNING or an inactive workspace) is a NON-started occurrence: it never
// increments the failure counter.
function endPatch(schedule, status, error, next, extra = {}) {
  const failed = status === "failed" || status === "timeout";
  const failures = failed ? (Number(schedule.consecutive_failures) || 0) + 1 : 0;
  const runCount = (Number(schedule.run_count) || 0) + (status === "skipped" ? 0 : 1);
  const patch = {
    ...extra,
    consecutive_failures: failures, run_count: runCount,
    last_status: status, last_error: status === "success" ? null : (error || null),
  };
  if (next !== undefined) patch.next_run_at = next ? next.toISOString() : null;
  let pause = null;
  if (status !== "skipped") {
    if (schedule.one_time_at) pause = "completed";
    else if (String(schedule.ends_type || "never") === "after" && Number(schedule.ends_after_count) > 0 && runCount >= Number(schedule.ends_after_count)) pause = "schedule_ended";
    else if (String(schedule.ends_type || "never") === "on" && schedule.ends_on_date && next && Number.isFinite(Date.parse(schedule.ends_on_date)) && next.getTime() > Date.parse(schedule.ends_on_date)) pause = "schedule_ended";
    else if (failures >= FAILURE_PAUSE_THRESHOLD) pause = "consecutive_failures";
  }
  if (pause) { patch.enabled = false; patch.next_run_at = null; patch.paused_reason = pause; }
  return { patch, pause };
}

// The pause/ended notification — written to the EXISTING audit surface the builder's
// notifications view reads, exactly like the certified scheduler's notification.
async function notifySchedulePaused(svc, schedule, reason, error) {
  await audit(svc, {
    workspace_id: schedule.workspace_id, project_id: schedule.project_id, user_id: null,
    action: reason === "consecutive_failures" ? "agent_schedule.paused" : "agent_schedule.ended",
    resource: "AgentSchedule", resource_id: schedule.id,
    metadata: { goal: trunc(schedule.goal, 200), agent_name: schedule.agent_name || null, reason, error: error ? String(error).slice(0, 200) : null },
  });
}

// Skipped, non-started occurrence: keep the slot for a one-time schedule (it still fires once
// the blocker clears), otherwise reschedule forward. The claim is RELEASED, so the next tick
// can re-attempt the same one-time occurrence once the blocker clears; for a recurring
// schedule next_run_at has already advanced past it, so the released slot can never re-fire
// the abandoned occurrence. Never a failure increment.
async function recordSkipped(svc, schedule, reason) {
  const next = schedule.one_time_at && schedule.next_run_at && Number.isFinite(Date.parse(schedule.next_run_at))
    ? new Date(Date.parse(schedule.next_run_at))
    : computeNextRun(schedule, new Date());
  const { patch, pause } = endPatch(schedule, "skipped", reason, next);
  await svc.entities.AgentSchedule.update(schedule.id, { ...patch, last_claimed_key: "" });
  if (pause) await notifySchedulePaused(svc, schedule, pause, reason).catch(() => {});
  return { schedule_id: schedule.id, skipped: reason, ...(pause ? { paused: pause } : {}) };
}

// Advance one schedule as far as possible. Every meaningful transition is persisted, so a
// killed worker resumes cleanly on the next tick.
async function processOne(svc, schedule, now) {
  // Ensure next_run_at exists (new schedules start uncomputed).
  if (!schedule.next_run_at || !Number.isFinite(Date.parse(schedule.next_run_at))) {
    const base = schedule.created_date ? new Date(schedule.created_date) : now;
    const computed = computeNextRun(schedule, base);
    if (!computed) return { schedule_id: schedule.id, skipped: "no_schedule" };
    await svc.entities.AgentSchedule.update(schedule.id, { next_run_at: computed.toISOString() });
    schedule.next_run_at = computed.toISOString();
  }

  const dueMs = Date.parse(schedule.next_run_at);
  if (!Number.isFinite(dueMs) || dueMs > now.getTime()) return { schedule_id: schedule.id, not_due: true };

  // An ENDED schedule never fires again: the end date is inclusive; a fulfilled
  // ends_after_count blocks further fires (certified ScheduledTrigger semantics).
  const endsType = String(schedule.ends_type || "never");
  if (endsType === "on" && schedule.ends_on_date && Number.isFinite(Date.parse(schedule.ends_on_date)) && dueMs > Date.parse(schedule.ends_on_date)) {
    await svc.entities.AgentSchedule.update(schedule.id, { enabled: false, next_run_at: null, paused_reason: "schedule_ended" });
    return { schedule_id: schedule.id, paused: "schedule_ended" };
  }
  if (endsType === "after" && Number(schedule.ends_after_count) > 0 && (Number(schedule.run_count) || 0) >= Number(schedule.ends_after_count)) {
    await svc.entities.AgentSchedule.update(schedule.id, { enabled: false, next_run_at: null, paused_reason: "schedule_ended" });
    return { schedule_id: schedule.id, paused: "schedule_ended" };
  }

  const scheduledAt = new Date(dueMs).toISOString();
  const key = `schedule:${schedule.id}:${scheduledAt}`;

  // IDEMPOTENT CLAIM: exactly ONE enqueue per due occurrence. The single claim slot on this
  // schedule is taken by an atomic conditional update (the certified deploy.ts claim pattern) —
  // a duplicate or concurrent tick that loses the race updates zero rows and moves on. The
  // certified ScheduledRun store is deliberately NOT used as the claim store: its rows mean a
  // generic-scheduler FUNCTION execution, and writing agent rows there would change its
  // certified semantics.
  const oldKey = schedule.last_claimed_key || "";
  if (oldKey === key) {
    // Redundant tick for an already-claimed occurrence — idempotently re-advance; for a
    // one-time schedule that occurrence already fired, so the schedule ends here.
    if (schedule.one_time_at) {
      await svc.entities.AgentSchedule.update(schedule.id, { enabled: false, next_run_at: null, paused_reason: "completed" });
      return { schedule_id: schedule.id, duplicate: "already_done", paused: "completed" };
    }
    const computed = computeNextRun(schedule, now);
    await svc.entities.AgentSchedule.update(schedule.id, { next_run_at: computed ? computed.toISOString() : null });
    return { schedule_id: schedule.id, duplicate: "already_done" };
  }
  const claim = await svc.entities.AgentSchedule.updateMany(
    { id: schedule.id, last_claimed_key: oldKey },
    { $set: { last_claimed_key: key, last_status: "running", last_error: null } },
  ).catch(() => null);
  if (!Number(claim?.updated || 0)) return { schedule_id: schedule.id, duplicate: "lost_race" };

  // Lifecycle + authorization boundary, re-checked at EVERY tick. A missing or archived
  // project, or a suspended/terminated workspace, records a skipped, NON-started occurrence
  // (no failure increment) and enqueues nothing.
  const project = await svc.entities.Project.get(schedule.project_id).catch(() => null);
  if (!project || project.status === "archived") {
    return recordSkipped(svc, schedule, project ? "project_archived" : "project_not_found");
  }
  const workspace = await svc.entities.Workspace.get(project.workspace_id).catch(() => null);
  if (!workspace) return recordSkipped(svc, schedule, "workspace_not_found");
  try {
    // G-2 lifecycle gate, the SAME choke-point rule every mutating surface funnels through.
    requireActiveWorkspace(workspace, "project.write");
  } catch {
    return recordSkipped(svc, schedule, `workspace_${workspace.status || "inactive"}`);
  }

  // Fixed goal, bounded exactly like the certified agentRun enqueue contract.
  const goal = String(schedule.goal || "").trim();
  if (!goal || goal.length > GOAL_MAX_CHARS) {
    const next = schedule.one_time_at ? new Date(dueMs) : computeNextRun(schedule, now);
    const { patch, pause } = endPatch(schedule, "failed", goal ? `goal exceeds ${GOAL_MAX_CHARS} characters` : "empty goal", next);
    await svc.entities.AgentSchedule.update(schedule.id, patch);
    if (pause) await notifySchedulePaused(svc, schedule, pause, patch.last_error).catch(() => {});
    return { schedule_id: schedule.id, failed: "invalid_goal", ...(pause ? { paused: pause } : {}) };
  }

  // Optional declared agent, validated fail-closed against the project's OWN files at EVERY
  // tick (the same E9 rule the certified enqueue path applies).
  let agent = null;
  if (schedule.agent_name) {
    const state = await loadProjectState(svc, schedule.project_id);
    agent = resolveAgent(state.files, String(schedule.agent_name));
    if (!agent) {
      const next = schedule.one_time_at ? new Date(dueMs) : computeNextRun(schedule, now);
      const { patch, pause } = endPatch(schedule, "failed", `the project declares no agent named '${schedule.agent_name}'`, next);
      await svc.entities.AgentSchedule.update(schedule.id, patch);
      if (pause) await notifySchedulePaused(svc, schedule, pause, patch.last_error).catch(() => {});
      return { schedule_id: schedule.id, failed: "AGENT_NOT_FOUND", ...(pause ? { paused: pause } : {}) };
    }
  }

  // Reuse the project's concurrency posture — the SAME one-agent-per-project rule the
  // certified enqueue contract enforces. A busy project is a SKIPPED, non-started
  // occurrence: never a failure increment.
  const active = (await svc.entities.AgentRun.filter({ project_id: project.id }, "-created_date", 10)).find((r) => !AGENT_TERMINAL.includes(r.status));
  if (active) return recordSkipped(svc, schedule, "AGENT_ALREADY_RUNNING");

  // THE enqueue: one AgentRun QUEUED — the exact record the certified Agent Executor triggers
  // on (entity create, status QUEUED). No second execution engine; the loop's own credit
  // reservation, budget guard and model-access gates apply to the run under the OWNER identity.
  const firedAt = new Date().toISOString();
  let agentRun;
  try {
    agentRun = await svc.entities.AgentRun.create({
      project_id: project.id, workspace_id: project.workspace_id, user_id: schedule.owner_user_id, goal,
      trigger_source: "schedule",
      ...(agent ? { agent_name: agent.name } : {}),
      status: "QUEUED", current_phase: "queued", current_step: 0,
      max_steps: agent?.max_steps ? Math.min(agent.max_steps, MAX_STEPS_CEILING) : MAX_STEPS_CEILING,
      cancel_requested: false, started_at: firedAt, heartbeat_at: firedAt,
    });
  } catch (e) {
    const next = schedule.one_time_at ? new Date(dueMs) : computeNextRun(schedule, now);
    const { patch, pause } = endPatch(schedule, "failed", trunc(e?.message || String(e), 200), next);
    await svc.entities.AgentSchedule.update(schedule.id, patch);
    if (pause) await notifySchedulePaused(svc, schedule, pause, patch.last_error).catch(() => {});
    return { schedule_id: schedule.id, failed: "ENQUEUE_FAILED", ...(pause ? { paused: pause } : {}) };
  }

  // Existing audit primitive: the fire is recorded like every other scheduled/surface action.
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: schedule.owner_user_id,
    action: "agent_schedule.fired", resource: "AgentSchedule", resource_id: schedule.id,
    metadata: { goal: trunc(goal, 200), agent_name: agent?.name || null, agent_run_id: agentRun.id, scheduled_at: scheduledAt },
  });

  const next = schedule.one_time_at ? null : computeNextRun(schedule, now);
  const { patch, pause } = endPatch(schedule, "success", null, next, {
    last_run_at: firedAt, last_agent_run_id: agentRun.id,
  });
  await svc.entities.AgentSchedule.update(schedule.id, patch);
  if (pause) await notifySchedulePaused(svc, schedule, pause, null).catch(() => {});
  return { schedule_id: schedule.id, status: "success", agent_run_id: agentRun.id, ...(pause ? { paused: pause } : {}) };
}

// One sweep tick: loads every enabled schedule and advances each. Safe to call concurrently:
// the per-occurrence conditional-update claim prevents double enqueue. Mirrors the certified
// sweep's bounds; the options parameter is an internal test hook that can only LOWER them.
export async function processDueAgentSchedules(svc, now = new Date(), scope = null, options = {}) {
  const schedules = await svc.entities.AgentSchedule.filter({ enabled: true, ...(scope ? { project_id: scope } : {}) }, "created_date", SWEEP_LIMIT);
  const batchSize = Math.max(1, Math.min(SWEEP_BATCH, Number(options.batch_size) || SWEEP_BATCH));
  const deadline = Math.max(1000, Math.min(SWEEP_DEADLINE_MS, Number(options.deadline_ms) || SWEEP_DEADLINE_MS));
  const startedAt = Date.now();
  const results = [];
  for (const schedule of schedules) {
    if (results.length >= batchSize || Date.now() - startedAt >= deadline) break;
    try { results.push(await processOne(svc, schedule, now)); }
    catch (e) { results.push({ schedule_id: schedule.id, error: trunc(e?.message || String(e)) }); }
  }
  return {
    processed: schedules.length, results,
    ...(schedules.length > results.length ? { remaining: schedules.length - results.length } : {}),
  };
}

// --- Member-authorized lifecycle (the Base44-evidenced Superagent surface, Phase 16C-4D) -----
// Base44's documented behavior for scheduled Superagent workflows: the Superagent itself creates
// and edits them in chat, and Pause / Resume / Archive / Restore are the lifecycle actions
// ("You can also ask your Superagent to create, edit, pause, archive, or restore workflows
// directly in chat" — docs.base44.com, Superagents → Setting up workflows). A hard DELETE is not
// an evidenced operation, so none is offered: archive is the tombstone, restore the only way
// back. These operations implement exactly that surface, reusing the platform's member
// authorization (loadAuthorizedProject — which applies the G-2 lifecycle gate) and the existing
// audit primitive. They are the executors of the agent_schedule_* tools in the SINGLE tool
// registry (shared/tools.ts); the AGENT loop invokes them from the run's persisted owner
// identity. No parallel CRUD architecture, no appAgentRuntime/tool_configs path, no HTTP surface.
const UPDATABLE_FIELDS = ["goal", "agent_name", "cron", "timezone", "interval_seconds", "one_time_at", "ends_type", "ends_on_date", "ends_after_count"];

const scheduleError = (code, message, status = 400) => Object.assign(new Error(message), { status, code });

const validateScheduleGoal = (goal, required) => {
  const g = String(goal ?? "").trim();
  if (!g) { if (required) throw scheduleError("SCHEDULE_INVALID", "goal is required"); return null; }
  if (g.length > GOAL_MAX_CHARS) throw scheduleError("SCHEDULE_INVALID", `goal too long (max ${GOAL_MAX_CHARS} characters)`);
  return g;
};

// Exactly one timing mode, mirroring the certified ScheduledTrigger create-side semantics
// (one_time_at takes precedence over interval over cron — but here ambiguity is REFUSED at
// creation rather than silently resolved). The one-time instant must lie in the future: a past
// one-time can never fire (the certified sweep computes "never" for it), so accepting one would
// create a dead schedule.
function timingOf(input) {
  const one_time_at = input.one_time_at != null && input.one_time_at !== "" ? String(input.one_time_at) : null;
  const interval_seconds = input.interval_seconds != null && input.interval_seconds !== "" ? Number(input.interval_seconds) : null;
  const cron = input.cron != null && input.cron !== "" ? String(input.cron) : null;
  const modes = [one_time_at, interval_seconds, cron].filter((v) => v !== null);
  if (modes.length > 1) throw scheduleError("SCHEDULE_INVALID", "exactly one of one_time_at, interval_seconds or cron may be set");
  if (one_time_at != null) {
    const t = Date.parse(one_time_at);
    if (!Number.isFinite(t)) throw scheduleError("SCHEDULE_INVALID", `one_time_at must be an ISO datetime, not '${one_time_at}'`);
    if (t <= Date.now()) throw scheduleError("SCHEDULE_INVALID", "one_time_at must be in the future — a past one-time can never fire");
    return { one_time_at };
  }
  if (interval_seconds != null) {
    if (!Number.isFinite(interval_seconds) || interval_seconds <= 0 || !Number.isInteger(interval_seconds)) {
      throw scheduleError("SCHEDULE_INVALID", "interval_seconds must be a positive whole number of seconds");
    }
    return { interval_seconds };
  }
  if (cron != null) {
    parseCron(cron); // fail closed on an unparseable expression, exactly like the certified path
    return { cron };
  }
  return null;
}

// The certified ScheduledTrigger end semantics: never | on (inclusive date) | after (N runs).
function endsOf(input) {
  if (input.ends_type == null) return null;
  const ends_type = String(input.ends_type);
  if (!["never", "on", "after"].includes(ends_type)) throw scheduleError("SCHEDULE_INVALID", "ends_type must be one of never, on, after");
  if (ends_type === "on") {
    const t = Date.parse(String(input.ends_on_date || ""));
    if (!Number.isFinite(t)) throw scheduleError("SCHEDULE_INVALID", "ends_type 'on' requires a valid ends_on_date (ISO)");
    return { ends_type, ends_on_date: new Date(t).toISOString(), ends_after_count: null };
  }
  if (ends_type === "after") {
    const n = Number(input.ends_after_count);
    if (!Number.isInteger(n) || n <= 0) throw scheduleError("SCHEDULE_INVALID", "ends_type 'after' requires a positive whole ends_after_count");
    return { ends_type, ends_on_date: null, ends_after_count: n };
  }
  return { ends_type, ends_on_date: null, ends_after_count: null };
}

// Optional declared agent — the SAME fail-closed E9 rule the enqueue contract applies.
async function validateScheduleAgent(svc, projectId, agent_name) {
  const name = String(agent_name ?? "").trim();
  if (!name) return null;
  const state = await loadProjectState(svc, projectId);
  if (!resolveAgent(state.files, name)) throw scheduleError("AGENT_NOT_FOUND", `the project declares no agent named '${name}'`, 400);
  return name;
}

// Member authorization + project-scoped load for every lifecycle operation: project.write
// through loadAuthorizedProject (G-2 lifecycle gate included), and the schedule must belong to
// that project — another project's schedule is simply not found.
async function loadOwnSchedule(svc, user, { project_id, schedule_id }) {
  if (!schedule_id) throw scheduleError("SCHEDULE_INVALID", "schedule_id is required");
  let authorized;
  try {
    authorized = await loadAuthorizedProject(svc, user, project_id, "project.write");
  } catch (e) {
    // A MISSING project row is a client-input error (404), not an internal failure: re-code it,
    // preserving every coded authorization refusal (NOT_A_MEMBER, workspace lifecycle, …).
    if (!e.code && /not found/i.test(e.message || "")) throw scheduleError("PROJECT_NOT_FOUND", "Project not found", 404);
    throw e;
  }
  const { project, workspace } = authorized;
  const schedule = await svc.entities.AgentSchedule.get(schedule_id).catch(() => null);
  if (!schedule || schedule.project_id !== project.id) {
    throw scheduleError("SCHEDULE_NOT_FOUND", "Schedule not found", 404);
  }
  return { project, workspace, schedule };
}

// Shared resume re-derivation (Resume and Restore use the same rule): an already-fired one-time
// schedule has ended and cannot come back; otherwise the next occurrence is recomputed from now,
// with the unfired one-time slot preserved (it fires on the next tick once the blocker clears).
// A manual resume also clears the failure streak — the documented "fix the cause, then Resume".
function resumePatch(schedule) {
  if (schedule.one_time_at && (Number(schedule.run_count) || 0) > 0) {
    throw scheduleError("SCHEDULE_ENDED", "the one-time schedule already fired and has ended");
  }
  const next = computeNextRun(schedule, new Date()) || (schedule.one_time_at ? new Date(Date.parse(schedule.one_time_at)) : null);
  if (!next) throw scheduleError("SCHEDULE_INVALID", "the schedule never computes a next run");
  return { enabled: true, paused_reason: null, consecutive_failures: 0, next_run_at: next.toISOString() };
}

const scheduleAudit = (svc, schedule, user, action, extra = {}) => audit(svc, {
  workspace_id: schedule.workspace_id, project_id: schedule.project_id, user_id: user.id,
  action: `agent_schedule.${action}`, resource: "AgentSchedule", resource_id: schedule.id,
  metadata: { goal: trunc(schedule.goal, 200), agent_name: schedule.agent_name || null, ...extra },
});

export async function createAgentSchedule(svc, user, input = {}) {
  const { project, workspace } = await loadAuthorizedProject(svc, user, input.project_id, "project.write");
  const goal = validateScheduleGoal(input.goal, true);
  const timing = timingOf(input);
  if (!timing) throw scheduleError("SCHEDULE_INVALID", "a schedule is required: cron, interval_seconds or one_time_at");
  const ends = endsOf(input) || {};
  const agent_name = await validateScheduleAgent(svc, project.id, input.agent_name);
  const timezone = input.timezone ? String(input.timezone) : "UTC";
  // Fail closed on an unreachable configuration: computing the next run NOW means a bad cron
  // expression or an unknown timezone is refused at creation, not discovered by the sweep.
  const next = computeNextRun({ ...timing, timezone }, new Date());
  if (!next) throw scheduleError("SCHEDULE_INVALID", "the schedule never computes a next run");
  const schedule = await svc.entities.AgentSchedule.create({
    project_id: project.id, workspace_id: project.workspace_id, goal,
    ...(agent_name ? { agent_name } : {}), ...timing, timezone, ...ends,
    owner_user_id: user.id, created_by: user.id,
    enabled: true, consecutive_failures: 0, run_count: 0,
    last_claimed_key: "", last_status: "pending", next_run_at: next.toISOString(),
  });
  await scheduleAudit(svc, schedule, user, "created", { ...timing, timezone, ends_type: ends.ends_type || "never" });
  return { schedule_id: schedule.id, project_id: project.id, next_run_at: schedule.next_run_at, enabled: true };
}

export async function updateAgentSchedule(svc, user, input = {}) {
  const { project, workspace, schedule } = await loadOwnSchedule(svc, user, input);
  const unknown = Object.keys(input).filter((k) => !["project_id", "schedule_id", ...UPDATABLE_FIELDS].includes(k));
  if (unknown.length) throw scheduleError("SCHEDULE_INVALID", `fields not updatable: ${unknown.join(", ")}`);
  const patch = {};
  const goal = validateScheduleGoal(input.goal, false);
  if (goal) patch.goal = goal;
  if (input.agent_name !== undefined) {
    const agent_name = await validateScheduleAgent(svc, project.id, input.agent_name);
    patch.agent_name = agent_name; // an empty value explicitly clears the declared agent
  }
  if (["cron", "interval_seconds", "one_time_at", "timezone", "ends_type", "ends_on_date", "ends_after_count"].some((k) => input[k] !== undefined)) {
    // Any timing/timezone/ends change re-derives the WHOLE schedule state fail-closed from the
    // merged definition, so a partial patch can never leave an ambiguous or dead schedule.
    const merged = { ...schedule };
    for (const k of ["cron", "interval_seconds", "one_time_at", "timezone", "ends_type", "ends_on_date", "ends_after_count"]) {
      if (input[k] !== undefined) merged[k] = input[k];
    }
    merged.timezone = input.timezone !== undefined ? String(input.timezone || "UTC") : (schedule.timezone || "UTC");
    const timing = timingOf(merged);
    if (!timing) throw scheduleError("SCHEDULE_INVALID", "the schedule must keep one timing mode: cron, interval_seconds or one_time_at");
    const ends = endsOf(merged) || {};
    Object.assign(patch, timing, { timezone: merged.timezone, ends_type: ends.ends_type || "never", ends_on_date: ends.ends_on_date ?? null, ends_after_count: ends.ends_after_count ?? null });
    const next = computeNextRun({ ...timing, timezone: merged.timezone }, new Date());
    if (!next) throw scheduleError("SCHEDULE_INVALID", "the schedule never computes a next run");
    patch.next_run_at = next.toISOString();
  }
  if (!Object.keys(patch).length) throw scheduleError("SCHEDULE_INVALID", "no updatable field supplied");
  await svc.entities.AgentSchedule.update(schedule.id, patch);
  const updated = { ...schedule, ...patch };
  await scheduleAudit(svc, updated, user, "updated", { changed: Object.keys(patch).join(","), ...(patch.next_run_at ? { next_run_at: patch.next_run_at } : {}) });
  return { schedule_id: schedule.id, changed: Object.keys(patch), ...(patch.next_run_at ? { next_run_at: patch.next_run_at } : {}) };
}

export async function pauseAgentSchedule(svc, user, input = {}) {
  const { schedule } = await loadOwnSchedule(svc, user, input);
  if (schedule.paused_reason === "archived") throw scheduleError("SCHEDULE_ARCHIVED", "the schedule is archived — restore it first");
  if (!schedule.enabled) return { schedule_id: schedule.id, enabled: false, paused_reason: schedule.paused_reason || null }; // idempotent
  // The due occurrence's claim and slot are preserved: a paused schedule holds nothing back —
  // the sweep simply never processes it, and resume recomputes the next occurrence from now.
  await svc.entities.AgentSchedule.update(schedule.id, { enabled: false, paused_reason: "paused", last_claimed_key: "" });
  await scheduleAudit(svc, schedule, user, "paused");
  return { schedule_id: schedule.id, enabled: false, paused_reason: "paused" };
}

export async function resumeAgentSchedule(svc, user, input = {}) {
  const { schedule } = await loadOwnSchedule(svc, user, input);
  if (schedule.paused_reason === "archived") throw scheduleError("SCHEDULE_ARCHIVED", "the schedule is archived — restore it first");
  const patch = resumePatch(schedule);
  await svc.entities.AgentSchedule.update(schedule.id, patch);
  await scheduleAudit(svc, { ...schedule, ...patch }, user, "resumed", { next_run_at: patch.next_run_at });
  return { schedule_id: schedule.id, enabled: true, next_run_at: patch.next_run_at };
}

export async function archiveAgentSchedule(svc, user, input = {}) {
  const { schedule } = await loadOwnSchedule(svc, user, input);
  if (schedule.paused_reason === "archived") return { schedule_id: schedule.id, archived: true }; // idempotent
  await svc.entities.AgentSchedule.update(schedule.id, { enabled: false, paused_reason: "archived", last_claimed_key: "" });
  await scheduleAudit(svc, schedule, user, "archived");
  return { schedule_id: schedule.id, archived: true };
}

export async function restoreAgentSchedule(svc, user, input = {}) {
  const { schedule } = await loadOwnSchedule(svc, user, input);
  if (schedule.paused_reason !== "archived") throw scheduleError("SCHEDULE_NOT_ARCHIVED", "the schedule is not archived");
  const patch = resumePatch(schedule);
  await svc.entities.AgentSchedule.update(schedule.id, patch);
  await scheduleAudit(svc, { ...schedule, ...patch }, user, "restored", { next_run_at: patch.next_run_at });
  return { schedule_id: schedule.id, enabled: true, next_run_at: patch.next_run_at };
}

// Run Now (DOCUMENTED Base44: "Click Run Now on the workflow to run it immediately, without
// waiting for its schedule or trigger"). Enqueues ONE AgentRun for this schedule immediately,
// through the SAME primitives the certified fire uses — the owner identity, the fail-closed
// agent validation, the one-agent-per-project concurrency posture and the existing audit
// primitive. Deliberately does NOT touch scheduler bookkeeping (next_run_at, run_count,
// consecutive_failures, the claim slot): those belong to the sweep, and a manual run must not
// advance or consume a scheduled occurrence. A busy project is a skipped, non-started attempt
// (the same posture the fire applies), surfaced to the member instead of a failure.
export async function runNowAgentSchedule(svc, user, input = {}) {
  const { project, schedule } = await loadOwnSchedule(svc, user, input);
  if (schedule.paused_reason === "archived") throw scheduleError("SCHEDULE_ARCHIVED", "the schedule is archived — restore it first");
  if (schedule.paused_reason === "completed" || schedule.paused_reason === "schedule_ended") {
    throw scheduleError("SCHEDULE_ENDED", "the schedule has ended and cannot run again");
  }
  const goal = validateScheduleGoal(schedule.goal, true);
  let agent = null;
  if (schedule.agent_name) {
    const state = await loadProjectState(svc, project.id);
    agent = resolveAgent(state.files, String(schedule.agent_name));
    if (!agent) throw scheduleError("AGENT_NOT_FOUND", `the project declares no agent named '${schedule.agent_name}'`, 400);
  }
  const active = (await svc.entities.AgentRun.filter({ project_id: project.id }, "-created_date", 10)).find((r) => !AGENT_TERMINAL.includes(r.status));
  if (active) return { schedule_id: schedule.id, skipped: "AGENT_ALREADY_RUNNING" };
  const firedAt = new Date().toISOString();
  const agentRun = await svc.entities.AgentRun.create({
    project_id: project.id, workspace_id: project.workspace_id, user_id: schedule.owner_user_id, goal,
    trigger_source: "schedule",
    ...(agent ? { agent_name: agent.name } : {}),
    status: "QUEUED", current_phase: "queued", current_step: 0,
    max_steps: agent?.max_steps ? Math.min(agent.max_steps, MAX_STEPS_CEILING) : MAX_STEPS_CEILING,
    cancel_requested: false, started_at: firedAt, heartbeat_at: firedAt,
  });
  await svc.entities.AgentSchedule.update(schedule.id, {
    last_run_at: firedAt, last_status: "success", last_error: null, last_agent_run_id: agentRun.id,
  });
  await audit(svc, {
    workspace_id: project.workspace_id, project_id: project.id, user_id: user.id,
    action: "agent_schedule.run_now", resource: "AgentSchedule", resource_id: schedule.id,
    metadata: { goal: trunc(goal, 200), agent_name: agent?.name || null, agent_run_id: agentRun.id, trigger: "run_now" },
  });
  return { schedule_id: schedule.id, status: "success", agent_run_id: agentRun.id, next_run_at: schedule.next_run_at || null };
}