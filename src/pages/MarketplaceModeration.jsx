import React, { useCallback, useEffect, useState } from "react";
import { ShieldAlert, Loader2, RefreshCw, Flag, Ban, CheckCircle2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import AccountPage from "@/components/shell/AccountPage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Marketplace admin moderation — the certified `marketplace.moderate` surface. Uses ONLY the
// existing `list_reports`, `resolve_report` and `suspend` actions. Shows existing report/listing
// status fields verbatim; no moderation policy or approval workflow is invented. resolve_report's
// `action` is the backend's fixed vocabulary (none|warning|suspend|remove); `suspend` is a direct
// listing suspension by id. Both write paths require confirmation.
const REPORT_STATUS_TONE = { open: "bg-amber-500/10 text-amber-600", reviewing: "bg-blue-500/10 text-blue-600", actioned: "bg-muted text-muted-foreground", dismissed: "bg-muted text-muted-foreground/60" };
const RESOLVE_ACTIONS = [
  { value: "none", label: "None (no action)" },
  { value: "warning", label: "Warning" },
  { value: "suspend", label: "Suspend listing" },
  { value: "remove", label: "Remove listing" },
];

export default function MarketplaceModeration() {
  const { loading, workspace, capabilities } = useWorkspace();
  const wsId = workspace?.id;
  const canModerate = (capabilities || []).includes("marketplace.moderate");
  const [reports, setReports] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [busy, setBusy] = useState(null);
  const [resolveOpen, setResolveOpen] = useState(null); // report row
  const [resolveForm, setResolveForm] = useState({ action: "none", note: "" });
  const [suspendOpen, setSuspendOpen] = useState(null); // listing_id
  const [suspendReason, setSuspendReason] = useState("");

  const load = useCallback(async () => {
    if (!wsId) return;
    setReports(null);
    try {
      const res = await base44.functions.invoke("marketplace", { action: "list_reports", workspace_id: wsId, status: statusFilter || null, limit: 100 });
      setReports(res.data?.reports || []);
    } catch (e) {
      toast({ variant: "destructive", title: "Load failed", description: e.response?.data?.error || e.message });
      setReports([]);
    }
  }, [wsId, statusFilter]);

  useEffect(() => { if (canModerate) load(); }, [load, canModerate]);

  const resolve = async () => {
    if (!resolveOpen) return;
    setBusy(resolveOpen.id);
    try {
      await base44.functions.invoke("marketplace", { action: "resolve_report", workspace_id: wsId, report_id: resolveOpen.id, action: resolveForm.action, note: resolveForm.note });
      toast({ title: "Report resolved", description: `action: ${resolveForm.action}` });
      setResolveOpen(null); setResolveForm({ action: "none", note: "" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Resolve failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const suspend = async () => {
    if (!suspendOpen) return;
    if (!confirm(`Suspend listing ${suspendOpen}? This hides it and blocks new installs.`)) return;
    setBusy(`suspend:${suspendOpen}`);
    try {
      await base44.functions.invoke("marketplace", { action: "suspend", workspace_id: wsId, listing_id: suspendOpen, reason: suspendReason || "Suspended by moderation" });
      toast({ title: "Listing suspended" });
      setSuspendOpen(null); setSuspendReason("");
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Suspend failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  return (
    <AccountPage loading={loading} title="Marketplace Moderation" subtitle="Review reports, resolve them, and suspend listings. Server-enforced (marketplace.moderate)."
      actions={<Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>}>
      {!canModerate ? (
        <div className="rounded-lg border border-border p-6 text-center text-[12.5px] text-muted-foreground/70">
          <ShieldAlert className="h-5 w-5 mx-auto mb-2 text-muted-foreground/50" />
          You need the <code className="font-mono">marketplace.moderate</code> capability to access moderation.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3">
            <Flag className="h-4 w-4 text-muted-foreground" />
            <label className="text-[12.5px] text-muted-foreground">Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-[12.5px]">
              <option value="">All</option>
              <option value="open">open</option>
              <option value="reviewing">reviewing</option>
              <option value="actioned">actioned</option>
              <option value="dismissed">dismissed</option>
            </select>
          </div>

          {reports === null ? (
            <div className="text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
          ) : reports.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground/60 py-6 text-center rounded-md border border-border border-dashed">No reports.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {reports.map((r) => (
                <li key={r.id} className="px-3 py-2.5">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${REPORT_STATUS_TONE[r.status] || "bg-muted text-muted-foreground"}`}>{r.status}</span>
                    {r.action && r.action !== "none" && <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">{r.action}</span>}
                    <span className="font-mono text-[11px] text-muted-foreground truncate">listing {r.listing_id?.slice(0, 12)}…</span>
                    <span className="text-[11px] text-muted-foreground ml-auto">{r.created_date ? new Date(r.created_date).toLocaleDateString() : ""}</span>
                  </div>
                  <div className="mt-1 text-[12px]"><span className="font-medium">Reason:</span> <span className="text-muted-foreground">{r.reason}</span></div>
                  {r.detail && <div className="mt-0.5 text-[11.5px] text-muted-foreground line-clamp-2">{r.detail}</div>}
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <button onClick={() => { setResolveOpen(r); setResolveForm({ action: r.action && r.action !== "none" ? r.action : "none", note: "" }); }} className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-muted transition-colors">
                      <CheckCircle2 className="h-3 w-3 inline -mt-0.5 mr-1" />Resolve
                    </button>
                    <button onClick={() => setSuspendOpen(r.listing_id)} className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium hover:text-destructive hover:bg-muted transition-colors">
                      <Ban className="h-3 w-3 inline -mt-0.5 mr-1" />Suspend listing
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {resolveOpen && (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setResolveOpen(null)}>
              <div className="w-full max-w-md rounded-lg border border-border bg-background shadow-lg p-4" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-sm font-semibold mb-2">Resolve report</h3>
                <p className="text-[11.5px] text-muted-foreground mb-2">Reason: {resolveOpen.reason}</p>
                <label className="block mb-2">
                  <span className="text-[11px] text-muted-foreground">Action</span>
                  <select value={resolveForm.action} onChange={(e) => setResolveForm({ ...resolveForm, action: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-[12.5px] w-full">
                    {RESOLVE_ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                </label>
                <label className="block mb-3">
                  <span className="text-[11px] text-muted-foreground">Note</span>
                  <Input value={resolveForm.note} onChange={(e) => setResolveForm({ ...resolveForm, note: e.target.value })} className="h-8 text-[12.5px]" />
                </label>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setResolveOpen(null)}>Cancel</Button>
                  <Button size="sm" onClick={resolve} disabled={busy === resolveOpen.id}>{busy === resolveOpen.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Resolve</Button>
                </div>
              </div>
            </div>
          )}

          {suspendOpen && (
            <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setSuspendOpen(null)}>
              <div className="w-full max-w-md rounded-lg border border-border bg-background shadow-lg p-4" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-sm font-semibold mb-2">Suspend listing</h3>
                <p className="text-[11.5px] text-muted-foreground mb-2 font-mono">{suspendOpen}</p>
                <label className="block mb-3">
                  <span className="text-[11px] text-muted-foreground">Reason</span>
                  <Input value={suspendReason} onChange={(e) => setSuspendReason(e.target.value)} placeholder="Suspended by moderation" className="h-8 text-[12.5px]" />
                </label>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setSuspendOpen(null)}>Cancel</Button>
                  <Button size="sm" variant="destructive" onClick={suspend} disabled={busy === `suspend:${suspendOpen}`}>{busy === `suspend:${suspendOpen}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}Suspend</Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </AccountPage>
  );
}