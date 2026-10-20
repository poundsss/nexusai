import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";

// REAL campaign actions from the certified googleAds surface: Pause / Resume (campaign_pause /
// campaign_resume) and an inline daily-budget edit (campaign_update, integer micros server-side).
// Delete and bulk budgets stay in the builder; launch stays in the agent chat (approval-gated).
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function GrowAdsCampaignActions({ projectId, channel, campaign, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [budget, setBudget] = useState(campaign.daily_budget_micros != null ? String(Number(campaign.daily_budget_micros) / 1e6) : "");
  const [error, setError] = useState(null);
  const paused = campaign.status === "PAUSED";

  const act = (action, extra = {}) => async () => {
    setBusy(true); setError(null);
    try {
      await base44.functions.invoke("googleAds", { action, project_id: projectId, channel, campaign_id: campaign.id, ...extra });
      setEditing(false);
      onChanged?.();
    } catch (e) { setError(errOf(e)); }
    finally { setBusy(false); }
  };

  const saveBudget = () => {
    const usd = Number(budget);
    if (!Number.isFinite(usd) || usd <= 0) { setError("Enter a positive budget in USD"); return; }
    act("campaign_update", { daily_budget_micros: Math.round(usd * 1e6) })();
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {editing ? (
        <>
          <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="USD / day"
            className="w-24 rounded-md border border-border bg-background px-2 py-1 text-[11.5px] outline-none focus:border-foreground/30" />
          <button type="button" disabled={busy} onClick={saveBudget} className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-50">Save</button>
          <button type="button" onClick={() => { setEditing(false); setError(null); }} className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">Cancel</button>
        </>
      ) : (
        <>
          <button type="button" disabled={busy} onClick={act(paused ? "campaign_resume" : "campaign_pause")}
            className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : paused ? "Resume" : "Pause"}
          </button>
          <button type="button" onClick={() => setEditing(true)} className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent">Budget</button>
        </>
      )}
      {error && <span className="text-[10.5px] text-destructive">{error}</span>}
    </div>
  );
}