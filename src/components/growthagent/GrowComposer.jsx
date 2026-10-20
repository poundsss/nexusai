import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import useDictation from "@/hooks/useDictation";
import useAutoGrowTextarea from "@/hooks/useAutoGrowTextarea";
import { useBuilderCredits } from "@/hooks/useBuilderCredits";
import AttachmentStrip from "@/components/attachments/AttachmentStrip";
import GrowComposerControls from "@/components/growthagent/GrowComposerControls";
import ComposerFrame from "@/components/composer/ComposerFrame";

export default function GrowComposer({ onSend, disabled, sending, injected, attachments, projectBar, error, onDismissError, questionnaire = null }) {
  const [text, setText] = useState("");
  const [preferences, setPreferences] = useState({ modelId: null, mode: "build" });
  const speech = useDictation({ onText: setText });
  const growRef = useAutoGrowTextarea(text);
  const credits = useBuilderCredits();
  const canSend = !!text.trim() && !disabled && !attachments.uploading;
  useEffect(() => { if (injected?.token) setText(injected.text || ""); }, [injected?.token]);
  const submit = async () => {
    if (!canSend) return;
    await onSend(text.trim(), preferences);
    setText("");
  };
  return (
    <div>
      {error && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          {onDismissError && (
            <button type="button" onClick={onDismissError} aria-label="Dismiss error" className="shrink-0 opacity-70 hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {questionnaire ? (
        <ComposerFrame projectBar={projectBar} className="border-border bg-card text-card-foreground focus-within:border-foreground/30 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.25)]">
          {questionnaire}
        </ComposerFrame>
      ) : <ComposerFrame {...attachments.dropZoneProps} projectBar={projectBar} className={`border-border bg-card text-card-foreground focus-within:border-foreground/30 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.25)] ${attachments.dragging ? "border-foreground/40" : ""}`}>
        {attachments.dragging && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[inherit] border border-dashed border-foreground/30 bg-background/80 text-[12.5px] font-medium">Drop an image to attach</div>}
        <textarea
          ref={growRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={attachments.onPaste}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}
          rows={3}
          aria-label="Message the Growth Agent"
          placeholder="Message the Growth Agent…"
          className="w-full resize-none rounded-t-[inherit] bg-transparent px-5 pt-4 pb-1 text-[17px] leading-relaxed outline-none placeholder:text-muted-foreground/60"
        />
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
        <GrowComposerControls attachments={attachments} speech={speech} text={text} preferences={preferences} onPreferences={setPreferences} models={credits.models} selectionAllowed={credits.modelSelection?.allowed !== false} canSend={canSend} sending={sending} onSend={submit} />
    </ComposerFrame>}
    </div>
  );
}