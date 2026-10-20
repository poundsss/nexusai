import React, { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { KeyRound, Loader2, Plus, Trash2, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/use-toast";

// Minimal Personal Access Token management (Workspace Settings → Security).
// The raw token is shown ONCE, in the create result, and never again — the list
// carries identification metadata (prefix, scope, status) only.
export default function PatSection({ workspace, user }) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("all");
  const [projectId, setProjectId] = useState("");
  const [fullAccess, setFullAccess] = useState(false);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState(null);

  const load = async () => {
    if (!workspace) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke("personalAccessTokens", { action: "list", workspace_id: workspace.id });
      setTokens(res?.tokens || []);
    } catch {
      // owner/admin only surface — a non-admin viewer simply sees an empty list
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [workspace]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await base44.functions.invoke("personalAccessTokens", {
        action: "create", workspace_id: workspace.id, name: name.trim(),
        app_scope: scope, project_id: scope === "project" ? projectId.trim() || null : null,
        full_access: fullAccess,
      });
      setIssued(res.token);
      setName(""); setProjectId(""); setFullAccess(false);
      await load();
      toast({ title: "Token created", description: "Copy it now — it is shown only once." });
    } catch (e) {
      toast({ title: "Could not create token", description: e.message, variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id) => {
    try {
      await base44.functions.invoke("personalAccessTokens", { action: "revoke", workspace_id: workspace.id, token_id: id });
      await load();
      toast({ title: "Token revoked" });
    } catch (e) {
      toast({ title: "Could not revoke token", description: e.message, variant: "destructive" });
    }
  };

  return (
    <section className="rounded-lg border border-border p-5">
      <div className="flex items-start gap-3">
        <span className="h-10 w-10 rounded-lg grid place-items-center shrink-0 bg-muted text-muted-foreground">
          <KeyRound className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold">Personal access tokens</h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Bearer tokens for API access to app data. Scope to all apps or one app; read-only or full access. The token value is shown once at creation.
          </p>

          {issued && (
            <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate font-mono text-[12px]">{issued}</code>
                <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(issued); toast({ title: "Copied" }); }}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>Done</Button>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">Shown only once — store it now.</p>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name" className="h-8 w-44 text-[13px]" />
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-[13px]"
            >
              <option value="all">All apps</option>
              <option value="project">One app</option>
            </select>
            {scope === "project" && (
              <Input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="App (project) id" className="h-8 w-52 text-[13px]" />
            )}
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <input type="checkbox" checked={fullAccess} onChange={(e) => setFullAccess(e.target.checked)} className="h-3.5 w-3.5" />
              Full access
            </label>
            <Button size="sm" onClick={create} disabled={creating || !name.trim() || (scope === "project" && !projectId.trim())}>
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Create
            </Button>
          </div>

          <div className="mt-3 space-y-2">
            {loading ? (
              <div className="flex justify-center py-3 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
            ) : tokens.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-3 text-[12.5px] text-muted-foreground">No personal access tokens yet.</div>
            ) : (
              tokens.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[13px]">
                  <div className="flex items-center gap-2 min-w-0">
                    <code className="truncate font-mono text-[12px]">{t.token_prefix}…</code>
                    <span className="text-[11px] text-muted-foreground uppercase">{t.app_scope === "all" ? "all apps" : "one app"}</span>
                    <span className="text-[11px] text-muted-foreground">{t.full_access ? "full" : "read-only"}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[11px] font-medium rounded px-2 py-0.5 ${t.status === "active" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{t.status}</span>
                    {t.status === "active" && (
                      <Button size="sm" variant="ghost" onClick={() => revoke(t.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}