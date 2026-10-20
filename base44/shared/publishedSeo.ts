// Published-app SEO surfaces (additive): the two documented well-known files every published
// site serves — /sitemap.xml (the app's page URLs) and /robots.txt (crawl directives).
// Built ONLY from the published app's existing data: its page routes (discovered by the SAME
// route discovery the runtime's own deploy verification uses) and its App Visibility. The URL
// base is the requesting host's own origin, validated to an exact https origin before use —
// no asset URL is invented, no new storage exists, and no SEO behavior beyond these two
// files is implemented (Base44 publishes nothing further — UNKNOWN).
import { discoverRoutes } from "./runtimeVerify.ts";

export const SEO_SITEMAP_MAX_ROUTES = 50;

// The ONLY accepted URL base: an exact https origin (no path, query or fragment). The host
// passes its own window.location.origin; anything else is refused.
export function validPublishedBaseUrl(raw) {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || !u.hostname) return null;
  if (u.pathname !== "/" || u.search || u.hash) return null;
  return u.origin;
}

const xmlEscape = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// The app's page routes, discovered from the deployed artifact's own client files with the
// SAME discovery the runtime's deploy verification uses — "/" first, bounded.
export function buildPublishedSitemapXml(baseUrl, clientFiles) {
  const routes = discoverRoutes(clientFiles || [], SEO_SITEMAP_MAX_ROUTES);
  const entries = routes.map((r) => `  <url><loc>${xmlEscape(`${baseUrl}${r}`)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}

// Crawl directives from the project's App Visibility: a public app allows crawling and names
// its sitemap; a private/workspace app is excluded from crawling entirely. No crawl-delay or
// other directive is invented.
export function buildPublishedRobotsTxt(visibility, baseUrl) {
  const lines = ["User-agent: *"];
  if (visibility === "public") {
    lines.push("Allow: /");
    lines.push(`Sitemap: ${baseUrl}/sitemap.xml`);
  } else {
    lines.push("Disallow: /");
  }
  return `${lines.join("\n")}\n`;
}