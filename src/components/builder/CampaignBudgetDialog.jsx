import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// Per-campaign budget edit over the CERTIFIED campaign_update contract: a positive integer
// daily budget in micros, validated here and re-validated server-side (INVALID_BUDGET).
// Budget only — the landing page stays immutable and no other campaign section is touched.
// The provider gate stays fail-closed: with no ads infrastructure the invoke refuses and the
// error surfaces inline, exactly like every other live operation on the card.
export default function CampaignBudgetDialog({ projectId, campaign, open, onOpenChange, onUpdated }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);
  const [bounds, setBounds] = useState(null);

  useEffect(() => {
    if (open) {
      setValue(String(Math.round(Number(campaign?.daily_budget_micros || 0))));
      setError(null);
      setBounds(null);
      // Presets/bounds come from the surface's budget_boundaries read — never hardcoded.
      base44.functions.invoke("googleAds", {
        project_id: projectId, action: "budget_boundaries",
        campaign_type: campaign?.campaign_type || "PERFORMANCE_MAX",
      }).then((res) => setBounds(res.data || {})).catch(() => {});
    }
  }, [open, campaign, projectId]);

  const micros = Number(value);

  const save = async () => {
    if (!Number.isInteger(micros) || micros <= 0) {
      setError("Enter a positive whole number of micros (1,000,000 micros = $1).");
      return;
    }
    setWorking(true); setError(null);
    try {
      await base44.functions.invoke("googleAds", {
        project_id: projectId, action: "campaign_update",
        campaign_id: campaign.id, daily_budget_micros: micros,
      });
      onOpenChange(false);
      if (onUpdated) onUpdated();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!working) onOpenChange(o); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit daily budget</DialogTitle>
          <DialogDescription>
            {campaign?.campaign_name} — currently ${(Number(campaign?.daily_budget_micros || 0) / 1e6).toFixed(2)} per day.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="ads-budget-micros">Daily budget (micros)</Label>
          <Input
            id="ads-budget-micros" type="number" min="1" step="1" value={value}
            onChange={(e) => setValue(e.target.value)} disabled={working}
            onKeyDown={(e) => { if (e.key === "Enter" && !working) save(); }}
          />
          {bounds && (
            <div className="flex items-center gap-1.5">
              {(bounds.preset_daily_budget_micros || []).map((m) => (
                <Button key={m} size="sm" variant={Number(value) === Number(m) ? "default" : "outline"} className="h-6 px-2 text-[11px]" disabled={working} onClick={() => setValue(String(Number(m)))}>
                  ${(Number(m) / 1e6).toFixed(2)}
                </Button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            A positive whole number of micros — 1,000,000 micros = $1. A daily average, not a hard limit.
          </p>
          {bounds && (
            <p className="text-[11px] text-muted-foreground">
              Google accepts ${(Number(bounds.min_daily_budget_micros) / 1e6).toFixed(2)}–${(Number(bounds.max_daily_budget_micros) / 1e6).toLocaleString()} per day.
            </p>
          )}
        </div>
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" disabled={working} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" disabled={working} onClick={save}>
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}