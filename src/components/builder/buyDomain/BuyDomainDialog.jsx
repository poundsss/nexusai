import React, { useCallback, useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import BuyDomainSearch from "@/components/builder/buyDomain/BuyDomainSearch";
import BuyDomainConfirm from "@/components/builder/buyDomain/BuyDomainConfirm";
import BuyDomainProgress from "@/components/builder/buyDomain/BuyDomainProgress";

// The registrar complexity (quotes, tokens, polling, DNS) stays entirely behind the
// domainPurchase control plane — this dialog only walks search → confirm → progress and
// shows the human stages and errors the control plane returns.
export default function BuyDomainDialog({ projectId, open, onClose, onConnected }) {
  const [stage, setStage] = useState("search"); // search | confirm | progress
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [offer, setOffer] = useState(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  const reset = () => { setStage("search"); setResults(null); setOffer(null); setError(null); };

  // Resume: a registration still in flight from an earlier session goes straight to progress.
  useEffect(() => {
    if (!open || !projectId) return undefined;
    reset();
    let alive = true;
    (async () => {
      try {
        const data = await base44.functions.invoke("domainPurchase", { project_id: projectId, action: "resume" }).then((r) => r.data);
        if (alive && data.registrations?.length) { setOffer(data.registrations[0]); setStage("progress"); }
      } catch { /* resume is best-effort */ }
    })();
    return () => { alive = false; };
  }, [open, projectId]);

  const call = useCallback(async (payload) => {
    const res = await base44.functions.invoke("domainPurchase", { project_id: projectId, ...payload });
    return res.data;
  }, [projectId]);

  const search = async (query) => {
    setSearching(true); setError(null);
    try {
      const data = await call({ action: "search", query });
      setResults(data.results || []);
    } catch (e) { setError(String(e?.message || e)); setResults(null); }
    finally { setSearching(false); }
  };

  const select = async (domain) => {
    setWorking(true); setError(null);
    try {
      const data = await call({ action: "quote", domain, period: 1, auto_renew: true });
      if (!data.available) setError("That domain was just taken by someone else. Pick another name.");
      else { setOffer(data.registration); setStage("confirm"); }
    } catch (e) { setError(String(e?.message || e)); }
    finally { setWorking(false); }
  };

  // The registrar prices the offer for the exact preferences it was quoted with, so a
  // changed auto-renew preference quietly re-quotes (instant) before purchase.
  const setAutoRenew = async (value) => {
    if (!offer) return;
    setWorking(true);
    try {
      const data = await call({ action: "quote", domain: offer.domain, period: offer.period || 1, auto_renew: value });
      if (data.available) setOffer(data.registration);
    } catch { /* keep the previous offer */ }
    finally { setWorking(false); }
  };

  const buy = async () => {
    setWorking(true); setError(null);
    try {
      const data = await call({ action: "register", registration_id: offer.registration_id });
      setOffer(data.registration);
      setStage("progress");
      if (data.registration.stage === "connected") onConnected?.();
    } catch (e) {
      // A taken or expired offer is marked failed server-side; surface that as the result
      // screen. Anything transient stays on the confirmation with an inline error.
      let fresh = null;
      try { fresh = (await call({ action: "poll", registration_id: offer.registration_id })).registration; } catch { /* keep */ }
      if (fresh && fresh.stage === "failed") { setOffer(fresh); setStage("progress"); }
      else setError(String(e?.message || e));
    } finally { setWorking(false); }
  };

  const poll = useCallback(async (registration_id) => {
    const data = await call({ action: "poll", registration_id });
    setOffer(data.registration);
    if (data.registration.stage === "connected") onConnected?.();
    return data.registration;
  }, [call, onConnected]);

  const retryConnect = async () => {
    setWorking(true);
    try {
      const data = await call({ action: "dns_provision", registration_id: offer.registration_id });
      setOffer(data.registration);
    } catch (e) { setError(String(e?.message || e)); }
    finally { setWorking(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Buy a domain</DialogTitle></DialogHeader>
        {stage === "search" && (
          <BuyDomainSearch searching={searching} working={working} results={results} error={error} onSearch={search} onSelect={select} />
        )}
        {stage === "confirm" && offer && (
          <BuyDomainConfirm offer={offer} working={working} error={error} onAutoRenew={setAutoRenew} onBuy={buy} onBack={() => { setStage("search"); setOffer(null); }} />
        )}
        {stage === "progress" && offer && (
          <BuyDomainProgress
            offer={offer}
            working={working}
            onPoll={poll}
            onRetryConnect={retryConnect}
            onSearchAgain={() => { reset(); }}
            onDone={() => { onClose(); }}
          />
        )}
        {stage === "progress" && !offer && <p className="text-[12px] text-muted-foreground">Loading…</p>}
      </DialogContent>
    </Dialog>
  );
}