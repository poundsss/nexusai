// Real test for advanced code mutation, file lifecycle operations and bulk database
// operations. Drives the REAL tool executor over the REAL virtual filesystem, and the REAL
// project-scoped data accessor against the REAL database on a throwaway project.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createFs, writeFile, readFile, listFiles, computeChanges } from "../../shared/projectFs.ts";
import { executeTool } from "../../shared/tools.ts";
import { findSymbol, resolveSpecifier, relativeSpecifier } from "../../shared/codeMutation.ts";
import { runBuild } from "../../shared/buildEngine.ts";
import { createServerDb } from "../../shared/appData.ts";

const MAIN = `import { html, render } from 'runtime';
import App from './App.js';
render(html\`<\${App} />\`, document.getElementById('app'));
`;
const APP = `import { html, useRoute } from 'runtime';
import Customers from './pages/Customers.js';
import Card from './components/Card.js';
export default function App() {
  const path = useRoute();
  return html\`<div class="page"><\${Customers} /><\${Card} title="x" /></div>\`;
}
`;
const CUSTOMERS = `import { html, useState, useEffect, db, server } from 'runtime';
import Card from '../components/Card.js';
const PAGE_SIZE = 20;
export function helperLabel(n) {
  return n + ' customers';
}
export default function Customers() {
  const [rows, setRows] = useState([]);
  useEffect(() => { db.Widget.list('-created_date', PAGE_SIZE).then(setRows); }, []);
  async function refresh() {
    const summary = await server.reportSummary({ scope: 'all' });
    setRows(summary.rows || []);
  }
  return html\`<div class="page"><button class="btn btn-primary" onClick=\${refresh}>\${helperLabel(rows.length)}</button><\${Card} title="List" /></div>\`;
}
`;
const CARD = `import { html } from 'runtime';
export default function Card({ title }) {
  return html\`<div class="card"><span class="card-title">\${title}</span></div>\`;
}
`;
const FN = `export const config = { method: 'POST', description: 'summary' };
export default async function handler(ctx) {
  const rows = await ctx.db.Widget.list('-created_date', 10);
  return { status: 200, body: { rows } };
}
`;

function seedFs() {
  const fs = createFs([
    { id: "f1", path: "src/main.js", content: MAIN },
    { id: "f2", path: "src/App.js", content: APP },
    { id: "f3", path: "src/pages/Customers.js", content: CUSTOMERS },
    { id: "f4", path: "src/components/Card.js", content: CARD },
    { id: "f5", path: "functions/reportSummary.js", content: FN },
    { id: "f6", path: "styles.css", content: ":root { --color-primary: #4f46e5; }\n.btn { color: var(--color-primary); }\n.card { display: block; }\n.page { display: block; }\n.btn-primary { color: #fff; }\n.card-title { font-weight: 600; }\n" },
  ]);
  return fs;
}
const ENTITY = { name: "Widget", fields: { title: { type: "string", required: true }, qty: { type: "number" }, state: { type: "enum", enum: ["draft", "live"] } } };

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const stamp = Date.now();
  let project = null;
  const run = (ctx, tool, input) => executeTool(ctx, tool, input, "default");

  try {
    // =========================== code mutation ===============================
    let fs = seedFs();
    let ctx = { fs, entities: [{ ...ENTITY, id: "e1" }], secrets: [], deletes: 0 };

    // apply_patches — atomic multi-edit
    const multi = await run(ctx, "apply_patches", { path: "src/pages/Customers.js", patches: [
      { find: "const PAGE_SIZE = 20;", replace: "const PAGE_SIZE = 50;" },
      { find: "n + ' customers'", replace: "n + ' widgets'" },
    ] });
    check("apply_patches applies every patch", multi.ok && multi.result.patches_applied === 2 && readFile(fs, "src/pages/Customers.js").includes("PAGE_SIZE = 50") && readFile(fs, "src/pages/Customers.js").includes("' widgets'"), JSON.stringify(multi.result || multi.error));

    const before = readFile(fs, "src/pages/Customers.js");
    const partial = await run(ctx, "apply_patches", { path: "src/pages/Customers.js", patches: [
      { find: "PAGE_SIZE = 50", replace: "PAGE_SIZE = 10" },
      { find: "does-not-exist-anywhere", replace: "x" },
    ] });
    check("a failing patch set changes nothing (atomic)", !partial.ok && readFile(fs, "src/pages/Customers.js") === before, partial.error);
    const ambiguous = await run(ctx, "apply_patches", { path: "src/pages/Customers.js", patches: [{ find: "html", replace: "HTML" }] });
    check("ambiguous patch anchors are refused", !ambiguous.ok && /more than one place/.test(ambiguous.error), ambiguous.error);

    // insert_at
    const ins = await run(ctx, "insert_at", { path: "src/components/Card.js", anchor: "import { html } from 'runtime';", position: "after", content: "const DEFAULT_TITLE = 'Untitled';" });
    check("insert_at places code after an anchor", ins.ok && /runtime';\nconst DEFAULT_TITLE/.test(readFile(fs, "src/components/Card.js")), ins.error);
    const insEnd = await run(ctx, "insert_at", { path: "src/components/Card.js", position: "end", content: "export const CARD_VERSION = 2;" });
    check("insert_at can append at end of file", insEnd.ok && readFile(fs, "src/components/Card.js").trimEnd().endsWith("export const CARD_VERSION = 2;"), insEnd.error);
    const insMissing = await run(ctx, "insert_at", { path: "src/components/Card.js", anchor: "nope", position: "before", content: "x" });
    check("insert_at refuses a missing anchor", !insMissing.ok && /anchor was not found/.test(insMissing.error), insMissing.error);

    // replace_range
    const rr = await run(ctx, "replace_range", { path: "src/components/Card.js", start_line: 2, end_line: 2, content: "const DEFAULT_TITLE = 'None';" });
    check("replace_range replaces exact lines", rr.ok && rr.result.lines_replaced === 1 && readFile(fs, "src/components/Card.js").split("\n")[1] === "const DEFAULT_TITLE = 'None';", rr.error);
    const rrBad = await run(ctx, "replace_range", { path: "src/components/Card.js", start_line: 5, end_line: 999, content: "x" });
    check("replace_range refuses an out-of-range span", !rrBad.ok && /cannot replace through line/.test(rrBad.error), rrBad.error);

    // replace_symbol — whole-declaration rewrite
    check("findSymbol resolves a function body with template literals", (() => { const f = findSymbol(readFile(fs, "src/pages/Customers.js"), "Customers"); return !!f && f.text.includes("return html`") && f.text.trimEnd().endsWith("}"); })(), "symbol range");
    const rs = await run(ctx, "replace_symbol", { path: "src/pages/Customers.js", symbol: "helperLabel", content: "export function helperLabel(n) {\n  return n === 1 ? '1 widget' : n + ' widgets';\n}" });
    const afterSym = readFile(fs, "src/pages/Customers.js");
    check("replace_symbol rewrites only that declaration", rs.ok && afterSym.includes("n === 1 ? '1 widget'") && afterSym.includes("export default function Customers()") && afterSym.includes("const PAGE_SIZE = 50;"), rs.error);
    const rsMissing = await run(ctx, "replace_symbol", { path: "src/pages/Customers.js", symbol: "nothingHere", content: "const x = 1;" });
    check("replace_symbol refuses an unknown symbol", !rsMissing.ok && /is not declared/.test(rsMissing.error), rsMissing.error);

    // rename_symbol — project-wide
    const ren = await run(ctx, "rename_symbol", { from: "Card", to: "WidgetCard" });
    check("rename_symbol renames declaration and references", ren.ok && ren.result.files_changed >= 3 && readFile(fs, "src/components/Card.js").includes("function WidgetCard") && readFile(fs, "src/App.js").includes("<${WidgetCard}"), JSON.stringify(ren.result || ren.error));
    check("rename_symbol respects word boundaries", !readFile(fs, "src/components/Card.js").includes("WidgetWidgetCard") && readFile(fs, "src/components/Card.js").includes("card-title"), "no substring damage");
    const renMissing = await run(ctx, "rename_symbol", { from: "NotPresent", to: "Other" });
    check("rename_symbol refuses an absent identifier", !renMissing.ok && /does not appear/.test(renMissing.error), renMissing.error);

    // patch_file — single find/replace + the required-field guard
    const pf = await run(ctx, "patch_file", { path: "src/pages/Customers.js", find: "const PAGE_SIZE = 50;", replace: "const PAGE_SIZE = 30;" });
    check("patch_file applies a single find/replace", pf.ok && readFile(fs, "src/pages/Customers.js").includes("PAGE_SIZE = 30"), pf.error);
    const pfMissing = await run(ctx, "patch_file", { path: "src/pages/Customers.js", replace: "x" });
    check("patch_file refuses a missing 'find'", !pfMissing.ok && /'find' is required/.test(pfMissing.error), pfMissing.error);
    const pfBlank = await run(ctx, "patch_file", { path: "src/pages/Customers.js", find: "   ", replace: "x" });
    check("patch_file refuses a blank 'find'", !pfBlank.ok && /'find' is required/.test(pfBlank.error), pfBlank.error);
    const pfNotFound = await run(ctx, "patch_file", { path: "src/pages/Customers.js", find: "does-not-exist-anywhere", replace: "x" });
    check("patch_file refuses a find target not in the file", !pfNotFound.ok && /not found/.test(pfNotFound.error), pfNotFound.error);

    // ================= file rename / move / copy / delete ====================
    check("relative specifiers resolve and re-base correctly", resolveSpecifier("src/pages/Customers.js", "../components/Card.js") === "src/components/Card.js" && relativeSpecifier("src/App.js", "src/components/ui/Card.js") === "./components/ui/Card.js" && relativeSpecifier("src/pages/a/b.js", "src/components/Card.js") === "../../components/Card.js", "path math");

    const mv = await run(ctx, "move_file", { from: "src/components/Card.js", to: "src/components/ui/WidgetCard.js" });
    const appAfter = readFile(fs, "src/App.js");
    const custAfter = readFile(fs, "src/pages/Customers.js");
    check("move_file relocates the file", mv.ok && listFiles(fs).some((f) => f.path === "src/components/ui/WidgetCard.js") && !listFiles(fs).some((f) => f.path === "src/components/Card.js"), mv.error);
    check("move_file rewrites importers", appAfter.includes("./components/ui/WidgetCard.js") && custAfter.includes("../components/ui/WidgetCard.js"), `${mv.result?.imports_rewritten?.join(",")}`);
    check("move_file re-bases the moved file's own imports", readFile(fs, "src/components/ui/WidgetCard.js").includes("from 'runtime'"), "runtime import intact");
    const mvExisting = await run(ctx, "move_file", { from: "src/components/ui/WidgetCard.js", to: "src/App.js" });
    check("move_file refuses to overwrite an existing file", !mvExisting.ok && /already exists/.test(mvExisting.error), mvExisting.error);

    const mvFn = await run(ctx, "move_file", { from: "functions/reportSummary.js", to: "functions/widgetSummary.js" });
    check("renaming a backend function follows its call sites", mvFn.ok && readFile(fs, "src/pages/Customers.js").includes("server.widgetSummary(") && !readFile(fs, "src/pages/Customers.js").includes("server.reportSummary("), mvFn.error);

    const cp = await run(ctx, "copy_file", { from: "src/pages/Customers.js", to: "src/pages/archive/OldCustomers.js" });
    check("copy_file copies and re-bases imports", cp.ok && readFile(fs, "src/pages/archive/OldCustomers.js").includes("../../components/ui/WidgetCard.js"), cp.error);

    const delGuard = await run(ctx, "delete_files", { paths: ["src/components/ui/WidgetCard.js"] });
    check("delete_files refuses files still imported", !delGuard.ok && /still used by/.test(delGuard.error), delGuard.error);
    const delOk = await run(ctx, "delete_files", { paths: ["src/pages/archive/OldCustomers.js"] });
    check("delete_files removes unreferenced files", delOk.ok && !listFiles(fs).some((f) => f.path === "src/pages/archive/OldCustomers.js"), delOk.error);
    const delForce = await run(ctx, "delete_files", { paths: ["src/components/ui/WidgetCard.js"], force: true });
    check("delete_files honours force", delForce.ok, delForce.error);

    // The project must still be BUILDABLE after the structural churn (restore the component
    // the force-delete removed, which is exactly the repair a real run would make).
    writeFile(fs, "src/components/ui/WidgetCard.js", CARD.replace(/Card/g, "WidgetCard"));
    const build = runBuild(fs, [ENTITY], []);
    check("project still builds after move/rename/copy/delete", build.status === "success", build.logs.filter((l) => l.startsWith("error")).slice(0, 3).join(" | "));
    const changes = computeChanges(fs);
    check("mutations are committable changes", changes.some((c) => c.path === "src/components/ui/WidgetCard.js" && c.change === "added") && changes.some((c) => c.path === "src/components/Card.js" && c.change === "deleted") && changes.some((c) => c.path === "functions/widgetSummary.js"), `${changes.length} changes`);

    // Guard rails preserved from the existing tool surface.
    const frozenFs = createFs([{ id: "z1", path: "src/App.js", content: APP, frozen: true }, { id: "z2", path: "src/pages/P.js", content: "import App from '../App.js';\nexport default function P() { return null; }\n" }]);
    const frozenCtx = { fs: frozenFs, entities: [], secrets: [], deletes: 0 };
    const frozenMove = await run(frozenCtx, "move_file", { from: "src/App.js", to: "src/Root.js" });
    check("frozen files cannot be moved", !frozenMove.ok && /frozen/.test(frozenMove.error), frozenMove.error);
    const badDest = await run(frozenCtx, "copy_file", { from: "src/pages/P.js", to: "secrets/leak.js" });
    check("mutations respect the project layout rules", !badDest.ok && /must live under src\//.test(badDest.error), badDest.error);
    const bulkDeleteCap = await run(frozenCtx, "delete_files", { paths: Array.from({ length: 12 }, (_, i) => `src/pages/x${i}.js`) });
    check("bulk delete is bounded", !bulkDeleteCap.ok, bulkDeleteCap.error);

    // ======================= bulk database operations ========================
    project = await svc.entities.Project.create({ workspace_id: `bulk-ws-${stamp}`, name: `Bulk Test ${stamp}`, slug: `bulk-${stamp}` });
    const db = createServerDb(svc, project.id, [ENTITY]);

    const created = await db.Widget.bulkCreate([
      { title: "a", qty: 1, state: "draft" }, { title: "b", qty: 2, state: "draft" },
      { title: "c", qty: 3, state: "live" }, { title: "d", qty: 4, state: "live" },
    ]);
    check("bulkCreate writes the whole set", created.length === 4 && created.every((i) => i.id) && (await db.Widget.count({})) === 4, `${created.length} created`);

    let rejected = null;
    try { await db.Widget.bulkCreate([{ title: "ok", qty: 5 }, { qty: 6 }]); } catch (e) { rejected = e; }
    check("bulkCreate validates the batch before writing", rejected?.code === "DATABASE_VALIDATION_FAILED" && /record 2/.test(rejected.message) && (await db.Widget.count({})) === 4, rejected?.message);
    let badEnum = null;
    try { await db.Widget.bulkCreate([{ title: "x", state: "archived" }]); } catch (e) { badEnum = e; }
    check("bulk writes enforce enum + unknown-field rules", badEnum?.code === "DATABASE_VALIDATION_FAILED" && (await db.Widget.count({})) === 4, badEnum?.message);
    let overLimit = null;
    try { await db.Widget.bulkCreate(Array.from({ length: 501 }, (_, i) => ({ title: `t${i}` }))); } catch (e) { overLimit = e; }
    check("bulk writes are bounded (500 per call)", overLimit?.code === "DATABASE_BULK_LIMIT" && (await db.Widget.count({})) === 4, overLimit?.message);

    const drafts = await db.Widget.filter({ state: "draft" });
    const upd = await db.Widget.bulkUpdate(drafts.map((d) => ({ id: d.id, data: { qty: 99 } })));
    const draftsAfter = await db.Widget.filter({ state: "draft" });
    check("bulkUpdate merges data per record", upd.length === 2 && draftsAfter.every((d) => d.qty === 99 && d.title), `${upd.length} updated`);
    let missing = null;
    try { await db.Widget.bulkUpdate([{ id: drafts[0].id, data: { qty: 1 } }, { id: "does-not-exist", data: { qty: 2 } }]); } catch (e) { missing = e; }
    check("bulkUpdate resolves every record before writing", missing?.code === "DATABASE_RECORD_NOT_FOUND" && (await db.Widget.get(drafts[0].id)).qty === 99, missing?.message);

    const where = await db.Widget.updateWhere({ state: "live" }, { state: "draft" });
    check("updateWhere updates the matching set", where.updated === 2 && (await db.Widget.count({ state: "draft" })) === 4, `${where.updated} updated`);

    let unsafe = null;
    try { await db.Widget.deleteWhere({}); } catch (e) { unsafe = e; }
    check("deleteWhere refuses an unfiltered wipe", unsafe?.code === "DATABASE_UNSAFE_BULK" && (await db.Widget.count({})) === 4, unsafe?.message);
    const delSome = await db.Widget.deleteWhere({ qty: { $gte: 99 } });
    check("deleteWhere deletes only matches", delSome.deleted === 2 && (await db.Widget.count({})) === 2, `${delSome.deleted} deleted`);
    const rest = await db.Widget.list();
    const bd = await db.Widget.bulkDelete(rest.map((r) => r.id));
    check("bulkDelete removes the given ids", bd.deleted === 2 && (await db.Widget.count({})) === 0, `${bd.deleted} deleted`);
    const emptyWhere = await db.Widget.deleteWhere({ state: "live" });
    check("query-driven bulk ops are safe on empty sets", emptyWhere.deleted === 0, "no-op");

    // RLS: bulk ops must obey per-user ownership exactly like single-record ops.
    const rlsDb = createServerDb(svc, project.id, [ENTITY], { rls: true, user: { id: "user-a" } });
    const otherDb = createServerDb(svc, project.id, [ENTITY], { rls: true, user: { id: "user-b" } });
    const mine = await rlsDb.Widget.bulkCreate([{ title: "mine-1" }, { title: "mine-2" }]);
    check("bulkCreate stamps ownership under RLS", mine.length === 2 && (await rlsDb.Widget.count({})) === 2 && (await otherDb.Widget.count({})) === 0, "owner scoping");
    let crossUser = null;
    try { await otherDb.Widget.bulkUpdate([{ id: mine[0].id, data: { title: "stolen" } }]); } catch (e) { crossUser = e; }
    check("bulk writes cannot cross users under RLS", crossUser?.code === "DATABASE_RECORD_NOT_FOUND" && (await rlsDb.Widget.get(mine[0].id)).title === "mine-1", crossUser?.message);
    const otherWipe = await otherDb.Widget.deleteWhere({ title: { $contains: "mine" } });
    check("deleteWhere under RLS only sees the caller's rows", otherWipe.deleted === 0 && (await rlsDb.Widget.count({})) === 2, `${otherWipe.deleted} deleted`);
    let anon = null;
    try { await createServerDb(svc, project.id, [ENTITY], { rls: true, user: null }).Widget.bulkCreate([{ title: "anon" }]); } catch (e) { anon = e; }
    check("anonymous bulk writes are rejected under RLS", anon?.code === "AUTH_REQUIRED" && (await rlsDb.Widget.count({})) === 2, anon?.message);
    const unknownEntity = await createServerDb(svc, project.id, [ENTITY]).Nope.bulkCreate([{ a: 1 }]).then(() => null).catch((e) => e);
    check("bulk ops on an unknown entity fail structurally", unknownEntity?.code === "DATABASE_ENTITY_NOT_FOUND", unknownEntity?.message);
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    if (project) {
      let rows = await svc.entities.AppRecord.filter({ project_id: project.id }, "-created_date", 500).catch(() => []);
      for (const r of rows) await svc.entities.AppRecord.delete(r.id).catch(() => {});
      await svc.entities.Project.delete(project.id).catch(() => {});
      rows = await svc.entities.AppRecord.filter({ project_id: project.id }, "-created_date", 5).catch(() => []);
      results.push({ name: "scratch data cleaned up", ok: rows.length === 0, detail: `${rows.length} records left` });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}