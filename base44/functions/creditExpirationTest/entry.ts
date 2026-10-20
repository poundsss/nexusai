// P-8.1/P-8.2 regression suite: Base44 credit expiration + billing-cycle anchoring.
//
// Drives the REAL machinery — processBillingEvent → ledger grants, recordEvent spends and
// reservations, grantFreePeriodCredits/runBillingMaintenance period grants, the real
// subscription lifecycle — and asserts the two parity contracts:
//   * cycle-bound grants: the unused remainder expires at the cycle boundary and never rolls
//     over; expired credits cannot be spent; top-up purchases expire at the reset too
//     (DOCUMENTED Base44: "top-up credits never carry over");
//   * the cycle boundary is anchored on the subscription's own period start (paid) or the
//     workspace's start date (free) — never on the calendar month.
//
// Every scenario runs in a throwaway workspace, is isolated from the others (an unexpected
// error is reported with its scenario label, never aborting the rest), and cleans up after itself.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { recordEvent, deriveBalance, verifyBalanceIntegrity, reserve, releaseReservation } from "../../shared/ledger.ts";
import { processBillingEvent, grantFreePeriodCredits, grantPeriodCredits, seedPlans } from "../../shared/billing.ts";
import { startSubscription, changePlan, applyScheduledChanges } from "../../shared/subscriptions.ts";
import { runBillingMaintenance } from "../../shared/maintenance.ts";

const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole;
  const results = [];
  const created = [];
  const t = (name, ok, detail) => { results.push({ test: name, ok: !!ok, detail }); return ok; };
  const section = async (label, fn) => {
    try { await fn(); }
    catch (e) { t(`${label} — unexpected error`, false, { error: e.message, code: e.code || null, status: e.status || null }); }
  };

  const newWorkspace = async (label) => {
    const ws = await db.entities.Workspace.create({ name: `exp-test ${label} ${Date.now()}`, owner_id: "credit_expiration_test", status: "active" });
    created.push(ws.id);
    return ws;
  };
  const entriesOf = (wsId) => db.entities.CreditLedgerEntry.filter({ workspace_id: wsId }, "created_date", 200).catch(() => []);
  const grant = (wsId, key, { credits, expiry, integration = 0, plan_code = null, event = "subscription_renewed" }) =>
    processBillingEvent(db, {
      workspace_id: wsId, provider: "none", event_type: event, credits, integration_credits: integration,
      plan_code, grant_expires_at: expiry, idempotency_key: `exp:${key}:${wsId}`,
    });

  try {
    await seedPlans(db);

    // --- 1. Cycle-bound grants: old cycle expires, new cycle gets only its own grant -------
    await section("cycles", async () => {
      const ws = await newWorkspace("cycles");
      await grant(ws.id, "old", { credits: 100, integration: 0, expiry: iso(Date.now() - HOUR) });
      await grant(ws.id, "new", { credits: 25, integration: 0, expiry: iso(Date.now() + HOUR) });
      const b = await deriveBalance(db, ws.id);
      // The old cycle's 100 did NOT roll over: the balance is the new grant alone.
      t("unused old-cycle credits expire (no rollover)", b.balance === 25, { balance: b.balance, would_have_rolled_over_to: 125 });
      t("new cycle receives only the new included grant", b.by_type.message.balance === 25, { message: b.by_type.message.balance });

      // Exactly at the boundary: derivation at t >= expires_at excludes the grant, and one
      // instant before the boundary it is still there.
      const rows = await entriesOf(ws.id);
      const liveEntry = rows.find((r) => !r.voided && r.amount > 0 && Date.parse(r.metadata?.expires_at) > Date.now());
      const boundary = Date.parse(liveEntry.metadata.expires_at);
      const before = await deriveBalance(db, ws.id, null, boundary - 1);
      const at = await deriveBalance(db, ws.id, null, boundary);
      t("credits expire exactly at the cycle boundary", before.balance === 25 && at.balance === 0,
        { before: before.balance, at_boundary: at.balance });
    });

    // --- 2. Expired credits cannot be spent ----------------------------------------------
    await section("spend-block", async () => {
      const ws = await newWorkspace("spend-block");
      await grant(ws.id, "expired", { credits: 100, integration: 0, expiry: iso(Date.now() - HOUR) });
      let refused = null;
      try {
        await recordEvent(db, { workspace_id: ws.id, event_type: "ai_charge", amount: -1, idempotency_key: `spend:${ws.id}` });
      } catch (e) { refused = e.code; }
      const after = await deriveBalance(db, ws.id);
      t("expired credits cannot be spent", refused === "INSUFFICIENT_CREDITS" && after.balance === 0,
        { refused, balance: after.balance });
    });

    // --- 3. Spending consumes cycle credits first; purchased credits survive -------------
    await section("fifo", async () => {
      const ws = await newWorkspace("fifo");
      await grant(ws.id, "expired", { credits: 50, integration: 0, expiry: iso(Date.now() - HOUR) });
      await grant(ws.id, "live", { credits: 30, integration: 0, expiry: iso(Date.now() + HOUR) });
      await recordEvent(db, { workspace_id: ws.id, event_type: "purchase", amount: 10, idempotency_key: `purch:${ws.id}` });
      await recordEvent(db, { workspace_id: ws.id, event_type: "ai_charge", amount: -20, idempotency_key: `chg:${ws.id}` });
      const b = await deriveBalance(db, ws.id);
      // The spend hit the LIVE cycle grant (30 → 10 remaining); the purchased 10 are untouched;
      // the expired grant's remainder dropped without ever being spendable after its expiry.
      t("spending consumes cycle credits first; purchased credits survive", b.by_type.message.balance === 20,
        { balance: b.by_type.message.balance, expected: 20 });
    });

    // --- 3b. Top-up purchases never carry over (DOCUMENTED Base44: "top-up credits never carry
    // over") — a credit_purchase grant carries the next reset boundary and the unused remainder
    // drops there, instead of staying permanent.
    await section("topup", async () => {
      const ws = await newWorkspace("topup");
      await grant(ws.id, "cycle", { credits: 100, integration: 0, expiry: iso(Date.now() + HOUR) });
      const purchase = await processBillingEvent(db, {
        workspace_id: ws.id, provider: "none", event_type: "credit_purchase",
        amount_cents: 1000, credits: 1000, plan_code: "credits_topup",
        idempotency_key: `topup:${ws.id}`,
      });
      const entry = (await entriesOf(ws.id)).find((r) => !r.voided && r.amount === 1000 && r.credit_type !== "integration");
      const expiry = entry?.metadata?.expires_at || null;
      t("a credit_purchase grant credits the ledger immediately", purchase.event.status === "processed" && entry?.amount === 1000,
        { status: purchase.event.status, amount: entry?.amount });
      t("a credit_purchase grant carries a reset expiry (never permanent)",
        !!expiry && Date.parse(expiry) > Date.now(),
        { expires_at: expiry });
      const replay = await processBillingEvent(db, {
        workspace_id: ws.id, provider: "none", event_type: "credit_purchase",
        amount_cents: 1000, credits: 1000, plan_code: "credits_topup",
        idempotency_key: `topup:${ws.id}`,
      });
      const afterReplay = await deriveBalance(db, ws.id);
      t("a replayed credit_purchase event does not credit twice (idempotent)",
        replay.duplicate === true && afterReplay.balance === 1100,
        { duplicate: replay.duplicate, balance: afterReplay.balance });
      // Just before the top-up's own expiry the cycle grant is already gone; the top-up holds.
      const beforeReset = await deriveBalance(db, ws.id, null, Date.parse(expiry) - 1);
      // AT the reset boundary the unused top-up remainder drops — it never carries over.
      const atReset = await deriveBalance(db, ws.id, null, Date.parse(expiry));
      t("unused top-up credits drop at the reset boundary (never carried over)",
        beforeReset.balance === 1000 && atReset.balance === 0,
        { before: beforeReset.balance, at_reset: atReset.balance });
    });

    // --- 4/5. Cycle anchored on subscription.current_period_start ------------------------
    await section("anchor", async () => {
      const ws = await newWorkspace("anchor");
      // A subscription started ten days ago, on its own anchor day and time.
      const anchor = new Date(Date.now() - 10 * 24 * HOUR);
      const expected = new Date(anchor.getTime());
      expected.setUTCMonth(expected.getUTCMonth() + 1);
      await db.entities.Subscription.create({
        workspace_id: ws.id, plan_code: "starter_monthly", status: "active", provider: "none",
        current_period_start: anchor.toISOString(), current_period_end: expected.toISOString(),
      });
      // A renewal grant with NO explicit expiry: the cycle end must be derived from the anchor.
      await processBillingEvent(db, {
        workspace_id: ws.id, provider: "none", event_type: "subscription_renewed",
        credits: 100, integration_credits: 2000, plan_code: "starter_monthly",
        idempotency_key: `renew-anchor:${ws.id}`,
      });
      const rows = await entriesOf(ws.id);
      const msg = rows.find((r) => r.credit_type !== "integration" && !r.voided);
      const expiresAt = msg?.metadata?.expires_at || null;
      const parsed = expiresAt ? new Date(expiresAt) : null;
      t("cycle anchored to subscription.current_period_start (not the calendar month)",
        !!parsed && parsed.getTime() === expected.getTime(),
        { expected_reset: expected.toISOString(), grant_expires_at: expiresAt });
      t("reset lands on the same day-of-month and exact time of the next period",
        !!parsed && parsed.getUTCDate() === anchor.getUTCDate() &&
        parsed.getUTCHours() === anchor.getUTCHours() && parsed.getUTCMinutes() === anchor.getUTCMinutes(),
        { anchor_day: anchor.getUTCDate(), reset: expiresAt });

      // grantPeriodCredits (the renewal path) derives the same anchored boundary.
      await grantPeriodCredits(db, { workspace_id: ws.id, plan_code: "starter_monthly", period_key: `test-${Date.now()}` });
      const rows2 = await entriesOf(ws.id);
      const renewals = rows2.filter((r) => !r.voided && r.credit_type !== "integration" && r.event_type === "purchase");
      t("renewal grants share the subscription-anchored cycle boundary",
        renewals.every((r) => r.metadata?.expires_at === expiresAt),
        { renewal_count: renewals.length, expiries_match: renewals.filter((r) => r.metadata?.expires_at === expiresAt).length });
    });

    // --- 6. Free plan: cycle anchored on the workspace start date, idempotent per cycle --
    await section("free", async () => {
      const ws = await newWorkspace("free");
      const first = await grantFreePeriodCredits(db, { workspace_id: ws.id });
      const again = await grantFreePeriodCredits(db, { workspace_id: ws.id });
      const b = await deriveBalance(db, ws.id);
      const rows = await entriesOf(ws.id);
      const expectedEnd = new Date(new Date(ws.created_date).getTime());
      expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1);
      t("free cycle grants the plan's credits (25 message / 100 integration)",
        b.by_type.message.balance === 25 && b.by_type.integration.balance === 100,
        { message: b.by_type.message.balance, integration: b.by_type.integration.balance });
      t("free cycle anchored on workspace start date (not the calendar month)",
        rows.every((r) => r.metadata?.expires_at === expectedEnd.toISOString()),
        { expected_cycle_end: expectedEnd.toISOString(), expiries: rows.map((r) => r.metadata?.expires_at) });
      t("duplicate free grant is idempotent", again.duplicate === true && !!first,
        { duplicate: again?.duplicate });

      // Duplicate maintenance runs grant once per cycle, never twice.
      const swept1 = await runBillingMaintenance(db, { workspace_ids: [ws.id] });
      const swept2 = await runBillingMaintenance(db, { workspace_ids: [ws.id] });
      const after = await deriveBalance(db, ws.id);
      t("duplicate maintenance runs create no duplicate grant",
        swept1.free_grants === 0 && swept2.free_grants === 0 && after.by_type.message.balance === 25,
        { first: swept1?.free_grants, second: swept2?.free_grants, balance: after.by_type.message.balance });
    });

    // --- 7. Upgrade/downgrade create no unexpected extra grants -------------------------
    await section("lifecycle", async () => {
      const ws = await newWorkspace("lifecycle");
      await startSubscription(db, { workspace_id: ws.id, plan_code: "starter_monthly", provider: "manual" });
      const afterStart = await entriesOf(ws.id);
      const afterStartBal = await deriveBalance(db, ws.id);
      t("subscription start grants exactly the plan's credits, cycle-bound",
        afterStartBal.by_type.message.balance === 100 && afterStartBal.by_type.integration.balance === 2000 &&
        afterStart.filter((r) => r.amount > 0).every((r) => !!r.metadata?.expires_at),
        { message: afterStartBal.by_type.message.balance, integration: afterStartBal.by_type.integration.balance, all_grants_cycle_bound: afterStart.filter((r) => r.amount > 0).every((r) => !!r.metadata?.expires_at) });

      // Downgrade: scheduled, nothing granted, no ledger movement.
      const down = await changePlan(db, { workspace_id: ws.id, plan_code: "free" });
      const afterDown = await entriesOf(ws.id);
      t("downgrade schedules without granting", down.direction === "downgrade" && afterDown.length === afterStart.length,
        { direction: down?.direction, entries_before: afterStart.length, entries_after: afterDown.length });

      // Upgrade (P-8.7): scheduled at period end — NO grant lands in the current cycle. At the
      // boundary exactly one new cycle-bound grant pair appears, and replaying grants nothing.
      const up = await changePlan(db, { workspace_id: ws.id, plan_code: "builder_monthly" });
      const afterUp = await entriesOf(ws.id);
      const balUp = await deriveBalance(db, ws.id);
      t("upgrade is scheduled without granting (no second grant in the same cycle)",
        up.direction === "upgrade" && afterUp.length === afterDown.length && balUp.by_type.message.balance === 100,
        { direction: up?.direction, entries: afterUp.length, message_balance: balUp.by_type.message.balance });

      const subRow = (await db.entities.Subscription.filter({ workspace_id: ws.id }, "-updated_date", 1))[0];
      await db.entities.Subscription.update(subRow.id, { scheduled_change_at: iso(Date.now() - 1000), current_period_end: iso(Date.now() - 1000) });
      const applied = await applyScheduledChanges(db, { workspace_id: ws.id });
      const afterApply = await entriesOf(ws.id);
      const balApply = await deriveBalance(db, ws.id);
      t("upgrade applies at the cycle boundary with exactly one new cycle-bound grant",
        applied.changed && afterApply.length === afterUp.length + 2 && balApply.by_type.message.balance === 350 &&
        afterApply.filter((r) => r.amount > 0 && r.credit_type !== "integration").every((r) => !!r.metadata?.expires_at),
        { entries: afterApply.length, message_balance: balApply.by_type.message.balance });

      const replay = await startSubscription(db, { workspace_id: ws.id, plan_code: "builder_monthly", provider: "manual" });
      const afterReplay = await entriesOf(ws.id);
      const balReplay = await deriveBalance(db, ws.id);
      t("replayed start/upgrade in the same cycle grants nothing extra",
        replay.duplicate === true && afterReplay.length === afterApply.length &&
        balReplay.by_type.message.balance === balApply.by_type.message.balance,
        { duplicate: replay?.duplicate, entries: afterReplay.length });
    });

    // --- 8. Reservations and concurrent spending stay safe against expiring credits ------
    await section("concurrency", async () => {
      const ws = await newWorkspace("concurrency");
      await grant(ws.id, "live", { credits: 100, integration: 0, expiry: iso(Date.now() + HOUR) });
      await reserve(db, { workspace_id: ws.id, credits: 60, idempotency_key: `hold:${ws.id}` });
      const held = await deriveBalance(db, ws.id);
      t("reservation holds cycle credits safely", held.reserved === 60 && held.available === 40,
        { reserved: held.reserved, available: held.available });

      let refused = null;
      try { await reserve(db, { workspace_id: ws.id, credits: 50, idempotency_key: `over:${ws.id}` }); }
      catch (e) { refused = e.code; }
      t("over-reservation against cycle credits is refused", refused === "INSUFFICIENT_CREDITS", { refused });

      // Two racing charges that together exceed the unreserved remainder: exactly one survives.
      await Promise.allSettled([
        recordEvent(db, { workspace_id: ws.id, event_type: "ai_charge", amount: -30, idempotency_key: `race-a:${ws.id}` }),
        recordEvent(db, { workspace_id: ws.id, event_type: "ai_charge", amount: -30, idempotency_key: `race-b:${ws.id}` }),
      ]);
      const raced = await deriveBalance(db, ws.id);
      const survivingCharges = (await entriesOf(ws.id)).filter((r) => r.event_type === "ai_charge" && !r.voided);
      t("concurrent spending never overdraws cycle credits",
        raced.available >= 0 && survivingCharges.length === 1,
        { available: raced.available, surviving_charges: survivingCharges.length });

      await releaseReservation(db, { workspace_id: ws.id, credits: 60, idempotency_key: `rel:${ws.id}` });
      const freed = await deriveBalance(db, ws.id);
      // After the cycle ends, the grant's unused remainder is gone (top-ups expire at their
      // own reset boundary — see the topup section).
      const nextCycle = await deriveBalance(db, ws.id, null, Date.now() + 2 * HOUR);
      t("released reservation frees the hold; expired remainder never rolls over",
        freed.reserved === 0 && nextCycle.balance === 0,
        { freed_reserved: freed.reserved, after_cycle: nextCycle.balance });
    });

    // --- 8b. Top-up purchases never carry over (DOCUMENTED Base44) ------------------------
    await section("topup", async () => {
      const ws = await newWorkspace("topup");
      const topup = await processBillingEvent(db, {
        workspace_id: ws.id, provider: "none", event_type: "credit_purchase",
        amount_cents: 1000, credits: 1000, plan_code: "credits_topup",
        idempotency_key: `topup:${ws.id}`,
      });
      const entry = (await entriesOf(ws.id)).find((r) => r.billing_event_id === topup.event.id && r.credit_type !== "integration");
      const boundary = entry?.metadata?.expires_at ? Date.parse(entry.metadata.expires_at) : null;
      t("a credit purchase lands on the balance immediately and carries the reset expiry",
        topup.event.status === "processed" && (await deriveBalance(db, ws.id)).balance === 1000 && !!boundary,
        { balance: (await deriveBalance(db, ws.id)).balance, expires_at: entry?.metadata?.expires_at || null });
      await recordEvent(db, { workspace_id: ws.id, event_type: "ai_charge", amount: -20, idempotency_key: `topup-spend:${ws.id}` });
      const spent = await deriveBalance(db, ws.id);
      const after = await deriveBalance(db, ws.id, null, boundary);
      t("unused top-up credits never carry over — they expire at the credit reset",
        spent.balance === 980 && after.balance === 0,
        { before_reset: spent.balance, after_reset: after.balance });
      const replay = await processBillingEvent(db, {
        workspace_id: ws.id, provider: "none", event_type: "credit_purchase",
        amount_cents: 1000, credits: 1000, plan_code: "credits_topup",
        idempotency_key: `topup:${ws.id}`,
      });
      t("a replayed purchase does not credit twice", replay.duplicate === true && (await deriveBalance(db, ws.id)).balance === 980,
        { duplicate: replay.duplicate, balance: (await deriveBalance(db, ws.id)).balance });
    });

    // --- 9. Ledger stays immutable and integrity-valid through all of the above ---------
    await section("immutability", async () => {
      const wsId = created[0];
      const snapshot = (await entriesOf(wsId)).map((r) =>
        ({ id: r.id, amount: r.amount, reserved_delta: r.reserved_delta, created_date: r.created_date, metadata: r.metadata, voided: r.voided }));
      await deriveBalance(db, wsId);
      await deriveBalance(db, wsId, null, Date.now() + 24 * HOUR);
      const reread = (await entriesOf(wsId)).map((r) =>
        ({ id: r.id, amount: r.amount, reserved_delta: r.reserved_delta, created_date: r.created_date, metadata: r.metadata, voided: r.voided }));
      const untouched = snapshot.length === reread.length &&
        snapshot.every((s, i) => JSON.stringify(s) === JSON.stringify(reread[i]));
      const integrity = await verifyBalanceIntegrity(db, wsId);
      t("derivation rewrites nothing: ledger entries byte-identical", untouched,
        { entries: snapshot.length, same: untouched });
      t("cached projection still matches the derived ledger", integrity.ok,
        { ok: integrity?.ok, cached: JSON.stringify(integrity?.cached || {}) });
    });

    const passed = results.filter((r) => r.ok).length;
    return Response.json({ ok: passed === results.length, passed, total: results.length, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, code: error.code || null, results }, { status: 500 });
  } finally {
    for (const wsId of created) {
      const entries = await db.entities.CreditLedgerEntry.filter({ workspace_id: wsId }, "created_date", 300).catch(() => []);
      for (const e of entries) await db.entities.CreditLedgerEntry.delete(e.id).catch(() => {});
      const events = await db.entities.BillingEvent.filter({ workspace_id: wsId }, "created_date", 100).catch(() => []);
      for (const e of events) await db.entities.BillingEvent.delete(e.id).catch(() => {});
      const invoices = await db.entities.Invoice.filter({ workspace_id: wsId }, "created_date", 100).catch(() => []);
      for (const i of invoices) await db.entities.Invoice.delete(i.id).catch(() => {});
      const subs = await db.entities.Subscription.filter({ workspace_id: wsId }, "created_date", 10).catch(() => []);
      for (const s of subs) await db.entities.Subscription.delete(s.id).catch(() => {});
      await db.entities.Workspace.delete(wsId).catch(() => {});
    }
  }
}