// P-9.5: billing/catalog parity with the CURRENT official Base44 pricing evidence (verified
// 2026-09-25 against the live pricing page):
//   • monthly prices: Free $0, Starter $20, Builder $50, Pro $100, Elite $200
//   • yearly: the same tiers at monthly × 12 × 0.8 — $192/$480/$960/$1,920 annual totals —
//     with the same included credits per cycle
//   • documented entitlements per tier (in-app code edits everywhere; AI model select /
//     GitHub integration / early beta / 25 referral credits / free-domain flag from Builder
//     up; premium support on Elite; Free: core features, up to 5 apps, published app URL)
//   • paid plans carry no per-plan project cap (documented: unlimited apps)
//   • the Elite selectable credit ladder: all 6 server-owned options grant exactly their
//     named amounts through the EXISTING P-8.8 contracts — checkout/initial grant, renewal,
//     scheduled change — while a forged option code is refused up front and a forged stored
//     amount falls back to the plan defaults at grant time, never to a client value. The
//     message and integration pools stay completely separate throughout.
// The catalog IS the source: publicPlans and commerce project these same rows, so pinning
// them here pins every price surface. Nothing in this suite re-prices anything.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, captureCall } from "../../shared/testHarness.ts";
import { seedPlans, DEFAULT_PLANS } from "../../shared/billing.ts";
import { startSubscription, changePlan, applyScheduledChanges, subscriptionFor } from "../../shared/subscriptions.ts";
import { deriveBalance } from "../../shared/ledger.ts";
import { makeBillingWorkspace } from "../../shared/billingTestFixtures.ts";

// Official evidence, as [tier, monthly_cents, message_credits, integration_credits].
const PAID_TIERS = [
  ["starter", 2000, 100, 2000],
  ["builder", 5000, 250, 10000],
  ["pro", 10000, 500, 20000],
  ["scale", 20000, 1200, 50000],
];
const PAID_CODES = ["starter_monthly", "builder_monthly", "pro_monthly", "scale_monthly", "starter_yearly", "builder_yearly", "pro_yearly", "scale_yearly"];
// The server-owned Elite ladder (P-8.8 contract, expanded in P-9.5). A caller only ever NAMES
// a code; these amounts are resolved from the plan row itself, never from client input.
const ELITE_LADDER = [
  { code: "elite_base", message_credits: 1200, integration_credits: 50000 },
  { code: "elite_x2", message_credits: 2400, integration_credits: 100000 },
  { code: "elite_x4", message_credits: 4800, integration_credits: 200000 },
  { code: "elite_5400", message_credits: 5400, integration_credits: 200000 },
  { code: "elite_6800", message_credits: 6800, integration_credits: 250000 },
  { code: "elite_8200", message_credits: 8200, integration_credits: 300000 },
];

// Subset equality on every field DEFAULT_PLANS defines: a persisted row may carry additional
// platform-internal keys, but every defined price, credit, limit and entitlement must match
// the platform-owned definition exactly.
const matches = (row, plan) => Object.entries(plan).every(([k, v]) => {
  if (Array.isArray(v)) return JSON.stringify(row[k] || []) === JSON.stringify(v);
  if (v && typeof v === "object") return Object.entries(v).every(([sk, sv]) => row[k]?.[sk] === sv);
  return row[k] === v;
});

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const h = createHarness();
  const check = h.check;
  const stamp = Date.now();
  const created = { workspaces: [], plans: [] };
  const past = (ms) => new Date(Date.now() - ms).toISOString();
  const balOf = (wsId) => deriveBalance(svc, wsId);
  const mkws = async (label) => (await makeBillingWorkspace(svc, created, `${label}${stamp}`, { plan: null, subscription: false }, stamp)).ws;

  try {
    await seedPlans(svc);
    const rows = await svc.entities.BillingPlan.list("-tier_rank", 200);
    const rowOf = (code) => rows.find((p) => p.code === code) || null;

    // ---- 1–3: monthly prices, yearly totals, the 20% annual discount -----------------
    for (const [tier, monthly, msg, intg] of PAID_TIERS) {
      const m = rowOf(`${tier}_monthly`);
      const y = rowOf(`${tier}_yearly`);
      check(`${tier}: monthly price is exactly the published $${monthly / 100}`,
        m?.interval === "monthly" && m?.price_cents === monthly,
        `price_cents=${m?.price_cents} interval=${m?.interval}`);
      check(`${tier}: yearly price is the annual total monthly × 12 × 0.8 ($${(monthly * 12 * 0.8) / 100})`,
        y?.interval === "yearly" && y?.price_cents === monthly * 12 * 0.8,
        `price_cents=${y?.price_cents} expected=${monthly * 12 * 0.8}`);
      for (const p of [m, y]) {
        check(`${p?.code}: includes the published ${msg}/${intg} message/integration credits`,
          p?.included_credits === msg && p?.included_integration_credits === intg,
          `included=${p?.included_credits}/${p?.included_integration_credits}`);
      }
    }
    const free = rowOf("free");
    check("Free: $0 with the published 25 message / 100 integration credits, 5 apps, 5/day and 25/month message caps",
      free?.price_cents === 0 && free?.included_credits === 25 && free?.included_integration_credits === 100 &&
      free?.limits?.projects === 5 && free?.usage_limits?.daily_credits === 5 && free?.usage_limits?.monthly_credits === 25,
      `price=${free?.price_cents} included=${free?.included_credits}/${free?.included_integration_credits} limits=${JSON.stringify(free?.limits)} usage=${JSON.stringify(free?.usage_limits)}`);

    // ---- 4: persisted catalog = DEFAULT_PLANS (the rows publicPlans/commerce project) -
    for (const plan of DEFAULT_PLANS) {
      const row = rowOf(plan.code);
      check(`catalog row "${plan.code}" matches DEFAULT_PLANS on every defined field`,
        !!row && matches(row, plan), row ? "" : "row missing");
    }
    check("paid plans carry no per-plan project cap (documented: unlimited apps)",
      PAID_CODES.every((c) => { const r = rowOf(c); return r && r.limits?.projects == null && r.entitlements?.projects == null; }),
      `offenders: ${PAID_CODES.filter((c) => { const r = rowOf(c); return !r || r.limits?.projects != null || r.entitlements?.projects != null; }).join(",")}`);

    // ---- 5: documented entitlements per tier ----------------------------------------
    const E = (code) => rowOf(code)?.entitlements || {};
    check("Free entitlements: core features, in-app code edits, free published app URL, 5 apps",
      E("free").core_features === true && E("free").in_app_code_edits === true && E("free").published_app_url === true && E("free").projects === 5,
      JSON.stringify(E("free")));
    check("Starter entitlements: in-app code edits + custom domain; no AI model select (per evidence)",
      E("starter_monthly").in_app_code_edits === true && E("starter_monthly").custom_domains === 1 && E("starter_monthly").ai_model_selection == null && E("starter_yearly").in_app_code_edits === true,
      JSON.stringify(E("starter_monthly")));
    const builderSet = (code) => ["in_app_code_edits", "ai_model_selection", "github_integration", "early_beta_access", "free_domain_1yr"].every((f) => E(code)[f] === true) && E(code).referral_credits === 25;
    check("Builder entitlements: model select, GitHub, early beta, 25 referral credits, free-domain flag",
      builderSet("builder_monthly") && builderSet("builder_yearly"), JSON.stringify(E("builder_monthly")));
    check("Pro entitlements: the same documented set as Builder",
      builderSet("pro_monthly") && builderSet("pro_yearly"), JSON.stringify(E("pro_monthly")));
    check("Elite entitlements: the Builder set plus premium support",
      builderSet("scale_monthly") && builderSet("scale_yearly") && E("scale_monthly").premium_support === true, JSON.stringify(E("scale_monthly")));

    // ---- 6: the Elite credit ladder is exactly the 6 server-owned options ------------
    check("Elite credit_options are exactly the 6 selectable combinations on both intervals",
      JSON.stringify(rowOf("scale_monthly")?.credit_options || []) === JSON.stringify(ELITE_LADDER) && JSON.stringify(rowOf("scale_yearly")?.credit_options || []) === JSON.stringify(ELITE_LADDER),
      JSON.stringify(rowOf("scale_monthly")?.credit_options || []));

    // ---- 7: Elite options behavior through the REAL lifecycle contracts -------------
    // 7a. checkout → initial grant, for every option: exactly the named amounts, both pools
    //     isolated, and the selection persisted on the subscription.
    for (const opt of ELITE_LADDER) {
      const ws = await mkws(`p95e${opt.code}`);
      const res = await startSubscription(svc, { workspace_id: ws.id, plan_code: "scale_monthly", provider: "manual", credit_option_code: opt.code });
      const bal = await balOf(ws.id);
      const sub = await subscriptionFor(svc, ws.id);
      check(`Elite ${opt.code} (${opt.message_credits}/${opt.integration_credits}): checkout grants exactly the named amounts, pools isolated`,
        res.credits_applied === opt.message_credits && res.event?.integration_credits === opt.integration_credits &&
        bal.by_type.message.balance === opt.message_credits && bal.by_type.integration.balance === opt.integration_credits &&
        sub?.selected_credit_option?.code === opt.code,
        JSON.stringify({ applied: res.credits_applied, applied_intg: res.event?.integration_credits, msg: bal.by_type.message.balance, intg: bal.by_type.integration.balance, selected: sub?.selected_credit_option || null }));
    }

    // 7b. renewal grants exactly the selected option again (8,200/300,000).
    {
      const ws = await mkws("p95renew");
      await startSubscription(svc, { workspace_id: ws.id, plan_code: "scale_monthly", provider: "manual", credit_option_code: "elite_8200" });
      const sub = await subscriptionFor(svc, ws.id);
      await svc.entities.Subscription.update(sub.id, { current_period_start: past(40 * 86400000), current_period_end: past(10 * 86400000) });
      const r = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const bal = await balOf(ws.id);
      check("Elite renewal grants exactly the selected option again (8,200/300,000 per cycle)",
        r.changed && r.action === "renewed" && bal.by_type.message.balance === 8200 * 2 && bal.by_type.integration.balance === 300000 * 2,
        { action: r.action, msg: bal.by_type.message.balance, intg: bal.by_type.integration.balance });
    }

    // 7c. scheduled plan change revalidates the named option against the TARGET plan.
    {
      const ws = await mkws("p95sched");
      await startSubscription(svc, { workspace_id: ws.id, plan_code: "builder_monthly", provider: "manual" });
      await changePlan(svc, { workspace_id: ws.id, plan_code: "scale_monthly", credit_option_code: "elite_6800" });
      const sub = await subscriptionFor(svc, ws.id);
      check("scheduled change records the named Elite option without granting early",
        sub.scheduled_plan_code === "scale_monthly" && sub.selected_credit_option?.code === "elite_6800",
        JSON.stringify({ scheduled: sub.scheduled_plan_code, selected: sub.selected_credit_option }));
      await svc.entities.Subscription.update(sub.id, { scheduled_change_at: past(1000), current_period_end: past(1000) });
      const applied = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const bal = await balOf(ws.id);
      check("the boundary grants the Elite plan with exactly the selected option (6,800/250,000)",
        applied.changed && bal.by_type.message.balance === 250 + 6800 && bal.by_type.integration.balance === 10000 + 250000,
        { action: applied.action, msg: bal.by_type.message.balance, intg: bal.by_type.integration.balance });
    }

    // 7d. a forged option CODE is refused before anything moves.
    {
      const ws = await mkws("p95forged");
      const forged = await captureCall(() => startSubscription(svc, { workspace_id: ws.id, plan_code: "scale_monthly", provider: "manual", credit_option_code: "elite_forged" }));
      const bal = await balOf(ws.id);
      check("a forged option code is refused (UNKNOWN_CREDIT_OPTION) and grants nothing",
        forged.threw && forged.code === "UNKNOWN_CREDIT_OPTION" && bal.by_type.message.balance === 0 && bal.by_type.integration.balance === 0,
        { threw: forged.threw, code: forged.code, msg: bal.by_type.message.balance, intg: bal.by_type.integration.balance });
    }

    // 7e. forged STORED amounts fall back to the plan defaults at renewal — never the forgery.
    {
      const ws = await mkws("p95tamper");
      await startSubscription(svc, { workspace_id: ws.id, plan_code: "scale_monthly", provider: "manual", credit_option_code: "elite_base" });
      const sub = await subscriptionFor(svc, ws.id);
      await svc.entities.Subscription.update(sub.id, {
        selected_credit_option: { code: "elite_base", message_credits: 999999, integration_credits: 999999 },
        current_period_start: past(40 * 86400000), current_period_end: past(10 * 86400000),
      });
      const r = await applyScheduledChanges(svc, { workspace_id: ws.id });
      const bal = await balOf(ws.id);
      check("a tampered stored amount falls back to the Elite defaults (1,200/50,000), never the forgery",
        r.changed && bal.by_type.message.balance === 1200 * 2 && bal.by_type.integration.balance === 50000 * 2,
        { action: r.action, msg: bal.by_type.message.balance, intg: bal.by_type.integration.balance });
    }

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const wsId of created.workspaces) await cleanupWorkspace(svc, wsId, ["CreditLedgerEntry", "Subscription"]);
  }
}