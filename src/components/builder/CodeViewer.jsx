import React from "react";
import { Lock, Unlock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import useFileEdit from "@/components/builder/useFileEdit";

// Frozen files are read-only here as a NexusAI safety choice (the backend also refuses
// FILE_FROZEN edits) — not a Base44 parity claim.
export default function CodeViewer({ file, onToggleFrozen, projectId, version, onSaved }) {
  const edit = useFileEdit({ projectId, file, version, onSaved });
  if (!file) {
    return <div className="h-full flex items-center justify-center text-[13px] text-muted-foreground/60">Select a file from the project tree.</div>;
  }
  const lines = edit.draft.split("\n").length;
  return (
    <div className="h-full flex flex-col bg-background">
      <div className="h-9 shrink-0 flex items-center gap-3 px-3 border-b border-border text-[12px]">
        <span className="font-mono text-foreground">{file.path}</span>
        <span className="text-muted-foreground/60">{lines} lines{edit.dirty ? " · unsaved" : ""}</span>
        <button onClick={() => onToggleFrozen(file)} disabled={edit.dirty} className={`ml-auto flex items-center gap-1.5 rounded-md border px-2 py-0.5 transition-colors ${file.frozen ? "border-amber-500/40 bg-amber-500/10 text-amber-600" : "border-border text-muted-foreground hover:bg-muted"}`} title={file.frozen ? "Frozen: read-only, and the AI cannot modify it" : "Prevent the AI from modifying this file"}>
          {file.frozen ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}{file.frozen ? "Frozen" : "Freeze"}
        </button>
      </div>
      <textarea
        value={edit.draft} onChange={(e) => edit.setDraft(e.target.value)} readOnly={file.frozen || edit.saving}
        spellCheck={false} wrap="off"
        className="flex-1 w-full resize-none bg-background p-3 font-mono text-[12px] leading-5 outline-none"
      />
      {edit.error && (
        <div className="border-t border-border px-3 py-2 text-[12px] text-destructive">
          {edit.error.message}
          {edit.error.details.slice(0, 5).map((d, i) => <div key={i} className="font-mono text-[11px]">{d}</div>)}
        </div>
      )}
      <div className="h-11 shrink-0 flex items-center justify-end gap-2 px-3 border-t border-border">
        {file.frozen && <span className="mr-auto text-[11px] text-muted-foreground">Unfreeze this file to edit it.</span>}
        <Button variant="outline" size="sm" disabled={!edit.dirty || edit.saving} onClick={edit.discard}>Discard</Button>
        <Button size="sm" disabled={!edit.dirty || edit.saving || file.frozen} onClick={edit.save}>
          {edit.saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}Save
        </Button>
      </div>
    </div>
  );
}