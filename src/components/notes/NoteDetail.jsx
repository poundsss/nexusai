import React from "react";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2, Pin, PinOff } from "lucide-react";

// 1:1 Base44 note reading pane: the selected note's title, date and full content, with the
// pin, edit and delete actions in the header.
export default function NoteDetail({ note, onTogglePin, onEdit, onDelete }) {
  if (!note) return null;
  const when = note.created_at || note.created_date;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 px-8 pt-6">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {note.is_pinned && <Pin className="h-3.5 w-3.5 text-brand" />}
            <h2 className="truncate text-[17px] font-semibold">{note.title}</h2>
          </div>
          {when && <p className="mt-1 text-[12px] text-muted-foreground">{new Date(when).toLocaleString()}</p>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => onTogglePin(note)} aria-label={note.is_pinned ? "Unpin note" : "Pin note"}>
            {note.is_pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => onEdit(note)} aria-label="Edit note">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => onDelete(note)} aria-label="Delete note">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-8 py-5">
        {note.content ? (
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{note.content}</p>
        ) : (
          <p className="text-[13px] text-muted-foreground">No content</p>
        )}
      </div>
    </div>
  );
}