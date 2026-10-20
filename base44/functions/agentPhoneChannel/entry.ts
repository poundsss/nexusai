// P-9.13P — the Phone channel lifecycle, FAIL-CLOSED at the transport.
//
// The confirmed channel capability (docs.base44.com: "give it its own phone number for calls")
// has NO provider/transport contract in this runtime: Base44 publishes no telephony provider
// contract, GenerateSpeech is media-only TTS with no phone transport, and no telephony
// connector exists. The connection and message lifecycle therefore refuse with the EXACT
// documented blocker instead of fabricating a provider — no fake number provisioning, no fake
// call relay, no invented billing. The in-Agent Voice Mode (voiceSession) is a DIFFERENT,
// already-certified capability and is untouched by this file.
//
// Actions: status | connect | message. `status` answers with the blocker as data (the UI's
// single source of truth); connect/message are 501 refusals — the lifecycle shell that exists
// precisely so the blocker is machine-checkable.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { PHONE_CHANNEL_BLOCKER, PHONE_TRANSPORT_UNAVAILABLE_CODE } from "../../shared/agentChannelGaps.ts";
import { TELEPHONY_CONTRACT } from "../../shared/telephonyBoundary.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (action === "status") {
      return Response.json({ channel: "phone", available: false, blocker: PHONE_CHANNEL_BLOCKER, code: PHONE_TRANSPORT_UNAVAILABLE_CODE, adapter: TELEPHONY_CONTRACT });
    }
    if (action !== "connect" && action !== "message") {
      return Response.json({ error: 'Unsupported action — use "status", "connect" or "message"', code: "INVALID_ACTION" }, { status: 400 });
    }
    return Response.json({ error: PHONE_CHANNEL_BLOCKER, code: PHONE_TRANSPORT_UNAVAILABLE_CODE }, { status: 501 });
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}