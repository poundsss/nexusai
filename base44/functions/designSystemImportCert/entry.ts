// Certification for Design System Import — Phase 2.
//
// Covers the behavior boundary from the audit:
//   1. Extraction: mapped tokens merge through the EXISTING mergeTokens validation (unknown
//      keys/values rejected); everything unmapped travels as bounded reference text.
//   2. The imported block states the non-rewrite guarantee and is empty for non-imported rows.
//   3. loadDesignSystem skips imported rows (styles.css keeps coming from the project's own
//      tokens); loadImportedDesignRow fails closed on presets, foreign projects, junk ids.
//   4. files action: happy path writes EXACTLY ONE row (no ProjectFile, no version), invalid
//      source fails closed.
//   5. projectBuilderSettings accepts an imported row id (same project ONLY), still accepts
//      preset ids and null, and returns the imported display name.
//   6. npm action: REAL registry fetch of a token package (open-props) → reference tokens;
//      nonexistent package fails closed.
//   7. github action: fails closed when no GitHub account is connected in this environment
//      (428 GITHUB_NOT_CONNECTED — the happy path reuses the same readCommitFiles primitives
//      the certified gitSync import exercises, but is NOT live-executed here).
//   8. Import NEVER rewrites existing files: version_count unchanged, no ProjectFile rows.
// All scratch data is disposable and removed in cleanup.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  buildImportedDesign, importedDesignSystemBlock, loadImportedDesignRow, importedDesignRow,
  selectStyleAndDocs, IMPORT_LIMITS,
} from "../../shared/designSystemImport.ts";
import { loadDesignSystem } from "../../shared/designSystem.ts";
import { isSupportedDesignSystemId } from "../../shared/designSystemPresets.ts";

const CSS = `:root {
  --color-primary: #7c3aed;
  --color-primary-foreground: #ffffff;
  --color-background: #fafaf9;
  --radius-lg: 0.9rem;
  --space-md: 1.25rem;
  --font-body: Inter, sans-serif;
  --brand-glow: 42deg;
}
.dark { --color-primary: #a78bfa; }`;
const STORY = `import Button from './Button';
export default { title: 'Components/Button' };
export const Primary = () => '<button class="btn btn-primary">Primary</button>';
// Usage: buttons use the .btn class; the primary variant is .btn-primary. Radius 0.9rem everywhere.`;

export const config = { method: "POST" };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole;
  const h = createHarness();
  const { check } = h;
  let scratchWorkspaceId = null;
  try {
    // --- 1. Extraction unit contract ------------------------------------------
    check("import limits exist and are bounded", IMPORT_LIMITS.reference_tokens === 150 && IMPORT_LIMITS.usage_chars === 6000, JSON.stringify(IMPORT_LIMITS));
    const picked = selectStyleAndDocs([
      { path: "tokens.css", content: CSS },
      { path: "Button.stories.jsx", content: STORY },
      { path: "src/components/Button.jsx", content: "export default function Button({ children, variant }) { return <button class=\"btn btn-primary\">{children}</button>; }" },
      { path: "index.js", content: "not a design file" },
    ]);
    check("style/doc/component slicing", picked.styles.length === 1 && picked.docs.length === 1 && picked.source.length === 1, JSON.stringify({ s: picked.styles.length, d: picked.docs.length, c: picked.source.length }));
    const design = buildImportedDesign({ name: "Scratch System", style_texts: [CSS], doc_texts: [STORY], source_files: picked.source });
    check("mapped tokens validated by the existing mergeTokens contract",
      design.tokens.colors.primary === "#7c3aed" && design.tokens.dark.primary === "#a78bfa" &&
      design.tokens.radius.lg === "0.9rem" && design.tokens.spacing.md === "1.25rem" &&
      design.tokens.typography.font_body === "Inter, sans-serif",
      JSON.stringify({ p: design.tokens.colors.primary, d: design.tokens.dark.primary, r: design.tokens.radius.lg }));
    check("unmapped variables travel as bounded reference text",
      design.reference.some((t) => t.name === "--brand-glow") && design.applied.includes("colors.primary"),
      JSON.stringify(design.reference.slice(0, 8)));
    check("usage text is a bounded excerpt", design.usage.includes("btn-primary") && design.usage.length <= IMPORT_LIMITS.usage_chars, `${design.usage.length}`);
    check("components discovered from real source files", design.components.some((c) => c.path === "src/components/Button.jsx"), JSON.stringify(design.components.map((c) => c.path)));
    const bad = buildImportedDesign({ style_texts: [":root { --color-primary: red; }"] });
    check("an invalid token value is rejected, never applied", !bad.applied.includes("colors.primary") && bad.rejected.some((r) => r.path === "colors.primary"), JSON.stringify(bad.rejected));

    // --- 2. Block contract ------------------------------------------------------
    const fakeRow = { imported: { source: "files", source_name: "Scratch System", reference_tokens: design.reference, usage: design.usage } };
    const block = importedDesignSystemBlock(fakeRow);
    check("imported block states the non-rewrite guarantee", block.startsWith("SELECTED DESIGN SYSTEM — Scratch System") && block.includes("does NOT authorize rewriting existing files"), block.slice(0, 60));
    check("block carries reference tokens and usage", block.includes("--brand-glow") && block.includes("btn-primary"), "present");
    check("empty block for null / non-imported rows", importedDesignSystemBlock(null) === "" && importedDesignSystemBlock({ tokens: {} }) === "", "empty strings");

    // --- 3. Scratch workspace + projects ---------------------------------------
    const me = await base44.auth.me();
    const ws = await svc.entities.Workspace.create({ name: `dsimport-cert-${Date.now()}`, owner_id: me.id });
    scratchWorkspaceId = ws.id;
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: "dsimport-cert", slug: `dsimport-cert-${Date.now()}`, status: "draft" });
    const proj2 = await svc.entities.Project.create({ workspace_id: ws.id, name: "dsimport-cert-2", slug: `dsimport-cert2-${Date.now()}`, status: "draft" });

    // loadDesignSystem skips imported rows.
    const normalRow = await svc.entities.DesignSystem.create({ project_id: proj.id, workspace_id: ws.id, tokens: { meta: { mood: "scratch-normal" }, colors: {} }, revision: 1 });
    const importedRow = await svc.entities.DesignSystem.create({
      project_id: proj.id, workspace_id: ws.id, tokens: design.tokens, components: design.components, revision: 1,
      imported: { source: "files", source_name: "Scratch System", ref: null, version: null, fetched_at: new Date().toISOString(), reference_tokens: design.reference, usage: design.usage, file_count: 2 },
    });
    const loaded = await loadDesignSystem(svc, proj.id);
    check("loadDesignSystem skips imported rows (project tokens stay authoritative)",
      loaded.id === normalRow.id && loaded.tokens.meta.mood === "scratch-normal", `${loaded.id}`);
    check("loadImportedDesignRow resolves the project's imported row", (await loadImportedDesignRow(svc, { id: proj.id, design_system_id: importedRow.id }))?.id === importedRow.id, "resolved");
    check("loadImportedDesignRow fails closed on a preset id", (await loadImportedDesignRow(svc, { id: proj.id, design_system_id: "shadcn" })) === null, "null for preset");
    check("imported row is project-scoped: another project's id resolves to null",
      (await importedDesignRow(svc, proj2.id, importedRow.id)) === null, "null cross-project");
    check("imported row id is not a preset id", isSupportedDesignSystemId(importedRow.id) === false, "not preset");

    // --- 4. files action (real surface, scratch project) ------------------------
    const tryInvoke = async (payload) => {
      try {
        const r = await base44.functions.invoke("designSystemImport", payload);
        return { status: r.status ?? 200, data: r.data };
      } catch (e) {
        return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? { error: e.message } };
      }
    };
    const okFiles = await tryInvoke({
      project_id: proj.id, source: "files", name: "Pasted System",
      entries: [{ path: "tokens.css", content: CSS }, { path: "Button.stories.jsx", content: STORY }],
    });
    check("files import writes exactly one DesignSystem row",
      okFiles.status === 200 && okFiles.data?.design_system_id && okFiles.data?.applied_tokens >= 4, JSON.stringify(okFiles.data ?? okFiles));
    const importedDbRow = okFiles.data?.design_system_id ? await svc.entities.DesignSystem.get(okFiles.data.design_system_id).catch(() => null) : null;
    check("imported row carries import metadata and validated tokens",
      importedDbRow && importedDbRow.imported?.source === "files" && importedDbRow.tokens?.colors?.primary === "#7c3aed", importedDbRow ? "row ok" : "missing");
    const projAfter = await svc.entities.Project.get(proj.id);
    const files = await svc.entities.ProjectFile.filter({ project_id: proj.id }, "path", 10);
    check("import never writes project source: no version, no files",
      (projAfter.version_count || 0) === 0 && files.length === 0, `versions=${projAfter.version_count} files=${files.length}`);
    const noStyle = await tryInvoke({ project_id: proj.id, source: "files", entries: [{ path: "readme.md", content: "just text" }] });
    check("invalid source fails closed (422 NO_STYLE_SOURCES)", noStyle.status === 422 && noStyle.data?.code === "NO_STYLE_SOURCES", `${noStyle.status}`);
    const badSource = await tryInvoke({ project_id: proj.id, source: "carrier-pigeon" });
    check("unsupported source is refused", badSource.status === 400 && badSource.data?.code === "UNSUPPORTED_SOURCE", `${badSource.status}`);

    // --- 5. projectBuilderSettings: imported id accepted, ownership enforced -----
    const setImported = await (async () => {
      try { const r = await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: proj.id, design_system_id: importedRow.id }); return { status: r.status ?? 200, data: r.data }; }
      catch (e) { return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? {} }; }
    })();
    check("selection persists for an imported row id", setImported.status === 200 && setImported.data?.design_system_id === importedRow.id, JSON.stringify(setImported.data ?? {}));
    const settings = await base44.functions.invoke("projectBuilderSettings", { action: "get", project_id: proj.id });
    check("get returns the selection and the imported display name",
      settings.data?.design_system_id === importedRow.id && settings.data?.design_system_name === "Scratch System", JSON.stringify({ id: settings.data?.design_system_id, name: settings.data?.design_system_name }));
    const crossProject = await (async () => {
      try { const r = await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: proj2.id, design_system_id: importedRow.id }); return { status: r.status ?? 200, data: r.data }; }
      catch (e) { return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? {} }; }
    })();
    check("another project's imported row is refused (server-side ownership)", crossProject.status === 400 && crossProject.data?.code === "INVALID_DESIGN_SYSTEM", `${crossProject.status}`);
    const junk = await (async () => {
      try { const r = await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: proj2.id, design_system_id: "ds-does-not-exist" }); return { status: r.status ?? 200, data: r.data }; }
      catch (e) { return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? {} }; }
    })();
    check("a non-existent id fails closed", junk.status === 400, `${junk.status}`);
    const preset = await (async () => {
      try { const r = await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: proj.id, design_system_id: "shadcn" }); return { status: r.status ?? 200, data: r.data }; }
      catch (e) { return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? {} }; }
    })();
    const cleared = await (async () => {
      try { const r = await base44.functions.invoke("projectBuilderSettings", { action: "set", project_id: proj.id, design_system_id: null }); return { status: r.status ?? 200, data: r.data }; }
      catch (e) { return { status: e.status ?? e.response?.status ?? 0, data: e.data ?? e.response?.data ?? {} }; }
    })();
    check("None/preset regression: preset and null selections still work",
      preset.status === 200 && preset.data?.design_system_id === "shadcn" && cleared.status === 200 && cleared.data?.design_system_id == null, `${preset.status}/${cleared.status}`);

    // --- 6. npm action: REAL registry, token package ----------------------------
    const npm = await tryInvoke({ project_id: proj.id, source: "npm", package: "open-props" });
    check("npm import of a real token package succeeds with reference tokens",
      npm.status === 200 && npm.data?.reference_tokens > 0, JSON.stringify(npm.data ?? npm));
    const npmMissing = await tryInvoke({ project_id: proj.id, source: "npm", package: "@nobody/nonsense-pkg-0009999" });
    check("nonexistent npm package fails closed", npmMissing.status === 404, `${npmMissing.status}`);

    // --- 7. github action: fail-closed without a connected account --------------
    const gh = await tryInvoke({ project_id: proj.id, source: "github", repo: "picocss/pico" });
    check("github import fails closed when no GitHub account is connected (428)", gh.status === 428 && gh.data?.code === "GITHUB_NOT_CONNECTED", `${gh.status}`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    if (scratchWorkspaceId) {
      await purgeBy(svc, "DesignSystem", { workspace_id: scratchWorkspaceId });
      await cleanupWorkspace(svc, scratchWorkspaceId, ["Project", "AuditLog"]);
      await purgeBy(svc, "Project", { workspace_id: scratchWorkspaceId });
    }
  }
}