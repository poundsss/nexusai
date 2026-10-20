import React, { useCallback, useEffect, useState } from "react";
import { Cable, Loader2, RefreshCw, Trash2, Link2, AlertTriangle, Info } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { workspaceRead } from "@/lib/workspaceRead";
import AccountPage from "@/components/shell/AccountPage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { toast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Generic app Connections — the certified delegatedOAuth contract (list/begin/refresh/revoke/
// status) for the deployed app's end-user delegated OAuth credentials. This is separate from the
// agent-connector configuration and from the workspace inbound MCP connections (/mcp).
//
// The contract is app-user-scoped: it resolves a signed-in app user from the deployed-app session,
// NOT a builder session. Called from the builder it returns AUTH_REQUIRED — the honest signal that
// the surface is meaningful inside a published app with an app user session, not a builder-only API.
// No new connector type or auth flow is created: begin reuses the existing authorization_url path
// and the existing /oauth/callback (AppOAuthCallback) handles the return.
const STATUS_TONE = {
  active: "bg-emerald-500/10 text-emerald-600", expired: "bg-amber-500/10 text-amber-600",
  revoked: "bg-muted text-muted-foreground", error: "bg-destructive/10 text-destructive",
};

export default function Connections() {
  const { loading, workspace } = useWorkspace();
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [creds, setCreds] = useState(null);
  const [providerId, setProviderId] = useState("");
  const [busy, setBusy] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!workspace) return;
    (async () => {
      try {
        const d = await workspaceRead("projects", { workspace_id: workspace.id, sort: "-updated_date", limit: 50 });
        const rows = d.projects || [];
        setProjects(rows);
        if (rows?.[0]?.id) setProjectId(rows[0].id);
        // A provider id may arrive from the agent onboarding (/connections?provider=…): prefill.
        const pre = new URLSearchParams(window.location.search).get("provider");
        if (pre) setProviderId(pre);
      } catch (e) { setError(e.response?.data?.error || e.message); }
    })();
  }, [workspace]);

  const load = useCallback(async () => {
    if (!projectId) { setCreds([]); return; }
    setCreds(null);
    try {
      const res = await base44.functions.invoke("delegatedOAuth", { action: "list", project_id: projectId });
      setCreds(res.data?.credentials || []);
      setError(null);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setCreds([]);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    const pid = providerId.trim();
    if (!pid) { toast({ variant: "destructive", title: "Enter a provider id" }); return; }
    setConnecting(true);
    try {
      const res = await base44.functions.invoke("delegatedOAuth", { action: "begin", project_id: projectId, provider_id: pid });
      const url = res.data?.authorization_url;
      if (url) window.location.href = url;
      else toast({ variant: "destructive", title: "No authorization URL returned" });
    } catch (e) {
      toast({ variant: "destructive", title: "Connect failed", description: e.response?.data?.error || e.message });
    } finally { setConnecting(false); }
  };

  const revoke = async (credential_id) => {
    setBusy(credential_id);
    try {
      await base44.functions.invoke("delegatedOAuth", { action: "revoke", project_id: projectId, credential_id });
      toast({ title: "Connection revoked" });
      load();
    } catch (e) {
      toast({ variant: "destructive", title: "Revoke failed", description: e.response?.data?.error || e.message });
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

  return (
    <AccountPage loading={loading} title="Connections" subtitle="Delegated OAuth connections for the deployed app's end users."
      actions={<Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>}>
      <div className="flex items-center gap-2 mb-4">
        <Cable className="h-4 w-4 text-muted-foreground" />
        <label className="text-[12.5px] text-muted-foreground">App</label>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-[12.5px]">
          {projects.length === 0 ? <option value="">No projects</option> : projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <section className="rounded-lg border border-border p-4 mb-4">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold mb-2"><Link2 className="h-3.5 w-3.5 text-muted-foreground" />Connect a provider</div>
        <p className="text-[12px] text-muted-foreground mb-2">
          Enter the provider id (the connector name declared in the app's <code className="font-mono">base44/connectors/*.jsonc</code>) and connect. The authorization URL from the certified <code className="font-mono">delegatedOAuth</code> contract opens the provider's consent screen; the existing <code className="font-mono">/oauth/callback</code> handles the return.
        </p>
        <div className="flex items-center gap-2">
          <Input value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="provider_id, e.g. googlecalendar" className="h-8 max-w-xs text-[12.5px]" />
          <Button size="sm" onClick={connect} disabled={connecting || !projectId}>
            {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}Connect
          </Button>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-2 mb-4">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-[12px] text-muted-foreground">{error}</p>
        </div>
      )}

      <section>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Connected credentials</h3>
        {creds === null ? (
          <div className="text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : creds.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground/60 py-4 text-center rounded-md border border-border border-dashed">No connections. This surface needs a signed-in app user of the deployed app (AUTH_REQUIRED in the builder).</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {creds.map((c) => (
              <li key={c.credential_id} className="px-3 py-2 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[12.5px]">
                    <span className="font-mono">{c.provider_id}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${STATUS_TONE[c.status] || "bg-muted text-muted-foreground"}`}>{c.status}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                    {c.external_subject || c.external_email || "—"}
                    {c.scopes?.length > 0 && <> · {c.scopes.join(" ")}</>}
                    {c.expires_at && <> · expires {new Date(c.expires_at).toLocaleString()}</>}
                  </div>
                </div>
                <button onClick={() => refresh(c.credential_id)} disabled={busy === c.credential_id} title="Refresh" className="rounded p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
                  {busy === c.credential_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                </button>
                <button onClick={() => revoke(c.credential_id)} disabled={busy === c.credential_id} title="Disconnect" className="rounded p-1.5 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-4 flex items-start gap-2 text-[11.5px] text-muted-foreground/80">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <p>The list of available (not-yet-connected) providers is built server-side from the app's connector declarations and is not exposed as a client-facing list action; the provider id is supplied here by name. Connecting reuses the existing OAuth begin/callback path — no new flow is created.</p>
      </div>
    </AccountPage>
  );
}