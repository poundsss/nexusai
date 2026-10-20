// One SHA-256 helper for the whole platform.
//
// Artifact checksums are only meaningful if EVERY producer and verifier hashes identically, so the
// function lives here once rather than being re-implemented per module.
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? "")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}