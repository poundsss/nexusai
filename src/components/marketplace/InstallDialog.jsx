import React, { useState } from "react";
import { Shield, Check, AlertTriangle, Loader2, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

const CAPABILITY_LABELS = {
  "entity:read": "Read your project data",
  "entity:write": "Create and modify your project data",
  "function:invoke": "Run backend functions",
  "network": "Make external network requests",
  "filesystem": "Access project files",
  "secrets": "Read secret values",
};

// Install consent dialog. Shows the capabilities the listing requests and the price
// (if any) before the user confirms. The backend re-checks consented_capabilities on
// install, so the client cannot silently grant more than the user approved.
export default function InstallDialog({ open, onOpenChange, listing, onConfirm, installing, error, balance }) {
  const [consented, setConsented] = useState([]);
  const capabilities = listing?.capabilities || [];
  const isPaid = listing?.pricing_model !== "free" && listing?.price_cents > 0;
  const insufficientCredits = isPaid && typeof balance === "number" && balance < (listing?.price_cents || 0);

  React.useEffect(() => {
    if (open) setConsented([]);
  }, [open]);

  const toggle = (cap) => setConsented((prev) => prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]);
  const allRequired = capabilities.every((c) => consented.includes(c));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install {listing?.name}</DialogTitle>
          <DialogDescription>
            Review the permissions and pricing before installing. You can uninstall anytime.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Capabilities / consent */}
          {capabilities.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[13px] font-medium mb-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                Permissions requested
              </div>
              <div className="space-y-1.5">
                {capabilities.map((cap) => (
                  <label key={cap} className="flex items-start gap-2.5 rounded-md border border-border p-2.5 cursor-pointer hover:bg-muted/50 transition-colors">
                    <input
                      type="checkbox"
                      checked={consented.includes(cap)}
                      onChange={() => toggle(cap)}
                      className="mt-0.5 h-4 w-4 rounded border-border"
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{CAPABILITY_LABELS[cap] || cap}</div>
                      <div className="text-[11px] text-muted-foreground font-mono">{cap}</div>
                    </div>
                  </label>
                ))}
              </div>
              {!allRequired && consented.length > 0 && (
                <p className="mt-1.5 text-[11px] text-amber-600">All permissions must be granted to install.</p>
              )}
            </div>
          )}

          {/* Pricing */}
          {isPaid && (
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">Price</span>
                <span className="text-lg font-bold">
                  {new Intl.NumberFormat("en-US", { style: "currency", currency: listing.currency || "USD" }).format(listing.price_cents / 100)}
                </span>
              </div>
              {insufficientCredits ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />Insufficient credits ({balance.toLocaleString()} available)
                </p>
              ) : (
                <p className="mt-1 text-[11px] text-muted-foreground">Credits will be deducted from your workspace balance.</p>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-[12px] text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /><span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={installing}>Cancel</Button>
          <Button
            onClick={onConfirm}
            disabled={installing || !allRequired || insufficientCredits}
          >
            {installing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
            {installing ? "Installing…" : isPaid ? "Purchase & install" : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}