// THE Base44 connector RESOURCE contract (E12).
//
// One connector per file: `base44/connectors/<name>.jsonc`, the FILE NAME being the connector's
// identity. This module is a RESOURCE layer only — it owns the canonical document, its parse, its
// deterministic emit and the projection onto the runtime. It deliberately owns NO validator, NO
// credential handling and NO execution:
//
//   definition  → shared/integrations.ts `normalizeIntegration` (the ONE validator, unchanged)
//   credentials → the same `auth.secret` / `auth.client_secret` NAME references, so a value can
//                 never enter a connector document (the normalizer refuses it) and secrets keep
//                 living in ProjectSecret exactly as before
//   runtime     → the EXISTING integration runtime, reached through the project's own
//                 `integrations/<name>.json` file, which this layer PROJECTS from the connector
//                 document. No second connector runtime is created, so tools, retries, quotas,
//                 breakers, rate limits and observability behave identically
//   tools       → the existing `integrations.<name>.<operation>()` surface
//   permissions → the caller's existing authorization (resourceSync → authz); nothing here grants
//                 anything, and an agent's tool grants stay the E10 gate's business
//
// A NexusAI project that has only `integrations/<name>.json` keeps working untouched: nothing here
// creates a connector document for it, and the runtime never requires one.
import { activeFiles } from "./projectFs.ts";
import { parseJsonc, isConnectorFilePath, connectorNameFromPath, connectorFilePath, CONNECTORS_DIR } from "./base44Layout.ts";
import { normalizeIntegration, serializeIntegration, integrationPath, integrationNameFromPath, isIntegrationPath, secretRefs, INTEGRATION_NAME_RE } from "./integrations.ts";

export { isConnectorFilePath, connectorNameFromPath, connectorFilePath, CONNECTORS_DIR };

const fail = (error, details = {}) => ({ ok: false, error, details });

/**
 * Parses ONE connector document. The PATH decides the connector's identity, and the document is
 * validated by the EXISTING integration normalizer — so a connector resource can never describe
 * something the runtime would refuse to execute.
 */
export function parseConnectorDocument(path, text) {
  const p = String(path || "");
  if (!isConnectorFilePath(p)) return fail("is not a canonical connector path (expected base44/connectors/<name>.jsonc)", { path: p });
  const identity = connectorNameFromPath(p);
  if (!INTEGRATION_NAME_RE.test(identity)) return fail(`has an invalid connector name '${identity}' (lowerCamelCase, e.g. weather)`, { path: p });

  let raw;
  try { raw = parseJsonc(text); } catch (e) { return fail(`is not valid JSONC: ${e.message}`, { path: p }); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("must be a JSON object", { path: p });
  if (raw.name != null && String(raw.name) !== identity) {
    return fail(`declares connector '${raw.name}' but its file name says '${identity}'`, { path: p, declared_name: String(raw.name), expected_name: identity });
  }

  let connector;
  try { connector = normalizeIntegration({ ...raw, name: identity }); }
  catch (e) { return fail(e.message.replace(/^integration:\s*/, ""), { path: p }); }
  return { ok: true, connector: { ...connector, path: p }, secret_refs: secretRefs(connector) };
}

/**
 * The canonical document text of one connector. Deterministic: the normalizer fixes both the field
 * set and its order, so emitting the same connector twice is byte-identical and a pull/push
 * round-trip produces no phantom change.
 */
export function connectorDocumentContent(connector) {
  const { path: _p, ...doc } = connector || {};
  return serializeIntegration(normalizeIntegration(doc));
}

/**
 * THE runtime projection: the `integrations/<name>.json` file the EXISTING integration runtime
 * already loads. The connector document is authoritative; this is its materialization, which is why
 * declaring a connector resource needs no runtime change at all.
 */
export const connectorRuntimePath = (name) => integrationPath(name);
export function connectorRuntimeContent(connector) {
  const { path: _p, ...doc } = connector || {};
  return serializeIntegration(normalizeIntegration(doc));
}

/** Every connector a project declares. Malformed documents are reported, never skipped. */
export function collectConnectors(files) {
  const connectors = [];
  const errors = [];
  for (const f of files || []) {
    if (!isConnectorFilePath(f.path)) continue;
    const parsed = parseConnectorDocument(f.path, f.content || "");
    if (parsed.ok) connectors.push(parsed.connector);
    else errors.push({ path: f.path, error: `${f.path} ${parsed.error}`, details: parsed.details || {} });
  }
  connectors.sort((a, b) => a.name.localeCompare(b.name));
  return { connectors, errors, count: connectors.length };
}

/** Resolves ONE connector from a project's files. `null` when the project does not declare it. */
export function resolveConnector(files, name) {
  const file = (files || []).find((f) => f.path === connectorFilePath(String(name || "")));
  if (!file) return null;
  const parsed = parseConnectorDocument(file.path, file.content || "");
  return parsed.ok ? parsed.connector : null;
}

/**
 * ADOPTION: an existing NexusAI `integrations/<name>.json` that has no connector document yet,
 * expressed as the connector resource it corresponds to. This is what lets a legacy project be
 * pulled into the Base44 layout without rewriting anything it already has.
 */
export function adoptableConnectors(fs) {
  const files = activeFiles(fs);
  const declared = new Set(files.filter((f) => isConnectorFilePath(f.path)).map((f) => connectorNameFromPath(f.path)));
  const out = [];
  for (const f of files) {
    if (!isIntegrationPath(f.path)) continue;
    const name = integrationNameFromPath(f.path);
    if (declared.has(name)) continue;
    let doc;
    try { doc = normalizeIntegration({ ...JSON.parse(f.content), name }); } catch { continue; }   // invalid files are the build's business
    out.push({ name, path: connectorFilePath(name), content: connectorDocumentContent(doc), runtime_path: f.path });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}