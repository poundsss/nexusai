// Shared WhatsApp channel certification stubs (the P-9.10C parity suite + the P-9.13G gap
// suite). Plain scripted transports and payload builders ONLY — no assertions, no cleanup
// policy; each suite keeps its own scenario and its own finally block.

/** HMAC-SHA256 hex over the EXACT raw body — the provider's documented signature form. */
export async function hmacWaHex(secret, raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(raw))))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A scripted WhatsApp Cloud API transport: records every call (url, token used, body) and
 * answers the documented endpoints — the display_phone_number GET, the create-group POST
 * (optional scripted body), and the messages POST (optionally failing). Never touches the
 * network.
 */
export function makeWaHttp({ waNumber, pnid, groupResponse = null } = {}) {
  const calls = [];
  let sendFails = false;
  const http = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, token: (init.headers && init.headers.authorization) || null, body: init.body ? JSON.parse(String(init.body)) : null });
    if (u.includes("?fields=display_phone_number")) {
      return new Response(JSON.stringify({ display_phone_number: waNumber, id: pnid }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/groups")) {
      if (groupResponse === null) return new Response(JSON.stringify({}), { status: 404 });
      return new Response(JSON.stringify(groupResponse), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.endsWith("/messages")) {
      if (sendFails) return new Response(JSON.stringify({ error: { message: "recipient unreachable" } }), { status: 500, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ wa_id: "1" }], messages: [{ id: "wamid.out" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
  return { http, calls, setSendFails: (v) => { sendFails = !!v; } };
}

/** The webhook update builder. `groupId` present → the Meta-documented GROUP shape. */
export function makeWaUpdate({ waNumber, pnid }) {
  let seq = 0;
  return (from, text, { id = `wamid.${++seq}`, contactWa = from, groupId = "" } = {}) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "ebid", changes: [{ field: "messages", value: {
        messaging_product: "whatsapp", metadata: { display_phone_number: waNumber, phone_number_id: pnid },
        contacts: [{ profile: { name: "Test" }, wa_id: contactWa }],
        messages: [{ from, ...(groupId ? { group_id: groupId } : {}), id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
      } }] }],
    });
}

/** The provider's group_lifecycle_update webhook builder (group create → invite link). */
export function makeWaLifecycle({ waNumber, pnid }) {
  return (groupId, inviteLink) =>
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "ebid", changes: [{ field: "group_lifecycle_update", value: {
        messaging_product: "whatsapp", metadata: { display_phone_number: waNumber, phone_number_id: pnid },
        event: "group_create_succeed", group_id: groupId, invite_link: inviteLink,
      } }] }],
    });
}