import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { Trash2, CheckCircle2, Loader2, Package, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";

// Installed apps view. Lists the workspace's marketplace installs from the real
// backend (my_installs action), shows status and granted capabilities, and allows
// uninstalling. The backend re-checks ownership on every uninstall.
export default function InstalledApps() {
  const { workspace } = useWorkspace();
  const [installs, setInstalls] = useState(null);
  const [listings, setListings] = useState({});
  const [loading, setLoading] = useState(true);
  const [uninstalling, setUninstalling] = useState(null);

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke("marketplace", { action: "my_installs", workspace_id: workspace.id });
      const rows = res.data?.installs || [];
      setInstalls(rows);
      // Resolve listing metadata for each install (name, kind, etc.)
      const listingIds = [...new Set(rows.map((i) => i.listing_id))];
      const listingMap = {};
      await Promise.all(listingIds.map(async (id) => {
        try {
          const r = await base44.functions.invoke("marketplace", { action: "get", listing_id: id });
          if (r.data?.listing) listingMap[id] = r.data.listing;
        } catch {}
      }));
      setListings(listingMap);
    } catch {} finally { setLoading(false); }
  }, [workspace]);

  useEffect(() => { load(); }, [load]);

  const uninstall = async (installId) => {
    setUninstalling(installId);
    try {
      await base44.functions.invoke("marketplace", { action: "uninstall", workspace_id: workspace.id, install_id: installId });
      toast({ title: "Uninstalled", description: "The app has been removed from your workspace." });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Uninstall failed", description: e.response?.data?.error || e.message });
    } finally {
      setUninstalling(null);
    }
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  if (!installs || installs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-12 text-center">
        <Package className="h-8 w-8 mx-auto text-muted-foreground/40" />
        <p className="mt-3 text-[14px] font-medium">No installed apps</p>
        <p className="text-[12px] text-muted-foreground mt-1">Browse the marketplace to find templates, integrations, and plugins.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {installs.map((inst) => {
        const listing = listings[inst.listing_id];
        return (
          <div key={inst.id} className="rounded-xl border border-border bg-card p-4 flex flex-col">
            <div className="flex items-start gap-3">
              <span className="h-10 w-10 rounded-lg bg-accent grid place-items-center text-accent-foreground shrink-0">
                <Package className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-[14px] truncate">{listing?.name || "Unknown"}</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {listing?.kind && <span className="capitalize">{listing.kind}</span>}
                  {` · v${inst.version_number}`}
                </div>
              </div>
              <span className={`flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded ${
                inst.status === "active" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"
              }`}>
                {inst.status === "active" && <CheckCircle2 className="h-3 w-3" />}
                {inst.status}
              </span>
            </div>
            {inst.capabilities_granted?.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1">
                {inst.capabilities_granted.slice(0, 3).map((c) => (
                  <span key={c} className="text-[9px] font-mono rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{c}</span>
                ))}
                {inst.capabilities_granted.length > 3 && (
                  <span className="text-[9px] text-muted-foreground">+{inst.capabilities_granted.length - 3}</span>
                )}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              {listing?.slug && (
                <Button size="sm" variant="outline" className="flex-1" asChild>
                  <Link to={`/marketplace/${listing.slug}`}>Details</Link>
                </Button>
              )}
              <Button
                size="sm" variant="outline"
                disabled={uninstalling === inst.id}
                onClick={() => uninstall(inst.id)}
                className="text-destructive hover:text-destructive"
              >
                {uninstalling === inst.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}