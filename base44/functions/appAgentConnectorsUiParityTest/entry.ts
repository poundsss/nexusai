// G-K3 certification: the Builder per-agent "Connectors tab" derivation contract.
//
// PURE checks only — no DB scenarios, no scratch workspaces, no network. Every fixture is an
// in-memory file set and every check exercises the production modules themselves:
//   • shared/agentConnectorsView.ts  — the projection, the usage scan and the toggle primitive;
//   • shared/agentResource.ts        — the P-9.11K owned `connectors` key and the canonical emit;
//   • shared/connectorResource.ts   — the connector registry (via the view's composition).
// The certified invariants: enabled ⊆ the parsed agent document, available = the project's own
// declared registry, usage = the audited static scan over the documented call forms, and a
// toggle that is idempotent, canonical and fail-closed on both ends. The P-9.11K runtime
// contract is NOT touched by this suite's subject — it is re-certified by the existing
// appAgentConnectorsParityTest regression.
import { createHarness, harnessResponse, harnessError } from "../../shared/testHarness.ts";
import { agentConnectorsView, connectorUsageScan, applyAgentConnectorToggle } from "../../shared/agentConnectorsView.ts";
import { parseAgentDocument, agentDocumentContent, validateAgentReferences } from "../../shared/agentResource.ts";
import { agentFilePath, connectorFilePath } from "../../shared/base44Layout.ts";
import { canonicalFunctionPath } from "../../shared/functionPaths.ts";

const fail = (code, message) => Object.assign(new Error(message), { code });

const agentText = (connectors) => `${JSON.stringify({
  name: "helper", instructions: "Answer briefly.", tools: [], skills: [],
  ...(connectors ? { connectors } : {}),
}, null, 2)}\n`;

const connectorText = (name) => `${JSON.stringify({
  name, type: "http", base_url: "https://example.test/api", auth: { type: "none" }, operations: [],
}, null, 2)}\n`;

const baseFiles = () => [
  { path: agentFilePath("helper"), content: agentText(["googleCalendar"]) },
  { path: connectorFilePath("googleCalendar"), content: connectorText("googleCalendar") },
  { path: connectorFilePath("slack"), content: connectorText("slack") },
  // The documented app-user SDK call form, in a canonical function file.
  { path: canonicalFunctionPath("syncCalendar"), content: `export default async function () {\n  const { accessToken } = await base44.asServiceRole.connectors.getCurrentAppUserConnection("googleCalendar");\n}\n` },
  // The audited member-call precedent, in a legacy flat-layout function file.
  { path: "functions/weatherProxy.js", content: `export default async function () {\n  return base44.integrations.weather.getForecast({ city: "Oslo" });\n}\n` },
  // A function that only MENTIONS the connector name — never attributed.
  { path: canonicalFunctionPath("plainWorker"), content: `// mentions googleCalendar in a comment\nexport default async function () { return null; }\n` },
  { path: connectorFilePath("weather"), content: connectorText("weather") },
];

export default async function (req) {
  const harness = createHarness();
  try {
    // --- projection -------------------------------------------------------------------------
    let view = agentConnectorsView(baseFiles());
    const helper = view.agents.find((a) => a.name === "helper");
    harness.check("view lists the declared agent", !!helper, JSON.stringify(view.agents.map((a) => a.name)));
    harness.check("available is the project's own connector registry",
      helper && helper.available.join(",") === "googleCalendar,slack,weather", JSON.stringify(helper?.available));
    harness.check("enabled comes from the agent document's connectors key",
      helper && helper.enabled.join(",") === "googleCalendar", JSON.stringify(helper?.enabled));
    harness.check("each registry row carries its enabled flag and usage",
      helper && helper.connectors.length === 3
        && helper.connectors.find((c) => c.name === "googleCalendar")?.enabled === true
        && helper.connectors.find((c) => c.name === "slack")?.enabled === false
        && helper.connectors.find((c) => c.name === "googleCalendar")?.used_by.join(",") === "syncCalendar"
        && helper.connectors.find((c) => c.name === "weather")?.used_by.join(",") === "weatherProxy",
      JSON.stringify(helper?.connectors));

    const noKeyFiles = [{ path: agentFilePath("helper"), content: agentText(null) }, ...baseFiles().slice(1)];
    const noKeyHelper = agentConnectorsView(noKeyFiles).agents.find((a) => a.name === "helper");
    harness.check("an agent without the connectors key projects as disabled (parse-time default)",
      noKeyHelper && noKeyHelper.enabled.length === 0 && noKeyHelper.connectors.every((c) => !c.enabled),
      JSON.stringify(noKeyHelper?.enabled));

    const malformedFiles = [
      ...baseFiles(),
      { path: agentFilePath("broken"), content: "{ not jsonc" },
      { path: connectorFilePath("badDef"), content: "{ not jsonc" },
    ];
    const malformedView = agentConnectorsView(malformedFiles);
    harness.check("malformed agent and connector documents are reported, never skipped",
      malformedView.agent_errors.some((e) => e.path === agentFilePath("broken"))
        && malformedView.connector_errors.some((e) => e.path === connectorFilePath("badDef")),
      JSON.stringify({ agents: malformedView.agent_errors.length, connectors: malformedView.connector_errors.length }));

    // --- usage scan -------------------------------------------------------------------------
    const usage = connectorUsageScan(baseFiles());
    harness.check("documented app-user SDK call form is attributed",
      usage.googleCalendar?.join(",") === "syncCalendar", JSON.stringify(usage.googleCalendar));
    harness.check("audited member-call precedent is attributed, legacy layout included",
      usage.weather?.join(",") === "weatherProxy", JSON.stringify(usage.weather));
    harness.check("a function that only mentions the name is never attributed",
      !usage.slack && (usage.googleCalendar || []).every((f) => f !== "plainWorker"),
      JSON.stringify(usage.slack));
    const explicitScan = connectorUsageScan(baseFiles(), ["googleCalendar"]);
    harness.check("an explicit name list bounds the scan to those connectors",
      Object.keys(explicitScan).join(",") === "googleCalendar" && explicitScan.googleCalendar.join(",") === "syncCalendar",
      JSON.stringify(explicitScan));

    // --- toggle persistence -----------------------------------------------------------------
    const path = agentFilePath("helper");
    const onText = applyAgentConnectorToggle(path, agentText(["googleCalendar"]), "slack", true);
    let onParsed = parseAgentDocument(path, onText);
    harness.check("enabling adds the connector and re-parses enabled",
      onParsed.ok && onParsed.agent.connectors.join(",") === "googleCalendar,slack", onParsed.ok ? onParsed.agent.connectors.join(",") : onParsed.error);
    harness.check("the toggled document feeds the canonical emitter and round-trips",
      (() => {
        const round = parseAgentDocument(path, agentDocumentContent(onParsed.agent));
        return round.ok && round.agent.connectors.join(",") === "googleCalendar,slack";
      })(), "");

    const offText = applyAgentConnectorToggle(path, onText, "slack", false);
    const offParsed = parseAgentDocument(path, offText);
    harness.check("disabling removes exactly that connector",
      offParsed.ok && offParsed.agent.connectors.join(",") === "googleCalendar", offParsed.ok ? offParsed.agent.connectors.join(",") : offParsed.error);

    const emptiedText = applyAgentConnectorToggle(path, agentText(["googleCalendar"]), "googleCalendar", false);
    const emptiedDoc = JSON.parse(emptiedText);
    harness.check("an emptied array drops the key, matching the canonical emitter's form",
      !("connectors" in emptiedDoc), Object.keys(emptiedDoc).join(","));

    harness.check("a no-op toggle is idempotent (byte-identical)",
      applyAgentConnectorToggle(path, agentText(["googleCalendar"]), "googleCalendar", true) === agentText(["googleCalendar"])
        && applyAgentConnectorToggle(path, agentText(null), "slack", false) === agentText(null),
      "");

    let invalidName = null;
    try { applyAgentConnectorToggle(path, agentText(["googleCalendar"]), "Google Calendar", true); }
    catch (e) { invalidName = e.code; }
    harness.check("an invalid connector name is refused fail-closed", invalidName === "AGENT_CONNECTOR_NAME_INVALID", String(invalidName));

    let invalidDoc = null;
    try { applyAgentConnectorToggle(agentFilePath("helper"), "{ not jsonc", "slack", true); }
    catch (e) { invalidDoc = e.code; }
    harness.check("a toggle on a malformed document is refused fail-closed", invalidDoc === "AGENT_DOCUMENT_INVALID", String(invalidDoc));

    // --- cross-resource integrity (the registry stays the toggle UI's source of truth) ------
    const refs = validateAgentReferences(baseFiles());
    harness.check("an enabled connector with its declaration present passes the cross-resource check",
      refs.ok && !refs.missingConnectors.length, JSON.stringify(refs.missingConnectors));
    const missingFiles = baseFiles().filter((f) => f.path !== connectorFilePath("googleCalendar"));
    const missingRefs = validateAgentReferences(missingFiles);
    harness.check("an enabled connector without its declaration is reported (never silently offered)",
      !missingRefs.ok && missingRefs.missingConnectors.some((m) => m.connector === "googleCalendar"),
      JSON.stringify(missingRefs.missingConnectors));

    // Nothing in this contract may widen the P-9.11K runtime surface: the toggle result is an
    // ordinary agent document, and the runtime keeps reading the SAME owned key.
    const runtimeDoc = parseAgentDocument(path, onText);
    harness.check("the toggled document is an ordinary P-9.11K agent document (owned key unchanged)",
      runtimeDoc.ok && runtimeDoc.agent.name === "helper" && runtimeDoc.agent.connectors.includes("slack"),
      runtimeDoc.ok ? "" : runtimeDoc.error);

    return harnessResponse(harness);
  } catch (error) {
    return harnessError(harness, error);
  }
}
