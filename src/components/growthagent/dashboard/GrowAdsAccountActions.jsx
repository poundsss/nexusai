import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";

// REAL account management for one ads channel, wired to the certified googleAds surface:
// Disconnect (account_disconnect), Recheck (parent reload) and — for the one documented
// credential-connect path (zernio:openai) — Connect (account_connect). Channels without a
// documented connect path say so instead of offering a fake button.
const errOf = (e) => (e?.response?.data?.code ? `${e.response.data.code}${e.response.data.error ? `: ${e.response.data.error}` : ""}` : e?.message || "Request failed");

export default function GrowAdsAccountActions({ projectId, channel, account, onConfigure }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [profileId, setProfileId] = useState("");
  const isZernioOpenAI = channel === "zernio:openai";

  const run = async (fn, okMsg) => {
    setBusy(true); setError(null); setNotice(null);
    try { const res = await fn(); setNotice(res?.already_connected ? "Already connected — the connection was refreshed in place." : okMsg); }
    catch (e) { setError(errOf(e)); }
    finally { setBusy(false); }
  };

  const disconnect = () => run(
    () => base44.functions.invoke("googleAds", { action: "account_disconnect", project_id: projectId, channel }),
    "Account disconnected — persisted status and history are kept.",
  );
  const connect = () => run(
    () => base44.functions.invoke("googleAds", { action: "account_connect", project_id: projectId, channel, openai_api_key: apiKey, profile_id: profileId }),
    "Connected — the account identity is persisted.",
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {account && account.status !== "disconnected" ? (
        <button type="button" disabled={busy} onClick={disconnect}
          className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Disconnect account"}
        </button>
      ) : isZernioOpenAI ? (
        <button type="button" disabled={busy} onClick={() => setConnectOpen((v) => !v)}
          className="rounded-lg border border-border bg-card px-2.5 py-1 text-[11.5px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60">
          {connectOpen ? "Cancel connect" : "Connect account"}
        </button>
      ) : (
        <span className="text-[11px] text-muted-foreground">No documented connect path for this channel in this runtime.</span>
      )}
      {error && <span className="text-[11.5px] text-destructive">{error}</span>}
      {notice && <span className="text-[11.5px] text-emerald-700 dark:text-emerald-300">{notice}</span>}
      {connectOpen && (
        <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="ChatGPT Ads Manager key"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-foreground/30" />
          <input value={profileId} onChange={(e) => setProfileId(e.target.value)} placeholder="Profile ID"
            className="w-40 rounded-md border border-border bg-background px-2 py-1.5 text-[12px] outline-none focus:border-foreground/30" />
          <button type="button" disabled={busy || !apiKey.trim() || !profileId.trim()} onClick={connect}
            className="rounded-lg bg-primary px-2.5 py-1.5 text-[11.5px] font-semibold text-primary-foreground transition-opacity disabled:opacity-50">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
          </button>
          <p className="w-full text-[10.5px] text-muted-foreground">The key is sent to the provider once and never stored, logged or returned.</p>
        </div>
      )}
    </div>
  );
}