// Microsoft Graph connector-event handler CORE — for the Base44 MANAGED Microsoft Teams and
// SharePoint connectors.
//
// This is the handler half of the Base44-documented Teams/SharePoint connector workflow integration.
// The Base44 platform owns the Graph change-notification subscription, signature verification and
// delivery, and dispatches a pre-decoded connector event to a workflow whose connector trigger is
// `integration_type=microsoft_teams` (event `created`/`updated`/`deleted`) or `integration_type=
// share_point` (event `updated`). The workflow's `invoke_backend_function` step passes `trigger.data`
// to this handler, which:
//   1. reads `data.value[]` — the Graph change-notification batch envelope the platform decoded;
//   2. for each notification, preserves the provider-native `changeType` as the event name and uses
//      `resourceData.id` (via the notification `resource` path that embeds it) to fetch the full
//      resource through the existing connector connection (`getConnection('microsoft_teams')` or
//      `getConnection('share_point')`) against the Microsoft Graph API;
//   3. fails CLOSED on a missing/invalid connection (no resource is fetched, no token is logged) and
//      fails CLOSED per-notification on a malformed or unsupported event (no fetch, recorded with a
//      code, the rest of the batch still resolves).
//
// The core is dependency-injectable (`getConnection`, `http`, `connector`) so the certification
// harness exercises it against a mock Graph API with NO real Microsoft account and NO production
// resource access. The two thin HTTP entries (functions/msTeamsConnectorEvent/entry.ts and
// functions/sharePointConnectorEvent/entry.ts) wire the real Base44 SDK connection and the real
// fetch transport, so the entries and their shared certification harness run exactly one
// implementation.
//
// NOT reused and deliberately NOT touched: `msGraphConnectorEvent` / `GraphSubscription` — that is the
// NATIVE Outlook/OneDrive receiver with a different contract (own subscription entity, own signature
// path). This handler is platform-managed-only: NO subscription entity, NO receiver, NO signature
// verification, NO new generic connector framework, NO external infrastructure — by design.
import { scrubText } from "./tracing.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Provider-native change types the Base44 platform documents for each managed Graph connector.
// Preserving these EXACT strings as the connector event names is the contract — no normalization.
const TEAMS_EVENTS = new Set(["created", "updated", "deleted"]);
const SHAREPOINT_EVENTS = new Set(["updated"]);

function supportedEvents(connector) {
  if (connector === "microsoft_teams") return TEAMS_EVENTS;
  if (connector === "share_point") return SHAREPOINT_EVENTS;
  return null; // unknown Graph connector — fail closed
}

/**
 * Default Microsoft Graph transport: wraps the global `fetch` into the `{ ok, status, body }` shape
 * the core expects. Used by the real entry functions; the cert injects a mock instead. Handles
 * Graph's empty 202/204 responses the documented way (text-then-parse, no raw res.json()).
 */
export async function defaultGraphHttp(url, options = {}) {
  const res = await fetch(String(url), { ...options });
  const text = await res.text();
  let body = text;
  const type = res.headers.get("content-type") || "";
  if (text && type.includes("json")) { try { body = JSON.parse(text); } catch { /* keep text */ } }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Handle a Microsoft Graph connector-event delivery for the given managed connector.
 *
 * `data` is the pre-decoded `trigger.data` — the Graph notification envelope `{ value: [...] }`
 * where each entry is `{ changeType, resource, resourceData: { id, "@odata.type" }, subscriptionId,
 * clientState }`. `getConnection` resolves to `{ accessToken, connectionConfig? }` — the Base44 SDK
 * contract. Returns `{ ok, events, count, requested }`; each event is
 * `{ changeType, resourceId, ok, code?, fetched? }`.
 *
 * Fail-closed behavior:
 *   • envelope with no `value[]`            → `{ ok:false, code:"MALFORMED_ENVELOPE", events:[] }`
 *   • unsupported connector                  → `{ ok:false, code:"UNSUPPORTED_CONNECTOR", events:[] }`
 *   • getConnection throws / no accessToken  → `{ ok:false, code:"CONNECTION_UNAVAILABLE"|"NO_ACCESS_TOKEN", events:[] }`
 *   • per-notification: missing changeType/resourceData.id → `ok:false, code:"MALFORMED_NOTIFICATION"`, no fetch
 *   • per-notification: changeType not in the connector's allowed set → `ok:false, code:"UNSUPPORTED_EVENT_TYPE"`, no fetch
 *   • per-notification: deleted changeType → `ok:true, fetched:null` (resource is gone, no fetch)
 *   • per-notification: Graph fetch failure → `ok:false, code:"FETCH_FAILED"`, fetched:null
 *
 * A single per-notification failure never aborts the batch; the rest still resolve.
 */
export async function handleGraphWebhook({ data, connector, getConnection, http = defaultGraphHttp } = {}) {
  const value = Array.isArray(data?.value) ? data.value : null;
  if (!value) {
    return { ok: false, code: "MALFORMED_ENVELOPE", error: "The Graph notification envelope has no value[] array.", events: [], count: 0, requested: 0 };
  }
  const allowed = supportedEvents(connector);
  if (!allowed) {
    return { ok: false, code: "UNSUPPORTED_CONNECTOR", error: `Unsupported Graph connector: ${connector}`, events: [], count: 0, requested: value.length };
  }

  let connection;
  try {
    connection = await getConnection?.();
  } catch {
    return { ok: false, code: "CONNECTION_UNAVAILABLE", error: `The ${connector} managed connector connection is not available.`, events: [], count: 0, requested: value.length };
  }
  if (!connection || !connection.accessToken) {
    return { ok: false, code: "NO_ACCESS_TOKEN", error: `The ${connector} managed connector returned no access token.`, events: [], count: 0, requested: value.length };
  }

  const events = [];
  for (const n of value) {
    const changeType = typeof n?.changeType === "string" ? n.changeType : null;
    const resourceId = n?.resourceData?.id ? String(n.resourceData.id) : null;
    const resource = typeof n?.resource === "string" ? n.resource : null;

    // Malformed notification: no event name or no resource id → fail closed for this entry.
    if (!changeType || !resourceId) {
      events.push({ changeType, resourceId, ok: false, code: "MALFORMED_NOTIFICATION", fetched: null });
      continue;
    }
    // Unsupported event type for this connector → fail closed for this entry (no fetch, no dispatch).
    if (!allowed.has(changeType)) {
      events.push({ changeType, resourceId, ok: false, code: "UNSUPPORTED_EVENT_TYPE", fetched: null });
      continue;
    }
    // Deleted: the resource is gone — record the event, no fetch (Graph would 404 / not-found).
    if (changeType === "deleted") {
      events.push({ changeType, resourceId, ok: true, fetched: null });
      continue;
    }
    // Fetch the full resource via Graph. The notification `resource` is the relative Graph path that
    // embeds resourceData.id (e.g. "me/messages/<id>", "/sites/<id>/lists/<id>/items/<id>").
    if (!resource) {
      events.push({ changeType, resourceId, ok: false, code: "MALFORMED_NOTIFICATION", fetched: null });
      continue;
    }
    try {
      const path = resource.startsWith("/") ? resource : `/${resource}`;
      const res = await http(`${GRAPH_BASE}${path}`, {
        headers: { Authorization: `Bearer ${connection.accessToken}` },
      });
      if (!res.ok || !res.body) {
        events.push({ changeType, resourceId, ok: false, code: "FETCH_FAILED", fetched: null });
        continue;
      }
      events.push({
        changeType, resourceId, ok: true,
        fetched: scrubText(typeof res.body === "string" ? res.body : JSON.stringify(res.body), 1000) || null,
      });
    } catch {
      events.push({ changeType, resourceId, ok: false, code: "FETCH_FAILED", fetched: null });
    }
  }
  return { ok: true, events, count: events.length, requested: value.length };
}