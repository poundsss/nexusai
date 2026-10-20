// Training-data provenance classification.
//
// Decides whether ONE recorded episode came from real production usage or from the platform's own
// test/synthetic machinery. The decision is read from records the platform already wrote — never
// guessed from a name and never supplied by a client:
//   • benchmark_harness — a BenchmarkResult names this project as its isolated scratch project
//     (#38 creates those projects itself, so the benchmark record is authoritative).
//   • synthetic — a SyntheticTask was generated for this project (#25 fixtures).
//   • certification_fixture — the episode itself declares it: context.test_only === true,
//     context.data_origin === "test", or an explicit TEST_ONLY marker in the recorded request.
//   • production — none of the above applies.
//
// Only 'production' may enter a learning dataset. Everything else is excluded with its reason
// recorded, so test data cannot silently become training data. This module classifies only: it
// writes nothing and reinterprets nothing.
export const DATA_ORIGIN_POLICY_VERSION = "1.0.0";
export const DATA_ORIGINS = ["production", "benchmark_harness", "synthetic", "certification_fixture"];
export const TEST_ORIGINS = ["benchmark_harness", "synthetic", "certification_fixture"];

const TEST_MARKER_RE = /\bTEST_ONLY\b|\bSYNTHETIC_FIXTURE\b|\bCERTIFICATION_FIXTURE\b/;

const svcOf = (b) => b.asServiceRole || b;

/**
 * Project-level provenance, read from the authoritative benchmark and synthetic-task records.
 * Cached per project so a build classifies each project once rather than per episode.
 */
export async function projectDataOrigin(base44, project_id, cache = null) {
  if (!project_id) return { origin: "production", evidence: "no project reference" };
  if (cache && cache.has(project_id)) return cache.get(project_id);
  const svc = svcOf(base44);
  let result = { origin: "production", evidence: "no benchmark or synthetic record names this project" };
  const benchmarkRows = await svc.entities.BenchmarkResult.filter({ benchmark_project_id: String(project_id) }, "created_date", 1).catch(() => []);
  if (benchmarkRows.length) {
    result = { origin: "benchmark_harness", evidence: `benchmark result ${benchmarkRows[0].id} used this project as an isolated scratch project` };
  } else {
    const syntheticRows = await svc.entities.SyntheticTask.filter({ project_id: String(project_id) }, "created_at", 1).catch(() => []);
    if (syntheticRows.length) result = { origin: "synthetic", evidence: `synthetic task ${syntheticRows[0].id} was generated for this project` };
  }
  if (cache) cache.set(project_id, result);
  return result;
}

/** Episode-level provenance. The episode's own declaration wins over the project-level signal. */
export async function classifyDataOrigin(base44, trajectory, cache = null) {
  const ctx = trajectory?.context || {};
  if (ctx.test_only === true || String(ctx.data_origin || "").toLowerCase() === "test") {
    return { origin: "certification_fixture", test_only: true, evidence: "episode context declares test-only data", policy_version: DATA_ORIGIN_POLICY_VERSION };
  }
  if (TEST_MARKER_RE.test(String(trajectory?.prompt || ""))) {
    return { origin: "certification_fixture", test_only: true, evidence: "recorded request carries an explicit test marker", policy_version: DATA_ORIGIN_POLICY_VERSION };
  }
  const project = await projectDataOrigin(base44, trajectory?.project_id, cache);
  return { origin: project.origin, test_only: TEST_ORIGINS.includes(project.origin), evidence: project.evidence, policy_version: DATA_ORIGIN_POLICY_VERSION };
}

export const isTestOrigin = (origin) => TEST_ORIGINS.includes(String(origin));