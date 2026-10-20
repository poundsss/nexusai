import React, { useState } from "react";
import { Coins, Loader2, Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { base44 } from "@/api/base44Client";

const fmtCents = (cents, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format((cents || 0) / 100);

// Credit purchase flow. Shows one_time plans (credit packages) from the real billing
// backend and processes purchases through the authoritative commerce function — the
// ledger is the only thing that moves credits, so the client never touches the balance.
export default function CreditPurchase({ plans, workspaceId, onPurchased }) {
  const [busy, setBusy] = useState(null);
  // One-time plans are credit packages; subscription plans are handled in the Plans section.
  const packages = plans.filter((p) => p.interval === "one_time" && p.visibility === "public" && p.included_credits > 0);

  if (packages.length === 0) return null;

  const buy = async (pkg) => {
    setBusy(pkg.code);
    try {
      // If a payment provider is configured, create a checkout session; otherwise the
      // purchase is settled as a manual billing event (still authoritative, still audited).
      const res = await base44.functions.invoke("commerce", {
        action: "checkout",
        workspace_id: workspaceId,
        plan_code: pkg.code,
        success_url: window.location.href,
        cancel_url: window.location.href,
      });
      if (res.data?.checkout?.url) {
        window.location.href = res.data.checkout.url;
      } else if (res.data?.checkout?.requires_manual_settlement) {
        // No live provider — settle as a manual purchase through the ledger.
        const settled = await base44.functions.invoke("commerce", {
          action: "settle_manual_purchase",
          workspace_id: workspaceId,
          plan_code: pkg.code,
          amount_cents: pkg.price_cents,
          credits: pkg.included_credits,
          idempotency_key: `purchase:${workspaceId}:${pkg.code}:${Date.now()}`,
        });
        toast({ title: "Credits added", description: `${pkg.included_credits.toLocaleString()} Message credits added to your balance.` });
        onPurchased?.();
      }
    } catch (e) {
      toast({ variant: "destructive", title: "Purchase failed", description: e.response?.data?.error || e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h2 className="text-sm font-semibold text-foreground">Buy credits</h2>
      <p className="mt-0.5 text-[13px] text-muted-foreground">Purchase credits anytime — top-up credits are added to your balance immediately and never carry over; unused top-up credits expire at your next credit reset.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {packages.map((pkg) => {
          const featured = pkg.included_credits >= Math.max(...packages.map((p) => p.included_credits));
          return (
            <div key={pkg.code} className={`relative rounded-lg border p-4 flex flex-col ${featured ? "border-primary ring-1 ring-primary" : "border-border"}`}>
              {featured && (
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-primary text-primary-foreground text-[9px] font-semibold uppercase px-2 py-0.5">Best value</span>
              )}
              <div className="flex items-center gap-2">
                <Coins className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium text-[13px]">{pkg.name}</span>
              </div>
              <div className="mt-2 flex items-baseline gap-1">
                <span className="text-2xl font-bold">{fmtCents(pkg.price_cents, pkg.currency)}</span>
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                <span className="font-semibold text-foreground">{pkg.included_credits.toLocaleString()}</span> Message credits
                {pkg.price_cents > 0 && (
                  <span className="text-muted-foreground/60"> · {Math.round(pkg.included_credits / (pkg.price_cents / 100))} / $1</span>
                )}
              </div>
              {pkg.description && <p className="mt-1.5 text-[11px] text-muted-foreground line-clamp-2 flex-1">{pkg.description}</p>}
              <Button
                className="mt-3 w-full"
                size="sm"
                variant={featured ? "default" : "outline"}
                disabled={busy === pkg.code}
                onClick={() => buy(pkg)}
              >
                {busy === pkg.code ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                {busy === pkg.code ? "Processing…" : "Purchase"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}