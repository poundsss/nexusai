import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Send, Loader2, AlertCircle, ChevronDown, ChevronRight, Sparkles, Paperclip, MousePointerClick, Mic } from "lucide-react";
import AttachmentStrip from "@/components/attachments/AttachmentStrip";
import AttachButton from "@/components/attachments/AttachButton";
import useAttachments from "@/hooks/useAttachments";
import ChatMessage from "./ChatMessage";
import RunActivity from "./RunActivity";
import AgentActivity from "./AgentActivity";
import ModelSelector from "./ModelSelector";
import CompareModal from "./CompareModal";
import BuilderMoreMenu from "./BuilderMoreMenu";
import CustomInstructionsDialog from "./CustomInstructionsDialog";
import FreezeFilesDialog from "./FreezeFilesDialog";
import AutoTextarea from "./AutoTextarea";
import { derivePages } from "./pageRoutes";
import useDictation from "@/hooks/useDictation";
import { toast } from "@/components/ui/use-toast";

const MODES = [
  { id: "default", label: "Build", hint: "The AI modifies the project" },
  { id: "discuss", label: "Discuss", hint: "Plan and explain — no file changes" },
  { id: "agent", label: "Agent", hint: "Give a high-level goal — the agent works autonomously" },
];

// Contextual suggestions recomputed from the project's REAL state (pages, auth presence)
// plus the latest user turn, so the chips stay relevant as the conversation and the app
// evolve. Pure derivation — no backend round-trip — so they refresh on every render.
function deriveSuggestions(files, messages) {
  const pages = derivePages(files || []);
  const paths = (files || []).map((f) => f.path || "");
  const hasAuth = paths.some((p) => /login|register|auth|signin|sign-up|signup/i.test(p));
  const hasSettings = paths.some((p) => /settings/i.test(p));
  const lastUser = [...(messages || [])].reverse().find((m) => m.role === "user");
  const lastText = (lastUser?.content || "").trim();
  const seen = new Set();
  const out = [];
  const push = (s) => { if (s && !seen.has(s)) { seen.add(s); out.push(s); } };

  // Next-step follow-ups tied to the most recent request, when there is one.
  if (lastText) {
    const short = lastText.length > 46 ? lastText.slice(0, 46).trimEnd() + "…" : lastText;
    push(`Refine: ${short}`);
    push("Run a build to verify this change");
  }
  // Gaps detectable from the file tree.
  if (!pages.length) push("Create the first page");
  if (!hasAuth) push("Add login and signup");
  if (!hasSettings) push("Add a settings page");
  // Per-page polish, drawn from the actual pages that exist.
  pages.slice(0, 2).forEach((p) => push(`Make the ${p.route || p.file} page mobile-friendly`));
  push("Add a search bar to filter records");
  return out.slice(0, 6);
}

export default function ChatPane({ messages, runs, liveRun, sending, pendingPrompt, onSend, onOpenFile, selectedFile, agent, models, modelId, onModelChange, credits, draft, onDraftApplied, onRevertRun, revertingRunId, selectedElement, onClearElement, autoApprove = false, onToggleAutoApprove, customInstructions = "", onSaveCustomInstructions, onBranch = false, files = [], onFreezeFilesSaved, onCompareModels, compareRunA, compareRunB, comparing = false, designSystemId = null, designSystemName = null, projectId = null, onDesignSystemChange }) {
  const [mode, setMode] = useState("default");
  const [modeOpen, setModeOpen] = useState(false);
  const [text, setText] = useState("");
  const [ciOpen, setCiOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const suggRef = useRef(null);
  const bottomRef = useRef(null);
  const modeRef = useRef(null);
  // Reference images for this prompt, through the SHARED attachment pipeline (picker, paste, drop).
  const attachments = useAttachments();
  // Browser-native speech recognition (Web Speech API). Transcribed text is fed into the
  // existing `text` composer state; the existing submit()/onSend/aiRun path is reused.
  const dictation = useDictation({ onText: setText });
  const runById = Object.fromEntries(runs.map((r) => [r.id, r]));
  const balance = credits?.balance;
  const lowCredits = typeof balance === "number" && balance < 100;
  const noCredits = typeof balance === "number" && balance <= 0;
  const currentMode = MODES.find((m) => m.id === mode);
  // Refresh as the app context (files) and the conversation (messages) change.
  const suggestions = useMemo(() => deriveSuggestions(files, messages), [files, messages]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, liveRun?.steps?.length, pendingPrompt]);

  useEffect(() => {
    if (!modeOpen) return;
    const handler = (e) => { if (modeRef.current && !modeRef.current.contains(e.target)) setModeOpen(false); };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [modeOpen]);

  // Microphone/recognition errors surface as toasts using the existing UI pattern.
  useEffect(() => {
    if (!dictation.error) return;
    const code = dictation.error;
    const msg =
      code === "not-allowed" || code === "service-not-allowed"
        ? "Microphone access was denied. Enable it in your browser settings to dictate."
        : code === "audio-capture"
        ? "No microphone found. Connect one to dictate."
        : code === "no-speech"
        ? null
        : "Voice input stopped unexpectedly. Try again.";
    if (msg) toast({ title: "Dictation error", description: msg });
  }, [dictation.error]);

  // A pre-seeded prompt (e.g. "Fix with AI" from the SEO checklist) fills the composer for
  // the user to review and send themselves — it NEVER auto-submits.
  useEffect(() => {
    if (!draft) return;
    setText(draft);
    onDraftApplied?.();
  }, [draft]);

  const submit = () => {
    dictation.stop();
    const t = text.trim();
    if (!t || sending || (mode === "agent" && (agent?.active || agent?.starting))) return;
    if (noCredits && mode !== "discuss") return;
    if (attachments.uploading) return;
    const imageUrls = attachments.urls;
    setText("");
    attachments.clear();
    onSend(t, mode, imageUrls);
  };

  // "Edit Element" — the documented visual-edit entry. Uses the EXISTING mode:"edit" enqueue
  // path; the element descriptor + page file are folded into the prompt by the Builder. The
  // composer's current text is the instruction (a sensible default if empty).
  const editElement = () => {
    if (sending || noCredits || attachments.uploading) return;
    dictation.stop();
    const t = text.trim() || "Adjust this selected element";
    const imageUrls = attachments.urls;
    setText("");
    attachments.clear();
    onSend(t, "edit", imageUrls);
  };

  // Compare: run the current prompt under two models. The prompt comes from the composer;
  // the Compare modal only collects the two model picks, then hands off to the Builder.
  const handleCompareSelect = (a, b) => {
    dictation.stop();
    const t = text.trim();
    if (!t) { toast({ variant: "destructive", title: "Enter a prompt first", description: "Type what you want to build, then compare models." }); return; }
    if (attachments.uploading) return;
    const imageUrls = attachments.urls;
    setText("");
    attachments.clear();
    setCompareOpen(false);
    onCompareModels?.(a, b, t, imageUrls);
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Messages — the panel opens straight into the conversation; project identity
          lives in the Builder's own top bar. */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-4">
        {messages.length === 0 && !pendingPrompt && (
          <div className="pt-2">
            <h2 className="text-[17px] font-semibold tracking-tight text-foreground">What would you like to change?</h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
              Each request is planned, applied to the files, built, and saved as a version you can restore.
            </p>
          </div>
        )}
        {messages.map((m) => <ChatMessage key={m.id} message={m} run={m.run_id ? runById[m.run_id] : null} onOpenFile={onOpenFile} onRevertRun={onRevertRun} revertingId={revertingRunId} />)}
        {pendingPrompt && <ChatMessage message={{ role: "user", content: pendingPrompt }} />}
        {sending && <RunActivity run={liveRun || { status: "QUEUED", steps: [] }} />}
        {(compareRunA || compareRunB) && (
          <div className="space-y-2">
            {compareRunA && (
              <div>
                <div className="text-[11px] font-medium text-muted-foreground mb-1">Model A</div>
                <RunActivity run={compareRunA} />
              </div>
            )}
            {compareRunB && (
              <div>
                <div className="text-[11px] font-medium text-muted-foreground mb-1">Model B</div>
                <RunActivity run={compareRunB} />
              </div>
            )}
          </div>
        )}
        {agent?.run && <AgentActivity run={agent.run} steps={agent.steps} onCancel={agent.cancel} />}
        <div ref={bottomRef} />
      </div>

      {/* Suggestions sit directly above the composer — a single scrollable row that
          recomputes from the project's pages + the latest user turn as context evolves. */}
      <div className="shrink-0 px-3 pt-0.5 pb-1">
        <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground/80">
          <Sparkles className="h-3 w-3" />Suggestions
        </p>
        <div className="relative flex items-center">
          <div ref={suggRef} className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar fade-right pr-16">
            {suggestions.map((ex) => (
              <button
                key={ex}
                onClick={() => setText(ex)}
                className="shrink-0 rounded-full border border-border bg-card px-2.5 py-1.5 text-left text-[11.5px] text-muted-foreground hover:border-foreground/25 hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
          <button
            onClick={() => suggRef.current?.scrollBy({ left: 220, behavior: "smooth" })}
            aria-label="Scroll suggestions"
            title="More suggestions"
            className="absolute right-0 top-1/2 -translate-y-1/2 grid place-items-center h-7 w-7 text-foreground/80 hover:text-foreground transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Composer */}
      <div className="shrink-0 px-3 pt-1 pb-3">
        {noCredits && mode !== "discuss" && (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11.5px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">No credits remaining.</span>
            <Link to="/billing" className="font-medium underline underline-offset-2 hover:opacity-80">Add credits</Link>
          </div>
        )}
        {lowCredits && !noCredits && mode !== "discuss" && (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11.5px] text-amber-600 dark:text-amber-400">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">Low on credits ({balance.toLocaleString()} remaining).</span>
            <Link to="/billing" className="font-medium underline underline-offset-2 hover:opacity-80">Add credits</Link>
          </div>
        )}
        {selectedElement && (
          <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-indigo-500/40 bg-indigo-500/5 px-2.5 py-1.5 text-[11.5px]">
            <MousePointerClick className="h-3.5 w-3.5 text-indigo-500 shrink-0" />
            <span className="flex-1 min-w-0 truncate text-foreground">
              Selected <span className="font-mono">&lt;{selectedElement.tag}&gt;</span>
              {selectedElement.text ? <span className="text-muted-foreground"> — {selectedElement.text.slice(0, 60)}</span> : null}
            </span>
            <button onClick={editElement} disabled={sending || noCredits} className="rounded-md bg-foreground text-background px-2 py-1 text-[11px] font-medium hover:opacity-90 disabled:opacity-50 shrink-0">Edit Element</button>
            <button onClick={onClearElement} aria-label="Clear selection" className="text-muted-foreground hover:text-foreground shrink-0">✕</button>
          </div>
        )}
        {mode === "agent" && <div className="mb-1.5 px-1 text-[11px] text-muted-foreground">{agent?.active ? "An agent is already running." : "Give a goal; the agent works in the background."}</div>}

        {/* The paste handler sits on the composer box AND the textarea: Cmd+V / Ctrl+V works
            whether focus is in the textarea or anywhere else inside the composer. */}
        <div
          onPaste={attachments.onPaste}
          {...attachments.dropZoneProps}
          className={`relative rounded-2xl border bg-card shadow-sm oled-border focus-within:shadow-md transition-all ${attachments.dragging ? "border-foreground/40 bg-accent/40" : "border-border"}`}
        >
          {attachments.dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-2xl border border-dashed border-foreground/30 bg-background/70 text-[12px] font-medium text-foreground/70">
              <span className="flex items-center gap-2"><Paperclip className="h-3.5 w-3.5" />Drop an image to attach</span>
            </div>
          )}
          <AutoTextarea
            value={text}
            onChange={setText}
            onPaste={attachments.onPaste}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={mode === "discuss" ? "Ask about architecture, tradeoffs, next steps…" : mode === "agent" ? "Turn this into a better dashboard…" : "Describe what to build or change…"}
          />
          <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
            <AttachButton bare onFiles={attachments.add} className="text-foreground" />
            {mode !== "agent" && models?.length > 0 && (
              <ModelSelector models={models} value={modelId} onChange={onModelChange} disabled={sending || !credits?.modelSelection?.allowed} onCompare={() => setCompareOpen(true)} />
            )}
            <div ref={modeRef} className="relative">
              <button
                onClick={() => setModeOpen(!modeOpen)}
                className="flex items-center gap-1 h-8 min-w-[68px] justify-between rounded-lg border border-border bg-background px-2 text-[12px] font-medium text-foreground hover:border-foreground/30 transition-colors"
              >
                {currentMode.label}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {modeOpen && (
                <div className="absolute right-0 bottom-full mb-1.5 z-20 w-60 rounded-xl border border-border bg-popover p-1 shadow-lg">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { setMode(m.id); setModeOpen(false); }}
                      className={`flex flex-col w-full rounded-lg px-2.5 py-1.5 text-left transition-colors ${mode === m.id ? "bg-accent" : "hover:bg-muted"}`}
                    >
                      <span className="text-[12px] font-medium">{m.label}</span>
                      <span className="text-[10.5px] text-muted-foreground">{m.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <BuilderMoreMenu
              onFreezeFiles={() => setFreezeOpen(true)}
              autoApprove={autoApprove}
              onToggleAutoApprove={onToggleAutoApprove}
              onCustomInstructions={() => setCiOpen(true)}
              onBranch={onBranch}
            />
            {dictation.supported && (
              <button
                type="button"
                onClick={() => (dictation.listening ? dictation.stop() : dictation.start(text))}
                title={dictation.listening ? "Stop dictation" : "Dictate"}
                aria-label={dictation.listening ? "Stop dictation" : "Dictate"}
                aria-pressed={dictation.listening}
                className={`grid place-items-center h-7 w-7 rounded-lg transition-colors ${
                  dictation.listening
                    ? "bg-destructive text-destructive-foreground animate-pulse"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/60"
                }`}
              >
                <Mic className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={submit}
              disabled={sending || comparing || !text.trim() || attachments.uploading || (noCredits && mode !== "discuss")}
              className="h-8 w-8 grid place-items-center rounded-xl bg-black text-white disabled:opacity-25 hover:opacity-90 transition-opacity shrink-0"
              aria-label="Send prompt"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
      <CustomInstructionsDialog
        open={ciOpen}
        initialValue={customInstructions || ""}
        onClose={() => setCiOpen(false)}
        onSave={(text) => { onSaveCustomInstructions?.(text); setCiOpen(false); }}
      />
      <FreezeFilesDialog
        open={freezeOpen}
        files={files}
        onClose={() => setFreezeOpen(false)}
        onSaved={onFreezeFilesSaved}
      />
      <CompareModal
        open={compareOpen}
        models={models || []}
        onClose={() => setCompareOpen(false)}
        onSelect={handleCompareSelect}
      />
    </div>
  );
}