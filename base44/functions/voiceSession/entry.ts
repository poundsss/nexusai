// Voice Mode (Superagent) — the single new NexusAI-native voice boundary.
//
// EXPLICITLY DOCUMENTED BOUNDARY: this is a TURN-BASED duplex voice session, not a streaming
// realtime audio transport. One turn = mic recording → private temp upload → signed URL →
// Core TranscribeAudio (ASR) → one Core InvokeLLM conversational reply (optionally with the
// current camera/screen frame attached as vision context) → Core GenerateSpeech (TTS) → the
// client plays the MP3. No provider, codec or transport is claimed beyond the platform's OWN
// certified Core media integrations; the certified ActorRelay is NOT used or modified (it
// remains downstream-only — no client audio ever traverses it).
//
// Fail-closed and session-scoped by contract:
//   • requires an authenticated user (401 otherwise);
//   • voice goal-setting is NOT supported: the reply is constrained to a conversational
//     answer only — the prompt explicitly forbids tools, goals and execution;
//   • NOTHING is persisted: no entity write, no transcript record, no recording URI, no
//     frame record. The temp private upload is referenced only by an expiring signed URL.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";

const VOICES = ["river", "honey", "sunny", "storm", "spark"];
const MAX_URL_CHARS = 2048;
const MAX_TRANSCRIPT_CHARS = 2000;
const MAX_REPLY_CHARS = 2000;
const MAX_SPEAK_CHARS = 2000;

const isHttpsUrl = (v) => typeof v === "string" && v.startsWith("https://") && v.length <= MAX_URL_CHARS;

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const voice = VOICES.includes(body.voice) ? body.voice : "river";
    const agentName = String(body.agent_name || "the agent").replace(/[\r\n]/g, " ").slice(0, 60);

    if (action === "turn") {
      const audioUrl = body.audio_url;
      if (!isHttpsUrl(audioUrl)) {
        return Response.json({ error: "audio_url is required (an expiring signed URL of the private temp recording)", code: "INVALID_INPUT" }, { status: 400 });
      }
      let frameUrls = [];
      if (body.frame_url != null && body.frame_url !== "") {
        if (!isHttpsUrl(body.frame_url)) {
          return Response.json({ error: "frame_url must be an expiring signed URL", code: "INVALID_INPUT" }, { status: 400 });
        }
        frameUrls = [body.frame_url];
      }

      // ASR — the platform's certified Whisper integration (server-side; its own 25MB/format limits apply).
      let transcript = "";
      try {
        transcript = String(await base44.asServiceRole.integrations.Core.TranscribeAudio({ audio_url: audioUrl }) || "").slice(0, MAX_TRANSCRIPT_CHARS);
      } catch {
        return Response.json({ error: "Transcription is unavailable right now", code: "ASR_UNAVAILABLE" }, { status: 502 });
      }
      if (!transcript.trim()) {
        return Response.json({ transcript: "", reply: "", audio_url: null, code: "EMPTY_TRANSCRIPT" });
      }

      // One conversational LLM reply. Voice goal-setting is explicitly NOT supported: the
      // prompt forbids tools, goals, data mutations and execution — answer only.
      let reply = "";
      try {
        const frameBlock = frameUrls.length
          ? " The user is currently sharing a live view (camera or desktop screen); the attached image is its current frame — use it as visual context for your answer."
          : "";
        reply = String(await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt:
            `You are ${agentName}, an assistant in a live VOICE conversation. A spoken turn was transcribed. ` +
            `Answer ONLY conversationally, as short natural spoken language (1-4 sentences), no markdown, no lists. ` +
            `Do NOT use tools, do NOT set or execute goals, do NOT modify data, do NOT take actions — you cannot act in voice mode.${frameBlock} ` +
            `The user's spoken turn: "${transcript}"`,
          file_urls: frameUrls.length ? frameUrls : undefined,
        }) || "").slice(0, MAX_REPLY_CHARS);
      } catch {
        return Response.json({ error: "The assistant is unavailable right now", code: "LLM_UNAVAILABLE" }, { status: 502 });
      }

      // TTS — best-effort: the text reply is always returned; audio may be absent.
      let audioUrlOut = null;
      try {
        const t = await base44.asServiceRole.integrations.Core.GenerateSpeech({ text: reply.slice(0, 4000), voice });
        audioUrlOut = t?.url || null;
      } catch {
        audioUrlOut = null;
      }
      return Response.json({ transcript, reply, audio_url: audioUrlOut });
    }

    if (action === "speak") {
      const text = String(body.text || "").slice(0, MAX_SPEAK_CHARS);
      if (!text.trim()) {
        return Response.json({ error: "text is required", code: "INVALID_INPUT" }, { status: 400 });
      }
      const res = await base44.asServiceRole.integrations.Core.GenerateSpeech({ text, voice });
      return Response.json({ url: res?.url || null });
    }

    return Response.json({ error: `Unsupported action "${action}"`, code: "INVALID_ACTION" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}