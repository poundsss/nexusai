import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Gift, Copy, Check } from "lucide-react";
import { toast } from "@/components/ui/use-toast";

// Referral card. The caller's referral code is issued SERVER-SIDE at workspace bootstrap and
// only shared here: the link exposes the code, copying it never names a referrer. Signing up
// through the link attributes the new account once and grants it 30 bonus credits (this
// slice has no referrer reward yet).
const APP_URL = window.location.origin;

export default function ReferralCard({ collapsed, referralCode }) {
  const [copied, setCopied] = useState(false);
  const link = referralCode ? `${APP_URL}/register?ref=${referralCode}` : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Your browser blocked clipboard access." });
    }
  };

  if (collapsed) {
    return (
      <Link to="/billing" title="Get bonus credits" className="flex justify-center rounded-lg p-1.5 hover:bg-sidebar-accent transition-colors">
        <Gift className="h-4 w-4 text-brand" />
      </Link>
    );
  }
  return (
    <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Gift className="h-3.5 w-3.5 shrink-0 text-brand" />
        <span className="text-[12px] font-medium text-sidebar-foreground">Invite a friend</span>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-sidebar-foreground/50">They get 30 bonus credits when they sign up.</p>
      {link ? (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
            aria-label="Your referral link"
            className="min-w-0 flex-1 rounded-md border border-sidebar-border bg-sidebar px-1.5 py-1 font-mono text-[10px] text-sidebar-foreground/70 outline-none"
          />
          <button
            type="button"
            onClick={copy}
            title="Copy referral link"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-sidebar-border text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      ) : (
        <Link to="/billing" className="mt-1 block text-[11px] text-brand hover:underline">Get bonus credits</Link>
      )}
    </div>
  );
}