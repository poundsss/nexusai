import React, { useCallback, useEffect, useState } from "react";
import { Brain, Loader2, Archive, ArchiveRestore, Search, RefreshCw, Plus, Pencil, ChevronDown } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useWorkspace } from "@/hooks/useWorkspace";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { useAgentChatState } from "@/lib/agentChatStore";
import MemoryEditDialog from "@/components/agent/MemoryEditDialog";

// MEMORY — what the agent remembers across conversations (the certified `memory` surface).
// Read + archive + restore + correction (supersede) go through the existing memory backend
// function; manual additions are the documented user-scope path (user_input / user_stated).
// Scope is resolved server-side — the client never supplies workspace or project ids for a write.
const SCOPE_TONE = { project: "text-brand", user: "text-muted-foreground", platform: "text-amber-600" };
const VERIF = { verified: "bg-emerald-500/10 text-emerald-600", user_stated: "bg-blue-500/10 text-blue-600", inferred: "bg-amber-500/10 text-amber-600", unverified: "bg-muted text-muted-foreground" };

export default function AgentMemory() {
  const { agentName } = useAgentChatState();
  const { workspace, user } = useWorkspace();
  const [items, setItems] = useState(null);
  const [archived, setArchived] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [mine, ws, mineArch, wsArch] = await Promise.all([
        base44.entities.MemoryItem.filter({ user_id: user.id, status: "active" }, { sort: "-updated_date", limit: 100 }).then((p) => p.items || []).catch(() => []),
        workspace
          ? base44.entities.MemoryItem.filter({ workspace_id: workspace.id, status: "active" }, { sort: "-updated_date", limit: 100 }).then((p) => p.items || []).catch(() => [])
          : [],
        base44.entities.MemoryItem.filter({ user_id: user.id, status: "archived" }, { sort: "-updated_date", limit: 50 }).then((p) => p.items || []).catch(() => []),
        workspace
          ? base44.entities.MemoryItem.filter({ workspace_id: workspace.id, status: "archived" }, { sort: "-updated_date", limit: 50 }).then((p) => p.items || []).catch(() => [])
          : [],
      ]);
      const merge = (...groups) => {
        const seen = new Set();
        const out = [];
        for (const g of groups) for (const m of g || []) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
        return out;
      };
      setItems(merge(ws, mine));
      setArchived(merge(wsArch, mineArch));
    } catch (e) {
      const err = e?.response?.data?.error || e?.message || "Could not load memories";
      setItems({ error: err }); setArchived([]);
    } finally { setLoading(false); }
  }, [user, workspace]);

  useEffect(() => { load(); }, [load]);

  const archive = async (id) => {
    setBusy(id);
    try {
      await base44.functions.invoke("memory", { action: "archive", memory_id: id });
      toast({ title: "Memory archived" });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not archive", description: e?.response?.data?.error || e?.message });
    } finally { setBusy(null); }
  };

  const restore = async (id) => {
    setBusy(id);
    try {
      await base44.functions.invoke("memory", { action: "restore", memory_id: id });
      toast({ title: "Memory restored" });
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not restore", description: e?.response?.data?.error || e?.message });
    } finally { setBusy(null); }
  };

  const remember = async () => {
    const statement = draft.trim();
    if (!statement) return;
    setBusy("add");
    try {
      await base44.functions.invoke("memory", {
        action: "create", scope: "user", memory_type: "preference", statement, source_type: "user_input",
        source_reference: { kind: "manual", note: "Added from the Memory page" },
      });
      toast({ title: "Saved to memory" });
      setDraft("");
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not save", description: e?.response?.data?.error || e?.message });
    } finally { setBusy(null); }
  };

  const saveCorrection = async ({ statement, reason }) => {
    try {
      await base44.functions.invoke("memory", {
        action: "supersede", memory_id: editing.id,
        ...(reason ? { reason } : {}),
        statement,
        source_type: "user_input",
        source_reference: { kind: "manual", note: "Corrected from the Memory page" },
      });
      toast({ title: "Memory corrected" });
      setEditing(null);
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not correct", description: e?.response?.data?.error || e?.message });
    }
  };

  const q = query.trim().toLowerCase();
  const list = (Array.isArray(items) ? items : []).filter((m) => !q || (m.statement || "").toLowerCase().includes(q));
  const archivedList = (Array.isArray(archived) ? archived : []).filter((m) => !q || (m.statement || "").toLowerCase().includes(q));

  const row = (m, isArchived) => (
    <li key={m.id} className="rounded-md border border-border/70 px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className={`text-[13px] ${isArchived ? "text-muted-foreground" : ""}`}>{m.statement}</p>
          {m.reason && <p className="mt-0.5 text-[11.5px] text-muted-foreground">{m.reason}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <span className={SCOPE_TONE[m.scope] || ""}>{m.scope}</span>
            <span className="rounded bg-muted px-1 py-0.5">{m.memory_type}</span>
            <span className={`rounded px-1 py-0.5 ${VERIF[m.verification] || VERIF.unverified}`}>{m.verification}</span>
          </div>
        </div>
        {isArchived ? (
          <button onClick={() => restore(m.id)} disabled={busy === m.id} title="Restore" aria-label="Restore memory"
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
            {busy === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArchiveRestore className="h-3 w-3" />}
          </button>
        ) : (
          <>
            <button onClick={() => setEditing(m)} disabled={busy === m.id} title="Correct" aria-label="Correct memory"
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors">
              <Pencil className="h-3 w-3" />
            </button>
            <button onClick={() => archive(m.id)} disabled={busy === m.id} title="Archive" aria-label="Archive memory"
              className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50 transition-colors">
              {busy === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
            </button>
          </>
        )}
      </div>
    </li>
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex items-center gap-2.5 mb-1">
        <Brain className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-[22px] font-semibold tracking-tight">Memory</h1>
        <button onClick={load} className="ml-auto text-muted-foreground hover:text-foreground transition-colors" aria-label="Refresh"><RefreshCw className="h-4 w-4" /></button>
      </div>
      <p className="text-[13px] text-muted-foreground mb-6">
        What <span className="font-medium text-foreground">{agentName}</span> and the workspace agents remember across conversations. Archive a memory to remove it from retrieval.
      </p>

      {/* Manual memory — the documented user-scope create */}
      <div className="flex items-center gap-2 mb-4">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") remember(); }}
          placeholder="Remember something about how you work…"
          className="h-9 text-[13px]"
        />
        <Button size="sm" className="h-9 shrink-0" onClick={remember} disabled={!draft.trim() || busy === "add"}>
          {busy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Remember
        </Button>
      </div>

      <div className="relative mb-3">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memories…" className="h-8 pl-8 text-[12.5px]" />
      </div>

      {loading ? (
        <div className="text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>
      ) : items?.error ? (
        <p className="text-[12.5px] text-destructive">{items.error}</p>
      ) : list.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground/60 py-4 text-center">No active memories yet — the agents save what they learn here automatically.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((m) => row(m, false))}
        </ul>
      )}

      {/* Archived — retained for provenance; restorable until retention removes them. */}
      {!loading && !items?.error && (archivedList.length > 0 || showArchived) && (
        <div className="mt-6">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showArchived ? "" : "-rotate-90"}`} />
            Archived ({archivedList.length})
          </button>
          {showArchived && (
            archivedList.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground/60 py-4 text-center">Nothing archived here.</p>
            ) : (
              <ul className="space-y-1.5 mt-2">{archivedList.map((m) => row(m, true))}</ul>
            )
          )}
        </div>
      )}

      {editing && (
        <MemoryEditDialog open onOpenChange={(o) => { if (!o) setEditing(null); }} memory={editing} onSave={saveCorrection} />
      )}
    </div>
  );
}