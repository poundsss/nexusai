import React, { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import NotesSidebar from "@/components/notes/NotesSidebar";
import NotesEmptyState from "@/components/notes/NotesEmptyState";
import NoteDetail from "@/components/notes/NoteDetail";
import NoteEditorDialog from "@/components/notes/NoteEditorDialog";
import { useToast } from "@/components/ui/use-toast";

export default function Notes() {
  const { toast } = useToast();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [building, setBuilding] = useState(false);

  // Search is a server $regex over title AND content — the list on screen is one page, never
  // filtered in JS. Search reloads from the server on every query change.
  const load = useCallback(async (q = "") => {
    setLoading(true);
    setError(null);
    try {
      const term = q.trim();
      const page = term
        ? await base44.entities.Note.filter(
            { $or: [{ title: { $regex: term, $options: "i" } }, { content: { $regex: term, $options: "i" } }] },
            { sort: "-created_date", limit: 200 })
        : await base44.entities.Note.list({ sort: "-created_date", limit: 200 });
      setNotes(page.items || []);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Could not load notes");
      setNotes([]);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(query); }, [query, load]);

  // Pinned first (server sort is by date only); keep the selection valid as the list changes.
  const sorted = [...notes].sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0));
  const selected = sorted.find((n) => n.id === selectedId) || null;
  useEffect(() => {
    if (!loading && sorted.length && !selected) setSelectedId(sorted[0].id);
  }, [loading, sorted, selected]);

  const togglePin = async (note) => {
    await base44.entities.Note.update(note.id, { is_pinned: !note.is_pinned });
    await load(query);
  };

  const save = async (data) => {
    if (editing) {
      await base44.entities.Note.update(editing.id, data);
    } else {
      const created = await base44.entities.Note.create({ ...data, created_at: new Date().toISOString() });
      setSelectedId(created.id);
    }
    await load(query);
  };

  const remove = async (note) => {
    await base44.entities.Note.delete(note.id);
    if (selectedId === note.id) setSelectedId(null);
    await load(query);
  };

  const openNew = () => { setEditing(null); setEditorOpen(true); };

  // Turns the agent's active memories into one note, via the existing memory contract.
  const buildFromMemory = async () => {
    setBuilding(true);
    try {
      const res = await base44.functions.invoke("memory", { action: "retrieve", limit: 10 });
      const items = res?.data?.items || [];
      if (!items.length) {
        toast({ title: "Nothing in memory yet", description: "Use the agent first so there is something to remember." });
        return;
      }
      const content = items.map((i) => `• ${i.statement}`).join("\n").slice(0, 500);
      const created = await base44.entities.Note.create({ title: "From memory", content, created_at: new Date().toISOString() });
      setSelectedId(created.id);
      await load(query);
      toast({ title: "Note built from memory" });
    } catch (e) {
      toast({ variant: "destructive", title: "Could not build from memory", description: e?.response?.data?.error || e?.message });
    } finally { setBuilding(false); }
  };

  return (
    <div className="flex h-full">
      {error && (
        <div className="absolute inset-x-0 top-0 z-10 rounded-none border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-[12.5px] text-destructive">{error}</div>
      )}
      <NotesSidebar
        notes={sorted}
        loading={loading}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={openNew}
        query={query}
        onQueryChange={setQuery}
      />
      <div className="relative min-w-0 flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <NotesEmptyState onNew={openNew} onBuildFromMemory={buildFromMemory} building={building} />
        ) : (
          <NoteDetail note={selected} onTogglePin={togglePin} onEdit={(n) => { setEditing(n); setEditorOpen(true); }} onDelete={remove} />
        )}
      </div>
      <NoteEditorDialog open={editorOpen} onOpenChange={setEditorOpen} note={editing} onSave={save} />
    </div>
  );
}