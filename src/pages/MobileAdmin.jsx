import React, { useCallback, useEffect, useState } from "react";
import { KeyRound, Store, Loader2, RefreshCw, Trash2, Plus, ShieldCheck, AlertTriangle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import AccountPage from "@/components/shell/AccountPage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

// Mobile admin — the certified `secret.manage` surface for the workspace's mobile signing
// credentials and store connections. Uses ONLY the existing `mobileBuild` signing-credential ops
// and `mobileStore` store-connection ops. Values are write-only: the list actions return is_set /
// description / last_used_at, never the secret itself. No store provider or credential field is
// invented — the iOS/Android field shapes are the backend's fixed validation (issuer_id/key_id/
// private_key for iOS; service_account_json for Android).
const PLATFORMS = [
  { id: "ios", label: "iOS — App Store" },
  { id: "android", label: "Android — Google Play" },
];

export default function MobileAdmin() {
  const { loading, workspace, capabilities } = useWorkspace();
  const wsId = workspace?.id;
  const canManage = (capabilities || []).includes("secret.manage");

  const [creds, setCreds] = useState(null);
  const [conns, setConns] = useState(null);
  const [credForm, setCredForm] = useState({ platform: "ios", value: "", description: "" });
  const [connForm, setConnForm] = useState({ platform: "ios", issuer_id: "", key_id: "", team_id: "", private_key: "", push_notifications: false, service_account_json: "" });
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    const safe = (p) => p.catch(() => null);
    const [c, s] = await Promise.all([
      safe(base44.functions.invoke("mobileBuild", { action: "list_signing_credentials", workspace_id: wsId })),
      safe(base44.functions.invoke("mobileStore", { action: "list_store_connections", workspace_id: wsId })),
    ]);
    setCreds(c ? c.data?.credentials ?? [] : []);
    setConns(s ? s.data?.connections ?? [] : []);
  }, [wsId]);

  useEffect(() => { if (canManage) load(); }, [load, canManage]);

  const putCred = async () => {
    if (!credForm.value.trim()) { toast({ variant: "destructive", title: "Credential value is required" }); return; }
    setBusy(`cred:${credForm.platform}`);
    try {
      await base44.functions.invoke("mobileBuild", { action: "put_signing_credential", workspace_id: wsId, platform: credForm.platform, value: credForm.value, description: credForm.description });
      toast({ title: "Signing credential saved", description: `${credForm.platform} — stored encrypted, value not exposed` });
      setCredForm({ ...credForm, value: "", description: "" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Save failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const delCred = async (platform) => {
    if (!confirm(`Delete ${platform} signing credential? Existing builds keep their pinned signatures.`)) return;
    setBusy(`del-cred:${platform}`);
    try {
      await base44.functions.invoke("mobileBuild", { action: "delete_signing_credential", workspace_id: wsId, platform });
      toast({ title: "Signing credential deleted" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Delete failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const putConn = async () => {
    const p = connForm.platform;
    const connection = p === "ios"
      ? { issuer_id: connForm.issuer_id, key_id: connForm.key_id, team_id: connForm.team_id, private_key: connForm.private_key, push_notifications: connForm.push_notifications }
      : { service_account_json: connForm.service_account_json };
    setBusy(`conn:${p}`);
    try {
      await base44.functions.invoke("mobileStore", { action: "put_store_connection", workspace_id: wsId, platform: p, connection });
      toast({ title: "Store connection saved", description: `${p} — stored encrypted, values not exposed` });
      setConnForm({ ...connForm, issuer_id: "", key_id: "", team_id: "", private_key: "", push_notifications: false, service_account_json: "" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Save failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const delConn = async (platform) => {
    if (!confirm(`Delete ${platform} store connection?`)) return;
    setBusy(`del-conn:${platform}`);
    try {
      await base44.functions.invoke("mobileStore", { action: "delete_store_connection", workspace_id: wsId, platform });
      toast({ title: "Store connection deleted" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Delete failed", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const credFor = (p) => (Array.isArray(creds) ? creds.find((c) => c.platform === p) : null) || { is_set: false, description: "", last_used_at: null };
  const connFor = (p) => (Array.isArray(conns) ? conns.find((c) => c.platform === p) : null) || { is_set: false, description: "", last_used_at: null };

  return (
    <AccountPage loading={loading} title="Mobile Admin" subtitle="Signing credentials and store connections for native builds. Server-enforced (secret.manage)."
      actions={<Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>}>
      {!canManage ? (
        <div className="rounded-lg border border-border p-6 text-center text-[12.5px] text-muted-foreground/70">
          <ShieldCheck className="h-5 w-5 mx-auto mb-2 text-muted-foreground/50" />
          You need the <code className="font-mono">secret.manage</code> capability (owner/admin) to manage mobile credentials.
        </div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          {/* Signing credentials */}
          <section className="rounded-lg border border-border p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-2"><KeyRound className="h-3.5 w-3.5 text-muted-foreground" />Signing credentials</div>
            <p className="text-[11.5px] text-muted-foreground mb-3">Per platform: one signing credential, stored encrypted. Values are write-only and never returned.</p>
            <ul className="divide-y divide-border/40 rounded-md border border-border mb-3">
              {PLATFORMS.map((p) => {
                const c = credFor(p.id);
                return (
                  <li key={p.id} className="px-2.5 py-2 flex items-center gap-2 text-[12px]">
                    <span className={`h-2 w-2 rounded-full ${c.is_set ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                    <span className="font-medium">{p.label}</span>
                    <span className="text-[11px] text-muted-foreground">{c.is_set ? "configured" : "not set"}</span>
                    {c.last_used_at && <span className="text-[10.5px] text-muted-foreground/70 ml-auto">used {new Date(c.last_used_at).toLocaleDateString()}</span>}
                    {c.is_set && <button onClick={() => delCred(p.id)} disabled={busy === `del-cred:${p.id}`} title="Delete" className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors">{busy === `del-cred:${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}</button>}
                  </li>
                );
              })}
            </ul>
            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="text-[11px] font-semibold text-muted-foreground">Set / replace credential</div>
              <select value={credForm.platform} onChange={(e) => setCredForm({ ...credForm, platform: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-[12px] w-full">
                {PLATFORMS.map((p) => <option key={p.id}>{p.label}</option>)}
              </select>
              <textarea value={credForm.value} onChange={(e) => setCredForm({ ...credForm, value: e.target.value })} placeholder="Paste signing credential (encrypted at rest, never shown again)" rows={3} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] font-mono" />
              <Input value={credForm.description} onChange={(e) => setCredForm({ ...credForm, description: e.target.value })} placeholder="Description (optional)" className="h-8 text-[12px]" />
              <Button size="sm" onClick={putCred} disabled={busy === `cred:${credForm.platform}`}>{busy === `cred:${credForm.platform}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Save credential</Button>
            </div>
          </section>

          {/* Store connections */}
          <section className="rounded-lg border border-border p-4">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-2"><Store className="h-3.5 w-3.5 text-muted-foreground" />Store connections</div>
            <p className="text-[11.5px] text-muted-foreground mb-3">App Store / Google Play API credentials, stored encrypted. Field shapes are the backend's fixed validation.</p>
            <ul className="divide-y divide-border/40 rounded-md border border-border mb-3">
              {PLATFORMS.map((p) => {
                const c = connFor(p.id);
                return (
                  <li key={p.id} className="px-2.5 py-2 flex items-center gap-2 text-[12px]">
                    <span className={`h-2 w-2 rounded-full ${c.is_set ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                    <span className="font-medium">{p.label}</span>
                    <span className="text-[11px] text-muted-foreground">{c.is_set ? "configured" : "not set"}</span>
                    {c.is_set && <button onClick={() => delConn(p.id)} disabled={busy === `del-conn:${p.id}`} title="Delete" className="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors ml-auto">{busy === `del-conn:${p.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}</button>}
                  </li>
                );
              })}
            </ul>
            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="text-[11px] font-semibold text-muted-foreground">Set / replace connection</div>
              <select value={connForm.platform} onChange={(e) => setConnForm({ ...connForm, platform: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-[12px] w-full">
                {PLATFORMS.map((p) => <option key={p.id}>{p.label}</option>)}
              </select>
              {connForm.platform === "ios" ? (
                <div className="space-y-2">
                  <Input value={connForm.issuer_id} onChange={(e) => setConnForm({ ...connForm, issuer_id: e.target.value })} placeholder="issuer_id" className="h-8 text-[12px] font-mono" />
                  <Input value={connForm.key_id} onChange={(e) => setConnForm({ ...connForm, key_id: e.target.value })} placeholder="key_id" className="h-8 text-[12px] font-mono" />
                  <Input value={connForm.team_id} onChange={(e) => setConnForm({ ...connForm, team_id: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) })} placeholder="team_id (10 chars)" maxLength={10} className="h-8 text-[12px] font-mono" />
                  <textarea value={connForm.private_key} onChange={(e) => setConnForm({ ...connForm, private_key: e.target.value })} placeholder="private_key (PEM)" rows={3} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] font-mono" />
                  <label className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                    <Switch checked={connForm.push_notifications} onCheckedChange={(v) => setConnForm({ ...connForm, push_notifications: v })} aria-label="Add push notifications" />
                    Add push notifications
                  </label>
                </div>
              ) : (
                <textarea value={connForm.service_account_json} onChange={(e) => setConnForm({ ...connForm, service_account_json: e.target.value })} placeholder='service_account_json (JSON with client_email + private_key)' rows={4} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] font-mono" />
              )}
              <div className="flex items-start gap-1.5 text-[10.5px] text-muted-foreground/80"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /><span>Values are encrypted at rest and never returned by the list action.</span></div>
              <Button size="sm" onClick={putConn} disabled={busy === `conn:${connForm.platform}`}>{busy === `conn:${connForm.platform}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}Save connection</Button>
            </div>
          </section>
        </div>
      )}
    </AccountPage>
  );
}