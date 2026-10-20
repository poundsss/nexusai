// Security headers and CSP for the PUBLIC deployed-app surface.
//
// Server-owned on purpose: the policy string and the iframe sandbox token list are produced
// here, returned by the runtime alongside the artifact, and applied by the host page. A
// change to the client cannot weaken them, and the host page has no policy of its own.
//
// What the policy is protecting against:
//   • A generated app injecting or loading arbitrary script (default-src 'none', no
//     'unsafe-eval', no wildcard script host).
//   • A generated app navigating or framing its way out of the sandbox, or posting a form
//     to a third party (frame-ancestors/frame-src/form-action/base-uri).
//   • Plaintext exfiltration and mixed content (only https: endpoints are reachable).
//
// What it deliberately preserves, because deployed apps depend on it:
//   • The bundle's ES modules are blob: URLs minted inside the sandboxed document
//     (script-src blob:; data: stays allowed for older artifacts), the Tailwind CDN runtime,
//     inline styles it generates, and https images/fonts.
//   • Outbound https calls from generated frontend code (connect-src https:), plus the
//     postMessage bridge, which CSP does not restrict.

export const APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob: data: https://cdn.tailwindcss.com",
  "style-src 'unsafe-inline' https://cdn.tailwindcss.com",
  "img-src data: blob: https:",
  "font-src data: https:",
  "connect-src blob: data: https:",
  "media-src data: blob: https:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

// Sandbox tokens for the deployed-app iframe. allow-same-origin is ABSENT: the frame is
// opaque-origin, so generated code cannot reach the host page's storage, cookies, session
// token or platform SDK. allow-top-navigation is absent too, so it cannot navigate the tab.
export const APP_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups";

// Headers for every response of the public runtime endpoint.
export function securityHeaders(extra = {}) {
  return {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
    "Cache-Control": "no-store",
    ...extra,
  };
}

// The policy the host page must apply to the deployed app document. Shipped with the
// artifact so the enforcement decision stays server-side.
export function appSecurityConfig() {
  return { csp: APP_CSP, sandbox: APP_SANDBOX, referrer_policy: "no-referrer" };
}

// Adds the headers to a Response without disturbing its status, body or existing headers
// (Set-Cookie from the auth path in particular).
export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(securityHeaders())) if (!headers.has(k)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}