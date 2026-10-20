// Frontend MIRROR of the backend connector event catalog (base44/shared/connectorEventCatalog.ts) —
// the same established pattern the Design System menu uses for its backend registry. Only the
// catalog entries NexusAI actually IMPLEMENTS (implemented:true) are exposed: these are the events
// a real receiver dispatches, so a workflow authored here can genuinely fire. base44-confirmed
// entries without a native receiver (gmail "mailbox", googlecalendar "events") are deliberately
// NOT listed — authoring against them would create workflows that can never dispatch. A
// `wildcard` connector accepts any provider-native event name (the catalog's `*` entry); the
// editor offers its enumerated names plus a custom-event input. Slack and Slack Bot connector
// automations REQUIRE a trigger condition (DOCUMENTED Base44) — the editor collects it as
// authoring-time input; every other connector is unchanged.
export const CONNECTOR_EVENT_OPTIONS = {
  github: { events: ["push"], wildcard: true },
  slack: { events: ["message"], wildcard: true },
  googlecalendar: { events: ["exists", "not_exists"] },
  // The Drive receiver normalizes provider states to the DOCUMENTED (Base44) workflow events:
  // file "add" stays generic "file"; update/trash/untrash/remove map to the file-scoped
  // file.update / file.trash / file.untrash / file.delete; the change feed maps to "changes".
  googledrive: { events: ["file", "file.update", "file.trash", "file.untrash", "file.delete", "changes"] },
  microsoft_teams: { events: ["created", "updated", "deleted"] },
  outlook: { events: ["created", "updated", "deleted"] },
  one_drive: { events: ["created", "updated", "deleted"] },
  share_point: { events: ["updated"] },
};

export const CONNECTOR_IDS = Object.keys(CONNECTOR_EVENT_OPTIONS);