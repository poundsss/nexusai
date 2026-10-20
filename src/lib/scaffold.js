// Initial files every new project starts with (a buildable, empty application).
export function scaffoldFiles(name) {
  return [
    {
      path: "src/main.js",
      content: `import { html, render } from 'runtime';\nimport App from './App.js';\n\nrender(html\`<\${App} />\`, document.getElementById('app'));\n`,
    },
    {
      path: "src/App.js",
      content: `import { html, useRoute } from 'runtime';\nimport Home from './pages/Home.js';\n\nexport default function App() {\n  const path = useRoute();\n  return html\`<div class="min-h-screen bg-white text-slate-900">\n    \${path === '/' && html\`<\${Home} />\`}\n  </div>\`;\n}\n`,
    },
    {
      path: "src/pages/Home.js",
      content: `import { html } from 'runtime';\n\nexport default function Home() {\n  return html\`<main class="min-h-screen flex items-center justify-center p-8">\n    <div class="text-center">\n      <h1 class="text-2xl font-semibold tracking-tight">${name.replace(/`/g, "")}</h1>\n      <p class="mt-2 text-sm text-slate-500">Describe what you want to build in the assistant to get started.</p>\n    </div>\n  </main>\`;\n}\n`,
    },
    { path: "styles.css", content: "/* Project styles. Tailwind utilities are available in markup. */\n" },
  ];
}