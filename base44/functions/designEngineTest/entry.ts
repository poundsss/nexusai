// Real integration test for the Design/UI engine: token validation, deterministic stylesheet
// emission, design + accessibility enforcement, component discovery, design indexing and
// retrieval, persistence/revisions, and backward compatibility for projects with no design row.
//
// Drives the REAL modules against the REAL database on a throwaway project, then deletes
// everything it created.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createFs, writeFile, readFile } from "../../shared/projectFs.ts";
import { createEmbedder } from "../../shared/embeddings.ts";
import { syncProjectIndex, hybridSearch, loadIndex } from "../../shared/projectIndex.ts";
import {
  DEFAULT_TOKENS, mergeTokens, normalizeTokens, tokensToCss, lintDesign, discoverComponents,
  designIndexObjects, designBlock, loadDesignSystem, saveDesignSystem,
} from "../../shared/designSystem.ts";

const CLEAN_PAGE = `import { html, useState, db } from 'runtime';
import CustomerCard from '../components/CustomerCard.js';
export default function Customers() {
  const [q, setQ] = useState('');
  return html\`<div class="page">
    <div class="page-header"><h1 class="h1">Customers</h1><button class="btn btn-primary">New</button></div>
    <label class="field-label" for="q">Search</label>
    <input id="q" class="field" value=\${q} onInput=\${e => setQ(e.target.value)} />
    <div class="grid-cards">\${[].map(c => html\`<\${CustomerCard} customer=\${c} />\`)}</div>
  </div>\`;
}
`;
const CARD = `import { html } from 'runtime';
export default function CustomerCard({ customer, onSelect }) {
  return html\`<div class="card"><div class="card-header"><span class="card-title">\${customer.name}</span></div><div class="card-body"><span class="badge">\${customer.tier}</span></div></div>\`;
}
`;
const DIRTY_PAGE = `import { html } from 'runtime';
export default function Dirty() {
  return html\`<div style="background:#1e293b;padding:12px">
    <span class="text-[13px]">hi</span>
    <img src="/logo.png" />
    <input class="rounded-[7px]" />
    <div onClick=\${() => {}}>click me</div>
  </div>\`;
}
`;
const LEGACY_PAGE = `import { html } from 'runtime';\nexport default function Legacy() { return html\`<div style="color:#ff0000">old</div>\`; }\n`;

export default async function (req) {
  const svc = createClientFromRequest(req).asServiceRole;
  const results = [];
  const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); return !!ok; };
  const stamp = Date.now();
  let projectA = null, projectB = null;

  try {
    projectA = await svc.entities.Project.create({ workspace_id: `dstest-ws-${stamp}`, name: `Design Test A ${stamp}`, slug: `dstest-a-${stamp}` });
    projectB = await svc.entities.Project.create({ workspace_id: `dstest-ws-other-${stamp}`, name: `Design Test B ${stamp}`, slug: `dstest-b-${stamp}` });
    const embedder = createEmbedder();

    // --- backward compatibility ----------------------------------------------
    const cold = await loadDesignSystem(svc, projectA.id);
    check("project without a design row gets defaults", cold.exists === false && cold.tokens.colors.primary === DEFAULT_TOKENS.colors.primary && cold.revision === 0, `primary ${cold.tokens.colors.primary}`);
    check("partial stored tokens are filled from defaults", normalizeTokens({ colors: { primary: "#111111" } }).radius.md === DEFAULT_TOKENS.radius.md, "radius preserved");

    // --- token validation -----------------------------------------------------
    const good = mergeTokens(cold.tokens, { rationale: "dark premium", colors: { primary: "#0f766e", background: "#f8fafc" }, radius: { lg: "1.25rem" }, typography: { size_3xl: "2.5rem", weight_bold: "800" } });
    check("valid token patch applies", good.changed && good.tokens.colors.primary === "#0f766e" && good.tokens.radius.lg === "1.25rem" && good.rejected.length === 0, good.applied.join(","));
    check("untouched tokens are preserved", good.tokens.colors.destructive === DEFAULT_TOKENS.colors.destructive && good.tokens.spacing.md === DEFAULT_TOKENS.spacing.md, "preserved");

    const bad = mergeTokens(good.tokens, {
      colors: { primary: "rebeccapurple", nonsense: "#000000" },
      radius: { md: "big" },
      typography: { weight_bold: "extra", font_body: "Inter; } body { display:none" },
      shadows: { md: "url(http://evil.example/x.png)" },
      fakeGroup: { a: "b" },
    });
    const rejectedPaths = bad.rejected.map((r) => r.path).sort();
    check("invalid values are rejected, not applied", bad.tokens.colors.primary === "#0f766e" && bad.tokens.radius.md === DEFAULT_TOKENS.radius.md && bad.tokens.typography.weight_bold === "800", rejectedPaths.join(","));
    check("unknown groups and keys are refused", rejectedPaths.includes("fakeGroup") && rejectedPaths.includes("colors.nonsense"), rejectedPaths.join(","));
    check("CSS-injection token values are refused", bad.rejected.some((r) => r.path === "typography.font_body") && bad.rejected.some((r) => r.path === "shadows.md"), "injection blocked");

    // --- deterministic stylesheet --------------------------------------------
    const css1 = tokensToCss(good.tokens);
    const css2 = tokensToCss(JSON.parse(JSON.stringify(good.tokens)));
    check("stylesheet emission is deterministic", css1 === css2 && css1.length > 2000, `${css1.length} chars`);
    check("stylesheet carries the changed tokens", css1.includes("--color-primary: #0f766e;") && css1.includes("--radius-lg: 1.25rem;"), "tokens emitted");
    check("stylesheet emits light and dark themes", css1.includes(":root {") && css1.includes(".dark {") && css1.includes("--color-background: #0b1120"), "both themes");
    check("stylesheet defines the component recipes", ["\n.btn ", ".btn-primary", ".card ", ".field ", ".nav-link", ".empty-state", ".table "].every((c) => css1.includes(c)), "recipes present");
    check("stylesheet enforces a11y + responsive + reduced motion", css1.includes(":focus-visible") && css1.includes("@media (max-width:") && css1.includes("prefers-reduced-motion"), "guards present");

    // --- design + accessibility enforcement ----------------------------------
    const fs = createFs([]);
    writeFile(fs, "src/main.js", "import { html, render } from 'runtime';\nimport App from './App.js';\nrender(html`<${App} />`, document.getElementById('app'));\n");
    writeFile(fs, "src/App.js", "import { html, useRoute } from 'runtime';\nimport Customers from './pages/Customers.js';\nexport default function App() { const p = useRoute(); return html`<${Customers} />`; }\n");
    writeFile(fs, "src/pages/Customers.js", CLEAN_PAGE);
    writeFile(fs, "src/components/CustomerCard.js", CARD);
    writeFile(fs, "styles.css", css1);

    const cleanLint = lintDesign(fs);
    check("token-based UI passes the design lint", cleanLint.ok, cleanLint.diagnostics.join(" | "));

    writeFile(fs, "src/pages/Dirty.js", DIRTY_PAGE);
    const dirtyLint = lintDesign(fs, { paths: ["src/pages/Dirty.js"] });
    const rules = [...new Set(dirtyLint.violations.map((v) => v.rule))].sort();
    check("hardcoded styling is caught", rules.includes("hardcoded-color") && rules.includes("arbitrary-value") && rules.includes("inline-style"), rules.join(","));
    check("accessibility defects are caught", rules.includes("image-missing-alt") && rules.includes("unlabelled-input") && rules.includes("click-on-div"), rules.join(","));
    check("diagnostics are actionable for the repair loop", dirtyLint.diagnostics.every((d) => d.startsWith("DESIGN_VIOLATION src/pages/Dirty.js:")), dirtyLint.diagnostics[0]);

    writeFile(fs, "src/pages/Legacy.js", LEGACY_PAGE);
    const scoped = lintDesign(fs, { paths: ["src/pages/Customers.js"] });
    check("pre-existing files are not blocked (backward compatible)", scoped.ok && !lintDesign(fs).ok, "scoped to touched files");
    check("stylesheet itself is exempt from the lint", !lintDesign(fs).violations.some((v) => v.path === "styles.css"), "generated CSS ignored");

    // --- component discovery --------------------------------------------------
    const components = discoverComponents(fs);
    const card = components.find((c) => c.path === "src/components/CustomerCard.js");
    check("components are discovered with role and props", !!card && card.role === "card" && card.props.includes("customer") && card.props.includes("onSelect"), JSON.stringify(card || {}));
    check("component variants are captured for reuse", card.variants.includes("card") && card.variants.includes("card-title"), card.variants.join(","));

    // --- indexing + retrieval -------------------------------------------------
    const designObjects = designIndexObjects({ tokens: good.tokens, components });
    const sync = await syncProjectIndex(svc, { project: projectA, fs, entities: [], integrations: [], extraObjects: designObjects, version_number: 1, embedder });
    check("design objects are indexed alongside code", sync.created >= designObjects.length && sync.embedding_failures === 0, `${sync.created} created`);
    const designHits = await hybridSearch(svc, projectA.id, "which colors, radius and button classes does this project's design system use", { limit: 6, types: ["config"], embedder });
    check("design system is retrievable before creating new styles", designHits.some((h) => h.key === "design:colors") && designHits.some((h) => h.key === "design:components"), designHits.map((h) => h.key).join(","));
    const invHits = await hybridSearch(svc, projectA.id, "existing reusable card component to reuse", { limit: 8, embedder });
    check("component inventory is retrievable", invHits.some((h) => h.key === "design:inventory" || h.key === "src/components/CustomerCard.js"), invHits.slice(0, 3).map((h) => h.key).join(" | "));

    const resync = await syncProjectIndex(svc, { project: projectA, fs, entities: [], integrations: [], extraObjects: designObjects, version_number: 1, embedder });
    check("design index is incremental", resync.created === 0 && resync.updated === 0 && resync.unchanged === sync.objects, `${resync.unchanged} unchanged`);

    // --- persistence + revisions ---------------------------------------------
    const saved = await saveDesignSystem(svc, { project: projectA, design: { ...cold, tokens: good.tokens }, components, runId: `dstest-run-${stamp}`, version_number: 1 });
    const reloaded = await loadDesignSystem(svc, projectA.id);
    check("design system persists as project state", reloaded.exists && reloaded.tokens.colors.primary === "#0f766e" && reloaded.components.length === components.length, `revision ${reloaded.revision}`);
    check("stylesheet hash is recorded with the design", !!saved.css_hash && saved.css_hash.length > 4, saved.css_hash);
    const second = mergeTokens(reloaded.tokens, { colors: { primary: "#7c3aed" } });
    await saveDesignSystem(svc, { project: projectA, design: { ...reloaded, tokens: second.tokens }, components, runId: `dstest-run-${stamp}-2`, version_number: 2 });
    const afterSecond = await loadDesignSystem(svc, projectA.id);
    check("token changes bump the revision, not a new row", afterSecond.revision === reloaded.revision + 1 && afterSecond.tokens.colors.primary === "#7c3aed", `revision ${afterSecond.revision}`);
    check("one design system per project", (await svc.entities.DesignSystem.filter({ project_id: projectA.id }, "-created_date", 10)).length === 1, "single row");

    // --- prompt contract ------------------------------------------------------
    const block = designBlock({ tokens: afterSecond.tokens, components, revision: afterSecond.revision });
    check("prompt block states the real tokens", block.includes("primary=#7c3aed") && block.includes(`revision ${afterSecond.revision}`), "tokens in prompt");
    check("prompt block lists reusable components", block.includes("CustomerCard") && block.includes("src/components/CustomerCard.js"), "inventory in prompt");
    check("prompt block forbids ad-hoc styling", /No hardcoded colors/.test(block) && /never be hand-written/.test(block) && /design patch in the plan/.test(block), "rules present");

    // --- isolation ------------------------------------------------------------
    await saveDesignSystem(svc, { project: projectB, design: { id: null, tokens: mergeTokens(DEFAULT_TOKENS, { colors: { primary: "#ea580c" } }).tokens, revision: 0 }, components: [{ name: "PayrollTable", path: "src/components/PayrollTable.js", props: [], role: "table", variants: [] }], runId: `dstest-run-b-${stamp}` });
    await syncProjectIndex(svc, { project: projectB, fs: createFs([]), entities: [], integrations: [], extraObjects: designIndexObjects({ tokens: mergeTokens(DEFAULT_TOKENS, { colors: { primary: "#ea580c" } }).tokens, components: [{ name: "PayrollTable", path: "src/components/PayrollTable.js", props: [], role: "table" }] }), version_number: 1, embedder });
    const aDesign = await loadDesignSystem(svc, projectA.id);
    const crossDesign = await hybridSearch(svc, projectA.id, "payroll table component orange primary", { limit: 10, embedder });
    check("design state is project-isolated", aDesign.tokens.colors.primary === "#7c3aed", `A primary ${aDesign.tokens.colors.primary}`);
    check("design retrieval never crosses projects", !crossDesign.some((h) => /PayrollTable/.test(h.text || "")), `${crossDesign.length} hits`);

    // --- rollback consistency -------------------------------------------------
    const restoredFs = createFs([]);
    writeFile(restoredFs, "src/main.js", readFile(fs, "src/main.js"));
    writeFile(restoredFs, "styles.css", tokensToCss(aDesign.tokens));
    const rollback = await syncProjectIndex(svc, { project: projectA, fs: restoredFs, entities: [], integrations: [], extraObjects: designIndexObjects({ tokens: aDesign.tokens, components: [] }), version_number: 3, embedder });
    const idx = await loadIndex(svc, projectA.id);
    check("rollback re-syncs design + code entries", rollback.deleted > 0 && idx.some((r) => r.key === "design:colors"), `-${rollback.deleted} stale`);
    check("stylesheet always matches the stored tokens", readFile(restoredFs, "styles.css") === tokensToCss((await loadDesignSystem(svc, projectA.id)).tokens), "css == tokens");
  } catch (e) {
    results.push({ name: "harness", ok: false, detail: `${e.name}: ${e.message}` });
  } finally {
    for (const p of [projectA, projectB].filter(Boolean)) {
      for (const row of await loadIndex(svc, p.id).catch(() => [])) await svc.entities.ProjectIndexEntry.delete(row.id).catch(() => {});
      for (const row of await svc.entities.DesignSystem.filter({ project_id: p.id }, "-created_date", 10).catch(() => [])) await svc.entities.DesignSystem.delete(row.id).catch(() => {});
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    const leftDesign = projectA ? await svc.entities.DesignSystem.filter({ project_id: projectA.id }, "-created_date", 5).catch(() => []) : [];
    const leftIndex = projectA ? await loadIndex(svc, projectA.id).catch(() => []) : [];
    results.push({ name: "scratch state cleaned up", ok: leftDesign.length === 0 && leftIndex.length === 0, detail: `${leftDesign.length} design rows, ${leftIndex.length} index rows left` });
  }

  const failed = results.filter((r) => !r.ok);
  return Response.json({ ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, failures: failed, results });
}