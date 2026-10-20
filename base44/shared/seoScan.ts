// Deterministic local SEO & GEO scan over a project's EXISTING published files.
//
// No AI, no network crawl, no credit charge: every check is a bounded regex/structural read
// over the project's own file contents, so the same files always produce the same verdict.
//
// PARITY NOTE: Base44 documents the SHAPE of its SEO scan (a 0-100 score with a letter grade,
// weighted categories, critical checks that cap the overall score, scans only meaningful for
// published apps, scans are free). It does NOT publish the check set, weights, caps, formulas
// or thresholds — all of those are UNKNOWN, and everything numeric below is a NexusAI-native
// implementation choice, not a parity claim.
//
// The scan reads only what the project already contains. It does NOT modify generated files,
// the runtime bundle, the <head>, sitemap or robots — those surfaces are untouched by design.

export const MAX_SCAN_FILES = 200;
export const MAX_FILE_BYTES = 100 * 1024;

// NexusAI-native weights and cap (UNKNOWN in Base44's contract — deliberately our own).
export const CATEGORY_WEIGHTS = { discoverability: 40, content: 35, structure: 25 };
export const CRITICAL_CAP = 40;

export function gradeOf(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// Visible text of an htm/jsx/js source: strip code fences, tags and script noise. Bounded.
function visibleText(content) {
  return String(content || "")
    .replace(/`[^`]*`/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function allImgsHaveAlt(content) {
  const imgs = String(content || "").match(/<img\b[^>]*>/g) || [];
  return imgs.every((tag) => /\balt\s*=\s*["'][^"']*["']|\balt\s*=\s*\{/.test(tag));
}

// One deterministic check. `pass` is a pure function of the resolved file list.
const CHECKS = [
  {
    category: "discoverability",
    id: "index_html_present",
    label: "A generated index.html entry page exists",
    weight: 15,
    critical: true,
    run: (files) => {
      const ok = files.some((f) => f.path === "index.html" || f.path.endsWith("/index.html"));
      return { pass: ok, detail: ok ? "index.html found" : "no index.html in the project" };
    },
  },
  {
    category: "discoverability",
    id: "document_title_set",
    label: "The app sets a document/page title",
    weight: 15,
    run: (files) => {
      const ok = files.some((f) => /document\.title\s*=|<title[>\s]/i.test(f.content));
      return { pass: ok, detail: ok ? "title assignment found" : "no document title assignment found" };
    },
  },
  {
    category: "discoverability",
    id: "meta_description_present",
    label: "A page description (meta description) is defined",
    weight: 10,
    run: (files) => {
      const ok = files.some((f) => /name\s*=\s*["']description["']|metaDescription/i.test(f.content));
      return { pass: ok, detail: ok ? "description found" : "no page description found" };
    },
  },
  {
    category: "content",
    id: "h1_present",
    label: "Primary pages carry an h1 heading",
    weight: 15,
    run: (files) => {
      const pages = files.filter((f) => /^src\/pages\//.test(f.path));
      const ok = pages.some((f) => /<h1[>\s]/i.test(f.content));
      return { pass: ok, detail: ok ? "h1 found in page sources" : "no h1 heading in any page" };
    },
  },
  {
    category: "content",
    id: "images_have_alt",
    label: "Images declare alt text",
    weight: 10,
    run: (files) => {
      const pages = files.filter((f) => /^src\/(pages|components)\//.test(f.path));
      const missing = pages.filter((f) => /<img\b/i.test(f.content) && !allImgsHaveAlt(f.content));
      return { pass: missing.length === 0, detail: missing.length === 0 ? "all images carry alt" : `${missing.length} file(s) with <img> missing alt` };
    },
  },
  {
    category: "content",
    id: "text_density",
    label: "Pages contain substantial visible text",
    weight: 10,
    run: (files) => {
      const pages = files.filter((f) => /^src\/pages\//.test(f.path));
      const total = pages.reduce((n, f) => n + visibleText(f.content).length, 0);
      return { pass: total >= 200, detail: `${total} chars of visible page text` };
    },
  },
  {
    category: "structure",
    id: "multiple_pages",
    label: "The app has more than one page",
    weight: 10,
    run: (files) => {
      const count = files.filter((f) => /^src\/pages\//.test(f.path)).length;
      return { pass: count >= 2, detail: `${count} page(s)` };
    },
  },
  {
    category: "structure",
    id: "internal_navigation",
    label: "Pages link to each other internally",
    weight: 10,
    run: (files) => {
      const pages = files.filter((f) => /^src\/pages\//.test(f.path));
      const ok = pages.some((f) => /href\s*=\s*["']\/(?!\/)/.test(f.content));
      return { pass: ok, detail: ok ? "internal links found" : "no internal href=\"/…\" links" };
    },
  },
  {
    category: "structure",
    id: "heading_hierarchy",
    label: "Secondary headings structure the content",
    weight: 5,
    run: (files) => {
      const pages = files.filter((f) => /^src\/pages\//.test(f.path));
      const ok = pages.some((f) => /<h2[>\s]/i.test(f.content));
      return { pass: ok, detail: ok ? "h2 headings found" : "no h2 headings" };
    },
  },
];

// Pure scan over an already-resolved file list: [{ path, content }]. Same input → same output.
export function runSeoChecks(files) {
  const categories = Object.keys(CATEGORY_WEIGHTS).map((category) => {
    const checks = CHECKS.filter((c) => c.category === category).map((c) => {
      const r = c.run(files);
      return { id: c.id, label: c.label, status: r.pass ? "passed" : "failed", weight: c.weight, critical: !!c.critical, detail: r.detail };
    });
    const earned = checks.reduce((n, c) => n + (c.status === "passed" ? c.weight : 0), 0);
    const total = checks.reduce((n, c) => n + c.weight, 0);
    return { category, weight: CATEGORY_WEIGHTS[category], score: Math.round((earned / total) * CATEGORY_WEIGHTS[category]), checks };
  });

  const raw = categories.reduce((n, c) => n + c.score, 0);
  const criticalFailed = categories.some((c) => c.checks.some((k) => k.critical && k.status === "failed"));
  const score = Math.min(raw, criticalFailed ? CRITICAL_CAP : 100);
  return { categories, raw_score: raw, score, grade: gradeOf(score), critical_capped: criticalFailed && raw > CRITICAL_CAP };
}

// The authorized scan execution: the PUBLISHED gate, the deterministic engine, the version-bound
// append-only row and the audit emission — one shared path used by both the HTTP surface and the
// certification test, so every scan goes through the same gates and the same audit primitive.
import { audit } from "./authz.ts";

export async function executeSeoScan(svc, project, workspace, user) {
  if (!project.production_deployment_id || !project.production_version_number) {
    throw Object.assign(new Error("The app has no published production version to scan. Deploy first."), { status: 409, code: "NOT_PUBLISHED" });
  }
  const started = Date.now();
  const files = await resolveScanFiles(svc, project.id);
  if (files.length === 0) {
    throw Object.assign(new Error("The project has no files to scan."), { status: 409, code: "NO_FILES" });
  }
  const result = runSeoChecks(files);
  const duration_ms = Date.now() - started;
  const row = await svc.entities.SeoScan.create({
    project_id: project.id,
    workspace_id: workspace.id,
    user_id: user.id,
    version_number: Number(project.production_version_number),
    production_deployment_id: project.production_deployment_id,
    status: "COMPLETED",
    score: result.score,
    grade: result.grade,
    categories: result.categories,
    critical_capped: result.critical_capped,
    scanned_files: files.length,
    duration_ms,
    completed_at: new Date().toISOString(),
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "seo.scan.completed", resource: "SeoScan", resource_id: row.id,
    metadata: { score: result.score, grade: result.grade, version_number: Number(project.production_version_number), scanned_files: files.length },
  });
  return { row, result, duration_ms, scanned_files: files.length };
}

// Resolves a ProjectFile row set into bounded scan input: inline content wins; content_url is
// fetched once and capped. The resolution is bounded (MAX_SCAN_FILES) so a huge project cannot
// blow the scan budget.
export async function resolveScanFiles(svc, projectId) {
  const rows = await svc.entities.ProjectFile.filter({ project_id: projectId }, "path", MAX_SCAN_FILES);
  const out = [];
  for (const row of rows) {
    if (out.length >= MAX_SCAN_FILES) break;
    let content = String(row.content || "");
    if (!content && row.content_url) {
      try {
        const res = await fetch(row.content_url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) content = (await res.text()).slice(0, MAX_FILE_BYTES);
      } catch {}
    }
    out.push({ path: row.path, content: content.slice(0, MAX_FILE_BYTES) });
  }
  return out;
}