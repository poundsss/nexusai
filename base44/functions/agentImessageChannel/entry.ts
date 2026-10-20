// P-9.13I — the iMessage channel lifecycle, FAIL-CLOSED at the transport.
//
// iMessage is a confirmed Base44 channel (docs.base44.com changelog, April 2026), but NO
// provider contract for it is available in this runtime: Apple exposes no public iMessage API,
// no Apple messaging connector exists among the platform's connectors, and Base44 publishes no
// iMessage transport contract. The certified channel transports here are WhatsApp Cloud API,
// Telegram Bot API, LINE Messaging API and Slack Events API. The connection and message
// lifecycle therefore refuse with the EXACT documented blocker; the missing external
// capability is ISOLATED, never fabricated.
//
// Actions: status | connect | message. `status` answers with the blocker as data (the UI's
// single source of truth); connect/message are 501 refusals — the lifecycle shell that exists
// precisely so the blocker is machine-checkable.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { IMESSAGE_CHANNEL_BLOCKER, IMESSAGE_TRANSPORT_UNAVAILABLE_CODE } from "../../shared/agentChannelGaps.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized", code: "UNAUTHENTICATED" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (action === "status") {
      return Response.json({ channel: "imessage", available: false, blocker: IMESSAGE_CHANNEL_BLOCKER, code: IMESSAGE_TRANSPORT_UNAVAILABLE_CODE });
    }
    if (action !== "connect" && action !== "message") {
      return Response.json({ error: 'Unsupported action — use "status", "connect" or "message"', code: "INVALID_ACTION" }, { status: 400 });
    }
    return Response.json({ error: IMESSAGE_CHANNEL_BLOCKER, code: IMESSAGE_TRANSPORT_UNAVAILABLE_CODE }, { status: 501 });
  } catch (e) {
    return Response.json({ error: e.message, code: e.code || null }, { status: e.status || 500 });
  }
}