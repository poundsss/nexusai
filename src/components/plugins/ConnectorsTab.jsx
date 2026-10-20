import React, { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Info } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { POPULAR_ORDER } from "./ConnectorRegistry";
import ConnectorIcon from "./ConnectorIcon";
import ConnectedAppsSection from "./ConnectedAppsSection";

// The Connectors tab: blue hero banner, Most popular (registry cards, 2-column), Browse all →,
// and Apps connected. Connection lifecycle stays on the certified delegatedOAuth contract
// (list/begin/refresh/revoke) — the same calls the Connections page makes; nothing new is added.
export default function ConnectorsTab({ projects, projectId, onSelectProject, registry, onConnect, onBrowseAll }) {
  const [connected, setConnected] = useState(null);
  const [busy, setBusy] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) { setConnected([]); return; }
    setConnected(null);
    try {
      const res = await base44.functions.invoke("delegatedOAuth", { action: "list", project_id: projectId });
      setConnected(res.data?.credentials || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setConnected([]);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const connect = async (name) => {
    if (!projectId) return;
    setConnecting(name);
    try {
      const ok = await onConnect(name);
      if (!ok) toast({ variant: "destructive", title: "No authorization URL returned" });
    } catch (e) {
      toast({ variant: "destructive", title: "Connect failed", description: e.response?.data?.error || e.message });
    } finally { setConnecting(null); }
  };

  const revoke = async (credential_id) => {
    setBusy(credential_id);
    try {
      await base44.functions.invoke("delegatedOAuth", { action: "revoke", project_id: projectId, credential_id });
      toast({ title: "Connection removed" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Disconnect failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const refresh = async (credential_id) => {
    setBusy(credential_id);
    try {
      await base44.functions.invoke("delegatedOAuth", { action: "refresh", project_id: projectId, credential_id });
      toast({ title: "Connection refreshed" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Refresh failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  // Most popular: the registry's own declarations, in the documented display order, first eight.
  const rank = (name) => { const i = POPULAR_ORDER.indexOf(name); return i === -1 ? POPULAR_ORDER.length : i; };
  const popular = (registry || []).slice().sort((a, b) => rank(a.name) - rank(b.name)).slice(0, 8);

  return (
    <div>
      {/* Blue connector hero/banner */}
      <div className="rounded-xl bg-gradient-to-r from-blue-600 via-blue-500 to-sky-500 text-white p-5 mb-5">
        <h2 className="text-[15px] font-semibold">Connect your tools</h2>
        <p className="mt-1 text-[12.5px] text-white/85 max-w-md leading-relaxed">
          Give your Superagent access to the services it runs on. Connecting opens the provider's
          consent screen and the connection persists for the app's signed-in user.
        </p>
      </div>

      {/* Most popular */}
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Most popular</h3>
        <button onClick={onBrowseAll} className="text-[12px] font-medium text-brand hover:underline underline-offset-2">
          Browse all →
        </button>
      </div>
      {registry === null ? (
        <div className="py-4 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : registry.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground/60 py-4 text-center rounded-md border border-border border-dashed mb-5">
          No connectors are declared in this app yet — add one under <span className="font-mono">base44/connectors/</span> to list it here.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 mb-5">
          {popular.map((c) => (
            <div key={c.name} className="flex items-start gap-3 rounded-lg border border-border p-3">
              <ConnectorIcon name={c.name} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium truncate">{c.label}</div>
                <p className="text-[11.5px] text-muted-foreground line-clamp-2 mt-0.5">{c.description}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => connect(c.name)} disabled={connecting === c.name}>
                {connecting === c.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Connect"}
              </Button>
            </div>
          ))}
        </div>
      )}

      <ConnectedAppsSection connected={connected} busy={busy} onRefresh={refresh} onDisconnect={revoke} />

      <div className="mt-3 flex items-start gap-2 text-[11.5px] text-muted-foreground/80">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <p>Connector actions run as the deployed app's signed-in end user; in the builder the backend answers AUTH_REQUIRED for this surface.</p>
      </div>

    </div>
  );
}