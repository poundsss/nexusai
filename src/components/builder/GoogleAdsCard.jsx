import React, { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, Megaphone, Pencil } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import GoogleAdsLaunchDialog from "@/components/builder/GoogleAdsLaunchDialog";
import CampaignBudgetDialog from "@/components/builder/CampaignBudgetDialog";
import OpenAIAdsConnect from "@/components/builder/OpenAIAdsConnect";

// Google Ads (Marketing entry point) — the documented Base44 connection UX over the certified
// googleAds surface: Get started / New Campaign, the account card (existing account_get
// projection), the campaign list with the provider's review/serving status, and the irreversible
// "Cancel all" confirmation mapped to account_disconnect. Launch stays fail-closed until the
// external provider infrastructure exists — nothing here invents account state or payment UI.
const CADENCE = { every_3_days: "every 3 days", weekly: "weekly" };
const STATUS_STYLE = {
  ENABLED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  PAUSED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  PENDING: "bg-muted text-muted-foreground",
  REMOVED: "bg-muted text-muted-foreground",
};

const CampaignRow = ({ c, onEditBudget }) => (
  <div className="px-3 py-2">
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-medium">{c.campaign_name}</span>
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${STATUS_STYLE[c.status] || "bg-muted text-muted-foreground"}`}>{c.status}</span>
    </div>
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        ${(Number(c.daily_budget_micros || 0) / 1e6).toFixed(2)}/day
        {onEditBudget && c.status !== "REMOVED" && (
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => onEditBudget(c)}
            aria-label={`Edit budget for ${c.campaign_name}`}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </span>
      {!c.metrics_pending && <span>{c.impressions} impressions · {c.clicks} clicks</span>}
      {c.metrics_pending && <span>Metrics pending</span>}
      {(c.review_status || c.serving_status) && (
        <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-600 dark:text-amber-400">
          Needs attention — {c.review_status || c.serving_status}
        </span>
      )}
    </div>
  </div>
);

export default function GoogleAdsCard({ projectId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [providerConfigured, setProviderConfigured] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState(null);
  const [working, setWorking] = useState(false);
  const [pauseAllWorking, setPauseAllWorking] = useState(false);
  const [pauseAllResult, setPauseAllResult] = useState(null);
  const [budgetEdit, setBudgetEdit] = useState(null);

  const load = useCallback(async () => {
    try {
      const [acc, list] = await Promise.all([
        base44.functions.invoke("googleAds", { project_id: projectId, action: "account_get" }),
        base44.functions.invoke("googleAds", { project_id: projectId, action: "campaign_list" }),
      ]);
      setAccount(acc.data?.account ?? null);
      setCampaigns(list.data?.campaigns || []);
      setProviderConfigured(!!acc.data?.account?.provider_configured);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const cancelAll = async () => {
    setWorking(true); setCancelError(null);
    try {
      const res = await base44.functions.invoke("googleAds", { project_id: projectId, action: "account_disconnect" });
      if (res.data?.budget_end_confirmed) { setCancelOpen(false); await load(); }
      else setCancelError("The budget end was not confirmed — check the account state and try again.");
    } catch (e) {
      setCancelError(e.response?.data?.error || e.message);
    } finally {
      setWorking(false);
    }
  };

  // Documented Base44 pause-all: the spend kill switch. The response carries exactly
  // { status, paused_count, total_count, failed_count }; "partial" shows the documented
  // retry / pause-individually guidance. Rows refresh through the normal load() afterwards.
  const pauseAll = async () => {
    setPauseAllWorking(true); setPauseAllResult(null);
    try {
      const res = await base44.functions.invoke("googleAds", { project_id: projectId, action: "campaign_pause_all" });
      setPauseAllResult(res.data || {});
      await load();
    } catch (e) {
      setPauseAllResult({ error: e.response?.data?.error || e.message });
    } finally {
      setPauseAllWorking(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Megaphone className="h-3.5 w-3.5" />Google Ads
        </h3>
        {!loading && !error && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setWizardOpen(true)}>
            {account && account.status !== "disconnected" ? "New Campaign" : "Get started"}
          </Button>
        )}
      </div>

      {loading && <div className="p-3 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>}

      {!loading && error && (
        <div className="flex items-start gap-2 p-3 text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="text-[12px]">{error}</div>
        </div>
      )}

      {!loading && !error && (
        <div className="p-3 space-y-3 text-[12px]">
          {!account ? (
            <p className="text-muted-foreground">
              No ads account yet. Launching your first campaign creates an account tied specifically to this app — you do not need an existing Google Ads account, and you cannot connect one you already have.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2">
                <span className="text-muted-foreground">Status</span><span className="font-medium">{account.status}</span>
                <span className="text-muted-foreground">Billing currency</span><span className="font-medium">{account.currency_code || "—"}</span>
                <span className="text-muted-foreground">Charged</span><span className="font-medium">{CADENCE[account.billing_cadence] || "—"}</span>
                <span className="text-muted-foreground">Payment method on file</span><span className="font-medium">{account.payment_on_file ? "Yes" : "No"}</span>
                {account.spend_cap_micros != null && (
                  <>
                    <span className="text-muted-foreground">Monthly ceiling</span>
                    <span className="font-medium">${(Number(account.spend_cap_micros) / 1e6).toLocaleString()}</span>
                  </>
                )}
              </div>

              {campaigns.length > 0 && (
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Campaigns</p>
                  <div className="mt-1 divide-y divide-border rounded-md border border-border">
                    {campaigns.map((c) => <CampaignRow key={c.id} c={c} onEditBudget={setBudgetEdit} />)}
                  </div>
                </div>
              )}

              {pauseAllResult && !pauseAllResult.error && pauseAllResult.total_count === 0 && (
                <p className="text-[11px] text-muted-foreground">No campaigns to pause.</p>
              )}
              {pauseAllResult && !pauseAllResult.error && pauseAllResult.total_count > 0 && pauseAllResult.status === "paused" && (
                <p className="text-[11px] text-emerald-600 dark:text-emerald-400">All {pauseAllResult.paused_count} campaigns paused.</p>
              )}
              {pauseAllResult && !pauseAllResult.error && pauseAllResult.status === "partial" && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  {pauseAllResult.paused_count} of {pauseAllResult.total_count} campaigns paused — {pauseAllResult.failed_count} could not be paused. Retry Pause all, or pause the remaining campaigns individually.
                </p>
              )}
              {pauseAllResult?.error && <p className="text-[11px] text-destructive">{pauseAllResult.error}</p>}

              <div className="flex items-center justify-between gap-2">
                <span className="text-[10.5px] text-muted-foreground/60">
                  {providerConfigured ? "Connected to Google Ads." : "Google Ads infrastructure is not connected yet — launches fail closed."}
                </span>
                {account.status !== "disconnected" && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                      disabled={pauseAllWorking || campaigns.every((c) => c.status === "REMOVED")}
                      onClick={pauseAll}
                    >
                      {pauseAllWorking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Pause all"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-destructive hover:text-destructive" onClick={() => setCancelOpen(true)}>
                      Cancel all
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          <OpenAIAdsConnect projectId={projectId} />
        </div>
      )}

      <CampaignBudgetDialog
        projectId={projectId}
        campaign={budgetEdit}
        open={!!budgetEdit}
        onOpenChange={(o) => { if (!o) setBudgetEdit(null); }}
        onUpdated={load}
      />

      <GoogleAdsLaunchDialog projectId={projectId} open={wizardOpen} onOpenChange={setWizardOpen} onLaunched={load} />

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel all Google Ads for this app?</AlertDialogTitle>
            <AlertDialogDescription>
              This ends the Google account budget and deactivates this app's ads account. Canceling cannot be undone, and you may still be charged for ad spend Google delivered before the budget finished ending — review your active campaigns and recent spend first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cancelError && <p className="text-[12px] text-destructive">{cancelError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Keep the account</AlertDialogCancel>
            <AlertDialogAction
              disabled={working}
              onClick={(e) => { e.preventDefault(); cancelAll(); }}
            >
              {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "End budget and deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}