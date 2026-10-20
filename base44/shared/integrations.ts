// Integrations are first-class project artifacts stored as integrations/<name>.json.
// Like backend functions they are ordinary project files, so they inherit the virtual
// filesystem, build validation, commit, version snapshot, rollback and authorization paths
// with no parallel machinery. The JSON document is the integration's METADATA ONLY:
// credentials are referenced by project-secret NAME and never stored here.
import { activeFiles } from "./projectFs.ts";
import { parseJsonOrYaml } from "./yaml.ts";
import { unpackFileContent } from "./blobStore.ts";
import { isFunctionPath, functionNameFromPath } from "./functionPaths.ts";

export const INTEGRATIONS_DIR = "integrations/";
export const INTEGRATION_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;
export const OPERATION_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const integrationPath = (name) => `${INTEGRATIONS_DIR}${name}.json`;
export const isIntegrationPath = (p) => p.startsWith(INTEGRATIONS_DIR) && p.endsWith(".json");
export const integrationNameFromPath = (p) => p.slice(INTEGRATIONS_DIR.length, -5);

export const INTEGRATION_TYPES = ["http", "openapi", "mcp"];
export const AUTH_TYPES = ["none", "api_key", "bearer", "oauth2"];
export const OAUTH2_GRANTS = ["client_credentials", "refresh_token"];
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const PARAM_LOCATIONS = ["path", "query", "header"];
const MAX_OPERATIONS = 60;
const MAX_TIMEOUT_MS = 12000;

const fail = (msg) => { throw new Error(`integration: ${msg}`); };

function normalizeParameter(p, opName) {
  if (!p || typeof p !== "object" || !p.name) fail(`operation '${opName}' has a parameter without a name`);
  const location = String(p.in || "query");
  if (!PARAM_LOCATIONS.includes(location)) fail(`operation '${opName}' parameter '${p.name}' has invalid location '${p.in}' (use ${PARAM_LOCATIONS.join(", ")})`);
  return {
    name: String(p.name), in: location, required: location === "path" ? true : !!p.required,
    type: String(p.type || "string"), ...(p.description ? { description: String(p.description) } : {}),
  };
}

function normalizeOperation(op, seen) {
  if (!op || typeof op !== "object") fail("each operation must be an object");
  const name = String(op.name || "");
  if (!OPERATION_NAME_RE.test(name)) fail(`operation name '${name}' must be lowerCamelCase, e.g. getForecast`);
  if (seen.has(name)) fail(`duplicate operation name '${name}'`);
  seen.add(name);
  const method = String(op.method || "GET").toUpperCase();
  if (!HTTP_METHODS.includes(method)) fail(`operation '${name}' has invalid method '${op.method}' (use ${HTTP_METHODS.join(", ")})`);
  let path = String(op.path || "");
  if (!path.startsWith("/")) path = "/" + path;
  const params = (Array.isArray(op.parameters) ? op.parameters : []).map((p) => normalizeParameter(p, name));
  // Every {placeholder} in the path is a required path parameter, declared or not.
  for (const m of path.matchAll(/\{([A-Za-z_][\w-]*)\}/g)) {
    if (!params.some((p) => p.in === "path" && p.name === m[1])) params.push({ name: m[1], in: "path", required: true, type: "string" });
  }
  let requestBody = op.request_body && typeof op.request_body === "object" ? op.request_body : null;
  // Planner-friendly shorthand: body_fields: [{ name, type, required, description }]
  if (!requestBody && Array.isArray(op.body_fields) && op.body_fields.length) {
    const properties = {}; const required = [];
    for (const f of op.body_fields) { if (!f?.name) continue; properties[f.name] = { type: f.type || "string", ...(f.description ? { description: f.description } : {}) }; if (f.required) required.push(f.name); }
    requestBody = { content_type: "application/json", schema: { type: "object", properties, ...(required.length ? { required } : {}) } };
  }
  return {
    name, method, path, description: String(op.description || ""), parameters: params,
    // Marks a POST/PATCH as safe to retry (the upstream is idempotent for this operation).
    // GET/PUT/DELETE are treated as idempotent without the flag.
    ...(op.idempotent === true ? { idempotent: true } : {}),
    ...(requestBody ? { request_body: requestBody } : {}),
    ...(op.response_schema && typeof op.response_schema === "object" ? { response_schema: op.response_schema } : {}),
  };
}

// An MCP operation is a named binding to a tool the server exposes: `tool` is the remote
// tool name and `input_schema` is the tool's own JSON schema (used for input validation and
// for teaching the generated code what to pass).
function normalizeMcpOperation(op, seen) {
  if (!op || typeof op !== "object") fail("each operation must be an object");
  const name = String(op.name || "");
  if (!OPERATION_NAME_RE.test(name)) fail(`operation name '${name}' must be lowerCamelCase, e.g. searchIssues`);
  if (seen.has(name)) fail(`duplicate operation name '${name}'`);
  seen.add(name);
  const tool = String(op.tool || op.tool_name || name);
  if (!/^[\w.:-]{1,120}$/.test(tool)) fail(`operation '${name}' has an invalid MCP tool name '${tool}'`);
  let schema = op.input_schema;
  if (typeof schema === "string") { try { schema = JSON.parse(schema); } catch { fail(`operation '${name}' has an input_schema that is not valid JSON`); } }
  if (schema && typeof schema !== "object") fail(`operation '${name}' input_schema must be an object`);
  return {
    name, tool, description: String(op.description || ""),
    input_schema: schema && typeof schema === "object" ? schema : { type: "object" },
    ...(op.read_only ? { read_only: true } : {}),
  };
}

// Retry policy for transient upstream failures. Bounded on purpose: an integration cannot
// configure itself into an unbounded retry storm against a third party.
function normalizeRetry(retry) {
  const r = retry && typeof retry === "object" ? retry : {};
  const max_attempts = Math.min(3, Math.max(1, Number(r.max_attempts) || 2));
  const statuses = Array.isArray(r.retry_on_status) && r.retry_on_status.length
    ? [...new Set(r.retry_on_status.map(Number).filter((s) => s >= 400 && s <= 599))]
    : [408, 425, 429, 500, 502, 503, 504];
  return { max_attempts, retry_on_status: statuses, backoff_ms: Math.min(2000, Math.max(50, Number(r.backoff_ms) || 200)) };
}

// Per-project integration call quota (#31D). Bounded to the same limits the quota layer enforces,
// so a project may tune its allowance but can never configure an unbounded quota. `enabled: false`
// is preserved verbatim — it is the only way a project opts a busy integration out of the quota.
const QUOTA_LIMIT_BOUNDS = [1, 100_000];
const QUOTA_WINDOW_BOUNDS = [1_000, 86_400_000];
const QUOTA_DEFAULTS = { limit: 1000, window_ms: 3_600_000 };
function clampBounded(value, [lo, hi], fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}
function normalizeQuota(quota) {
  const q = quota && typeof quota === "object" ? quota : {};
  if (q.enabled === false) return { enabled: false, ...QUOTA_DEFAULTS };
  return {
    enabled: true,
    limit: clampBounded(q.limit ?? q.calls ?? q.max_calls, QUOTA_LIMIT_BOUNDS, QUOTA_DEFAULTS.limit),
    window_ms: clampBounded(q.window_ms, QUOTA_WINDOW_BOUNDS, QUOTA_DEFAULTS.window_ms),
  };
}

// Delegated OAuth block (P-9.9 App User Connectors): how a connector's END-USERS authorize
// their OWN external account, so calls run as the individual app user instead of a shared
// credential. Same rule as every other credential surface: secret NAMES only — a value here
// can never parse, and the values keep living exclusively in ProjectSecret.
function normalizeDelegatedOauth(block, integrationName) {
  if (block === undefined || block === null) return null;
  if (!block || typeof block !== "object" || Array.isArray(block)) fail("delegated_oauth must be an object");
  if ("value" in block || "token" in block || "key" in block || "client_secret_value" in block || "client_id" in block) {
    fail("delegated_oauth must reference project secrets by NAME (client_id_secret / client_secret_secret) — never carry a credential value");
  }
  const endpoint = (v, what) => {
    let u;
    try { u = new URL(String(v || "")); } catch { fail(`delegated_oauth.${what} '${v}' is not a valid absolute URL`); }
    if (!["http:", "https:"].includes(u.protocol)) fail(`delegated_oauth.${what} must use http or https`);
    return u.toString();
  };
  const clientIdSecret = String(block.client_id_secret || "");
  if (!SECRET_NAME_RE.test(clientIdSecret)) fail(`delegated_oauth.client_id_secret for '${integrationName}' must be an UPPER_SNAKE_CASE project secret NAME`);
  if (block.client_secret_secret !== undefined && block.client_secret_secret !== null && block.client_secret_secret !== "" && !SECRET_NAME_RE.test(String(block.client_secret_secret))) {
    fail("delegated_oauth.client_secret_secret must be an UPPER_SNAKE_CASE project secret NAME, never a value");
  }
  return {
    authorization_endpoint: endpoint(block.authorization_endpoint, "authorization_endpoint"),
    token_endpoint: endpoint(block.token_endpoint, "token_endpoint"),
    ...(block.revoke_endpoint ? { revoke_endpoint: endpoint(block.revoke_endpoint, "revoke_endpoint") } : {}),
    client_id_secret: clientIdSecret,
    ...(block.client_secret_secret ? { client_secret_secret: String(block.client_secret_secret) } : {}),
    scopes: Array.isArray(block.scopes) ? block.scopes.map((s) => String(s).slice(0, 80)).filter(Boolean) : [],
    pkce: block.pkce !== false,
  };
}

function normalizeAuth(auth, integrationName) {
  const a = auth && typeof auth === "object" ? auth : { type: "none" };
  const type = String(a.type || "none");
  if (!AUTH_TYPES.includes(type)) fail(`auth.type '${a.type}' is invalid (use ${AUTH_TYPES.join(", ")})`);
  if ("value" in a || "token" in a || "key" in a || "client_secret_value" in a) fail("auth must reference a project secret by NAME (auth.secret) — never carry a credential value");
  if (type === "none") return { type: "none" };
  const secret = String(a.secret || "");
  if (!SECRET_NAME_RE.test(secret)) fail(`auth.secret for '${integrationName}' must be an UPPER_SNAKE_CASE project secret name, e.g. ${integrationName.toUpperCase()}_API_KEY`);
  // OAuth2 machine-to-machine auth. The platform exchanges the stored credential for a
  // short-lived access token at call time; the token is never stored, never returned and
  // never visible to generated code.
  if (type === "oauth2") {
    const grant = String(a.grant || "client_credentials");
    if (!OAUTH2_GRANTS.includes(grant)) fail(`auth.grant '${a.grant}' is invalid (use ${OAUTH2_GRANTS.join(", ")})`);
    let tokenUrl;
    try { tokenUrl = new URL(String(a.token_url || "")); } catch { fail(`auth.token_url '${a.token_url}' is not a valid absolute URL`); }
    if (!["http:", "https:"].includes(tokenUrl.protocol)) fail("auth.token_url must use http or https");
    const clientId = String(a.client_id || "");
    if (!clientId) fail("oauth2 auth needs auth.client_id (the public client identifier)");
    if (a.client_secret !== undefined && a.client_secret !== null && a.client_secret !== "" && !SECRET_NAME_RE.test(String(a.client_secret))) {
      fail("auth.client_secret must be an UPPER_SNAKE_CASE project secret NAME (the extra secret used with a refresh token), never a value");
    }
    return {
      type, grant, token_url: tokenUrl.toString(), client_id: clientId, secret,
      ...(a.client_secret ? { client_secret: String(a.client_secret) } : {}),
      ...(a.scope ? { scope: String(a.scope) } : {}),
      ...(a.audience ? { audience: String(a.audience) } : {}),
      credentials_in: a.credentials_in === "basic_header" ? "basic_header" : "body",
    };
  }
  if (type === "bearer") return { type, secret };
  const where = String(a.in || "header");
  if (!["header", "query"].includes(where)) fail("auth.in must be 'header' or 'query' for api_key auth");
  return { type, secret, in: where, header_name: String(a.header_name || a.name || (where === "header" ? "X-API-Key" : "api_key")) };
}

// Validates and canonicalizes an integration document. Throws with an actionable message.
export function normalizeIntegration(input) {
  const doc = input && typeof input === "object" ? input : fail("definition must be an object");
  const name = String(doc.name || "");
  if (!INTEGRATION_NAME_RE.test(name)) fail(`name '${name}' must be lowerCamelCase, e.g. weather`);
  const type = String(doc.type || "http");
  if (!INTEGRATION_TYPES.includes(type)) fail(`type '${doc.type}' is invalid (use ${INTEGRATION_TYPES.join(", ")})`);
  let base_url = String(doc.base_url || "").trim().replace(/\/+$/, "");
  // An MCP integration addresses a JSON-RPC endpoint, not a REST base path, so it declares
  // server_url and tool operations instead of base_url and method/path operations.
  let server_url = "";
  if (type === "mcp") {
    let u; try { u = new URL(String(doc.server_url || base_url || "")); } catch { fail(`server_url '${doc.server_url || doc.base_url || ""}' is not a valid absolute URL`); }
    if (!["http:", "https:"].includes(u.protocol)) fail("server_url must use http or https");
    server_url = u.toString();
    base_url = "";
  } else {
    let u; try { u = new URL(base_url); } catch { fail(`base_url '${doc.base_url}' is not a valid absolute URL`); }
    if (!["http:", "https:"].includes(u.protocol)) fail("base_url must use http or https");
  }
  const headers = {};
  for (const [k, v] of Object.entries(doc.headers || {})) {
    if (/^(authorization|proxy-authorization|cookie)$/i.test(k) || /api[-_]?key|token|secret/i.test(k)) fail(`static header '${k}' looks like a credential — use auth with a secret reference instead`);
    headers[k] = String(v);
  }
  const timeout_ms = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(doc.timeout_ms) || MAX_TIMEOUT_MS));
  const status = doc.status === "disabled" ? "disabled" : "active";
  const seen = new Set();
  const ops = Array.isArray(doc.operations) ? doc.operations : [];
  if (ops.length > MAX_OPERATIONS) fail(`too many operations (${ops.length}); an integration may declare at most ${MAX_OPERATIONS}`);
  const operations = ops.map((op) => (type === "mcp" ? normalizeMcpOperation(op, seen) : normalizeOperation(op, seen)));
  const auth = normalizeAuth(doc.auth, name);
  if (type === "mcp" && auth.type === "api_key" && auth.in === "query") fail("an MCP server is authenticated with a header or a bearer token, not a query parameter");
  return {
    name, type, description: String(doc.description || ""), base_url, ...(type === "mcp" ? { server_url } : {}),
    auth, headers, timeout_ms, status, retry: normalizeRetry(doc.retry), operations,
    // P-9.9: present only when the connector declares an end-user delegated OAuth flow.
    ...(doc.delegated_oauth ? { delegated_oauth: normalizeDelegatedOauth(doc.delegated_oauth, name) } : {}),
    ...(doc.quota ? { quota: normalizeQuota(doc.quota) } : {}),
    ...(doc.source && typeof doc.source === "object" ? { source: { ...(doc.source.openapi_url ? { openapi_url: String(doc.source.openapi_url) } : {}), ...(doc.source.spec_version ? { spec_version: String(doc.source.spec_version) } : {}), ...(doc.source.title ? { title: String(doc.source.title) } : {}) } } : {}),
  };
}

// Every project-secret NAME an integration depends on (an oauth2 refresh-token setup may
// need two). Used to declare the requirements and to load the right rows at execution time.
export function secretRefs(doc) {
  return [doc?.auth?.secret, doc?.auth?.client_secret].filter(Boolean);
}

export function serializeIntegration(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

export function parseIntegrationFile(path, content) {
  let raw;
  try { raw = JSON.parse(content); } catch (e) { throw new Error(`${path}: invalid JSON — ${e.message}`); }
  const doc = normalizeIntegration(raw);
  if (doc.name !== integrationNameFromPath(path)) throw new Error(`${path}: integration name '${doc.name}' must match the file name`);
  return doc;
}

// Static usage scan: which backend functions call which integration operations.
export const INTEGRATION_CALL_RE = /\bintegrations\s*\.\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g;
export function integrationCallsIn(content) {
  const out = [];
  for (const m of content.matchAll(INTEGRATION_CALL_RE)) out.push({ integration: m[1], operation: m[2] });
  return out;
}

// Metadata view of every integration in the project (for AI tools, context and the UI).
// id / created / updated come from the ProjectFile record when one exists.
export function describeIntegrations(fs) {
  const files = activeFiles(fs);
  const functions = files.filter((f) => isFunctionPath(f.path));
  return files.filter((f) => isIntegrationPath(f.path)).map((f) => {
    const rec = fs.files.get(f.path);
    const base = { id: rec?.id || null, path: f.path, name: integrationNameFromPath(f.path) };
    let doc;
    try { doc = parseIntegrationFile(f.path, f.content); } catch (e) { return { ...base, error: e.message }; }
    const used_by = functions.filter((fn) => integrationCallsIn(fn.content).some((c) => c.integration === doc.name)).map((fn) => functionNameFromPath(fn.path));
    return { ...base, ...doc, secret_ref: doc.auth.secret || null, secret_refs: secretRefs(doc), operation_count: doc.operations.length, used_by };
  });
}

// Parsed, valid integrations only — what the runtime executes against.
export function integrationsFromFs(fs) {
  return describeIntegrations(fs).filter((i) => !i.error);
}

export async function loadProjectIntegrations(client, projectId) {
  const rows = await client.entities.ProjectFile.filter({ project_id: projectId }, "path", 500);
  const out = [];
  for (const r of rows) {
    if (!isIntegrationPath(r.path)) continue;
    try { out.push(parseIntegrationFile(r.path, await unpackFileContent(r))); } catch { /* invalid files are reported by the build, not executed */ }
  }
  return out;
}

// --- OpenAPI import -----------------------------------------------------------
// OpenAPI 3.x (and basic Swagger 2.0) JSON → normalized integration. Generic by design:
// no provider registry; whatever the document declares becomes operations.

function derefFactory(doc) {
  const lookup = (ref) => ref.startsWith("#/") ? ref.slice(2).split("/").reduce((o, k) => (o == null ? undefined : o[k.replace(/~1/g, "/").replace(/~0/g, "~")]), doc) : undefined;
  const deref = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 6) return node;
    if (Array.isArray(node)) return node.map((n) => deref(n, depth + 1));
    if (typeof node.$ref === "string") { const target = lookup(node.$ref); return target ? deref(target, depth + 1) : { type: "object", $ref: node.$ref }; }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = deref(v, depth + 1);
    return out;
  };
  return deref;
}

function operationName(op, method, path, taken) {
  let base = op.operationId ? String(op.operationId).replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")) : "";
  if (!base) {
    const segs = path.split("/").filter(Boolean).map((s) => s.startsWith("{") ? "By" + s.slice(1, -1).replace(/^./, (c) => c.toUpperCase()) : s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toUpperCase()));
    base = method.toLowerCase() + (segs.join("") || "Root");
  }
  base = base.replace(/^[^a-zA-Z]+/, "").replace(/^./, (c) => c.toLowerCase()) || "operation";
  let name = base; let i = 2;
  while (taken.has(name)) name = `${base}${i++}`;
  taken.add(name);
  return name;
}

function authFromSecurity(doc, security, name, secretOverride) {
  const schemes = doc.components?.securitySchemes || doc.securityDefinitions || {};
  const req = Array.isArray(security) && security.length ? security[0] : null;
  const schemeName = req ? Object.keys(req)[0] : Object.keys(schemes)[0];
  const scheme = schemeName ? schemes[schemeName] : null;
  if (!scheme) return { type: "none" };
  if (scheme.type === "apiKey") {
    const where = scheme.in === "query" ? "query" : "header";
    if (scheme.in === "cookie") return { type: "none" };
    return { type: "api_key", secret: secretOverride || `${name.toUpperCase()}_API_KEY`, in: where, header_name: scheme.name || (where === "header" ? "X-API-Key" : "api_key") };
  }
  if ((scheme.type === "http" && /bearer/i.test(scheme.scheme || "")) || scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    return { type: "bearer", secret: secretOverride || `${name.toUpperCase()}_TOKEN` };
  }
  return { type: "none" };
}

export function importOpenApi(document, { name, description, base_url, secret, openapi_url } = {}) {
  let doc = document;
  let format = "object";
  // JSON and YAML specifications converge here: the document is parsed to plain data and
  // then validated by exactly the same normalizer.
  if (typeof doc === "string") {
    let parsed;
    try { parsed = parseJsonOrYaml(doc, "OpenAPI document"); } catch (e) { fail(e.message.replace(/^yaml: /, "YAML error: ")); }
    doc = parsed.value; format = parsed.format;
  }
  if (!doc || typeof doc !== "object" || !doc.paths) fail("OpenAPI document has no 'paths' — is this really an OpenAPI/Swagger document?");
  const specVersion = doc.openapi ? String(doc.openapi) : doc.swagger ? `swagger ${doc.swagger}` : "unknown";
  const deref = derefFactory(doc);

  let resolvedBase = base_url;
  if (!resolvedBase) {
    if (Array.isArray(doc.servers) && doc.servers[0]?.url) {
      resolvedBase = String(doc.servers[0].url).replace(/\{[^}]+\}/g, (m) => { const v = m.slice(1, -1); return doc.servers[0].variables?.[v]?.default ?? ""; });
    } else if (doc.host) {
      resolvedBase = `${(doc.schemes || ["https"])[0]}://${doc.host}${doc.basePath || ""}`;
    }
    if (resolvedBase && resolvedBase.startsWith("/") && openapi_url) resolvedBase = new URL(resolvedBase, openapi_url).toString();
    if (!resolvedBase && openapi_url) resolvedBase = new URL(openapi_url).origin;
  }
  if (!resolvedBase) fail("could not determine base_url from the document; pass base_url explicitly");

  const taken = new Set();
  const operations = [];
  let skipped = 0;
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== "object") continue;
    const shared = Array.isArray(item.parameters) ? item.parameters.map((p) => deref(p)) : [];
    for (const method of HTTP_METHODS) {
      const op = item[method.toLowerCase()];
      if (!op) continue;
      if (operations.length >= MAX_OPERATIONS) { skipped++; continue; }
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters.map((p) => deref(p)) : [])];
      const parameters = []; let requestBody = null;
      for (const p of params) {
        if (!p?.name) continue;
        if (p.in === "body") { requestBody = { content_type: "application/json", schema: deref(p.schema) || { type: "object" } }; continue; }
        if (!PARAM_LOCATIONS.includes(p.in)) continue;
        parameters.push({ name: p.name, in: p.in, required: !!p.required, type: p.schema?.type || p.type || "string", ...(p.description ? { description: String(p.description).slice(0, 200) } : {}) });
      }
      const rb = op.requestBody ? deref(op.requestBody) : null;
      if (rb?.content) {
        const media = rb.content["application/json"] || Object.values(rb.content)[0];
        if (media?.schema) requestBody = { content_type: rb.content["application/json"] ? "application/json" : Object.keys(rb.content)[0], schema: media.schema };
      }
      let responseSchema = null;
      for (const code of Object.keys(op.responses || {})) {
        if (!/^2\d\d$/.test(code)) continue;
        const res = deref(op.responses[code]);
        responseSchema = res?.content?.["application/json"]?.schema || res?.schema || null;
        if (responseSchema) break;
      }
      operations.push({
        name: operationName(op, method, path, taken), method, path,
        description: String(op.summary || op.description || "").slice(0, 300), parameters,
        ...(requestBody ? { request_body: requestBody } : {}),
        ...(responseSchema ? { response_schema: responseSchema } : {}),
      });
    }
  }
  const integrationName = String(name || "").trim();
  const auth = authFromSecurity(doc, doc.security, integrationName, secret);
  const normalized = normalizeIntegration({
    name: integrationName, type: "openapi", description: description || doc.info?.description?.slice(0, 300) || doc.info?.title || "",
    base_url: resolvedBase, auth, operations,
    source: { ...(openapi_url ? { openapi_url } : {}), spec_version: specVersion, ...(doc.info?.title ? { title: String(doc.info.title) } : {}) },
  });
  return { integration: normalized, imported: operations.length, skipped, spec_version: specVersion, format };
}