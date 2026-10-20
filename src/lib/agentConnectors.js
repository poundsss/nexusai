// Client-side mirror of base44/shared/agentConnectorsView.ts — the G-K3 Builder "Connectors
// tab" projection. The shared module is the certified authority (appAgentConnectorsUiParityTest);
// this pure mirror exists because base44/ is server-side only and never enters the client bundle.
// Everything is derived from the files the Builder already loaded (useProjectData) — zero new
// requests, zero new storage. Toggles persist through the existing projectEdit commit path, so
// the server's build validation remains the fail-closed authority for anything this light parse
// accepts (a document the resource layer would refuse is refused there, with the error surfaced).

const AGENT_PATH_RE = /^base44\/agents\/([a-z][a-z0-9-]*)\.jsonc$/;
const CONNECTOR_PATH_RE = /^base44\/connectors\/([a-z][a-zA-Z0-9_]*)\.jsonc$/;
const CONNECTOR_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;
const FUNCTION_PATH_RES = [
  /^base44\/functions\/([a-zA-Z][a-zA-Z0-9_]*)\/entry\.ts$/,
  /^functions\/([a-zA-Z][a-zA-Z0-9_]*)\.js$/,
];

// Mirrors the platform's JSONC reader: comments are stripped string-aware, trailing commas are
// legal, so a `//` inside a URL is never mistaken for a comment.
export function parseJsonc(text) {
  const src = String(text ?? "");
  let out = "";
  let inString = false, quote = "", inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; continue; }
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quote = c; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function docOf(file) {
  try {
    const doc = parseJsonc(file.content);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
  } catch { return null; }
}

/** Every declared in-app agent file with its `connectors` array (empty when absent/invalid). */
export function agentConnectorDocs(files) {
  return (files || [])
    .filter((f) => AGENT_PATH_RE.test(f.path))
    .map((f) => {
      const doc = docOf(f);
      const connectors = doc && Array.isArray(doc.connectors)
        ? doc.connectors.filter((c) => typeof c === "string" && CONNECTOR_NAME_RE.test(c))
        : [];
      return {
        name: f.path.slice("base44/agents/".length).replace(/\.jsonc$/, ""),
        path: f.path,
        content: f.content,
        connectors,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The project's own connector declarations — the "already set up" registry. */
export function connectorDocs(files) {
  return (files || [])
    .filter((f) => CONNECTOR_PATH_RE.test(f.path))
    .map((f) => ({ name: f.path.slice("base44/connectors/".length).replace(/\.jsonc$/, ""), path: f.path }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The audited static usage scan, over the same documented call forms as the server contract. */
export function connectorUsage(files, names) {
  const functionFiles = (files || []).filter((f) => FUNCTION_PATH_RES.some((r) => r.test(f.path)));
  const usage = {};
  for (const name of names || []) {
    const re = new RegExp(`(?:\\bgetCurrentAppUserConnection\\s*\\(\\s*["']${escapeRe(name)}["']|\\bintegrations\\s*\\.\\s*${escapeRe(name)}\\s*\\.)`);
    const users = functionFiles
      .filter((f) => re.test(String(f.content || "")))
      .map((f) => (FUNCTION_PATH_RES.find((r) => r.test(f.path)).exec(f.path) || [null, ""])[1])
      .sort();
    if (users.length) usage[name] = users;
  }
  return usage;
}

/** Toggle one connector in an agent document, re-emitted canonically (the toggle primitive). */
export function toggleConnectors(text, connectorName, enabled) {
  const name = String(connectorName || "");
  if (!CONNECTOR_NAME_RE.test(name)) throw new Error(`'${name}' is not a valid connector name`);
  const doc = parseJsonc(text);
  const current = Array.isArray(doc.connectors) ? doc.connectors.map(String) : [];
  const next = enabled ? [...new Set([...current, name])] : current.filter((c) => c !== name);
  const out = { ...doc };
  if (next.length) out.connectors = next;
  else delete out.connectors;
  return `${JSON.stringify(out, null, 2)}\n`;
}