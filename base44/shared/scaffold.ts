// Server-side copy of the initial project scaffold (mirrors src/lib/scaffold.js, which
// serves the browser build; the two runtimes cannot share a module).
//
// A NEW project starts in the canonical Base44 layout: its `base44/config.jsonc` manifest is the
// project's own declaration of where its resources live, generated from the shared layout contract
// so the scaffold can never disagree with the filesystem or the build about a path. The resource
// directories themselves are not emitted as placeholder files — a directory exists exactly when it
// holds a resource, and the ones this foundation does not support yet are refused by the
// filesystem rather than pre-created empty.
//
// Existing projects are never rewritten: they have no manifest and keep working in the flat layout.
import { configContent } from "./base44Layout.ts";

export function scaffoldFiles(name, description = "") {
  const safe = String(name).replace(/`/g, "");
  return [
    { path: "base44/config.jsonc", content: configContent(name, description) },
    { path: "src/main.js", content: `import { html, render } from 'runtime';\nimport App from './App.js';\n\nrender(html\`<\${App} />\`, document.getElementById('app'));\n` },
    { path: "src/App.js", content: `import { html, useRoute } from 'runtime';\nimport Home from './pages/Home.js';\n\nexport default function App() {\n  const path = useRoute();\n  return html\`<div class="min-h-screen bg-white text-slate-900">\n    \${path === '/' && html\`<\${Home} />\`}\n  </div>\`;\n}\n` },
    { path: "src/pages/Home.js", content: `import { html } from 'runtime';\n\nexport default function Home() {\n  return html\`<main class="min-h-screen flex items-center justify-center p-8">\n    <div class="text-center">\n      <h1 class="text-2xl font-semibold tracking-tight">${safe}</h1>\n      <p class="mt-2 text-sm text-slate-500">Describe what you want to build in the assistant to get started.</p>\n    </div>\n  </main>\`;\n}\n` },
    { path: "styles.css", content: "/* Project styles. Tailwind utilities are available in markup. */\n" },
  ];
}