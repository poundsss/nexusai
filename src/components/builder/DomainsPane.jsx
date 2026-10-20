import React, { useState } from "react";
import { Loader2, Plus, ShoppingCart } from "lucide-react";
import DomainRow from "@/components/builder/DomainRow";
import BuyDomainDialog from "@/components/builder/buyDomain/BuyDomainDialog";
import PageRedirectsSection from "@/components/builder/PageRedirectsSection";
import BuiltInUrlSection from "@/components/builder/BuiltInUrlSection";

export default function DomainsPane({ projectId, onChanged, domains, loading, working, onAdd, onVerify, onSetPrimary, onRemove }) {
  const [hostname, setHostname] = useState("");
  const [environment, setEnvironment] = useState("production");
  const [buyOpen, setBuyOpen] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!hostname.trim()) return;
    await onAdd(hostname.trim(), environment);
    setHostname("");
  };

  return (
    <div>
      <BuiltInUrlSection projectId={projectId} onChanged={onChanged} />

      <h3 className="text-[12px] font-medium text-muted-foreground">Custom domains</h3>
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          placeholder="app.acme.com"
          className="min-w-[200px] flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-[12px]">
          <option value="production">production</option>
          <option value="staging">staging</option>
        </select>
        <button type="submit" disabled={working || !hostname.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" />Add
        </button>
        {projectId && (
          <button
            type="button"
            onClick={() => setBuyOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-[12px] font-medium hover:bg-accent transition-colors"
          >
            <ShoppingCart className="h-3.5 w-3.5" />Buy a domain
          </button>
        )}
      </form>
      <p className="mt-1.5 text-[11px] text-muted-foreground">Add the TXT record shown, then verify. A domain serves nothing until ownership is proven.</p>

      <div className="mt-2 space-y-2">
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />}
        {!loading && !domains.length && <p className="text-[12px] text-muted-foreground/60">No custom domains yet.</p>}
        {domains.map((d) => (
          <DomainRow key={d.id} domain={d} working={working} onVerify={onVerify} onSetPrimary={onSetPrimary} onRemove={onRemove} />
        ))}
      </div>

      {projectId && (
        <BuyDomainDialog
          projectId={projectId}
          open={buyOpen}
          onClose={() => setBuyOpen(false)}
          onConnected={onChanged}
        />
      )}

      <div className="mt-5 border-t border-border pt-4">
        <PageRedirectsSection projectId={projectId} />
      </div>
    </div>
  );
}