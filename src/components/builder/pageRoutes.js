import { resolveRelative } from "@/lib/runtime/previewBundle";

// Derives the application's pages from the project's REAL files: every module under
// src/pages/ is a page, and its route is read from the route comparisons the app's own
// App module performs (`path === '/x'` / `path.startsWith('/x')`) next to where that page
// component is rendered. Nothing is invented — a page whose route cannot be read from the
// source reports no route rather than a guessed one.
const PAGE_FILE = /^src\/pages\/[^/]+\.jsx?$/;

export function derivePages(files) {
  const pageFiles = (files || []).filter((f) => PAGE_FILE.test(f.path));
  const app = (files || []).find((f) => f.path === "src/App.js" || f.path === "src/App.jsx");
  const routeByFile = {};

  if (app?.content) {
    const fileByComponent = {};
    for (const m of app.content.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) {
      if (m[2].startsWith(".")) fileByComponent[m[1]] = resolveRelative(app.path, m[2]);
    }
    const claim = (component, route) => {
      const file = fileByComponent[component];
      if (file && !routeByFile[file]) routeByFile[file] = route;
    };
    for (const m of app.content.matchAll(/path\s*===\s*['"]([^'"]+)['"][\s\S]{0,240}?<\$\{(\w+)\}/g)) claim(m[2], m[1]);
    for (const m of app.content.matchAll(/path\.startsWith\(\s*['"]([^'"]+)['"]\s*\)[\s\S]{0,240}?<\$\{(\w+)\}/g)) claim(m[2], m[1]);
  }

  return pageFiles
    .map((f) => ({
      file: f.path,
      name: f.path.split("/").pop().replace(/\.jsx?$/, ""),
      route: routeByFile[f.path] || null,
    }))
    .sort((a, b) => (a.route === "/" ? -1 : b.route === "/" ? 1 : a.name.localeCompare(b.name)));
}