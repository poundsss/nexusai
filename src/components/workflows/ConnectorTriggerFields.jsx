import React, { useEffect, useState } from "react";
import { CONNECTOR_EVENT_OPTIONS, CONNECTOR_IDS } from "@/lib/connectorEvents";

const CUSTOM = "__custom";

// The connector + event fields of a connector trigger, shared by the new-workflow dialog and the
// workflow-card trigger editor. Values travel ONLY through onConnector/onEvent (and onCondition
// for the connectors that require one) — the parent owns the state and persists it through the
// existing workflow create/update actions. Event choices are exactly the implemented catalog
// entries; a wildcard connector additionally accepts a custom provider-native event name (the
// catalog's `*` entry), typed into the custom input. DOCUMENTED (Base44): slack and slackbot
// connector automations REQUIRE a trigger condition, so those connectors show a condition input
// (a platform jq expression, e.g. .event.type == "message").
const CONDITION_REQUIRED_CONNECTORS = ["slack", "slackbot"];

export default function ConnectorTriggerFields({ connector, event, condition, onCondition, onConnector, onEvent }) {
  const entry = CONNECTOR_EVENT_OPTIONS[connector];
  const events = entry?.events || [];
  const wildcard = !!entry?.wildcard;
  const customActive = wildcard && (!!event ? !events.includes(event) : false);
  const [custom, setCustom] = useState(customActive);

  // Switching connectors resets the event selection; leave custom mode only while the
  // connector actually allows it.
  useEffect(() => {
    setCustom((c) => (CONNECTOR_EVENT_OPTIONS[connector]?.wildcard ? c : false));
  }, [connector]);

  const selectCls = "rounded-md border border-border bg-background px-2 py-1 text-[11.5px]";
  const inputCls = "rounded-md border border-border bg-background px-2 py-1 text-[11.5px] outline-none focus:ring-1 ring-ring";

  return (
    <>
      <select
        value={connector}
        onChange={(e) => { onConnector(e.target.value); onEvent(""); setCustom(false); }}
        aria-label="Connector"
        className={selectCls}
      >
        <option value="">connector…</option>
        {CONNECTOR_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
      </select>
      {entry && (custom ? (
        <input
          value={event || ""}
          onChange={(e) => onEvent(e.target.value)}
          placeholder="custom event name"
          aria-label="Custom connector event"
          className={`${inputCls} min-w-[180px] flex-1 font-mono`}
        />
      ) : (
        <select
          value={events.includes(event) ? event : CUSTOM}
          onChange={(e) => {
            if (e.target.value === CUSTOM) { setCustom(true); onEvent(""); }
            else onEvent(e.target.value);
          }}
          aria-label="Connector event"
          className={selectCls}
        >
          <option value={CUSTOM} disabled={!wildcard}>custom event…</option>
          {events.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      ))}
      {CONDITION_REQUIRED_CONNECTORS.includes(connector) && (
        <input
          value={condition || ""}
          onChange={(e) => onCondition(e.target.value)}
          placeholder='required condition, e.g. .event.type == "message"'
          aria-label="Required trigger condition"
          className={`${inputCls} min-w-[180px] flex-1 font-mono`}
        />
      )}
    </>
  );
}