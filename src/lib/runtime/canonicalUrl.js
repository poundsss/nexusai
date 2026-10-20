// Self-referencing per-page canonical URL for the deployed published-app host page.
//
// DOCUMENTED Base44 semantics (docs.base44.com, "SEO and search visibility"):
//   • "Base44 adds self-referencing canonical tags to every page" — the canonical
//     references the page's own URL, not the site root.
//   • "For URLs that include query parameters, Base44 intelligently filters out
//     tracking parameters (such as utm_* and fbclid) while preserving
//     content-affecting parameters (such as ?id=123). Parameters are also sorted
//     consistently so that the same page always produces the same canonical URL
//     regardless of parameter order."
//
// NOTHING beyond these documented rules is normalized: the page path travels verbatim
// (no trailing-slash rewriting, no case folding), retained query pairs pass through
// byte-for-byte, and the app-root form is unchanged when no query is present.
const safeDecode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };

const isTrackingParam = (name) => {
  const lower = safeDecode(name).toLowerCase();
  return lower.startsWith("utm_") || lower === "fbclid";
};

// The ONLY documented query normalization: drop tracking parameters, keep every other
// parameter verbatim, sort the retained pairs consistently. Returns "" or "…".
export function canonicalQuery(search) {
  if (!search) return "";
  const kept = [];
  for (const pair of search.split("&")) {
    if (!pair) continue;
    if (isTrackingParam(pair.split("=", 1)[0] || "")) continue;
    kept.push(pair);
  }
  kept.sort();
  return kept.length ? `?${kept.join("&")}` : "";
}

// Canonical URL for the current page: `url` is the app's canonical root (built-in
// published form or custom-domain origin, exactly as the host already computes it),
// `pagePath` is the same per-page path the page title already uses (may carry a query).
export function canonicalPageUrl(url, pagePath) {
  if (!url) return url;
  if (!pagePath) return url;
  const q = pagePath.indexOf("?");
  const path = q === -1 ? pagePath : pagePath.slice(0, q);
  const query = canonicalQuery(q === -1 ? "" : pagePath.slice(q + 1));
  // Root page: unchanged apart from the documented query handling.
  if (path === "/" || path === "") return url + query;
  // Deep link: the page path rides the app root (a trailing slash on a custom-domain
  // root collapses, so the join never doubles it; the path itself is untouched).
  const base = url.replace(/\/+$/, "");
  const page = path.startsWith("/") ? path : `/${path}`;
  return base + page + query;
}