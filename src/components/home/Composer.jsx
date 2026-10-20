import React, { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUp, Loader2, Plus, Mic, Globe, Presentation, Laptop, FlaskConical, Github, Figma, FileText } from "lucide-react";
import ModelSelector from "@/components/builder/ModelSelector";
import DesignSystemMenu from "@/components/builder/DesignSystemMenu";
import PlusMenu from "@/components/home/PlusMenu";
import BuildModeMenu from "@/components/home/BuildModeMenu";
import useAttachments from "@/hooks/useAttachments";
import useDictation from "@/hooks/useDictation";
import AttachmentStrip from "@/components/attachments/AttachmentStrip";

const APP_TYPES = [
  { label: "Website", icon: Globe, prompt: "Build a website for " },
  { label: "Slides", icon: Presentation, prompt: "Build a slide presentation about ", badge: "New" },
  { label: "App", icon: Laptop, prompt: "Build an app for " },
  { label: "Prototype", icon: FlaskConical, prompt: "Build a prototype of " },
];

// The dominant element of Home: a real composer. Typing here creates the project
// and hands the description — and any reference images — to the Builder's first AI run.
// P-16C1 (documented): the model can also be chosen for the FIRST prompt, from the same
// commerce-sourced catalog and the same Builder+ entitlement gate as the Builder chat.
export default function Composer({ onCreate, disabled, dark = false, models = [], selectionAllowed = true, initialText = "", initialMode = "build" }) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(initialMode);
  const [modelId, setModelId] = useState(null);
  const [designSystemId, setDesignSystemId] = useState(null);
  const attachments = useAttachments();
  const dictation = useDictation({ onText: setText });
  const navigate = useNavigate();
  const fileRef = useRef(null);

  const submit = async (value) => {
    const description = (value ?? text).trim();
    if (!description || busy || disabled || attachments.uploading) return;
    setBusy(true);
    try {
      await onCreate(description, { mode, imageUrls: attachments.urls, modelId, designSystemId });
      attachments.clear();
    } finally {
      setBusy(false);
    }
  };

  const toggleMic = () => {
    if (!dictation.supported) return;
    if (dictation.listening) dictation.stop();
    else dictation.start(text);
  };

  const micIdle = dark
    ? "text-white/70 hover:text-white"
    : "text-muted-foreground hover:text-foreground";

  const shell = dark
    ? "bg-[#171717] border-white/10 focus-within:border-white/25 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.7)]"
    : "bg-card border-border focus-within:border-foreground/30 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.25)]";
  const chip = dark
    ? "border-white/10 text-white/70 hover:text-white hover:border-white/25"
    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30";
  const send = dark
    ? "bg-[#60a5fa] text-white hover:bg-[#60a5fa]/90"
    : "bg-foreground text-background hover:opacity-90";

  return (
    <div>
      <div
        {...attachments.dropZoneProps}
        className={`relative oled-border rounded-3xl border backdrop-blur transition-colors ${shell} ${attachments.dragging ? (dark ? "border-white/40 bg-white/[0.08]" : "border-foreground/40 bg-accent/40") : ""}`}
      >
        {attachments.dragging && (
          <div className={`pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-3xl border border-dashed ${dark ? "border-white/40 bg-neutral-900/50 text-white/80" : "border-foreground/30 bg-background/70 text-foreground/70"}`}>
            <span className="flex items-center gap-2 text-[12.5px] font-medium">
              <Plus className="h-3.5 w-3.5" />Drop an image to attach
            </span>
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={attachments.onPaste}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          rows={3}
          autoFocus
          placeholder="Let's build a data visualization tool…"
          className={`w-full resize-none bg-transparent px-5 pt-4 pb-1 text-[17px] leading-relaxed outline-none ${dark ? "text-white placeholder:text-white/35" : "placeholder:text-muted-foreground/60"}`}
          aria-label="Describe your application"
        />
        <AttachmentStrip items={attachments.items} onRemove={attachments.remove} dark={dark} />
        <div className="flex items-center gap-1.5 px-3 pb-3">
          {/* Attach (+) */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { attachments.add(e.target.files); e.target.value = ""; }}
          />
          <PlusMenu
            dark={dark}
            onAttach={() => fileRef.current?.click()}
            onStart={(t) => { setText(t); }}
          />

          {/* Model selector — "Auto" by default; the chip stays visible even before models load */}
          <ModelSelector
            models={models}
            value={modelId}
            onChange={setModelId}
            disabled={!selectionAllowed}
            dark={dark}
          />

          {/* Build / Plan mode — sits next to the send button */}
          <BuildModeMenu mode={mode} onChange={setMode} dark={dark} />

          {/* Design system for the app this prompt creates — same selector as the Builder chat */}
          <DesignSystemMenu value={designSystemId} onChange={setDesignSystemId} dark={dark} />

          {/* Mic — icon only, no shell */}
          <button
            type="button"
            onClick={toggleMic}
            disabled={!dictation.supported}
            title={dictation.supported ? (dictation.listening ? "Stop dictation" : "Dictate") : "Speech recognition not supported"}
            aria-label="Dictate"
            className={`ml-auto grid place-items-center h-8 w-8 transition-colors disabled:opacity-40 ${
              dictation.listening ? (dark ? "text-[#60a5fa]" : "text-brand") : micIdle
            }`}
          >
            <Mic className={`h-4 w-4 ${dictation.listening ? "animate-pulse" : ""}`} />
          </button>

          {/* Send */}
          <button
            onClick={() => submit()}
            disabled={!text.trim() || busy || disabled || attachments.uploading}
            className={`grid place-items-center h-10 w-10 rounded-full font-semibold disabled:opacity-30 transition-opacity ${send}`}
            aria-label="Build it"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* App type grid */}
      <div className="mt-8 flex justify-center gap-6 sm:gap-8">
        {APP_TYPES.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => setText(t.prompt)}
            className="group flex flex-col items-center gap-2"
          >
            <span className={`relative grid place-items-center h-[72px] w-[72px] rounded-xl border transition-colors ${
              dark ? "border-white/10 bg-white/[0.06] group-hover:bg-white/[0.12] group-hover:border-white/25" : "border-border bg-card group-hover:bg-accent group-hover:border-foreground/25"
            }`}>
              {t.badge && (
                <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-[#60a5fa] text-white text-[10px] font-semibold px-1.5 py-0.5 leading-none">
                  {t.badge}
                </span>
              )}
              <t.icon className={`h-6 w-6 ${dark ? "text-white/90" : "text-foreground/80"}`} />
            </span>
            <span className={`text-[12.5px] font-medium ${dark ? "text-white/80" : "text-foreground/80"}`}>{t.label}</span>
          </button>
        ))}
      </div>

      {/* or start from */}
      <div className={`mt-8 flex items-center justify-center gap-2 flex-wrap text-[12.5px] ${dark ? "text-white/55" : "text-muted-foreground"}`}>
        <span>or start from</span>
        <button
          type="button"
          onClick={() => setText("Build an app from this Figma design: ")}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${dark ? "border-white/15 bg-white/5 text-white/80 hover:bg-white/10" : "border-border bg-card text-foreground hover:bg-accent"}`}
        >
          <Figma className="h-3.5 w-3.5" />Figma
        </button>
        <button
          type="button"
          onClick={() => setText("Build an app based on this GitHub repo: ")}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${dark ? "border-white/15 bg-white/5 text-white/80 hover:bg-white/10" : "border-border bg-card text-foreground hover:bg-accent"}`}
        >
          <Github className="h-3.5 w-3.5" />GitHub
        </button>
        <button
          type="button"
          onClick={() => navigate("/marketplace")}
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${dark ? "border-white/15 bg-white/5 text-white/80 hover:bg-white/10" : "border-border bg-card text-foreground hover:bg-accent"}`}
        >
          <FileText className="h-3.5 w-3.5" />Team template
        </button>
      </div>
    </div>
  );
}