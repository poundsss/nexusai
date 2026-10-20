import React, { useRef } from "react";
import { ArrowUp, Loader2, Mic, Plus } from "lucide-react";
import GrowModelMenu from "@/components/growthagent/GrowModelMenu";

export default function GrowComposerControls({ attachments, speech, text, preferences, onPreferences, models, selectionAllowed, canSend, sending, onSend }) {
  const picker = useRef(null);
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-1.5 px-3 pb-3">
      <input ref={picker} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { attachments.add(event.target.files); event.target.value = ""; }} />
      <button type="button" onClick={() => picker.current?.click()} aria-label="Attach an image" className="grid h-8 w-8 shrink-0 place-items-center text-muted-foreground hover:text-foreground"><Plus className="h-4 w-4" /></button>
      <div className="flex min-w-0 items-center gap-1.5">
        <GrowModelMenu models={models} value={preferences.modelId} onChange={(modelId) => onPreferences({ ...preferences, modelId })} selectionAllowed={selectionAllowed} />
      </div>
      <div className="flex-1" />
      <button
        type="button"
        disabled={!speech.supported}
        onClick={() => (speech.listening || speech.transcribing) ? speech.stop() : speech.start(text)}
        aria-label={speech.listening ? "Stop dictation" : "Dictate"}
        title={speech.error ? `Dictation error: ${speech.error}` : speech.supported ? "Dictate" : "Speech input not supported"}
        className={`grid h-8 w-8 shrink-0 place-items-center disabled:opacity-40 ${speech.listening ? "text-brand" : speech.error ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`}
      >
        {speech.transcribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
      </button>
      <button type="button" onClick={onSend} disabled={!canSend} aria-label="Send" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-30">{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-5 w-5" />}</button>
    </div>
  );
}