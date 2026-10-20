import React, { useState } from "react";
import { Search, Store, Star, Download, Tag, Package, Shield, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { useMarketplace } from "@/hooks/useMarketplace";
import { Input } from "@/components/ui/input";
import AccountPage from "@/components/shell/AccountPage";
import EmptyState from "@/components/states/EmptyState";
import InstalledApps from "@/components/marketplace/InstalledApps";
import ListingPreview from "@/components/marketplace/ListingPreview";

const KINDS = [
  { id: null, label: "All", icon: Sparkles },
  { id: "template", label: "Templates", icon: Store },
  { id: "integration", label: "Integrations", icon: Package },
  { id: "agent", label: "Agents", icon: Sparkles },
  { id: "component", label: "Components", icon: Package },
  { id: "plugin", label: "Plugins", icon: Package },
  { id: "workflow", label: "Workflows", icon: Package },
];

const SORTS = [
  { id: "-install_count", label: "Most installed" },
  { id: "-rating_avg", label: "Top rated" },
  { id: "-listed_at", label: "Newest" },
];

const KIND_ICON = {
  template: Store, integration: Package, agent: Sparkles, component: Package, plugin: Package, workflow: Package,
};

function ListingCard({ listing }) {
  const Icon = KIND_ICON[listing.kind] || Store;
  return (
    <Link to={`/marketplace/${listing.slug}`} className="flex flex-col rounded-xl border border-border bg-card shadow-sm overflow-hidden hover:border-foreground/25 hover:shadow-md transition-all">
      <ListingPreview listing={listing} Icon={Icon} />
      <div className="flex items-start gap-2.5 p-3.5 pb-0">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[13.5px] truncate">{listing.name}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5 capitalize">
            {listing.kind}{listing.category && ` · ${listing.category}`}
          </div>
        </div>
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
          {listing.pricing_model === "free" ? "Free" : listing.price_cents > 0 ? `$${(listing.price_cents / 100).toFixed(0)}` : ""}
        </span>
      </div>
      <p className="mt-2 px-3.5 text-[12px] text-muted-foreground line-clamp-2 flex-1">{listing.summary || listing.description || "No description"}</p>
      <div className="mt-3 flex items-center gap-3 px-3.5 pb-3 text-[11px] text-muted-foreground border-t border-border/70 pt-2.5">
        <span className="flex items-center gap-1">
          <Star className="h-3 w-3 text-amber-500" />
          {listing.rating_avg > 0 ? listing.rating_avg.toFixed(1) : "—"}
          {listing.rating_count > 0 && ` (${listing.rating_count})`}
        </span>
        <span className="flex items-center gap-1">
          <Download className="h-3 w-3" />
          {listing.install_count}
        </span>
        {listing.trust_score < 80 && (
          <span className="flex items-center gap-0.5 text-amber-600">
            <Shield className="h-3 w-3" />{listing.trust_score < 50 ? "Low trust" : "Review"}
          </span>
        )}
      </div>
    </Link>
  );
}

export default function Marketplace() {
  const { listings, loading, error, query, setQuery, kind, setKind, sort, setSort } = useMarketplace();
  const [tab, setTab] = useState("browse");

  return (
    <AccountPage title="Marketplace" subtitle="Templates, integrations, agents and plugins you can install into an application.">
      {/* Tabs */}
      <div className="flex gap-1 mb-5 border-b border-border">
        <button
          onClick={() => setTab("browse")}
          className={`flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium border-b-2 transition-colors ${tab === "browse" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          <Store className="h-3.5 w-3.5" />Browse
        </button>
        <button
          onClick={() => setTab("installed")}
          className={`flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium border-b-2 transition-colors ${tab === "installed" ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          <Package className="h-3.5 w-3.5" />Installed
        </button>
      </div>

      {tab === "installed" ? (
        <InstalledApps />
      ) : (
        <>
          {/* Search + sort */}
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search listings…"
                className="pl-9"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="h-9 rounded-lg border border-border bg-background px-3 text-[13px] hover:bg-muted/50 transition-colors cursor-pointer"
            >
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>

          {/* Category pills */}
          <div className="flex flex-wrap gap-2 mb-6">
            {KINDS.map((k) => {
              const Icon = k.icon;
              return (
                <button
                  key={k.label}
                  onClick={() => setKind(k.id)}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                    kind === k.id ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />{k.label}
                </button>
              );
            })}
          </div>

          {/* Content */}
          {loading ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[0,1,2,3,4,5].map((i) => <div key={i} className="h-52 rounded-xl border border-border bg-muted/30 animate-pulse" />)}
            </div>
          ) : error ? (
            <EmptyState icon={Store} title="Could not load marketplace" description={error} />
          ) : listings.length === 0 ? (
            <EmptyState icon={Store} title="No listings found" description="Try a different search or filter." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {listings.map((l) => <ListingCard key={l.id} listing={l} />)}
            </div>
          )}
        </>
      )}
    </AccountPage>
  );
}