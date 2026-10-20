// Path-level 301 page redirects for a published app.
//
// Contract source: Base44 docs — "Setting up 301 redirects" + "Create URL redirect" API
// reference. This module implements ONLY the path-level redirect contract:
//   • per-app scope, up to 50 redirects per app
//   • source_path: starts with `/`, no query/fragment, trailing slash stripped,
//     percent-escapes decoded before storing
//   • target_path: an internal `/` path normalized the same way, OR an absolute `https://`
//     URL kept verbatim; no query/fragment
//   • source != target
//   • match_type single | prefix (prefix keeps the remainder of the path)
//   • the visitor's own query string is carried over to the destination
//   • excluded source paths (auth paths + named system files) are rejected and never
//     redirected at runtime
//   • writes require the custom-domains plan entitlement; listing does not
//
// Whole-domain redirects are NOT implemented (their API is undocumented).

export const MAX_REDIRECTS_PER_APP = 50;

// Paths the redirect layer never intercepts: Base44 serves these directly. A source equal to
// (or, for /.well-known, beneath) one of these is rejected at create time, and the runtime
// never redirects a request to one of these even if a rule somehow matched.
const EXACT_EXCLUDED = new Set([
  "/sitemap.xml",
  "/robots.txt",
  "/favicon.ico",
  "/link_preview.png",
  "/manifest.json",
  "/llms.txt",
]);
// Canonical sign-in paths of a published app (the boilerplate auth routes). The docs name
// "login and password reset" as examples; this is the concrete set this platform serves.
const AUTH_PREFIXES = ["/login", "/register", "/forgot-password", "/reset-password", "/oauth/"];

export function isExcludedPath(path) {
  const p = normalizePath(path);
  if (p == null) return false;
  if (EXACT_EXCLUDED.has(p)) return true;
  if (p === "/.well-known" || p.startsWith("/.well-known/")) return true;
  return AUTH_PREFIXES.some((a) => p === a || p.startsWith(a));
}

// Decode percent-escapes, strip trailing slash (root `/` stays `/`), reject query/fragment,
// reject anything not starting with `/`. Returns the normalized path or null if invalid.
export function normalizePath(raw) {
  let p = String(raw || "");
  if (!p.startsWith("/")) return null;
  // No query string or fragment allowed in a source/internal target.
  if (p.includes("?") || p.includes("#")) return null;
  // Percent-escapes are decoded before storing, so `/old/` and `/%6Fld` are the same rule.
  let decoded;
  try { decoded = decodeURIComponent(p); } catch { return null; }
  if (decoded.includes("?") || decoded.includes("#")) return null;
  // Strip a single trailing slash (root `/` is preserved).
  if (decoded.length > 1 && decoded.endsWith("/")) decoded = decoded.slice(0, -1);
  if (!decoded.startsWith("/")) return null;
  return decoded;
}

// A target is either an internal `/` path (normalized) or an absolute `https://` URL kept
// verbatim. No query/fragment. Returns { ok, value, error }.
export function normalizeTarget(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, error: "Target path is required." };
  if (s.startsWith("https://")) {
    if (s.includes("#")) return { ok: false, error: "Target URL must not include a fragment." };
    if (s.includes("?")) return { ok: false, error: "Target URL must not include a query string; the visitor's query string is carried over automatically." };
    return { ok: true, value: s, external: true };
  }
  const internal = normalizePath(s);
  if (internal == null) return { ok: false, error: "Target must be an internal path starting with `/` or an absolute `https://` URL." };
  return { ok: true, value: internal, external: false };
}

// Validates a full rule. Throws a { status, code } error on rejection. Returns the normalized
// { source_path, target_path, match_type }.
export function validateRule({ source_path, target_path, match_type }) {
  const mt = String(match_type || "single");
  if (mt !== "single" && mt !== "prefix") {
    throw Object.assign(new Error("match_type must be 'single' or 'prefix'."), { status: 400, code: "INVALID_MATCH_TYPE" });
  }
  const source = normalizePath(source_path);
  if (source == null) {
    throw Object.assign(new Error("Source path must start with `/` and carry no query string or fragment."), { status: 400, code: "INVALID_SOURCE" });
  }
  if (isExcludedPath(source)) {
    throw Object.assign(new Error("That path is served directly and cannot be redirected. Choose a source outside the sign-in and system file paths."), { status: 400, code: "EXCLUDED_SOURCE" });
  }
  const target = normalizeTarget(target_path);
  if (!target.ok) {
    throw Object.assign(new Error(target.error, { status: 400, code: "INVALID_TARGET" }), { status: 400, code: "INVALID_TARGET" });
  }
  // After normalization an internal target can collide with the source; an external one never can.
  if (!target.external && target.value === source) {
    throw Object.assign(new Error("Source path must differ from the target path."), { status: 400, code: "SOURCE_EQUALS_TARGET" });
  }
  return { source_path: source, target_path: target.value, match_type: mt };
}

// First-match resolver. `rules` is newest- or oldest-first; pass them oldest-first so the
// earliest-created rule wins. Returns { status: 301, location } or null.
export function matchRedirect(rules, requestPath, requestSearch = "") {
  const path = normalizePath(requestPath);
  if (path == null) return null;
  if (isExcludedPath(path)) return null;
  for (const r of rules) {
    if (r.match_type === "single") {
      if (r.source_path === path) return { status: 301, location: buildLocation(r.target_path, "", requestSearch) };
    } else {
      // prefix: exact source OR a path beneath it (segment-aware), keeping the remainder.
      if (r.source_path === path || path.startsWith(r.source_path + "/")) {
        const remainder = path.slice(r.source_path.length);
        return { status: 301, location: buildLocation(r.target_path, remainder, requestSearch) };
      }
    }
  }
  return null;
}

// target + remainder + visitor query string. Target has no query (validated at create), so the
// visitor's search is appended directly. For external targets the remainder is appended to the
// path portion; for internal targets it is appended to the path.
function buildLocation(target, remainder, search) {
  const loc = remainder ? `${target}${remainder}` : target;
  const qs = search && search.startsWith("?") ? search : (search ? `?${search}` : "");
  // Avoid a double `?` if a future external target ever carried one (defensive only — create
  // validation forbids it).
  if (loc.includes("?")) return qs ? `${loc}&${qs.slice(1)}` : loc;
  return `${loc}${qs}`;
}

// Public projection of a stored rule (mirrors the documented API response shape).
export const view = (r) => ({
  id: r.id,
  source_path: r.source_path,
  target_path: r.target_path,
  match_type: r.match_type,
});