// Project logo validation + storage helpers — the documented Base44 "Dashboard → Overview →
// Edit logo" surface. The logo is a PUBLIC file (world-readable, so the published app can serve
// it as a browser favicon and home-screen icon) kept on the Project row as `logo_url`.
//
// This module owns the documented limits so the projectLogo backend function and its certification
// suite share one enforcement path: PNG/JPEG only, ≤5 MB, ≤1024×1024 px. Dimensions come from the
// image header bytes (shared/imageDims.ts), never a client claim. No new storage system — the
// actual upload uses the existing Core.UploadPublicFile primitive, called from the backend function.

import { imageDimensions } from "./imageDims.ts";

export const LOGO_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const LOGO_MAX_DIM = 1024;              // 1024×1024 px
export const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg"]);

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// Decode a base64 (optionally data-URL-prefixed) payload into bytes.
export function decodeLogoBase64(content_base64) {
  const b64 = String(content_base64 || "").replace(/^data:[^;]*;base64,/, "");
  let binary;
  try { binary = atob(b64); } catch {
    throw httpError(400, "Logo content must be base64 encoded", "LOGO_INVALID_ENCODING");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Enforce every documented limit on the decoded bytes. Throws an HTTP-shaped error on the first
// violation; returns the validated metadata ({ width, height, content_type, size }) on success.
export function validateLogoBytes(bytes, { contentType } = {}) {
  const type = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_LOGO_TYPES.has(type)) {
    throw httpError(415, "Logo must be a PNG or JPEG image", "LOGO_TYPE_REJECTED");
  }
  if (!bytes || !bytes.length) throw httpError(400, "Logo is empty", "LOGO_EMPTY");
  if (bytes.length > LOGO_MAX_BYTES) {
    throw httpError(413, `Logo exceeds the ${LOGO_MAX_BYTES / (1024 * 1024)}MB limit`, "LOGO_TOO_LARGE");
  }
  const dims = imageDimensions(bytes);
  if (!dims) throw httpError(400, "Could not read image dimensions", "LOGO_UNREADABLE");
  if (dims.width > LOGO_MAX_DIM || dims.height > LOGO_MAX_DIM) {
    throw httpError(413, `Logo must be at most ${LOGO_MAX_DIM}×${LOGO_MAX_DIM} px`, "LOGO_TOO_LARGE_DIM");
  }
  return { width: dims.width, height: dims.height, content_type: type, size: bytes.length };
}

export const logoExtension = (type) => (type === "image/png" ? "png" : "jpg");