// P-9 automatic renewal regression suite.
//
// Drives the REAL machinery — applyScheduledChanges/runBillingMaintenance → grantPeriodCredits →
// processBillingEvent → the immutable ledger — and asserts the renewal contract:
//   * an ACTIVE subscription past its period end, with no pending cancellation and no scheduled
//     plan change, rolls into the next billing cycle on its OWN anchor (P-8.2 preserved);
//   * the new cycle's message + integration credits are granted through the canonical
//     period-keyed billing event — never a parallel credit path;
//   * the grant stays cycle-bound (P-8.1): the previous cycle's unused remainder expires at its
//     boundary and the renewal's own expiry is exactly the new period end;
//   * renewal is idempotent and replay-safe (grant-first/roll-second), misses multiple cycles
//     safely (one grant for the cycle containing now), and honours a selected Elite credit
//     option with server-side exact-match re-validation;
//   * cancel_at_period_end, past_due, trials and scheduled plan changes keep their certified
//     behaviour, and one workspace's renewal never touches another's.
//
// Every fixture is scratch and removed afterwards.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { processBillingEvent } from "../../shared/billing.ts";
import { applyScheduledChanges, subscriptionFor } from "../../shared/subscriptions.ts";
import { runBillingMaintenance } from "../../shared/maintenance.ts";
import { deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { makeBillingPlan, makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";

const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;
// The same interval arithmetic the cycle machinery uses (addInterval/nextCycleEnd).
const step = (ms, interval = "monthly") => {
  const d = new Date(ms);
  if (interval === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
};

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check } = h;
  const stamp = Date.now();
  const created = { plans: [], workspaces: [] };

  const entriesOf = (wsId) => svc.entities.CreditLedgerEntry.filter({ workspace_id: wsId }, "created_date", 200);
  const balOf = (wsId) => deriveBalance(svc, wsId);
  const eventsOf = (wsId) => svc.entities.BillingEvent.filter({ workspace_id: wsId }, "created_date", 100);

  const mkws = async (label) => (await makeBillingWorkspace(svc, created, label, { plan: null, subscription: false }, stamp)).ws;
  const mkplan = (label, overrides = {}) => makeBillingPlan(svc, created, label, {
    tier_rank: 5, price_cents: 5000, included_credits: 100, included_integration_credits: 2000, ...overrides,
  }, stamp);
  const mksub = (ws, plan, bounds, extra = {}) => svc.entities.Subscription.create({
    workspace_id: ws.id, plan_code: plan.code, status: "active", provider: "manual",
    current_period_start: iso(bounds.start), current_period_end: iso(bounds.end),
    entitlements: {}, ...extra,
  });

  try {
    const base = await mkplan("monthly");
    const now = Date.now();

    // ---- 1/2/4: normal renewal, canonical grant, anchor, cycle-bound expiry, replay safety ----
    {
      const ws = await mkws("normal");
      // One FULL interval behind: the end lies on the anchor's own boundary grid and is due.
      const start = now - 40 * DAY, end = step(start);
      await mksub(ws, base, { start, end });
      const res = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const sub = await subscriptionFor(svc, ws.id);
      const bal = await balOf(ws.id);
      const renewal = (await eventsOf(ws.id)).find((e) => e.event_type === "subscription_renewed" && e.status === "processed");
      check("1. normal renewal: the active subscription rolls into its next cycle (provider=manual)",
        res.changed === true && res.action === "renewed" && sub.status === "active" && sub.plan_code === base.code,
        `action ${res.action}, status ${sub.status}`);
      check("4. cycle anchor preserved: the new period starts exactly at the old period end and runs one interval",
        sub.current_period_start === iso(end) && sub.current_period_end === iso(step(end)),
        `start ${sub.current_period_start} (want ${iso(end)}), end ${sub.current_period_end} (want ${iso(step(end))})`);
      check("2. message + integration credits granted through the canonical period-keyed billing event",
        bal.by_type.message.balance === 100 && bal.by_type.integration.balance === 2000 &&
        !!renewal && renewal.provider === "manual" && renewal.amount_cents === base.price_cents &&
        renewal.idempotency_key === `period:${ws.id}:${base.code}:${iso(step(end))}`,
        `message ${bal.by_type.message.balance}, integration ${bal.by_type.integration.balance}, key ${renewal?.idempotency_key}`);
      const rows = await entriesOf(ws.id);
      const msgGrant = rows.find((r) => !r.voided && r.amount > 0 && r.credit_type !== "integration");
      const intGrant = rows.find((r) => !r.voided && r.amount > 0 && r.credit_type === "integration");
      check("3. the renewal grant is cycle-bound: both pools expire exactly at the new period end",
        msgGrant?.metadata?.expires_at === iso(step(end)) && intGrant?.metadata?.expires_at === iso(step(end)),
        `msg ${msgGrant?.metadata?.expires_at}, int ${intGrant?.metadata?.expires_at}`);
      check("5. idempotent: a re-run over the rolled state transitions and grants nothing",
        (await applyScheduledChanges(svc, { workspace_id: ws.id })).changed === false &&
        (await balOf(ws.id)).by_type.message.balance === 100,
        "second pass was a no-op");
      // Crash simulation: the grant landed but the roll never did — the replay must settle as a
      // duplicate, never a second grant.
      await svc.entities.Subscription.update(sub.id, { current_period_start: iso(start), current_period_end: iso(end) });
      const replay = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const balReplay = await balOf(ws.id);
      const renewEvents = (await eventsOf(ws.id)).filter((e) => e.event_type === "subscription_renewed");
      check("5. replay safety: a grant-first/roll-failed replay never double-grants",
        replay.changed === true && replay.duplicate === true && balReplay.by_type.message.balance === 100 &&
        balReplay.by_type.integration.balance === 2000 && renewEvents.length === 1,
        `duplicate ${replay.duplicate}, balance ${balReplay.by_type.message.balance}, events ${renewEvents.length}`);
    }

    // ---- 3: the previous cycle's unused credits are gone at its boundary ----------------------
    {
      const ws = await mkws("expire");
      const start = now - 40 * DAY, end = now - 10 * DAY;
      await mksub(ws, base, { start, end });
      // A previous-cycle grant, cycle-bound to the OLD period end like a real one.
      await processBillingEvent(svc, {
        workspace_id: ws.id, provider: "manual", event_type: "subscription_renewed",
        credits: 500, integration_credits: 7000, plan_code: base.code,
        grant_expires_at: iso(end), idempotency_key: `old-cycle:${ws.id}`,
      });
      const beforeBoundary = await deriveBalance(svc, ws.id, null, end - 3600000);
      const res = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const bal = await balOf(ws.id);
      check("6. previous-cycle credits expired at their boundary; renewal grants only the new cycle (no rollover)",
        beforeBoundary.by_type.message.balance === 500 && bal.by_type.message.balance === 100 &&
        bal.by_type.integration.balance === 2000 && res.action === "renewed",
        `one hour before the old boundary ${beforeBoundary.by_type.message.balance}, after renewal ${bal.by_type.message.balance}`);
    }

    // ---- 7: missed maintenance over several cycles ------------------------------------------
    {
      const ws = await mkws("missed");
      const start = now - 70 * DAY;
      const end = step(start);
      await mksub(ws, base, { start, end });
      let prev = start, cur = step(start);
      while (cur <= now) { prev = cur; cur = step(cur); }
      const res = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const sub = await subscriptionFor(svc, ws.id);
      const bal = await balOf(ws.id);
      const renewEvents = (await eventsOf(ws.id)).filter((e) => e.event_type === "subscription_renewed");
      const grants = (await entriesOf(ws.id)).filter((r) => !r.voided && r.amount > 0 && r.credit_type !== "integration");
      check("7. missed maintenance: bounds roll directly to the cycle containing now, on the same anchor",
        res.action === "renewed" && sub.current_period_start === iso(prev) && sub.current_period_end === iso(cur),
        `start ${sub.current_period_start} (want ${iso(prev)}), end ${sub.current_period_end} (want ${iso(cur)})`);
      check("7. missed maintenance: exactly ONE grant — no duplicate grants for skipped, already-expired cycles",
        grants.length === 1 && renewEvents.length === 1 && bal.by_type.message.balance === 100 &&
        bal.by_type.integration.balance === 2000,
        `grants ${grants.length}, events ${renewEvents.length}, message ${bal.by_type.message.balance}`);
    }

    // ---- 8: Elite selected credit_option renewal ---------------------------------------------
    {
      const elite = await mkplan("elite", {
        tier_rank: 20, included_credits: 1200, included_integration_credits: 50000,
        credit_options: [
          { code: "elite_base", message_credits: 1200, integration_credits: 50000 },
          { code: "elite_x2", message_credits: 2400, integration_credits: 100000 },
        ],
      });
      const start = now - 40 * DAY, end = now - 10 * DAY;
      const wsChosen = await mkws("elite-chosen");
      await mksub(wsChosen, elite, { start, end }, { selected_credit_option: { code: "elite_x2", message_credits: 2400, integration_credits: 100000 } });
      const res = await applyScheduledChanges(svc, { workspace_id: wsChosen.id });
      const bal = await balOf(wsChosen.id);
      const sub = await subscriptionFor(svc, wsChosen.id);
      check("8. Elite renewal grants exactly the selected credit_option, re-validated server-side",
        res.action === "renewed" && bal.by_type.message.balance === 2400 &&
        bal.by_type.integration.balance === 100000 && sub.selected_credit_option?.code === "elite_x2",
        `message ${bal.by_type.message.balance}, integration ${bal.by_type.integration.balance}`);

      const wsForged = await mkws("elite-forged");
      await mksub(wsForged, elite, { start, end }, { selected_credit_option: { code: "elite_x2", message_credits: 999999, integration_credits: 1 } });
      await applyScheduledChanges(svc, { workspace_id: wsForged.id });
      const balForged = await balOf(wsForged.id);
      check("8. Elite renewal: a forged stored amount falls back to the plan's defaults, never the forgery",
        balForged.by_type.message.balance === 1200 && balForged.by_type.integration.balance === 50000,
        `message ${balForged.by_type.message.balance}, integration ${balForged.by_type.integration.balance}`);
    }

    // ---- 9/10: cancel_at_period_end does not renew; past_due is preserved ---------------------
    {
      const wsCancel = await mkws("cancel");
      await mksub(wsCancel, base, { start: now - 40 * DAY, end: now - 10 * DAY }, { cancel_at_period_end: true, cancelled_at: iso(now - 11 * DAY) });
      const resCancel = await applyScheduledChanges(svc, { workspace_id: wsCancel.id });
      const subCancel = await subscriptionFor(svc, wsCancel.id);
      const balCancel = await balOf(wsCancel.id);
      check("9. cancel_at_period_end: the subscription expires instead of renewing, with no grant",
        resCancel.action === "expired" && subCancel.status === "expired" &&
        balCancel.by_type.message.balance === 0 && balCancel.by_type.integration.balance === 0,
        `action ${resCancel.action}, status ${subCancel.status}`);

      const wsPastDue = await mkws("pastdue");
      await mksub(wsPastDue, base, { start: now - 40 * DAY, end: now - 10 * DAY }, { status: "past_due" });
      const resPastDue = await applyScheduledChanges(svc, { workspace_id: wsPastDue.id });
      const subPastDue = await subscriptionFor(svc, wsPastDue.id);
      check("10. past_due is preserved: a failed-payment subscription is never auto-renewed",
        resPastDue.changed === false && subPastDue.status === "past_due" &&
        (await balOf(wsPastDue.id)).by_type.message.balance === 0,
        `changed ${resPastDue.changed}, status ${subPastDue.status}`);
    }

    // ---- 11: a scheduled plan change at the boundary wins over renewal -----------------------
    {
      const target = await mkplan("target", { tier_rank: 9, included_credits: 250, included_integration_credits: 10000 });
      const ws = await mkws("scheduled");
      await mksub(ws, base, { start: now - 40 * DAY, end: now - 10 * DAY }, { scheduled_plan_code: target.code, scheduled_change_at: iso(now - 10 * DAY) });
      const res = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const sub = await subscriptionFor(svc, ws.id);
      const bal = await balOf(ws.id);
      const grants = (await entriesOf(ws.id)).filter((r) => !r.voided && r.amount > 0 && r.credit_type !== "integration");
      check("11. a scheduled plan change applies at the boundary with exactly one grant — no renewal on top",
        res.action === "downgrade_applied" && sub.plan_code === target.code && sub.scheduled_plan_code == null &&
        grants.length === 1 && bal.by_type.message.balance === 250 && bal.by_type.integration.balance === 10000,
        `action ${res.action}, plan ${sub.plan_code}, grants ${grants.length}, message ${bal.by_type.message.balance}`);
      check("11. the applied cycle's bounds are rolled, so a follow-up pass renews nothing",
        (await applyScheduledChanges(svc, { workspace_id: ws.id })).changed === false &&
        (await balOf(ws.id)).by_type.message.balance === 250,
        "follow-up pass was a no-op");
    }

    // ---- 12/13/14: the scheduled sweep, workspace isolation, repeated maintenance -------------
    {
      const wsDue = await mkws("sweep-due");
      const startD = now - 40 * DAY, endD = step(startD);
      await mksub(wsDue, base, { start: startD, end: endD });
      const wsFuture = await mkws("sweep-future");
      await mksub(wsFuture, base, { start: now - 5 * DAY, end: now + 25 * DAY });
      const futureBefore = await subscriptionFor(svc, wsFuture.id);

      const first = await runBillingMaintenance(svc, { workspace_ids: [wsDue.id, wsFuture.id] });
      const subDue = await subscriptionFor(svc, wsDue.id);
      const subFuture = await subscriptionFor(svc, wsFuture.id);
      const balDue = await balOf(wsDue.id);
      check("12. the real maintenance sweep performs the renewal (transitions.renewed) on the manual provider",
        first.transitions.renewed === 1 && subDue.current_period_start === iso(endD) &&
        balDue.by_type.message.balance === 100 && balDue.by_type.integration.balance === 2000,
        JSON.stringify({ renewed: first.transitions.renewed, message: balDue.by_type.message.balance }));
      check("13. workspace isolation: the not-due workspace keeps its bounds, its zero balance and its empty events",
        subFuture.current_period_start === futureBefore.current_period_start &&
        subFuture.current_period_end === futureBefore.current_period_end &&
        (await balOf(wsFuture.id)).by_type.message.balance === 0 &&
        (await eventsOf(wsFuture.id)).length === 0,
        `bounds unchanged: ${subFuture.current_period_end === futureBefore.current_period_end}, events ${(await eventsOf(wsFuture.id)).length}`);
      const second = await runBillingMaintenance(svc, { workspace_ids: [wsDue.id, wsFuture.id] });
      check("14. repeated maintenance is safe: the second sweep renews nothing and grants nothing",
        second.transitions.renewed === 0 && second.audits === 0 &&
        (await balOf(wsDue.id)).by_type.message.balance === 100,
        `renewed ${second.transitions.renewed}, audits ${second.audits}`);
    }

    // ---- ledger integrity across every fixture ------------------------------------------------
    {
      let integrityOk = true;
      for (const wsId of created.workspaces) if (!(await verifyBalanceIntegrity(svc, wsId)).ok) integrityOk = false;
      check("15. the ledger stays integrity-valid: renewal never wrote a balance directly",
        integrityOk, integrityOk ? "all workspaces consistent" : "a workspace drifted");
    }

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const wsId of created.workspaces) {
      await cleanupWorkspace(svc, wsId, ["Subscription", "BillingEvent", "CreditLedgerEntry", "Invoice", "AuditLog"]);
    }
    for (const id of created.plans) await svc.entities.BillingPlan.delete(id).catch(() => {});
  }
}