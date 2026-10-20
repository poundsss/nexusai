import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Starts Zernio's documented Meta Ads connect flow; Zernio returns the member to this Grow dashboard.
export default function ZernioMetaConnectButton({ projectId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const start = async () => {
    setBusy(true); setError(null);
    const redirect_url = `${window.location.origin}/growth-agent?dashboard=1&project=${encodeURIComponent(projectId)}&zernio_connected=meta`;
    try {
      const { data } = await base44.functions.invoke("googleAds", { action: "account_connect_url", project_id: projectId, channel: "zernio:meta", redirect_url });
      window.location.href = data.auth_url;
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not start the connection");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <ol className="list-decimal space-y-0.5 pl-4 text-[12.5px] text-muted-foreground">
        <li>Sign in with Facebook and allow ads access.</li>
        <li>Pick the Facebook Page your ads run as (Instagram needs a professional account linked to that Page).</li>
        <li>You'll come back here — then link the new account.</li>
      </ol>
      {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
      <button type="button" disabled={busy} onClick={start} className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[12px] text-background disabled:opacity-50">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Connect Meta Ads in Zernio
      </button>
    </div>
  );
}