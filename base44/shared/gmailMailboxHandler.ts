// Gmail mailbox handler CORE — Phase 2, using the Base44 MANAGED gmail connector.
//
// This is the handler half of the Base44-documented Gmail connector workflow integration. The
// Base44 platform owns Pub/Sub ingestion, OIDC verification and historyId tracking, and dispatches
// a pre-enriched connector event to a workflow whose connector trigger is `integration_type=gmail`
// / event `mailbox`. The workflow's `invoke_backend_function` step passes `trigger.data` to this
// handler, which:
//   1. reads `data.new_message_ids` (pre-populated by the platform — no historyId tracking here);
//   2. resolves the Gmail connection through the Base44 SDK (`getConnection('gmail')`);
//   3. fetches each message via the Gmail messages API;
//   4. fails CLOSED on a missing/invalid connection (no message is fetched, no token is logged).
//
// The core is dependency-injectable (`getConnection`, `http`) so the certification harness exercises
// it against a mock Gmail API with NO real Gmail account and NO production message access. The
// thin HTTP entry (functions/gmailMailboxHandler/entry.ts) wires the real Base44 SDK connection and
// the real fetch transport, so the two share exactly one implementation.
//
// NO Pub/Sub receiver, NO topic/subscription, NO OIDC/JWKS, NO historyId SyncState, NO new entity,
// NO new generic connector framework — by design (the platform manages all of that).
import { scrubText } from "./tracing.ts";

const GMAIL_MESSAGES_BASE = "https://gmail.googleapis.com/gmail/v1/users/me/messages/";

/**
 * Default Gmail messages-API transport: wraps the global `fetch` into the `{ ok, status, body }`
 * shape the core expects. Used by the real entry function; the cert injects a mock instead.
 */
export async function defaultGmailHttp(url, options = {}) {
  const res = await fetch(String(url), { ...options });
  const text = await res.text();
  let body = text;
  const type = res.headers.get("content-type") || "";
  if (type.includes("json")) { try { body = JSON.parse(text); } catch { /* keep text */ } }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Fetch the content of every `new_message_ids` message through the Base44 `gmail` managed
 * connector. Returns `{ ok, messages, count, requested }`. Fails CLOSED on any connection problem:
 * a thrown/missing `getConnection` or a token-less connection yields `{ ok: false, code, messages: [] }`
 * and NEVER fetches a message. A single message fetch failure is skipped (the rest still resolve).
 *
 * `data` is the pre-enriched `trigger.data` (`{ has_new_non_draft_messages, new_message_ids, ... }`).
 * `getConnection` resolves to `{ accessToken, connectionConfig? }` — the Base44 SDK contract.
 */
export async function handleGmailMailbox({ data, getConnection, http = defaultGmailHttp } = {}) {
  const ids = Array.isArray(data?.new_message_ids)
    ? data.new_message_ids.map((s) => String(s || "")).filter(Boolean)
    : [];

  let connection;
  try {
    connection = await getConnection?.();
  } catch {
    return { ok: false, code: "CONNECTION_UNAVAILABLE", error: "The Gmail managed connector connection is not available.", messages: [], count: 0, requested: ids.length };
  }
  if (!connection || !connection.accessToken) {
    return { ok: false, code: "NO_ACCESS_TOKEN", error: "The Gmail managed connector returned no access token.", messages: [], count: 0, requested: ids.length };
  }

  const messages = [];
  for (const id of ids) {
    try {
      const res = await http(`${GMAIL_MESSAGES_BASE}${encodeURIComponent(id)}?format=full`, {
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      });
      if (!res.ok || !res.body) continue;
      const m = res.body;
      messages.push({
        id: String(m.id || id),
        threadId: m.threadId || null,
        snippet: typeof m.snippet === "string" ? scrubText(m.snippet, 500) : null,
        labelIds: Array.isArray(m.labelIds) ? m.labelIds : null,
      });
    } catch {
      // One failed message never aborts the batch; the rest still resolve.
    }
  }
  return { ok: true, messages, count: messages.length, requested: ids.length };
}