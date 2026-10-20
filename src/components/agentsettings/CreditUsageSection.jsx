import React from "react";
import { Link } from "react-router-dom";
import { Crown } from "lucide-react";
import { useShellData } from "@/hooks/useShellData";

// 1:1 Base44 Credit usage: the plan banner with Upgrade Plan, then one progress bar per credit
// pool — the same commerce billing_overview data the Billing page reads.
const Bar = ({ used, total }) => {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-orange-500" style={{ width: `${pct}%` }} />
    </div>
  );
};

export default function CreditUsageSection() {
  const { credits, plan } = useShellData();
  const included = credits.message.included ?? credits.monthlyLimit ?? null;
  const msgIncluded = credits.message.included ?? null;
  const intIncluded = credits.integration.included ?? null;
  const msgUsed = msgIncluded != null && credits.message.available != null ? Math.max(0, msgIncluded - credits.message.available) : null;
  const intUsed = intIncluded != null && credits.integration.available != null ? Math.max(0, intIncluded - credits.integration.available) : null;
  const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

  return (
    <div className="max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[12.5px] font-semibold">You're currently using the {plan?.name || "current"} plan</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">Monthly credits renew each billing cycle.</p>
        </div>
        <Link
          to="/billing"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-orange-500/60 bg-orange-500/5 px-3.5 text-[12.5px] font-medium text-orange-600 hover:bg-orange-500/10"
        >
          <Crown className="h-4 w-4" /> Upgrade Plan
        </Link>
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-[12.5px] font-semibold">Message credits</span>
          <span className="text-[12.5px] text-muted-foreground tabular-nums">{fmt(msgUsed)}/{msgIncluded != null ? fmt(msgIncluded) : "—"}</span>
        </div>
        <Bar used={msgUsed || 0} total={msgIncluded || 0} />
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between">
          <span className="text-[12.5px] font-semibold">Integration credits</span>
          <span className="text-[12.5px] text-muted-foreground tabular-nums">{fmt(intUsed)}/{intIncluded != null ? fmt(intIncluded) : "—"}</span>
        </div>
        <Bar used={intUsed || 0} total={intIncluded || 0} />
      </div>

      {included == null && (
        <p className="mt-4 text-[12.5px] text-muted-foreground">
          Credit pool balances come from billing — open <Link to="/billing" className="underline hover:text-foreground">Billing</Link> for the full breakdown.
        </p>
      )}
    </div>
  );
}