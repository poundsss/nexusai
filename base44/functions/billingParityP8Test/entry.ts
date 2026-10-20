// P-8.6 / P-8.7 / P-8.8 targeted parity suite.
//
//   P-8.6 annual billing: the yearly variants exist at exactly monthly × 12 × 0.8, carry the
//   same included credits as their monthly tier, and a yearly subscription's grant is
//   cycle-bound to a ~1-year cycle through the standard P-8.1/P-8.2 machinery.
//   P-8.7 upgrade parity: BOTH directions are scheduled at the current period's end through the
//   EXISTING scheduled-plan mechanism — no second grant lands in the same cycle, the boundary
//   grant is period-keyed and idempotent, and downgrade/cancel stay intact.
//   P-8.8 Elite credits: a selectable credit volume is NAMED by code only, fixed on the
//   subscription, granted at start and at every renewal exactly as chosen, re-validated
//   server-side at every grant (a forged stored amount outside the plan's list grants the
//   plan's defaults, never the forgery), and an unknown option is refused before any ledger
//   movement. Base44 publishes the mechanism but not the exact option values (UNKNOWN) — the
//   ladder exercised here is scratch.
//   P-8.9/P-8.10: period-scoped grant dedupe (checkout + first invoice.paid grant ONCE per
//   plan-period; later periods grant again), concurrent duplicate delivery settlement (one
//   processed event row, one credit movement) and the provider price → plan reverse lookup
//   (fail-closed on an unmapped price).
//
// Every fixture is scratch and removed. Certified P-8.1–P-8.5 behavior is only exercised.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace } from "../../shared/testHarness.ts";
import { seedPlans, getPlan, grantPeriodCredits, processBillingEvent, planByProviderPrice } from "../../shared/billing.ts";
import { mapStripeEvent } from "../../shared/paymentProviders.ts";
import { startSubscription, changePlan, cancelSubscription, subscriptionFor, applyScheduledChanges } from "../../shared/subscriptions.ts";
import { deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { makeBillingPlan, makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";

const iso = (ms) => new Date(ms).toISOString();
const past = (ms) => iso(Date.now() - ms);

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check, expectThrow } = h;
  const stamp = Date.now();
  const created = { plans: [], workspaces: [] };

  const entriesOf = (wsId) => svc.entities.CreditLedgerEntry.filter({ workspace_id: wsId }, "created_date", 200);
  const balOf = (wsId) => deriveBalance(svc, wsId);
  const mkws = async (label) => (await makeBillingWorkspace(svc, created, label, { plan: null, subscription: false }, stamp)).ws;

  try {
    await seedPlans(svc);

    // ---- P-8.6: annual plans in the catalog ---------------------------------
    const yearly = [
      ["starter_yearly", "starter_monthly", 19200],
      ["builder_yearly", "builder_monthly", 48000],
      ["pro_yearly", "pro_monthly", 96000],
      ["scale_yearly", "scale_monthly", 192000],
    ];
    for (const [code, monthlyCode, price] of yearly) {
      const y = await getPlan(svc, code);
      const m = await getPlan(svc, monthlyCode);
      check(`P-8.6 ${code}: exists, yearly interval, exactly monthly × 12 × 0.8`,
        !!y && y.interval === "yearly" && y.price_cents === price && m.price_cents * 12 * 0.8 === price,
        `${y?.price_cents} vs ${m?.price_cents} × 12 × 0.8`);
      check(`P-8.6 ${code}: included credits unchanged from the monthly tier`,
        y.included_credits === m.included_credits && y.included_integration_credits === m.included_integration_credits,
        `${y?.included_credits}/${y?.included_integration_credits}`);
    }

    // A yearly subscription grants once, cycle-bound to a ~1-year cycle.
    {
      const ws = await mkws("annual");
      await startSubscription(svc, { workspace_id: ws.id, plan_code: "starter_yearly", provider: "manual" });
      const bal = await balOf(ws.id);
      const rows = await entriesOf(ws.id);
      const msg = rows.find((r) => !r.voided && r.credit_type !== "integration");
      const days = msg ? (Date.parse(msg.metadata?.expires_at) - Date.now()) / 86400000 : 0;
      check("P-8.6 yearly subscription grants the tier's credits with a ~1-year cycle-bound expiry",
        bal.by_type.message.balance === 100 && bal.by_type.integration.balance === 2000 && days > 360 && days < 366,
        { message: bal.by_type.message.balance, integration: bal.by_type.integration.balance, expiry_days: Math.round(days) });
    }

    // ---- P-8.7: upgrades scheduled at the cycle boundary ----------------------
    {
      const low = await makeBillingPlan(svc, created, "low", { tier_rank: 2, included_credits: 100, included_integration_credits: 1000, price_cents: 1000, visibility: "public" }, stamp);
      const high = await makeBillingPlan(svc, created, "high", { tier_rank: 8, included_credits: 500, included_integration_credits: 5000, price_cents: 5000, visibility: "public" }, stamp);
      const ws = await mkws("sched");
      await startSubscription(svc, { workspace_id: ws.id, plan_code: low.code, provider: "manual" });
      const before = (await entriesOf(ws.id)).length;
      const balBefore = (await balOf(ws.id)).by_type.message.balance;

      const up = await changePlan(svc, { workspace_id: ws.id, plan_code: high.code });
      const sub = await subscriptionFor(svc, ws.id);
      check("P-8.7 upgrade is scheduled at period end, not applied now",
        up.direction === "upgrade" && up.credits_applied === 0 && sub.plan_code === low.code &&
        sub.scheduled_plan_code === high.code && (await entriesOf(ws.id)).length === before &&
        (await balOf(ws.id)).by_type.message.balance === balBefore,
        `plan ${sub.plan_code} → ${sub.scheduled_plan_code}`);

      const noop = await applyScheduledChanges(svc, { workspace_id: ws.id });
      check("P-8.7 before the boundary nothing is granted or applied",
        noop.changed === false && (await entriesOf(ws.id)).length === before,
        JSON.stringify(noop));

      const subRow = await subscriptionFor(svc, ws.id);
      await svc.entities.Subscription.update(subRow.id, { scheduled_change_at: past(1000), current_period_end: past(1000) });
      const applied = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const after = await subscriptionFor(svc, ws.id);
      const balAfter = await balOf(ws.id);
      check("P-8.7 the boundary applies the upgrade with exactly one new cycle-bound grant",
        applied.changed && after.plan_code === high.code && after.scheduled_plan_code == null &&
        balAfter.by_type.message.balance === balBefore + 500 && balAfter.by_type.integration.balance === 1000 + 5000,
        `plan ${after.plan_code}, message ${balAfter.by_type.message.balance}`);
      const grantRows = (await entriesOf(ws.id)).filter((r) => r.amount > 0 && r.credit_type !== "integration");
      check("P-8.7 the boundary grant is cycle-bound and the ledger stays integrity-valid",
        grantRows.every((r) => !!r.metadata?.expires_at) && grantRows.length === 2 &&
        (await verifyBalanceIntegrity(svc, ws.id)).ok,
        `${grantRows.length} grant entries`);

      const again = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const balAgain = await balOf(ws.id);
      check("P-8.7 re-driving the boundary grants nothing (no double grant in one cycle)",
        again.changed === false && balAgain.by_type.message.balance === balAfter.by_type.message.balance,
        JSON.stringify(again));

      // Downgrade/cancel remain intact on the same subscription.
      const down = await changePlan(svc, { workspace_id: ws.id, plan_code: low.code });
      const subDown = await subscriptionFor(svc, ws.id);
      check("P-8.7 downgrade still schedules without granting",
        down.direction === "downgrade" && subDown.scheduled_plan_code === low.code && subDown.plan_code === high.code,
        `plan ${subDown.plan_code} → ${subDown.scheduled_plan_code}`);
      await svc.entities.Subscription.update(subDown.id, { scheduled_plan_code: null, scheduled_change_at: null });
      await cancelSubscription(svc, { workspace_id: ws.id });
      const subCancel = await subscriptionFor(svc, ws.id);
      await svc.entities.Subscription.update(subCancel.id, { current_period_end: past(1000) });
      const expired = await applyScheduledChanges(svc, { workspace_id: ws.id });
      check("P-8.7 cancel-at-period-end still expires at the boundary",
        subCancel.cancel_at_period_end === true && expired.action === "expired" && (await subscriptionFor(svc, ws.id)).status === "expired",
        (await subscriptionFor(svc, ws.id)).status);
    }

    // ---- P-8.8: configurable Elite credit allowance ---------------------------
    {
      const elite = await makeBillingPlan(svc, created, "elite", {
        tier_rank: 20, price_cents: 20000, visibility: "public",
        included_credits: 1200, included_integration_credits: 50000,
        credit_options: [
          { code: "base", message_credits: 1200, integration_credits: 50000 },
          { code: "double", message_credits: 2400, integration_credits: 100000 },
        ],
      }, stamp);
      const plain = await makeBillingPlan(svc, created, "plain", { tier_rank: 5, included_credits: 300, included_integration_credits: 3000, visibility: "public" }, stamp);
      const ws = await mkws("elite");

      // A chosen volume is NAMED by code only and fixed on the subscription.
      await startSubscription(svc, { workspace_id: ws.id, plan_code: elite.code, provider: "manual", credit_option_code: "double" });
      let sub = await subscriptionFor(svc, ws.id);
      let bal = await balOf(ws.id);
      check("P-8.8 the chosen option is granted exactly at start and fixed on the subscription",
        bal.by_type.message.balance === 2400 && bal.by_type.integration.balance === 100000 &&
        sub.selected_credit_option?.code === "double" && sub.selected_credit_option?.message_credits === 2400,
        `message ${bal.by_type.message.balance}, option ${JSON.stringify(sub.selected_credit_option)}`);

      // Renewal grants exactly the chosen volume, through the canonical period-keyed event.
      const renew = await grantPeriodCredits(svc, { workspace_id: ws.id, plan_code: elite.code, period_key: `next-${stamp}` });
      const renewReplay = await grantPeriodCredits(svc, { workspace_id: ws.id, plan_code: elite.code, period_key: `next-${stamp}` });
      const balRenew = await balOf(ws.id);
      check("P-8.8 renewal grants exactly the selected volume, idempotently",
        renew.credits_applied === 2400 && renew.duplicate === false && renewReplay.duplicate === true &&
        balRenew.by_type.message.balance === 4800 && balRenew.by_type.integration.balance === 200000,
        `charged ${renew.credits_applied}, message ${balRenew.by_type.message.balance}`);

      // An unknown option name is refused before anything moves.
      const entriesBefore = (await entriesOf(ws.id)).length;
      await expectThrow("P-8.8 an unknown option code is refused before any ledger movement",
        () => changePlan(svc, { workspace_id: ws.id, plan_code: plain.code, credit_option_code: "bogus" }), "UNKNOWN_CREDIT_OPTION");
      await expectThrow("P-8.8 an option cannot be named on a plan that has none",
        () => changePlan(svc, { workspace_id: ws.id, plan_code: plain.code, credit_option_code: "base" }), "UNKNOWN_CREDIT_OPTION");
      check("P-8.8 refused option names moved nothing",
        (await entriesOf(ws.id)).length === entriesBefore, `${entriesBefore} entries`);

      // A forged stored amount (outside the plan's list) grants the plan's DEFAULTS, never the forgery.
      const forged = await subscriptionFor(svc, ws.id);
      await svc.entities.Subscription.update(forged.id, { selected_credit_option: { code: "double", message_credits: 999999, integration_credits: 999999 } });
      const forgedRenew = await grantPeriodCredits(svc, { workspace_id: ws.id, plan_code: elite.code, period_key: `forged-${stamp}` });
      const balForged = await balOf(ws.id);
      check("P-8.8 a forged stored amount never grants — exact-match re-validation falls back to the plan's defaults",
        forgedRenew.credits_applied === 1200 && balForged.by_type.message.balance === 6000,
        `charged ${forgedRenew.credits_applied}, message ${balForged.by_type.message.balance}`);

      // Standard plans are unaffected: no options, fixed defaults granted.
      const ws2 = await mkws("plain");
      await startSubscription(svc, { workspace_id: ws2.id, plan_code: plain.code, provider: "manual" });
      const balPlain = await balOf(ws2.id);
      check("P-8.8 a plan without credit_options still grants its fixed defaults",
        balPlain.by_type.message.balance === 300 && balPlain.by_type.integration.balance === 3000 &&
        (await subscriptionFor(svc, ws2.id)).selected_credit_option == null,
        `message ${balPlain.by_type.message.balance}`);
    }

    // ---- P-8.9 / P-8.10 targeted checks -------------------------------------------------------
    {
      const plan = await makeBillingPlan(svc, created, "scope", { tier_rank: 4, price_cents: 2000, included_credits: 200, included_integration_credits: 2000, visibility: "public" }, stamp);
      const ws = await mkws("scope");
      const start = await startSubscription(svc, { workspace_id: ws.id, plan_code: plan.code, provider: "manual", trial: false });
      const checkoutAgain = await processBillingEvent(svc, { workspace_id: ws.id, provider: "stripe", provider_event_id: `evt_chk_${stamp}`, event_type: "subscription_started", plan_code: plan.code, amount_cents: plan.price_cents });
      const invoiceFirst = await processBillingEvent(svc, { workspace_id: ws.id, provider: "stripe", provider_event_id: `evt_inv_${stamp}`, event_type: "subscription_renewed", plan_code: plan.code, period_start: start.subscription.current_period_start, period_end: start.subscription.current_period_end, amount_cents: plan.price_cents });
      const balA = (await balOf(ws.id)).by_type.message.balance;
      const nextRenew = await grantPeriodCredits(svc, { workspace_id: ws.id, plan_code: plan.code, period_key: iso(Date.now() + 45 * 86400000), period_start: iso(Date.now() + 30 * 86400000) });
      const balB = (await balOf(ws.id)).by_type.message.balance;
      const integA = await verifyBalanceIntegrity(svc, ws.id);
      check("P-8.9 one grant per plan-period: checkout + the first invoice.paid dedupe, a later period grants once",
        start.credits_applied === 200 && checkoutAgain.duplicate === true && checkoutAgain.credits_applied === 0 &&
        invoiceFirst.duplicate === true && invoiceFirst.credits_applied === 0 &&
        balA === 200 && nextRenew.credits_applied === 200 && balB === 400 && integA.ok,
        `start ${start.credits_applied}, checkout dup ${checkoutAgain.duplicate}/${checkoutAgain.credits_applied}, invoice dup ${invoiceFirst.duplicate}/${invoiceFirst.credits_applied}, balA ${balA}, renewed ${nextRenew.credits_applied}, balB ${balB}, integ ${integA.ok}${integA.reason ? ` (${integA.reason})` : ""}`);

      const concWs = await mkws("concurrent");
      const raceOut = await Promise.all([0, 1, 2].map(() => processBillingEvent(svc, {
        workspace_id: concWs.id, provider: "manual", provider_event_id: `evt_race_${stamp}`,
        event_type: "subscription_started", plan_code: plan.code, amount_cents: plan.price_cents,
      })));
      const raceRows = await svc.entities.BillingEvent.filter({ workspace_id: concWs.id, idempotency_key: `manual:evt_race_${stamp}` }, "created_date", 10);
      check("P-8.9 concurrent duplicate deliveries settle to exactly ONE processed event row and ONE credit movement",
        raceRows.filter((e) => e.status === "processed").length === 1 &&
        raceRows.filter((e) => e.status === "ignored").length === raceRows.length - 1 &&
        raceOut.filter((r) => !r.duplicate).length === 1 &&
        (await balOf(concWs.id)).by_type.message.balance === 200 && (await verifyBalanceIntegrity(svc, concWs.id)).ok,
        `${raceRows.length} rows, dups ${raceOut.filter((r) => r.duplicate).length}, message ${(await balOf(concWs.id)).by_type.message.balance}`);
      // R-1: a failed post-insert duplicate re-read must abort before any credit, processed stamp or payment trigger.
      const failWs = await mkws("reread-fail");
      let beFilters = 0;
      const writes = [];
      const failing = { ...svc, entities: new Proxy(svc.entities, { get: (t, name) => new Proxy(t[name], { get: (e, m) => {
        if (name === "BillingEvent" && m === "filter") return async (...a) => { if (writes.includes("BillingEvent.create") && ++beFilters === 1) throw new Error("simulated re-read failure"); return e.filter(...a); };
        if (["create", "update", "bulkCreate"].includes(m)) return async (...a) => { writes.push(`${String(name)}.${String(m)}`); return e[m](...a); };
        return typeof e[m] === "function" ? e[m].bind(e) : e[m];
      } }) }) };
      let threw = null;
      try {
        await processBillingEvent(failing, { workspace_id: failWs.id, provider: "manual", provider_event_id: `evt_rfail_${stamp}`,
          event_type: "subscription_started", plan_code: plan.code, amount_cents: plan.price_cents });
      } catch (e) { threw = String(e?.message || e); }
      const failRows = await svc.entities.BillingEvent.filter({ workspace_id: failWs.id }, "created_date", 10);
      const failLedger = await svc.entities.CreditLedgerEntry.filter({ workspace_id: failWs.id, billing_event_id: failRows[0]?.id || "none" }, "created_date", 10);
      check("R-1 a failed duplicate re-read aborts: error thrown, no processed event, no credit, no payment trigger",
        /simulated re-read failure/.test(threw || "") && failRows.length === 1 && failRows[0].status === "received" &&
        !failLedger.length && JSON.stringify(writes) === JSON.stringify(["BillingEvent.create"]),
        `threw ${threw}, rows ${failRows.map((r) => r.status)}, ledger ${failLedger.length}, writes ${JSON.stringify(writes)}`);
    }
    {
      const priced = await makeBillingPlan(svc, created, "priced", { tier_rank: 5, price_cents: 3000, included_credits: 300, included_integration_credits: 3000, visibility: "public", provider: "stripe", provider_price_id: `price_p810_${stamp}` }, stamp);
      const intent = mapStripeEvent({ id: `evt_upd_${stamp}`, type: "customer.subscription.updated", data: { object: { items: { data: [{ price: { id: `price_p810_${stamp}` } }] } } } });
      const resolved = await planByProviderPrice(svc, "stripe", intent.provider_price_id);
      const unknown = await planByProviderPrice(svc, "stripe", `price_unknown_${stamp}`);
      const plain2 = await makeBillingPlan(svc, created, "plain2", { tier_rank: 2, included_credits: 50, included_integration_credits: 500, visibility: "public" }, stamp);
      const ws = await mkws("priced");
      await startSubscription(svc, { workspace_id: ws.id, plan_code: plain2.code, provider: "stripe", trial: false });
      const applied = await processBillingEvent(svc, { workspace_id: ws.id, provider: "stripe", provider_event_id: `evt_upd2_${stamp}`, event_type: "subscription_updated", plan_code: (resolved || {}).code, provider_subscription_id: `sub_${stamp}` });
      check("P-8.10 a portal-style price change resolves its plan from the price mirror, an unknown price stays fail-closed, and the resolved plan applies without any credit movement",
        intent.provider_price_id === `price_p810_${stamp}` && intent.plan_code === null && resolved?.code === priced.code &&
        unknown === null && applied.credits_applied === 0 && (await subscriptionFor(svc, ws.id)).plan_code === priced.code,
        `price ${intent.provider_price_id}, resolved ${resolved?.code}, unknown ${unknown}, plan ${(await subscriptionFor(svc, ws.id)).plan_code}`);
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