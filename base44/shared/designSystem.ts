// Design / UI engine: a project's visual language as STRUCTURED STATE.
//
// Why this exists: without persisted design state each run invents its own colors, radii and
// type scale, so an app drifts into a different look on every prompt. Here the project owns a
// token set; every generated page consumes it through emitted CSS variables and component
// classes, and a natural-language design request MUTATES the tokens instead of scattering
// one-off styles through the code.
//
// Guarantees:
//   • Deterministic: the same tokens always emit byte-identical CSS (hashable, diffable).
//   • Validated: a token patch is checked value-by-value; malformed values are rejected with a
//     reason and the previous value is kept, so a bad model output cannot corrupt the design.
//   • Bounded: fixed key space — a patch cannot introduce arbitrary keys or unbounded content.
//   • Enforced: lintDesign() turns "don't hardcode styles" from prompt advice into a real
//     build diagnostic that feeds the existing repair loop.
import { activeFiles, indexFile } from "./projectFs.ts";
import { hashString } from "./embeddings.ts";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const LEN = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%|ms|s))$/;
const SAFE_CLASS = /^[a-z0-9 :\[\]\/\.\-_%()]+$/i;

export const DEFAULT_TOKENS = {
  meta: { name: "Base", mood: "clean, modern, professional", theme_default: "light" },
  colors: {
    background: "#ffffff", foreground: "#0f172a", card: "#ffffff", card_foreground: "#0f172a",
    muted: "#f1f5f9", muted_foreground: "#64748b", border: "#e2e8f0", input: "#e2e8f0",
    primary: "#4f46e5", primary_foreground: "#ffffff", secondary: "#f1f5f9", secondary_foreground: "#0f172a",
    accent: "#eef2ff", accent_foreground: "#3730a3", destructive: "#dc2626", success: "#16a34a", warning: "#d97706",
    ring: "#4f46e5",
  },
  dark: {
    background: "#0b1120", foreground: "#e2e8f0", card: "#111827", card_foreground: "#e2e8f0",
    muted: "#1e2937", muted_foreground: "#94a3b8", border: "#1e2937", input: "#1e2937",
    primary: "#818cf8", primary_foreground: "#0b1120", secondary: "#1e2937", secondary_foreground: "#e2e8f0",
    accent: "#1e1b4b", accent_foreground: "#c7d2fe", destructive: "#f87171", success: "#4ade80", warning: "#fbbf24",
    ring: "#818cf8",
  },
  typography: {
    font_body: "ui-sans-serif, system-ui, sans-serif",
    font_heading: "ui-sans-serif, system-ui, sans-serif",
    font_mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    size_xs: "0.75rem", size_sm: "0.875rem", size_base: "1rem", size_lg: "1.125rem",
    size_xl: "1.5rem", size_2xl: "1.875rem", size_3xl: "2.25rem",
    weight_normal: "400", weight_medium: "500", weight_semibold: "600", weight_bold: "700",
    line_tight: "1.2", line_normal: "1.5", tracking_tight: "-0.01em",
  },
  spacing: { unit: "0.25rem", xs: "0.5rem", sm: "0.75rem", md: "1rem", lg: "1.5rem", xl: "2rem", "2xl": "3rem" },
  radius: { none: "0", sm: "0.25rem", md: "0.5rem", lg: "0.75rem", xl: "1rem", full: "9999px" },
  shadows: { sm: "0 1px 2px rgba(15,23,42,0.06)", md: "0 4px 12px rgba(15,23,42,0.08)", lg: "0 12px 32px rgba(15,23,42,0.12)" },
  borders: { width: "1px", style: "solid" },
  breakpoints: { sm: "640px", md: "768px", lg: "1024px", xl: "1280px" },
  motion: { duration_fast: "120ms", duration_base: "200ms", easing: "cubic-bezier(0.4, 0, 0.2, 1)", respect_reduced_motion: true },
  icons: { style: "outline", size: "1.25rem", stroke: "1.75" },
  imagery: { style: "photographic, neutral", radius: "0.75rem", fit: "cover" },
  a11y: { min_contrast: "4.5", focus_ring_width: "2px", min_touch_target: "44px" },
  // Component recipes. Generated markup uses these class names, so one semantic component has
  // exactly one appearance across every page of the project.
  components: {
    button: "btn", button_primary: "btn btn-primary", button_secondary: "btn btn-secondary",
    button_ghost: "btn btn-ghost", button_danger: "btn btn-danger",
    card: "card", card_header: "card-header", card_title: "card-title", card_body: "card-body",
    input: "field", label: "field-label", table: "table", badge: "badge",
    nav: "nav", nav_link: "nav-link", nav_link_active: "nav-link nav-link-active",
    page: "page", page_header: "page-header", heading_1: "h1", heading_2: "h2", muted_text: "text-muted",
    grid_cards: "grid-cards", stack: "stack", empty_state: "empty-state", dialog: "dialog",
  },
};

const GROUPS = Object.keys(DEFAULT_TOKENS);

// Planner-facing patch contract. Deliberately a flat set of groups with string values: the
// model can restyle the project, but it cannot inject structure.
//
// Schema compliance: every object with `properties` has a matching `required` array and
// `additionalProperties: false`. Token groups use explicit property keys (derived from
// DEFAULT_TOKENS) rather than `additionalProperties: { type: "string" }`, because OpenAI
// structured outputs reject dictionary-typed properties from `required` with
// "Extra required key 'colors' supplied." The model sends current values for unchanged
// tokens; mergeTokens applies only the ones that actually differ.
const stringProps = (keys) => Object.fromEntries(keys.map((k) => [k, { type: "string" }]));
const tokenGroup = (keys, description) => ({
  type: "object",
  description,
  properties: stringProps(keys),
  required: keys,
  additionalProperties: false,
});

// Compact design patch schema: a flat list of {group, key, value} entries instead of
// ~100 explicit nested properties. This keeps the compiled grammar well under Claude's
// strict-structured-output limit while preserving every token the planner can change.
// mergeTokens receives the converted object (see designPatchToObject).
export const DESIGN_SCHEMA = {
  type: "object",
  description: "Design-system change for this run. Omit entirely when the request is not visual. Only send the tokens that must change — everything else is preserved.",
  properties: {
    rationale: { type: "string", description: "One line: the visual intent, e.g. 'dark premium SaaS look with tighter cards'." },
    tokens: {
      type: "array",
      description: "Token changes as a flat list. Each entry sets one token. Only include tokens that must change. Valid groups: meta (name, mood, theme_default), colors, dark, typography, spacing, radius, shadows, motion, icons, imagery.",
      items: {
        type: "object",
        properties: {
          group: { type: "string", enum: ["meta", "colors", "dark", "typography", "spacing", "radius", "shadows", "motion", "icons", "imagery"], description: "Token group." },
          key: { type: "string", description: "Token key within the group, e.g. 'primary', 'size_base', 'sm', 'name'." },
          value: { type: "string", description: "The new value: hex color (#rrggbb) for colors/dark, CSS length for spacing/radius/typography sizes, font stack for font_*, etc." },
        },
        required: ["group", "key", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["rationale", "tokens"],
  additionalProperties: false,
};

// Converts the compact design patch (array of {group, key, value}) to the object format
// that mergeTokens expects ({group: {key: value}}). Accepts both formats for backward
// compatibility with any persisted staging from before the schema compaction.
export function designPatchToObject(patch) {
  if (!patch || typeof patch !== "object") return {};
  if (Array.isArray(patch.tokens)) {
    const out = {};
    if (patch.rationale) out.rationale = patch.rationale;
    for (const t of patch.tokens) {
      if (!t || !t.group || !t.key) continue;
      if (!out[t.group]) out[t.group] = {};
      out[t.group][t.key] = t.value;
    }
    return out;
  }
  return patch;
}

function validateValue(group, key, value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) return "must be a short string";
  const v = value.trim();
  if (group === "colors" || group === "dark") return HEX.test(v) ? null : "must be a #rgb or #rrggbb hex color";
  if (group === "radius" || group === "spacing" || group === "breakpoints") return LEN.test(v) ? null : "must be a CSS length (px, rem, em, % or 0)";
  if (group === "typography") {
    if (key.startsWith("size_")) return LEN.test(v) ? null : "font sizes must be a CSS length";
    if (key.startsWith("weight_")) return /^[1-9]00$/.test(v) ? null : "font weights must be 100-900 in hundreds";
    if (key.startsWith("line_") || key.startsWith("tracking_")) return /^-?\d*\.?\d+(em|rem|%)?$/.test(v) ? null : "must be a number or em/rem value";
    if (key.startsWith("font_")) return /[<>{};@]/.test(v) ? "font stacks cannot contain CSS control characters" : null;
    return null;
  }
  if (group === "motion") {
    if (key.startsWith("duration_")) return LEN.test(v) ? null : "durations must be like 200ms";
    return /[<>{};@]/.test(v) ? "invalid easing value" : null;
  }
  if (group === "shadows") return /[<>{}@]|url\(/i.test(v) ? "shadows cannot contain url() or CSS control characters" : null;
  if (group === "components") return SAFE_CLASS.test(v) ? null : "component recipes must be plain class names";
  return /[<>{}]|javascript:|url\(/i.test(v) ? "unsafe token value" : null;
}

// Merges a patch into the current tokens. Unknown groups/keys and invalid values are rejected
// (reported, not applied), so the design system stays well-formed whatever the model returns.
export function mergeTokens(current, patch) {
  const base = normalizeTokens(current);
  const out = JSON.parse(JSON.stringify(base));
  const applied = [];
  const rejected = [];
  for (const [group, values] of Object.entries(patch || {})) {
    if (group === "rationale") continue;
    if (!GROUPS.includes(group)) { rejected.push({ path: group, reason: "unknown token group" }); continue; }
    if (!values || typeof values !== "object" || Array.isArray(values)) { rejected.push({ path: group, reason: "must be an object of token values" }); continue; }
    for (const [key, value] of Object.entries(values)) {
      const known = Object.prototype.hasOwnProperty.call(DEFAULT_TOKENS[group], key);
      if (!known) { rejected.push({ path: `${group}.${key}`, reason: "unknown token" }); continue; }
      const problem = validateValue(group, key, value);
      if (problem) { rejected.push({ path: `${group}.${key}`, reason: problem }); continue; }
      if (out[group][key] !== value.trim()) applied.push(`${group}.${key}`);
      out[group][key] = value.trim();
    }
  }
  return { tokens: out, applied, rejected, changed: applied.length > 0 };
}

// Backward compatibility: a project created before the design engine (or with a partial row)
// is filled from defaults rather than failing.
export function normalizeTokens(tokens) {
  const out = {};
  for (const group of GROUPS) {
    out[group] = { ...DEFAULT_TOKENS[group], ...(tokens && typeof tokens[group] === "object" && !Array.isArray(tokens[group]) ? tokens[group] : {}) };
  }
  return out;
}

const cssVar = (prefix, key) => `--${prefix}-${key.replace(/_/g, "-")}`;

// Deterministic stylesheet: CSS variables for every token plus the component recipes the
// generator is told to use. Emitted from tokens only — never hand-edited by the model.
export function tokensToCss(tokens) {
  const t = normalizeTokens(tokens);
  const vars = (prefix, obj) => Object.entries(obj).map(([k, v]) => `  ${cssVar(prefix, k)}: ${v};`).join("\n");
  return `/* GENERATED FROM THE PROJECT DESIGN SYSTEM — do not hand-edit.
   Change the design by changing design tokens; this file is re-emitted from them. */
:root {
${vars("color", t.colors)}
${vars("font", { body: t.typography.font_body, heading: t.typography.font_heading, mono: t.typography.font_mono })}
${vars("text", Object.fromEntries(Object.entries(t.typography).filter(([k]) => k.startsWith("size_")).map(([k, v]) => [k.slice(5), v])))}
${vars("weight", Object.fromEntries(Object.entries(t.typography).filter(([k]) => k.startsWith("weight_")).map(([k, v]) => [k.slice(7), v])))}
${vars("space", t.spacing)}
${vars("radius", t.radius)}
${vars("shadow", t.shadows)}
${vars("motion", t.motion.respect_reduced_motion ? { duration_fast: t.motion.duration_fast, duration_base: t.motion.duration_base, easing: t.motion.easing } : t.motion)}
  --line-tight: ${t.typography.line_tight};
  --line-normal: ${t.typography.line_normal};
  --border-width: ${t.borders.width};
  --focus-ring: ${t.a11y.focus_ring_width};
  --touch-target: ${t.a11y.min_touch_target};
  --image-radius: ${t.imagery.radius};
}
.dark {
${vars("color", t.dark)}
}
* { border-color: var(--color-border); }
body {
  margin: 0;
  background: var(--color-background);
  color: var(--color-foreground);
  font-family: var(--font-body);
  font-size: var(--text-base);
  line-height: var(--line-normal);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { font-family: var(--font-heading); line-height: var(--line-tight); letter-spacing: ${t.typography.tracking_tight}; margin: 0; }
.h1 { font-size: var(--text-3xl); font-weight: var(--weight-bold); }
.h2 { font-size: var(--text-xl); font-weight: var(--weight-semibold); }
.text-muted { color: var(--color-muted-foreground); font-size: var(--text-sm); }
.page { padding: var(--space-lg); max-width: 1280px; margin: 0 auto; }
.page-header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-md); flex-wrap: wrap; margin-bottom: var(--space-lg); }
.stack { display: flex; flex-direction: column; gap: var(--space-md); }
.grid-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-md); }
.card { background: var(--color-card); color: var(--color-card-foreground); border: var(--border-width) ${t.borders.style} var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.card-header { padding: var(--space-md); border-bottom: var(--border-width) ${t.borders.style} var(--color-border); }
.card-title { font-family: var(--font-heading); font-size: var(--text-lg); font-weight: var(--weight-semibold); }
.card-body { padding: var(--space-md); }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-xs);
  min-height: var(--touch-target); padding: 0 var(--space-md);
  border-radius: var(--radius-md); border: var(--border-width) ${t.borders.style} transparent;
  font-family: var(--font-body); font-size: var(--text-sm); font-weight: var(--weight-medium);
  cursor: pointer; background: var(--color-secondary); color: var(--color-secondary-foreground);
  transition: background var(--motion-duration-fast) var(--motion-easing), box-shadow var(--motion-duration-fast) var(--motion-easing);
}
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.btn-primary { background: var(--color-primary); color: var(--color-primary-foreground); }
.btn-secondary { background: var(--color-secondary); color: var(--color-secondary-foreground); border-color: var(--color-border); }
.btn-ghost { background: transparent; color: var(--color-foreground); }
.btn-danger { background: var(--color-destructive); color: #ffffff; }
.field {
  width: 100%; min-height: var(--touch-target); padding: 0 var(--space-sm);
  background: var(--color-background); color: var(--color-foreground);
  border: var(--border-width) ${t.borders.style} var(--color-input); border-radius: var(--radius-md);
  font-family: var(--font-body); font-size: var(--text-sm);
}
.field-label { display: block; font-size: var(--text-sm); font-weight: var(--weight-medium); margin-bottom: var(--space-xs); }
.badge { display: inline-flex; align-items: center; padding: 0 var(--space-xs); border-radius: var(--radius-full); background: var(--color-accent); color: var(--color-accent-foreground); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.table th { text-align: left; font-weight: var(--weight-semibold); color: var(--color-muted-foreground); padding: var(--space-sm); border-bottom: var(--border-width) ${t.borders.style} var(--color-border); }
.table td { padding: var(--space-sm); border-bottom: var(--border-width) ${t.borders.style} var(--color-border); }
.nav { display: flex; align-items: center; gap: var(--space-xs); flex-wrap: wrap; padding: var(--space-sm) var(--space-lg); border-bottom: var(--border-width) ${t.borders.style} var(--color-border); background: var(--color-card); }
.nav-link { display: inline-flex; align-items: center; min-height: var(--touch-target); padding: 0 var(--space-sm); border-radius: var(--radius-md); color: var(--color-muted-foreground); font-size: var(--text-sm); font-weight: var(--weight-medium); text-decoration: none; }
.nav-link-active { background: var(--color-accent); color: var(--color-accent-foreground); }
.empty-state { padding: var(--space-2xl) var(--space-md); text-align: center; color: var(--color-muted-foreground); }
.dialog { background: var(--color-card); color: var(--color-card-foreground); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-lg); max-width: 32rem; width: calc(100% - var(--space-lg)); }
img, video { max-width: 100%; height: auto; border-radius: var(--image-radius); object-fit: ${t.imagery.fit}; }
:focus-visible { outline: var(--focus-ring) solid var(--color-ring); outline-offset: 2px; }
@media (max-width: ${t.breakpoints.md}) {
  .page { padding: var(--space-md); }
  .page-header { align-items: flex-start; flex-direction: column; }
  .grid-cards { grid-template-columns: 1fr; }
  .table { display: block; overflow-x: auto; }
}
${t.motion.respect_reduced_motion ? `@media (prefers-reduced-motion: reduce) {\n  * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }\n}` : ""}
`;
}

// --- consistency + accessibility enforcement ---------------------------------

const ROLE_HINTS = [
  [/card/i, "card"], [/button|btn/i, "button"], [/table|list|rows/i, "table"], [/form|editor|input/i, "form"],
  [/nav|sidebar|header|menu/i, "nav"], [/layout|shell|page/i, "layout"], [/chart|graph|metric|stat/i, "chart"],
  [/dialog|modal|drawer/i, "dialog"],
];

// Component discovery, so a design request can reuse what exists instead of adding a fifth
// card component. Derived from the real filesystem, not remembered guesses.
export function discoverComponents(fs) {
  const out = [];
  for (const f of activeFiles(fs)) {
    if (!f.path.startsWith("src/components/") && !f.path.startsWith("src/pages/")) continue;
    const meta = indexFile(f.path, f.content);
    const name = (meta.exports.find((e) => e.startsWith("default")) || "").match(/\(([^)]+)\)/)?.[1]
      || f.path.split("/").pop().replace(/\.js$/, "");
    const props = [...new Set([...f.content.matchAll(/function\s+\w+\s*\(\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(",").map((p) => p.trim().split(/[:=]/)[0].trim()).filter(Boolean)))].slice(0, 12);
    const classes = [...new Set([...f.content.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))];
    out.push({
      name, path: f.path, props,
      role: (ROLE_HINTS.find(([re]) => re.test(f.path) || re.test(name)) || [null, "other"])[1],
      variants: classes.filter((c) => /^(btn|card|nav|field|badge|table|dialog)/.test(c)).slice(0, 8),
    });
  }
  return out.slice(0, 80);
}

const LINT_RULES = [
  { rule: "hardcoded-color", re: /#[0-9a-fA-F]{6}\b|\brgba?\(\s*\d/g, message: "hardcoded color — use a design token (var(--color-*)) or a component class" },
  { rule: "arbitrary-value", re: /\b(?:text|p|m|w|h|gap|rounded|leading|bg|border)-\[[^\]]+\]/g, message: "arbitrary style value — use the project's spacing/radius/type scale" },
  { rule: "inline-style", re: /style="[^"]*(?:color|background|font-size|border-radius|padding|margin)[^"]*"/g, message: "inline visual style — move it to the design system or a component class" },
  { rule: "hardcoded-font", re: /font-family\s*:/g, message: "hardcoded font-family — use var(--font-body)/var(--font-heading)" },
  { rule: "image-missing-alt", re: /<img(?![^>]*\balt=)[^>]*>/g, message: "image without alt text — accessibility requirement" },
  { rule: "unlabelled-input", re: /<input(?![^>]*(?:aria-label|id=))[^>]*>/g, message: "input without a label association (id + label, or aria-label)" },
  { rule: "click-on-div", re: /<div[^>]*\bonClick=/g, message: "click handler on a div — use a <button> so it is keyboard accessible" },
];

// Design/accessibility lint over generated frontend code. Scoped to the files a run touched so
// a legacy project is never blocked by pre-existing violations (backward compatibility), and
// the diagnostics are phrased as fixes so the existing repair loop can act on them.
export function lintDesign(fs, { paths = null, max = 40 } = {}) {
  const violations = [];
  for (const f of activeFiles(fs)) {
    if (!f.path.startsWith("src/")) continue;
    if (paths && !paths.includes(f.path)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length && violations.length < max; i++) {
      const line = lines[i];
      for (const { rule, re, message } of LINT_RULES) {
        re.lastIndex = 0;
        if (re.test(line)) violations.push({ path: f.path, line: i + 1, rule, message, snippet: line.trim().slice(0, 120) });
      }
    }
  }
  return {
    ok: violations.length === 0, violations,
    diagnostics: violations.map((v) => `DESIGN_VIOLATION ${v.path}:${v.line} [${v.rule}] ${v.message} — ${v.snippet}`),
  };
}

// --- persistence + retrieval --------------------------------------------------

export async function loadDesignSystem(base44, projectId) {
  // Bounded multi-row fetch: the newest row can be an imported (guidance) one, so skipping it
  // must not lose the project's own design row — the skip is applied AFTER loading.
  const rows = await base44.entities.DesignSystem.filter({ project_id: projectId }, "-updated_date", 50);
  // Imported design systems (Phase 2) are GUIDANCE rows, never project visual state: an import
  // must not replace the tokens styles.css is emitted from, so they are skipped here and
  // consumed only through importedDesignSystemBlock in the Build prompt.
  const row = rows.find((r) => !r.imported) || null;
  return {
    id: row?.id || null,
    tokens: normalizeTokens(row?.tokens),
    components: row?.components || [],
    revision: row?.revision || 0,
    exists: !!row,
  };
}

export async function saveDesignSystem(base44, { project, design, components, runId, version_number }) {
  const css_hash = hashString(tokensToCss(design.tokens));
  const data = {
    project_id: project.id, workspace_id: project.workspace_id, tokens: design.tokens,
    components: (components || []).slice(0, 80), revision: (design.revision || 0) + 1,
    version_number: version_number ?? undefined, updated_by_run_id: runId || undefined, css_hash,
  };
  if (design.id) return base44.entities.DesignSystem.update(design.id, data);
  return base44.entities.DesignSystem.create(data);
}

// Design objects for the project index, so the design agent RETRIEVES the existing visual
// language and component inventory instead of inventing a new one.
export function designIndexObjects({ tokens, components }) {
  const t = normalizeTokens(tokens);
  const objects = [
    { group: "colors", text: `design colors ${Object.entries(t.colors).map(([k, v]) => `${k}=${v}`).join(" ")} dark ${Object.entries(t.dark).map(([k, v]) => `${k}=${v}`).join(" ")}` },
    { group: "typography", text: `design typography ${Object.entries(t.typography).map(([k, v]) => `${k}=${v}`).join(" ")}` },
    { group: "layout", text: `design spacing ${Object.entries(t.spacing).map(([k, v]) => `${k}=${v}`).join(" ")} radius ${Object.entries(t.radius).map(([k, v]) => `${k}=${v}`).join(" ")} breakpoints ${Object.entries(t.breakpoints).map(([k, v]) => `${k}=${v}`).join(" ")}` },
    { group: "components", text: `design component recipes ${Object.entries(t.components).map(([k, v]) => `${k}="${v}"`).join(" ")}` },
    { group: "inventory", text: `reusable UI components ${(components || []).map((c) => `${c.name}(${c.role}) ${c.path}`).join(", ")}` },
  ];
  return objects.map((o) => ({
    object_type: "config", key: `design:${o.group}`, source_path: "styles.css", title: `design ${o.group}`,
    text: o.text.slice(0, 1200), metadata: { design_group: o.group, mood: t.meta.mood, theme_default: t.meta.theme_default },
    hash: hashString(o.text),
  }));
}

// Prompt block. The design system is PLATFORM-OWNED state: the generator consumes it, and may
// only change it through the plan's design patch — not by writing ad-hoc styles.
export function designBlock({ tokens, components, revision = 0 }) {
  const t = normalizeTokens(tokens);
  const line = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("  ");
  const inventory = (components || []).length
    ? components.map((c) => `- ${c.name} (${c.role}) at ${c.path}${c.props.length ? ` props: ${c.props.join(", ")}` : ""}`).join("\n")
    : "- (no reusable components yet)";
  return `DESIGN SYSTEM (revision ${revision} — the project's persistent visual language; styles.css is GENERATED from these tokens and must never be hand-written)
Mood: ${t.meta.mood} · default theme: ${t.meta.theme_default}
Colors (light): ${line(t.colors)}
Colors (dark):  ${line(t.dark)}
Typography: ${line(t.typography)}
Spacing: ${line(t.spacing)}
Radius: ${line(t.radius)}
Shadows: ${line(t.shadows)}
Breakpoints: ${line(t.breakpoints)}
Motion: ${line(t.motion)}
Icons: ${line(t.icons)} · Imagery: ${line(t.imagery)}
Accessibility floors: ${line(t.a11y)}

USE THESE CLASSES for every UI element (they come from styles.css and keep every page identical):
${Object.entries(t.components).map(([k, v]) => `- ${k}: class="${v}"`).join("\n")}
Tailwind utilities may be used ONLY for layout and spacing (flex, grid, gap-*, p-*, w-full, hidden, md:*). Never for color, radius, shadow, font family or font size — those come from the classes above or var(--*) tokens.

EXISTING REUSABLE COMPONENTS (import and reuse before creating anything new):
${inventory}

HARD DESIGN RULES (enforced by the build — a violation fails verification):
- No hardcoded colors (#hex, rgb()), no arbitrary Tailwind values (text-[13px], rounded-[7px]), no inline visual style attributes, no font-family declarations in components.
- One semantic component = one appearance. Reuse the classes and the components above instead of inventing a variant.
- Every <img> needs alt text; every input needs a label (id+label or aria-label); interactive elements are <button>/<a>, never a div with onClick.
- Layout must work at ${t.breakpoints.sm}/${t.breakpoints.md}/${t.breakpoints.lg}: stack columns on mobile, allow tables to scroll, keep touch targets ≥ ${t.a11y.min_touch_target}.
- To CHANGE the look, return a design patch in the plan (design.colors / design.typography / …). Never restyle by editing styles.css or by adding one-off CSS.`;
}