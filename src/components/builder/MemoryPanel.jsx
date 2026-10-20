import React, { useCallback, useEffect, useState } from "react";
import { Brain, Loader2, Archive, Search, RefreshCw } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "@/components/ui/use-toast";
import { Input } from "@/components/ui/input";

// Project / agent memory — the certified `memory` surface (retrieve / archive / history).
// retrieve lists active memories across the project, user and platform tiers; archive removes
// one item (the only "delete" the contract exposes). There is NO pin and NO bulk-clear action in
// the backend — those are not exposed here (UNKNOWN), and none is invented.
const SCOPE_TONE = { project: "text-brand", user: "text-muted-foreground", platform: "text-amber-600" };
const VERIF = { verified: "bg-emerald-500/10 text-emerald-600", user_stated: "bg-blue-500/10 text-blue-600", inferred: "bg-amber-500/10 text-amber-600", unverified: "bg-muted text-muted-foreground" };

export default function MemoryPanel({ projectId }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await base44.functions.invoke("memory", { action: "retrieve", project_id: projectId, query, limit: 50, allow_low_confidence: true });
      setItems(res.data?.items || []);
    } catch (e) {
      setItems({ error: e.response?.data?.error || e.message });
    } finally {
      setLoading(false);
    }
  }, [projectId, query]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const archive = async (id) => {
    setBusy(id);
    try {
      await base44.functions.invoke("memory", { action: "archive", memory_id: id });
      toast({ title: "Memory archived" });
      setItems((cur) => (Array.isArray(cur) ? cur.filter((m) => m.memory_id !== id) : cur));
    } catch (e) {
      toast({ variant: "destructive", title: "Could not archive", description: e.response?.data?.error || e.message });
    } finally { setBusy(null); }
  };

  const list = Array.isArray(items) ? items : [];
  const scoped = list.filter((m) => m.scope === "project");

  return (
    <div className="mt-4 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 mb-2">
        <Brain className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Memory</h3>
        <span className="text-[11px] text-muted-foreground/60">{scoped.length} project · {list.length} total active</span>
        <button onClick={load} className="ml-auto text-muted-foreground hover:text-foreground transition-colors" aria-label="Refresh"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      <p className="text-[12px] text-muted-foreground mb-2">
        Active memories the AI retrieves for this app — project, your user, and platform knowledge. Archive a memory to remove it from retrieval; pin and bulk-clear are not supported by the backend.
      </p>
      <div className="relative mb-2">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memories…" className="h-8 pl-8 text-[12.5px]" />
      </div>

      {loading ? (
        <div className="text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : items?.error ? (
        <p className="text-[12px] text-destructive">{items.error}</p>
      ) : list.length === 0 ? (
        <p className="text-[12px] text-muted-foreground/60 py-3 text-center">No active memories yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((m) => (
            <li key={m.memory_id} className="rounded-md border border-border/70 px-2.5 py-1.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px]">{m.statement}</p>
                  {m.reason && <p className="mt-0.5 text-[11px] text-muted-foreground">{m.reason}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    <span className={SCOPE_TONE[m.scope] || ""}>{m.scope}</span>
                    <span className="rounded bg-muted px-1 py-0.5">{m.memory_type}</span>
                    <span className={`rounded px-1 py-0.5 ${VERIF[m.verification] || VERIF.unverified}`}>{m.verification}</span>
                    {m.confidence != null && <span>conf {Math.round((m.confidence || 0) * 100)}%</span>}
                    {m.subject_key && <span className="font-mono truncate">· {m.subject_key}</span>}
                  </div>
                </div>
                <button onClick={() => archive(m.memory_id)} disabled={busy === m.memory_id} title="Archive" className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors">
                  {busy === m.memory_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}