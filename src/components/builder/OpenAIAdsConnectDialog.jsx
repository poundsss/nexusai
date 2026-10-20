import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

// The OpenAI Ads connect dialog over the CERTIFIED `account_connect` path (channel
// zernio:openai). It collects the member's ChatGPT Ads Manager API key and the Zernio
// profileId — the documented { apiKey, profileId } body. The key lives ONLY in this dialog's
// state: it is sent once to the certified surface and cleared on success/close — never stored,
// logged or echoed by this app. Errors surface inline, exactly like every other live
// operation on the card (the backend stays fail-closed, so a missing infrastructure shows
// PROVIDER_NOT_CONFIGURED here rather than a fake success).
export default function OpenAIAdsConnectDialog({ projectId, open, onOpenChange, onConnected }) {
  const [apiKey, setApiKey] = useState("");
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (open) { setApiKey(""); setProfileId(""); setError(null); }
  }, [open]);

  const connect = async () => {
    setWorking(true); setError(null);
    try {
      const res = await base44.functions.invoke("googleAds", {
        project_id: projectId, action: "account_connect", channel: "zernio:openai",
        openai_api_key: apiKey, profile_id: profileId,
      });
      if (res.data?.account) {
        setApiKey(""); setProfileId("");
        onOpenChange(false);
        if (onConnected) onConnected();
      } else {
        setError("The connection did not complete — check the account state and try again.");
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setWorking(false);
    }
  };

  const ready = apiKey.trim().length > 0 && profileId.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!working) onOpenChange(o); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Connect OpenAI Ads</DialogTitle>
          <DialogDescription>
            Paste your ChatGPT Ads Manager API key and the Zernio profile id. The key is validated against OpenAI and kept by Zernio only — it is never stored by this app.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="openai-ads-key">ChatGPT Ads Manager API key</Label>
          <Input
            id="openai-ads-key" type="password" autoComplete="off" value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} disabled={working}
          />
          <Label htmlFor="openai-ads-profile">Zernio profile id</Label>
          <Input
            id="openai-ads-profile" value={profileId}
            onChange={(e) => setProfileId(e.target.value)} disabled={working}
          />
        </div>
        {error && <p className="text-[12px] text-destructive">{error}</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" disabled={working} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" disabled={working || !ready} onClick={connect}>
            {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}