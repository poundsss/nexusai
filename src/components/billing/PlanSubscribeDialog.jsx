import React, { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, X } from "lucide-react";

const fmtCents = (cents, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format((cents || 0) / 100);

const fmtShort = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`);

const MONTHLY_EXCLUSIONS = ["Special discount and savings", "Free domain for 1 year", "25 credits to share with a friend"];

/**
 * Plan subscription dialog: pick a billing period (yearly / monthly) for a chosen plan,
 * review what the selected period includes, then confirm. onConfirm receives the plan
 * code for the chosen interval (plus the named credit option, when the plan has one).
 */
export default function PlanSubscribeDialog({ plan, yearlyPlan, defaultOptionCode = null, confirmLabel = "Confirm subscription", busy = false, onCancel, onConfirm }) {
  const [interval, setInterval] = useState("monthly");
  const [optionCode, setOptionCode] = useState(null);

  useEffect(() => {
    setInterval("monthly");
    setOptionCode(defaultOptionCode || (plan?.credit_options?.length ? plan.credit_options[0].code : null));
  }, [plan?.code, defaultOptionCode]);

  if (!plan) return null;

  const selected = interval === "yearly" && yearlyPlan ? yearlyPlan : plan;
  const option = selected.credit_options?.find((o) => o.code === optionCode) || null;
  const msgCredits = option ? option.message_credits : selected.included_credits || 0;
  const intCredits = option ? option.integration_credits : selected.included_integration_credits || 0;
  const saveCents = yearlyPlan ? plan.price_cents * 12 - yearlyPlan.price_cents : 0;

  const rows = [];
  if (yearlyPlan) rows.push({ key: "yearly", row: yearlyPlan });
  rows.push({ key: "monthly", row: plan });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Choose your billing period</DialogTitle>
          <DialogDescription>{plan.name} plan — pick how often you want to be billed. You can switch later.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          {rows.map(({ key, row }) => {
            const active = interval === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setInterval(key)}
                className={`w-full rounded-xl border p-3.5 text-left transition-colors ${active ? "border-foreground/30 bg-background shadow-sm" : "border-border bg-background hover:bg-muted/50"}`}
              >
                <div className="flex items-center gap-2.5">
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${active ? "border-foreground bg-foreground" : "border-muted-foreground/40"}`}>
                    {active && <span className="h-1.5 w-1.5 rounded-full bg-background" />}
                  </span>
                  <span className="text-[13.5px] font-medium capitalize">{key}</span>
                  <span className="text-muted-foreground/40">—</span>
                  <span className="text-[13.5px] text-muted-foreground">
                    {key === "yearly" ? `${fmtCents(yearlyPlan.price_cents / 12)} x 12 months` : `${fmtCents(plan.price_cents)} / every month`}
                  </span>
                  {key === "yearly" && saveCents > 0 && (
                    <span className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">SAVE {fmtCents(saveCents)}</span>
                  )}
                  <span className="ml-auto text-muted-foreground">
                    {active ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </span>
                </div>

                {active && (
                  <div className="mt-3.5 border-t border-border pt-3.5">
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-md border border-border bg-muted/60 px-2 py-1 text-[12px] text-muted-foreground">{fmtShort(msgCredits)} Message credits</span>
                      <span className="rounded-md border border-border bg-muted/60 px-2 py-1 text-[12px] text-muted-foreground">{fmtShort(intCredits)} Integration credits</span>
                    </div>

                    {selected.credit_options?.length > 0 && (
                      <select
                        value={optionCode || ""}
                        onChange={(e) => setOptionCode(e.target.value)}
                        className="mt-3 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground"
                      >
                        {selected.credit_options.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.message_credits.toLocaleString()} Message + {o.integration_credits.toLocaleString()} Integration credits
                          </option>
                        ))}
                      </select>
                    )}

                    {key === "monthly" && (
                      <>
                        <div className="mt-3.5 border-t border-border pt-3.5 text-[12.5px] font-medium text-foreground">
                          Monthly subscription doesn't include:
                        </div>
                        <ul className="mt-2 space-y-1.5">
                          {MONTHLY_EXCLUSIONS.map((t) => (
                            <li key={t} className="flex items-center gap-2 text-[12px] text-muted-foreground">
                              <X className="h-3.5 w-3.5 text-red-500" />{t}
                            </li>
                          ))}
                        </ul>
                        {yearlyPlan && (
                          <p className="mt-3 text-[12px] text-muted-foreground">
                            Choose a{" "}
                            <span role="button" tabIndex={0} className="underline underline-offset-2 text-foreground cursor-pointer" onClick={() => setInterval("yearly")}>
                              yearly
                            </span>{" "}
                            subscription to get the most from your premium plan
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-5 flex justify-end">
          <Button disabled={busy} onClick={() => onConfirm(selected.code, option ? option.code : null)}>
            {busy ? "…" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}