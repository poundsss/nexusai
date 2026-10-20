import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Coins, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Low-credit banner shown when balance falls below a threshold. Used in the Builder
// and on the Billing page. The balance is the authoritative ledger-derived number
// from the commerce backend — never a client-side guess.
export default function LowCreditBanner({ balance, spendable, threshold = 200 }) {
  const low = typeof balance === "number" && balance < threshold;
  const exhausted = typeof balance === "number" && balance <= 0;

  if (exhausted) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-destructive">No credits remaining</p>
          <p className="text-[12px] text-muted-foreground">AI operations are blocked. Purchase credits to continue building.</p>
        </div>
        <Button size="sm" asChild><Link to="/billing">Add credits</Link></Button>
      </div>
    );
  }

  if (low) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
        <Coins className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-amber-700 dark:text-amber-400">Low on credits</p>
          <p className="text-[12px] text-muted-foreground">
            {balance.toLocaleString()} credits remaining{typeof spendable === "number" && spendable < balance ? ` · ${spendable.toLocaleString()} spendable` : ""}.
          </p>
        </div>
        <Button size="sm" variant="outline" asChild><Link to="/billing">Add credits</Link></Button>
      </div>
    );
  }

  return null;
}