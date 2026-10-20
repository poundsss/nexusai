import React, { useCallback, useEffect, useState } from "react";
import { Pencil, Archive, ArchiveRestore, MessageSquare, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useAgentChatState, setActiveId as selectConversation, onNewConversation } from "@/lib/agentChatStore";

// Sentinel for the sidebar's UI-state mirror rows (the platform conversation row stays the
// source of truth for messages; this entity only persists the title/archive state, which the
// platform conversation API has no update endpoint for).
const MIRROR_SENTINEL = "workspace-agent-ui";

// Conversation list of the Agent mode — rendered INSIDE the main shell sidebar (one left bar,
// like the reference Agent surface). Light theme to match the shell; selection lives in the
// shared agent chat store so the /agent chat page and this section stay in sync.
export default function ConversationsSidebar() {
  const { agentName, activeId } = useAgentChatState();
  const [rows, setRows] = useState(null); // platform conversations, newest first
  const [meta, setMeta] = useState({}); // conversation_id -> { title, is_archived }
  const [tab, setTab] = useState("active");
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [list, mirrors] = await Promise.all([
        base44.agents.listConversations({ agent_name: agentName }),
        base44.entities.Conversation.filter({ agent_name: agentName }),
      ]);
      const m = {};
      for (const r of mirrors || []) {
        if (r.conversation_id) m[r.conversation_id] = { title: r.title || "", is_archived: !!r.is_archived };
      }
      setMeta(m);
      const sorted = (list || []).slice().sort((a, b) =>
        String(b.updated_date || b.created_date || "").localeCompare(String(a.updated_date || a.created_date || "")));
      setRows(sorted);
      return sorted;
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not load conversations");
      return [];
    }
  }, [agentName]);

  useEffect(() => {
    setRows(null); setEditingId(null);
    let alive = true;
    (async () => {
      let list = await load();
      // First visit with no conversations at all: create the starter session, as before.
      if (alive && list && list.length === 0) {
        const c = await base44.agents.createConversation({ agent_name: agentName, metadata: { name: "New conversation" } }).catch(() => null);
        if (c) { await load(); selectConversation(c.id); return; }
      }
      if (alive && list && list.length && activeId == null) {
        const firstOpen = list.find((c) => !meta[c.id]?.is_archived);
        if (firstOpen) selectConversation(firstOpen.id);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName, load]);

  // Persist a sidebar state change through the Conversation-entity mirror.
  const setMirror = async (cid, patch) => {
    setBusy(true);
    try {
      const found = await base44.entities.Conversation.filter({ agent_name: agentName, conversation_id: cid });
      // One mirror row per conversation: collapse any accidental duplicates, then apply the patch.
      for (const extra of found.slice(1)) await base44.entities.Conversation.delete(extra.id).catch(() => {});
      if (found[0]) await base44.entities.Conversation.update(found[0].id, patch);
      else await base44.entities.Conversation.create({
        project_id: MIRROR_SENTINEL, agent_name: agentName, conversation_id: cid, is_archived: false, ...patch,
      });
      const list = await load();
      if (patch.is_archived === true && cid === activeId) {
        const fallback = (list || []).find((c) => c.id !== cid && !meta[c.id]?.is_archived);
        selectConversation(fallback ? fallback.id : null);
      }
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not save");
    } finally { setBusy(false); }
  };

  const newChat = async () => {
    setBusy(true); setError(null);
    try {
      const c = await base44.agents.createConversation({ agent_name: agentName, metadata: { name: "New conversation" } });
      await load();
      selectConversation(c.id);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not start a new conversation");
    } finally { setBusy(false); }
  };

  // The "New conversation" button lives at the TOP of the agent nav (ShellSidebar); this
  // section keeps the creation + refresh logic and answers its clicks.
  useEffect(() => onNewConversation(() => { newChat(); }), [newChat]);

  const titleOf = (c) => (meta[c.id]?.title) || c.metadata?.name || c.title || "New conversation";
  const all = rows || [];
  const open = all.filter((c) => !meta[c.id]?.is_archived);
  const archived = all.filter((c) => meta[c.id]?.is_archived);
  const shown = tab === "active" ? open : archived;

  return (
    <div className="pb-2">
      <p className="px-2.5 pb-1.5 text-[12px] font-medium text-sidebar-foreground/60">Conversations</p>

      <div className="mt-2 flex gap-1 px-1.5 text-[12px]">
        <button
          onClick={() => setTab("active")}
          className={`rounded-md px-2 py-1 ${tab === "active" ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/50 hover:text-sidebar-accent-foreground"}`}
        >Active ({open.length})</button>
        {archived.length > 0 && (
          <button
            onClick={() => setTab("archived")}
            className={`rounded-md px-2 py-1 ${tab === "archived" ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/50 hover:text-sidebar-accent-foreground"}`}
          >Archived ({archived.length})</button>
        )}
      </div>

      {error && <p className="px-2.5 pt-2 text-[11px] text-destructive">{error}</p>}

      <div className="mt-1 px-1.5">
        {rows === null && (
          <div className="grid place-items-center py-6"><Loader2 className="h-4 w-4 animate-spin text-sidebar-foreground/40" /></div>
        )}
        {rows !== null && shown.length === 0 && (
          <p className="px-1.5 py-3 text-[12px] text-sidebar-foreground/50">
            {tab === "active" ? "No conversations yet." : "Nothing archived."}
          </p>
        )}
        {shown.map((c) => {
          const editing = editingId === c.id;
          const isArchived = !!meta[c.id]?.is_archived;
          return (
            <div
              key={c.id}
              className={`group relative flex items-center rounded-md pr-12 ${c.id === activeId ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"}`}
            >
              {editing ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { const v = draft.trim(); setEditingId(null); if (v) setMirror(c.id, { title: v }); }
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onBlur={() => setEditingId(null)}
                  className="w-full rounded-md border border-sidebar-border bg-sidebar-accent/60 px-2.5 py-2 text-[13px] text-sidebar-accent-foreground outline-none"
                />
              ) : (
                <button
                  onClick={() => selectConversation(c.id)}
                  className="flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left"
                  title={titleOf(c)}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40" />
                  <span className="truncate text-[13px] text-sidebar-foreground/85">{titleOf(c)}</span>
                </button>
              )}
              {!editing && (
                <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-60 md:opacity-0 md:group-hover:opacity-100">
                  <button
                    onClick={() => { setEditingId(c.id); setDraft(titleOf(c)); }}
                    title="Rename"
                    aria-label="Rename conversation"
                    className="rounded-md p-1 text-sidebar-foreground/50 hover:text-sidebar-accent-foreground"
                  ><Pencil className="h-3 w-3" /></button>
                  {isArchived ? (
                    <button
                      onClick={() => setMirror(c.id, { is_archived: false })}
                      disabled={busy}
                      title="Restore"
                      aria-label="Restore conversation"
                      className="rounded-md p-1 text-sidebar-foreground/50 hover:text-sidebar-accent-foreground disabled:opacity-50"
                    ><ArchiveRestore className="h-3 w-3" /></button>
                  ) : (
                    <button
                      onClick={() => setMirror(c.id, { is_archived: true })}
                      disabled={busy}
                      title="Archive"
                      aria-label="Archive conversation"
                      className="rounded-md p-1 text-sidebar-foreground/50 hover:text-sidebar-accent-foreground disabled:opacity-50"
                    ><Archive className="h-3 w-3" /></button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}