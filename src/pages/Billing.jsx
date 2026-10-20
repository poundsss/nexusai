import React, { useEffect, useState, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import AccountPage from "@/components/shell/AccountPage";
import Section from "@/components/shell/Section";
import DataList from "@/components/shell/DataList";
import MetricRow from "@/components/shell/MetricRow";
import PlanSubscribeDialog from "@/components/billing/PlanSubscribeDialog";
import CreditPurchase from "@/components/billing/CreditPurchase";
import CreditHistory from "@/components/billing/CreditHistory";
import LowCreditBanner from "@/components/billing/LowCreditBanner";
import { planCreditLines, poolBalance, fmtCredits } from "@/lib/planCredits";
import { CreditCard, Coins, Receipt, AlertCircle, ExternalLink, RotateCcw, Play, Calendar, Check } from "lucide-react";

const fmtCents = (cents, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format((cents || 0) / 100);

const STATUS_TONE = {
  active: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20",
  trialing: "bg-brand-muted text-brand ring-brand/20",
  past_due: "bg-amber-500/10 text-amber-600 ring-amber-500/20",
  cancelled: "bg-rose-500/10 text-rose-600 ring-rose-500/20",
  expired: "bg-muted text-muted-foreground ring-border",
  incomplete: "bg-amber-500/10 text-amber-600 ring-amber-500/20",
};

const EVENT_TONE = {
  processed: "text-emerald-600",
  received: "text-amber-600",
  rejected: "text-destructive",
  ignored: "text-muted-foreground",
};

export default function Billing() {
  const { user, workspace, loading: wsLoading } = useWorkspace();
  const [data, setData] = useState(null);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [billingInterval, setBillingInterval] = useState("monthly");
  const [optionByPlan, setOptionByPlan] = useState({});
  const [dialogPlan, setDialogPlan] = useState(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      const [overview, plansRes] = await Promise.all([
        base44.functions.invoke("commerce", { action: "billing_overview", workspace_id: workspace.id }),
        base44.functions.invoke("commerce", { action: "plans", workspace_id: workspace.id }),
      ]);
      setData(overview.data);
      setPlans(plansRes.data.plans || []);
    } catch (e) {
      setError(e.message || "Failed to load billing overview");
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => { load(); }, [load]);

  const callBilling = async (action, payload, successMsg) => {
    setBusy(action);
    try {
      const res = await base44.functions.invoke("commerce", { action, workspace_id: workspace.id, ...payload });
      if (successMsg) toast(successMsg);
      await load();
      return res.data;
    } catch (e) {
      toast({ title: "Action failed", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const subscribe = (planCode, trial, optionCode) => callBilling("subscribe", { plan_code: planCode, trial: trial ?? null, ...(optionCode ? { credit_option_code: optionCode } : {}) }, { title: "Subscription started" });
  const changePlan = (planCode, optionCode) => callBilling("change_plan", { plan_code: planCode, ...(optionCode ? { credit_option_code: optionCode } : {}) }, { title: "Plan change scheduled" });
  const cancel = () => callBilling("cancel_subscription", {}, { title: "Subscription cancelled", description: "Entitlements continue until period end." });
  const resume = () => callBilling("resume_subscription", {}, { title: "Subscription resumed" });
  const openPortal = async () => {
    setBusy("portal");
    try {
      const res = await base44.functions.invoke("commerce", { action: "billing_portal", workspace_id: workspace.id, return_url: window.location.href });
      if (res.data?.portal?.url) window.open(res.data.portal.url, "_blank");
    } catch (e) {
      toast({ title: "Could not open billing portal", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally { setBusy(null); }
  };

  const sub = data?.subscription || null;
  const entitlements = data?.entitlements || {};
  const balance = data?.balance || { balance: 0, reserved: 0, available: 0 };
  const msgPool = poolBalance(balance, "message");
  const intPool = poolBalance(balance, "integration");
  const customer = data?.customer || null;
  const currentPlanCode = entitlements.plan_code || sub?.plan_code || "free";
  const subStatus = entitlements.status || sub?.status || "active";
  const isOwner = data?.role === "owner" || data?.role === "admin";
  const canManage = isOwner;

  return (
    <AccountPage
      loading={wsLoading || loading}
      title="Billing"
      subtitle="Plans, credits, usage, and invoices."
      actions={canManage && customer && <Button variant="outline" size="sm" disabled={busy === "portal"} onClick={openPortal}><ExternalLink className="h-3.5 w-3.5 mr-1.5" />Billing portal</Button>}
    >
      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-[13px] text-destructive">
          <AlertCircle className="h-4 w-4" /><span>{error}</span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={load}>Retry</Button>
        </div>
      ) : (
        <div className="space-y-8">
          <LowCreditBanner balance={msgPool?.available} spendable={data?.spendable?.available} />

          <MetricRow
            items={[
              { label: "Message credits", value: fmtCredits(msgPool?.available), sub: `${fmtCredits(intPool?.available)} Integration credits available` },
              { label: "Plan", value: <span className="capitalize">{currentPlanCode}</span>, sub: <span className="capitalize">{subStatus}{sub?.cancel_at_period_end && subStatus === "active" ? " · cancels at period end" : ""}{sub?.scheduled_plan_code && sub.scheduled_plan_code !== currentPlanCode ? ` · → ${sub.scheduled_plan_code}` : ""}</span> },
              { label: "Period ends", value: sub?.current_period_end ? new Date(sub.current_period_end).toLocaleDateString() : "—", sub: sub?.trial_end && new Date(sub.trial_end) > new Date() ? `Trial ends ${new Date(sub.trial_end).toLocaleDateString()}` : sub?.cancel_at_period_end ? "Cancels at period end" : "Renews automatically" },
              { label: "Credits spent", value: (data?.usage?.total_credits ?? 0).toLocaleString(), sub: "this period" },
            ]}
          />

          {customer && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3.5">
              <div className="flex items-center gap-2 text-[13px]">
                <CreditCard className="h-4 w-4 text-muted-foreground" />
                {customer.card_brand && customer.card_last4 ? (
                  <span className="font-mono">{customer.card_brand} ···· {customer.card_last4}</span>
                ) : (
                  <span className="text-muted-foreground">No payment method on file</span>
                )}
              </div>
              {customer.payment_status === "failed" && (
                <span className="flex items-center gap-1 text-[12px] text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" /> Last payment failed{customer.last_failure_reason ? ` — ${customer.last_failure_reason}` : ""}
                </span>
              )}
            </div>
          )}

          <Section title="Plans" description="Self-serve public plans. Enterprise and custom plans are not self-subscribable. Plan changes take effect at the next billing cycle.">
            <div className="flex gap-1 p-1 mb-4 w-fit rounded-lg border border-border bg-muted/40">
              {[["monthly", "Monthly"], ["yearly", "Yearly"]].map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setBillingInterval(value)}
                  className={`px-3.5 py-1.5 rounded-md text-[12.5px] font-medium transition-colors ${billingInterval === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {label}
                  {value === "yearly" && <span className="ml-1.5 text-[10px] font-semibold text-emerald-600">Save 20%</span>}
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {plans.filter((p) => p.visibility === "public" && p.interval !== "one_time" && (p.price_cents === 0 || p.interval === billingInterval)).map((p) => {
                const current = currentPlanCode === p.code;
                const isUpgrade = (p.tier_rank || 0) > (plans.find((x) => x.code === currentPlanCode)?.tier_rank || 0);
                const isDowngrade = (p.tier_rank || 0) < (plans.find((x) => x.code === currentPlanCode)?.tier_rank || 0);
                const chosenOption = p.credit_options?.length ? optionByPlan[p.code] || p.credit_options[0].code : null;
                return (
                  <div key={p.code} className={`relative rounded-lg border p-4 flex flex-col ${current ? "border-foreground/40 bg-muted/40" : "border-border"}`}>
                    {current && <span className="absolute top-3 right-3 rounded-md bg-foreground px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-background">Current</span>}
                    <div className="font-semibold text-[14px]">{p.name}</div>
                    <div className="mt-1.5 flex items-baseline gap-1">
                      <span className="text-2xl font-bold">{p.price_cents === 0 ? "Free" : fmtCents(p.price_cents, p.currency)}</span>
                      {p.price_cents > 0 && <span className="text-sm text-muted-foreground">{p.interval === "yearly" ? "/year" : "/mo"}</span>}
                    </div>
                    {p.price_cents > 0 && p.interval === "yearly" && (
                      <div className="text-[11px] text-muted-foreground">billed annually</div>
                    )}
                    {p.price_cents > 0 && p.interval === "monthly" && (
                      <div className="text-[11px] text-muted-foreground">billed monthly</div>
                    )}
                    <p className="mt-1.5 text-[12px] text-muted-foreground min-h-[2.5em]">{p.description}</p>
                    <ul className="mt-3 space-y-1.5 text-[12px] text-muted-foreground flex-1">
                      {planCreditLines(p).map((line) => (
                        <li key={line} className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />{line}</li>
                      ))}
                      <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />{p.limits?.projects != null ? `${p.limits.projects} projects` : "Unlimited projects"} · {p.limits?.seats != null ? `${p.limits.seats} seats` : "unlimited members"}</li>
                      {p.entitlements?.in_app_code_edits && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />In-app code edits</li>}
                      {p.entitlements?.ai_model_selection && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />AI model selection</li>}
                      {p.entitlements?.github_integration && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />GitHub integration</li>}
                      {p.entitlements?.early_beta_access && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />Early access to beta features</li>}
                      {p.entitlements?.referral_credits != null && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />{p.entitlements.referral_credits} credits to share with a friend</li>}
                      {p.entitlements?.free_domain_1yr && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />Free domain for 1 year</li>}
                      {p.entitlements?.premium_support && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />Premium support</li>}
                      {p.entitlements?.published_app_url && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />Free published app URL</li>}
                      {p.trial_days > 0 && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />{p.trial_days}-day trial</li>}
                      {p.entitlements?.sso && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />SSO & SCIM</li>}
                      {p.entitlements?.advanced_models && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />Advanced models</li>}
                    </ul>
                    {p.credit_options?.length && (
                      <select
                        value={chosenOption}
                        onChange={(e) => setOptionByPlan((s) => ({ ...s, [p.code]: e.target.value }))}
                        className="mt-3 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground"
                      >
                        {p.credit_options.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.message_credits.toLocaleString()} Message + {o.integration_credits.toLocaleString()} Integration credits
                          </option>
                        ))}
                      </select>
                    )}
                    {canManage ? (
                      current ? (
                        sub?.cancel_at_period_end ? (
                          <Button className="mt-4 w-full" size="sm" variant="outline" disabled={busy === "resume"} onClick={resume}>
                            <Play className="h-3.5 w-3.5 mr-1.5" />{busy === "resume" ? "…" : "Resume"}
                          </Button>
                        ) : p.credit_options?.length ? (
                          <Button className="mt-4 w-full" size="sm" variant="outline" disabled={busy === "change_plan"} onClick={() => changePlan(p.code, chosenOption)}>
                            {busy === "change_plan" ? "…" : "Update credit volume"}
                          </Button>
                        ) : (
                          <Button className="mt-4 w-full" size="sm" variant="outline" disabled>Current plan</Button>
                        )
                      ) : (
                        <Button
                          className="mt-4 w-full"
                          size="sm"
                          variant={isUpgrade ? "default" : "outline"}
                          disabled={busy === "subscribe" || busy === "change_plan"}
                          onClick={() => {
                            if (p.price_cents > 0) { setDialogPlan(p); return; }
                            if (!sub || subStatus === "expired" || subStatus === "cancelled") {
                              subscribe(p.code, p.trial_days > 0 && !sub, chosenOption);
                            } else {
                              changePlan(p.code, chosenOption);
                            }
                          }}
                        >
                          {busy === "subscribe" || busy === "change_plan" ? "…" :
                           !sub || subStatus === "expired" || subStatus === "cancelled" ? (p.trial_days > 0 ? "Start trial" : "Subscribe") :
                           isUpgrade ? "Upgrade" : isDowngrade ? "Downgrade" : "Switch billing"}
                        </Button>
                      )
                    ) : (
                      <Button className="mt-4 w-full" size="sm" variant="outline" disabled>Contact owner</Button>
                    )}
                    {!current && sub && !sub?.cancel_at_period_end && (isUpgrade || isDowngrade) && (
                      <p className="mt-1.5 text-[10px] text-muted-foreground text-center">Takes effect at the next billing cycle</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          {dialogPlan && (
            <PlanSubscribeDialog
              plan={dialogPlan}
              yearlyPlan={plans.find((x) => x.code === dialogPlan.code.replace(/_monthly$/, "_yearly")) || null}
              defaultOptionCode={optionByPlan[dialogPlan.code] || null}
              confirmLabel={
                !sub || subStatus === "expired" || subStatus === "cancelled"
                  ? dialogPlan.trial_days > 0 ? "Confirm trial" : "Confirm subscription"
                  : (dialogPlan.tier_rank || 0) > (plans.find((x) => x.code === currentPlanCode)?.tier_rank || 0) ? "Confirm subscription upgrade"
                  : (dialogPlan.tier_rank || 0) < (plans.find((x) => x.code === currentPlanCode)?.tier_rank || 0) ? "Confirm subscription downgrade"
                  : "Confirm billing switch"
              }
              busy={busy === "subscribe" || busy === "change_plan"}
              onCancel={() => setDialogPlan(null)}
              onConfirm={(code, opt) => {
                setDialogPlan(null);
                if (!sub || subStatus === "expired" || subStatus === "cancelled") {
                  subscribe(code, dialogPlan.trial_days > 0 && !sub, opt);
                } else {
                  changePlan(code, opt);
                }
              }}
            />
          )}

          {canManage && (
            <Section title="Buy credits" description="One-time top-up packages. Top-up credits are added to your balance immediately and never carry over — unused top-up credits expire at your next credit reset.">
              <CreditPurchase plans={plans} workspaceId={workspace.id} onPurchased={load} />
            </Section>
          )}

          <Section title="Credit history" description="Purchases, usage, refunds and adjustments.">
            <CreditHistory workspaceId={workspace?.id} />
          </Section>

          <Section title="Invoices" description="Payment history for this workspace.">
            <DataList
              empty="No invoices yet — they appear here after your first payment."
              rows={data?.invoices || []}
              columns={[
                { key: "number", label: "Number", mono: true, render: (inv) => inv.number || inv.id.slice(-8) },
                { key: "status", label: "Status", render: (inv) => <span className="capitalize text-muted-foreground">{inv.status}</span> },
                { key: "amount_cents", label: "Amount", align: "right", render: (inv) => fmtCents(inv.amount_cents, inv.currency) },
                { key: "credits_granted", label: "Message credits", align: "right", render: (inv) => inv.credits_granted || 0 },
                { key: "issued_at", label: "Issued", align: "right", render: (inv) => <span className="text-muted-foreground">{inv.issued_at ? new Date(inv.issued_at).toLocaleDateString() : "—"}</span> },
                ...(canManage ? [{
                  key: "hosted_invoice_url", label: "", align: "right",
                  render: (inv) => inv.hosted_invoice_url ? (
                    <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline">
                      View invoice<ExternalLink className="h-3 w-3" />
                    </a>
                  ) : <span className="text-muted-foreground">—</span>,
                }] : []),
              ]}
            />
          </Section>

          {data?.events?.length > 0 && (
            <Section title="Billing events" description="Subscription and payment activity.">
              <DataList
                rows={data.events}
                columns={[
                  { key: "event_type", label: "Event", render: (e) => <span className="capitalize">{e.event_type?.replace(/[._]/g, " ")}</span> },
                  { key: "status", label: "Status", render: (e) => (
                    <span className={`text-[11.5px] font-medium ${EVENT_TONE[e.status] || "text-muted-foreground"}`}>{e.status}{e.reject_reason ? ` (${e.reject_reason})` : ""}</span>
                  ) },
                  { key: "credits", label: "Message", align: "right", render: (e) => e.credits || 0 },
                  { key: "integration_credits", label: "Integration", align: "right", render: (e) => e.integration_credits || 0 },
                  { key: "amount_cents", label: "Amount", align: "right", render: (e) => (e.amount_cents ? fmtCents(e.amount_cents) : "—") },
                  { key: "created_date", label: "Date", align: "right", render: (e) => <span className="text-muted-foreground">{new Date(e.created_date).toLocaleDateString()}</span> },
                ]}
              />
            </Section>
          )}

          {canManage && sub && subStatus === "active" && !sub.cancel_at_period_end && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3.5">
              <div>
                <div className="text-[13px] font-medium">Cancel subscription</div>
                <div className="text-[12px] text-muted-foreground">Entitlements continue until the end of the paid period. Already-purchased credits remain.</div>
              </div>
              <Button variant="outline" size="sm" disabled={busy === "cancel_subscription"} onClick={cancel}>
                {busy === "cancel_subscription" ? "…" : "Cancel"}
              </Button>
            </div>
          )}
        </div>
      )}
    </AccountPage>
  );
}