// Minimal YAML 1.1/1.2 subset parser — enough for real OpenAPI/Swagger documents, which is
// the only thing on this platform that arrives as YAML.
//
// Deliberately NOT a general YAML implementation and not a dependency: it supports what
// specification documents actually use — nested block maps, block sequences, flow
// collections, quoted/plain scalars, block scalars (| and >), comments and multi-document
// headers — and FAILS LOUDLY on anything else instead of guessing. The result is plain JS
// data handed to the existing importOpenApi() path, so YAML and JSON specs converge on one
// code path with one validator.
const fail = (msg, line) => { throw new Error(`yaml: ${msg}${line != null ? ` (line ${line})` : ""}`); };

// Strips an unquoted trailing comment. Quote state is tracked so a '#' inside a string
// (common in OpenAPI descriptions and enum values) survives.
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text;
}

function parseScalar(raw) {
  const text = String(raw).trim();
  if (!text || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "False" || text === "FALSE" || text === "no" || text === "off") return false;
  if (text[0] === '"' || text[0] === "'") {
    const quote = text[0];
    const end = text.lastIndexOf(quote);
    if (end <= 0) fail(`unterminated ${quote === '"' ? "double" : "single"}-quoted string ${text.slice(0, 40)}`);
    const inner = text.slice(1, end);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  if (text[0] === "[" || text[0] === "{") return parseFlow(text);
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
  // Tags and anchors carry no meaning for a spec document; the value they decorate does.
  if (/^[!&*]\S*$/.test(text)) return null;
  return text.replace(/^!!?\S+\s+/, "").replace(/^[&*]\S+\s+/, "");
}

// Flow collections ([a, b] / {a: b}) — JSON-compatible plus unquoted keys/values.
function parseFlow(text) {
  let i = 0;
  const src = String(text);
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const readUntil = (stops) => {
    const start = i;
    let quote = null;
    while (i < src.length) {
      const c = src[i];
      if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; i++; continue; }
      if (c === '"' || c === "'") { quote = c; i++; continue; }
      if (stops.includes(c)) break;
      i++;
    }
    return src.slice(start, i).trim();
  };
  const value = () => {
    ws();
    if (src[i] === "[") {
      i++; const out = [];
      for (;;) {
        ws();
        if (src[i] === "]") { i++; return out; }
        out.push(value());
        ws();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "]") { i++; return out; }
        fail(`malformed flow sequence near "${src.slice(i, i + 20)}"`);
      }
    }
    if (src[i] === "{") {
      i++; const out = {};
      for (;;) {
        ws();
        if (src[i] === "}") { i++; return out; }
        const key = String(parseScalar(readUntil([":", ",", "}"])) ?? "");
        ws();
        if (src[i] === ":") { i++; out[key] = value(); } else out[key] = null;
        ws();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "}") { i++; return out; }
        fail(`malformed flow mapping near "${src.slice(i, i + 20)}"`);
      }
    }
    return parseScalar(readUntil([",", "]", "}"]));
  };
  const out = value();
  ws();
  if (i < src.length) fail(`unexpected trailing content in flow collection "${src.slice(i, i + 20)}"`);
  return out;
}

const KEY_RE = /^(?:(?:"((?:[^"\\]|\\.)*)")|(?:'([^']*)')|([^:#]+?))\s*:(?:\s+([\s\S]*))?$/;

function collectRows(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed === "---" || trimmed.startsWith("--- ") || trimmed === "...") continue;
    if (trimmed.startsWith("%")) continue; // %YAML / %TAG directives
    rows.push({ indent: raw.length - raw.trimStart().length, text: trimmed, line: i + 1, raw });
  }
  return rows;
}

// A block scalar's body is every following line indented deeper than its key. Literal (|)
// keeps newlines, folded (>) joins them — enough for descriptions and examples.
function blockScalar(rows, from, keyIndent, style) {
  const body = [];
  let i = from;
  while (i < rows.length && rows[i].indent > keyIndent) { body.push(rows[i].text); i++; }
  const text = style === "|" ? body.join("\n") : body.join(" ");
  return [text, i];
}

function parseBlock(rows, from, to, indent) {
  if (from >= to) return [null, from];
  const first = rows[from];
  if (first.text === "-" || first.text.startsWith("- ")) return parseSequence(rows, from, to, indent);
  return parseMapping(rows, from, to, indent);
}

function parseMapping(rows, from, to, indent) {
  const out = {};
  let i = from;
  while (i < to) {
    const row = rows[i];
    if (row.indent < indent) break;
    if (row.indent > indent) fail(`unexpected indentation in mapping near "${row.text.slice(0, 40)}"`, row.line);
    const text = stripComment(row.text);
    const m = KEY_RE.exec(text);
    if (!m) fail(`expected "key: value" but found "${text.slice(0, 60)}"`, row.line);
    const key = m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2] !== undefined ? m[2] : m[3].trim();
    const inline = (m[4] ?? "").trim();
    i++;
    if (inline === "|" || inline === ">" || inline === "|-" || inline === ">-" || inline === "|+" || inline === ">+") {
      const [scalar, next] = blockScalar(rows, i, row.indent, inline[0]);
      out[key] = scalar; i = next; continue;
    }
    if (inline) { out[key] = parseScalar(inline); continue; }
    // Nested block: everything indented deeper (a sequence may sit at the SAME indent).
    let end = i;
    while (end < to && (rows[end].indent > row.indent || (rows[end].indent === row.indent && (rows[end].text === "-" || rows[end].text.startsWith("- "))))) end++;
    if (end === i) { out[key] = null; continue; }
    const [value, consumed] = parseBlock(rows, i, end, rows[i].indent);
    out[key] = value;
    i = consumed > i ? consumed : end;
  }
  return [out, i];
}

function parseSequence(rows, from, to, indent) {
  const out = [];
  let i = from;
  while (i < to) {
    const row = rows[i];
    if (row.indent < indent) break;
    if (!(row.text === "-" || row.text.startsWith("- "))) fail(`expected a "- " sequence item but found "${row.text.slice(0, 40)}"`, row.line);
    const rest = stripComment(row.text.slice(1).trim());
    // The item's own block is its inline remainder (re-indented to where it starts) plus
    // every following line indented deeper than the dash.
    const contentIndent = row.indent + 2;
    let end = i + 1;
    while (end < to && rows[end].indent > row.indent) end++;
    if (!rest) {
      if (end === i + 1) out.push(null);
      else { const [value] = parseBlock(rows, i + 1, end, rows[i + 1].indent); out.push(value); }
    } else if (KEY_RE.test(rest) && !/^["'[{]/.test(rest)) {
      const synthetic = [{ indent: contentIndent, text: rest, line: row.line, raw: rest }, ...rows.slice(i + 1, end)];
      const [value] = parseMapping(synthetic, 0, synthetic.length, contentIndent);
      out.push(value);
    } else if (rest === "|" || rest === ">") {
      const [scalar] = blockScalar(rows, i + 1, row.indent, rest);
      out.push(scalar);
    } else {
      out.push(parseScalar(rest));
    }
    i = end;
  }
  return [out, i];
}

export function parseYaml(text) {
  const rows = collectRows(text);
  if (!rows.length) fail("document is empty");
  const [value] = parseBlock(rows, 0, rows.length, rows[0].indent);
  return value;
}

// JSON first (a JSON document is valid YAML, but the native parser is exact and cheaper),
// then YAML. Used by the OpenAPI importer so callers never care which format arrived.
export function parseJsonOrYaml(text, what = "document") {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error(`${what} is empty`);
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try { return { value: JSON.parse(raw), format: "json" }; } catch (e) { throw new Error(`${what} looks like JSON but is invalid: ${e.message}`); }
  }
  try { return { value: parseYaml(raw), format: "yaml" }; } catch (e) {
    try { return { value: JSON.parse(raw), format: "json" }; } catch { throw new Error(`${what} is neither valid JSON nor valid YAML — ${e.message}`); }
  }
}