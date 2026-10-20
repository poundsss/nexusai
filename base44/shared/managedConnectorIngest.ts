// THE shared managed-connector ingestion core — the smallest production-grade abstraction every
// certified connector receiver can route through once it has verified a provider delivery.
//
// It owns ONLY the three steps every verified connector delivery shares, and nothing else:
//   1. envelope validation  — connector/event/delivery_id present, event known to the catalog;
//   2. replay deduplication — existing claimDeliveryOnce, namespaced per connector;
//   3. dispatch             — existing emitConnector, provider-native event name + payload verbatim.
//
// It does NOT verify the delivery (each receiver does that with its own provider-specific
// primitive — HMAC, channel token, Graph clientState — unchanged), does NOT enrich the payload,
// does NOT touch WorkflowDefinition / WorkflowRun / trigger matching / jq conditions, and does NOT
// introduce a universal CREATE/UPDATE/DELETE event enum. Base44's managed enrichment of trigger.data
// is UNKNOWN and is not imitated.
import { claimDeliveryOnce } from "./githubWebhook.ts";
import { emitConnector } from "./workflowTriggers.ts";
import { connectorEventKnown, connectorKnown } from "./connectorEventCatalog.ts";
import { dispatchConnectorAutomations, automationDeliveryFromPayload } from "./connectorAutomations.ts";

/**
 * Gmail mailbox payload parity (the single confirmed parity gap). Base44's PUBLIC trigger-condition
 * contract documents `has_new_messages` (equals true → the mailbox change delivered new emails),
 * while the platform-enriched trigger.data carries NexusAI's internal derivation
 * (`has_new_non_draft_messages` + `new_message_ids`). Derive the documented field from the
 * already-available new-message information ONLY: the internal fields are preserved untouched, a
 * `has_new_messages` the platform already supplied is never overwritten, and nothing else is added.
 */
export function enrichGmailMailboxData(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  // The dispatched gmail payload carries the engine trigger envelope: the enriched fields live
  // under `trigger.data` (the shape the platform enriches and jq conditions reference as
  // `.trigger.data.…`). A bare trigger-data object is enriched directly.
  const target = payload.trigger && typeof payload.trigger === "object" && payload.trigger.data
    && typeof payload.trigger.data === "object"
    ? payload.trigger.data
    : payload;
  if (Object.prototype.hasOwnProperty.call(target, "has_new_messages")) return payload;
  const nonDraft = target.has_new_non_draft_messages === true;
  const newIds = Array.isArray(target.new_message_ids) ? target.new_message_ids : [];
  const enriched = { ...target, has_new_messages: nonDraft || newIds.length > 0 };
  return target === payload ? enriched : { ...payload, trigger: { ...payload.trigger, data: enriched } };
}

/** The minimum common envelope. The provider's native payload is carried as `data`, unchanged. */
export function normalizeConnectorEnvelope({ connector, event, delivery_id, received_at, data } = {}) {
  return {
    connector: String(connector || ""),
    event: String(event || ""),
    delivery_id: String(delivery_id || ""),
    received_at: typeof received_at === "string" && received_at ? received_at : new Date().toISOString(),
    data: data === undefined ? null : data,
  };
}

/**
 * Ingest one verified connector delivery: validate the envelope, dedup, dispatch.
 *
 * The caller has ALREADY verified the delivery with its provider-specific primitive. This core
 * trusts that and performs the shared post-verification steps. It returns:
 *   • { ok:false, code, status, error }       — envelope/catalog rejection (fail closed, no dispatch)
 *   • { ok:true, duplicate:true, matched:0 }  — a redelivered delivery (acknowledged, no dispatch)
 *   • { ok:true, duplicate:false, matched, envelope } — a fresh delivery that was dispatched
 *
 * `replay_key` overrides the default `${connector}:${delivery_id}` dedup key, so a receiver that
 * already namespaced its replay key (e.g. Slack `slack:<event_id>`, or GitHub's raw delivery id)
 * preserves its exact prior dedup behavior. `delivery_id` is always the value passed to
 * emitConnector as the engine idempotency key (unchanged).
 */
export async function ingestConnectorDelivery(svc, {
  project, connector, event, delivery_id, payload = null, replay_key = null, trace_id = null, now = Date.now(),
} = {}) {
  if (!project) {
    return { ok: false, code: "PROJECT_REQUIRED", status: 400, duplicate: false, matched: 0,
      error: "a connector delivery requires a project" };
  }
  const conn = String(connector || "").trim();
  const evt = String(event || "").trim();
  const did = String(delivery_id || "").trim();
  if (!conn || !evt || !did) {
    return { ok: false, code: "ENVELOPE_MALFORMED", status: 400, duplicate: false, matched: 0,
      error: "a connector delivery requires connector, event and delivery_id",
      connector: conn, event: evt, delivery_id: did };
  }
  if (!connectorKnown(conn)) {
    return { ok: false, code: "UNKNOWN_CONNECTOR", status: 400, duplicate: false, matched: 0,
      error: `connector '${conn}' is not in the connector event catalog`, connector: conn };
  }
  if (!connectorEventKnown(conn, evt)) {
    return { ok: false, code: "UNKNOWN_CONNECTOR_EVENT", status: 400, duplicate: false, matched: 0,
      error: `connector '${conn}' has no known event '${evt}'`, connector: conn, event: evt };
  }

  // Replay dedup — the existing durable primitive. Default key is namespaced per connector so
  // deliveries across connectors never collide in the shared replay cache.
  const key = replay_key || `${conn}:${did}`;
  const claimed = await claimDeliveryOnce(svc, { projectId: project.id, deliveryId: key, now });
  if (!claimed) {
    return { ok: true, duplicate: true, matched: 0, connector: conn, event: evt, delivery_id: did, replay_key: key };
  }

  // Gmail mailbox parity: enrich ONLY gmail/mailbox with the documented `has_new_messages` field.
  const dispatchedPayload = conn === "gmail" && evt === "mailbox"
    ? enrichGmailMailboxData(payload)
    : payload;

  // Normalize the envelope (diagnostics/audit — carries the dispatched payload).
  const envelope = normalizeConnectorEnvelope({
    connector: conn, event: evt, delivery_id: did, received_at: new Date(now).toISOString(), data: dispatchedPayload,
  });

  // Dispatch through the ONE existing emitter. Provider-native event name + payload preserved.
  const result = await emitConnector(svc, {
    project, workspace_id: project.workspace_id,
    connector: conn, event: evt, payload: dispatchedPayload, delivery_id: did, trace_id,
  });

  // Backend Connector Automations (the DOCUMENTED second dispatch target): the SAME verified,
  // already-deduplicated delivery is also projected onto opted-in generated backend functions
  // (config.automations). Purely additive — the Workflow dispatch above is unchanged, an
  // automation failure never affects the workflow result, and this remains the ONE
  // post-verification choke point (no second ingestion system).
  const automations = await dispatchConnectorAutomations(svc, {
    project, connector: conn, event: evt, delivery: automationDeliveryFromPayload(dispatchedPayload),
    delivery_id: did, trace_id,
  }).catch((e) => ({ matched: 0, dispatched: 0, functions_scanned: 0, error: String(e?.message || e).slice(0, 200) }));

  return { ok: true, duplicate: false, matched: result?.matched ?? 0, connector: conn, event: evt,
    delivery_id: did, replay_key: key, envelope,
    automations: { matched: automations.matched ?? 0, dispatched: automations.dispatched ?? 0 } };
}