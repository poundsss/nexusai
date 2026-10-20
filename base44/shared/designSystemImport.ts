// Design System Import (Phase 2) — extraction, persistence shape and prompt block for
// IMPORTED design systems.
//
// Boundary (from the Phase 2 audit, confirmed behavior only):
//   • An imported system is GUIDANCE, not project visual state: an import writes exactly ONE
//     DesignSystem row (carrying the `imported` metadata), referenced by Project.design_system_id,
//     and is consumed by the Build pipeline ONLY through importedDesignSystemBlock in NEW Build
//     output. loadDesignSystem skips imported rows, so styles.css keeps being emitted from the
//     project's own tokens and an import never rewrites existing project files.
//   • Extraction is bounded and honest: CSS custom properties that map onto the EXISTING fixed
//     token groups are merged through the existing mergeTokens validation (an import can never
//     introduce unknown token groups/keys or unsafe values); everything else travels as bounded
//     reference text and bounded usage excerpts. No CSF/MDX parser is invented — story/doc files
//     contribute bounded text only.
//   • Reuse, not reinvention: github.ts fetch primitives for GitHub, packageSupply verified
//     fetch/integrity for npm, discoverComponents for component inventory, mergeTokens for token
//     validation, the existing DesignSystem entity — no new entity, no new capability.
import { DEFAULT_TOKENS, mergeTokens, discoverComponents } from "./designSystem.ts";
import { createFs, writeFile } from "./projectFs.ts";
import { isSupportedDesignSystemId } from "./designSystemPresets.ts";

export const IMPORT_LIMITS = {
  entries: 20,            // pasted-files action: max files per import
  entry_chars: 100000,    // max chars per pasted file
  style_files: 24,        // max style/token files read per import
  style_file_bytes: 200000,
  reference_tokens: 150,  // max raw CSS custom properties carried as reference text
  ref_value_chars: 120,
  usage_docs: 4,          // max doc/story files used for usage text
  usage_doc_chars: 1500,
  usage_chars: 6000,
  name_chars: 80,
  component_scan_files: 100,
};

const scanVars = (text) => [...String(text || "").matchAll(/--([a-zA-Z0-9-]+)\s*:\s*([^;{}]+)/g)]
  .map((m) => [m[1], m[2]]);

const COLOR_KEYS = [
  "background", "foreground", "card", "card_foreground", "muted", "muted_foreground", "border", "input",
  "primary", "primary_foreground", "secondary", "secondary_foreground", "accent", "accent_foreground",
  "destructive", "success", "warning", "ring",
];

// A CSS custom property maps onto the fixed token groups ONLY when its name matches the naming
// the platform's own stylesheet emits (tokensToCss) or the shadcn/ui naming. Everything else is
// carried as reference text — never mapped, never invented.
function mapColorToken(name) {
  let n = String(name).toLowerCase();
  if (n.startsWith("color-")) n = n.slice(6);
  const key = n.replace(/-/g, "_");
  return COLOR_KEYS.includes(key) ? key : null;
}

function mapOtherToken(name) {
  const n = String(name).toLowerCase();
  let x;
  if ((x = /^radius-(none|sm|md|lg|xl|full)$/.exec(n))) return { group: "radius", key: x[1] };
  if (/^radius$/.test(n)) return { group: "radius", key: "md" };
  if ((x = /^space-(unit|xs|sm|md|lg|xl|2xl)$/.exec(n))) return { group: "spacing", key: x[1] };
  if ((x = /^font-(body|heading|mono)$/.exec(n))) return { group: "typography", key: `font_${x[1]}` };
  if ((x = /^text-(xs|sm|base|lg|xl|2xl|3xl)$/.exec(n))) return { group: "typography", key: `size_${x[1]}` };
  if ((x = /^weight-([1-9]00)$/.exec(n))) return { group: "typography", key: `weight_${x[1]}` };
  if ((x = /^shadow-(sm|md|lg)$/.exec(n))) return { group: "shadows", key: x[1] };
  if ((x = /^motion-duration-(fast|base)$/.exec(n))) return { group: "motion", key: `duration_${x[1]}` };
  return null;
}

export const isStyleFile = (path) =>
  /\.(css|scss|sass|less)$/i.test(String(path || ""))
  || /(^|\/)tailwind\.config\.[jt]s$/i.test(String(path || ""))
  || /(tokens?|theme|design-tokens|variables)\.(css|scss|js|ts|json)$/i.test(String(path || ""));

export const isDocFile = (path) =>
  /\.(stories|story)\.[jt]sx?$/i.test(String(path || ""))
  || /\.mdx?$/i.test(String(path || ""))
  || /(^|\/)(readme|usage)\.md$/i.test(String(path || ""));

export const isComponentSource = (path) =>
  /^(src\/)?(components|pages)\//.test(String(path || "")) && /\.(jsx?|tsx?)$/.test(String(path || ""));

function scopeCss(css, selector) {
  return [...String(css || "").matchAll(new RegExp(`${selector}[^{]*\\{([^}]*)\\}`, "g"))].map((m) => m[1]).join("\n");
}

// Splits fetched source into the three bounded slices extraction consumes.
export function selectStyleAndDocs(files) {
  const styles = [];
  const docs = [];
  const source = [];
  for (const f of files || []) {
    if (!f || typeof f.content !== "string") continue;
    if (isStyleFile(f.path)) {
      if (f.content.length <= IMPORT_LIMITS.style_file_bytes) styles.push({ path: f.path, content: f.content });
    } else if (isDocFile(f.path)) docs.push(f.content);
    else if (isComponentSource(f.path)) source.push(f);
  }
  return {
    styles: styles.slice(0, IMPORT_LIMITS.style_files),
    docs: docs.slice(0, IMPORT_LIMITS.usage_docs + 4),
    source: source.slice(0, IMPORT_LIMITS.component_scan_files),
  };
}

/**
 * Extracts an imported design from bounded source text. Reference tokens are every extracted CSS
 * custom property (bounded); mapped tokens go through the EXISTING mergeTokens validation, so a
 * value that is not a valid token is rejected exactly like a model-provided patch would be.
 */
export function buildImportedDesign({ name = "", style_texts = [], doc_texts = [], source_files = [] } = {}) {
  // 1) Reference tokens — the raw look of the source, carried as bounded text.
  const reference = [];
  const seen = new Set();
  for (const text of style_texts) {
    for (const [vname, value] of scanVars(text)) {
      if (reference.length >= IMPORT_LIMITS.reference_tokens) break;
      const key = `--${String(vname).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const v = String(value).trim().slice(0, IMPORT_LIMITS.ref_value_chars);
      if (!v) continue;
      reference.push({ name: key, value: v });
    }
    if (reference.length >= IMPORT_LIMITS.reference_tokens) break;
  }

  // 2) Mapped tokens — validated by the existing mergeTokens contract.
  const patch = {};
  const put = (group, key, value) => {
    const g = (patch[group] = patch[group] || {});
    if (g[key] === undefined) g[key] = String(value).trim().slice(0, 200);
  };
  const allStyles = style_texts.join("\n");
  const root = scopeCss(allStyles, ":root");
  const dark = scopeCss(allStyles, "\\.dark");
  for (const [vname, value] of scanVars(root)) {
    const colorKey = mapColorToken(vname);
    if (colorKey) put("colors", colorKey, value);
    const other = mapOtherToken(vname);
    if (other) put(other.group, other.key, value);
  }
  for (const [vname, value] of scanVars(dark)) {
    const colorKey = mapColorToken(vname);
    if (colorKey) put("dark", colorKey, value);
  }
  const merged = mergeTokens(DEFAULT_TOKENS, patch);

  // 3) Bounded usage/examples excerpt from docs/stories — text only, no parser invented.
  const usage = (doc_texts || []).slice(0, IMPORT_LIMITS.usage_docs)
    .map((t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, IMPORT_LIMITS.usage_doc_chars))
    .filter(Boolean).join("\n\n").slice(0, IMPORT_LIMITS.usage_chars);

  // 4) Component inventory from real source files — the SAME discovery the design engine uses.
  let components = [];
  if ((source_files || []).length) {
    const fs = createFs([]);
    let n = 0;
    for (const f of source_files.slice(0, IMPORT_LIMITS.component_scan_files)) {
      if (!isComponentSource(f.path) || !f.content || n >= IMPORT_LIMITS.component_scan_files) continue;
      try { writeFile(fs, f.path, String(f.content)); n++; } catch { /* not a valid project path — skipped */ }
    }
    try { components = discoverComponents(fs); } catch { components = []; }
  }

  return {
    tokens: merged.tokens,
    applied: merged.applied,
    rejected: merged.rejected,
    reference,
    usage,
    components,
    name: String(name || "").trim().slice(0, IMPORT_LIMITS.name_chars) || "Imported design system",
  };
}

// The DesignSystem row an id points at, when that id is NOT a static preset and the row is an
// imported system owned by the given project. Everything else returns null (fail closed).
export async function importedDesignRow(base44, projectId, id) {
  if (!id || isSupportedDesignSystemId(id)) return null;
  const row = await base44.entities.DesignSystem.get(String(id)).catch(() => null);
  return row && row.project_id === String(projectId) && row.imported ? row : null;
}

export const loadImportedDesignRow = (base44, project) =>
  importedDesignRow(base44, project?.id, project?.design_system_id);

// Prompt block for an imported system — the same shape and the same non-rewrite guarantee as
// designSystemLibraryBlock, emitted from the imported row's bounded metadata.
export function importedDesignSystemBlock(row) {
  if (!row || !row.imported) return "";
  const imp = row.imported;
  const name = String(imp.source_name || "Imported design system").slice(0, IMPORT_LIMITS.name_chars);
  const ref = (imp.reference_tokens || []).slice(0, IMPORT_LIMITS.reference_tokens)
    .map((t) => `${String(t.name).slice(0, 60)}: ${String(t.value).slice(0, IMPORT_LIMITS.ref_value_chars)}`)
    .join("\n");
  const usage = String(imp.usage || "").slice(0, IMPORT_LIMITS.usage_chars);
  return `SELECTED DESIGN SYSTEM — ${name} (imported from ${String(imp.source || "external source").slice(0, 20)})
This system was imported for the project and applies to NEW components this Build creates. It does NOT authorize rewriting existing files: modify existing code only where the user's request explicitly asks for it.
${ref ? `Reference tokens extracted from the source (express the imported look through the project's token stylesheet or a design patch — never ad-hoc styles):\n${ref}\n` : ""}${usage ? `Usage and examples from the source (bounded excerpt):\n${usage}\n` : ""}Rules:
- Apply the imported system's look to NEW output only; never hand-edit styles.css and never rewrite untouched files.
- Reuse the project's existing component classes and var(--*) tokens; the reference tokens guide the design patch, not one-off CSS.`;
}

export async function importedDesignSystemPrompt(base44, project) {
  return importedDesignSystemBlock(await loadImportedDesignRow(base44, project));
}