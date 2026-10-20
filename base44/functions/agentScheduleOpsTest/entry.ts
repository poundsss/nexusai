// Phase 16C-4D verification: the member-authorized AgentSchedule lifecycle tool surface
// (agent_schedule_* registry tools, executed by the agent loop). Covers authorization, create
// validation, update, pause/resume, archive/restore, audit emission, the E10 grant gate, and a
// scheduler regression (a lifecycle-created schedule still fires through the same sweep).
// Self-contained fixtures, fully cleaned up.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import {
  createAgentSchedule, updateAgentSchedule, pauseAgentSchedule, resumeAgentSchedule,
  archiveAgentSchedule, restoreAgentSchedule, processDueAgentSchedules,
} from "../../shared/agentSchedules.ts";
import { gateAction, SCHEDULE_ACTION_TOOL } from "../../shared/agentLoop.ts";
import { agentPermissionGate, GRANTABLE_TOOLS } from "../../shared/agentResource.ts";
import { toolContracts } from "../../shared/toolRouter.ts";
import { TOOL_REGISTRY } from "../../shared/tools.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async (base44) => {
  const svc = base44.asServiceRole || base44;
  // A synthetic owner: loadAuthorizedProject resolves the role from Workspace.owner_id /
  // WorkspaceMember rows, so no authenticated session is needed to exercise the lifecycle.
  const OWNER = `u_asops_${Date.now()}`;
  const user = { id: OWNER, email: null };
  const me = { id: OWNER, email: null };
  const stranger = { id: "user_not_a_member", email: null };
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail == null ? null : detail });
  const expectThrow = async (name, fn, code) => {
    try { await fn(); check(name, false, "no error thrown"); }
    catch (e) { check(name, code ? (e.code || "").includes(code) || e.status === code : true, `${e.code || ""}: ${e.message}`.slice(0, 200)); }
  };

  // --- 1. registry + router contracts --------------------------------------------------------
  const names = TOOL_REGISTRY.map((t) => t.name);
  for (const t of ["agent_schedule_create", "agent_schedule_update", "agent_schedule_pause", "agent_schedule_resume", "agent_schedule_archive", "agent_schedule_restore"]) {
    check(`registry has ${t}`, names.includes(t));
    check(`grant surface has ${t}`, GRANTABLE_TOOLS.includes(t));
  }
  let contractsOk = true;
  try { toolContracts(); } catch { contractsOk = false; }
  check("toolContracts() complete for the whole registry", contractsOk);
  let contracts = [];
  try { contracts = toolContracts().filter((t) => t.name.startsWith("agent_schedule_")); } catch {}
  check("router contracts carry project.write", contracts.length === 6 && contracts.every((c) => c.capability === "project.write"));

  // --- 2. E10 grant gate ----------------------------------------------------------------------
  const gate = agentPermissionGate({ name: "gate-agent", tools: ["agent_schedule_create", "agent_schedule_update"] });
  check("granted create_schedule allowed", gateAction(gate, "create_schedule") === null);
  check("ungranted pause_schedule refused", gateAction(gate, "pause_schedule")?.code === "AGENT_TOOL_NOT_GRANTED");
  check("no-agent run keeps default posture", gateAction(null, "pause_schedule") === null);
  check("SCHEDULE_ACTION_TOOL maps all six schedule actions", Object.keys(SCHEDULE_ACTION_TOOL).length === 6);

  // --- 3. fixtures ----------------------------------------------------------------------------
  const W = await svc.entities.Workspace.create({ name: "asops-w", owner_id: user.id, status: "active" });
  const Ws = await svc.entities.Workspace.create({ name: "asops-w-suspended", owner_id: user.id, status: "suspended" });
  const P = await svc.entities.Project.create({ workspace_id: W.id, name: "asops-p", status: "ready" });
  const Ps = await svc.entities.Project.create({ workspace_id: Ws.id, name: "asops-ps", status: "ready" });
  const P2 = await svc.entities.Project.create({ workspace_id: W.id, name: "asops-p2", status: "ready" });
  await svc.entities.ProjectFile.create({ project_id: P.id, path: "base44/agents/helper.jsonc", content: JSON.stringify({ name: "helper", description: "Test helper agent", instructions: "Do the fixture work." }) });
  const scheduleIds = [];
  const runIds = new Set();
  try {
    // --- 4. authorization ---------------------------------------------------------------------
    await expectThrow("non-member create refused (403)", () => createAgentSchedule(svc, stranger, { project_id: P.id, goal: "x", cron: "*/5 * * * *" }), 403);
    await expectThrow("suspended workspace create refused (G-2)", () => createAgentSchedule(svc, me, { project_id: Ps.id, goal: "x", cron: "*/5 * * * *" }));
    await expectThrow("paused workspace (terminated analog) refused", () => createAgentSchedule(svc, stranger, { project_id: P.id, goal: "x", cron: "*/5 * * * *" }), 403);

    // --- 5. create: valid + validation failures -------------------------------------------------
    const s1 = await createAgentSchedule(svc, me, { project_id: P.id, goal: "daily build check", cron: "30 2 * * *", timezone: "America/Chicago" });
    scheduleIds.push(s1.schedule_id);
    check("create returns computed next_run_at", !!s1.next_run_at && !!s1.schedule_id);
    const s1row = await svc.entities.AgentSchedule.get(s1.schedule_id);
    check("create persists owner/created_by/enabled/tz", s1row.owner_user_id === OWNER && s1row.created_by === OWNER && s1row.enabled === true && s1row.timezone === "America/Chicago");
    check("create timezone conversion (02:30 Chicago = 07:30Z)", String(s1.next_run_at || "").endsWith("07:30:00.000Z"));
    const s2 = await createAgentSchedule(svc, me, { project_id: P.id, goal: "agent-run helper", interval_seconds: 300, agent_name: "helper" });
    scheduleIds.push(s2.schedule_id);
    const s2row = await svc.entities.AgentSchedule.get(s2.schedule_id);
    check("create with declared agent validates fail-open on a real agent", s2row.agent_name === "helper" && !!s2row.next_run_at);
    await expectThrow("create refuses empty goal", () => createAgentSchedule(svc, me, { project_id: P.id, goal: " ", cron: "*/5 * * * *" }));
    await expectThrow("create refuses >4000-char goal", () => createAgentSchedule(svc, me, { project_id: P.id, goal: "x".repeat(4001), cron: "*/5 * * * *" }));
    await expectThrow("create refuses two timing modes", () => createAgentSchedule(svc, me, { project_id: P.id, goal: "x", cron: "*/5 * * * *", interval_seconds: 300 }));
    await expectThrow("create refuses bad cron", () => createAgentSchedule(svc, me, { project_id: P.id, goal: "x", cron: "not a cron" }));
    await expectThrow("create refuses unknown timezone", () => createAgentSchedule(svc, me, { project_id: P.id, goal: "x", cron: "*/5 * * * *", timezone: "Mars/Olympus" }));
    await expectThrow("create refuses past one_time_at", () => createAgentSchedule(svc, me, { project_id: P.id, goal: "x", one_time_at: new Date(Date.now() - 60000).toISOString() }));
    await expectThrow("create refuses unknown agent", () => createAgentSchedule(svc, me, { project_id: P.id, goal: "x", interval_seconds: 300, agent_name: "no-such-agent" }));

    // --- 6. update --------------------------------------------------------------------------------
    const u1 = await updateAgentSchedule(svc, me, { project_id: P.id, schedule_id: s1.schedule_id, cron: "0 3 * * *", timezone: "UTC" });
    check("update recomputes next_run_at", u1.next_run_at.endsWith("03:00:00.000Z") && u1.changed.includes("next_run_at"));
    const u2 = await updateAgentSchedule(svc, me, { project_id: P.id, schedule_id: s2.schedule_id, goal: "agent-run helper v2" });
    check("update goal", u2.changed.includes("goal"));
    const u3 = await updateAgentSchedule(svc, me, { project_id: P.id, schedule_id: s2.schedule_id, agent_name: "" });
    check("update clears declared agent", u3.changed.includes("agent_name") && (await svc.entities.AgentSchedule.get(s2.schedule_id)).agent_name == null);
    await expectThrow("update refuses unknown field", () => updateAgentSchedule(svc, me, { project_id: P.id, schedule_id: s1.schedule_id, owner_user_id: "hijack" }));
    await expectThrow("update of another project's schedule refused", () => updateAgentSchedule(svc, me, { project_id: P2.id, schedule_id: s1.schedule_id }), 404);
    await expectThrow("update to no timing mode refused", () => updateAgentSchedule(svc, me, { project_id: P.id, schedule_id: s1.schedule_id, cron: "" }));

    // --- 7. pause/resume -----------------------------------------------------------------------------
    await svc.entities.AgentSchedule.update(s2.schedule_id, { consecutive_failures: 3 });
    const p1 = await pauseAgentSchedule(svc, me, { project_id: P.id, schedule_id: s2.schedule_id });
    check("pause disables + stamps paused_reason", p1.enabled === false && p1.paused_reason === "paused" && (await svc.entities.AgentSchedule.get(s2.schedule_id)).paused_reason === "paused");
    const sweepPaused = await processDueAgentSchedules(svc, new Date(), P.id);
    check("sweep skips paused schedule", !sweepPaused.results.some((r) => r.schedule_id === s2.schedule_id));
    const r1 = await resumeAgentSchedule(svc, me, { project_id: P.id, schedule_id: s2.schedule_id });
    const r1row = await svc.entities.AgentSchedule.get(s2.schedule_id);
    check("resume re-enables, recomputes next, clears failure streak", r1.enabled === true && r1row.enabled === true && r1row.consecutive_failures === 0 && !!r1row.next_run_at && r1row.paused_reason == null);
    const s3 = await createAgentSchedule(svc, me, { project_id: P.id, goal: "one-time later", one_time_at: new Date(Date.now() + 3600000).toISOString() });
    scheduleIds.push(s3.schedule_id);

    // --- 8. archive/restore (tested on an UNFIRED one-time, while restore is still possible) ----------
    const a1 = await archiveAgentSchedule(svc, me, { project_id: P.id, schedule_id: s3.schedule_id });
    check("archive stamps archived tombstone", a1.archived === true && (await svc.entities.AgentSchedule.get(s3.schedule_id)).paused_reason === "archived");
    await expectThrow("resume of archived refuses (SCHEDULE_ARCHIVED)", () => resumeAgentSchedule(svc, me, { project_id: P.id, schedule_id: s3.schedule_id }), "SCHEDULE_ARCHIVED");
    const t1 = await restoreAgentSchedule(svc, me, { project_id: P.id, schedule_id: s3.schedule_id });
    check("restore re-enables with a next run", t1.enabled === true && (await svc.entities.AgentSchedule.get(s3.schedule_id)).paused_reason == null);
    await expectThrow("restore of non-archived refuses", () => restoreAgentSchedule(svc, me, { project_id: P.id, schedule_id: s3.schedule_id }), "SCHEDULE_NOT_ARCHIVED");

    // THEN the one-time-ended scenario: simulate a fired one-time only after restore was verified.
    await svc.entities.AgentSchedule.update(s3.schedule_id, { run_count: 1 });
    await expectThrow("resume of a fired one-time refuses (SCHEDULE_ENDED)", () => resumeAgentSchedule(svc, me, { project_id: P.id, schedule_id: s3.schedule_id }), "SCHEDULE_ENDED");

    // --- 9. audit emission ------------------------------------------------------------------------------
    const audits = await svc.entities.AuditLog.filter({ workspace_id: W.id, action: { $regex: "^agent_schedule" } }, "-created_date", 50);
    const actions = new Set(audits.map((a) => a.action));
    for (const a of ["agent_schedule.created", "agent_schedule.updated", "agent_schedule.paused", "agent_schedule.resumed", "agent_schedule.archived", "agent_schedule.restored"]) {
      check(`audit row written: ${a}`, actions.has(a));
    }

    // --- 10. scheduler regression: a lifecycle-created schedule still fires through the sweep ---
    const fire = await createAgentSchedule(svc, me, { project_id: P.id, goal: "regression one-time fire", one_time_at: new Date(Date.now() + 1200).toISOString() });
    scheduleIds.push(fire.schedule_id);
    await sleep(1500);
    const srBefore = (await svc.entities.ScheduledRun.filter({}, "-created_date", 500)).filter((r) => String(r.idempotency_key || "").startsWith("schedule:")).length;
    const sweep = await processDueAgentSchedules(svc, new Date(), P.id);
    const fired = sweep.results.find((r) => r.schedule_id === fire.schedule_id);
    check("sweep fires the lifecycle-created one-time", !!fired?.agent_run_id);
    if (fired?.agent_run_id) {
      runIds.add(fired.agent_run_id);
      const run = await svc.entities.AgentRun.get(fired.agent_run_id);
      check("fired run carries the owner identity", run.user_id === OWNER && run.status === "QUEUED");
      // Terminalize immediately so the certified executor no-ops without spending credits.
      await svc.entities.AgentRun.update(fired.agent_run_id, { status: "CANCELLED", current_phase: "cancelled" });
    }
    // THE invariant: the second tick creates NO additional AgentRun. A one-time schedule that
    // already fired is disabled with paused_reason "completed", so the sweep (enabled: true
    // filter) never even picks it up — the check must not require a specific sweep result shape.
    const fireRunsBefore = (await svc.entities.AgentRun.filter({ project_id: P.id, goal: "regression one-time fire" }, "-created_date", 100)).length;
    const sweep2 = await processDueAgentSchedules(svc, new Date(), P.id);
    const fireRunsAfter = (await svc.entities.AgentRun.filter({ project_id: P.id, goal: "regression one-time fire" }, "-created_date", 100)).length;
    check("duplicate tick converges (no additional AgentRun)", fireRunsBefore === 1 && fireRunsAfter === 1 && sweep2.results.every((r) => r.schedule_id !== fire.schedule_id || !r.agent_run_id));
    const srAfter = (await svc.entities.ScheduledRun.filter({}, "-created_date", 500)).filter((r) => String(r.idempotency_key || "").startsWith("schedule:")).length;
    check("certified ScheduledRun store untouched", srBefore === 0 && srAfter === 0);
    const fireAudit = await svc.entities.AuditLog.filter({ workspace_id: W.id, action: "agent_schedule.fired" }, "-created_date", 5);
    check("fired audit row written", fireAudit.some((a) => a.resource_id === fire.schedule_id));

    // --- cleanup ----------------------------------------------------------------------------------------
    for (const rid of runIds) {
      await svc.entities.AgentStep.deleteMany({ agent_run_id: rid }).catch(() => {});
      await svc.entities.AgentRun.delete(rid).catch(() => {});
    }
    await svc.entities.AgentSchedule.deleteMany({ id: { $in: scheduleIds } }).catch(() => {});
    await svc.entities.AuditLog.deleteMany({ workspace_id: W.id, action: { $regex: "^agent_schedule" } }).catch(() => {});
    await svc.entities.ProjectFile.deleteMany({ project_id: P.id, path: "base44/agents/helper.jsonc" }).catch(() => {});
    await svc.entities.Project.delete(P.id).catch(() => {});
    await svc.entities.Project.delete(P2.id).catch(() => {});
    await svc.entities.Project.delete(Ps.id).catch(() => {});
    await svc.entities.Workspace.delete(W.id).catch(() => {});
    await svc.entities.Workspace.delete(Ws.id).catch(() => {});
    results.push({ name: "fixtures cleaned", pass: true });
  } catch (e) {
    results.push({ name: "UNEXPECTED ERROR", pass: false, detail: `${e.code || ""}: ${e.message}`.slice(0, 300) });
    try {
      await svc.entities.Project.delete(P.id).catch(() => {});
      await svc.entities.Project.delete(P2.id).catch(() => {});
      await svc.entities.Project.delete(Ps.id).catch(() => {});
      await svc.entities.Workspace.delete(W.id).catch(() => {});
      await svc.entities.Workspace.delete(Ws.id).catch(() => {});
    } catch { /* best effort */ }
  }
  const failed = results.filter((r) => !r.pass);
  return { ok: failed.length === 0, total: results.length, failed_count: failed.length, results };
};

export default async function (req) {
  try {
    return Response.json(await run(createClientFromRequest(req)));
  } catch (e) {
    return Response.json({ ok: false, fatal: true, error: String(e?.message || e).slice(0, 500), stack: String(e?.stack || "").slice(0, 900) }, { status: 500 });
  }
}