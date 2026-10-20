import React, { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import OpenAIAdsConnectDialog from "@/components/builder/OpenAIAdsConnectDialog";

// The OpenAI Ads section on the existing Ads card — the ONLY UI affordance for the certified
// `account_connect` path, and ONLY on the zernio:openai channel: every call carries
// channel: "zernio:openai" explicitly, so the Google section above (which sends no channel,
// its certified behavior) and every other channel are untouched. Connected accounts render the
// certified account_get projection (status + account name); disconnect and reconnect run the
// CERTIFIED account_disconnect path for the same channel. Nothing here invents state — the
// fail-closed surface answers for everything.
export default function OpenAIAdsConnect({ projectId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [account, setAccount] = useState(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    try {
      const acc = await base44.functions.invoke("googleAds", {
        project_id: projectId, action: "account_get", channel: "zernio:openai",
      });
      setAccount(acc.data?.account ?? null);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const disconnect = async () => {
    setWorking(true); setDisconnectError(null);
    try {
      const res = await base44.functions.invoke("googleAds", {
        project_id: projectId, action: "account_disconnect", channel: "zernio:openai",
      });
      if (res.data?.account?.status === "disconnected") { setDisconnectOpen(false); await load(); }
      else setDisconnectError("The disconnect did not complete — check the account state and try again.");
    } catch (e) {
      setDisconnectError(e.response?.data?.error || e.message);
    } finally {
      setWorking(false);
    }
  };

  const connected = account && account.status !== "disconnected";

  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">OpenAI Ads</p>
        {!loading && !error && (
          connected ? (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-destructive hover:text-destructive" onClick={() => setDisconnectOpen(true)}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setConnectOpen(true)}>
              {account ? "Connect again" : "Connect"}
            </Button>
          )
        )}
      </div>
      {loading && <div className="mt-1 text-muted-foreground/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /></div>}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
      {!loading && !error && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {connected
            ? `Connected — ${account.business_name || "OpenAI ad account"} (status: ${account.status}).`
            : account
              ? "The connection was ended. Connect again with your ChatGPT Ads Manager API key."
              : "Connect your ChatGPT Ads Manager account to run ads on OpenAI. Requires the Zernio Ads infrastructure."}
        </p>
      )}

      <OpenAIAdsConnectDialog projectId={projectId} open={connectOpen} onOpenChange={setConnectOpen} onConnected={load} />

      <AlertDialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect OpenAI Ads?</AlertDialogTitle>
            <AlertDialogDescription>
              This disconnects the app's OpenAI ad account on Zernio and stops serving. Campaigns stay listed for reporting; outstanding spend remains owed and is confirmed separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {disconnectError && <p className="text-[12px] text-destructive">{disconnectError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Keep the connection</AlertDialogCancel>
            <AlertDialogAction
              disabled={working}
              onClick={(e) => { e.preventDefault(); disconnect(); }}
            >
              {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}