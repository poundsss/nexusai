// THE app-level project surface: `.app.jsonc`, plugin declarations and assets.
//
// This layer owns a CONTRACT, not a second configuration system. The distinction the existing
// architecture already draws is preserved exactly:
//
//   base44/config.jsonc   PROJECT config — where each resource kind lives, and the site build
//                         commands. It is the project's resource manifest.
//   base44/.app.jsonc     APP metadata — what the deployed application IS: its display name,
//                         description, icon, visibility, and the plugin packages it installs.
//                         It declares NO resource locations and NO commands.
//
// Neither file is required, neither rewrites the other, and a project that has only `config.jsonc`
// (every project today, and every legacy project) behaves exactly as before.
//
// PLUGINS stay CONFIGURATION DECLARATIONS — the architecture's existing choice. No plugin resource
// type, loader or executor is invented here: a declaration is a NAME, validated against a grammar,
// and nothing in it can carry code, a path or a command.
//
// ASSETS are ordinary project files under ONE canonical directory, so they travel through the
// existing filesystem, version, build, artifact and deploy path with no new machinery.
import { parseJsonc, VISIBILITIES, ASSETS_DIR, APP_CONFIG_FILE, isAssetPath, isAppConfigPath, assetName } from "./base44Layout.ts";

export { ASSETS_DIR, APP_CONFIG_FILE, isAssetPath, isAppConfigPath, assetName } from "./base44Layout.ts";

/**
 * Plugin identity: a bare name, or a namespaced `namespace/name`. Lowercase letters, digits and
 * dashes only — so a declaration can never be a relative path, a URL or a shell command.
 */
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/;
export const isPluginName = (name) => PLUGIN_NAME_RE.test(String(name || ""));

/** Top-level keys `.app.jsonc` recognises. An unknown key is a stated error, never ignored. */
export const APP_CONFIG_FIELDS = ["name", "description", "icon", "visibility", "plugins", "metadata"];

const MAX_PLUGINS = 50;
const MAX_METADATA_KEYS = 50;

/**
 * Parses and validates ONE `.app.jsonc` document.
 *
 * Returns `{ ok: true, app }` with the normalized metadata, or `{ ok: false, error }`. Validation is
 * deterministic and states the offending field, so the same bad document always fails the same way.
 */
export function parseAppConfig(path, text) {
  if (!isAppConfigPath(path)) return { ok: false, error: `is not the canonical app metadata path (${APP_CONFIG_FILE})` };
  let doc;
  try { doc = parseJsonc(text); } catch (e) { return { ok: false, error: `is not valid JSONC: ${e.message}` }; }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "must be a JSON object" };
  for (const k of Object.keys(doc)) {
    if (!APP_CONFIG_FIELDS.includes(k)) return { ok: false, error: `'${k}' is not a recognised app setting (${APP_CONFIG_FIELDS.join(", ")})` };
  }
  if (!doc.name || typeof doc.name !== "string") return { ok: false, error: "must declare a string 'name'" };
  if (doc.description != null && typeof doc.description !== "string") return { ok: false, error: "'description' must be a string" };
  if (doc.visibility != null && !VISIBILITIES.includes(doc.visibility)) {
    return { ok: false, error: `'visibility' must be one of ${VISIBILITIES.join(", ")}` };
  }
  // The icon is an ASSET, named relative to the canonical asset directory — never an absolute
  // path, a parent-directory escape or an external URL.
  if (doc.icon != null) {
    if (typeof doc.icon !== "string" || !doc.icon.trim()) return { ok: false, error: "'icon' must be a non-empty asset name" };
    if (!isAssetPath(`${ASSETS_DIR}${doc.icon.replace(/^\.?\//, "")}`)) {
      return { ok: false, error: `'icon' must name a file inside ${ASSETS_DIR} (got '${doc.icon}')` };
    }
  }
  if (doc.plugins != null) {
    if (!Array.isArray(doc.plugins)) return { ok: false, error: "'plugins' must be an array of plugin names" };
    if (doc.plugins.length > MAX_PLUGINS) return { ok: false, error: `'plugins' may declare at most ${MAX_PLUGINS} plugins` };
    const seen = new Set();
    for (const p of doc.plugins) {
      if (typeof p !== "string" || !isPluginName(p)) {
        return { ok: false, error: `'plugins' entry ${JSON.stringify(p)} is not a valid plugin name (lowercase letters, digits and dashes, optionally 'namespace/name')` };
      }
      if (seen.has(p)) return { ok: false, error: `'plugins' declares '${p}' twice` };
      seen.add(p);
    }
  }
  if (doc.metadata != null) {
    if (typeof doc.metadata !== "object" || Array.isArray(doc.metadata)) return { ok: false, error: "'metadata' must be an object" };
    const entries = Object.entries(doc.metadata);
    if (entries.length > MAX_METADATA_KEYS) return { ok: false, error: `'metadata' may carry at most ${MAX_METADATA_KEYS} keys` };
    for (const [k, v] of entries) {
      if (v !== null && !["string", "number", "boolean"].includes(typeof v)) {
        return { ok: false, error: `'metadata.${k}' must be a string, number or boolean` };
      }
    }
  }
  return {
    ok: true,
    app: {
      name: doc.name,
      description: doc.description || "",
      icon: doc.icon ? doc.icon.replace(/^\.?\//, "") : null,
      visibility: doc.visibility || null,
      plugins: [...(doc.plugins || [])].sort(),
      metadata: doc.metadata || {},
    },
  };
}

/**
 * Emits the canonical `.app.jsonc` document for app metadata. Deterministic: the same metadata
 * always produces byte-identical content, so a round-trip through push/pull changes nothing.
 */
export function appConfigContent(app = {}) {
  const doc = {
    name: String(app.name || "app").replace(/[\r\n]/g, " ").slice(0, 120),
    ...(app.description ? { description: String(app.description).replace(/[\r\n]/g, " ").slice(0, 500) } : {}),
    ...(app.icon ? { icon: String(app.icon).replace(/^\.?\//, "") } : {}),
    ...(app.visibility ? { visibility: app.visibility } : {}),
    ...(app.plugins && app.plugins.length ? { plugins: [...app.plugins].sort() } : {}),
    ...(app.metadata && Object.keys(app.metadata).length ? { metadata: app.metadata } : {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** The project's `.app.jsonc`, parsed from a file set. `null` when the project declares none. */
export function readAppConfig(files) {
  const file = (files || []).find((f) => isAppConfigPath(f.path));
  if (!file) return { declared: false, app: null, error: null };
  const parsed = parseAppConfig(file.path, file.content);
  return parsed.ok ? { declared: true, app: parsed.app, error: null } : { declared: true, app: null, error: `${APP_CONFIG_FILE} ${parsed.error}` };
}

/** Every asset a project declares, sorted by path. Assets carry content, never behaviour. */
export function collectAssets(files) {
  return (files || []).filter((f) => isAssetPath(f.path))
    .map((f) => ({ path: f.path, name: assetName(f.path), size: String(f.content ?? "").length }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The project's effective plugin declarations, from BOTH declaration sites — `.app.jsonc` (the app
 * surface) and the existing `base44/config.jsonc` `plugins` array, which keeps working untouched.
 * The result is a deduplicated, sorted set, so the same project state always resolves the same
 * plugin list. Invalid names are REPORTED rather than dropped.
 */
export function resolvePlugins({ appConfig = null, projectConfig = null } = {}) {
  const declared = [];
  const errors = [];
  const add = (name, source) => {
    if (!isPluginName(name)) { errors.push({ source, name: String(name), error: `${source} declares an invalid plugin name '${name}'` }); return; }
    if (!declared.some((d) => d.name === name)) declared.push({ name, source });
  };
  for (const p of appConfig?.plugins || []) add(p, APP_CONFIG_FILE);
  for (const p of projectConfig?.plugins || []) add(p, "base44/config.jsonc");
  declared.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins: declared, names: declared.map((d) => d.name), errors };
}