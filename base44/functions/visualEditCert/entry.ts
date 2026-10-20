// Certification for the Visual Edit style toolbar: the deterministic source transform (unit) and
// the end-to-end projectEdit action "visual_edit" (auth, conflict, persistence, build gate, cleanup)
// on a disposable workspace/project. Nothing outside the scratch workspace is touched.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError } from "../../shared/testHarness.ts";
import { applyVisualEdit, pickedClasses } from "../../shared/visualEditSource.ts";

const PAGE = `export default function Home() {\n  return (<div className="p-4">\n    <h1 className="text-2xl font-bold text-slate-900">Welcome</h1>\n    <p className="text-sm">One</p>\n    <p className="text-sm">Two</p>\n    <span className="text-xs">{count}</span>\n  </div>);\n}\n`;
const HTM_PAGE = "import { html } from 'runtime';\n\nexport default function Home() {\n  return html`<main class=\"p-4\">\n    <h1 class=\"text-2xl font-bold text-slate-900\">Welcome</h1>\n  </main>`;\n}\n";
const h1 = { tag: "h1", html: '<h1 class="text-2xl font-bold text-slate-900">Welcome</h1>', text: "Welcome" };
const PROJECT_ENTITIES = ["ProjectFile", "ProjectVersion", "Build", "CommitJournal", "AuditLog", "Architecture", "ArchitectureNode", "ArchitectureEdge", "TraceEvent"];

async function tryInvoke(client, name, payload) {
  try { const r = await client.functions.invoke(name, payload); return { status: r.status, data: r.data }; }
  catch (e) { return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? { error: e.message } }; }
}
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  let ws = null, project = null;
  try {
    // --- unit: transform ---
    const files = [{ path: "src/pages/Home.jsx", content: PAGE }];
    h.check("u1 picked classes come from the opening tag only", pickedClasses('<p class="a b"><b class="x">y</b></p>') === "a b");
    const e1 = applyVisualEdit(files, { element: h1, changes: { classes: { text_color: "text-blue-600", font_size: "text-4xl" } } });
    h.check("u2 class groups are swapped in place", e1.content.includes('className="font-bold text-blue-600 text-4xl"') && !e1.content.includes("text-slate-900"), e1.content.split("\n")[2]);
    const e2 = applyVisualEdit(files, { element: h1, changes: { text: "Hello there" } });
    h.check("u3 literal text is replaced", e2.content.includes(">Hello there</h1>"));
    const e3 = applyVisualEdit(files, { element: { tag: "p", html: '<p class="text-sm">Two</p>', text: "Two" }, changes: { classes: { font_weight: "font-bold" } } });
    h.check("u4 identical classes are disambiguated by literal text", e3.content.includes('<p className="text-sm font-bold">Two</p>') && e3.content.includes('<p className="text-sm">One</p>'));
    h.check("u5 same classes without text is AMBIGUOUS", code(() => applyVisualEdit(files, { element: { tag: "p", html: '<p class="text-sm"></p>', text: "" }, changes: { classes: { padding: "p-2" } } })) === "VISUAL_EDIT_AMBIGUOUS");
    h.check("u6 dynamic text is refused", code(() => applyVisualEdit(files, { element: { tag: "span", html: '<span class="text-xs">3</span>', text: "3" }, changes: { text: "4" } })) === "VISUAL_EDIT_TEXT_DYNAMIC");
    h.check("u7 unknown element is UNRESOLVED", code(() => applyVisualEdit(files, { element: { tag: "h2", html: '<h2 class="zz">x</h2>' }, changes: { classes: { padding: "p-2" } } })) === "VISUAL_EDIT_UNRESOLVED");
    h.check("u8 non-allowlisted class is refused", code(() => applyVisualEdit(files, { element: h1, changes: { classes: { text_color: "text-[url(x)]" } } })) === "VISUAL_EDIT_INVALID");
    h.check("u9 markup in text is refused", code(() => applyVisualEdit(files, { element: h1, changes: { text: "<script>" } })) === "VISUAL_EDIT_INVALID");
    h.check("u10 unknown style group is refused", code(() => applyVisualEdit(files, { element: h1, changes: { classes: { onclick: "x" } } })) === "VISUAL_EDIT_INVALID");

    // --- end-to-end through projectEdit ---
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "Run as an authenticated workspace owner" }, { status: 401 });
    ws = await svc.entities.Workspace.create({ name: `vedit-ws-${Date.now()}`, owner_id: caller.id, status: "active" });
    project = await svc.entities.Project.create({ workspace_id: ws.id, name: "vedit", slug: `vedit-${Date.now()}`, status: "ready", version_count: 0 });
    const seed = await tryInvoke(base44, "projectEdit", { action: "commit", project_id: project.id, expected_version: 0, edits: [{ path: "src/main.js", content: 'import Home from "./pages/Home.js";\nexport default Home;\n' }, { path: "src/pages/Home.js", content: HTM_PAGE }] });
    h.check("e0 fixture page committed", seed.status === 200 && seed.data?.version?.number === 1, JSON.stringify(seed.data).slice(0, 300));
    const v = await tryInvoke(base44, "projectEdit", { action: "visual_edit", project_id: project.id, expected_version: 1, page_file: "src/pages/Home.js", element: h1, changes: { classes: { text_color: "text-blue-600" }, text: "Hi" } });
    h.check("e1 visual edit commits a new version", v.status === 200 && v.data?.version?.number === 2 && v.data?.path === "src/pages/Home.js", JSON.stringify(v.data).slice(0, 300));
    const [file] = await svc.entities.ProjectFile.filter({ project_id: project.id, path: "src/pages/Home.js" }, "-created_date", 1);
    h.check("e2 the edit is persisted in the project's source", !!file?.content?.includes('class="text-2xl font-bold text-blue-600">Hi</h1>'), String(file?.content || "").split("\n")[4]);
    const stale = await tryInvoke(base44, "projectEdit", { action: "visual_edit", project_id: project.id, expected_version: 1, element: { tag: "main", html: '<main class="p-4"></main>' }, changes: { classes: { padding: "p-2" } } });
    h.check("e3 a stale version is refused with VERSION_CONFLICT", stale.status === 409 && stale.data?.code === "VERSION_CONFLICT", JSON.stringify(stale.data).slice(0, 200));
    const gone = await tryInvoke(base44, "projectEdit", { action: "visual_edit", project_id: project.id, expected_version: 2, element: h1, changes: { classes: { padding: "p-2" } } });
    h.check("e4 the old element no longer resolves (UNRESOLVED → AI fallback)", gone.status === 409 && gone.data?.code === "VISUAL_EDIT_UNRESOLVED", JSON.stringify(gone.data).slice(0, 200));
    const foreign = await tryInvoke(base44, "projectEdit", { action: "visual_edit", project_id: "nonexistent-project", element: h1, changes: { classes: { padding: "p-2" } } });
    h.check("e5 an unauthorized project is refused", [403, 404].includes(foreign.status), String(foreign.status));
    const after = await svc.entities.Project.get(project.id);
    h.check("e6 refusals left the project version unchanged", after.version_count === 2, String(after.version_count));
    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    if (project) {
      for (const e of PROJECT_ENTITIES) await svc.entities[e]?.deleteMany({ project_id: project.id }).catch(() => {});
      await svc.entities.Project.delete(project.id).catch(() => {});
    }
    if (ws) { await svc.entities.AuditLog.deleteMany({ workspace_id: ws.id }).catch(() => {}); await svc.entities.Workspace.delete(ws.id).catch(() => {}); }
  }
}