// Grow dictation — the server transcription fallback, over EXISTING platform contracts.
// The composer records audio in the browser (MediaRecorder) and uploads it with the platform's
// Core.UploadPublicFile; this function runs the platform's Core.TranscribeAudio (Whisper)
// integration on the uploaded URL and returns ONLY the transcript text. No third-party provider
// is invented and no transcript is stored.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const audio_url = String(body.audio_url || "");
    if (!/^https:\/\/\S+$/.test(audio_url)) {
      return Response.json({ error: "audio_url must be an https URL of an uploaded audio file", code: "INVALID_INPUT" }, { status: 400 });
    }
    const result = await base44.asServiceRole.integrations.Core.TranscribeAudio({ audio_url });
    const text = String(result || "").trim();
    if (!text) return Response.json({ error: "No speech was detected in the recording", code: "EMPTY_TRANSCRIPT" }, { status: 422 });
    return Response.json({ text });
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 300), code: "TRANSCRIPTION_FAILED" }, { status: 502 });
  }
}