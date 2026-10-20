import { useEffect } from "react";
import { canonicalPageUrl } from "@/lib/runtime/canonicalUrl";

// CLIENT-SIDE head metadata for the deployed-app host page (NexusAI-native).
//
// The host SPA document is the only document crawlers and social scrapers see; the
// sandboxed iframe's own head is opaque and irrelevant for SEO. Purely additive:
// missing tags are created, existing ones updated, and nothing else on the page
// is touched — no data logic, no runtime behavior change.
//
// Deliberately NOT set here (no public surface exists yet — see SEO audit):
// robots.txt and sitemap.xml are SERVED surfaces (the published runtime's "seo"
// action), not head tags. The canonical URL follows the DOCUMENTED Base44 semantics
// (self-referencing per page; tracking parameters filtered, content parameters kept
// and sorted consistently) — see canonicalPageUrl.
const upsert = (selector, tag, attrs) => {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement(tag);
    document.head.appendChild(el);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null && v !== "") el.setAttribute(k, v);
  }
  return el;
};

export default function AppHeadMeta({ title, description, url, logoUrl, pagePath }) {
  useEffect(() => {
    // Per-page title (documented Base44: "Each page has a unique meta title based on its
    // URL"): the page path rides the app-level title; the app-level title stays the
    // fallback for the root page and whenever no page path is known.
    const pageTitle = pagePath && pagePath !== "/" && title ? `${title} — ${pagePath}` : title;
    if (!pageTitle) return;
    document.title = pageTitle;
    upsert('meta[property="og:title"]', "meta", { property: "og:title", content: pageTitle });
    upsert('meta[property="og:type"]', "meta", { property: "og:type", content: "website" });
    // Self-referencing per-page canonical (documented Base44): the current page URL —
    // the app root on the root page, root + page path on a deep link, with the
    // documented query handling (tracking params dropped, content params kept and
    // sorted). og:url carries the SAME URL.
    const canonicalUrl = url ? canonicalPageUrl(url, pagePath) : window.location.href;
    upsert('meta[property="og:url"]', "meta", { property: "og:url", content: canonicalUrl });
    upsert('meta[name="twitter:card"]', "meta", { name: "twitter:card", content: "summary" });
    upsert('meta[name="twitter:title"]', "meta", { name: "twitter:title", content: pageTitle });
    upsert('link[rel="canonical"]', "link", { rel: "canonical", href: canonicalUrl });
    // Description metas only when an app description exists — absence is a clean no-op.
    if (description) {
      upsert('meta[name="description"]', "meta", { name: "description", content: description });
      upsert('meta[property="og:description"]', "meta", { property: "og:description", content: description });
      upsert('meta[name="twitter:description"]', "meta", { name: "twitter:description", content: description });
    }
    // Project logo → browser favicon + home-screen icon + social preview images
    // (og:image / twitter:image). Applied only when the project has configured a logo (the
    // documented "Edit logo" surface) — the SAME existing public URL, never a new asset or
    // storage. A logo-less app keeps whatever favicon the host document already declares
    // (the platform default), so absence is a no-op.
    if (logoUrl) {
      upsert('link[rel="icon"]', "link", { rel: "icon", href: logoUrl });
      upsert('link[rel="apple-touch-icon"]', "link", { rel: "apple-touch-icon", href: logoUrl });
      upsert('meta[property="og:image"]', "meta", { property: "og:image", content: logoUrl });
      upsert('meta[name="twitter:image"]', "meta", { name: "twitter:image", content: logoUrl });
    }
  }, [title, description, url, logoUrl, pagePath]);
  return null;
}