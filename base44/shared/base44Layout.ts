// THE Base44 resource-layout contract.
//
// A project's non-frontend resources live under a single reserved directory, `base44/`, described
// by the project's own `base44/config.jsonc` manifest. This module owns nothing but the CONTRACT:
// which directories exist, which paths are resources, how the manifest is parsed and validated,
// and what a new project's manifest looks like. It reads no files, touches no database and knows
// nothing about builds — so every layer (filesystem, build, scaffold, index) can agree on paths
// without depending on each other.
//
// Legacy projects have no `base44/` directory at all. Nothing here creates one for them, and every
// helper answers `false` for a flat-layout path, so the old layout keeps working untouched.

export const BASE44_DIR = "base44/";
export const CONFIG_FILE = "base44/config.jsonc";
export const ENTITIES_DIR = "base44/entities/";
export const FUNCTIONS_DIR = "base44/functions/";
export const ACTORS_DIR = "base44/actors/";
export const AGENTS_DIR = "base44/agents/";
export const AGENT_SKILLS_DIR = "base44/agent-skills/";
export const CONNECTORS_DIR = "base44/connectors/";
export const AUTH_DIR = "base44/auth/";
export const ASSETS_DIR = "base44/assets/";
export const TYPES_DIR = "base44/.types/";

/**
 * APP metadata: `base44/.app.jsonc`. A SIBLING of the project manifest, never a replacement — the
 * manifest says where a project's resources live, this says what the deployed application is. Only
 * the PATH grammar lives here; the document contract is shared/appResource.ts.
 */
export const APP_CONFIG_FILE = "base44/.app.jsonc";
export const isAppConfigPath = (path) => String(path || "") === APP_CONFIG_FILE;

/**
 * Assets: ordinary static files under `base44/assets/`, addressed by their path below it. The
 * grammar is deliberately narrow — plain name segments with an extension, at most five levels deep
 * — so no asset path can escape the directory, hide a traversal or carry a query.
 */
export const ASSET_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isAssetPath(path) {
  const p = String(path || "");
  if (!p.startsWith(ASSETS_DIR)) return false;
  const rel = p.slice(ASSETS_DIR.length);
  if (!rel || rel.includes("..") || rel.endsWith("/")) return false;
  const segments = rel.split("/");
  if (segments.length > 5) return false;
  if (!segments.every((s) => ASSET_SEGMENT_RE.test(s))) return false;
  return /\.[A-Za-z0-9]+$/.test(segments[segments.length - 1]);
}
export const assetName = (path) => String(path || "").slice(ASSETS_DIR.length);
export const assetFilePath = (name) => `${ASSETS_DIR}${String(name || "").replace(/^\.?\//, "")}`;

/**
 * Context files (P-9.11D): plain reference files under `base44/context/`, addressed by
 * their path below it — builder-supplied reference material a declared agent names in its
 * `context_files` key. The same narrow grammar as assets, so no context path can escape the
 * directory, hide a traversal or carry a query. Base44 publishes the count (up to 10 per
 * agent) but not its storage layout (UNKNOWN) — this reserved directory is this platform's
 * own representation, classified out of the client bundle by the deploy path.
 */
export const CONTEXT_DIR = "base44/context/";
export function isContextFilePath(path) {
  const p = String(path || "");
  if (!p.startsWith(CONTEXT_DIR)) return false;
  const rel = p.slice(CONTEXT_DIR.length);
  if (!rel || rel.includes("..") || rel.endsWith("/")) return false;
  const segments = rel.split("/");
  if (segments.length > 5) return false;
  if (!segments.every((s) => ASSET_SEGMENT_RE.test(s))) return false;
  return /\.[A-Za-z0-9]+$/.test(segments[segments.length - 1]);
}

/** Every canonical resource directory, in manifest order. */
export const RESOURCE_DIRS = [ENTITIES_DIR, FUNCTIONS_DIR, ACTORS_DIR, AGENTS_DIR, AGENT_SKILLS_DIR, CONNECTORS_DIR, AUTH_DIR, TYPES_DIR];

/**
 * The manifest's directory fields, mapping a config key to its canonical directory.
 *
 * A manifest states each one as a BARE relative directory name, resolved against the manifest's own
 * directory — the platform contract's shape, and the reason a project cannot silently relocate a
 * resource kind outside `base44/`.
 */
export const RESOURCE_DIR_FIELDS = {
  entitiesDir: ENTITIES_DIR,
  functionsDir: FUNCTIONS_DIR,
  actorsDir: ACTORS_DIR,
  agentsDir: AGENTS_DIR,
  agentSkillsDir: AGENT_SKILLS_DIR,
  connectorsDir: CONNECTORS_DIR,
  authDir: AUTH_DIR,
};

/** The bare directory name a manifest field declares, e.g. entitiesDir -> "entities". */
export const bareDirName = (canonical) => canonical.slice(BASE44_DIR.length).replace(/\/$/, "");

/** Site build settings a project's manifest may carry. Values are commands, never executed here. */
export const SITE_FIELDS = ["installCommand", "buildCommand", "serveCommand", "outputDirectory"];

const DEFAULT_SITE = {
  installCommand: "npm install",
  buildCommand: "npm run build",
  serveCommand: "npm run dev",
  outputDirectory: "./dist",
};

export const VISIBILITIES = ["public", "private", "workspace"];

/**
 * Plugin configuration.
 *
 * `plugin` declares that THIS project IS a plugin, under its own namespace — the namespace the
 * project's resources are addressed by once another project installs it. `plugins` is the list of
 * plugin packages this project installs. Both are declarations only: nothing here loads, resolves or
 * executes a plugin, so a manifest can state them without any plugin runtime existing.
 */
export const PLUGIN_FIELDS = ["namespace"];

/** Plugin namespace grammar: letters, numbers, underscores and dashes. */
const PLUGIN_NAMESPACE_RE = /^[a-zA-Z0-9_-]+$/;

export const isBase44Path = (path) => String(path || "").startsWith(BASE44_DIR);
export const isConfigPath = (path) => String(path || "") === CONFIG_FILE;
export const isEntityFilePath = (path) => /^base44\/entities\/[A-Z][A-Za-z0-9_]*\.jsonc$/.test(String(path || ""));
export const isTypesPath = (path) => String(path || "").startsWith(TYPES_DIR);
/** Reserved-but-not-yet-supported resource directories. Rejected explicitly, never half-accepted. */
export const isUnsupportedResourcePath = (path) =>
  [AUTH_DIR].some((d) => String(path || "").startsWith(d));

/**
 * Actor resources (E8): `base44/actors/<Name>/entry.ts`, the DIRECTORY NAME being the actor's
 * identity. Only the PATH grammar lives here; the document contract is shared/actorResource.ts and
 * the stateful runtime is shared/actorRuntime.ts.
 */
export const ACTOR_ENTRY_FILE = "entry.ts";
export const isActorFilePath = (path) => /^base44\/actors\/[A-Z][A-Za-z0-9]*\/entry\.ts$/.test(String(path || ""));
export const actorNameFromPath = (path) => String(path || "").slice(ACTORS_DIR.length).replace(/\/entry\.ts$/, "");
export const actorFilePath = (name) => `${ACTORS_DIR}${name}/${ACTOR_ENTRY_FILE}`;

/**
 * Connector resources (E12): `base44/connectors/<name>.jsonc`, the FILE NAME being the connector's
 * identity — the same lowerCamelCase name the existing integration runtime already addresses it by.
 * Only the PATH grammar lives here; the document contract is shared/connectorResource.ts and the
 * definition is validated by the existing integration normalizer.
 */
export const CONNECTOR_NAME_RE = /^[a-z][a-zA-Z0-9_]*$/;
export const isConnectorFilePath = (path) => /^base44\/connectors\/[a-z][a-zA-Z0-9_]*\.jsonc$/.test(String(path || ""));
export const connectorNameFromPath = (path) => String(path || "").slice(CONNECTORS_DIR.length).replace(/\.jsonc$/, "");
export const connectorFilePath = (name) => `${CONNECTORS_DIR}${name}.jsonc`;

/**
 * Agent resources (E9): `base44/agents/<name>.jsonc`, the FILE NAME being the agent's identity.
 * Agent skills (E11): `base44/agent-skills/<name>.md`, one flat Markdown-with-frontmatter document
 * per skill — the FILE NAME (without `.md`) being the skill's identity. Only the PATH grammar lives
 * here; the document contracts are
 * shared/agentResource.ts and shared/agentSkillResource.ts.
 */
export const RESOURCE_NAME_RE = /^[a-z][a-z0-9-]*$/;
export const isAgentFilePath = (path) => /^base44\/agents\/[a-z][a-z0-9-]*\.jsonc$/.test(String(path || ""));
export const agentNameFromPath = (path) => String(path || "").slice(AGENTS_DIR.length).replace(/\.jsonc$/, "");
export const agentFilePath = (name) => `${AGENTS_DIR}${name}.jsonc`;
export const isAgentSkillFilePath = (path) => /^base44\/agent-skills\/[a-z][a-z0-9-]*\.md$/.test(String(path || ""));
export const agentSkillNameFromPath = (path) => String(path || "").slice(AGENT_SKILLS_DIR.length).replace(/\.md$/, "");
export const agentSkillFilePath = (name) => `${AGENT_SKILLS_DIR}${name}.md`;

/** The entity name a canonical schema path declares — the FILE NAME is the entity's identity. */
export const entityNameFromPath = (path) => String(path || "").slice(ENTITIES_DIR.length).replace(/\.jsonc$/, "");
export const entityFilePath = (name) => `${ENTITIES_DIR}${name}.jsonc`;

/** The ONE generated declarations file of a project. An editor artifact — never authoritative. */
export const typesFilePath = () => `${TYPES_DIR}types.d.ts`;

/**
 * THE conversion boundary between the platform's JSON Schema entity documents and NexusAI's
 * internal normalized field map.
 *
 * The internal representation is unchanged and stays authoritative: `{ name, fields }` where fields
 * is `{ fieldName: { type, required, enum?, description?, default? } }`. Only the FILE speaks JSON
 * Schema. Both directions live here, so no other layer can invent a second translation.
 *
 * `text` has no JSON Schema equivalent and is written as a plain string — the field-diff engine
 * treats string/text/date as one compatibility family, so this loses no data and produces no
 * migration. No custom keyword is invented to preserve it.
 */
const JSON_SCHEMA_TYPE = { string: "string", text: "string", number: "number", boolean: "boolean", date: "string", enum: "string" };

/** One internal field -> its JSON Schema property. */
function fieldToProperty(def) {
  const d = def || {};
  const prop = { type: JSON_SCHEMA_TYPE[d.type] || "string" };
  if (d.type === "date") prop.format = "date";
  if (d.type === "enum" && Array.isArray(d.enum) && d.enum.length) prop.enum = [...d.enum];
  if (d.description) prop.description = d.description;
  // `default` is carried through only when the internal field already holds one.
  if (d.default !== undefined) prop.default = d.default;
  // R-7 Phase 0: a field-level `rls` block is carried verbatim (stored, NOT enforced yet).
  if (d.rls != null) prop.rls = d.rls;
  return prop;
}

/** R-7 Phase 0: shape check for a field-level `rls` block — same rule shape as the entity block. */
export function validateFieldRls(entityName, fieldName, rls) {
  const check = validateRlsBlock(rls);
  if (!check.ok) throw new Error(`entity '${entityName || "?"}' field '${fieldName}' ${check.error}`);
  return check.rls;
}

/** The internal fields map -> `{ properties, required }`. `required` is omitted when empty. */
export function fieldsToJsonSchema(fields) {
  const properties = {};
  const required = [];
  for (const [name, def] of Object.entries(fields || {})) {
    properties[name] = fieldToProperty(def);
    if (def && def.required) required.push(name);
  }
  return { properties, ...(required.length ? { required } : {}) };
}

/** One JSON Schema property -> its internal field type. */
function propertyToType(prop) {
  const p = prop || {};
  if (p.type === "number" || p.type === "integer") return "number";
  if (p.type === "boolean") return "boolean";
  if (Array.isArray(p.enum) && p.enum.length) return "enum";
  if (p.format === "date" || p.format === "date-time") return "date";
  return "string";
}

/**
 * A JSON Schema entity document -> the internal `{ fieldName: { type, required, ... } }` map.
 * Requiredness comes from the document's top-level `required` array.
 */
export function jsonSchemaToFields(doc) {
  const d = doc || {};
  if (!d.properties || typeof d.properties !== "object" || Array.isArray(d.properties)) {
    throw new Error(`entity '${d.name || "?"}' must declare a 'properties' object`);
  }
  if (d.required != null && !Array.isArray(d.required)) throw new Error(`entity '${d.name || "?"}' has a 'required' that is not an array`);
  const req = new Set((d.required || []).map(String));
  const fields = {};
  for (const [name, prop] of Object.entries(d.properties)) {
    if (!prop || typeof prop !== "object" || Array.isArray(prop)) throw new Error(`entity '${d.name || "?"}' field '${name}' must be an object schema`);
    const type = propertyToType(prop);
    const frls = validateFieldRls(d.name, name, prop.rls);
    fields[name] = {
      type,
      required: req.has(name),
      ...(type === "enum" ? { enum: [...prop.enum] } : {}),
      ...(prop.description ? { description: prop.description } : {}),
      ...(prop.default !== undefined ? { default: prop.default } : {}),
      ...(frls ? { rls: frls } : {}),
    };
  }
  return fields;
}

/** Top-level keys this layer owns. Anything else on an existing document is foreign metadata. */
const OWNED_CONFIG_KEYS = ["name", "type", "properties", "required", "fields"];

/**
 * The row-level-security operations an entity document may declare. `write` is the legacy
 * key `update`/`delete` inherit from; it is accepted, never generated.
 */
export const RLS_OPS = ["read", "create", "update", "delete"];

/**
 * Shape check for a top-level `rls` block. Deliberately SHAPE ONLY: the platform's own
 * validator is not verified, so an unrecognised operator or key is carried through rather
 * than rejected — the evaluator (shared/rls.ts) is what decides what actually enforces.
 */
export function validateRlsBlock(rls) {
  if (rls == null) return { ok: true, rls: undefined };
  if (typeof rls !== "object" || Array.isArray(rls)) return { ok: false, error: "'rls' must be an object of read/create/update/delete rules" };
  for (const [op, rule] of Object.entries(rls)) {
    if (!RLS_OPS.includes(op) && op !== "write") return { ok: false, error: `'rls.${op}' is not a row-level-security operation (${RLS_OPS.join(", ")})` };
    if (rule === true || rule === false || rule == null) continue;
    if (typeof rule !== "object" || Array.isArray(rule)) return { ok: false, error: `'rls.${op}' must be a filter object, true or false` };
  }
  return { ok: true, rls };
}

/**
 * The canonical declaration of ONE entity, as its `base44/entities/<Name>.jsonc` document — a JSON
 * Schema object: `{ name, type: "object", properties, required }`.
 *
 * The document is a PROJECTION of the runtime model (the already-normalized fields map), never a
 * second competing representation. `existing` is the current document text when the file is being
 * re-emitted: any top-level metadata this layer does not own (e.g. a future `rls` block) is carried
 * over verbatim, so re-emitting a schema can never silently drop it.
 *
 * `rls` is a top-level SIBLING of `properties`/`required` — never part of `fields`, so the
 * internal `{ name, fields }` representation and the schema-migration diff are untouched by it.
 * Omitted here, an `rls` block already on the document is carried over like any other metadata.
 */
export function entitySchemaContent(name, fields, existing = null, rls = undefined) {
  let extra = {};
  if (existing) {
    try {
      const prev = parseJsonc(existing);
      if (prev && typeof prev === "object" && !Array.isArray(prev)) {
        extra = Object.fromEntries(Object.entries(prev).filter(([k]) => !OWNED_CONFIG_KEYS.includes(k)));
      }
    } catch { /* an unreadable previous document carries nothing forward */ }
  }
  if (rls !== undefined) delete extra.rls;             // an explicit block replaces the stored one
  const doc = {
    name: String(name), type: "object", ...fieldsToJsonSchema(fields),
    ...(rls !== undefined && rls !== null ? { rls } : {}),
    ...extra,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The inverse read: one declaration back into the shape the runtime already uses, `{ name, fields }`.
 * Both shapes are accepted — the canonical JSON Schema document, and the LEGACY `fields` document
 * already committed by earlier projects. A malformed document is a stated failure, never a silent
 * empty entity.
 */
export function parseEntitySchema(text) {
  const doc = parseJsonc(text);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("entity declaration must be a JSON object");
  if (!doc.name || typeof doc.name !== "string") throw new Error("entity declaration must declare a string 'name'");
  const check = validateRlsBlock(doc.rls);
  if (!check.ok) throw new Error(`entity '${doc.name}' ${check.error}`);
  // `rls` rides BESIDE fields, so an entity that declares it is still the same normalized
  // { name, fields } record the runtime, the build and the migration engine already use.
  const rls = check.rls ? { rls: check.rls } : {};
  // Legacy shape: the internal fields map written directly into the file.
  if (doc.fields != null) {
    if (typeof doc.fields !== "object" || Array.isArray(doc.fields)) throw new Error(`entity '${doc.name}' must declare a 'fields' object`);
    for (const [fname, fdef] of Object.entries(doc.fields)) validateFieldRls(doc.name, fname, fdef?.rls);
    return { name: doc.name, fields: doc.fields, ...rls };
  }
  return { name: doc.name, fields: jsonSchemaToFields(doc), ...rls };
}

/**
 * Parses JSONC: JSON plus `//` and block comments and trailing commas. String contents are
 * preserved verbatim, so a `//` inside a URL is never mistaken for a comment.
 */
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
  // Trailing commas before a closer are legal in JSONC and not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Validates a manifest document. Returns `{ ok, config }` or `{ ok: false, error }` — a malformed
 * manifest is always a stated failure, never a silently defaulted one.
 */
export function validateConfigDocument(text) {
  let doc;
  try { doc = parseJsonc(text); } catch (e) { return { ok: false, error: `is not valid JSONC: ${e.message}` }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "must be a JSON object" };
  if (!doc.name || typeof doc.name !== "string") return { ok: false, error: "must declare a string 'name'" };
  if (doc.description != null && typeof doc.description !== "string") return { ok: false, error: "'description' must be a string" };
  if (doc.visibility != null && !VISIBILITIES.includes(doc.visibility)) {
    return { ok: false, error: `'visibility' must be one of ${VISIBILITIES.join(", ")}` };
  }
  for (const [field, canonical] of Object.entries(RESOURCE_DIR_FIELDS)) {
    const v = doc[field];
    if (v == null) continue;
    if (typeof v !== "string") return { ok: false, error: `'${field}' must be a string path` };
    const normalized = v.replace(/^\.\//, "").replace(/\/$/, "");
    if (`${BASE44_DIR}${normalized}/` !== canonical) {
      return { ok: false, error: `'${field}' must point at ${canonical} (got '${v}')` };
    }
  }
  if (doc.site != null) {
    if (typeof doc.site !== "object" || Array.isArray(doc.site)) return { ok: false, error: "'site' must be an object" };
    for (const [k, v] of Object.entries(doc.site)) {
      if (!SITE_FIELDS.includes(k)) return { ok: false, error: `'site.${k}' is not a recognised site setting (${SITE_FIELDS.join(", ")})` };
      if (typeof v !== "string") return { ok: false, error: `'site.${k}' must be a string` };
    }
  }
  if (doc.plugin != null) {
    if (typeof doc.plugin !== "object" || Array.isArray(doc.plugin)) return { ok: false, error: "'plugin' must be an object" };
    for (const k of Object.keys(doc.plugin)) {
      if (!PLUGIN_FIELDS.includes(k)) return { ok: false, error: `'plugin.${k}' is not a recognised plugin setting (${PLUGIN_FIELDS.join(", ")})` };
    }
    if (typeof doc.plugin.namespace !== "string" || !PLUGIN_NAMESPACE_RE.test(doc.plugin.namespace)) {
      return { ok: false, error: "'plugin.namespace' must be a string of letters, numbers, underscores or dashes" };
    }
  }
  if (doc.plugins != null) {
    if (!Array.isArray(doc.plugins)) return { ok: false, error: "'plugins' must be an array of plugin names" };
    for (const p of doc.plugins) {
      if (typeof p !== "string" || !p.trim()) return { ok: false, error: "each entry of 'plugins' must be a non-empty string" };
    }
  }
  return { ok: true, config: doc };
}

/** The manifest a NEW project starts with. Existing projects are never rewritten. */
export function configContent(projectName, description = "") {
  const doc = {
    name: String(projectName || "app").replace(/[\r\n]/g, " ").slice(0, 120),
    ...(description ? { description: String(description).replace(/[\r\n]/g, " ").slice(0, 500) } : {}),
    visibility: "private",
    // Bare relative directory names, resolved against the manifest's own directory.
    ...Object.fromEntries(Object.entries(RESOURCE_DIR_FIELDS).map(([field, dir]) => [field, bareDirName(dir)])),
    site: { ...DEFAULT_SITE },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}