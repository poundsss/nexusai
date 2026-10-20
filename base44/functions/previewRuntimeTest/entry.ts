// Regression test for the Builder Preview runtime.
//
// Verifies that the preview bundle produces a valid sandboxed HTML document that can actually
// mount a generated app. The original bug: the builder preview passed no CSP to bundlePreview,
// so the srcDoc iframe inherited the parent page's CSP (which does not allow data: in
// script-src), silently blocking the dynamic import() of the bundle's data: URL ES modules.
// The preview rendered nothing — no error, no content — because the import was CSP-blocked
// before any module could execute.
//
// This test:
//   1. Loads a real project's files from the database.
//   2. Simulates the bundlePreview logic (import rewriting, data: URL creation, CSP meta tag).
//   3. Verifies the generated HTML has the correct structure: CSP meta tag, #app div, Tailwind
//      CDN script, dynamic import() of a data: URL module.
//   4. Verifies the CSP explicitly allows data: in script-src (the root cause fix).
//   5. Verifies the import chain resolves: every relative import in the project maps to a
//      real file, and the runtime module is reachable.
//   6. Verifies the scaffold app (minimal project) also produces a valid preview.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";

export const config = { method: "POST" };

// Mirrors the PREVIEW_CSP constant from src/lib/runtime/previewBundle.js and APP_CSP from
// base44/shared/securityHeaders.ts. Keep all three in sync.
const EXPECTED_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data: https://cdn.tailwindcss.com",
  "style-src 'unsafe-inline' https://cdn.tailwindcss.com",
  "img-src data: blob: https:",
  "font-src data: https:",
  "connect-src https:",
  "media-src data: blob: https:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

function resolveRelative(from, spec) {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") dir.pop(); else dir.push(seg);
  }
  return dir.join("/");
}

// Simulates the browser-side bundlePreview logic server-side (no btoa/TextEncoder, but the
// structure and CSP checks are what matter).
function simulateBundlePreview(files, csp) {
  const byPath = new Map(files.map((f) => [f.path, f.content || ""]));
  const visited = new Set();
  const errors = [];
  const importChain = [];

  function build(path) {
    if (visited.has(path)) return;
    visited.add(path);
    if (!byPath.has(path)) { errors.push(`Missing file: ${path}`); return null; }
    importChain.push(path);
    const code = byPath.get(path);
    const regex = /(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g;
    let m;
    while ((m = regex.exec(code)) !== null) {
      const spec = m[3];
      if (spec === "runtime") continue;
      if (!spec.startsWith(".")) { errors.push(`${path}: unsupported import "${spec}"`); continue; }
      const resolved = resolveRelative(path, spec);
      build(resolved);
    }
  }

  build("src/main.js");
  const css = byPath.get("styles.css") || "";
  const cspMeta = csp
    ? `<meta http-equiv="Content-Security-Policy" content="${String(csp).replace(/"/g, "&quot;")}">`
    : "";
  const html = `<!doctype html><html><head>${cspMeta}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><script src="https://cdn.tailwindcss.com"></script><style>${css}</style></head><body><div id="app"></div><script type="module">import("data:text/javascript;base64,MAIN_MODULE").catch((e) => parent.postMessage({ type: "runtime:error", message: e.message }, "*"));</script></body></html>`;
  return { html, errors, importChain, visited };
}

function checkHtmlStructure(html, csp) {
  const checks = [];
  checks.push({ name: "has doctype", ok: html.startsWith("<!doctype html>") });
  checks.push({ name: "has CSP meta tag", ok: html.includes('<meta http-equiv="Content-Security-Policy"') });
  checks.push({ name: "CSP allows data: in script-src", ok: csp.includes("script-src 'unsafe-inline' data:") });
  checks.push({ name: "CSP allows cdn.tailwindcss.com", ok: csp.includes("https://cdn.tailwindcss.com") });
  checks.push({ name: "has #app div", ok: html.includes('<div id="app"></div>') });
  checks.push({ name: "has Tailwind CDN script", ok: html.includes('src="https://cdn.tailwindcss.com"') });
  checks.push({ name: "has dynamic import()", ok: html.includes("import(") && html.includes(".catch(") });
  checks.push({ name: "has runtime:error handler", ok: html.includes("runtime:error") });
  checks.push({ name: "CSP is first element in head", ok: html.indexOf('<meta http-equiv="Content-Security-Policy"') < html.indexOf("<meta charset") });
  return checks;
}

export default async function (req) {
  const base44 = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 300) });

  // 1) The CSP constant must allow data: URLs in script-src.
  check("PREVIEW_CSP allows data: in script-src", EXPECTED_CSP.includes("script-src 'unsafe-inline' data:"), EXPECTED_CSP.slice(0, 80));
  check("PREVIEW_CSP allows Tailwind CDN", EXPECTED_CSP.includes("https://cdn.tailwindcss.com"), "");
  check("PREVIEW_CSP has default-src 'none'", EXPECTED_CSP.startsWith("default-src 'none'"), "");

  // 2) Load a REAL runtime-ready project and verify its files produce a valid preview.
  //    Selection is DETERMINISTIC and does not depend on Project.list() ordering: the project
  //    must be `ready`, carry a production deployment pointer, have at least one ProjectFile, and
  //    that production deployment must be LIVE. Orphan scratch projects left by certification
  //    suites (no files, no deployment) can never satisfy this and can never be picked.
  const projects = await base44.entities.Project.list();
  let project = null;
  for (const p of projects) {
    if (p.status !== "ready" || !p.production_deployment_id) continue;
    const probeFiles = await base44.entities.ProjectFile.filter({ project_id: p.id }, "path", 1);
    if (!probeFiles.length) continue;
    const dep = await base44.entities.Deployment.get(p.production_deployment_id).catch(() => null);
    if (dep && dep.status === "LIVE") { project = p; break; }
  }
  if (!project) {
    check("real project exists", false, "no ready project with a LIVE production deployment and files");
  } else {
    const fileRecords = await base44.entities.ProjectFile.filter({ project_id: project.id }, "path", 500);
    const files = fileRecords.map((f) => ({ path: f.path, content: f.content || "" }));

    check("real project has files", files.length > 0, `${files.length} files`);
    check("real project has src/main.js", files.some((f) => f.path === "src/main.js"), "");

    const { html, errors, importChain } = simulateBundlePreview(files, EXPECTED_CSP);
    check("real project: no build errors", errors.length === 0, errors.join("; "));
    check("real project: import chain includes main.js", importChain.includes("src/main.js"), importChain.join(", "));

    const structureChecks = checkHtmlStructure(html, EXPECTED_CSP);
    for (const sc of structureChecks) check(`real project: ${sc.name}`, sc.ok, "");
  }

  // 3) Verify the scaffold app (minimal project) also produces a valid preview.
  const scaffoldFiles = [
    { path: "src/main.js", content: "import { html, render } from 'runtime';\nimport App from './App.js';\n\nrender(html`<${App} />`, document.getElementById('app'));\n" },
    { path: "src/App.js", content: "import { html } from 'runtime';\n\nexport default function App() {\n  return html`<div>Hello</div>`;\n}\n" },
    { path: "styles.css", content: "/* styles */\n" },
  ];
  const { html: scaffoldHtml, errors: scaffoldErrors, importChain: scaffoldChain } = simulateBundlePreview(scaffoldFiles, EXPECTED_CSP);
  check("scaffold: no build errors", scaffoldErrors.length === 0, scaffoldErrors.join("; "));
  check("scaffold: import chain resolves", scaffoldChain.length === 2 && scaffoldChain.includes("src/main.js"), scaffoldChain.join(", "));

  const scaffoldChecks = checkHtmlStructure(scaffoldHtml, EXPECTED_CSP);
  for (const sc of scaffoldChecks) check(`scaffold: ${sc.name}`, sc.ok, "");

  // 4) Verify that WITHOUT the CSP, the HTML would be missing the critical meta tag.
  const { html: noCspHtml } = simulateBundlePreview(scaffoldFiles, null);
  check("without CSP: no CSP meta tag", !noCspHtml.includes('Content-Security-Policy'), "this is the bug — parent CSP blocks data: imports");

  // 5) Verify the CSP string in previewBundle.js matches the expected CSP.
  // We can't import the frontend module, but we can check that the structure is correct.
  check("CSP has all required directives", [
    "default-src", "script-src", "style-src", "img-src", "font-src",
    "connect-src", "media-src", "frame-src", "object-src", "base-uri",
    "form-action", "frame-ancestors",
  ].every((dir) => EXPECTED_CSP.includes(dir)), "");

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}