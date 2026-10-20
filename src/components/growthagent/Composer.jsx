import React, { useState, useEffect } from "react";
import { Mic, AlertCircle, X, Plus, SendHorizonal } from "lucide-react";
import useDictation from "@/hooks/useDictation";
import useAutoGrowTextarea from "@/hooks/useAutoGrowTextarea";
import AttachmentStrip from "@/components/attachments/AttachmentStrip";
import AttachButton from "@/components/attachments/AttachButton";
import ComposerFrame from "@/components/composer/ComposerFrame";

// Shared chat composer (Growth + Agent), styled 1:1 with the reference Build composer:
// one rounded card, a tall input area, and a bottom control row — paperclip (when attachments
// are wired), the dictation mic, and a circular send button.
// Optional capabilities mount through props: `attachments` (useAttachments() instance),
// `dictation`, `error`, `commands` ("/" shortcuts), `projectBar`, `injected` (draft).
export default function Composer({ onSend, disabled, dark, placeholder, attachments = null, dictation = false, error = null, onDismissError, commands = null, projectBar = null, injected = null }) {
  const [text, setText] = useState("");
  const [cmdSel, setCmdSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const speech = useDictation({ onText: setText });
  const growRef = useAutoGrowTextarea(text);

  // Injected draft (Grow module request flow): a new token replaces the composer text —
  // the request is inserted for review and manual Send, never auto-sent.
  useEffect(() => { if (injected && injected.token) setText(injected.text || ""); }, [injected && injected.token]);

  const slashQuery = commands && /^\/\S{0,20}$/.test(text) ? text.slice(1).toLowerCase() : null;
  const matches = slashQuery === null
    ? []
    : commands.filter((c) => c.label.toLowerCase().startsWith(slashQuery) || slashQuery === "");
  const menuOpen = slashQuery !== null && matches.length > 0 && !slashDismissed;
  const sel = Math.min(cmdSel, matches.length - 1);

  useEffect(() => { setSlashDismissed(false); }, [text]);

  const execCommand = (c) => {
    if (!c) return;
    setCmdSel(0);
    setSlashDismissed(false);
    setText("");
    c.run();
  };

  const submit = () => {
    if (!text.trim() || disabled || attachments?.uploading) return;
    onSend(text);
    setText("");
  };

  const toggleMic = () => {
    if (!speech.supported) return;
    if (speech.listening) speech.stop();
    else speech.start(text);
  };

  const errorRow = error ? (
    <div className={`mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] ${dark ? "border-red-400/30 bg-red-500/10 text-red-200" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
      {onDismissError && (
        <button onClick={onDismissError} aria-label="Dismiss error" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  ) : null;

  const commandMenu = menuOpen && (
    <div className="absolute bottom-full left-3 right-3 mb-2 z-20 overflow-hidden rounded-xl border border-white/15 bg-neutral-900/95 shadow-xl backdrop-blur" role="listbox" aria-label="Composer commands">
      <p className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-white/40">Commands</p>
      {matches.map((c, i) => (
        <button
          key={c.label}
          type="button"
          role="option"
          aria-selected={i === sel}
          onMouseDown={(e) => { e.preventDefault(); execCommand(c); }}
          className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] ${i === sel ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5"}`}
        >
          {c.icon && <c.icon className="h-3.5 w-3.5 shrink-0 text-white/50" />}
          <span className="font-medium">{c.label}</span>
          <span className="min-w-0 truncate text-[11px] text-white/40">{c.hint}</span>
        </button>
      ))}
    </div>
  );

  const onTextAreaKeyDown = (e) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); setCmdSel((i) => (matches.length ? (i + 1) % matches.length : 0)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setCmdSel((i) => (matches.length ? (i - 1 + matches.length) % matches.length : 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); execCommand(matches[sel]); return; }
      if (e.key === "Escape") { e.preventDefault(); setSlashDismissed(true); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div>
      {errorRow}
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="max-w-3xl mx-auto">
        {projectBar && <div className="mb-2">{projectBar}</div>}
        <ComposerFrame
          {...(attachments ? attachments.dropZoneProps : {})}
          className={`${
            dark
              ? `border-white/12 bg-white/[0.06] focus-within:border-white/25 ${attachments?.dragging ? "border-white/40 bg-white/[0.08]" : ""}`
              : `border-border bg-card shadow-[0_18px_50px_-24px_rgba(0,0,0,0.25)] focus-within:border-foreground/30 ${attachments?.dragging ? "border-foreground/40 bg-accent/40" : ""}`
          }`}
        >
          {commandMenu}
          {attachments?.dragging && (
            <div className={`pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-3xl border border-dashed ${dark ? "border-white/40 bg-neutral-900/50 text-white/80" : "border-foreground/30 bg-background/70 text-foreground/70"}`}>
              <span className="text-[12.5px] font-medium">Drop an image to attach</span>
            </div>
          )}
          <textarea
            ref={growRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={attachments ? attachments.onPaste : undefined}
            onKeyDown={onTextAreaKeyDown}
            rows={3}
            placeholder={placeholder || (dark ? "Message your assistant…" : "Message the Growth Agent…")}
            className={`w-full resize-none bg-transparent px-5 pt-4 pb-1 text-[17px] leading-relaxed outline-none ${dark ? "text-white placeholder:text-white/35" : "placeholder:text-muted-foreground/60"}`}
          />
          {attachments && <AttachmentStrip items={attachments.items} onRemove={attachments.remove} dark={dark} />}
          <div className="flex h-[52px] shrink-0 items-center gap-1.5 px-3 pb-3">
            {attachments && (
              <AttachButton
                onFiles={attachments.add}
                bare
                icon={Plus}
                className={dark ? "text-white/60 hover:text-white" : "text-muted-foreground hover:text-foreground"}
                iconSize="h-[18px] w-[18px]"
              />
            )}
            <div className="flex-1" />
            {dictation && (
              <button
                type="button"
                onClick={toggleMic}
                disabled={!speech.supported}
                title={speech.supported ? (speech.listening ? "Stop dictation" : "Dictate") : "Speech recognition not supported"}
                aria-label="Dictate"
                className={`grid h-8 w-8 place-items-center rounded-full transition-colors disabled:opacity-40 ${
                  speech.listening ? (dark ? "text-[#60a5fa]" : "text-brand") : dark ? "text-white/70 hover:text-white" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Mic className={`h-[18px] w-[18px] ${speech.listening ? "animate-pulse" : ""}`} />
              </button>
            )}
            <button
              type="submit"
              disabled={disabled || !text.trim() || attachments?.uploading}
              aria-label="Send"
              className={`grid h-10 w-10 place-items-center rounded-full transition-colors disabled:pointer-events-none ${
                disabled || !text.trim() || attachments?.uploading
                  ? (dark ? "bg-white/10 text-white/40" : "bg-muted text-background")
                  : (dark ? "bg-white text-neutral-900" : "bg-foreground text-background")
              }`}
            >
              <SendHorizonal className="h-[18px] w-[18px]" />
            </button>
          </div>
        </ComposerFrame>
      </form>
    </div>
  );
}