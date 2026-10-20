import React from "react";
import { File as FileIcon, Loader2 } from "lucide-react";

// Left pane of the code workspace: the repository's file list plus the working branch's
// changed files vs the base branch (clicking a change opens its diff in the editor pane).
export default function FileTree({ loading, files, changes, selected, onOpen, onDiff }) {
  const nodes = files?.files || [];
  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-1.5">
        {!files ? (
          <div className="grid place-items-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : nodes.length === 0 ? (
          <p className="px-1.5 py-2 text-[12px] text-muted-foreground">No files.</p>
        ) : (
          nodes.map((n) => (
            <button
              key={n.path}
              onClick={() => onOpen(n.path)}
              className={`w-full flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] font-mono truncate transition-colors ${
                selected === n.path ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
              title={n.path}
            >
              <FileIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{n.path}</span>
            </button>
          ))
        )}
      </div>
      <div className="shrink-0 border-t border-border p-1.5">
        <p className="px-1.5 py-1 text-[11px] font-medium text-muted-foreground">
          Changes vs base{changes.length ? ` (${changes.length})` : ""}
        </p>
        {changes.length === 0 ? (
          <p className="px-1.5 py-1 text-[11px] text-muted-foreground">No changes yet.</p>
        ) : (
          changes.map((c) => (
            <button
              key={c.path}
              onClick={() => onDiff(c.path)}
              className="w-full flex items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] font-mono hover:bg-muted/60 transition-colors"
              title={`Diff ${c.path}`}
            >
              <span className={`text-[11px] w-14 shrink-0 ${c.change === "added" ? "text-emerald-600" : c.change === "removed" ? "text-destructive" : "text-amber-600"}`}>{c.change}</span>
              <span className="truncate">{c.path}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}