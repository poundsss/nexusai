import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

// Voice Mode hook (Superagent): ONE turn-based duplex voice session, session-scoped.
// Recording → UploadPrivateFile (temp) → CreateFileSignedUrl (expiring) → voiceSession
// (ASR + conversational reply + TTS) → playback. NOTHING is persisted: no transcript,
// no recording URI, no frame is written to any entity; the signed URL expires on its own.
// Camera/screen sharing is interactive and session-scoped: the CURRENT frame rides along
// on each spoken turn (no recording, no storage). Fail-closed on unsupported devices,
// denied permissions, and server/unavailable voice infrastructure.
const MAX_TURN_MS = 30000;

export default function useVoiceSession({ agentName = null } = {}) {
  const [status, setStatus] = useState("idle"); // idle | connecting | ready | recording | thinking | speaking
  const [error, setError] = useState(null);
  const [sharing, setSharing] = useState({ camera: false, screen: false });
  const [transcript, setTranscript] = useState(null); // last turn's transcript (memory only)
  const [reply, setReply] = useState(null);

  const micStreamRef = useRef(null);
  const shareStreamRef = useRef(null);
  const videoElRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const turnTimerRef = useRef(null);
  const audioRef = useRef(null);

  const cap = typeof navigator !== "undefined" ? navigator.mediaDevices || {} : {};
  const [supported] = useState(() => ({
    mic: !!cap.getUserMedia && typeof window !== "undefined" && !!window.MediaRecorder,
    camera: !!cap.getUserMedia,
    screen: !!cap.getDisplayMedia,
  }));

  const failClosed = useCallback((msg) => { setError(msg); return false; }, []);

  const attachPreview = useCallback((stream) => {
    if (videoElRef.current) {
      videoElRef.current.srcObject = stream;
      videoElRef.current.play?.().catch(() => {});
    }
  }, []);

  // --- Session lifecycle ------------------------------------------------------
  const start = useCallback(async () => {
    setError(null);
    if (!supported.mic) return failClosed("Voice is not supported on this device or browser.");
    setStatus("connecting");
    try {
      micStreamRef.current = await cap.getUserMedia({ audio: true });
    } catch {
      setStatus("idle");
      return failClosed("Microphone permission denied — voice mode stays off.");
    }
    setStatus("ready");
    return true;
  }, [cap, supported, failClosed]);

  const cleanup = useCallback(() => {
    if (turnTimerRef.current) { clearTimeout(turnTimerRef.current); turnTimerRef.current = null; }
    try { recorderRef.current?.state !== "inactive" && recorderRef.current?.stop(); } catch {}
    recorderRef.current = null;
    chunksRef.current = [];
    for (const ref of [micStreamRef, shareStreamRef]) {
      const s = ref.current;
      if (s) { for (const t of s.getTracks?.() || []) try { t.stop(); } catch {} ref.current = null; }
    }
    setSharing({ camera: false, screen: false });
    if (audioRef.current) { try { audioRef.current.pause(); } catch {} audioRef.current = null; }
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setTranscript(null);
    setReply(null);
    setStatus("idle");
  }, [cleanup]);
  useEffect(() => stop, [stop]); // unmount / dialog close = session cleanup

  // --- Camera / screen sharing (interactive, session-scoped, never recorded) ----
  const toggleShare = useCallback(async (kind) => {
    setError(null);
    if (sharing[kind]) {
      const s = shareStreamRef.current;
      if (s) { for (const t of s.getTracks?.() || []) try { t.stop(); } catch {} }
      shareStreamRef.current = null;
      setSharing((st) => ({ ...st, [kind]: false }));
      return true;
    }
    if (kind === "screen" && !supported.screen) return failClosed("Screen sharing is not supported on this device or browser.");
    if (!supported.camera) return failClosed("Camera sharing is not supported on this device or browser.");
    try {
      const stream = kind === "screen"
        ? await cap.getDisplayMedia({ video: true })
        : await cap.getUserMedia({ video: true });
      const videoTrack = stream.getVideoTracks?.()[0];
      if (videoTrack) videoTrack.onended = () => toggleShare(kind); // user pressed the browser's "Stop sharing"
      shareStreamRef.current = stream;
      attachPreview(stream);
      setSharing((st) => ({ ...st, [kind]: true }));
      return true;
    } catch {
      return failClosed(kind === "screen" ? "Screen sharing was not permitted." : "Camera was not permitted.");
    }
  }, [cap, supported, sharing, attachPreview, failClosed]);

  // --- One voice turn ---------------------------------------------------------
  const uploadTemp = async (blob, name, type) => {
    const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file: new File([blob], name, { type }) });
    const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: 300 });
    return signed_url;
  };

  const captureFrame = async () => {
    const v = videoElRef.current;
    if (!v || !v.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(v.videoWidth, 1280);
    canvas.height = Math.round(canvas.width * (v.videoHeight / v.videoWidth));
    canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7));
  };

  const finishTurn = useCallback(async () => {
    const recorder = recorderRef.current;
    const blob = await new Promise((resolve) => {
      recorder.onstop = () => { resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" })); };
      try { recorder.stop(); } catch { resolve(null); }
    });
    recorderRef.current = null;
    chunksRef.current = [];
    if (turnTimerRef.current) { clearTimeout(turnTimerRef.current); turnTimerRef.current = null; }
    if (!blob || blob.size === 0) { setStatus("ready"); return; }
    setStatus("thinking");
    try {
      const audioUrl = await uploadTemp(blob, "voice-turn.webm", blob.type || "audio/webm");
      let frameUrl = null;
      if (shareStreamRef.current) {
        const frame = await captureFrame();
        if (frame) frameUrl = await uploadTemp(frame, "voice-frame.jpg", "image/jpeg");
      }
      const res = await base44.functions.invoke("voiceSession", {
        action: "turn", audio_url: audioUrl, frame_url: frameUrl, agent_name: agentName,
      });
      const out = res.data || {};
      if (!String(out.transcript || "").trim()) {
        setError("No speech was detected — try the turn again.");
      } else {
        setTranscript(out.transcript);
        setReply(out.reply);
        if (out.audio_url) {
          setStatus("speaking");
          await new Promise((resolve) => {
            const a = new Audio(out.audio_url);
            audioRef.current = a;
            a.onended = resolve;
            a.onerror = resolve;
            a.play().catch(resolve);
          });
        }
      }
    } catch (e) {
      setError(e.response?.data?.error || e.message || "The voice turn failed.");
    } finally {
      setStatus("ready");
    }
  }, [agentName]);

  const toggleTurn = useCallback(() => {
    setError(null);
    if (status === "recording") { finishTurn(); return; }
    if (status !== "ready") return;
    const stream = micStreamRef.current;
    if (!stream) { setError("The voice session is not active."); return; }
    try {
      const rec = new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      rec.start();
      setStatus("recording");
      turnTimerRef.current = setTimeout(() => { if (recorderRef.current === rec) finishTurn(); }, MAX_TURN_MS);
    } catch {
      setError("Recording could not start on this device.");
    }
  }, [status, finishTurn]);

  const busy = status === "connecting" || status === "thinking" || status === "speaking";
  return {
    supported, status, busy, error, sharing, transcript, reply,
    videoElRef, start, stop, toggleShare, toggleTurn,
  };
}