// Speaks a Superagent voice sample through the platform TTS (GenerateSpeech). Core media
// integrations run server-side only; the client calls this narrow endpoint instead.
// Bounded input: a whitelisted voice id and the agent's display name only — the sample
// sentence is fixed here, never taken from the caller.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";

const VOICES = ["river", "honey", "sunny", "storm", "spark"];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const voice = VOICES.includes(body.voice) ? body.voice : "river";
    const agentName = String(body.agent_name || "the agent").replace(/[\r\n]/g, " ").slice(0, 60);

    const res = await base44.asServiceRole.integrations.Core.GenerateSpeech({
      text: `Hi, I am ${agentName}. Here is how I sound.`,
      voice,
    });
    return Response.json({ url: res.url });
  } catch (error) {
    return Response.json({ error: error.message, code: error.code || null }, { status: error.status || 500 });
  }
}