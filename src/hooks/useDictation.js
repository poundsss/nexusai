import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";

// Dictation for every composer, over EXISTING contracts only. TWO paths:
//   1. Browser speech recognition (Web Speech API) — the primary path, unchanged.
//   2. Server fallback (used whenever the browser has no Web Speech API): MediaRecorder
//      captures the audio, Core.UploadPrivateFile stores it privately (no public URL),
//      a short-lived signed URL (Core.CreateFileSignedUrl, expires_in: 300) is passed to
//      the transcribeDictation backend function, which transcribes it through the
//      platform's TranscribeAudio (Whisper) integration. No third-party provider is
//      invented. The signed URL is never persisted, logged or shared.
// The hook produces transcript text and hands it to the composer's existing setText —
// it owns no submission path.

const SpeechRecognitionCtor = () =>
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

function joinText(base, add) {
  const b = String(base || "");
  const a = String(add || "").replace(/^\s+/, ""); // interim transcripts often lead with a space
  if (!a) return b;
  if (!b.trim()) return a;
  return (b.endsWith(" ") ? b : b + " ") + a;
}

export default function useDictation({ onText } = {}) {
  const [supported] = useState(() => !!SpeechRecognitionCtor() ||
    (typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia));
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState(null);
  const recRef = useRef(null); // SpeechRecognition instance OR MediaRecorder
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const baseRef = useRef("");
  const cancelledRef = useRef(false); // stop() while transcribing discards the result
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const stop = useCallback(() => {
    if (transcribing) { cancelledRef.current = true; setTranscribing(false); return; }
    const r = recRef.current;
    recRef.current = null;
    if (!r) return;
    try { r.stop(); } catch {}
    setListening(false);
  }, [transcribing]);

  // The server fallback: record → upload → transcribe → hand the final text to the composer.
  const startFallback = useCallback(async (currentText) => {
    baseRef.current = String(currentText || "");
    chunksRef.current = [];
    cancelledRef.current = false;
    setError(null);
    let recorder;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        cleanupStream();
        recRef.current = null;
        setListening(false);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (cancelledRef.current) return;
        if (blob.size < 1000) { setError("no-speech"); return; }
        setTranscribing(true);
        try {
          const file = new File([blob], "dictation.webm", { type: blob.type || "audio/webm" });
          const { file_uri } = await base44.integrations.Core.UploadPrivateFile({ file });
          const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri, expires_in: 300 });
          const res = await base44.functions.invoke("transcribeDictation", { audio_url: signed_url });
          if (cancelledRef.current) return;
          const text = res.data?.text || "";
          if (!text.trim()) { setError("no-speech"); onTextRef.current?.(baseRef.current); return; }
          onTextRef.current?.(joinText(baseRef.current, text));
        } catch {
          setError("transcription-failed");
        } finally {
          setTranscribing(false);
        }
      };
      recRef.current = recorder;
      recorder.start();
      setListening(true);
    } catch (ev) {
      cleanupStream();
      recRef.current = null;
      setListening(false);
      setError(ev?.name === "NotAllowedError" || ev?.name === "PermissionDeniedError" ? "not-allowed" : "start-failed");
    }
  }, []);

  const start = useCallback((currentText = "") => {
    const S = SpeechRecognitionCtor();
    if (!S) { startFallback(currentText); return; }
    const r = new S();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true;
    baseRef.current = String(currentText || "");
    setError(null);
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          baseRef.current = joinText(baseRef.current, res[0].transcript);
        } else {
          interim += res[0].transcript;
        }
      }
      onTextRef.current?.(joinText(baseRef.current, interim));
    };
    r.onerror = (ev) => {
      setError(ev.error || "unknown");
      recRef.current = null;
      setListening(false);
      onTextRef.current?.(baseRef.current); // drop interim on error
    };
    r.onend = () => {
      recRef.current = null;
      setListening(false);
      onTextRef.current?.(baseRef.current); // commit finals, drop interim
    };
    recRef.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setError("start-failed");
      recRef.current = null;
      setListening(false);
    }
  }, [startFallback]);

  useEffect(() => () => {
    const r = recRef.current; if (r) { try { r.stop(); } catch {} }
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  return { supported, listening, transcribing, error, start, stop };
}