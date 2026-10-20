// THE connector event catalog — a pure, dependency-free description of which connector events
// NexusAI knows about. It records, per connector, the provider and the event names that are
// base44_confirmed (the closed set the Base44 platform documents), provider_native (the provider's
// own event names, preserved verbatim — an open set a receiver passes through), or unknown.
//
// It is NOT a normalized event enum: provider-native event names are recorded exactly as the
// provider emits them. A connector whose receiver passes the provider event name through verbatim
// (Slack event.type, GitHub x-github-event) carries a `*` entry marking that any provider-native
// name is accepted — so the catalog never has to enumerate every provider event and never invents
// a Base44 event name.
//
// `implemented` describes whether NexusAI currently has a receiver/handler that EMITS this event.
// A base44_confirmed event that Base44 delivers but NexusAI has no native receiver for is recorded
// with implemented:false (the managed platform may still dispatch it; NexusAI just does not produce
// it). This is descriptive, never a claim that Base44 internals are known.

export const CONNECTOR_EVENT_SOURCES = ["base44_confirmed", "provider_native", "unknown"];

export const CONNECTOR_EVENT_CATALOG = {
  gmail: {
    provider: "google",
    events: [{ name: "mailbox", source: "base44_confirmed", implemented: false }],
  },
  // Google receiver (shared/googleChannelConnectorEvent.ts) NORMALIZES a verified push's
  // provider-native X-Goog-Resource-State to the Base44-compatible workflow event before
  // dispatch: calendar exists/not_exists → "events"; drive change → "changes", add → "file",
  // update/trash/untrash/remove → the documented file-scoped file.* events. The provider state
  // is preserved in the dispatched
  // payload. An unmapped state still passes through verbatim (an open provider-native set), so
  // the enumerated provider-native entries below are no longer emitted verbatim and are
  // recorded implemented:false.
  googlecalendar: {
    provider: "google",
    events: [
      { name: "events", source: "base44_confirmed", implemented: true },
      { name: "exists", source: "provider_native", implemented: false },
      { name: "not_exists", source: "provider_native", implemented: false },
    ],
  },
  googledrive: {
    provider: "google",
    events: [
      { name: "changes", source: "base44_confirmed", implemented: true },
      { name: "file", source: "base44_confirmed", implemented: true },
      // DOCUMENTED (Base44) file-scoped events — the receiver maps the provider states
      // update/trash/untrash/remove onto these (Drive "add" stays generic "file").
      { name: "file.update", source: "base44_confirmed", implemented: true },
      { name: "file.trash", source: "base44_confirmed", implemented: true },
      { name: "file.untrash", source: "base44_confirmed", implemented: true },
      { name: "file.delete", source: "base44_confirmed", implemented: true },
      { name: "add", source: "provider_native", implemented: false },
      { name: "update", source: "provider_native", implemented: false },
      { name: "remove", source: "provider_native", implemented: false },
      { name: "trash", source: "provider_native", implemented: false },
      { name: "untrash", source: "provider_native", implemented: false },
      { name: "change", source: "provider_native", implemented: false },
    ],
  },
  slack: {
    provider: "slack",
    events: [
      { name: "message", source: "base44_confirmed", implemented: true },
      // The Slack receiver passes payload.event.type through verbatim, so any provider-native
      // event name is accepted — represented by the `*` entry (no enumerated enum is invented).
      { name: "*", source: "provider_native", implemented: true },
    ],
  },
  github: {
    provider: "github",
    events: [
      { name: "push", source: "provider_native", implemented: true },
      // The GitHub receiver passes x-github-event through verbatim for repo-scoped events.
      { name: "*", source: "provider_native", implemented: true },
    ],
  },
  microsoft_teams: {
    provider: "microsoft",
    events: [
      { name: "created", source: "provider_native", implemented: true },
      { name: "updated", source: "provider_native", implemented: true },
      { name: "deleted", source: "provider_native", implemented: true },
    ],
  },
  share_point: {
    provider: "microsoft",
    events: [{ name: "updated", source: "provider_native", implemented: true }],
  },
  outlook: {
    provider: "microsoft",
    events: [
      { name: "created", source: "provider_native", implemented: true },
      { name: "updated", source: "provider_native", implemented: true },
      { name: "deleted", source: "provider_native", implemented: true },
    ],
  },
  one_drive: {
    provider: "microsoft",
    events: [
      { name: "created", source: "provider_native", implemented: true },
      { name: "updated", source: "provider_native", implemented: true },
      { name: "deleted", source: "provider_native", implemented: true },
    ],
  },
};

const WILDCARD = "*";

/** The catalog entry for a (connector, event) pair, or null. A `*` entry matches any event. */
export function connectorEventEntry(connector, event) {
  const c = CONNECTOR_EVENT_CATALOG[String(connector || "")];
  if (!c) return null;
  const exact = c.events.find((e) => e.name === String(event || ""));
  if (exact) return exact;
  const wildcard = c.events.find((e) => e.name === WILDCARD);
  return wildcard || null;
}

/** Whether the connector is in the catalog at all. */
export const connectorKnown = (connector) => Object.prototype.hasOwnProperty.call(CONNECTOR_EVENT_CATALOG, String(connector || ""));

/** Whether a (connector, event) pair is known (exact match, or the connector accepts any via `*`). */
export const connectorEventKnown = (connector, event) => connectorEventEntry(connector, event) !== null;

/** Whether NexusAI currently implements (emits) this event. False for base44_confirmed events
 *  with no native receiver. */
export const connectorEventImplemented = (connector, event) => {
  const e = connectorEventEntry(connector, event);
  return !!e && e.implemented;
};

/** The list of connector ids in the catalog. */
export const connectorIds = () => Object.keys(CONNECTOR_EVENT_CATALOG);

/** A credential-free public description of the catalog. */
export const describeConnectorEventCatalog = () => ({
  sources: CONNECTOR_EVENT_SOURCES,
  connectors: Object.fromEntries(
    Object.entries(CONNECTOR_EVENT_CATALOG).map(([id, c]) => [
      id,
      { provider: c.provider, events: c.events.map((e) => ({ name: e.name, source: e.source, implemented: e.implemented })) },
    ]),
  ),
});