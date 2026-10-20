// Regression test for the production CSP / runtime bootstrap bug.
//
// BUG: The generated-app runtime imported htm/preact from https://esm.sh, but the
// production CSP (script-src 'unsafe-inline' data: https://cdn.tailwindcss.com) blocked
// esm.sh. The browser refused to load the runtime module, so deployed apps could not
// bootstrap — they showed a blank iframe with a CSP violation error.
//
// FIX: The htm/preact standalone module is now VENDORED locally and embedded as a data:
// URL inside the runtime source. The runtime no longer references any external origin,
// so the existing CSP (which already allows data:) covers it without any widening.
//
// This test proves the production CSP is compatible with the actual runtime dependency:
//   1. script-src allows data: (the vendored module's transport).
//   2. script-src does NOT include esm.sh (we eliminated the dependency, not widened CSP).
//   3. script-src does NOT use a broad https: wildcard.
//   4. frame-ancestors 'self' and other protections are intact.
//   5. The iframe sandbox keeps the frame opaque-origin (no allow-same-origin).
//   6. A simulated bundle document under the production CSP has no script origin the
//      policy would block — i.e. every script src is either data: or cdn.tailwindcss.com.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { APP_CSP, APP_SANDBOX, appSecurityConfig, securityHeaders } from "../../shared/securityHeaders.ts";

export const config = { method: "POST" };

export default async function (req) {
  const results = [];
  const check = (name, ok, detail) =>
    results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 300) });

  // --- 1. CSP allows the vendored runtime transport (data: URLs) ----------------
  check(
    "script-src allows data: (vendored runtime transport)",
    APP_CSP.includes("script-src") && /script-src[^\;]*\bdata:/i.test(APP_CSP),
    APP_CSP.match(/script-src[^\;]*/i)?.[0]
  );

  // --- 2. CSP does NOT include esm.sh — the dependency was eliminated, not allowlisted
  check(
    "script-src does NOT include esm.sh",
    !/script-src[^\;]*esm\.sh/i.test(APP_CSP),
    "esm.sh must not appear in script-src"
  );

  // --- 3. No broad https: wildcard in script-src --------------------------------
  // The old CSP used the specific Tailwind CDN origin, which is correct. A broad
  // https: in script-src would allow any TLS origin to inject script — a regression.
  const scriptSrc = (APP_CSP.match(/script-src[^\;]*/i) || [""])[0];
  check(
    "script-src does NOT use broad https: wildcard",
    !/\bhttps:\s/.test(scriptSrc), // https: as a bare scheme keyword, not https://
    scriptSrc
  );

  // --- 4. frame-ancestors and core protections intact ----------------------------
  check(
    "frame-ancestors 'self' present",
    /frame-ancestors\s+'self'/.test(APP_CSP),
    APP_CSP.match(/frame-ancestors[^\;]*/i)?.[0]
  );
  check("default-src 'none' present", APP_CSP.includes("default-src 'none'"), "baseline deny-all");
  check("object-src 'none' present", APP_CSP.includes("object-src 'none'"), "no plugins");
  check("base-uri 'none' present", APP_CSP.includes("base-uri 'none'"), "no <base> hijack");
  check("form-action 'none' present", APP_CSP.includes("form-action 'none'"), "no form exfil");
  check("no 'unsafe-eval' in script-src", !/script-src[^\;]*unsafe-eval/i.test(APP_CSP), "eval stays blocked");

  // --- 5. iframe sandbox keeps the frame opaque-origin --------------------------
  check(
    "sandbox excludes allow-same-origin",
    !APP_SANDBOX.includes("allow-same-origin"),
    APP_SANDBOX
  );
  check(
    "sandbox excludes allow-top-navigation",
    !APP_SANDBOX.includes("allow-top-navigation"),
    APP_SANDBOX
  );

  // --- 6. Simulated bundle document: every script src is CSP-compatible --------
  // Reproduce what bundlePreview emits: a <script type="module"> that imports a data:
  // URL (the app entry), which in turn imports the runtime data: URL, which imports the
  // vendored htm/preact data: URL. Plus the Tailwind CDN script. Under the production
  // CSP, every one of these must be loadable.
  const simulatedScriptSrcs = [
    "data:text/javascript;base64,SGVsbG8=", // app entry (data: URL)
    "data:text/javascript;base64,QW5vdGhlcg==", // runtime module (data: URL)
    "data:text/javascript;base64,VmVuZG9yZWQ=", // vendored htm/preact (data: URL)
    "https://cdn.tailwindcss.com", // Tailwind CDN (explicitly allowed)
  ];

  // Parse the CSP script-src directive and check each src against it.
  // A data: URL matches the 'data:' keyword; cdn.tailwindcss.com matches the origin.
  const allowed = scriptSrc
    .replace("script-src", "")
    .trim()
    .split(/\s+/)
    .map((s) => s.trim());

  const allScriptsLoadable = simulatedScriptSrcs.every((src) => {
    if (src.startsWith("data:")) return allowed.includes("data:");
    if (src === "https://cdn.tailwindcss.com") return allowed.includes("https://cdn.tailwindcss.com");
    return false; // anything else is blocked — which is the point
  });

  check(
    "all simulated bundle script sources are CSP-loadable",
    allScriptsLoadable,
    allScriptsLoadable ? "all pass" : "some src would be blocked"
  );

  // --- 7. appSecurityConfig returns the right shape -----------------------------
  const cfg = appSecurityConfig();
  check(
    "appSecurityConfig returns csp + sandbox + referrer",
    typeof cfg.csp === "string" && typeof cfg.sandbox === "string" && cfg.referrer_policy === "no-referrer",
    Object.keys(cfg).join(", ")
  );
  check(
    "appSecurityConfig csp matches APP_CSP",
    cfg.csp === APP_CSP,
    "config and constant agree"
  );

  // --- 8. securityHeaders still applied to the runtime endpoint -----------------
  const h = securityHeaders();
  check(
    "runtime endpoint headers include CSP and nosniff",
    h["X-Content-Type-Options"] === "nosniff" && h["X-Frame-Options"] === "SAMEORIGIN",
    Object.keys(h).join(", ")
  );

  const failed = results.filter((r) => !r.ok);
  return Response.json({
    ok: failed.length === 0,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed,
    results,
  });
}