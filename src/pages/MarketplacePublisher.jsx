import React, { useCallback, useEffect, useState } from "react";
import { Store, Loader2, RefreshCw, Plus, Eye, EyeOff, History, Ban, X, Trophy, Coins, Rocket } from "lucide-react";
import { base44 } from "@/api/base44Client";
import AccountPage from "@/components/shell/AccountPage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import PublishVersionDialog from "@/components/marketplace/PublishVersionDialog";

// Marketplace publisher surface — creator-side listing + version + revenue management.
// Reuses ONLY the certified `marketplace` backend: my_listings, create, update, publish_listing,
// versions, yank, publish_project, my_revenue, creator_metrics. No approval state, revenue rule,
// or marketplace policy is invented — every status/visibility/price field comes from the backend.
const KINDS = ["app", "agent", "template", "integration"];
const STATUS_TONE = {
  draft: "bg-muted text-muted-foreground", published: "bg-emerald-500/10 text-emerald-600",
  unlisted: "bg-blue-500/10 text-blue-600", suspended: "bg-destructive/10 text-destructive", removed: "bg-muted text-muted-foreground/60",
};
const PRICING = ["free", "paid", "freemium"];
const VSTATUS_TONE = {
  published: "bg-emerald-500/10 text-emerald-600", yanked: "bg-destructive/10 text-destructive", draft: "bg-muted text-muted-foreground",
};
const RSTATUS_TONE = { active: "text-emerald-600", reversed: "text-muted-foreground" };

export default function MarketplacePublisher() {
  const { loading, workspace } = useWorkspace();
  const wsId = workspace?.id;
  const [tab, setTab] = useState("listings");
  return (
    <AccountPage loading={loading} title="Publisher" subtitle="Create listings, manage versions, and review your creator earnings."
      actions={
        <div className="flex items-center rounded-md border border-border p-0.5">
          <button onClick={() => setTab("listings")} className={`px-2.5 py-1 rounded text-[12px] font-medium transition-colors ${tab === "listings" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Listings</button>
          <button onClick={() => setTab("revenue")} className={`px-2.5 py-1 rounded text-[12px] font-medium transition-colors ${tab === "revenue" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>Revenue</button>
        </div>
      }>
      {tab === "listings" ? <ListingsTab wsId={wsId} /> : <RevenueTab wsId={wsId} />}
    </AccountPage>
  );
}

function ListingsTab({ wsId }) {
  const [listings, setListings] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ slug: "", name: "", kind: "app", summary: "", category: "", pricing_model: "free", price_cents: 0, currency: "USD" });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [versions, setVersions] = useState(null);
  const [publishOpen, setPublishOpen] = useState(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    setListings(null);
    try {
      const [mine, met] = await Promise.all([
        base44.functions.invoke("marketplace", { action: "my_listings", workspace_id: wsId, limit: 100 }),
        base44.functions.invoke("marketplace", { action: "creator_metrics", workspace_id: wsId }).catch(() => null),
      ]);
      setListings(mine.data?.listings || []);
      if (met?.data) setMetrics(met.data);
    } catch (e) {
      toast({ variant: "destructive", title: "Load failed", description: e.response?.data?.error || e.message });
      setListings([]);
    }
  }, [wsId]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.slug || !form.name) { toast({ variant: "destructive", title: "Slug and name are required" }); return; }
    setBusy(true);
    try {
      await base44.functions.invoke("marketplace", { action: "create", workspace_id: wsId, ...form });
      toast({ title: "Listing created" });
      setCreating(false);
      setForm({ slug: "", name: "", kind: "app", summary: "", category: "", pricing_model: "free", price_cents: 0, currency: "USD" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Create failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(false); }
  };

  const publishListing = async (l) => {
    setBusy(l.id);
    try {
      await base44.functions.invoke("marketplace", { action: "publish_listing", workspace_id: wsId, listing_id: l.id, visibility: l.visibility === "private" ? "private" : "public" });
      toast({ title: "Listing published" });
      load();
    } catch (e) { toast({ variant: "destructive", title: "Publish failed", description: e.response?.data?.error || e.message }); }
    finally { setBusy(null); }
  };

  const remove = async (l) => {
    if (!confirm(`Remove "${l.name}"? This is permanent.`)) return;
    setBusy(l.id);
    try {
      await base44.functions.invoke("marketplace", { action: "remove", workspace_id: wsId, listing_id: l.id });
      toast({ title: "Listing removed" });
      load();
    } catch (e) { toast({ variant: "destructive", title: "Remove failed", description: e.response?.data?.error || e.message }); }
    finally { setBusy(null); }
  };

  const openVersions = async (l) => {
    setOpen(l);
    setVersions(null);
    try {
      const res = await base44.functions.invoke("marketplace", { action: "versions", listing_id: l.id, workspace_id: wsId });
      setVersions(res.data?.versions || []);
    } catch (e) { setVersions({ error: e.response?.data?.error || e.message }); }
  };

  const yank = async (v) => {
    setBusy(v.id);
    try {
      await base44.functions.invoke("marketplace", { action: "yank", workspace_id: wsId, listing_id: open.id, version_id: v.id, reason: "Yanked by publisher" });
      toast({ title: "Version yanked" });
      openVersions(open);
    } catch (e) { toast({ variant: "destructive", title: "Yank failed", description: e.response?.data?.error || e.message }); }
    finally { setBusy(null); }
  };

  return (
    <div>
      {metrics && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { label: "Listings", value: metrics.listing_count ?? listings?.length ?? 0 },
            { label: "Published", value: metrics.published_count ?? 0 },
            { label: "Installs", value: metrics.install_count ?? 0 },
            { label: "Avg rating", value: (metrics.rating_avg ?? 0).toFixed(1) },
          ].map((m) => (
            <div key={m.label} className="rounded-md border border-border p-3">
              <div className="text-[11px] text-muted-foreground">{m.label}</div>
              <div className="text-lg font-semibold mt-0.5">{m.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mb-3">
        <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}><Plus className="h-3.5 w-3.5" />{creating ? "Cancel" : "New listing"}</Button>
        <Button variant="ghost" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>
      </div>

      {creating && (
        <div className="rounded-lg border border-border p-4 mb-4 space-y-2.5">
          <div className="grid sm:grid-cols-2 gap-2.5">
            <Field label="Slug"><Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} className="h-8 text-[12.5px]" /></Field>
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-8 text-[12.5px]" /></Field>
            <Field label="Kind">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-[12.5px] w-full">
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
            <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="h-8 text-[12.5px]" /></Field>
            <Field label="Pricing">
              <select value={form.pricing_model} onChange={(e) => setForm({ ...form, pricing_model: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-[12.5px] w-full">
                {PRICING.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Price (cents)"><Input type="number" value={form.price_cents} onChange={(e) => setForm({ ...form, price_cents: Number(e.target.value) })} className="h-8 text-[12.5px]" /></Field>
          </div>
          <Field label="Summary"><Input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} className="h-8 text-[12.5px]" /></Field>
          <Button size="sm" onClick={create} disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Create listing</Button>
        </div>
      )}

      {listings === null ? (
        <div className="text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : listings.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground/60 py-6 text-center rounded-md border border-border border-dashed">No listings yet. Create one to start publishing.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {listings.map((l) => (
            <li key={l.id} className="px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[12.5px]">
                    <span className="font-medium truncate">{l.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${STATUS_TONE[l.status] || "bg-muted text-muted-foreground"}`}>{l.status}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{l.visibility}</span>
                    <span className="text-[11px] text-muted-foreground">v{l.current_version_number || 0}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                    <code className="font-mono">{l.slug}</code> · {l.kind} · {l.pricing_model} · {l.install_count} installs · ★ {(l.rating_avg || 0).toFixed(1)}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {l.kind === "template" && (
                    <button onClick={() => setPublishOpen(l)} title="Publish new version" className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"><Rocket className="h-3.5 w-3.5" /></button>
                  )}
                  {l.status === "draft" || l.status === "unlisted" ? (
                    <button onClick={() => publishListing(l)} disabled={busy === l.id} title="Publish listing" className="rounded p-1.5 text-muted-foreground hover:text-emerald-600 hover:bg-muted disabled:opacity-50 transition-colors"><Eye className="h-3.5 w-3.5" /></button>
                  ) : null}
                  <button onClick={() => openVersions(l)} title="Versions" className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"><History className="h-3.5 w-3.5" /></button>
                  <button onClick={() => remove(l)} disabled={busy === l.id} title="Remove" className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors"><Ban className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {publishOpen && (
        <PublishVersionDialog wsId={wsId} listing={publishOpen} onClose={() => setPublishOpen(null)} onDone={load} />
      )}

      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setOpen(null)}>
          <div className="w-full max-w-lg rounded-lg border border-border bg-background shadow-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
              <History className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold flex-1">Versions · {open.name}</h3>
              <button onClick={() => setOpen(null)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-4 max-h-96 overflow-y-auto">
              {versions === null ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : versions?.error ? <p className="text-[12px] text-destructive">{versions.error}</p> : versions.length === 0 ? <p className="text-[12px] text-muted-foreground/60">No versions published.</p> : (
                <ul className="divide-y divide-border/40">
                  {versions.map((v) => (
                    <li key={v.id} className="py-2 flex items-center gap-2 text-[12px]">
                      <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${VSTATUS_TONE[v.status] || "bg-muted text-muted-foreground"}`}>{v.status}</span>
                      <span className="font-mono">v{v.version_number}</span>
                      {v.version_label && <span className="text-muted-foreground">{v.version_label}</span>}
                      <span className="text-[11px] text-muted-foreground ml-auto">{v.install_count} installs</span>
                      {v.status === "published" && <button onClick={() => yank(v)} disabled={busy === v.id} title="Yank version" className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors">{busy === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}</button>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RevenueTab({ wsId }) {
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    if (!wsId) return;
    setData(null);
    try {
      const res = await base44.functions.invoke("marketplace", { action: "my_revenue", workspace_id: wsId });
      setData(res.data);
    } catch (e) {
      setData({ error: e.response?.data?.error || e.message });
    }
  }, [wsId]);
  useEffect(() => { load(); }, [load]);

  const rows = data?.revenue || [];
  const summary = data?.summary || {};

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Button variant="ghost" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Metric icon={Coins} label="Net publisher credits" value={summary.publisher_credits?.toFixed(2) ?? "0"} />
        <Metric icon={Coins} label="Gross credits" value={summary.gross_credits?.toFixed(2) ?? "0"} />
        <Metric icon={Coins} label="Platform fee" value={summary.platform_fee_credits?.toFixed(2) ?? "0"} />
        <Metric icon={Trophy} label="Active allocations" value={summary.active ?? 0} />
      </div>

      {data === null ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : data?.error ? <p className="text-[12px] text-destructive">{data.error}</p> : rows.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground/60 py-6 text-center rounded-md border border-border border-dashed">No revenue yet. Earnings appear here when paid installs are allocated.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-[12px]">
            <thead className="bg-muted text-left text-muted-foreground"><tr>
              <th className="px-2.5 py-1.5 font-medium">Listing</th><th className="px-2.5 py-1.5 font-medium">Version</th>
              <th className="px-2.5 py-1.5 font-medium">Gross</th><th className="px-2.5 py-1.5 font-medium">Publisher</th>
              <th className="px-2.5 py-1.5 font-medium">Fee</th><th className="px-2.5 py-1.5 font-medium">Status</th><th className="px-2.5 py-1.5 font-medium">Date</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/40">
                  <td className="px-2.5 py-1.5 font-mono truncate max-w-[160px]">{r.listing_slug || r.listing_id}</td>
                  <td className="px-2.5 py-1.5 font-mono text-muted-foreground">v{r.version_number ?? "—"}</td>
                  <td className="px-2.5 py-1.5 font-mono">{r.gross_credits?.toFixed(2)}</td>
                  <td className="px-2.5 py-1.5 font-mono">{r.publisher_credits?.toFixed(2)}</td>
                  <td className="px-2.5 py-1.5 font-mono text-muted-foreground">{r.platform_fee_credits?.toFixed(2)}</td>
                  <td className={`px-2.5 py-1.5 ${RSTATUS_TONE[r.status] || "text-muted-foreground"}`}>{r.status}</td>
                  <td className="px-2.5 py-1.5 text-muted-foreground">{r.created_date ? new Date(r.created_date).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[11.5px] text-muted-foreground/70">Payout is out of scope — this view reports MarketplaceRevenue allocations only (active minus reversed). No payout logic or billing calculation is added.</p>
    </div>
  );
}

function Field({ label, children }) {
  return <label className="block"><span className="text-[11px] text-muted-foreground">{label}</span>{children}</label>;
}
function Metric({ icon: Icon, label, value }) {
  return <div className="rounded-md border border-border p-3"><div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Icon className="h-3 w-3" />{label}</div><div className="text-lg font-semibold mt-0.5">{value}</div></div>;
}