// P-8.3 — Free Plan Credits Parity regression.
//
// The Base44 Free contract: 5 message credits per UTC day and 25 per monthly credit cycle,
// enforced through the EXISTING plan usage gate (checkBudget → planUsageState → planUsageViolations)
// and the real reservation lifecycle (beginOperation/settleUsage). Expiration and cycle derivation
// are P-8.1/P-8.2 machinery and are only exercised here, never modified. Paid plans, prices, model
// economics and payment providers are untouched — the test asserts that too.
//
// Every scenario runs in a throwaway workspace and cleans up after itself.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { seedPlans, processBillingEvent, getPlan } from "../../shared/billing.ts";
import { beginOperation, settleUsage } from "../../shared/aiOperations.ts";
import { recordEvent, deriveBalance, verifyBalanceIntegrity } from "../../shared/ledger.ts";
import { checkBudget } from "../../shared/budget.ts";
import { planUsageState } from "../../shared/planLimits.ts";

const MODEL_ID = "gemini-3-flash";
const MODEL = { model_id: MODEL_ID, id: MODEL_ID, provider: "base44-core", upstream_provider: "google", name: "gemini_3_flash" };
// Tiny worst case: the reservation and the settled charge both price at the policy minimum
// (1 credit), so every scenario's credit arithmetic is exact.
const TINY = { max_input_tokens: 200, max_output_tokens: 50 };
const TINY_USAGE = { input_tokens: 100, output_tokens: 20 };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const db = base44.asServiceRole;
  const results = [];
  const created = { workspaces: [], operations: [] };
  const t = (name, ok, detail) => { results.push({ test: name, ok: !!ok, detail }); return ok; };

  // The same UTC clocks the plan gate uses (dayStartUtc / monthStart in planLimits.ts).
  const dayStart = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); };
  const monthStart = () => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)); };
  const nowIso = () => new Date().toISOString();
  const uniq = () => `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  const newWorkspace = async (label, credits = 60, expiresAt = null) => {
    const ws = await db.entities.Workspace.create({ name: `free-parity ${label} ${Date.now()}`, owner_id: "free_plan_parity_test", status: "active" });
    created.workspaces.push(ws.id);
    if (credits > 0) {
      await recordEvent(db, {
        workspace_id: ws.id, event_type: "promotional", amount: credits,
        idempotency_key: `test-grant:${ws.id}`, reason: "Test credit grant",
        ...(expiresAt ? { metadata: { expires_at: expiresAt } } : {}),
      });
    }
    return ws;
  };
  const track = (op) => { if (op?.id) created.operations.push(op.id); return op; };

  // A settled operation, the exact shape the plan gate derives both windows from. finalized_at
  // drives the daily/monthly windows, so a backdated row simulates an earlier day/cycle.
  const seedChargedOp = async (ws, { charged = 1, finalizedAt = null, i }) => {
    const at = finalizedAt || nowIso();
    return track(await db.entities.AIOperation.create({
      workspace_id: ws.id, operation_type: "ai_run", credit_type: "message", model_id: MODEL_ID,
      provider: "google", status: "completed", usage_source: "estimated", pricing_version: "test",
      currency: "USD", credits_charged: charged, credits_reserved: 0,
      idempotency_key: `seed:${ws.id}:${i}:${uniq()}`, finalized_at: at, started_at: at,
    }));
  };

  // A REAL operation through the production gate: begin (budget check + hold) → settle (charge
  // + release). Both price at 1 credit for the tiny estimate/usage above.
  const realOp = async (ws, key) => {
    const { operation } = await beginOperation(db, {
      workspace_id: ws.id, run_id: key, operation_type: "ai_run", model_id: MODEL_ID,
      idempotency_key: `run:${key}`, estimate: TINY,
    });
    track(operation);
    const held = await deriveBalance(db, ws.id);
    const settled = await settleUsage(db, {
      workspace_id: ws.id, run_id: key, operation_type: "ai_run", model: MODEL,
      usage: TINY_USAGE, idempotency_key: `run:${key}`, status: "completed",
    });
    return { operation, held, settled };
  };

  const refusal = async (fn) => {
    try { await fn(); return { thrown: false }; }
    catch (e) {
      const violations = e?.detail?.violations || [];
      return { thrown: true, code: e.code || null, codes: [e?.detail?.code, ...violations.map((v) => v.code)].filter(Boolean) };
    }
  };
  const planState = (ws) => planUsageState(db, { workspace_id: ws.id, credit_type: "message" });
  const budget = (ws, credits = 1) => checkBudget(db, { workspace_id: ws.id, credits }, "message");

  try {
    // --- 0. Plan catalog parity ------------------------------------------------
    await seedPlans(db);
    {
      const free = await getPlan(db, "free");
      t("0. free plan: 5 daily / 25 monthly message credits",
        free?.usage_limits?.daily_credits === 5 && free?.usage_limits?.monthly_credits === 25,
        { usage_limits: free?.usage_limits });
      t("0. free plan: grant, integration pool and price unchanged",
        free?.included_credits === 25 && free?.included_integration_credits === 100 && free?.price_cents === 0,
        { included_credits: free?.included_credits, included_integration_credits: free?.included_integration_credits, price_cents: free?.price_cents });
      const paidCodes = ["starter_monthly", "builder_monthly", "pro_monthly", "scale_monthly"];
      const paidRows = [];
      for (const code of paidCodes) paidRows.push(await getPlan(db, code));
      t("0. paid plans untouched: no daily ceiling, limits and prices unchanged",
        paidRows.every((p) => p && p.usage_limits?.daily_credits === undefined && p.price_cents > 0 && p.usage_limits?.monthly_credits !== 25),
        paidRows.map((p) => ({ code: p?.code, usage_limits: p?.usage_limits, price_cents: p?.price_cents })));
    }

    // --- 1. Daily window: 5 allowed, the 6th refused fail-closed -----------------
    const A = await newWorkspace("daily");
    await seedChargedOp(A, { charged: 2, i: 0 });          // 2 credits settled today
    await seedChargedOp(A, { charged: 2, i: 1 });          // 4 credits settled today
    const fifth = await realOp(A, `fifth_${uniq()}`);      // the 5th credit today
    const stateA = await planState(A);
    t("1. free can use 5 message credits in a UTC day",
      fifth.settled.credits_charged === 1 && stateA.daily.limit === 5 && stateA.daily.consumed === 5,
      { charged: fifth.settled.credits_charged, daily: stateA.daily });

    const sixth = await refusal(() => beginOperation(db, {
      workspace_id: A.id, run_id: "sixth", operation_type: "ai_run", model_id: MODEL_ID,
      idempotency_key: `run:sixth_${uniq()}`, estimate: TINY,
    }));
    const afterSixth = await deriveBalance(db, A.id);
    t("1. the 6th credit the same UTC day is refused fail-closed",
      sixth.thrown && sixth.codes.includes("PLAN_DAILY_CREDITS_EXCEEDED"),
      sixth.thrown ? sixth : "the 6th operation was NOT refused");
    t("1. refused operation strands no reservation",
      afterSixth.reserved === 0 && afterSixth.available === afterSixth.balance,
      { reserved: afterSixth.reserved, available: afterSixth.available, balance: afterSixth.balance });
    const integrityA = await verifyBalanceIntegrity(db, A.id);
    t("1. reservation/release and ledger integrity hold on the free plan",
      fifth.held.reserved === fifth.operation.credits_reserved && fifth.operation.credits_reserved > 0 && integrityA.ok,
      { held: fifth.held.reserved, integrity: integrityA });

    // --- 2. A new UTC day re-opens the daily window ------------------------------
    {
      const yesterday = new Date(dayStart().getTime() - 12 * 3600 * 1000).toISOString();
      const ops = await db.entities.AIOperation.filter({ workspace_id: A.id, status: "completed" }, "created_date", 100);
      for (const o of ops) await db.entities.AIOperation.update(o.id, { finalized_at: yesterday });
      const fresh = await realOp(A, `newday_${uniq()}`);
      const state = await planState(A);
      t("2. a new UTC day allows the daily limit again",
        fresh.settled.credits_charged === 1 && state.daily.consumed === 1,
        { daily: state.daily, monthly: state.monthly });
    }

    // --- 3. Monthly ceiling 25 binds even when the day has room -----------------
    {
      const C = await newWorkspace("monthly");
      const sameMonth = dayStart().getTime() > monthStart().getTime();
      const backAt = new Date(dayStart().getTime() - 24 * 3600 * 1000).toISOString();
      let n = 0;
      if (sameMonth) {
        // 21 credits on an earlier day of this cycle + 4 today = 25 monthly, daily headroom 1.
        await seedChargedOp(C, { charged: 10, finalizedAt: backAt, i: n++ });
        await seedChargedOp(C, { charged: 10, finalizedAt: backAt, i: n++ });
        await seedChargedOp(C, { charged: 1, finalizedAt: backAt, i: n++ });
        await seedChargedOp(C, { charged: 4, i: n++ });
      } else {
        // On the 1st of a month there is no earlier in-month day: everything lands today.
        await seedChargedOp(C, { charged: 24, i: n++ });
        await seedChargedOp(C, { charged: 1, i: n++ });
      }
      const state = await planState(C);
      const res = await budget(C, 1);
      const codes = res.violations.map((v) => v.code);
      t("3. monthly ceiling 25 blocks further use after 25 credits",
        state.monthly.consumed === 25 && res.ok === false && codes.includes("PLAN_MONTHLY_CREDITS_EXCEEDED"),
        { monthly: state.monthly, codes });
      if (sameMonth) {
        t("3. daily headroom cannot bypass the monthly ceiling",
          state.daily.consumed === 4 && !codes.includes("PLAN_DAILY_CREDITS_EXCEEDED"),
          { daily: state.daily, codes });
      } else {
        t("3. daily-headroom isolation skipped: run on the 1st of a month (monthly refusal proven above)", true, { note: "no earlier in-month day exists" });
      }
    }

    // --- 4. Expired credits never fund use ---------------------------------------
    {
      const B = await newWorkspace("expired", 10, new Date(Date.now() - 3600 * 1000).toISOString());
      const bal = await deriveBalance(db, B.id);
      const res = await budget(B, 1);
      t("4. expired credits are not counted as available",
        bal.available === 0 && res.violations.some((v) => v.code === "INSUFFICIENT_CREDITS"),
        { balance: bal.balance, available: bal.available, codes: res.violations.map((v) => v.code) });
    }

    // --- 5. Workspace isolation ---------------------------------------------------
    {
      const D = await newWorkspace("iso-a");
      const E = await newWorkspace("iso-b");
      await seedChargedOp(D, { charged: 5, i: 0 });       // D's day is exhausted
      const stD = await planState(D);
      const stE = await planState(E);
      const resD = await budget(D, 1);
      const resE = await budget(E, 1);
      t("5. workspace isolation: one workspace's exhausted day never reaches another",
        stD.daily.consumed === 5 && resD.ok === false &&
        stE.daily.consumed === 0 && stE.monthly.consumed === 0 && resE.ok === true,
        { D: stD.daily, E: stE.daily, okD: resD.ok, okE: resE.ok });
    }

    // --- 6. Paid plans unaffected ---------------------------------------------------
    {
      const F = await newWorkspace("paid", 0);
      await processBillingEvent(db, {
        workspace_id: F.id, event_type: "subscription_started", provider: "none",
        plan_code: "starter_monthly", amount_cents: 2000, period_key: "parity_test",
        period_start: nowIso(), period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        idempotency_key: `parity:${F.id}`,
      });
      await seedChargedOp(F, { charged: 5, i: 0 });       // would exhaust a free day
      const stF = await planState(F);
      const paid = await realOp(F, `paid_${uniq()}`);      // the 6th credit today passes
      t("6. paid plans: no daily ceiling, plan usage unaffected",
        stF.plan.code === "starter_monthly" && stF.daily.limit === null && paid.settled.credits_charged === 1,
        { plan: stF.plan.code, daily: stF.daily, charged: paid.settled.credits_charged });
    }

    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    return Response.json({ ok: passed === results.length, passed, total: results.length, failed, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, code: error.code || null, results }, { status: 500 });
  } finally {
    for (const opId of created.operations) await db.entities.AIOperation.delete(opId).catch(() => {});
    for (const wsId of created.workspaces) {
      const entries = await db.entities.CreditLedgerEntry.filter({ workspace_id: wsId }, "created_date", 200).catch(() => []);
      for (const e of entries) await db.entities.CreditLedgerEntry.delete(e.id).catch(() => {});
      const ops = await db.entities.AIOperation.filter({ workspace_id: wsId }, "created_date", 100).catch(() => []);
      for (const o of ops) await db.entities.AIOperation.delete(o.id).catch(() => {});
      const events = await db.entities.BillingEvent.filter({ workspace_id: wsId }, "created_date", 100).catch(() => []);
      for (const e of events) await db.entities.BillingEvent.delete(e.id).catch(() => {});
      const subs = await db.entities.Subscription.filter({ workspace_id: wsId }, "created_date", 10).catch(() => []);
      for (const s of subs) await db.entities.Subscription.delete(s.id).catch(() => {});
      await db.entities.Workspace.delete(wsId).catch(() => {});
    }
  }
}