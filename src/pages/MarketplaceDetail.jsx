import React, { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  Store, Star, Download, Tag, Shield, CheckCircle2, AlertTriangle, ArrowLeft,
  Loader2, Flag, Package, Coins, Lock,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import AccountPage from "@/components/shell/AccountPage";
import InstallDialog from "@/components/marketplace/InstallDialog";
import Reviews from "@/components/marketplace/Reviews";

const fmtCents = (cents, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format((cents || 0) / 100);

const CAPABILITY_LABELS = {
  "entity:read": "Read project data",
  "entity:write": "Modify project data",
  "function:invoke": "Run backend functions",
  "network": "External network requests",
  "filesystem": "Access project files",
  "secrets": "Read secret values",
};

const TRUST_TONE = (score) => {
  if (score >= 80) return { label: "Trusted", cls: "bg-emerald-500/10 text-emerald-600" };
  if (score >= 50) return { label: "Review", cls: "bg-amber-500/10 text-amber-600" };
  return { label: "Low trust", cls: "bg-rose-500/10 text-rose-600" };
};

export default function MarketplaceDetail() {
  const { slug } = useParams();
  const { workspace } = useWorkspace();
  const [listing, setListing] = useState(null);
  const [versions, setVersions] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(null);
  const [balance, setBalance] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listingRes = await base44.functions.invoke("marketplace", { action: "get_by_slug", slug });
      const l = listingRes.data?.listing;
      if (!l) { setError("Listing not found"); return; }
      setListing(l);
      const [vRes, rRes] = await Promise.all([
        base44.functions.invoke("marketplace", { action: "versions", listing_id: l.id }).catch(() => ({ data: { versions: [] } })),
        base44.functions.invoke("marketplace", { action: "reviews", listing_id: l.id }).catch(() => ({ data: { reviews: [] } })),
      ]);
      setVersions(vRes.data?.versions || []);
      setReviews(rRes.data?.reviews || []);
      if (workspace) {
        const balRes = await base44.functions.invoke("commerce", { action: "summary", workspace_id: workspace.id }).catch(() => null);
        setBalance(balRes?.data?.balance?.available ?? null);
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [slug, workspace]);

  useEffect(() => { load(); }, [load]);

  const handleInstall = async (consentedCapabilities) => {
    setInstalling(true);
    setInstallError(null);
    try {
      await base44.functions.invoke("marketplace", {
        action: "install",
        workspace_id: workspace.id,
        listing_id: listing.id,
        consented_capabilities: consentedCapabilities,
      });
      toast({ title: "Installed", description: `${listing.name} is now available in your workspace.` });
      setInstallOpen(false);
      await load();
    } catch (e) {
      setInstallError(e.response?.data?.error || e.message);
    } finally {
      setInstalling(false);
    }
  };

  const report = async () => {
    const reason = prompt("Report reason (spam, malware, ip_infringement, etc.):");
    if (!reason) return;
    try {
      await base44.functions.invoke("marketplace", {
        action: "report", workspace_id: workspace.id, listing_id: listing.id, reason,
      });
      toast({ title: "Report submitted", description: "Thank you. Our team will review it." });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not submit report", description: e.response?.data?.error || e.message });
    }
  };

  if (loading) return <AccountPage loading><div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div></AccountPage>;
  if (error || !listing) return (
    <AccountPage>
      <div className="text-center py-20">
        <p className="text-[15px] font-medium">{error || "Listing not found"}</p>
        <Button variant="outline" className="mt-4" asChild><Link to="/marketplace"><ArrowLeft className="h-4 w-4 mr-1.5" />Back to marketplace</Link></Button>
      </div>
    </AccountPage>
  );

  const trust = TRUST_TONE(listing.trust_score);
  const isPaid = listing.pricing_model !== "free" && listing.price_cents > 0;
  const isSuspended = listing.status === "suspended";

  return (
    <AccountPage>
      <div className="max-w-4xl mx-auto">
        <Link to="/marketplace" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground transition-colors mb-4">
          <ArrowLeft className="h-3.5 w-3.5" />Back to marketplace
        </Link>

        {/* Header */}
        <div className="flex items-start gap-4">
          <span className="h-14 w-14 rounded-xl bg-accent grid place-items-center text-accent-foreground shrink-0">
            <Store className="h-7 w-7" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">{listing.name}</h1>
              <span className="text-[10px] font-semibold uppercase rounded bg-muted px-1.5 py-0.5 text-muted-foreground capitalize">{listing.kind}</span>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">{listing.summary || listing.description?.slice(0, 120)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <Star className="h-3.5 w-3.5 text-amber-500" />
                {listing.rating_avg > 0 ? `${listing.rating_avg.toFixed(1)} (${listing.rating_count})` : "No ratings"}
              </span>
              <span className="flex items-center gap-1"><Download className="h-3.5 w-3.5" />{listing.install_count} installs</span>
              <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${trust.cls}`}>
                <Shield className="h-3 w-3" />{trust.label}
              </span>
              {listing.current_version_number > 0 && <span className="font-mono">v{listing.current_version_number}</span>}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            {isSuspended ? (
              <span className="flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[13px] text-destructive">
                <AlertTriangle className="h-4 w-4" />Suspended
              </span>
            ) : (
              <Button onClick={() => setInstallOpen(true)} disabled={!workspace}>
                <Download className="h-4 w-4 mr-1.5" />
                {isPaid ? `${fmtCents(listing.price_cents, listing.currency)}` : "Install"}
              </Button>
            )}
            <button onClick={report} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
              <Flag className="h-3 w-3" />Report
            </button>
          </div>
        </div>

        {/* Description */}
        {listing.description && (
          <div className="mt-6 rounded-lg border border-border p-5">
            <h2 className="text-sm font-semibold mb-2">About</h2>
            <p className="text-[14px] text-muted-foreground leading-relaxed whitespace-pre-wrap">{listing.description}</p>
          </div>
        )}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {/* Capabilities / Permissions */}
          <div className="rounded-lg border border-border p-5">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold mb-3"><Shield className="h-4 w-4 text-muted-foreground" />Permissions</h2>
            {listing.capabilities?.length > 0 ? (
              <ul className="space-y-2">
                {listing.capabilities.map((cap) => (
                  <li key={cap} className="flex items-start gap-2 text-[13px]">
                    <Lock className="h-3.5 w-3.5 mt-0.5 text-amber-600 shrink-0" />
                    <div>
                      <span className="font-medium">{CAPABILITY_LABELS[cap] || cap}</span>
                      <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">{cap}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">No special permissions required.</p>
            )}
          </div>

          {/* Details */}
          <div className="rounded-lg border border-border p-5">
            <h2 className="text-sm font-semibold mb-3">Details</h2>
            <dl className="space-y-2 text-[13px]">
              {listing.category && <div className="flex justify-between"><dt className="text-muted-foreground">Category</dt><dd>{listing.category}</dd></div>}
              <div className="flex justify-between"><dt className="text-muted-foreground">Pricing</dt><dd className="capitalize">{listing.pricing_model === "free" ? "Free" : `${fmtCents(listing.price_cents, listing.currency)} · ${listing.pricing_model}`}</dd></div>
              {listing.tags?.length > 0 && (
                <div className="flex justify-between items-start"><dt className="text-muted-foreground">Tags</dt><dd className="flex flex-wrap gap-1 justify-end">{listing.tags.map((t) => <span key={t} className="flex items-center gap-0.5 text-[11px] rounded bg-muted px-1.5 py-0.5"><Tag className="h-2.5 w-2.5" />{t}</span>)}</dd></div>
              )}
              {listing.listed_at && <div className="flex justify-between"><dt className="text-muted-foreground">Listed</dt><dd>{new Date(listing.listed_at).toLocaleDateString()}</dd></div>}
            </dl>
          </div>
        </div>

        {/* Versions */}
        {versions.length > 0 && (
          <div className="mt-6 rounded-lg border border-border p-5">
            <h2 className="text-sm font-semibold mb-3">Versions</h2>
            <div className="space-y-2">
              {versions.slice(0, 5).map((v) => (
                <div key={v.id} className="flex items-center gap-3 text-[13px] py-1.5 border-b border-border/30 last:border-0">
                  <span className="font-mono text-muted-foreground w-12">v{v.version_number}</span>
                  {v.version_label && <span className="font-medium">{v.version_label}</span>}
                  {v.changelog && <span className="text-muted-foreground truncate flex-1">{v.changelog}</span>}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${v.status === "published" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{v.status}</span>
                  <span className="text-[11px] text-muted-foreground">{new Date(v.published_at || v.created_date).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reviews */}
        <div className="mt-6">
          <h2 className="text-sm font-semibold mb-3">Reviews</h2>
          <Reviews listingId={listing.id} workspaceId={workspace?.id} reviews={reviews} onSubmitted={load} />
        </div>
      </div>

      <InstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        listing={listing}
        onConfirm={() => handleInstall(listing.capabilities || [])}
        installing={installing}
        error={installError}
        balance={balance}
      />
    </AccountPage>
  );
}