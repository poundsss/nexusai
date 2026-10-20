import React from "react";
import { Button } from "@/components/ui/button";
import { Pencil, Trash2, Pin, PinOff } from "lucide-react";

export default function NoteRow({ note, onEdit, onDelete, onTogglePin }) {
  const when = note.created_at || note.created_date;
  return (
    <div className="group flex items-start gap-4 px-4 py-3.5 border-b border-border last:border-0 hover:bg-muted/40 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          {note.is_pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-brand" />}
          <span className="text-[14px] font-medium truncate">{note.title}</span>
        </div>
        {note.content && (
          <p className="mt-1 text-[12.5px] text-muted-foreground line-clamp-2 whitespace-pre-wrap">{note.content}</p>
        )}
        {when && (
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            {new Date(when).toLocaleString()}
          </div>
        )}
      </div>
      <div className={`flex items-center gap-1 transition-opacity ${note.is_pinned ? "" : "opacity-0 group-hover:opacity-100"}`}>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onTogglePin(note)}
          aria-label={note.is_pinned ? "Unpin note" : "Pin note"}
          title={note.is_pinned ? "Unpin" : "Pin"}
        >
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
  );
}