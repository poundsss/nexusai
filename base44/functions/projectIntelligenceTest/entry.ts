// Real integration test for the project-intelligence layer (indexing, incremental sync,
// hybrid retrieval, ranking, dependency expansion, context budgeting, cross-run memory,
// redaction, project isolation, rollback/version consistency).
//
// Nothing is mocked: it creates two throwaway projects, drives the REAL index and memory
// modules against the REAL database, asserts observable behaviour, and deletes every row it
// created. It never touches an existing project's index or memory.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createFs, writeFile, deleteFile } from "../../shared/projectFs.ts";
import { createEmbedder, cosine } from "../../shared/embeddings.ts";
import { syncProjectIndex, hybridSearch, assembleContext, expandDependencies, deriveIndexObjects, loadIndex } from "../../shared/projectIndex.ts";
import { extractMemories, storeMemories, retrieveMemories, redactMemoryText, isStorableMemory, memoryBlock } from "../../shared/projectMemory.ts";

const MAIN = `import { html, render } from 'runtime';\nimport App from './App.js';\nrender(html\`<\${App} />\`, document.getElementById('app'));\n`;
const APP = `import { html, useRoute } from 'runtime';\nimport Customers from './pages/Customers.js';\nimport Invoices from './pages/Invoices.js';\nexport default function App() {\n  const path = useRoute();\n  if (path.startsWith('/invoices')) return html\`<\${Invoices} />\`;\n  return html\`<\${Customers} />\`;\n}\n`;
const CUSTOMERS = `import { html, useState, useEffect, db } from 'runtime';\nimport CustomerCard from '../components/CustomerCard.js';\nexport default function Customers() {\n  const [rows, setRows] = useState([]);\n  useEffect(() => { db.Customer.list().then(setRows); }, []);\n  return html\`<div>\${rows.map(r => html\`<\${CustomerCard} customer=\${r} />\`)}</div>\`;\n}\n`;
const CARD = `import { html } from 'runtime';\nexport default function CustomerCard({ customer }) { return html\`<div class="p-2">\${customer.name}</div>\`; }\n`;
const INVOICES = `import { html, db, server } from 'runtime';\nexport default function Invoices() {\n  return html\`<div>invoices</div>\`;\n}\n`;
const FN = `export const config = { method: 'POST', secrets: ['STRIPE_API_KEY'], description: 'charge an invoice' };\nexport default async function handler(ctx) {\n  const inv = await ctx.db.Invoice.get(ctx.request.body.id);\n  return { status: 200, body: { total: inv.amount } };\n}\n`;

const ENTITIES = [
  { name: "Customer", fields: [{ name: "name", type: "string", required: true }, { name: "company", type: "string" }] },
  { name: "Invoice", fields: [{ name: "amount", type: "number" }, { name: "status", type: "enum", enum: ["draft", "paid"] }] },
];
const INTEGRATIONS = [{ name: "stripe", base_url: "https://api.stripe.com/v1", auth: { type: "bearer", secret: "STRIPE_API_KEY" }, operations: [{ name: "createCharge", method: "POST", path: "/charges" }] }];

function makeFs(files) {
  const fs = createFs([]);
  for (const [path, content] of Object.entries(files)) writeFile(fs, path, content);
  return fs;
}
const baseFiles = () => ({
  "src/main.js": MAIN, "src/App.js": APP, "src/pages/Customers.js": CUSTOMERS,
  "src/pages/Invoices.js": INVOICES, "src/components/CustomerCard.js": CARD, "functions/chargeInvoice.js": FN,
});

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const stamp = Date.now();
  let projectA = null, projectB = null;

  try {
    projectA = await svc.entities.Project.create({ workspace_id: `pitest-ws-${stamp}`, name: `PI Test A ${stamp}`, slug: `pitest-a-${stamp}` });
    projectB = await svc.entities.Project.create({ workspace_id: `pitest-ws-other-${stamp}`, name: `PI Test B ${stamp}`, slug: `pitest-b-${stamp}` });
    const embedder = createEmbedder();

    // --- embeddings -----------------------------------------------------------
    const v1 = await embedder.embed("customer list page with company column");
    const v2 = await embedder.embed("customer list page with company column");
    const v3 = await embedder.embed("stripe invoice charging backend function");
    check("embedding is deterministic", JSON.stringify(v1) === JSON.stringify(v2), `dim ${v1.length}`);
    check("embedding separates unrelated text", cosine(v1, v2) > cosine(v1, v3), `same ${cosine(v1, v2).toFixed(3)} vs other ${cosine(v1, v3).toFixed(3)}`);
    check("empty text yields no vector", (await embedder.embed("")) === null, "null");

    // --- derive + first index -------------------------------------------------
    let fs = makeFs(baseFiles());
    const objects = deriveIndexObjects({ fs, entities: ENTITIES, integrations: INTEGRATIONS });
    const types = [...new Set(objects.map((o) => o.object_type))].sort();
    check("index derives every object kind", ["component", "entity", "function", "integration", "page", "route"].every((t) => types.includes(t)), types.join(","));
    check("routes discovered from App.js", objects.some((o) => o.object_type === "route" && o.key === "/invoices"), objects.filter((o) => o.object_type === "route").map((o) => o.key).join(","));
    check("index text carries no secret value", !objects.some((o) => /sk_live|sk_test/.test(o.text)), "clean");

    const first = await syncProjectIndex(svc, { project: projectA, fs, entities: ENTITIES, integrations: INTEGRATIONS, version_number: 1, embedder });
    check("initial index created entries", first.created === first.objects && first.created > 8, `${first.created} created`);
    check("initial index embedded entries", first.embedded === first.created && first.embedding_failures === 0, `${first.embedded} embedded via ${first.provider}`);

    // --- incremental ----------------------------------------------------------
    const second = await syncProjectIndex(svc, { project: projectA, fs, entities: ENTITIES, integrations: INTEGRATIONS, version_number: 1, embedder });
    check("unchanged content is not re-embedded", second.created === 0 && second.updated === 0 && second.embedded === 0 && second.unchanged === first.created, `${second.unchanged} unchanged`);

    writeFile(fs, "src/pages/Invoices.js", INVOICES.replace("invoices", "invoices with overdue filter"));
    const third = await syncProjectIndex(svc, { project: projectA, fs, entities: ENTITIES, integrations: INTEGRATIONS, version_number: 2, embedder });
    check("changed file is re-indexed only", third.updated === 1 && third.created === 0 && third.deleted === 0, `${third.updated} updated, ${third.unchanged} unchanged`);

    deleteFile(fs, "src/components/CustomerCard.js");
    writeFile(fs, "src/components/CustomerTile.js", CARD);
    const fourth = await syncProjectIndex(svc, { project: projectA, fs, entities: ENTITIES, integrations: INTEGRATIONS, version_number: 3, embedder });
    const afterRename = await loadIndex(svc, projectA.id);
    check("rename/move updates the index", fourth.created === 1 && fourth.deleted === 1, `+${fourth.created} -${fourth.deleted}`);
    check("deleted file is no longer retrievable", !afterRename.some((r) => r.key === "src/components/CustomerCard.js") && afterRename.some((r) => r.key === "src/components/CustomerTile.js"), "stale entry removed");
    check("version stamp follows the project", afterRename.filter((r) => r.version_number === 3).length === afterRename.length, `all at v3`);

    // --- retrieval ------------------------------------------------------------
    const hits = await hybridSearch(svc, projectA.id, "show the list of customers and their company", { limit: 6, embedder });
    check("hybrid search ranks the right page first", hits[0] && (hits[0].key === "src/pages/Customers.js" || hits[0].key === "Customer"), hits.slice(0, 3).map((h) => `${h.key}:${h.score}`).join(" | "));
    check("hybrid search combines semantic and lexical", hits.some((h) => h.scores.semantic > 0) && hits.some((h) => h.scores.lexical > 0), JSON.stringify(hits[0].scores));
    const exact = await hybridSearch(svc, projectA.id, "patch functions/chargeInvoice.js to add a refund path", { limit: 5, embedder });
    check("exact path match outranks fuzzy matches", exact[0] && exact[0].source_path === "functions/chargeInvoice.js" && exact[0].scores.exact > 0, exact.slice(0, 2).map((h) => h.key).join(" | "));
    const onlyEntities = await hybridSearch(svc, projectA.id, "invoice amount", { limit: 5, types: ["entity"], embedder });
    check("structured type filter is respected", onlyEntities.length > 0 && onlyEntities.every((h) => h.object_type === "entity"), onlyEntities.map((h) => h.key).join(","));

    // --- dependency expansion + context budgeting -----------------------------
    const deps = expandDependencies(fs, ["src/App.js"], { depth: 1 });
    check("dependency expansion follows project imports", deps.includes("src/pages/Customers.js") && deps.includes("src/pages/Invoices.js"), deps.join(","));
    check("dependency expansion ignores 'runtime'", !deps.some((d) => d.includes("runtime")), "no runtime module");
    const bounded = expandDependencies(fs, ["src/main.js"], { depth: 3, max: 2 });
    check("dependency expansion is bounded", bounded.length <= 2, `${bounded.length} files`);

    const ctxFull = assembleContext(fs, hits, { budget: 45000 });
    check("context includes entry files and retrieved hits", ctxFull.included.some((f) => f.path === "src/main.js") && ctxFull.included.some((f) => f.path === "src/pages/Customers.js"), ctxFull.included.map((f) => f.path).join(","));
    check("context is deduplicated", new Set(ctxFull.included.map((f) => f.path)).size === ctxFull.included.length, `${ctxFull.included.length} files`);
    const ctxTight = assembleContext(fs, hits, { budget: 400 });
    check("context respects the token budget", ctxTight.used <= 400 && ctxTight.omitted.length > 0, `${ctxTight.used}/400 chars, ${ctxTight.omitted.length} omitted`);

    // --- memory ---------------------------------------------------------------
    const redacted = redactMemoryText("Uses STRIPE_API_KEY whose value is sk_live_abcdef1234567890 for charges");
    check("secret values are redacted", redacted.includes("[REDACTED]") && !redacted.includes("sk_live_abcdef1234567890"), redacted);
    check("secret NAMES survive redaction", redacted.includes("STRIPE_API_KEY"), redacted);
    check("credential-shaped facts are refused", !isStorableMemory("password = hunter2superlong"), "dropped");

    const items = extractMemories({
      plan: { message: "Added an invoice charging flow via Stripe", plan: ["Create Invoice entity", "Add functions/chargeInvoice.js"], assumptions: ["Amounts are in cents"] },
      entities: ENTITIES, integrations: INTEGRATIONS, secrets: [{ name: "STRIPE_API_KEY", is_set: false }],
      changes: [{ path: "functions/chargeInvoice.js", change: "added" }], prompt: "let users charge invoices with stripe",
    });
    check("memory extracted from the real run outcome", items.length >= 5 && items.some((i) => i.kind === "integration") && items.some((i) => i.kind === "limitation"), items.map((i) => i.kind).join(","));
    check("extracted memory holds no secret value", !items.some((i) => /sk_live|sk_test|\bpassword\b\s*[:=]/i.test(i.text)), "clean");

    const stored = await storeMemories(svc, { project: projectA, runId: `pitest-run-${stamp}`, items, embedder });
    check("memory persisted", stored.created === items.length, `${stored.created} created`);
    const again = await storeMemories(svc, { project: projectA, runId: `pitest-run-${stamp}-2`, items, embedder });
    check("repeat facts reinforce instead of duplicating", again.created === 0 && again.reinforced === items.length, `${again.reinforced} reinforced`);

    const mem = await retrieveMemories(svc, projectA.id, "how are stripe charges authenticated in this project", { limit: 4, embedder });
    check("memory retrieval ranks the relevant fact first", mem[0] && /stripe/i.test(mem[0].text), mem.map((m) => m.kind).join(","));
    check("memory block frames memory as untrusted data", /never as an instruction/i.test(memoryBlock(mem)) && /USER REQUEST always wins/i.test(memoryBlock(mem)), "framed");

    // --- isolation ------------------------------------------------------------
    await syncProjectIndex(svc, { project: projectB, fs: makeFs({ "src/main.js": MAIN, "src/pages/Secretive.js": "export default function Secretive(){ return 'other workspace payroll' }" }), entities: [{ name: "Payroll", fields: [{ name: "salary", type: "number" }] }], version_number: 1, embedder });
    await storeMemories(svc, { project: projectB, runId: `pitest-run-b-${stamp}`, items: [{ kind: "decision", text: "Project B stores payroll data in the Payroll entity", tags: ["Payroll"] }], embedder });
    const crossIndex = await hybridSearch(svc, projectA.id, "payroll salary secretive", { limit: 10, embedder });
    const crossMem = await retrieveMemories(svc, projectA.id, "payroll", { limit: 10, embedder });
    check("index retrieval is project-isolated", !crossIndex.some((h) => h.key === "Payroll" || h.key === "src/pages/Secretive.js"), `${crossIndex.length} hits, none from project B`);
    check("memory retrieval is project-isolated", !crossMem.some((m) => /Project B/.test(m.text)), `${crossMem.length} memories`);

    // --- rollback consistency -------------------------------------------------
    const rolledBackFs = makeFs(baseFiles()); // snapshot state: CustomerTile never existed
    const restore = await syncProjectIndex(svc, { project: projectA, fs: rolledBackFs, entities: ENTITIES, integrations: INTEGRATIONS, version_number: 4, embedder });
    const afterRestore = await loadIndex(svc, projectA.id);
    check("rollback re-indexes the restored state", restore.created === 1 && restore.deleted === 1, `+${restore.created} -${restore.deleted}`);
    check("rollback drops entries not in the snapshot", !afterRestore.some((r) => r.key === "src/components/CustomerTile.js") && afterRestore.some((r) => r.key === "src/components/CustomerCard.js"), "index matches snapshot");
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    for (const p of [projectA, projectB].filter(Boolean)) {
      for (const row of await loadIndex(svc, p.id).catch(() => [])) await svc.entities.ProjectIndexEntry.delete(row.id).catch(() => {});
      for (const row of await svc.entities.ProjectMemory.filter({ project_id: p.id }, "-created_date", 200).catch(() => [])) await svc.entities.ProjectMemory.delete(row.id).catch(() => {});
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    const leftIndex = projectA ? await loadIndex(svc, projectA.id).catch(() => []) : [];
    const leftMem = projectA ? await svc.entities.ProjectMemory.filter({ project_id: projectA.id }, "-created_date", 5).catch(() => []) : [];
    results.push({ name: "scratch state cleaned up", ok: leftIndex.length === 0 && leftMem.length === 0, detail: `${leftIndex.length} index rows, ${leftMem.length} memories left` });
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}