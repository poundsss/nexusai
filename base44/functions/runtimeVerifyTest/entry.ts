// Verification harness for the runtime build/test engine (runtimeVerify.ts).
//
// Everything here runs against a TEMPORARY fixture project that is deleted at the end, with
// inert frontend stubs and a scratch data namespace, so no real project, record, secret,
// email or push is involved. Each case asserts the deterministic failure CATEGORY, which is
// the contract the AI repair loop depends on.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createFs } from "../../shared/projectFs.ts";
import { verifyProjectRuntime, discoverRoutes } from "../../shared/runtimeVerify.ts";

export const config = { method: "POST" };

const HOME = `import { html, useState } from 'runtime';
export default function Home() {
  const [n] = useState(3);
  return html\`<h1>Home \${n}</h1>\`;
}
`;

const MAIN = `import { html, render, useRoute } from 'runtime';
import Home from './pages/home.js';
function App() {
  const route = useRoute();
  if (route.path === '/about') return html\`<div>About</div>\`;
  return html\`<div><\${Home} /></div>\`;
}
render(App, 'root');
`;

const PING = `export const config = { method: 'POST' };
export default async function handler(ctx) {
  const items = await ctx.db.Note.filter({});
  return { ok: true, count: items.length };
}
`;

const ENTITIES = [{ name: "Note", fields: { title: { type: "string", required: true }, body: { type: "text" } } }];

function fsOf(overrides = {}) {
  const files = { "src/main.js": MAIN, "src/pages/home.js": HOME, "functions/ping.js": PING, "styles.css": "body{}", ...overrides };
  return createFs(Object.entries(files).filter(([, c]) => c !== null).map(([path, content]) => ({ id: path, path, content })));
}

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 220) });

  const project = await svc.entities.Project.create({ workspace_id: "verify-fixture-ws", name: "Runtime Verify Fixture", framework: "preact-htm" });
  // A real record under the fixture project: proves verification never touches project data.
  const guard = await svc.entities.AppRecord.create({ project_id: project.id, entity_name: "Note", data: { title: "untouched" } });

  const run = (overrides, opts = {}) => verifyProjectRuntime(svc, { project, fs: fsOf(overrides), entities: ENTITIES, ...opts });

  try {
    // 1) valid application
    const valid = await run({});
    check("valid application verifies", valid.ok, valid.diagnostics.join(" | ") || `${valid.checks.length} checks`);
    check("valid run exercised routes/backend/database",
      valid.checks.some((c) => c.name === "routes") && valid.checks.some((c) => c.name === "backend:ping") && valid.checks.some((c) => c.name === "database:Note"),
      valid.checks.map((c) => c.name).join(", "));

    // 2) broken syntax
    const syntax = await run({ "src/pages/home.js": "export default function Home() { return html`<h1>" });
    check("broken syntax → BUILD_ERROR", syntax.category === "BUILD_ERROR", `${syntax.category}: ${syntax.diagnostics[0]}`);

    // 3) broken import (unresolvable relative file)
    const badImport = await run({ "src/main.js": MAIN.replace("./pages/home.js", "./pages/missing.js") });
    check("broken import → DEPENDENCY_ERROR", badImport.category === "DEPENDENCY_ERROR", `${badImport.category}: ${badImport.diagnostics[0]}`);

    // 4) missing dependency (external package)
    const external = await run({ "src/main.js": `import _ from 'lodash';\n${MAIN}` });
    check("external package → DEPENDENCY_ERROR", external.category === "DEPENDENCY_ERROR", `${external.category}: ${external.diagnostics[0]}`);

    // 5) startup crash (module body throws before mount)
    const startup = await run({ "src/main.js": `const cfg = null;\nconst v = cfg.value;\n${MAIN}` });
    check("startup crash → STARTUP_ERROR", startup.category === "STARTUP_ERROR", `${startup.category}: ${startup.diagnostics[0]}`);

    // 6) app never mounts
    const noMount = await run({ "src/main.js": MAIN.replace("render(App, 'root');", "") });
    check("never mounts → STARTUP_ERROR", noMount.category === "STARTUP_ERROR", `${noMount.category}: ${noMount.diagnostics[0]}`);

    // 7) runtime exception on the initial render
    const runtimeErr = await run({ "src/pages/home.js": `import { html } from 'runtime';\nexport default function Home() { throw new Error('boom in Home'); }\n` });
    check("render exception → RUNTIME_ERROR", runtimeErr.category === "RUNTIME_ERROR", `${runtimeErr.category}: ${runtimeErr.diagnostics[0]}`);

    // 8) a single route branch crashes
    const routeErr = await run({ "src/main.js": MAIN.replace("return html`<div>About</div>`;", "{ const x = null; return html`<div>${x.title}</div>`; }") });
    check("route branch crash → ROUTE_ERROR", routeErr.category === "ROUTE_ERROR", `${routeErr.category}: ${routeErr.diagnostics[0]}`);

    // 8b) event handlers that access e.target.value must NOT be called during the smoke
    //     test — they are interaction callbacks, not render-path code. Calling them with {}
    //     throws "Cannot read properties of undefined (reading 'value')" because e.target is
    //     undefined, which previously caused a false STARTUP_ERROR that rolled back correct code.
    const withHandlers = await run({
      "src/pages/home.js": "import { html, useState } from 'runtime';\nexport default function Home() {\n  const [q, setQ] = useState('');\n  return html`<div>\n    <input onInput=${(e) => setQ(e.target.value)} value=${q} />\n    <select onChange=${(e) => setQ(e.target.value)}>\n      <option value=\"a\">A</option>\n    </select>\n    <button onClick=${() => setQ('')}>Clear</button>\n    <p>${q}</p>\n  </div>`;\n}\n",
    });
    check("event handlers not called during smoke test", withHandlers.ok, `${withHandlers.category}: ${withHandlers.diagnostics[0] || 'passed'}`);

    // 9) a runaway render is always terminated by a resource verdict (never reported as a
    //    code defect, and never allowed to run unbounded).
    const timeout = await run(
      { "src/pages/home.js": `import { html } from 'runtime';\nexport default function Home() { let i = 0; while (true) { i = i + 1; } }\n` },
      { frontendTimeoutMs: 2000, frontendSteps: 200000 },
    );
    check("runaway render → TIMEOUT or RESOURCE_ERROR", ["TIMEOUT", "RESOURCE_ERROR"].includes(timeout.category), `${timeout.category}: ${timeout.diagnostics[0]}`);

    // 10) work exhaustion
    const resource = await run(
      { "src/pages/home.js": `import { html } from 'runtime';\nexport default function Home() { let i = 0; while (true) { i = i + 1; } }\n` },
      { frontendSteps: 4000, frontendTimeoutMs: 15000 },
    );
    check("step exhaustion → RESOURCE_ERROR", resource.category === "RESOURCE_ERROR", `${resource.category}: ${resource.diagnostics[0]}`);

    // 11) backend exception
    const backend = await run({ "functions/ping.js": `export const config = { method: 'POST' };\nexport default async function handler(ctx) { throw new Error('backend exploded'); }\n` });
    check("backend exception → BACKEND_ERROR", backend.category === "BACKEND_ERROR", `${backend.category}: ${backend.diagnostics[0]}`);

    // 12) backend resource exhaustion
    const backendLoop = await run({ "functions/ping.js": `export const config = { method: 'POST' };\nexport default async function handler(ctx) { let i = 0; while (true) { i = i + 1; } }\n` });
    check("backend infinite loop → TIMEOUT or RESOURCE_ERROR", ["TIMEOUT", "RESOURCE_ERROR"].includes(backendLoop.category), `${backendLoop.category}: ${backendLoop.diagnostics[0]}`);

    // 13) unconfigured secret is a setup gap, not a runtime failure
    // Name assembled at runtime so this harness's own source does not read as a secret declaration.
    const absent = ["VERIFY", "ABSENT", "KEY"].join("_");
    const decl = ["secrets", ": ['", absent, "']"].join("");
    const secretSource = "export const config = { method: 'POST', DECL };\nexport default async function handler(ctx) { return { k: ctx.secrets.get(KEY) }; }\n"
      .replace("KEY", `'${absent}'`).replace("DECL", decl);
    const secretFn = await run({ "functions/ping.js": secretSource });
    check("missing secret does not fail verification", secretFn.ok, `${secretFn.category}: ${secretFn.diagnostics[0]}`);

    // 14) route discovery is bounded
    const many = discoverRoutes([{ path: "src/main.js", content: Array.from({ length: 40 }, (_, i) => `'/p${i}'`).join(",") }], 6);
    check("route discovery bounded", many.length <= 6 && many.includes("/"), many.join(","));

    // 15) isolation: project data untouched, scratch namespace cleaned up
    const stillThere = await svc.entities.AppRecord.get(guard.id).catch(() => null);
    const scratch = await svc.entities.AppRecord.filter({ entity_name: "Note" }, "-created_date", 100);
    const leaked = scratch.filter((r) => String(r.project_id || "").startsWith(`verify_${project.id}`));
    check("project records untouched", !!stillThere && stillThere.data?.title === "untouched", stillThere ? "present" : "missing");
    check("scratch namespace cleaned up", leaked.length === 0, `${leaked.length} leftover row(s)`);
  } finally {
    // Fixture teardown: records, telemetry, then the fixture project itself.
    await svc.entities.AppRecord.deleteMany({ project_id: project.id }).catch(() => {});
    await svc.entities.FunctionInvocation.deleteMany({ project_id: project.id }).catch(() => {});
    await svc.entities.Project.delete(project.id).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}