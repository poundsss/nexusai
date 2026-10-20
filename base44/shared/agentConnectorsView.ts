// G-K3: the Builder per-agent "Connectors tab" DERIVATION contract (the P-9.11K UI surface).
//
// Base44 documents the tab's BEHAVIOR (docs.base44.com, in-app agents): "Use the Connectors tab
// to let your app users connect their own external accounts to the agent via OAuth", "If a user
// connector is already set up in your workspace, it appears in the Connectors tab automatically",
// and "The Connectors tab also shows which backend functions are using each connector." It
// publishes NO usage-detection mechanism, NO storage layout and NO API for this view (UNKNOWN) —
// so this module invents none of those: it is a PURE, deterministic projection over the project's
// own files, composed ONLY of already-certified resource contracts:
//   • enabled ....... collectAgents (P-9.11K owned key `connectors`, parseAgentDocument);
//   • available ..... collectConnectors (the project's own connector declarations — the
//                     "already set up" registry; a malformed document is reported, never skipped);
//   • usage ......... a bounded static scan of the project's own backend-function sources for
//                     the DOCUMENTED call forms only: the app-user SDK call
//                     `getCurrentAppUserConnection("<connector>")` (docs.base44.com, app-user
//                     connectors) and the existing `integrations.<name>.` member-call precedent
//                     (the audited IntegrationsPane usage analysis). No runtime observation,
//                     no new entity, no connector-usage model — a name either appears in a
//                     function's source in one of those two forms or it does not;
//   • toggle ........ applyAgentConnectorToggle re-emits the agent document canonically
//                     (2-space JSON + trailing newline, the same emit form as
//                     agentDocumentContent) and validates the result through parseAgentDocument
//                     fail-closed. Persistence itself rides the EXISTING journalled commit path
//                     (collaboration.ts commitMemberEdit) — no second write API, no new storage,
//                     and the P-9.11K runtime contract (connect_link, payload.connectors,
//                     entitlement gates) is untouched.
import { parseJsonc, CONNECTOR_NAME_RE } from "./base44Layout.ts";
import { parseAgentDocument, collectAgents } from "./agentResource.ts";
import { collectConnectors } from "./connectorResource.ts";
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The static usage scan: for each connector name, every backend function (either layout shape)
 * whose source uses it in one of the two documented call forms. Deterministic: a function is
 * attributed or not by its own source text, and the result is sorted by function name.
 * `connectorNames` defaults to the project's declared connector registry.
 */
export function connectorUsageScan(files, connectorNames = null) {
  const registry = collectConnectors(files).connectors.map((c) => c.name);
  const names = Array.isArray(connectorNames) ? connectorNames.map(String) : registry;
  const functionFiles = (files || []).filter((f) => f && isFunctionPath(f.path));
  const usage = {};
  for (const name of names) {
    const re = new RegExp(`(?:\\bgetCurrentAppUserConnection\\s*\\(\\s*["']${escapeRe(name)}["']|\\bintegrations\\s*\\.\\s*${escapeRe(name)}\\s*\\.)`);
    const users = functionFiles
      .filter((f) => re.test(String(f.content || "")))
      .map((f) => functionNameFromPath(f.path))
      .sort();
    if (users.length) usage[name] = users;
  }
  return usage;
}

/**
 * THE Connectors-tab projection for one project's files: every declared in-app agent with its
 * enabled connectors (the owned `connectors` key), the available registry, and per-connector
 * backend-function usage. Malformed agent or connector documents are reported in the errors
 * arrays, never silently skipped.
 */
export function agentConnectorsView(files) {
  const { agents, errors: agentErrors } = collectAgents(files);
  const { connectors, errors: connectorErrors } = collectConnectors(files);
  const usage = connectorUsageScan(files, connectors.map((c) => c.name));
  return {
    agents: agents.map((a) => ({
      name: a.name,
      path: a.path,
      enabled: [...(a.connectors || [])],
      available: connectors.map((c) => c.name),
      connectors: connectors.map((c) => ({
        name: c.name,
        enabled: (a.connectors || []).includes(c.name),
        used_by: usage[c.name] || [],
      })),
    })),
    agent_errors: agentErrors,
    connector_errors: connectorErrors,
  };
}

/**
 * The toggle primitive: ONE connector name added to or removed from the agent document's
 * `connectors` array, re-emitted canonically. Fail-closed on BOTH ends — the original must
 * parse as a valid agent document, the connector name must be a valid lowerCamelCase name, and
 * the result must re-parse through parseAgentDocument before it is returned. The empty state
 * drops the key, exactly as the canonical emitter (agentDocumentContent) omits an empty array.
 */
export function applyAgentConnectorToggle(path, text, connectorName, enabled) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const parsed = parseAgentDocument(path, text);
  if (!parsed.ok) fail("AGENT_DOCUMENT_INVALID", `${path} ${parsed.error}`);
  const name = String(connectorName || "");
  if (!CONNECTOR_NAME_RE.test(name)) {
    fail("AGENT_CONNECTOR_NAME_INVALID", `'${name}' is not a valid connector name (lowerCamelCase, e.g. googleCalendar)`);
  }
  const doc = parseJsonc(text);
  const current = Array.isArray(doc.connectors) ? doc.connectors.map(String) : [];
  const next = enabled ? [...new Set([...current, name])] : current.filter((c) => c !== name);
  const out = { ...doc };
  if (next.length) out.connectors = next;
  else delete out.connectors;
  const outText = `${JSON.stringify(out, null, 2)}\n`;
  const revalidated = parseAgentDocument(path, outText);
  if (!revalidated.ok) fail("AGENT_DOCUMENT_INVALID", `${path} ${revalidated.error}`);
  return outText;
}