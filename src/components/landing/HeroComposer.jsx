import React, { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, ArrowRight, Paperclip, X, ChevronDown, Check, Hammer, MessageCircle } from "lucide-react";

const MODES = [
  { id: "build", label: "Build", icon: Hammer, hint: "Start building immediately" },
  { id: "ask", label: "Ask", icon: MessageCircle, hint: "Discuss before building" },
];

// Hero composer: prompt + file attachments + Build/Ask mode.
// Visitors are not signed in, so submitting carries the intent to registration.
export default function HeroComposer({ prompt, onPromptChange }) {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [mode, setMode] = useState("build");
  const [menuOpen, setMenuOpen] = useState(false);
  const active = MODES.find((m) => m.id === mode);
  const ActiveIcon = active.icon;

  // The intent must survive registration: it rides the SAFE returnTo (validated by
  // safeReturnTo), so register → verify — or Continue with Google — lands on Home with
  // the original prompt and mode, and Home's composer uses them for the first build.
  const submit = () => {
    const next = new URLSearchParams({ mode });
    if (prompt.trim()) next.set("prompt", prompt.trim());
    navigate(`/register?returnTo=${encodeURIComponent(`/?${next.toString()}`)}`);
  };

  return (
    <div className="relative oled-border mt-10 text-left rounded-2xl border border-border bg-card p-4 shadow-sm">
      <textarea
        rows={2}
        value={prompt}
        onChange={(e) => onPromptChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        placeholder="Describe the app you want to build…"
        className="w-full resize-none bg-transparent text-[16px] text-foreground placeholder:text-muted-foreground/60 outline-none"
      />

      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[11.5px] text-foreground/80">
              <Paperclip className="h-3 w-3" />
              <span className="max-w-[160px] truncate">{f.name}</span>
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { setFiles([...files, ...Array.from(e.target.files || [])]); e.target.value = ""; }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="grid place-items-center h-8 w-8 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
          title="Attach files"
        >
          <Paperclip className="h-4 w-4" />
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-1.5 h-8 rounded-lg border border-border px-2.5 text-[12.5px] text-foreground hover:border-foreground/30 transition-colors"
          >
            <ActiveIcon className="h-3.5 w-3.5" />
            {active.label}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
          </button>
          {menuOpen && (
            <div className="absolute left-0 bottom-full mb-2 w-60 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl z-20">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { setMode(m.id); setMenuOpen(false); }}
                  className="w-full flex items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-accent transition-colors"
                >
                  <m.icon className="h-4 w-4 mt-0.5 shrink-0" />
                  <span className="flex-1">
                    <span className="block text-[13.5px] font-medium">{m.label}</span>
                    <span className="block text-[12px] text-muted-foreground">{m.hint}</span>
                  </span>
                  {mode === m.id && <Check className="h-4 w-4 mt-0.5" />}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="hidden sm:flex items-center gap-1.5 text-[11.5px] text-muted-foreground ml-1">
          <Sparkles className="h-3.5 w-3.5" />Free credits to start
        </span>

        <button
          type="button"
          onClick={submit}
          className="ml-auto grid place-items-center h-10 w-10 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}