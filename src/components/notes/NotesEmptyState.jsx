import React from "react";
import { Button } from "@/components/ui/button";
import { StickyNote, Sparkles } from "lucide-react";

// 1:1 Base44 empty state: a centered card with a soft icon tile, headline, one supporting
// line and the two starting actions.
export default function NotesEmptyState({ onNew, onBuildFromMemory, building = false }) {
  return (
    <div className="h-full grid place-items-center p-8">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card px-6 py-8 text-center shadow-sm">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-lg bg-muted border border-border">
          <StickyNote className="h-5 w-5 text-muted-foreground" />
        </span>
        <h2 className="mt-4 text-[15px] font-semibold">Create your first note</h2>
        <p className="mt-1.5 text-[12.5px] text-muted-foreground">Add files or write your own note to get started.</p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button size="sm" onClick={onNew} className="h-9 px-3.5">Add new note</Button>
          <Button size="sm" variant="outline" onClick={onBuildFromMemory} disabled={building} className="h-9 px-3.5 gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            {building ? "Building…" : "Build from memory"}
          </Button>
        </div>
      </div>
    </div>
  );
}