import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search, Pin, X } from "lucide-react";

// 1:1 Base44 notes sidebar: a "Notes" header with the add and search actions, then the
// note list. Search expands inline and filters on the server.
export default function NotesSidebar({ notes, loading, selectedId, onSelect, onNew, query, onQueryChange }) {
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <div className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between px-4 py-3.5">
        <h1 className="text-[14.5px] font-semibold">Notes</h1>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={onNew} aria-label="New note">
            <Plus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 hover:text-foreground ${searchOpen ? "text-foreground" : "text-muted-foreground"}`}
            onClick={() => { setSearchOpen((v) => !v); if (searchOpen) onQueryChange(""); }}
            aria-label="Search notes"
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {searchOpen && (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search notes…"
              className="h-8 pl-8 pr-8 text-[12.5px]"
              autoFocus
            />
            {query.trim() && (
              <Button
                variant="ghost" size="icon"
                onClick={() => onQueryChange("")}
                className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {loading && notes.length === 0 ? (
          <div className="px-2 py-3 text-[12.5px] text-muted-foreground">Loading…</div>
        ) : notes.length === 0 ? (
          <div className="px-2 py-3 text-[12.5px] text-muted-foreground">
            {query.trim() ? "No notes match your search" : "No notes yet"}
          </div>
        ) : (
          notes.map((note) => (
            <button
              key={note.id}
              type="button"
              onClick={() => onSelect(note.id)}
              className={`block w-full rounded-md px-2.5 py-2 text-left transition-colors ${
                note.id === selectedId ? "bg-muted" : "hover:bg-muted/60"
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {note.is_pinned && <Pin className="h-3 w-3 shrink-0 text-brand" />}
                <span className="truncate text-[13px] font-medium">{note.title}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {new Date(note.created_at || note.created_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}