// P-9.13 — the fail-closed channel-transport gaps: Phone and iMessage.
//
// The single source of truth for the two channels whose CONFIRMED product capability (docs.
// base44.com, Superagents: "You can also give it its own phone number for calls"; the iMessage
// changelog entry) has NO provider/transport contract available in this runtime. The connection
// and message lifecycle refuse with the EXACT blocker instead of fabricating a provider —
// per the standing rule: a missing external capability is isolated, never invented.
//
// Evidence, never assumptions:
//   • VERIFIED (docs.base44.com): Phone and iMessage are documented Superagent channels, but
//     Base44 publishes NO telephony or iMessage transport contract — the transport is Base44's
//     own platform infrastructure, exactly like the Chrome Web Store extension.
//   • VERIFIED (this runtime): the certified channel transports are WhatsApp Cloud API,
//     Telegram Bot API, LINE Messaging API and Slack Events API; no telephony connector exists
//     among the platform's connectors; GenerateSpeech is media-only TTS with NO phone
//     transport; Apple exposes no public iMessage API and no Apple messaging connector exists.
//   • Therefore: status / connect / message all fail closed with the SAME documented blocker —
//     no fake number provisioning, no fake message relay, no invented billing.

export const PHONE_TRANSPORT_UNAVAILABLE_CODE = "PHONE_TRANSPORT_UNAVAILABLE";
export const IMESSAGE_TRANSPORT_UNAVAILABLE_CODE = "IMESSAGE_TRANSPORT_UNAVAILABLE";

export const PHONE_CHANNEL_BLOCKER =
  "No telephony transport is available in this runtime: the Phone channel is a documented " +
  "Base44 capability, but Base44 publishes no telephony provider contract (no PSTN or voice-call " +
  "primitive; GenerateSpeech is media-only TTS with no phone transport, and no telephony " +
  "connector exists). Number provisioning and call/message relaying fail closed instead of " +
  "fabricating a provider.";

export const IMESSAGE_CHANNEL_BLOCKER =
  "No iMessage provider contract is available in this runtime: Apple exposes no public iMessage " +
  "API, no Apple messaging connector exists among the platform's connectors, and Base44 " +
  "publishes no iMessage transport contract. The certified channel transports here are WhatsApp " +
  "Cloud API, Telegram Bot API, LINE Messaging API and Slack Events API. The iMessage connection " +
  "and message lifecycle fail closed instead of fabricating the provider.";

/** The fail-closed Phone lifecycle: connect and message ALWAYS refuse with the exact blocker. */
export function phoneChannelTransportUnavailable() {
  throw Object.assign(new Error(PHONE_CHANNEL_BLOCKER), {
    code: PHONE_TRANSPORT_UNAVAILABLE_CODE,
    status: 501,
  });
}

/** The fail-closed iMessage lifecycle: connect and message ALWAYS refuse with the exact blocker. */
export function imessageChannelTransportUnavailable() {
  throw Object.assign(new Error(IMESSAGE_CHANNEL_BLOCKER), {
    code: IMESSAGE_TRANSPORT_UNAVAILABLE_CODE,
    status: 501,
  });
}