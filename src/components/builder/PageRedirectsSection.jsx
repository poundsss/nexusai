import React, { useState } from "react";
import { Loader2, Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import usePageRedirects from "@/hooks/usePageRedirects";

// Path-level 301 redirect management for a published app. Mirrors the documented Page
// redirects section under Domains. Writes require the custom-domains plan entitlement
// (enforced server-side); listing stays available without it.
export default function PageRedirectsSection({ projectId }) {
  const { redirects, loading, working, create, update, remove } = usePageRedirects(projectId);
  const { toast } = useToast();
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [matchType, setMatchType] = useState("single");
  const [editId, setEditId] = useState(null);
  const [editSource, setEditSource] = useState("");
  const [editTarget, setEditTarget] = useState("");
  const [editMatch, setEditMatch] = useState("single");

  const submit = async (e) => {
    e.preventDefault();
    if (!source.trim() || !target.trim()) return;
    try {
      await create(source.trim(), target.trim(), matchType);
      setSource(""); setTarget(""); setMatchType("single");
    } catch (err) {
      toast({ variant: "destructive", description: err.response?.data?.error || err.message });
    }
  };

  const saveEdit = async (id) => {
    try {
      await update(id, editSource.trim(), editTarget.trim(), editMatch);
      setEditId(null);
    } catch (err) {
      toast({ variant: "destructive", description: err.response?.data?.error || err.message });
    }
  };

  const del = async (id) => {
    try { await remove(id); } catch (err) { toast({ variant: "destructive", description: err.response?.data?.error || err.message }); }
  };

  const fieldCls = "min-w-[120px] flex-1 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12px] focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div>
      <h3 className="text-[12px] font-medium text-muted-foreground">Page redirects</h3>
      <p className="mt-1 text-[11px] text-muted-foreground">Permanently (301) send one path to another, or to an external <code className="font-mono">https://</code> URL. Up to 50 per app. Excludes sign-in and system-file paths.</p>
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2">
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="/old-page" className={fieldCls} />
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/new-page or https://…" className={fieldCls} />
        <select value={matchType} onChange={(e) => setMatchType(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-[12px]">
          <option value="single">Single path</option>
          <option value="prefix">Prefix</option>
        </select>
        <button type="submit" disabled={working || !source.trim() || !target.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" />Add
        </button>
      </form>

      <div className="mt-2 space-y-1.5">
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/60" />}
        {!loading && !redirects.length && <p className="text-[12px] text-muted-foreground/60">No redirects yet.</p>}
        {redirects.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px]">
            {editId === r.id ? (
              <>
                <input value={editSource} onChange={(e) => setEditSource(e.target.value)} className={fieldCls} />
                <input value={editTarget} onChange={(e) => setEditTarget(e.target.value)} className={fieldCls} />
                <select value={editMatch} onChange={(e) => setEditMatch(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-[12px]">
                  <option value="single">Single</option>
                  <option value="prefix">Prefix</option>
                </select>
                <button onClick={() => saveEdit(r.id)} className="p-1 hover:bg-accent rounded"><Check className="h-3.5 w-3.5" /></button>
                <button onClick={() => setEditId(null)} className="p-1 hover:bg-accent rounded"><X className="h-3.5 w-3.5" /></button>
              </>
            ) : (
              <>
                <span className="font-mono truncate">{r.source_path}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-mono truncate">{r.target_path}</span>
                <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{r.match_type}</span>
                <button onClick={() => { setEditId(r.id); setEditSource(r.source_path); setEditTarget(r.target_path); setEditMatch(r.match_type); }} className="p-1 hover:bg-accent rounded"><Pencil className="h-3.5 w-3.5" /></button>
                <button onClick={() => del(r.id)} className="p-1 hover:bg-accent rounded text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}