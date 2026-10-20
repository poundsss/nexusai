// Visual Edit style toolbar (Base44 parity: hands-on edits to a selected preview element without
// an AI run). A DETERMINISTIC source transform: the picked element's static className (and, for
// text edits, its literal text) must resolve to EXACTLY ONE JSX opening tag in the project. Then a
// bounded, allowlisted set of Tailwind class groups and/or the literal text are rewritten. Anything
// unresolvable or ambiguous is refused (409) — never guessed — and the caller falls back to an AI
// edit. The result is committed by the caller through the existing journalled commit path.
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

const COLORS = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const SHADES = "50|100|200|300|400|500|600|700|800|900|950";
const TOKENS = "primary|primary-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|card|card-foreground|background|foreground|destructive|brand|white|black|transparent";
const colorRe = (p) => new RegExp(`^${p}-((${COLORS})-(${SHADES})|${TOKENS})$`);
const SIZES = "xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl";
const SPACE = "0|0\\.5|1|1\\.5|2|2\\.5|3|4|5|6|8|10|12|16|20|24";

// group → [matcher of existing classes to remove, validator of the new value]
export const STYLE_GROUPS = {
  text_color: [colorRe("text"), colorRe("text")],
  bg_color: [colorRe("bg"), colorRe("bg")],
  font_size: [new RegExp(`^text-(${SIZES})$`), new RegExp(`^text-(${SIZES})$`)],
  font_weight: [/^font-(thin|light|normal|medium|semibold|bold|extrabold|black)$/, /^font-(light|normal|medium|semibold|bold|extrabold)$/],
  padding: [new RegExp(`^p-(${SPACE})$`), new RegExp(`^p-(${SPACE})$`)],
  margin: [new RegExp(`^m-(${SPACE})$`), new RegExp(`^m-(${SPACE})$`)],
  radius: [/^rounded(-(none|sm|md|lg|xl|2xl|3xl|full))?$/, /^rounded(-(none|sm|md|lg|xl|2xl|3xl|full))?$/],
  text_align: [/^text-(left|center|right|justify)$/, /^text-(left|center|right|justify)$/],
};
export const VISUAL_EDIT_LIMITS = { text_chars: 500, files_scanned: 400 };

const norm = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The static class attribute of the picked element's OPENING tag (from the picker's outerHTML). */
export function pickedClasses(html) {
  const open = String(html || "").match(/^<[a-zA-Z][\w-]*\b[^>]*>/)?.[0] || "";
  return open.match(/\sclass="([^"]*)"/)?.[1] ?? "";
}

/** Validates the requested changes against the allowlist. Returns a normalized change set. */
export function validateChanges(changes = {}) {
  const classes = {};
  for (const [group, value] of Object.entries(changes.classes || {})) {
    const spec = STYLE_GROUPS[group];
    if (!spec) fail(400, "VISUAL_EDIT_INVALID", `Unknown style "${group}"`);
    if (value === null || value === "") { classes[group] = null; continue; }
    if (!spec[1].test(String(value))) fail(400, "VISUAL_EDIT_INVALID", `"${value}" is not an allowed ${group} value`);
    classes[group] = String(value);
  }
  let text = null;
  if (changes.text != null) {
    text = String(changes.text).trim();
    if (!text || text.length > VISUAL_EDIT_LIMITS.text_chars || /[{}<>]/.test(text)) fail(400, "VISUAL_EDIT_INVALID", "Text must be 1-500 characters without { } < >");
  }
  if (!Object.keys(classes).length && text == null) fail(400, "VISUAL_EDIT_INVALID", "No change requested");
  return { classes, text };
}

function rewriteClasses(list, classes) {
  let out = [...list];
  for (const [group, value] of Object.entries(classes)) {
    const [match] = STYLE_GROUPS[group];
    out = out.filter((c) => !match.test(c));
    if (value) out.push(value);
  }
  return out.join(" ");
}

/**
 * Locates the element in the project's JSX and applies the change set.
 * files: [{path, content}]. element: {tag, html, text}. page_file: preferred file (searched first,
 * but uniqueness is checked across ALL candidate files so a shared component is never mis-edited).
 */
export function applyVisualEdit(files, { element, changes, page_file = null }) {
  const set = validateChanges(changes);
  const tag = String(element?.tag || "").toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(tag)) fail(400, "VISUAL_EDIT_INVALID", "The selected element has no tag");
  const want = norm(pickedClasses(element?.html));
  if (!want.length) fail(409, "VISUAL_EDIT_UNRESOLVED", "This element has no static classes to locate it in the source");
  const wantKey = [...want].sort().join(" ");
  const candidates = (files || []).filter((f) => /\.(jsx|tsx|js)$/.test(f.path) && f.path.startsWith("src/")).slice(0, VISUAL_EDIT_LIMITS.files_scanned);
  // Generated apps are htm templates (`class="…"`); JSX (`className="…"`) is accepted too.
  const tagRe = new RegExp(`<${esc(tag)}\\b[^<>]*?\\s(class|className)="([^"]*)"[^<>]*?>`, "g");
  const text = String(element?.text || "").trim();
  const hits = [];
  for (const f of candidates) {
    for (const m of String(f.content || "").matchAll(tagRe)) {
      if ([...norm(m[2])].sort().join(" ") !== wantKey) continue;
      hits.push({ file: f, index: m.index, open: m[0], attr: m[1], cls: m[2] });
    }
  }
  // Text disambiguates identical class lists: keep hits whose literal child text matches.
  const literal = (h) => {
    const after = String(h.file.content).slice(h.index + h.open.length);
    const lm = after.match(new RegExp(`^([^<{}]*)</${esc(tag)}>`));
    return lm && lm[1].trim() === text ? lm[1] : null;
  };
  let pool = hits;
  if (pool.length > 1 && text) pool = pool.filter((h) => literal(h) != null);
  if (!pool.length) fail(409, "VISUAL_EDIT_UNRESOLVED", "This element could not be found in the source");
  if (pool.length > 1) fail(409, "VISUAL_EDIT_AMBIGUOUS", `This element matches ${pool.length} places in the source`);
  const hit = pool[0];
  const src = String(hit.file.content);
  const newOpen = Object.keys(set.classes).length
    ? hit.open.replace(`${hit.attr}="${hit.cls}"`, `${hit.attr}="${rewriteClasses(norm(hit.cls), set.classes)}"`)
    : hit.open;
  let rest = src.slice(hit.index + hit.open.length);
  if (set.text != null) {
    const lit = literal(hit);
    if (lit == null) fail(409, "VISUAL_EDIT_TEXT_DYNAMIC", "This element's text is not plain text in the source");
    rest = lit.replace(lit.trim(), set.text) + rest.slice(lit.length);
  }
  const content = src.slice(0, hit.index) + newOpen + rest;
  return { path: hit.file.path, content, page_file_matched: !page_file || hit.file.path === page_file };
}