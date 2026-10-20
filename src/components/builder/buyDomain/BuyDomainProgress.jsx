import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

const POLL_MS = 3000;
const MAX_MS = 120000;

const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");

export default function BuyDomainProgress({ offer, working, onPoll, onRetryConnect, onSearchAgain, onDone }) {
  const [note, setNote] = useState(null);
  const startedAt = useRef(Date.now());

  // Registration is usually quick; poll every few seconds. If it exceeds the window it
  // keeps going server-side and can be resumed later from the domain list.
  useEffect(() => {
    if (offer.stage !== "registering") return undefined;
    startedAt.current = Date.now();
    setNote(null);
    const timer = setInterval(async () => {
      if (Date.now() - startedAt.current > MAX_MS) {
        clearInterval(timer);
        setNote("This is taking longer than usual. It will finish in the background — check the domain list in a few minutes.");
        return;
      }
      try { await onPoll(offer.registration_id); } catch { /* transient errors keep polling */ }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [offer.stage, offer.registration_id, onPoll]);

  if (offer.stage === "registering") {
    return (
      <div className="py-6 text-center">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-brand" />
        <p className="mt-3 text-[13px] font-medium">Registering {offer.domain}…</p>
        <p className="mt-1 text-[12px] text-muted-foreground">This usually takes a minute. Keep this open.</p>
        {note && <p className="mt-3 rounded-md bg-brand-muted px-3 py-2 text-[12px]">{note}</p>}
      </div>
    );
  }

  if (offer.stage === "failed") {
    return (
      <div className="py-4 text-center">
        <XCircle className="mx-auto h-6 w-6 text-destructive" />
        <p className="mt-2 text-[13px] font-medium">Purchase didn't go through</p>
        <p className="mt-1 text-[12px] text-muted-foreground">{offer.error}</p>
        <button
          onClick={onSearchAgain}
          className="mt-4 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Search again
        </button>
      </div>
    );
  }

  const connected = offer.connected === "active";
  return (
    <div className="py-3 text-center">
      {connected
        ? <CheckCircle2 className="mx-auto h-6 w-6 text-chart-2" />
        : <Loader2 className="mx-auto h-5 w-5 animate-spin text-brand" />}
      <p className="mt-2 break-all font-mono text-[14px] font-medium">{offer.domain}</p>
      {connected ? (
        <>
          <p className="mt-1 text-[12px] text-muted-foreground">Connected and serving</p>
          <div className="mt-3 space-y-1 rounded-md border border-border px-3 py-2 text-left text-[12px]">
            <p className="flex justify-between"><span className="text-muted-foreground">Expires</span><span>{fmtDate(offer.expires_at)}</span></p>
            <p className="flex justify-between"><span className="text-muted-foreground">Auto-renew</span><span>{offer.auto_renew ? "On" : "Off"}</span></p>
          </div>
          <button
            onClick={onDone}
            className="mt-4 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Done
          </button>
        </>
      ) : (
        <>
          <p className="mt-1 text-[12px] text-muted-foreground">Registered. Connecting it to your app…</p>
          {offer.error && <p className="mt-1 text-[12px] text-destructive">{offer.error}</p>}
          <button
            onClick={onRetryConnect}
            disabled={working}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-[12px] font-medium hover:bg-accent transition-colors disabled:opacity-50"
          >
            {working && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Retry connecting
          </button>
        </>
      )}
    </div>
  );
}