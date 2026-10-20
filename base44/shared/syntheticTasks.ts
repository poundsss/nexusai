// NexusAI Synthetic Task Generator — PERSISTENCE, VALIDATION, TASK SETS and BENCHMARK EXPORT.
//
// Turns the pure generator (syntheticTemplates.ts) into a governed, versioned data layer. Generation
// and validation ONLY: nothing here executes a task against a model — that is #23's job, and the
// export path hands generated tasks to the EXISTING BenchmarkTask contract rather than a second one.
//
// Boundaries this module keeps:
//   SERVER-AUTHORIZED + ISOLATED — the workspace is resolved server-side from an authorized owner
//     project, and every read is filtered by that project, so one workspace can never read or
//     generate from another's templates, tasks or task sets.
//   DETERMINISTIC + REPRODUCIBLE — every task records its template version, seed, parameter set,
//     generator version and fingerprint; validation RE-GENERATES the task and refuses if the
//     fingerprint does not reproduce.
//   VALID BEFORE FINALIZED — only a VALID task may be finalized, and only a FINALIZED task may be
//     exported, so an unvalidated or invalid task can never enter a finalized benchmark task set.
//   IMMUTABLE WHEN FINALIZED — finalized templates, tasks and task sets refuse every mutating path;
//     a change is a NEW version.
//   NO DUPLICATES — a generation reproducing an already-finalized fingerprint is recorded as a
//     DUPLICATE instead of silently finalized twice.
//   SYNTHETIC + SCRUBBED — fixtures are generated from fixed synthetic pools, every stored string
//     passes the platform's existing secret scrubber, and validation refuses a task that still
//     contains a credential shape or any artifact of the owner project.
import { scrub, scrubText, recordSpan, newTraceId } from "./tracing.ts";
import { loadAuthorizedProject, audit } from "./authz.ts";
import { fingerprint, initialStateFingerprint, BENCHMARK_LIMITS } from "./benchmark.ts";
import { addBenchmarkTask } from "./benchmark.ts";
import {
  GENERATOR_VERSION, FIXTURE_VERSION, TASK_CATEGORIES, DIFFICULTIES, CHECK_TYPES, INVARIANT_TYPES,
  OUTCOME_TYPES, DEFAULT_PARAMETERS, generateTaskContent, taskFingerprint, templateChecksum, resolveParameters,
} from "./syntheticTemplates.ts";

export const SYNTH_LIMITS = { name: 120, description: 2000, tasks_per_set: 50, list: 100, versions: 100 };
export const TASK_STATUSES = ["DRAFT", "VALID", "INVALID", "FINALIZED", "DUPLICATE"];

// Credential shapes that must never survive into a synthetic task, checked on the STORED content.
const SECRET_SCAN = /(sk_live_[\w-]{8,}|sk_test_[\w-]{8,}|whsec_[\w-]{8,}|ghp_[\w-]{8,}|github_pat_[\w-]{8,}|xox[abposr]-[\w-]{8,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[\w-]{10,}\.[\w-]{5,})/i;

const svcOf = (b) => b.asServiceRole || b;
const nowIso = () => new Date().toISOString();
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };

const SECRET_KEYISH = /(secret|token|password|credential|api[_-]?key|private[_-]?key|authorization)/i;

/**
 * Structure-preserving scrub. The generic deep scrubber truncates long strings and deep structures,
 * which would silently mangle a fixture file or an acceptance assertion — so generated content is
 * scrubbed string-by-string with the platform's own scrubber while its shape is kept intact, and any
 * credential-named key is dropped outright.
 */
function sanitizeDeep(value, maxStr = BENCHMARK_LIMITS.fixture_file_chars) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return scrubText(value, maxStr);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, maxStr));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYISH.test(k) ? "[REDACTED]" : sanitizeDeep(v, maxStr);
    return out;
  }
  return undefined;
}

/**
 * Generates and sanitizes in ONE step, then fingerprints the sanitized result — so the stored task
 * is exactly the task that was fingerprinted, and re-generation (which sanitizes identically)
 * reproduces the same fingerprint.
 */
function generateSanitized(template, seed, parameters) {
  const raw = generateTaskContent({ template, seed, parameters: parameters || {} });
  const content = sanitizeDeep(raw);
  return { content, fingerprint: taskFingerprint({ template, seed, content }) };
}

// --- public projections ---------------------------------------------------------

export const publicTemplate = (t) => ({
  template_id: t.id, template_key: t.template_key, version: t.version, category: t.category,
  difficulty: t.difficulty || null, description: t.description || null,
  required_capabilities: t.required_capabilities || [], generation_parameters: t.generation_parameters || {},
  acceptance_criteria_spec: t.acceptance_criteria_spec || {}, invariants_spec: t.invariants_spec || {},
  fixture_requirements: t.fixture_requirements || {}, expected_outcome_type: t.expected_outcome_type || null,
  generator_version: t.generator_version, checksum: t.checksum || null, finalized: !!t.finalized,
  workspace_id: t.workspace_id, project_id: t.project_id,
  created_at: t.created_at || t.created_date, finalized_at: t.finalized_at || null,
});

export const publicSyntheticTask = (t) => ({
  task_id: t.id, task_key: t.task_key, task_version: t.task_version || 1, status: t.status,
  template_id: t.template_id, template_key: t.template_key, template_version: t.template_version,
  generator_version: t.generator_version, seed: t.seed, parameters: t.parameters || {},
  fingerprint: t.fingerprint, category: t.category, difficulty: t.difficulty,
  complexity: t.complexity || {}, definition: t.definition || {},
  initial_state: t.initial_state || {}, initial_state_fingerprint: t.initial_state_fingerprint || null,
  fixture: t.fixture || {}, acceptance_criteria: t.acceptance_criteria || {}, invariants: t.invariants || [],
  required_capabilities: t.required_capabilities || [], verification_criteria: t.verification_criteria || {},
  targets: t.targets || {}, validation: t.validation || null, validated_at: t.validated_at || null,
  duplicate_of_task_id: t.duplicate_of_task_id || null, benchmark_task_refs: t.benchmark_task_refs || [],
  trace_id: t.trace_id || null, run_id: t.run_id || null,
  workspace_id: t.workspace_id, project_id: t.project_id, finalized: !!t.finalized,
  created_at: t.created_at || t.created_date, finalized_at: t.finalized_at || null,
});

export const publicTaskSet = (s) => ({
  task_set_id: s.id, name: s.name, description: s.description || null, version: s.version, status: s.status,
  generator_version: s.generator_version, task_ids: s.task_ids || [], members: s.members || [],
  membership_fingerprint: s.membership_fingerprint || null, checksum: s.checksum || null,
  item_count: s.item_count || 0, parent_task_set_id: s.parent_task_set_id || null,
  workspace_id: s.workspace_id, project_id: s.project_id, trace_id: s.trace_id || null,
  finalized: !!s.finalized, created_at: s.created_at || s.created_date, finalized_at: s.finalized_at || null,
});

// --- templates ------------------------------------------------------------------

/**
 * Creates a template, or the NEXT version of an existing template key. Category, difficulty and
 * outcome type are validated against the generator's registries — an unknown value is refused
 * rather than silently producing an empty task.
 */
export async function createTemplate(base44, user, {
  project_id, template_key, category, difficulty = "medium", description = null,
  required_capabilities = [], generation_parameters = null, acceptance_criteria_spec = null,
  invariants_spec = null, fixture_requirements = null, expected_outcome_type = null,
} = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to create a task template");
  const key = String(template_key || "").trim().slice(0, SYNTH_LIMITS.name);
  if (!key) fail(400, "INVALID_INPUT", "template_key is required");
  if (!TASK_CATEGORIES.includes(category)) fail(400, "UNKNOWN_CATEGORY", `Unknown task category: ${category}. Supported: ${TASK_CATEGORIES.join(", ")}`);
  if (!DIFFICULTIES.includes(difficulty)) fail(400, "UNKNOWN_DIFFICULTY", `Unknown difficulty: ${difficulty}`);
  if (expected_outcome_type && !OUTCOME_TYPES.includes(expected_outcome_type)) fail(400, "UNKNOWN_OUTCOME_TYPE", `Unknown expected_outcome_type: ${expected_outcome_type}`);

  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const svc = svcOf(base44);
  const siblings = (await svc.entities.TaskTemplate.filter({ template_key: key }, "-version", SYNTH_LIMITS.versions).catch(() => []))
    .filter((t) => t.workspace_id === workspace.id);
  const version = Math.max(0, ...siblings.map((t) => t.version || 0)) + 1;

  const draft = {
    template_key: key, version, category, difficulty,
    description: description ? scrubText(description, SYNTH_LIMITS.description) : null,
    required_capabilities: (required_capabilities || []).map((c) => String(c).slice(0, 60)).slice(0, 12),
    generation_parameters: scrub({ ...DEFAULT_PARAMETERS, ...(generation_parameters || {}) }),
    acceptance_criteria_spec: scrub({
      min_checks: acceptance_criteria_spec?.min_checks ?? 3,
      required_check_types: (acceptance_criteria_spec?.required_check_types || []).filter((t) => CHECK_TYPES.includes(t)),
      machine_readable_required: true,
    }),
    invariants_spec: scrub({
      min_invariants: invariants_spec?.min_invariants ?? 1,
      required_invariant_types: (invariants_spec?.required_invariant_types || []).filter((t) => INVARIANT_TYPES.includes(t)),
    }),
    fixture_requirements: scrub({
      fixture_version: FIXTURE_VERSION, isolated: true, synthetic_only: true,
      require_seed_entities: !!fixture_requirements?.require_seed_entities,
      require_seed_data: !!fixture_requirements?.require_seed_data,
      ...(fixture_requirements || {}),
    }),
    expected_outcome_type: expected_outcome_type || null,
    generator_version: GENERATOR_VERSION,
  };
  const record = await svc.entities.TaskTemplate.create({
    ...draft, checksum: templateChecksum(draft), finalized: false,
    workspace_id: workspace.id, project_id: project.id, created_by: user.id, created_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "synthetic.template.created", resource: "TaskTemplate", resource_id: record.id,
    metadata: { template_key: key, version, category, checksum: record.checksum },
  });
  return { template: publicTemplate(record) };
}

async function authorizeTemplate(base44, user, template_id, capability = "project.write") {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use task templates");
  if (!template_id) fail(400, "INVALID_INPUT", "template_id is required");
  const svc = svcOf(base44);
  const template = await svc.entities.TaskTemplate.get(String(template_id)).catch(() => null);
  if (!template) fail(404, "TEMPLATE_NOT_FOUND", "Task template not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, template.project_id, capability);
  if (template.workspace_id && template.workspace_id !== workspace.id) fail(403, "NOT_A_MEMBER", "Template belongs to another workspace");
  return { template, project, workspace };
}

/** Finalizing makes a template immutable: from here a change means a new version. */
export async function finalizeTemplate(base44, user, { template_id } = {}) {
  const { template, project, workspace } = await authorizeTemplate(base44, user, template_id, "project.write");
  if (template.finalized) return { template: publicTemplate(template), already_finalized: true };
  const svc = svcOf(base44);
  const updated = await svc.entities.TaskTemplate.update(template.id, { finalized: true, finalized_at: nowIso() });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "synthetic.template.finalized", resource: "TaskTemplate", resource_id: template.id,
    metadata: { template_key: template.template_key, version: template.version },
  });
  return { template: publicTemplate(updated) };
}

export async function listTemplateVersions(base44, user, { project_id, template_key = null } = {}) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.TaskTemplate.filter(
    { workspace_id: workspace.id, project_id: project.id, ...(template_key ? { template_key: String(template_key) } : {}) }, "version", SYNTH_LIMITS.list);
  return { project_id: project.id, count: rows.length, templates: rows.map(publicTemplate) };
}

// --- generation -----------------------------------------------------------------

async function authorizeTask(base44, user, task_id, capability = "project.write") {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use synthetic tasks");
  if (!task_id) fail(400, "INVALID_INPUT", "task_id is required");
  const svc = svcOf(base44);
  const task = await svc.entities.SyntheticTask.get(String(task_id)).catch(() => null);
  if (!task) fail(404, "TASK_NOT_FOUND", "Synthetic task not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, task.project_id, capability);
  if (task.workspace_id && task.workspace_id !== workspace.id) fail(403, "NOT_A_MEMBER", "Synthetic task belongs to another workspace");
  return { task, project, workspace };
}

/**
 * Generates one task from a template + seed + parameters.
 *
 * Idempotent on the fingerprint within the owner project: re-generating identical inputs resolves
 * the EXISTING task instead of inserting a second copy, which is what makes repeated generation
 * safe rather than a source of duplicates.
 */
export async function generateTask(base44, user, {
  project_id, template_id, seed, parameters = null, trace_id = null, run_id = null,
} = {}) {
  const { template, project, workspace } = await authorizeTemplate(base44, user, template_id, "project.write");
  const seedText = String(seed ?? "").trim().slice(0, 200);
  if (!seedText) fail(400, "INVALID_INPUT", "A generation seed is required — without it the task would not be reproducible");
  const svc = svcOf(base44);
  const trace = trace_id || newTraceId();

  const { content, fingerprint: fp } = generateSanitized(template, seedText, parameters);
  const task_key = fingerprint("stkey", { template_key: template.template_key, template_version: template.version, generator_version: GENERATOR_VERSION, seed: seedText, parameters: content.parameters });

  const existing = (await svc.entities.SyntheticTask.filter({ project_id: project.id, task_key }, "-task_version", SYNTH_LIMITS.versions).catch(() => []));
  const identical = existing.find((t) => t.fingerprint === fp);
  if (identical) return { task: publicSyntheticTask(identical), created: false, reason: "identical_generation" };

  const record = await svc.entities.SyntheticTask.create({
    task_key, task_version: Math.max(0, ...existing.map((t) => t.task_version || 0)) + 1,
    template_id: template.id, template_key: template.template_key, template_version: template.version,
    generator_version: GENERATOR_VERSION, seed: seedText, parameters: content.parameters, fingerprint: fp,
    status: "DRAFT", category: content.category, difficulty: content.difficulty,
    complexity: content.complexity, definition: content.definition,
    initial_state: content.initial_state, initial_state_fingerprint: initialStateFingerprint(content.initial_state),
    fixture: content.fixture, acceptance_criteria: content.acceptance_criteria,
    invariants: content.invariants, required_capabilities: content.required_capabilities,
    verification_criteria: content.verification_criteria, targets: content.targets,
    trace_id: trace, run_id: run_id || undefined,
    workspace_id: workspace.id, project_id: project.id, finalized: false,
    created_by: user.id, created_at: nowIso(),
  });
  await recordSpan(svc, {
    trace_id: trace, workspace_id: workspace.id, project_id: project.id, run_id: run_id || null,
    event_type: "background_job", name: "synthetic.task.generated", status: "ok", reference_id: record.id,
    metadata: { generator_version: GENERATOR_VERSION, template_key: template.template_key, template_version: template.version, seed: seedText, category: content.category, difficulty: content.difficulty, fingerprint: fp },
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "synthetic.task.generated", resource: "SyntheticTask", resource_id: record.id,
    metadata: { template_key: template.template_key, template_version: template.version, seed: seedText, fingerprint: fp, trace_id: trace },
  });
  return { task: publicSyntheticTask(record), created: true };
}

// --- validation -----------------------------------------------------------------

const ref = (ok, name, detail) => ({ name, ok, detail });

/** Every artifact a check may legitimately point at: the fixture's own, plus the declared targets. */
function resolvableArtifacts(task) {
  const files = new Set([...(task.initial_state?.files || []).map((f) => f.path), ...(task.targets?.files || [])]);
  const entities = new Set([...(task.initial_state?.entities || []).map((e) => e.name), ...(task.targets?.entities || [])]);
  return { files, entities, functions: new Set(task.targets?.functions || []), routes: new Set(task.targets?.routes || []) };
}

function unresolvedReferences(task) {
  const { files, entities, functions, routes } = resolvableArtifacts(task);
  const out = [];
  for (const c of task.acceptance_criteria?.checks || []) {
    const a = c.assert || {};
    if (a.path && !files.has(a.path)) out.push(`${c.check_id}: file ${a.path}`);
    if (a.entity && !entities.has(a.entity)) out.push(`${c.check_id}: entity ${a.entity}`);
    if (a.function_name && !functions.has(a.function_name)) out.push(`${c.check_id}: function ${a.function_name}`);
    if (a.route && !routes.has(a.route)) out.push(`${c.check_id}: route ${a.route}`);
    if (a.renders_file && !files.has(a.renders_file)) out.push(`${c.check_id}: file ${a.renders_file}`);
    if (a.module && !files.has(a.module)) out.push(`${c.check_id}: module ${a.module}`);
    for (const p of a.must_reference_all || []) if (!files.has(p)) out.push(`${c.check_id}: file ${p}`);
  }
  for (const i of task.invariants || []) {
    const a = i.assert || {};
    if (a.entity && !entities.has(a.entity)) out.push(`${i.invariant_id}: entity ${a.entity}`);
    if (a.function_name && !functions.has(a.function_name)) out.push(`${i.invariant_id}: function ${a.function_name}`);
    if (a.route && !routes.has(a.route)) out.push(`${i.invariant_id}: route ${a.route}`);
    if (a.from && !entities.has(a.from)) out.push(`${i.invariant_id}: entity ${a.from}`);
    if (a.to && a.from && !entities.has(a.to)) out.push(`${i.invariant_id}: entity ${a.to}`);
  }
  return out;
}

/**
 * Seeds the task's fixture into a THROWAWAY project inside the benchmark's own workspace, verifies
 * every fixture artifact materializes, then deletes it. This is what makes "executable in an
 * isolated scratch project" a checked fact rather than a claim — and no user or production project
 * is ever touched.
 */
async function probeIsolatedExecutability(svc, task) {
  const files = task.initial_state?.files || [];
  const entities = task.initial_state?.entities || [];
  let scratch = null;
  try {
    scratch = await svc.entities.Project.create({
      workspace_id: task.workspace_id,
      name: `synthtask-probe-${String(task.id).slice(-8)}`.slice(0, 120),
      description: "Isolated synthetic-task validation probe. Created and deleted by the task generator; not a user project.",
      framework: "preact-htm", status: "draft", version_count: 1,
    });
    if (files.length) await svc.entities.ProjectFile.bulkCreate(files.map((f) => ({ project_id: scratch.id, path: f.path, content: f.content, frozen: false })));
    for (const e of entities) await svc.entities.AppEntity.create({ project_id: scratch.id, name: e.name, fields: e.fields || {} });
    const [seededFiles, seededEntities] = await Promise.all([
      svc.entities.ProjectFile.filter({ project_id: scratch.id }, "path", 200),
      svc.entities.AppEntity.filter({ project_id: scratch.id }, "name", 100),
    ]);
    const ok = seededFiles.length === files.length && seededEntities.length === entities.length;
    return { ok, detail: ok ? `Fixture materialized in an isolated scratch project (${seededFiles.length} file(s), ${seededEntities.length} entity declaration(s)), which was then destroyed.` : `Fixture did not materialize (${seededFiles.length}/${files.length} files, ${seededEntities.length}/${entities.length} entities)`, probe_project_id: scratch.id };
  } catch (e) {
    return { ok: false, detail: `Isolated probe failed: ${scrubText(e.message, 200)}`, probe_project_id: scratch?.id || null };
  } finally {
    if (scratch) {
      await svc.entities.ProjectFile.deleteMany({ project_id: scratch.id }).catch(() => {});
      await svc.entities.AppEntity.deleteMany({ project_id: scratch.id }).catch(() => {});
      await svc.entities.Project.delete(scratch.id).catch(() => {});
    }
  }
}

/**
 * Validates ONE generated task against every quality gate. A task only becomes VALID when all of
 * them hold; anything else is recorded as INVALID with an explainable report, and an INVALID task
 * can never be finalized or exported.
 */
export async function validateTask(base44, user, { task_id } = {}) {
  const { task, project, workspace } = await authorizeTask(base44, user, task_id, "project.write");
  if (task.finalized) return { task: publicSyntheticTask(task), validation: task.validation, already_finalized: true };
  const svc = svcOf(base44);
  const template = await svc.entities.TaskTemplate.get(task.template_id).catch(() => null);
  const checks = [];

  // 1. Schema correctness of the generated task itself.
  const schemaOk = !!task.task_key && TASK_CATEGORIES.includes(task.category) && DIFFICULTIES.includes(task.difficulty)
    && !!task.definition?.goal && Array.isArray(task.acceptance_criteria?.checks) && Array.isArray(task.invariants)
    && !!task.generator_version && !!task.seed && !!task.template_version;
  checks.push(ref(schemaOk, "schema_correctness", schemaOk ? "Task carries a category, difficulty, goal, checks, invariants and full lineage." : "Task is missing required structural fields."));

  // 2. Acceptance criteria completeness — machine-readable checks, not prose.
  const spec = template?.acceptance_criteria_spec || {};
  const list = task.acceptance_criteria?.checks || [];
  const malformed = list.filter((c) => !c.check_id || !CHECK_TYPES.includes(c.type) || !c.target || typeof c.assert !== "object" || c.assert === null);
  const missingTypes = (spec.required_check_types || []).filter((t) => !list.some((c) => c.type === t));
  const acceptOk = list.length >= (spec.min_checks ?? 3) && !malformed.length && !missingTypes.length
    && list.length >= (task.complexity?.acceptance_check_count ?? 0);
  checks.push(ref(acceptOk, "acceptance_criteria_completeness", acceptOk
    ? `${list.length} machine-readable check(s) of type(s) ${[...new Set(list.map((c) => c.type))].join(", ")}.`
    : `Acceptance criteria incomplete: ${malformed.length} malformed, missing types [${missingTypes.join(", ")}], ${list.length} check(s).`));

  // 3. Invariants are explicit and machine-checkable.
  const ispec = template?.invariants_spec || {};
  const badInv = (task.invariants || []).filter((i) => !i.invariant_id || !INVARIANT_TYPES.includes(i.type) || typeof i.assert !== "object" || i.assert === null);
  const missingInv = (ispec.required_invariant_types || []).filter((t) => !(task.invariants || []).some((i) => i.type === t));
  const invOk = (task.invariants || []).length >= (ispec.min_invariants ?? 0) && !badInv.length && !missingInv.length;
  checks.push(ref(invOk, "invariants_machine_readable", invOk
    ? `${(task.invariants || []).length} invariant(s): ${(task.invariants || []).map((i) => i.type).join(", ") || "none required"}.`
    : `Invariants invalid: ${badInv.length} malformed, missing types [${missingInv.join(", ")}].`));

  // 4. Fixture integrity.
  const files = task.initial_state?.files || [];
  const badFiles = files.filter((f) => !f?.path || typeof f.content !== "string" || f.content.length > BENCHMARK_LIMITS.fixture_file_chars);
  const fixtureOk = files.length > 0 && files.length <= BENCHMARK_LIMITS.fixture_files && !badFiles.length
    && task.fixture?.synthetic === true && task.initial_state_fingerprint === initialStateFingerprint(task.initial_state);
  checks.push(ref(fixtureOk, "fixture_integrity", fixtureOk
    ? `${files.length} synthetic fixture file(s), ${(task.initial_state?.entities || []).length} seed entity declaration(s), fingerprint matches.`
    : `Fixture invalid: ${files.length} file(s), ${badFiles.length} malformed, synthetic=${task.fixture?.synthetic}.`));

  // 5. Deterministic fingerprint — the task is RE-GENERATED and must reproduce exactly.
  let fpOk = false, fpDetail = "Template version is unavailable, so determinism cannot be re-checked.";
  if (template) {
    try {
      const { fingerprint: recomputed } = generateSanitized({ ...template, version: task.template_version }, task.seed, task.parameters || {});
      fpOk = recomputed === task.fingerprint;
      fpDetail = fpOk ? `Re-generation reproduced fingerprint ${recomputed}.` : `Re-generation produced ${recomputed}, stored ${task.fingerprint}.`;
    } catch (e) { fpDetail = `Re-generation failed: ${scrubText(e.message, 200)}`; }
  }
  checks.push(ref(fpOk, "deterministic_fingerprint", fpDetail));

  // 6. No unresolved references.
  const unresolved = unresolvedReferences(task);
  checks.push(ref(!unresolved.length, "no_unresolved_references", unresolved.length ? `Unresolved: ${unresolved.slice(0, 5).join("; ")}` : "Every check and invariant target resolves to a fixture artifact or a declared target."));

  // 7. No secret values anywhere in the stored task.
  const serialized = JSON.stringify({ d: task.definition, s: task.initial_state, a: task.acceptance_criteria, i: task.invariants, p: task.parameters, f: task.fixture });
  const secretHit = SECRET_SCAN.exec(serialized);
  checks.push(ref(!secretHit, "no_secret_values", secretHit ? "A credential-shaped value survived into the task content." : "No API key, token, password or credential shape present."));

  // 8. No private project data: nothing generated may reproduce an artifact of the owner project.
  const [ownerFiles, ownerEntities] = await Promise.all([
    svc.entities.ProjectFile.filter({ project_id: project.id }, "path", 200).catch(() => []),
    svc.entities.AppEntity.filter({ project_id: project.id }, "name", 100).catch(() => []),
  ]);
  const ownerContents = new Set(ownerFiles.map((f) => String(f.content || "").trim()).filter((c) => c.length > 40));
  const ownerNames = new Set(ownerEntities.map((e) => e.name));
  const leaked = [
    ...files.filter((f) => ownerContents.has(String(f.content || "").trim())).map((f) => `file ${f.path}`),
    ...(task.initial_state?.entities || []).filter((e) => ownerNames.has(e.name)).map((e) => `entity ${e.name}`),
  ];
  checks.push(ref(!leaked.length, "no_private_project_data", leaked.length ? `Owner-project artifact(s) present: ${leaked.slice(0, 4).join("; ")}` : "Fixture content is synthetic; no owner-project file or entity is reproduced."));

  // 9. Executable in an isolated scratch project.
  const probe = await probeIsolatedExecutability(svc, task);
  checks.push(ref(probe.ok, "isolated_executability", probe.detail));

  const passed = checks.every((c) => c.ok);
  const validation = {
    generator_version: GENERATOR_VERSION, validated_at: nowIso(), passed,
    failed_checks: checks.filter((c) => !c.ok).map((c) => c.name), checks,
  };
  const updated = await svc.entities.SyntheticTask.update(task.id, {
    status: passed ? "VALID" : "INVALID", validation: scrub(validation), validated_at: validation.validated_at,
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: passed ? "synthetic.task.validated" : "synthetic.task.invalid", resource: "SyntheticTask", resource_id: task.id,
    metadata: { fingerprint: task.fingerprint, failed_checks: validation.failed_checks },
  });
  return { task: publicSyntheticTask(updated), validation, passed };
}

/**
 * Finalizes a VALID task. Validation is RE-RUN first, so a stale pass cannot be reused, and a task
 * whose fingerprint already belongs to a finalized task is recorded as a DUPLICATE and refused
 * instead of quietly entering a benchmark twice.
 */
export async function finalizeTask(base44, user, { task_id } = {}) {
  const { task, project, workspace } = await authorizeTask(base44, user, task_id, "project.write");
  if (task.finalized) return { task: publicSyntheticTask(task), already_finalized: true };
  const svc = svcOf(base44);

  const { task: revalidated, passed } = await validateTask(base44, user, { task_id: task.id });
  if (!passed) fail(409, "TASK_INVALID", `An invalid task cannot be finalized (failed: ${revalidated.validation?.failed_checks?.join(", ")})`);

  const sameFingerprint = (await svc.entities.SyntheticTask.filter({ project_id: project.id, fingerprint: task.fingerprint }, "created_date", 20).catch(() => []))
    .filter((t) => t.id !== task.id && t.finalized);
  if (sameFingerprint.length) {
    const updated = await svc.entities.SyntheticTask.update(task.id, { status: "DUPLICATE", duplicate_of_task_id: sameFingerprint[0].id });
    await audit(svc, {
      workspace_id: workspace.id, project_id: project.id, user_id: user.id,
      action: "synthetic.task.duplicate", resource: "SyntheticTask", resource_id: task.id,
      metadata: { fingerprint: task.fingerprint, duplicate_of: sameFingerprint[0].id },
    });
    const err = Object.assign(new Error("A finalized task with an identical fingerprint already exists"), { status: 409, code: "DUPLICATE_TASK" });
    err.duplicate_of_task_id = sameFingerprint[0].id;
    err.task = publicSyntheticTask(updated);
    throw err;
  }

  const finalizedTask = await svc.entities.SyntheticTask.update(task.id, { status: "FINALIZED", finalized: true, finalized_at: nowIso() });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "synthetic.task.finalized", resource: "SyntheticTask", resource_id: task.id,
    metadata: { fingerprint: task.fingerprint, category: task.category, difficulty: task.difficulty },
  });
  return { task: publicSyntheticTask(finalizedTask) };
}

export async function getTask(base44, user, { task_id } = {}) {
  const { task } = await authorizeTask(base44, user, task_id, "project.read");
  return { task: publicSyntheticTask(task) };
}

export async function listTaskVersions(base44, user, { project_id, task_key = null, template_key = null } = {}) {
  const { project } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.SyntheticTask.filter(
    { project_id: project.id, ...(task_key ? { task_key: String(task_key) } : {}), ...(template_key ? { template_key: String(template_key) } : {}) },
    "task_version", SYNTH_LIMITS.list);
  return { project_id: project.id, count: rows.length, tasks: rows.map(publicSyntheticTask) };
}

// --- task sets ------------------------------------------------------------------

const membersOf = (tasks) => tasks.map((t) => ({
  task_id: t.id, task_key: t.task_key, task_version: t.task_version || 1,
  fingerprint: t.fingerprint, category: t.category, difficulty: t.difficulty,
}));
const membershipFingerprint = (members) => fingerprint("stset", members.map((m) => m.fingerprint));
const taskSetChecksum = (members) => fingerprint("stsetchk", { generator_version: GENERATOR_VERSION, members });

/**
 * Creates a task set, or the NEXT version of an existing set name. Only FINALIZED tasks are
 * admitted, so a set can never contain an unvalidated task. Changing membership means calling this
 * again: the result is a new version chained to the previous finalized one, never an edit.
 */
export async function createTaskSet(base44, user, { project_id, name, description = null, task_ids = [], trace_id = null } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to create a task set");
  const label = String(name || "").trim().slice(0, SYNTH_LIMITS.name);
  if (!label) fail(400, "INVALID_INPUT", "A task set name is required");
  const ids = [...new Set((task_ids || []).map(String))];
  if (!ids.length) fail(400, "INVALID_INPUT", "A task set needs at least one finalized task");
  if (ids.length > SYNTH_LIMITS.tasks_per_set) fail(400, "TOO_MANY_TASKS", `A task set may hold at most ${SYNTH_LIMITS.tasks_per_set} tasks`);

  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.write");
  const svc = svcOf(base44);
  const tasks = [];
  for (const id of ids) {
    const t = await svc.entities.SyntheticTask.get(id).catch(() => null);
    if (!t) fail(404, "TASK_NOT_FOUND", `Synthetic task ${id} not found`);
    if (t.project_id !== project.id || t.workspace_id !== workspace.id) fail(403, "NOT_A_MEMBER", "A task from another project cannot join this task set");
    if (!t.finalized || t.status !== "FINALIZED") fail(409, "TASK_NOT_FINALIZED", `Task ${t.task_key} is ${t.status}; only finalized tasks may join a task set`);
    tasks.push(t);
  }
  tasks.sort((a, b) => String(a.task_key).localeCompare(String(b.task_key)));
  const members = membersOf(tasks);

  const siblings = (await svc.entities.SyntheticTaskSet.filter({ name: label }, "-version", SYNTH_LIMITS.versions).catch(() => []))
    .filter((s) => s.workspace_id === workspace.id);
  const version = Math.max(0, ...siblings.map((s) => s.version || 0)) + 1;
  const parent = siblings.filter((s) => s.finalized).sort((a, b) => (b.version || 0) - (a.version || 0))[0] || null;

  const record = await svc.entities.SyntheticTaskSet.create({
    name: label, description: description ? scrubText(description, SYNTH_LIMITS.description) : undefined,
    version, status: "DRAFT", generator_version: GENERATOR_VERSION,
    task_ids: members.map((m) => m.task_id), members,
    membership_fingerprint: membershipFingerprint(members), checksum: taskSetChecksum(members),
    item_count: members.length, parent_task_set_id: parent?.id || undefined,
    workspace_id: workspace.id, project_id: project.id, trace_id: trace_id || newTraceId(),
    finalized: false, created_by: user.id, created_at: nowIso(),
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "synthetic.task_set.created", resource: "SyntheticTaskSet", resource_id: record.id,
    metadata: { name: label, version, item_count: members.length, membership_fingerprint: record.membership_fingerprint },
  });
  return { task_set: publicTaskSet(record) };
}

async function authorizeTaskSet(base44, user, task_set_id, capability = "project.write") {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to use task sets");
  if (!task_set_id) fail(400, "INVALID_INPUT", "task_set_id is required");
  const svc = svcOf(base44);
  const set = await svc.entities.SyntheticTaskSet.get(String(task_set_id)).catch(() => null);
  if (!set) fail(404, "TASK_SET_NOT_FOUND", "Task set not found");
  const { project, workspace } = await loadAuthorizedProject(base44, user, set.project_id, capability);
  if (set.workspace_id && set.workspace_id !== workspace.id) fail(403, "NOT_A_MEMBER", "Task set belongs to another workspace");
  return { set, project, workspace };
}

/** Membership may only change while the set is a DRAFT. A finalized set refuses — create a new version. */
export async function updateTaskSetMembership(base44, user, { task_set_id, task_ids = [] } = {}) {
  const { set, project, workspace } = await authorizeTaskSet(base44, user, task_set_id, "project.write");
  if (set.finalized || set.status === "FINALIZED") fail(409, "TASK_SET_FINALIZED", "A finalized task set is immutable; create a new task-set version instead");
  const svc = svcOf(base44);
  const tasks = [];
  for (const id of [...new Set((task_ids || []).map(String))]) {
    const t = await svc.entities.SyntheticTask.get(id).catch(() => null);
    if (!t) fail(404, "TASK_NOT_FOUND", `Synthetic task ${id} not found`);
    if (t.project_id !== project.id) fail(403, "NOT_A_MEMBER", "A task from another project cannot join this task set");
    if (!t.finalized) fail(409, "TASK_NOT_FINALIZED", `Task ${t.task_key} is not finalized`);
    tasks.push(t);
  }
  if (!tasks.length) fail(400, "INVALID_INPUT", "A task set needs at least one finalized task");
  tasks.sort((a, b) => String(a.task_key).localeCompare(String(b.task_key)));
  const members = membersOf(tasks);
  const updated = await svc.entities.SyntheticTaskSet.update(set.id, {
    task_ids: members.map((m) => m.task_id), members,
    membership_fingerprint: membershipFingerprint(members), checksum: taskSetChecksum(members), item_count: members.length,
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "synthetic.task_set.updated", resource: "SyntheticTaskSet", resource_id: set.id,
    metadata: { item_count: members.length, membership_fingerprint: updated.membership_fingerprint },
  });
  return { task_set: publicTaskSet(updated) };
}

/**
 * Finalizes a task set. Membership is re-read and the checksum RECOMPUTED, so a member that was
 * altered or un-finalized behind the set's back blocks finalization instead of shipping silently.
 */
export async function finalizeTaskSet(base44, user, { task_set_id } = {}) {
  const { set, project, workspace } = await authorizeTaskSet(base44, user, task_set_id, "project.write");
  if (set.finalized) return { task_set: publicTaskSet(set), already_finalized: true };
  const svc = svcOf(base44);
  const tasks = [];
  for (const id of set.task_ids || []) {
    const t = await svc.entities.SyntheticTask.get(id).catch(() => null);
    if (!t || !t.finalized || t.status !== "FINALIZED") fail(409, "MEMBER_NOT_FINALIZED", `Member ${id} is no longer a finalized task`);
    tasks.push(t);
  }
  tasks.sort((a, b) => String(a.task_key).localeCompare(String(b.task_key)));
  const members = membersOf(tasks);
  const checksum = taskSetChecksum(members);
  if (set.checksum && set.checksum !== checksum) fail(409, "CHECKSUM_MISMATCH", "The recomputed task-set checksum does not match; membership changed after creation");
  const updated = await svc.entities.SyntheticTaskSet.update(set.id, {
    status: "FINALIZED", finalized: true, finalized_at: nowIso(), members, checksum,
    membership_fingerprint: membershipFingerprint(members), item_count: members.length,
  });
  await audit(svc, {
    workspace_id: workspace.id, project_id: project.id, user_id: user.id,
    action: "synthetic.task_set.finalized", resource: "SyntheticTaskSet", resource_id: set.id,
    metadata: { name: set.name, version: set.version, checksum, item_count: members.length },
  });
  return { task_set: publicTaskSet(updated), checksum };
}

export async function getTaskSet(base44, user, { task_set_id } = {}) {
  const { set } = await authorizeTaskSet(base44, user, task_set_id, "project.read");
  return { task_set: publicTaskSet(set) };
}

export async function listTaskSets(base44, user, { project_id, name = null } = {}) {
  const { project, workspace } = await loadAuthorizedProject(base44, user, project_id, "project.read");
  const rows = await svcOf(base44).entities.SyntheticTaskSet.filter(
    { workspace_id: workspace.id, project_id: project.id, ...(name ? { name: String(name) } : {}) }, "version", SYNTH_LIMITS.list);
  return { project_id: project.id, count: rows.length, task_sets: rows.map(publicTaskSet) };
}

// --- benchmark export -----------------------------------------------------------

/** The #23 BenchmarkTask payload of one generated task. No second benchmark schema is introduced. */
export const benchmarkTaskPayload = (task) => ({
  task_key: task.task_key, goal: task.definition?.goal, success_criteria: task.definition?.success_criteria,
  initial_state: task.initial_state, required_capabilities: task.required_capabilities || [],
  verification_criteria: task.verification_criteria || {}, category: task.category, difficulty: task.difficulty,
  time_budget_ms: task.complexity?.time_budget_ms ?? null, max_steps: task.complexity?.max_steps ?? null,
});

/**
 * Exports finalized generated tasks into an existing DRAFT benchmark through #23's OWN
 * addBenchmarkTask path — which re-authorizes the caller, versions the task and computes the
 * benchmark's fingerprints exactly as an operator-defined fixture would.
 */
export async function exportTasksToBenchmark(base44, user, { benchmark_id, task_set_id = null, task_ids = null } = {}) {
  if (!user?.id) fail(401, "AUTH_REQUIRED", "Sign in to export tasks");
  const svc = svcOf(base44);
  let tasks = [];
  if (task_set_id) {
    const { set } = await authorizeTaskSet(base44, user, task_set_id, "project.read");
    for (const id of set.task_ids || []) {
      const t = await svc.entities.SyntheticTask.get(id).catch(() => null);
      if (t) tasks.push(t);
    }
  } else {
    for (const id of task_ids || []) {
      const { task } = await authorizeTask(base44, user, id, "project.read");
      tasks.push(task);
    }
  }
  if (!tasks.length) fail(400, "INVALID_INPUT", "Nothing to export");
  const notFinal = tasks.filter((t) => !t.finalized || t.status !== "FINALIZED");
  if (notFinal.length) fail(409, "TASK_NOT_FINALIZED", `${notFinal.length} task(s) are not finalized; only finalized tasks may enter a benchmark task set`);

  const exported = [];
  for (const t of tasks) {
    const { task: benchTask } = await addBenchmarkTask(base44, user, { benchmark_id, ...benchmarkTaskPayload(t) });
    exported.push({ synthetic_task_id: t.id, ...benchTask });
    await svc.entities.SyntheticTask.update(t.id, {
      benchmark_task_refs: [...(t.benchmark_task_refs || []), { benchmark_id: String(benchmark_id), benchmark_task_id: benchTask.task_id, task_version: benchTask.task_version, checksum: benchTask.checksum }],
    }).catch(() => {});
  }
  return { benchmark_id: String(benchmark_id), exported_count: exported.length, tasks: exported };
}