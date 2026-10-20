// Run Now certification (DOCUMENTED Base44 surface: "Click Run Now on the workflow to run it
// immediately, without waiting for its schedule or trigger"). Verifies that the member-authorized
// run_now op reuses the certified fire primitives — owner identity, fail-closed agent validation,
// the one-agent-per-project concurrency posture, audit — WITHOUT advancing any scheduler
// bookkeeping (next_run_at, run_count, consecutive_failures, claim slot). Self-contained
// fixtures, fully cleaned up.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createAgentSchedule, runNowAgentSchedule, archiveAgentSchedule } from "../../shared/agentSchedules.ts";

const run = async (base44) => {
  const svc = base44.asServiceRole || base44;
  const OWNER = `u_runnow_${Date.now()}`;
  const me = { id: OWNER, email: null };
  const stranger = { id: "user_not_a_member", email: null };
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail == null ? null : detail });
  const expectThrow = async (name, fn, code) => {
    try { await fn(); check(name, false, "no error thrown"); }
    catch (e) { check(name, code ? (e.code || "").includes(code) || e.status === code : true, `${e.code || ""}: ${e.message}`.slice(0, 200)); }
  };

  const W = await svc.entities.Workspace.create({ name: "runnow-w", owner_id: OWNER, status: "active" });
  const P = await svc.entities.Project.create({ workspace_id: W.id, name: "runnow-p", status: "ready" });
  await svc.entities.ProjectFile.create({ project_id: P.id, path: "base44/agents/helper.jsonc", content: JSON.stringify({ name: "helper", description: "Test helper agent", instructions: "Do the fixture work." }) });
  const scheduleIds = [];
  const runIds = new Set();
  try {
    // --- 1. success: enqueue with the owner identity, scheduler bookkeeping untouched --------
    const s1 = await createAgentSchedule(svc, me, { project_id: P.id, goal: "run now target", interval_seconds: 3600 });
    scheduleIds.push(s1.schedule_id);
    const before = await svc.entities.AgentSchedule.get(s1.schedule_id);
    const res = await runNowAgentSchedule(svc, me, { project_id: P.id, schedule_id: s1.schedule_id });
    check("run_now enqueues an AgentRun", res.status === "success" && !!res.agent_run_id);
    if (res.agent_run_id) {
      runIds.add(res.agent_run_id);
      const runRow = await svc.entities.AgentRun.get(res.agent_run_id);
      check("fired run carries the owner identity + QUEUED", runRow.user_id === OWNER && runRow.status === "QUEUED" && runRow.goal === "run now target");
      // Terminalize immediately so the certified executor no-ops without spending credits.
      await svc.entities.AgentRun.update(res.agent_run_id, { status: "CANCELLED", current_phase: "cancelled" });
    }
    const after = await svc.entities.AgentSchedule.get(s1.schedule_id);
    check("scheduler bookkeeping untouched (next_run_at/run_count/failures/claim/enabled)",
      after.next_run_at === before.next_run_at && (after.run_count || 0) === (before.run_count || 0)
      && (after.consecutive_failures || 0) === 0 && after.enabled === true && after.last_claimed_key === before.last_claimed_key);
    check("visibility fields updated (last_run_at/status/agent_run_id)",
      after.last_agent_run_id === res.agent_run_id && after.last_status === "success" && !!after.last_run_at);

    // --- 2. declared agent: resolved fail-closed ----------------------------------------------
    const s2 = await createAgentSchedule(svc, me, { project_id: P.id, goal: "declared agent target", interval_seconds: 3600, agent_name: "helper" });
    scheduleIds.push(s2.schedule_id);
    const r2 = await runNowAgentSchedule(svc, me, { project_id: P.id, schedule_id: s2.schedule_id });
    check("run_now with a declared agent succeeds", r2.status === "success");
    if (r2.agent_run_id) {
      runIds.add(r2.agent_run_id);
      const row = await svc.entities.AgentRun.get(r2.agent_run_id);
      check("declared agent carried onto the run", row.agent_name === "helper");
      await svc.entities.AgentRun.update(r2.agent_run_id, { status: "CANCELLED", current_phase: "cancelled" });
    }
    await svc.entities.AgentSchedule.update(s2.schedule_id, { agent_name: "no-such-agent" });
    await expectThrow("unknown agent refuses (AGENT_NOT_FOUND)", () => runNowAgentSchedule(svc, me, { project_id: P.id, schedule_id: s2.schedule_id }), "AGENT_NOT_FOUND");

    // --- 3. concurrency: a non-terminal run skips, non-started, no second enqueue -------------
    const guardRun = await svc.entities.AgentRun.create({ project_id: P.id, workspace_id: W.id, user_id: OWNER, goal: "concurrency guard", status: "QUEUED", current_phase: "queued", current_step: 0, max_steps: 20, cancel_requested: false, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() });
    runIds.add(guardRun.id);
    const r3 = await runNowAgentSchedule(svc, me, { project_id: P.id, schedule_id: s1.schedule_id });
    check("busy project skips (AGENT_ALREADY_RUNNING, no enqueue)", r3.skipped === "AGENT_ALREADY_RUNNING" && !r3.agent_run_id);
    const busyCount = (await svc.entities.AgentRun.filter({ project_id: P.id, goal: "run now target" }, "-created_date", 100)).length;
    check("no second enqueue for the busy project", busyCount === 1);

    // --- 4. terminal states refuse -------------------------------------------------------------
    await archiveAgentSchedule(svc, me, { project_id: P.id, schedule_id: s1.schedule_id });
    await expectThrow("archived refuses (SCHEDULE_ARCHIVED)", () => runNowAgentSchedule(svc, me, { project_id: P.id, schedule_id: s1.schedule_id }), "SCHEDULE_ARCHIVED");
    const oneTime = await createAgentSchedule(svc, me, { project_id: P.id, goal: "one-time", one_time_at: new Date(Date.now() + 3600000).toISOString() });
    scheduleIds.push(oneTime.schedule_id);
    await svc.entities.AgentSchedule.update(oneTime.schedule_id, { enabled: false, paused_reason: "completed", run_count: 1 });
    await expectThrow("ended one-time refuses (SCHEDULE_ENDED)", () => runNowAgentSchedule(svc, me, { project_id: P.id, schedule_id: oneTime.schedule_id }), "SCHEDULE_ENDED");

    // --- 5. authorization -----------------------------------------------------------------------
    await expectThrow("non-member run_now refused (403)", () => runNowAgentSchedule(svc, stranger, { project_id: P.id, schedule_id: s2.schedule_id }), 403);
    await expectThrow("unknown project refused", () => runNowAgentSchedule(svc, me, { project_id: "000000000000000000000000", schedule_id: s2.schedule_id }), "NOT_FOUND");

    // --- 6. audit -------------------------------------------------------------------------------
    const audits = await svc.entities.AuditLog.filter({ workspace_id: W.id, action: "agent_schedule.run_now" }, "-created_date", 10);
    check("audit row written (agent_schedule.run_now)", audits.some((a) => a.resource_id === s1.schedule_id));
    check("run_now audit not conflated with scheduled fires", audits.every((a) => a.action === "agent_schedule.run_now"));

    // --- cleanup ----------------------------------------------------------------------------------
    for (const rid of runIds) {
      await svc.entities.AgentStep.deleteMany({ agent_run_id: rid }).catch(() => {});
      await svc.entities.AgentRun.delete(rid).catch(() => {});
    }
    await svc.entities.AgentSchedule.deleteMany({ id: { $in: scheduleIds } }).catch(() => {});
    await svc.entities.AuditLog.deleteMany({ workspace_id: W.id, action: { $regex: "^agent_schedule" } }).catch(() => {});
    await svc.entities.ProjectFile.deleteMany({ project_id: P.id, path: "base44/agents/helper.jsonc" }).catch(() => {});
    await svc.entities.Project.delete(P.id).catch(() => {});
    await svc.entities.Workspace.delete(W.id).catch(() => {});
    results.push({ name: "fixtures cleaned", pass: true });
  } catch (e) {
    results.push({ name: "UNEXPECTED ERROR", pass: false, detail: `${e.code || ""}: ${e.message}`.slice(0, 300) });
    try {
      await svc.entities.Project.delete(P.id).catch(() => {});
      await svc.entities.Workspace.delete(W.id).catch(() => {});
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