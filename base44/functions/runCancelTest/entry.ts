// End-to-end verification of AI run cancellation, exercised through the SHIPPING code:
//   shared/runCancel.ts   → authorization, durable intent, terminal transition, credit release
//   shared/runPipeline.ts → the worker's between-phase and pre-commit cancellation gates
// Identities are passed explicitly so unauthorized and anonymous callers hit the real
// authorization path. Check recording, expected-failure assertions and cleanup come from the
// shared test harness.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy } from "../../shared/testHarness.ts";
import { requestRunCancel, cancelRun } from "../../shared/runCancel.ts";
import { executeRunPhase } from "../../shared/runPipeline.ts";
import { recordEvent, reserve, deriveBalance } from "../../shared/ledger.ts";

const uid = () => crypto.randomUUID().slice(0, 8);

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check, expectThrow } = h;
  const cleanup = [];

  try {
    // --- fixtures: two independent accounts, one project, one conversation ------------
    const userA = { id: `uA-${uid()}`, email: `a-${uid()}@test.local` };
    const userB = { id: `uB-${uid()}`, email: `b-${uid()}@test.local` };
    const wsA = await svc.entities.Workspace.create({ name: "Cancel WS A", owner_id: userA.id });
    const wsB = await svc.entities.Workspace.create({ name: "Cancel WS B", owner_id: userB.id });
    const project = await svc.entities.Project.create({ name: "Cancel Target", workspace_id: wsA.id, version_count: 1, status: "ready" });
    const conv = await svc.entities.Conversation.create({ project_id: project.id, title: "cancellation" });
    const version1 = await svc.entities.ProjectVersion.create({ project_id: project.id, number: 1, message: "scaffold" });
    const file1 = await svc.entities.ProjectFile.create({ project_id: project.id, path: "src/main.js", content: "// original\n", frozen: false });
    cleanup.push(async () => {
      for (const e of ["AIRun", "Message", "AuditLog", "CommitJournal", "AIOperation", "UsageEvent", "ProjectVersion", "ProjectFile"]) {
        await purgeBy(svc, e, { project_id: project.id });
      }
      await purgeBy(svc, "CreditLedgerEntry", { workspace_id: wsA.id });
      await svc.entities.Conversation.delete(conv.id).catch(() => {});
      await svc.entities.Project.delete(project.id).catch(() => {});
      await svc.entities.Workspace.delete(wsA.id).catch(() => {});
      await svc.entities.Workspace.delete(wsB.id).catch(() => {});
    });

    const makeRun = (extra = {}) => {
      const now = new Date().toISOString();
      return svc.entities.AIRun.create({
        project_id: project.id, conversation_id: conv.id, status: "QUEUED", phase: "plan", mode: "default",
        prompt: `cancel test ${uid()}`, steps: [], started_at: now, heartbeat_at: now, base_version_number: 1, ...extra,
      });
    };
    const auditsFor = (runId) => svc.entities.AuditLog.filter({ project_id: project.id, action: "ai.run.cancelled", resource_id: runId }, "-created_date", 10);
    const versionCount = async () => (await svc.entities.ProjectVersion.filter({ project_id: project.id }, "-number", 20)).length;

    // ================================================================================
    // 1. QUEUED run — no worker in flight, so cancellation is terminal immediately
    // ================================================================================
    const queued = await makeRun();
    const q = await requestRunCancel(base44, userA, { run_id: queued.id });
    const queuedAfter = await svc.entities.AIRun.get(queued.id);
    check("queued_run_cancelled_immediately",
      q.cancelled === true && q.status === "CANCELLED" && queuedAfter.status === "CANCELLED" && queuedAfter.phase === "done" && queuedAfter.cancel_requested === true && queuedAfter.cancel_requested_by === userA.id,
      `endpoint → ${q.status}; record ${queuedAfter.status}/${queuedAfter.phase}, requested_by=${queuedAfter.cancel_requested_by}`);
    const qAudit = await auditsFor(queued.id);
    check("queued_cancellation_audited", qAudit.length === 1 && qAudit[0].user_id === userA.id, `${qAudit.length} ai.run.cancelled entry by ${qAudit[0]?.user_id}`);

    // repeated cancellation is a no-op (idempotent), not a second transition or audit entry
    const again = await requestRunCancel(base44, userA, { run_id: queued.id });
    const again2 = await requestRunCancel(base44, userA, { run_id: queued.id });
    check("repeated_cancellation_idempotent",
      again.already_terminal === true && again.status === "CANCELLED" && again2.status === "CANCELLED" && (await auditsFor(queued.id)).length === 1,
      `both replays reported CANCELLED; still ${(await auditsFor(queued.id)).length} audit entry`);

    // concurrent cancellation of one run settles on exactly one terminal state
    const raced = await makeRun();
    const results = await Promise.all([1, 2, 3].map(() => requestRunCancel(base44, userA, { run_id: raced.id }).catch((e) => ({ error: e.message }))));
    const racedAfter = await svc.entities.AIRun.get(raced.id);
    check("concurrent_cancellation_idempotent",
      results.every((r) => !r.error) && racedAfter.status === "CANCELLED" && (await versionCount()) === 1,
      `${results.length} concurrent requests all succeeded → ${racedAfter.status}, still 1 version`);

    // ================================================================================
    // 2. RUNNING run — the worker owns the transition and stops at its next gate
    // ================================================================================
    const running = await makeRun({ status: "EXECUTING", phase: "generate", input_tokens: 1200, output_tokens: 300 });
    const rq = await requestRunCancel(base44, userA, { run_id: running.id });
    const flagged = await svc.entities.AIRun.get(running.id);
    check("running_run_cancel_recorded_durably",
      rq.cancel_requested === true && rq.cancelled === false && flagged.status === "EXECUTING" && flagged.cancel_requested === true && !!flagged.cancel_requested_at,
      `intent persisted while the run is still ${flagged.status}; the worker performs the transition`);

    const gated = await executeRunPhase(svc, running.id);
    const runningAfter = await svc.entities.AIRun.get(running.id);
    check("running_run_cancelled_by_worker_gate",
      gated.status === "CANCELLED" && gated.done === true && runningAfter.status === "CANCELLED" && runningAfter.phase === "done",
      `worker gate at phase "${gated.phase}" → ${gated.status}`);
    check("running_cancellation_audited", (await auditsFor(running.id)).length === 1, `${(await auditsFor(running.id)).length} ai.run.cancelled entry`);

    // ================================================================================
    // 3. A cancelled run mutates nothing and produces no version
    // ================================================================================
    const commitStage = await makeRun({ status: "EXECUTING", phase: "commit", cancel_requested: true, cancel_requested_by: userA.id, cancel_requested_at: new Date().toISOString() });
    const preVersions = await versionCount();
    const commitGated = await executeRunPhase(svc, commitStage.id);
    const commitAfter = await svc.entities.AIRun.get(commitStage.id);
    const fileAfter = await svc.entities.ProjectFile.get(file1.id);
    const journals = await svc.entities.CommitJournal.filter({ project_id: project.id }, "-created_date", 10);
    check("cancelled_run_performs_no_mutation",
      commitGated.status === "CANCELLED" && fileAfter.content === "// original\n" && journals.length === 0 && !commitAfter.version_id,
      `stopped before the commit phase mutated anything: file unchanged, ${journals.length} commit journal(s), no version_id`);
    check("cancelled_run_creates_no_version",
      (await versionCount()) === preVersions && (await versionCount()) === 1 && (await svc.entities.Project.get(project.id)).version_count === 1,
      `still ${await versionCount()} version (v${version1.number}) and project.version_count=1`);

    // ================================================================================
    // 4. Credits: the reservation is released and nothing is charged
    // ================================================================================
    await recordEvent(svc, { workspace_id: wsA.id, event_type: "promotional", amount: 5000, idempotency_key: `grant-${uid()}`, reason: "test grant" });
    const billed = await makeRun({ status: "EXECUTING", phase: "generate", input_tokens: 4000, output_tokens: 900 });
    const op = await svc.entities.AIOperation.create({
      workspace_id: wsA.id, project_id: project.id, run_id: billed.id, user_id: userA.id,
      operation_type: "ai_run", status: "running", credits_reserved: 200, idempotency_key: `run:${billed.id}`, started_at: new Date().toISOString(),
    });
    await reserve(svc, { workspace_id: wsA.id, project_id: project.id, operation_id: op.id, credits: 200, idempotency_key: `reserve:run:${billed.id}`, reason: "test reservation" });
    const held = await deriveBalance(svc, wsA.id);
    await svc.entities.AIRun.update(billed.id, { operation_id: op.id });
    await requestRunCancel(base44, userA, { run_id: billed.id });
    await executeRunPhase(svc, billed.id);
    const released = await deriveBalance(svc, wsA.id);
    const opAfter = await svc.entities.AIOperation.get(op.id);
    const billedAfter = await svc.entities.AIRun.get(billed.id);
    check("cancelled_run_releases_reservation",
      held.reserved === 200 && released.reserved === 0 && released.balance === 5000 && released.available === 5000,
      `reserved ${held.reserved} → ${released.reserved}, balance ${released.balance}, available ${released.available}`);
    check("cancelled_run_charges_nothing",
      (billedAfter.credits_charged || 0) === 0 && (opAfter.credits_charged || 0) === 0 && opAfter.status !== "completed",
      `run charged ${billedAfter.credits_charged}, operation ${opAfter.status} charged ${opAfter.credits_charged || 0}`);
    // A replayed cancellation must not move credits or audit a second time.
    await cancelRun(svc, billedAfter, { actor_id: userA.id, reason: "replay" });
    const replayed = await deriveBalance(svc, wsA.id);
    check("cancel_settlement_exactly_once",
      replayed.balance === released.balance && replayed.reserved === 0 && (await auditsFor(billed.id)).length === 1,
      `balance ${replayed.balance} unchanged on replay, ${(await auditsFor(billed.id)).length} audit entry`);

    // ================================================================================
    // 5. Authorization
    // ================================================================================
    const guarded = await makeRun({ status: "EXECUTING", phase: "generate" });
    await expectThrow("unauthorized_cancellation_rejected", () => requestRunCancel(base44, userB, { run_id: guarded.id }), "NOT_A_MEMBER");
    await expectThrow("anonymous_cancellation_rejected", () => requestRunCancel(base44, null, { run_id: guarded.id }), "AUTH_REQUIRED");
    await expectThrow("unknown_run_rejected", () => requestRunCancel(base44, userA, { run_id: `run-${uid()}` }), "RUN_NOT_FOUND");
    await expectThrow("missing_run_id_rejected", () => requestRunCancel(base44, userA, {}), "INVALID_INPUT");
    const guardedAfter = await svc.entities.AIRun.get(guarded.id);
    check("rejected_cancellation_left_run_running",
      guardedAfter.status === "EXECUTING" && guardedAfter.cancel_requested !== true && !guardedAfter.cancel_requested_by,
      `run still ${guardedAfter.status} with no cancellation intent recorded`);

    // ================================================================================
    // 6. A successful run is untouched by the cancellation path
    // ================================================================================
    const completed = await makeRun({
      status: "COMPLETED", phase: "done", version_id: version1.id, version_number: 1, credits_charged: 42,
      completed_at: new Date().toISOString(), usage_event_id: `ue-${uid()}`,
    });
    const c = await requestRunCancel(base44, userA, { run_id: completed.id });
    const completedAfter = await svc.entities.AIRun.get(completed.id);
    check("successful_run_unchanged",
      c.already_terminal === true && c.cancelled === false && c.status === "COMPLETED" &&
      completedAfter.status === "COMPLETED" && completedAfter.version_id === version1.id && completedAfter.credits_charged === 42 && completedAfter.cancel_requested !== true &&
      (await auditsFor(completed.id)).length === 0,
      `reported ${c.status}; record still COMPLETED with version ${completedAfter.version_number} and ${completedAfter.credits_charged} credits, no cancel audit`);
    const finalVersions = await versionCount();
    check("no_version_history_side_effects", finalVersions === 1 && (await svc.entities.ProjectFile.get(file1.id)).content === "// original\n",
      `${finalVersions} version and the project's file content untouched across the whole suite`);
  } catch (e) {
    check("suite_execution", false, `${e.message}`);
  } finally {
    for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
  }

  return harnessResponse(h);
}