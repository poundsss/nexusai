// PKCE (S256) helpers — the ONE implementation shared by the delegated OAuth credential flow
// (#31G) and the deployed-app social sign-in flow (P-9.8). Extracted unchanged from
// delegatedOAuth.ts, which re-exports them so its public API is identical.
export function generatePkceVerifier() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallengeFromVerifier(verifier) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(verifier)));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}