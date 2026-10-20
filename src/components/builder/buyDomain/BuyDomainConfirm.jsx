import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

const fmtMoney = (m) => (m ? new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency || "USD" }).format(m.value / 100) : null);

export default function BuyDomainConfirm({ offer, working, error, onAutoRenew, onBuy, onBack }) {
  const [autoRenew, setAutoRenew] = useState(offer.auto_renew !== false);

  // A changed auto-renew preference re-quotes server-side; follow the refreshed offer.
  useEffect(() => { setAutoRenew(offer.auto_renew !== false); }, [offer]);

  return (
    <div>
      <p className="break-all font-mono text-[15px] font-medium">{offer.domain}</p>

      <div className="mt-3 space-y-1.5 rounded-md border border-border px-3 py-2.5 text-[12px]">
        <p className="flex justify-between"><span className="text-muted-foreground">Period</span><span>{offer.period} year{offer.period > 1 ? "s" : ""}</span></p>
        <p className="flex justify-between"><span className="text-muted-foreground">Price</span><span className="font-medium">{fmtMoney(offer.price) || "—"}</span></p>
        {offer.renewal_price && (
          <p className="flex justify-between"><span className="text-muted-foreground">Renews at</span><span>{fmtMoney(offer.renewal_price)}/yr</span></p>
        )}
        <label className="flex cursor-pointer items-center justify-between pt-1">
          <span className="text-muted-foreground">Auto-renew</span>
          <input
            type="checkbox"
            checked={autoRenew}
            onChange={(e) => { setAutoRenew(e.target.checked); onAutoRenew(e.target.checked); }}
            disabled={working}
            className="h-4 w-4 accent-[hsl(var(--brand))]"
          />
        </label>
      </div>

      {offer.agreements?.length > 0 && (
        <div className="mt-3 text-[11px] text-muted-foreground">
          <p>By buying you accept:</p>
          <ul className="mt-1 space-y-0.5">
            {offer.agreements.map((a) => (
              <li key={a.agreement_type}>
                {a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">{a.title || a.agreement_type}</a> : (a.title || a.agreement_type)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onBack}
          disabled={working}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-[12px] font-medium hover:bg-accent transition-colors disabled:opacity-50"
        >
          Back
        </button>
        <button
          onClick={onBuy}
          disabled={working}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Buy domain
        </button>
      </div>
    </div>
  );
}