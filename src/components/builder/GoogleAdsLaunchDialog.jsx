import React, { useEffect, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// The launch wizard — the documented 3-step flow collapsed to the minimum over the certified
// surface: campaign details, then the launch_readiness gate (blocker banner + payment
// verification state), then Approve and Launch. No provider/channel picker, no OAuth, no
// account selection: the launch creates the ONE account tied to this app. Every launch fails
// closed until the external provider infrastructure exists — the banner says so, and nothing
// is faked.
export const BLOCKER_TEXT = {
  PROVIDER_NOT_CONFIGURED: "Google Ads is not connected for this app yet — launching needs the external ads infrastructure, so nothing can go live.",
  APP_NOT_PUBLISHED: "Publish the app first — only published apps can be advertised.",
  APP_NOT_PUBLIC: "Set the app visibility to Public — private or workspace-only apps cannot be advertised.",
  ACTIVE_CAMPAIGN_LIMIT: "Two active campaigns is the limit — pause one before starting a third.",
  PAYMENT_ON_FILE_MISSING: "A payment method is required to complete setup.",
  ACCOUNT_NOT_ACTIVE: "The ads account is not active.",
  LANDING_PAGE_MISSING: "Choose the site page the ad will lead to.",
};

export default function GoogleAdsLaunchDialog({ projectId, open, onOpenChange, onLaunched }) {
  const [name, setName] = useState("");
  const [budget, setBudget] = useState(10);
  const [landing, setLanding] = useState("");
  const [step, setStep] = useState("details");
  const [readiness, setReadiness] = useState(null);
  const [gateLoading, setGateLoading] = useState(false);
  const [gateError, setGateError] = useState(null);
  const [launchError, setLaunchError] = useState(null);
  const [launching, setLaunching] = useState(false);
  const [bounds, setBounds] = useState(null);

  useEffect(() => {
    if (open) {
      setName(""); setBudget(10); setLanding("");
      setStep("details"); setReadiness(null); setGateError(null); setLaunchError(null);
      setBounds(null);
      // The budget step quotes the surface's budget_boundaries read (presets + bounds) —
      // never hardcoded numbers. A failed read leaves the free input usable without presets.
      base44.functions.invoke("googleAds", {
        project_id: projectId, action: "budget_boundaries", campaign_type: "PERFORMANCE_MAX",
      }).then((res) => {
        const b = res.data || {};
        setBounds(b);
        if (b.recommended_daily_budget_micros) setBudget(Number(b.recommended_daily_budget_micros) / 1e6);
      }).catch(() => {});
    }
  }, [open, projectId]);

  const runGate = async () => {
    setGateLoading(true); setGateError(null); setReadiness(null);
    try {
      const res = await base44.functions.invoke("googleAds", {
        project_id: projectId, action: "launch_readiness", landing_page: landing,
      });
      setReadiness(res.data);
      setStep("gate");
    } catch (e) {
      setGateError(e.response?.data?.error || e.message);
    } finally {
      setGateLoading(false);
    }
  };

  const launch = async () => {
    setLaunching(true); setLaunchError(null);
    try {
      await base44.functions.invoke("googleAds", {
        project_id: projectId, action: "launch", campaign_name: name,
        campaign_type: "PERFORMANCE_MAX", daily_budget_micros: Math.round(Number(budget) * 1e6),
        landing_page: landing, targeting: {},
      });
      onOpenChange(false);
      if (onLaunched) onLaunched();
    } catch (e) {
      const blockers = e.response?.data?.blockers;
      setLaunchError(e.response?.data?.error || e.message);
      if (blockers) setReadiness((r) => ({ ...(r || {}), blockers }));
    } finally {
      setLaunching(false);
    }
  };

  const blockers = readiness?.blockers || [];
  const paymentMissing = blockers.includes("PAYMENT_ON_FILE_MISSING");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>
            Every campaign here is a Google Performance Max campaign — you set the budget, assets and targeting; Google decides where the ads run.
          </DialogDescription>
        </DialogHeader>

        {step === "details" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ads-campaign-name">Campaign name</Label>
              <Input id="ads-campaign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring promotion" />
              <p className="text-[11px] text-muted-foreground">Only you see the campaign name.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ads-campaign-budget">Daily budget</Label>
              <div className="flex items-center gap-1.5">
                {(bounds?.preset_daily_budget_micros || []).map((m) => {
                  const p = Number(m) / 1e6;
                  return (
                    <Button key={m} size="sm" variant={Number(budget) === p ? "default" : "outline"} className="h-7 px-2 text-[11px]" onClick={() => setBudget(p)}>
                      ${p % 1 === 0 ? p : p.toFixed(2)}
                    </Button>
                  );
                })}
                <Input
                  id="ads-campaign-budget" type="number" min="1" step="0.01" value={budget}
                  onChange={(e) => setBudget(e.target.value)} className="h-7 w-24 text-[12px]"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">A daily average, not a hard limit — Google can spend up to twice this on a busy day.</p>
              {bounds && (
                <p className="text-[11px] text-muted-foreground">
                  Google accepts ${(Number(bounds.min_daily_budget_micros) / 1e6).toFixed(2)}–${(Number(bounds.max_daily_budget_micros) / 1e6).toLocaleString()} per day.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ads-campaign-landing">Site page the ad leads to</Label>
              <Input id="ads-campaign-landing" value={landing} onChange={(e) => setLanding(e.target.value)} placeholder="Leave empty for the main page" />
              <p className="text-[11px] text-muted-foreground">The domain cannot change after the campaign is created.</p>
            </div>
            {gateError && (
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="text-[12px]">{gateError}</div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {gateLoading && (
              <div className="flex items-center gap-2 p-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />Checking launch readiness…
              </div>
            )}
            {!gateLoading && readiness && (
              <>
                {blockers.length > 0 && (
                  <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                    {blockers.map((b) => (
                      <div key={b} className="flex items-start gap-2 text-[12px] text-amber-700 dark:text-amber-400">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{BLOCKER_TEXT[b] || b}</span>
                      </div>
                    ))}
                  </div>
                )}
                {paymentMissing && !blockers.includes("PROVIDER_NOT_CONFIGURED") && (
                  <div className="rounded-md border border-border p-3 text-[12px]">
                    <p className="font-medium">Validate payment and continue</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Add a payment method before launch — it is verified through the ads provider during setup.
                    </p>
                  </div>
                )}
                {readiness.ready && (
                  <div className="rounded-md border border-border bg-muted/30 p-3 text-[12px]">
                    <p className="font-medium">Ready to launch</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      ${Number(budget).toFixed(2)} daily average · {landing ? landing : "the main page"} · performance max
                    </p>
                  </div>
                )}
              </>
            )}
            {launchError && (
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="text-[12px]">{launchError}</div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === "details" ? (
            <>
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button size="sm" disabled={!name.trim() || gateLoading} onClick={runGate}>
                {gateLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Continue"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={gateLoading || launching} onClick={() => setStep("details")}>Back</Button>
              <Button size="sm" disabled={!readiness?.ready || gateLoading || launching} onClick={launch}>
                {launching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Approve and Launch"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}