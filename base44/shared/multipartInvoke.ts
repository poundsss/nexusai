// G-A: multipart/File support for the DOCUMENTED functions.invoke surface (SDK 0.8.52).
// Published SDK contract (node_modules/@base44/sdk/dist/modules/functions.js + docs.base44.com
// "functions" reference): invoke() sends multipart/form-data when ANY named parameter is a File
// (or the data itself is a FormData instance) — File params are appended as-is, other objects
// are JSON-stringified, scalars as-is — and the function receives the data as NAMED PARAMETERS.
//
// This module owns both ends, additively, without touching the JSON invoke path:
//   • parseMultipartInvokeBody — server acceptance: a genuine multipart invoke request is parsed
//     into the SAME JSON envelope every existing consumer already reads (envelope keys verbatim,
//     `payload` JSON-decoded, loose text fields and File fields become named payload params);
//   • restoreFileParams — executor-side restoration: a file descriptor on the invoke payload
//     becomes the named parameter the generated function reads.
//
// Wire file-descriptor shape (NEXUSAI-DERIVED — Base44 publishes the client serialization, not
// the server-side File-object contract): { __base44file__: true, filename, content_type, size,
// content_base64 }. The restored shape drops only the marker, so the descriptor fields are the
// SAME ones the app's own file surfaces already use (files.upload, integrations Core uploads).
// File parameters are NEVER stored and never charged — bytes travel inline in the payload, so
// no integration or message credit can move for an invoke File parameter.

export const FILE_PARAM_MARKER = "__base44file__";
export const FILE_PARAM_MAX_BYTES = 10 * 1024 * 1024;

const ENVELOPE_KEYS = new Set([
  "action", "op", "mode", "slug", "host", "function_name", "session_token",
  "project_id", "trace_id", "run_id", "anonymous_token",
]);

// Genuine multipart/form-data detection on the invoke request. Only requests the published
// SDK actually sends this way take the multipart path; every other request keeps the JSON path.
export function isMultipartInvoke(req) {
  const type = String(req.headers.get("content-type") || "").toLowerCase();
  return type.startsWith("multipart/form-data");
}

function base64OfBytes(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function parseJsonOrString(text) {
  try { return JSON.parse(text); } catch { return text; }
}

function tooLargeError() {
  return Object.assign(new Error(`File parameter exceeds the ${FILE_PARAM_MAX_BYTES}-byte invoke limit`), { status: 413, code: "FILE_PARAM_TOO_LARGE" });
}

// One file field → the wire descriptor. The byte cap is enforced on the decoded bytes, so a
// padded or truncated base64 body can never smuggle a larger file through.
export async function fileDescriptorFrom(file) {
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > FILE_PARAM_MAX_BYTES) throw tooLargeError();
  const u8 = new Uint8Array(bytes);
  return {
    [FILE_PARAM_MARKER]: true,
    filename: typeof file.name === "string" && file.name ? file.name : "file",
    content_type: typeof file.type === "string" && file.type ? file.type : "application/octet-stream",
    size: u8.byteLength,
    content_base64: base64OfBytes(u8),
  };
}

function base64DecodedBytesTooLarge(descriptor) {
  const len = String(descriptor.content_base64 || "").length;
  if (!len) return false;
  // decoded bytes ≈ base64 length × 3/4 (minus padding) — compare against the cap with margin.
  return len * 0.75 > FILE_PARAM_MAX_BYTES + 4;
}

// Server acceptance: multipart/form-data → the JSON envelope. Envelope keys travel verbatim
// (strings); the `payload` field is JSON-decoded (falling back to the raw string, so a plain
// scalar survives); any OTHER text field is a named parameter merged into the payload
// (JSON-decoded, matching the published SDK's client serialization); every File field becomes
// a named file parameter. An explicit non-object payload combined with named file parameters
// is refused — there is nowhere to attach them.
export async function parseMultipartInvokeBody(req) {
  let form;
  try { form = await req.formData(); } catch {
    throw Object.assign(new Error("Invalid multipart/form-data body"), { status: 400, code: "INVOKE_BODY_INVALID" });
  }
  const envelope = {};
  const loose = {};
  const files = {};
  let explicitPayload;
  let hasExplicitPayload = false;
  for (const [rawKey, value] of form.entries()) {
    const key = String(rawKey);
    if (typeof value === "string") {
      if (ENVELOPE_KEYS.has(key)) { envelope[key] = value; continue; }
      if (key === "payload") { explicitPayload = parseJsonOrString(value); hasExplicitPayload = true; continue; }
      loose[key] = parseJsonOrString(value);
      continue;
    }
    files[key] = await fileDescriptorFrom(value);
  }
  const hasNamedParams = Object.keys(loose).length > 0 || Object.keys(files).length > 0;
  if (hasExplicitPayload && (explicitPayload === null || typeof explicitPayload !== "object" || Array.isArray(explicitPayload))) {
    if (hasNamedParams) {
      throw Object.assign(new Error("File parameters require an object invoke payload"), { status: 400, code: "INVOKE_PAYLOAD_SHAPE" });
    }
    envelope.payload = explicitPayload;
    return envelope;
  }
  const payload = { ...(hasExplicitPayload ? explicitPayload : {}), ...loose, ...files };
  if (hasExplicitPayload || hasNamedParams) envelope.payload = payload;
  return envelope;
}

function hasFileParams(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return false;
  if (Array.isArray(value)) return value.some((v) => hasFileParams(v, depth + 1));
  if (value[FILE_PARAM_MARKER] === true) return true;
  return Object.values(value).some((v) => hasFileParams(v, depth + 1));
}

// Executor-side restoration. Only well-formed descriptors are converted — an object that
// merely looks file-ish stays a plain object, so a JSON invoke's data is never silently
// transformed. Bounded depth; when nothing file-like is present the ORIGINAL value is returned
// untouched, keeping the JSON invoke path byte-identical to its previous behavior.
export function restoreFileParams(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) {
    if (!hasFileParams(value, depth)) return value;
    return value.map((v) => restoreFileParams(v, depth + 1));
  }
  if (!hasFileParams(value, depth)) return value;
  if (value[FILE_PARAM_MARKER] === true) {
    if (typeof value.content_base64 !== "string") return value;
    if (base64DecodedBytesTooLarge(value)) throw tooLargeError();
    return {
      filename: typeof value.filename === "string" && value.filename ? value.filename : "file",
      content_type: typeof value.content_type === "string" && value.content_type ? value.content_type : "application/octet-stream",
      size: typeof value.size === "number" ? value.size : null,
      content_base64: value.content_base64,
    };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = restoreFileParams(v, depth + 1);
  return out;
}