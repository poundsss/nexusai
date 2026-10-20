// Pure plan-acceptance and build-gate helpers, extracted from runPipeline.ts unchanged.
import { describeFailure } from "./runDiagnostics.ts";

export const MAX_FILES_PER_RUN = 14;

// Applies the manifest filters + the per-run file cap and reports what was dropped or empty.
// Build-mode plans with no files, entities, integrations or secrets are `empty` (PLAN_EMPTY).
export function finalizePlanManifest(plan, mode) {
  plan.files = plan.files.filter((f) => !String(f.path || "").startsWith("integrations/") && String(f.path || "") !== "styles.css");
  const truncated = plan.files.length > MAX_FILES_PER_RUN ? plan.files.slice(MAX_FILES_PER_RUN).map((f) => f.path) : [];
  if (truncated.length) plan.files = plan.files.slice(0, MAX_FILES_PER_RUN);
  const empty = mode === "default" && !plan.files.length && !plan.entities.length && !(plan.integrations || []).length && !(plan.secrets || []).length;
  return { truncated, empty };
}

// plan.files[].exports contract: optional array of strings. A string is coerced to a one-item
// array; any other shape refuses the plan (non-retryable) before file generation.
export function normalizePlanFileExports(files = []) {
  for (const f of files) {
    if (!f || f.exports === undefined) continue;
    if (typeof f.exports === "string") { f.exports = [f.exports]; continue; }
    if (Array.isArray(f.exports) && f.exports.every((x) => typeof x === "string")) continue;
    throw Object.assign(new Error(`Planner returned invalid exports for ${f.path || "a file"}: expected an array of strings`), { code: "PLAN_INVALID_EXPORTS", retryable: false });
  }
  return files;
}

export function truncationNote(paths = []) {
  return paths.length ? `\n\n**Partially completed:** the plan exceeded the ${MAX_FILES_PER_RUN}-file limit, so ${paths.length} planned file(s) were not generated:\n${paths.map((p) => `- ${p}`).join("\n")}` : "";
}

// Build gate. Before any repair: every generation failure + repair failure (unchanged). After a
// repair: generation failures stay blocking unless repair successfully rewrote their target;
// rejected design tokens are the only exception (repair has no tool to resolve them).
export const isDesignToken = (f) => f.stage === "design" && f.operation === "token";
// Records excluded from the post-repair gate (kept in diagnostics, reported explicitly).
export function gateExcludedFailures(records = [], repaired = false) {
  return repaired ? records.filter(isDesignToken) : [];
}

export function buildGateFailures({ generationLines = [], generationRecords = [], repairLines = [], repairedTargets = [], repaired = false } = {}) {
  if (!repaired) return [...generationLines, ...repairLines];
  const fixed = new Set(repairedTargets);
  const unresolved = generationRecords.filter((f) => !isDesignToken(f) && !(f.path && fixed.has(f.path)));
  return [...unresolved.map((f) => `unresolved generation failure: ${describeFailure(f)}`), ...repairLines];
}