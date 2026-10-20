// Scheduled-trigger lifecycle certification: the DOCUMENTED schedule behaviors
// (Base44: Automations + Creating workflows + changelog) applied to the EXISTING
// ScheduledTrigger/ScheduledRun model —
//   • cron evaluated in the trigger's TIMEZONE (UTC default unchanged);
//   • ONE-TIME schedules fire once and then end;
//   • ends_type on (inclusive date) / after (N runs) archive the schedule;
//   • 5 consecutive failures PAUSE the trigger with a builder notification written
//     to the existing notification surface (the workspace audit log);
//   • regression: the unchanged cadence/idempotency/lease behavior (success ticks,
//     UTC cron, primitive idempotency).
//
// NOT covered (out of scope by approval): function.jsonc automations, retry/missed-run
// catch-up, sweep chunking/reliability, workflow API changes.
//
// The sweep is invoked with an explicit PROJECT scope — the test never advances
// triggers outside its scratch project.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import { makeBillingWorkspace, makeBillingPlan } from "../../shared/billingTestFixtures.ts";
import { createDeployedApp, MINIMAL_MAIN, MINIMAL_STYLES } from "../../shared/deployFixtures.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";
import { computeNextRun, processDueTriggers } from "../../shared/scheduler.ts";
import { invokePrimitive } from "../../shared/primitives.ts";

const FN_ECHO = `export const config = { method: 'ANY' };
export default async function (ctx) {
  if (ctx.request.body && ctx.request.body.fail) return { status: 500, body: { error: 'boom' } };
  return { status: 200, body: ctx.request.body || null };
}`;
const APP = `import { html } from 'runtime';
export default function App() { return html\`<div class="page"><h1 class="card-title">Sched</h1></div>\`; }
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (req) {
  const db = createClientFromRequest(req).asServiceRole;
  const harness = createHarness();
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const projectIds = [];

  try {
    const plan = await makeBillingPlan(db, created, `p9sc${stamp}`, {});
    const A = await makeBillingWorkspace(db, created, `p9sc${stamp}`, { plan });
    const app = await createDeployedApp(db, {
      workspace_id: A.ws.id, name: `p9sc ${stamp}`, slug: `p9sc-${stamp}`, deployed_by: A.user.id,
      entities: [], files: [[ENTRY_FILE, MINIMAL_MAIN], ["src/App.js", APP], ["styles.css", MINIMAL_STYLES]],
      extra_files: [["base44/functions/echoSched/entry.ts", FN_ECHO]],
      on_project_created: (p) => projectIds.push(p.id),
    });
    harness.check("setup: app deploys LIVE", app.run.status === "LIVE", String(app.run.status));
    if (app.run.status !== "LIVE") return harnessResponse(harness);
    const P = app.project;

    // ---- 1-2. timezone-aware cron + UTC regression (pure) ------------------------------------
    const after = new Date("2026-09-28T05:00:00.000Z");
    const tzChi = computeNextRun({ cron: "30 9 * * *", timezone: "America/Chicago" }, after);
    const tzUtc = computeNextRun({ cron: "30 9 * * *" }, after);
    harness.check("1 cron honors the trigger timezone (9:30 America/Chicago = 14:30Z CDT)",
      !!tzChi && tzChi.toISOString() === "2026-09-28T14:30:00.000Z", tzChi ? tzChi.toISOString() : "null");
    harness.check("2 cron regression: UTC default unchanged (9:30Z)",
      !!tzUtc && tzUtc.toISOString() === "2026-09-28T09:30:00.000Z", tzUtc ? tzUtc.toISOString() : "null");

    // ---- 3. one-time next-run computation (pure) ----------------------------------------------
    const onceFuture = computeNextRun({ one_time_at: "2026-10-01T00:00:00.000Z" }, after);
    const oncePast = computeNextRun({ one_time_at: "2026-01-01T00:00:00.000Z" }, after);
    harness.check("3 one-time: future date resolves once, past date never",
      !!onceFuture && onceFuture.toISOString() === "2026-10-01T00:00:00.000Z" && oncePast === null,
      `future=${onceFuture ? onceFuture.toISOString() : "null"} past=${oncePast}`);

    // ---- 4-8. ScheduleTask@1.1.0 validation and creation ---------------------------------------
    const prim = (input) => invokePrimitive(db, {
      primitive: "ScheduleTask", project: P, actor: "system",
      idempotency_key: `schedtest:${stamp}:${Math.random().toString(36).slice(2, 8)}`, input,
    });
    const badTz = await prim({ operation: "create", function_name: "echoSched", cron: "0 9 * * *", timezone: "Mars/Olympus" });
    harness.check("4 invalid timezone refused",
      badTz.ok === false && badTz.error && (badTz.error.code === "SCHEDULE_INVALID" || badTz.error.code === "PRIMITIVE_INPUT_INVALID"),
      JSON.stringify(badTz.error || badTz).slice(0, 140));
    const badEnds = await prim({ operation: "create", function_name: "echoSched", cron: "0 9 * * *", ends_type: "on" });
    harness.check("5 ends_type=on without ends_on_date refused",
      badEnds.ok === false && badEnds.error && (badEnds.error.code === "SCHEDULE_INVALID" || badEnds.error.code === "PRIMITIVE_INPUT_INVALID"),
      JSON.stringify(badEnds.error || badEnds).slice(0, 140));
    const badEndsType = await prim({ operation: "create", function_name: "echoSched", cron: "0 9 * * *", ends_type: "sometimes" });
    harness.check("6 unknown ends_type refused", badEndsType.ok === false, JSON.stringify(badEndsType.error || badEndsType).slice(0, 140));
    const badOnce = await prim({ operation: "create", function_name: "echoSched", one_time_at: "not-a-date" });
    harness.check("7 invalid one_time_at refused", badOnce.ok === false, JSON.stringify(badOnce.error || badOnce).slice(0, 140));
    const onceCreate = await prim({ operation: "create", function_name: "echoSched", one_time_at: "2026-10-01T00:00:00.000Z" });
    harness.check("8 one-time schedule creates with the new fields surfaced",
      onceCreate.ok === true && onceCreate.output && onceCreate.output.one_time_at === "2026-10-01T00:00:00.000Z" && onceCreate.output.ends_type === "never",
      JSON.stringify(onceCreate.output || onceCreate).slice(0, 200));

    // ---- 9-14. sweep lifecycle on the LIVE deployment (scoped to the scratch project) ----------
    // Cadence rows get a precomputed next_run_at slightly in the future, so the FIRST sweep
    // already executes them (a trigger without next_run_at is only planned on its first tick —
    // exactly the documented "computed at creation by the scheduler" behavior).
    const mk = (fields) => db.entities.ScheduledTrigger.create({
      project_id: P.id, enabled: true,
      ...(fields.one_time_at ? {} : { next_run_at: new Date(Date.now() + 50).toISOString() }),
      ...fields,
    });
    const tOk = await mk({ name: `ok1s${stamp}`, function_name: "echoSched", interval_seconds: 1, payload: { echo: "hi" } });
    const tEnds = await mk({ name: `ends2${stamp}`, function_name: "echoSched", interval_seconds: 1, ends_type: "after", ends_after_count: 2, payload: { echo: "ends" } });
    const tOnce = await mk({ name: `once3s${stamp}`, function_name: "echoSched", one_time_at: new Date(Date.now() + 3000).toISOString(), payload: { echo: "once" } });
    const tFail = await mk({ name: `missing5${stamp}`, function_name: "missingFn", interval_seconds: 1 });

    await processDueTriggers(db, new Date(), P.id); // sweep 1
    const okRow = await db.entities.ScheduledTrigger.get(tOk.id);
    harness.check("9 success tick executes and records the run bookkeeping",
      okRow.last_status === "success" && Number(okRow.run_count) === 1 && Number(okRow.consecutive_failures) === 0,
      JSON.stringify(okRow && { last_status: okRow.last_status, run_count: okRow.run_count }));

    await sleep(1200);
    await processDueTriggers(db, new Date(), P.id); // sweep 2: tEnds reaches its 2nd run
    const endsRow = await db.entities.ScheduledTrigger.get(tEnds.id);
    harness.check("10 ends_type=after archives the schedule after the Nth run",
      endsRow.enabled === false && endsRow.paused_reason === "schedule_ended" && Number(endsRow.run_count) === 2,
      JSON.stringify(endsRow && { enabled: endsRow.enabled, run_count: endsRow.run_count, paused_reason: endsRow.paused_reason }));

    await sleep(2200); // past tOnce's fire time
    await processDueTriggers(db, new Date(), P.id); // sweep 3: the one-time fires
    const onceRow = await db.entities.ScheduledTrigger.get(tOnce.id);
    harness.check("11 one-time schedule fires once and ends (enabled=false, completed)",
      onceRow.enabled === false && onceRow.paused_reason === "completed",
      JSON.stringify(onceRow && { enabled: onceRow.enabled, last_status: onceRow.last_status, paused_reason: onceRow.paused_reason }));

    for (let i = 0; i < 4; i++) { await sleep(1200); await processDueTriggers(db, new Date(), P.id); } // sweeps 4-7
    const failRow = await db.entities.ScheduledTrigger.get(tFail.id);
    harness.check("12 five consecutive failures pause the trigger",
      failRow.enabled === false && failRow.paused_reason === "consecutive_failures" && Number(failRow.consecutive_failures) === 5,
      JSON.stringify(failRow && { enabled: failRow.enabled, consecutive_failures: failRow.consecutive_failures, paused_reason: failRow.paused_reason }));
    const pausedNotifs = await db.entities.AuditLog.filter({ project_id: P.id, action: "schedule.paused" }, "-created_date", 5);
    harness.check("13 pause notification written to the existing builder notification surface (audit log)",
      pausedNotifs.length === 1 && pausedNotifs[0].resource_id === tFail.id && pausedNotifs[0].metadata && pausedNotifs[0].metadata.reason === "consecutive_failures",
      `notifications=${pausedNotifs.length}`);

    const tReset = await mk({ name: `reset${stamp}`, function_name: "echoSched", interval_seconds: 1, consecutive_failures: 3, payload: { echo: "reset" } });
    await sleep(1200);
    await processDueTriggers(db, new Date(), P.id); // sweep 8: a success resets the streak
    const resetRow = await db.entities.ScheduledTrigger.get(tReset.id);
    harness.check("14 regression: a success resets the consecutive-failure streak (no pause at 3 < 5)",
      Number(resetRow.consecutive_failures) === 0 && resetRow.last_status === "success" && resetRow.enabled !== false,
      JSON.stringify(resetRow && { consecutive_failures: resetRow.consecutive_failures, last_status: resetRow.last_status }));

    // ---- 15-16. bounded batch (worker execution budget) ---------------------------------------
    const beforeSlot = (await db.entities.ScheduledTrigger.get(tReset.id)).next_run_at;
    const batched = await processDueTriggers(db, new Date(), P.id, { batch_size: 1 });
    const afterSlot = (await db.entities.ScheduledTrigger.get(tReset.id)).next_run_at;
    harness.check("15 batch_size=1 processes exactly one trigger; triggers beyond the batch keep their due slot for the next tick",
      batched.results.length === 1 && afterSlot === beforeSlot,
      `processed=${batched.results.length} remaining=${batched.remaining} slot_kept=${afterSlot === beforeSlot}`);
    const drained = await processDueTriggers(db, new Date(), P.id, { batch_size: 5 });
    harness.check("16 continuation: a subsequent tick processes the remaining due triggers",
      drained.results.length >= 1 && drained.results.length <= 5,
      `processed=${drained.results.length}`);

    return harnessResponse(harness);
  } catch (error) {
    const s = harness.summary();
    return Response.json({ ...s, ok: false, error: error.message, stack: String(error.stack || "").slice(0, 400) }, { status: 500 });
  } finally {
    for (const pid of projectIds) {
      for (const entity of ["ScheduledTrigger", "ScheduledRun", "AuditLog", "Deployment", "DeploymentArtifact", "ProjectVersion", "ProjectFile", "Build", "FunctionInvocation", "AppRecord", "AppEntity", "AppSession", "WorkflowDefinition", "WorkflowRun", "WorkflowStepRun"]) {
        await purgeBy(db, entity, { project_id: pid });
      }
      await db.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(db, wid, ["Subscription", "CreditLedgerEntry", "BillingEvent", "AuditLog", "TraceEvent", "WorkspaceMember", "Project", "UsageEvent", "AIOperation"]);
    }
    for (const id of created.plans) await db.entities.BillingPlan.delete(id).catch(() => {});
    await db.entities.BillingPlan.deleteMany({ code: { $regex: "^test_p9sc" } }).catch(() => {});
  }
}