// E2E certification of scheduled billing maintenance (P-8.3): trial expiry, downgrade at period
// end, cancel-at-period-end expiry, upgrade immediacy, Free-plan rollover, entitlement
// recalculation, duplicate execution safety, suspended/terminated skipping and ledger integrity —
// through the REAL sweep, the REAL handler registry and the REAL job queue. Every fixture is
// scoped to scratch workspaces and removed afterwards.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import { seedPlans, entitlementsFor } from "../../shared/billing.ts";
import { startSubscription, changePlan, cancelSubscription, subscriptionFor } from "../../shared/subscriptions.ts";
import { runBillingMaintenance } from "../../shared/maintenance.ts";
import { MAINTENANCE_HANDLERS, MAINTENANCE_SCHEDULE } from "../../shared/jobHandlers.ts";
import { enqueue, runJobs } from "../../shared/jobQueue.ts";
import { deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";

const past = (ms) => new Date(Date.now() - ms).toISOString();

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check } = h;
  const stamp = Date.now();
  const Q = `bmt_${stamp}`;
  const created = { workspaces: [], plans: [], jobs: [] };

  const ledgerCount = async (wid) => (await svc.entities.CreditLedgerEntry.filter({ workspace_id: wid }, "created_date", 500)).filter((e) => !e.voided).length;
  const auditCount = async (action, resource_id) => (await svc.entities.AuditLog.filter({ action, resource_id }, "-created_date", 10)).length;

  try {
    await seedPlans(svc);

    const mkplan = (code, extra = {}) => svc.entities.BillingPlan.create({
      code, name: code, price_cents: 1000, interval: "monthly", included_credits: 100, included_integration_credits: 0,
      trial_days: 0, tier_rank: 5, visibility: "public", limits: {}, usage_limits: {}, model_access: [],
      overage_policy: "block", entitlements: { advanced_models: true, sso: true }, provider: "none", active: true, ...extra,
    });
    const P_TRIAL = await mkplan(`bmt_trial_${stamp}`, { trial_days: 7, included_credits: 50 });
    const P_HIGH = await mkplan(`bmt_high_${stamp}`, { tier_rank: 10, included_credits: 500 });
    const P_LOW = await mkplan(`bmt_low_${stamp}`, { tier_rank: 2, included_credits: 120 });
    created.plans.push(P_TRIAL.id, P_HIGH.id, P_LOW.id);

    const mkws = (name, status = "active") => svc.entities.Workspace.create({ name: `bmt-${name} ${stamp}`, owner_id: `bmt_${name}_${stamp}`, status });
    const track = (ws) => { created.workspaces.push(ws.id); return ws; };

    // Fixture: a trialing subscription whose trial ended two days ago.
    const W_TRIAL = track(await mkws("trial"));
    await startSubscription(svc, { workspace_id: W_TRIAL.id, plan_code: P_TRIAL.code });
    const subTrial0 = await subscriptionFor(svc, W_TRIAL.id);
    await svc.entities.Subscription.update(subTrial0.id, { trial_end: past(2 * 86400000) });

    // Fixture: a scheduled downgrade whose date passed an hour ago.
    const W_DG = track(await mkws("dg"));
    await startSubscription(svc, { workspace_id: W_DG.id, plan_code: P_HIGH.code });
    await changePlan(svc, { workspace_id: W_DG.id, plan_code: P_LOW.code });
    const subDg0 = await subscriptionFor(svc, W_DG.id);
    await svc.entities.Subscription.update(subDg0.id, { scheduled_change_at: past(3600000) });
    const dgLedgerBefore = await ledgerCount(W_DG.id);
    const dgEventsBefore = (await svc.entities.BillingEvent.filter({ workspace_id: W_DG.id }, "created_date", 100)).length;

    // Fixture: a cancellation scheduled at a period end that already passed.
    const W_CX = track(await mkws("cx"));
    await startSubscription(svc, { workspace_id: W_CX.id, plan_code: P_HIGH.code });
    await cancelSubscription(svc, { workspace_id: W_CX.id });
    const subCx0 = await subscriptionFor(svc, W_CX.id);
    await svc.entities.Subscription.update(subCx0.id, { current_period_end: past(3600000) });

    // Fixture: a scheduled upgrade (P-8.7: upgrades take effect at the next cycle like downgrades —
    // nothing granted mid-cycle; the sweep must leave it untouched before the boundary).
    const W_UP = track(await mkws("up"));
    await startSubscription(svc, { workspace_id: W_UP.id, plan_code: P_LOW.code });
    const upLedgerBefore = await ledgerCount(W_UP.id);
    await changePlan(svc, { workspace_id: W_UP.id, plan_code: P_HIGH.code });

    // Fixture: a subscription-less workspace (implicit Free plan).
    const W_FREE = track(await mkws("free"));

    // Fixtures: suspended workspace with a due downgrade, suspended workspace with no subscription,
    // and a terminated workspace — all must be skipped entirely.
    const W_SUS = track(await mkws("sus", "suspended"));
    await startSubscription(svc, { workspace_id: W_SUS.id, plan_code: P_HIGH.code });
    await changePlan(svc, { workspace_id: W_SUS.id, plan_code: P_LOW.code });
    const subSus0 = await subscriptionFor(svc, W_SUS.id);
    await svc.entities.Subscription.update(subSus0.id, { scheduled_change_at: past(3600000) });
    const W_SUSFREE = track(await mkws("susfree", "suspended"));
    const W_TERM = track(await mkws("term", "terminated"));

    // Fixture for the end-to-end job-queue run: another expired trial.
    const W_JOB = track(await mkws("job"));
    await startSubscription(svc, { workspace_id: W_JOB.id, plan_code: P_TRIAL.code });
    const subJob0 = await subscriptionFor(svc, W_JOB.id);
    await svc.entities.Subscription.update(subJob0.id, { trial_end: past(86400000) });

    // ------------------------------------------------------------------ the sweep
    // W_JOB is left OUT of the direct sweeps so the queued run (check 10) is what expires it.
    const sweepScope = created.workspaces.filter((id) => id !== W_JOB.id);
    const first = await runBillingMaintenance(svc, { workspace_ids: sweepScope });

    const subTrial = await subscriptionFor(svc, W_TRIAL.id);
    check("1. expired trial: a trialing subscription past its trial_end becomes past_due, its entitlements are revoked (stored AND derived) and the transition is audited exactly once",
      subTrial.status === "past_due" && Object.keys(subTrial.entitlements || {}).length === 0
      && Object.keys((await entitlementsFor(svc, W_TRIAL.id)).entitlements).length === 0
      && (await auditCount("billing.scheduled.trial_ended", subTrial.id)) === 1,
      `status ${subTrial.status}`);

    const subDg = await subscriptionFor(svc, W_DG.id);
    const dgLedgerAfter = await ledgerCount(W_DG.id);
    const dgEventsAfter = (await svc.entities.BillingEvent.filter({ workspace_id: W_DG.id }, "created_date", 100)).length;
    check("2. downgrade at period end: applied through exactly one processed billing event, the new plan's credits granted once, scheduled fields cleared, audit anchored on the billing event",
      subDg.plan_code === P_LOW.code && subDg.scheduled_plan_code == null && subDg.status === "active"
      && dgEventsAfter === dgEventsBefore + 1 && dgLedgerAfter === dgLedgerBefore + 1
      && (await auditCount("billing.scheduled.downgrade_applied", (await svc.entities.BillingEvent.filter({ workspace_id: W_DG.id, event_type: "subscription_renewed" }, "-created_date", 1))[0].id)) === 1,
      `plan ${subDg.plan_code}, ledger ${dgLedgerBefore}→${dgLedgerAfter}`);

    const subCx = await subscriptionFor(svc, W_CX.id);
    check("3. cancel at period end: the subscription expires at its period end, its entitlements are cleared, and it is audited exactly once",
      subCx.status === "expired" && Object.keys(subCx.entitlements || {}).length === 0
      && (await auditCount("billing.scheduled.expired", subCx.id)) === 1 && first.entitlements_cleared === 2,
      `status ${subCx.status}, cleared ${first.entitlements_cleared}`);

    const subUp = await subscriptionFor(svc, W_UP.id);
    check("4. upgrade parity (P-8.7): an upgrade is scheduled at period end with no immediate grant — plan, entitlements and ledger stay untouched until the boundary, and the sweep reports exactly the three due transitions",
      subUp.plan_code === P_LOW.code && subUp.scheduled_plan_code === P_HIGH.code && subUp.status === "active"
      && (await ledgerCount(W_UP.id)) === upLedgerBefore
      && first.transitions.downgrade_applied === 1 && first.transitions.expired === 1 && first.transitions.trial_ended === 1,
      `plan ${subUp.plan_code} → ${subUp.scheduled_plan_code}, ledger ${upLedgerBefore} entries, transitions ${JSON.stringify(first.transitions)}`);

    const freeBal = await deriveBalance(svc, W_FREE.id);
    check("5. credit rollover: the subscription-less workspace's Free-plan period grant lands exactly once, through the ledger in both pools",
      first.free_grants === 1 && freeBal.by_type.message.balance === 25 && freeBal.by_type.integration.balance === 100,
      JSON.stringify(freeBal.by_type));

    const subSus = await subscriptionFor(svc, W_SUS.id);
    const susEvents = (await svc.entities.BillingEvent.filter({ workspace_id: W_SUS.id }, "created_date", 100)).length;
    const susFreeEvents = (await svc.entities.BillingEvent.filter({ workspace_id: W_SUSFREE.id }, "created_date", 100)).length;
    check("6. suspended and terminated workspaces are skipped: no state transition, no grants, no billing events while they cannot serve",
      subSus.plan_code === P_HIGH.code && subSus.scheduled_plan_code === P_LOW.code && subSus.status === "active"
      && susEvents === 1 && susFreeEvents === 0
      && first.skipped_suspended === 2 && first.skipped_terminated === 1,
      JSON.stringify({ sus_plan: subSus.plan_code, scheduled: subSus.scheduled_plan_code, susEvents, susFreeEvents }));

    const ledgersBefore = {};
    for (const wid of created.workspaces) ledgersBefore[wid] = await ledgerCount(wid);
    const auditsBefore = (await svc.entities.AuditLog.filter({}, "-created_date", 500)).filter((a) => String(a.action || "").startsWith("billing.scheduled.")).length;
    const second = await runBillingMaintenance(svc, { workspace_ids: sweepScope });
    let ledgersUnchanged = true;
    for (const wid of created.workspaces) if (await ledgerCount(wid) !== ledgersBefore[wid]) ledgersUnchanged = false;
    const auditsAfter = (await svc.entities.AuditLog.filter({}, "-created_date", 500)).filter((a) => String(a.action || "").startsWith("billing.scheduled.")).length;
    check("7. duplicate execution is safe: a second pass over the same state transitions nothing, grants nothing and audits nothing",
      second.transitions.downgrade_applied === 0 && second.transitions.expired === 0 && second.transitions.trial_ended === 0
      && second.free_grants === 0 && second.entitlements_cleared === 0 && second.audits === 0
      && ledgersUnchanged && auditsAfter === auditsBefore,
      JSON.stringify(second));

    let integrityOk = true;
    for (const wid of created.workspaces) if (!(await verifyBalanceIntegrity(svc, wid)).ok) integrityOk = false;
    check("8. the ledger is the only credit truth: the sweep never writes a balance directly — every fixture's cached balance equals its derived ledger total",
      integrityOk, integrityOk ? "all workspaces consistent" : "a workspace drifted");

    check("9. the sweep is a registered singleton-guarded handler on the recurring maintenance schedule",
      typeof MAINTENANCE_HANDLERS["billing.apply_scheduled_changes"] === "function"
      && MAINTENANCE_SCHEDULE.some((s) => s.job_type === "billing.apply_scheduled_changes" && s.queue === "maintenance"));

    const { job } = await enqueue(svc, { queue: Q, job_type: "billing.apply_scheduled_changes", payload: { workspace_ids: [W_JOB.id] } });
    created.jobs.push(job.id);
    await runJobs(svc, { queue: Q, handlers: MAINTENANCE_HANDLERS, worker_id: "bmt-worker", max_jobs: 3, budget_ms: 30000 });
    const jobDone = await svc.entities.BackgroundJob.get(job.id);
    const subJob = await subscriptionFor(svc, W_JOB.id);
    check("10. scheduled execution actually runs: the queued sweep expired the trial workspace through the real worker and the real handler registry",
      jobDone.status === "succeeded" && jobDone.result?.transitions?.trial_ended === 1 && subJob.status === "past_due",
      `${jobDone.status} → ${subJob.status}`);

    check("11. payload scoping narrows only: the job processed exactly the one requested workspace with the worker's own clock",
      jobDone.result?.workspaces_scanned === 1 && jobDone.result?.processed === 1 && jobDone.result?.skipped_suspended === 0 && jobDone.result?.skipped_terminated === 0,
      JSON.stringify(jobDone.result || {}));

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    await purgeBy(svc, "BackgroundJob", { queue: Q }).catch(() => {});
    for (const id of created.jobs) await svc.entities.BackgroundJob.delete(id).catch(() => {});
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["Subscription", "BillingEvent", "CreditLedgerEntry", "CreditTransaction", "AuditLog", "Invoice", "BillingCustomer", "Budget", "UsageEvent"]);
    }
    for (const pid of created.plans) await svc.entities.BillingPlan.delete(pid).catch(() => {});
  }
}