import React, { useEffect, useState, useCallback } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import { planCreditLines, fmtCredits } from "@/lib/planCredits";
import { Check, Loader2 } from "lucide-react";
import PlanSubscribeDialog from "@/components/billing/PlanSubscribeDialog";

const fmtCents = (cents, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format((cents || 0) / 100);

// In-builder plans modal — surfaces the SAME commerce billing the /billing page uses
// (plans + billing_overview, subscribe / change_plan), so the Upgrade button stays in the
// Builder instead of navigating away. No new billing surface: this reuses commerce verbatim.
export default function PlansModal({ open, onClose }) {
  const { workspace } = useWorkspace();
  const [data, setData] = useState(null);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);
  const [billingInterval, setBillingInterval] = useState("monthly");
  const [optionByPlan, setOptionByPlan] = useState({});
  const [dialogPlan, setDialogPlan] = useState(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      const [overview, plansRes] = await Promise.all([
        base44.functions.invoke("commerce", { action: "billing_overview", workspace_id: workspace.id }),
        base44.functions.invoke("commerce", { action: "plans", workspace_id: workspace.id }),
      ]);
      setData(overview.data);
      setPlans(plansRes.data.plans || []);
    } catch (e) {
      toast({ title: "Could not load plans", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const callBilling = async (action, payload, successMsg) => {
    setBusy(action);
    try {
      await base44.functions.invoke("commerce", { action, workspace_id: workspace.id, ...payload });
      if (successMsg) toast(successMsg);
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: e.response?.data?.error || e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const sub = data?.subscription || null;
  const entitlements = data?.entitlements || {};
  const currentPlanCode = entitlements.plan_code || sub?.plan_code || "free";
  const subStatus = entitlements.status || sub?.status || "active";
  const isOwner = data?.role === "owner" || data?.role === "admin";
  const canManage = isOwner;

  const subscribe = (planCode, trial, optionCode) => callBilling("subscribe", { plan_code: planCode, trial: trial ?? null, ...(optionCode ? { credit_option_code: optionCode } : {}) }, { title: "Subscription started" });
  const changePlan = (planCode, optionCode) => callBilling("change_plan", { plan_code: planCode, ...(optionCode ? { credit_option_code: optionCode } : {}) }, { title: "Plan change scheduled" });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[920px] max-h-[88vh] overflow-y-auto">
        <DialogTitle className="text-[15px] font-semibold mb-1">Plans</DialogTitle>

        {loading ? (
          <div className="py-16 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading plans…
          </div>
        ) : (
          <>
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

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
                    <p className="mt-1.5 text-[12px] text-muted-foreground min-h-[2.5em]">{p.description}</p>
                    <ul className="mt-3 space-y-1.5 text-[12px] text-muted-foreground flex-1">
                      {planCreditLines(p).map((line) => (
                        <li key={line} className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />{line}</li>
                      ))}
                      <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />{p.limits?.projects != null ? `${p.limits.projects} projects` : "Unlimited projects"}</li>
                      {p.entitlements?.ai_model_selection && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />AI model selection</li>}
                      {p.entitlements?.github_integration && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />GitHub integration</li>}
                      {p.entitlements?.premium_support && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />Premium support</li>}
                      {p.entitlements?.sso && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />SSO & SCIM</li>}
                      {p.trial_days > 0 && <li className="flex items-center gap-1.5"><Check className="h-3 w-3 text-muted-foreground" />{p.trial_days}-day trial</li>}
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
                        <Button className="mt-4 w-full" size="sm" variant="outline" disabled>Current plan</Button>
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
                  </div>
                );
              })}
            </div>
          </>
        )}
      </DialogContent>

      {dialogPlan && (
        <PlanSubscribeDialog
          open={!!dialogPlan}
          plan={dialogPlan}
          onClose={() => setDialogPlan(null)}
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
    </Dialog>
  );
}