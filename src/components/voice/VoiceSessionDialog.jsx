import React from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Mic, MicOff, Video, Monitor, PhoneOff, AlertCircle } from "lucide-react";
import useVoiceSession from "@/hooks/useVoiceSession";

// Superagent Voice Mode — `Use voice` in the composer opens a live, session-scoped voice
// call: tap-to-talk turns (recording → transcription → conversational reply → spoken answer),
// optional camera / desktop screen sharing as visual context for the current turn.
// Nothing is recorded or stored: media lives only inside the session and stops on End call.
const STATUS_LABEL = { connecting: "Connecting…", ready: "Listening for your turn…", recording: "Recording…", thinking: "Thinking…", speaking: "Speaking…" };

export default function VoiceSessionDialog({ open, onClose, agentName, dark }) {
  const v = useVoiceSession({ agentName });
  const [started, setStarted] = React.useState(false);

  React.useEffect(() => {
    if (open && !started) { setStarted(true); v.start(); }
    if (!open && started) { setStarted(false); v.stop(); }
  }, [open, started, v]);

  if (!open) return null;
  const darkCls = dark ?? true;

  const shareBtn = (kind, Icon, label) => (
    <button
      type="button"
      onClick={() => v.toggleShare(kind)}
      title={v.sharing[kind] ? `Stop ${label}` : `Share ${label}`}
      aria-label={v.sharing[kind] ? `Stop ${label}` : `Share ${label}`}
      className={`grid h-10 w-10 place-items-center rounded-full border transition-colors ${
        v.sharing[kind]
          ? "border-[#60a5fa]/60 bg-[#2563eb]/20 text-[#60a5fa]"
          : "border-white/12 text-white/70 hover:bg-white/5 hover:text-white"
      } ${v.supported[kind === "screen" ? "screen" : "camera"] ? "" : "opacity-40"}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={`max-w-sm rounded-2xl ${darkCls ? "border-white/10 bg-neutral-900 text-white" : "bg-card"}`}>
        <div className="text-center">
          <p className="text-[13px] font-medium">Voice call with {agentName || "your assistant"}</p>
          <p className="mt-0.5 text-[11.5px] text-white/50">{STATUS_LABEL[v.status] || "Ready"}</p>
        </div>

        {/* Live camera / screen preview — session-scoped, nothing recorded */}
        <div className="relative mt-3 overflow-hidden rounded-xl border border-white/10 bg-black/40" style={{ aspectRatio: "16/9" }}>
          <video ref={v.videoElRef} muted playsInline autoPlay className="h-full w-full object-cover" />
          {!v.sharing.camera && !v.sharing.screen && (
            <div className="absolute inset-0 grid place-items-center text-[11.5px] text-white/35">Camera / screen off</div>
          )}
        </div>

        {/* Last turn (memory only — never persisted) */}
        {(v.transcript || v.reply) && (
          <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left">
            {v.transcript && <p className="text-[11.5px] text-white/55">You: {v.transcript}</p>}
            {v.reply && <p className="mt-1 text-[12px] text-white/85">{v.reply}</p>}
          </div>
        )}

        {v.error && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-left text-[12px] text-red-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{v.error}</span>
          </div>
        )}

        <div className="mt-4 flex items-center justify-center gap-3">
          {shareBtn("camera", Video, "camera")}
          {/* Tap-to-talk: one tap records, second sends the turn; auto-send at 30s */}
          <button
            type="button"
            onClick={v.toggleTurn}
            disabled={v.status === "connecting" || v.status === "thinking" || v.status === "speaking"}
            aria-label={v.status === "recording" ? "Send turn" : "Speak"}
            className={`grid h-14 w-14 place-items-center rounded-full transition-colors disabled:opacity-50 ${
              v.status === "recording" ? "bg-destructive text-white animate-pulse" : "bg-[#2563eb] text-white hover:bg-[#3b82f6]"
            }`}
          >
            {v.status === "thinking" || v.status === "speaking" || v.status === "connecting"
              ? <Loader2 className="h-5 w-5 animate-spin" />
              : v.status === "recording" ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          {shareBtn("screen", Monitor, "your screen")}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onClose}
          className="mx-auto mt-3 gap-1.5 border-white/15 bg-transparent text-white/80 hover:bg-white/5 hover:text-white"
        >
          <PhoneOff className="h-3.5 w-3.5" />End call
        </Button>
        <p className="mt-1.5 text-center text-[10.5px] text-white/35">Recordings are not stored. Camera and screen sharing end with the call.</p>
      </DialogContent>
    </Dialog>
  );
}