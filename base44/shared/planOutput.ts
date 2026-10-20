// Normalizes structured model results before the pipeline uses them. Providers sometimes return
// the structured output as a JSON string (optionally fenced); a valid JSON object string is
// parsed, an object passes through unchanged, anything else is rejected with a clear error.
function parseModelObject(raw, label, codePrefix) {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    if (text === "") value = null;
    else {
      try { value = JSON.parse(text); }
      catch (e) { throw Object.assign(new Error(`${label} returned invalid JSON: ${e.message}`), { code: `${codePrefix}_INVALID_JSON`, retryable: false }); }
    }
  }
  if (value == null || value === "") {
    throw Object.assign(new Error(`${label} returned an empty result`), { code: `${codePrefix}_INVALID_SHAPE`, retryable: false });
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} returned ${Array.isArray(value) ? "an array" : typeof value} instead of an object`), { code: `${codePrefix}_INVALID_SHAPE`, retryable: false });
  }
  return value;
}

export function normalizePlanOutput(raw) {
  if (raw == null || raw === "") {
    throw Object.assign(new Error("Planner returned an empty result (no plan)"), { code: "PLAN_INVALID_SHAPE", retryable: false });
  }
  // Plain Markdown/prose (e.g. "# Plan ...") is refused with a stable code — never converted.
  if (typeof raw === "string") {
    const t = raw.trim();
    // Markdown headings, or text with no JSON structure at all. Malformed JSON keeps its existing error.
    if (t && !/^(\{|\[|```)/.test(t) && (t.startsWith("#") || !/[{[]/.test(t))) {
      throw Object.assign(new Error("Planner returned non-JSON text instead of a JSON plan object"), { code: "PLAN_NOT_JSON", retryable: false });
    }
  }
  try { return parseModelObject(raw, "Planner", "PLAN"); }
  catch (e) {
    if (e.code === "PLAN_INVALID_SHAPE" && /instead of an object/.test(e.message)) e.message = e.message.replace("an object", "a plan object");
    throw e;
  }
}

// File generator output: { content: non-empty string }.
export function normalizeFileOutput(raw) {
  const out = parseModelObject(raw, "File generator", "FILE_OUTPUT");
  if (typeof out.content !== "string" || out.content.trim() === "") {
    throw Object.assign(new Error(`File generator output is missing required field "content"`), { code: "FILE_OUTPUT_MISSING_CONTENT", retryable: false });
  }
  return out;
}

// Patcher output: { patches: [{ find, replace }, ...] } with at least one valid edit.
export function normalizePatchOutput(raw) {
  const out = parseModelObject(raw, "Patcher", "PATCH_OUTPUT");
  if (!Array.isArray(out.patches) || out.patches.length === 0) {
    throw Object.assign(new Error("Patcher returned an empty edit list (no patches)"), { code: "PATCH_OUTPUT_EMPTY", retryable: false });
  }
  const bad = out.patches.findIndex((p) => !p || typeof p.find !== "string" || p.find === "" || typeof p.replace !== "string");
  if (bad !== -1) {
    throw Object.assign(new Error(`Patcher edit ${bad} is missing required "find"/"replace" strings`), { code: "PATCH_OUTPUT_INVALID_EDIT", retryable: false });
  }
  return out;
}