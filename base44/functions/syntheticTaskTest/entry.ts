// E2E certification for the NexusAI Synthetic Task Generator (#24).
//
// Runs against the REAL modules and the REAL data layer: real templates, real deterministic
// generation, real validation (including an isolated scratch-project probe) and a real export into
// the EXISTING #23 BenchmarkTask contract. Nothing is stubbed.
//
// GENERATION AND VALIDATION ONLY — no generated task is executed against a model here, by design.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, purgeBy, cleanupWorkspace } from "../../shared/testHarness.ts";
import {
  createTemplate, finalizeTemplate, listTemplateVersions, generateTask, validateTask, finalizeTask,
  getTask, listTaskVersions, createTaskSet, updateTaskSetMembership, finalizeTaskSet, getTaskSet,
  listTaskSets, exportTasksToBenchmark, benchmarkTaskPayload,
} from "../../shared/syntheticTasks.ts";
import {
  GENERATOR_VERSION, TASK_CATEGORIES, CHECK_TYPES, INVARIANT_TYPES, DIFFICULTY_KNOBS,
  generateTaskContent, taskFingerprint,
} from "../../shared/syntheticTemplates.ts";
import { createBenchmark, getBenchmark } from "../../shared/benchmark.ts";
import { createControlEpisode, nowIso } from "../../shared/testFixtures.ts";

const SECRET = "sk_live_SYNTHETICLEAK1234567890";
const PRIVATE_FILE = "// PRIVATE owner project source. Confidential business logic that must never appear in a synthetic fixture.\nexport const ownerMargin = 0.42;\n";

export default async function (req) {
  const h = createHarness();
  const base44 = createClientFromRequest(req);
  const svc = base44.asServiceRole || base44;
  const created = { workspaces: [], projects: [], benchmarks: [] };

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // ---------------------------------------------------------------- fixtures
    const ws = await svc.entities.Workspace.create({ name: `synth-cert-${Date.now()}`, owner_id: user.id, status: "active" });
    created.workspaces.push(ws.id);
    const owner = await svc.entities.Project.create({ workspace_id: ws.id, name: "synth-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(owner.id);
    await svc.entities.ProjectFile.create({ project_id: owner.id, path: "src/private/margin.js", content: PRIVATE_FILE, frozen: false });
    await svc.entities.AppEntity.create({ project_id: owner.id, name: "PrivateLedger", fields: { margin: { type: "number" } } });

    // A workspace this caller is NOT a member of.
    const wsForeign = await svc.entities.Workspace.create({ name: `synth-foreign-${Date.now()}`, owner_id: `u_not_${user.id}`, status: "active" });
    created.workspaces.push(wsForeign.id);
    const foreignProject = await svc.entities.Project.create({ workspace_id: wsForeign.id, name: "foreign-owner", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(foreignProject.id);

    // CONTROL records from the closed layers, which #24 must leave byte-identical.
    const control = await svc.entities.Project.create({ workspace_id: ws.id, name: "control-project", framework: "preact-htm", status: "draft", version_count: 1 });
    created.projects.push(control.id);
    const ctl = await createControlEpisode(svc, { user, project: control, workspace: ws, duration_ms: 900 });
    const controlRun = ctl.run, controlTraj = ctl.trajectory, controlSealed = ctl.trajectory;
    const controlEval = ctl.evaluation, controlReward = ctl.reward;
    const controlMemory = await svc.entities.MemoryItem.create({
      scope: "project", memory_type: "decision", statement: "Control memory: the primary store is the platform entity layer.",
      source_type: "project_state", logical_key: `synthctl_${Date.now()}`, project_id: control.id, workspace_id: ws.id,
      confidence: 0.9, verification: "verified", status: "active",
    });

    // A pre-existing benchmark + task the generator must not touch.
    const controlBench = (await createBenchmark(base44, user, { project_id: control.id, name: "control-benchmark", scope: "project" })).benchmark;
    created.benchmarks.push(controlBench.benchmark_id);
    const snap = (o) => JSON.stringify(o);
    const before = {
      bench: snap(await svc.entities.Benchmark.get(controlBench.benchmark_id)),
      benchTasks: (await svc.entities.BenchmarkTask.filter({ benchmark_id: controlBench.benchmark_id }, "task_version", 20)).length,
      datasets: (await svc.entities.Dataset.filter({}, "-created_date", 200).catch(() => [])).length,
      dataset_items: (await svc.entities.DatasetItem.filter({}, "-created_date", 200).catch(() => [])).length,
      traj: snap({ status: controlSealed.status, revision: controlSealed.revision, sealed: controlSealed.sealed, event_count: controlSealed.event_count, outcomes: controlSealed.outcomes }),
      evaluation: snap({ id: controlEval.id, revision: controlEval.revision, inputs_hash: controlEval.inputs_hash, scores: controlEval.scores }),
      reward: snap({ id: controlReward.id, status: controlReward.status, final_reward: controlReward.final_reward, revision: controlReward.revision }),
      memory: snap({ id: controlMemory.id, status: controlMemory.status, statement: controlMemory.statement, revision: controlMemory.revision, confidence: controlMemory.confidence }),
      run: snap({ status: controlRun.status, phase: controlRun.phase ?? null, prompt: controlRun.prompt }),
      ownerFiles: (await svc.entities.ProjectFile.filter({ project_id: owner.id }, "path", 50)).length,
    };

    // ------------------------------------------------------------ 1/2/16 templates
    const t1 = (await createTemplate(base44, user, {
      project_id: owner.id, template_key: "crud-core", category: "crud_data_modeling", difficulty: "medium",
      description: "Model synthetic entities and expose CRUD.",
      acceptance_criteria_spec: { min_checks: 4, required_check_types: ["entity_schema", "file_exists", "build_succeeds"] },
      invariants_spec: { min_invariants: 1, required_invariant_types: ["no_duplicate_records"] },
      fixture_requirements: { require_seed_entities: false },
      expected_outcome_type: "feature_implemented",
    })).template;
    h.check("1 template can be created",
      !!t1.template_id && t1.version === 1 && t1.category === "crud_data_modeling" && t1.generator_version === GENERATOR_VERSION &&
      !!t1.checksum && t1.workspace_id === ws.id && t1.acceptance_criteria_spec.machine_readable_required === true,
      `crud-core v1 · checksum ${t1.checksum}`);
    await h.expectThrow("1b unknown category is refused", () => createTemplate(base44, user, { project_id: owner.id, template_key: "bogus", category: "telepathy" }), "UNKNOWN_CATEGORY");

    await finalizeTemplate(base44, user, { template_id: t1.template_id });
    const t2 = (await createTemplate(base44, user, {
      project_id: owner.id, template_key: "crud-core", category: "crud_data_modeling", difficulty: "hard",
      description: "Model synthetic entities and expose CRUD — revised knobs.",
      acceptance_criteria_spec: { min_checks: 5, required_check_types: ["entity_schema", "route_exists"] },
      invariants_spec: { min_invariants: 1 },
      expected_outcome_type: "feature_implemented",
    })).template;
    const t1After = (await listTemplateVersions(base44, user, { project_id: owner.id, template_key: "crud-core" })).templates;
    const t1Frozen = t1After.find((t) => t.version === 1);
    h.check("2 template versioning works", t2.version === 2 && t1After.length === 2 && t1Frozen.checksum === t1.checksum && t1Frozen.finalized === true,
      `versions ${t1After.map((t) => t.version).join(",")} · v1 frozen with its original checksum`);
    h.check("16 template changes create new versions", t2.checksum !== t1.checksum && t2.template_key === t1.template_key && t2.template_id !== t1.template_id && t2.finalized === false,
      `a changed definition produced v2 (${t2.checksum}) beside the immutable v1`);

    // -------------------------------------------------------- 3/4/5/6/25 generation
    const trace = `tr_synthgen_${Date.now()}`;
    const gen1 = await generateTask(base44, user, { project_id: owner.id, template_id: t2.template_id, seed: "seed-alpha", trace_id: trace });
    const taskA = gen1.task;
    h.check("3 deterministic generation works",
      gen1.created === true && !!taskA.fingerprint && !!taskA.definition.goal && taskA.category === "crud_data_modeling" &&
      taskA.difficulty === "hard" && taskA.status === "DRAFT" && (taskA.initial_state.files || []).length > 0,
      `task ${taskA.task_key} · fingerprint ${taskA.fingerprint}`);

    const gen1b = await generateTask(base44, user, { project_id: owner.id, template_id: t2.template_id, seed: "seed-alpha" });
    const templateRow = await svc.entities.TaskTemplate.get(t2.template_id);
    const pure1 = generateTaskContent({ template: templateRow, seed: "seed-alpha", parameters: {} });
    const pure2 = generateTaskContent({ template: templateRow, seed: "seed-alpha", parameters: {} });
    h.check("4 same seed produces identical task",
      gen1b.created === false && gen1b.task.task_id === taskA.task_id && gen1b.task.fingerprint === taskA.fingerprint &&
      JSON.stringify(pure1) === JSON.stringify(pure2),
      "re-generation resolved the existing task; two independent generations are byte-identical");
    h.check("5 generation fingerprint is stable",
      taskFingerprint({ template: templateRow, seed: "seed-alpha", content: pure1 }) === taskFingerprint({ template: templateRow, seed: "seed-alpha", content: pure2 }),
      `stable across independent runs (${taskFingerprint({ template: templateRow, seed: "seed-alpha", content: pure1 })})`);

    const gen2 = await generateTask(base44, user, { project_id: owner.id, template_id: t2.template_id, seed: "seed-beta" });
    const taskB = gen2.task;
    h.check("6 different seed produces a distinct task",
      gen2.created === true && taskB.fingerprint !== taskA.fingerprint && taskB.task_key !== taskA.task_key &&
      taskB.definition.goal !== taskA.definition.goal,
      `seed-beta produced a different task (${taskB.fingerprint})`);

    // ------------------------------------------------------------ 7 difficulty
    const diffTasks = {};
    for (const level of ["easy", "expert"]) {
      diffTasks[level] = (await generateTask(base44, user, { project_id: owner.id, template_id: t2.template_id, seed: "seed-diff", parameters: { difficulty: level } })).task;
    }
    const easy = diffTasks.easy.complexity, expert = diffTasks.expert.complexity;
    const repeatEasy = generateTaskContent({ template: templateRow, seed: "seed-diff", parameters: { difficulty: "easy" } });
    h.check("7 difficulty levels alter deterministic complexity",
      easy.entity_count < expert.entity_count && easy.operation_count < expert.operation_count &&
      easy.dependency_depth < expert.dependency_depth && easy.constraint_count < expert.constraint_count &&
      easy.acceptance_check_count < expert.acceptance_check_count &&
      easy.entity_count === DIFFICULTY_KNOBS.easy.entities && expert.max_steps === DIFFICULTY_KNOBS.expert.max_steps &&
      JSON.stringify(repeatEasy.complexity) === JSON.stringify(easy),
      `easy(${easy.entity_count}e/${easy.acceptance_check_count}checks) → expert(${expert.entity_count}e/${expert.acceptance_check_count}checks), recorded and reproducible`);

    // ------------------------------------------------------ 8 every category
    const perCategory = [];
    for (const category of TASK_CATEGORIES) {
      const tpl = (await createTemplate(base44, user, { project_id: owner.id, template_key: `cat-${category}`, category, difficulty: "medium" })).template;
      const task = (await generateTask(base44, user, { project_id: owner.id, template_id: tpl.template_id, seed: `seed-${category}` })).task;
      const { validation } = await validateTask(base44, user, { task_id: task.task_id });
      perCategory.push({ category, ok: validation.passed, failed: validation.failed_checks, checks: task.acceptance_criteria.check_count, invariants: task.invariants.length });
    }
    h.check("8 all required task categories can generate valid tasks",
      perCategory.length === 9 && perCategory.every((c) => c.ok && c.checks >= 4 && c.invariants >= 1),
      perCategory.map((c) => `${c.category}:${c.ok ? "VALID" : `INVALID(${c.failed.join("|")})`}`).join(", "));

    // --------------------------------------------------- 9/10/11/25 validation
    const validated = await validateTask(base44, user, { task_id: taskA.task_id });
    const taskAValid = validated.task;
    const checks = taskAValid.acceptance_criteria.checks;
    h.check("9 machine-readable acceptance criteria are present",
      checks.length >= 5 && checks.every((c) => c.check_id && CHECK_TYPES.includes(c.type) && c.target && typeof c.assert === "object" && c.assert !== null) &&
      checks.some((c) => c.type === "entity_schema") && checks.some((c) => c.type === "build_succeeds") &&
      taskAValid.verification_criteria.expect_entities.length > 0,
      `${checks.length} checks of types ${taskAValid.acceptance_criteria.check_types.join(", ")}`);
    h.check("10 invariants are machine-readable",
      taskAValid.invariants.length >= 1 && taskAValid.invariants.every((i) => i.invariant_id && INVARIANT_TYPES.includes(i.type) && typeof i.assert === "object" && i.assert !== null) &&
      taskAValid.invariants.some((i) => i.type === "no_duplicate_records"),
      taskAValid.invariants.map((i) => `${i.invariant_id}:${JSON.stringify(i.assert).slice(0, 40)}`).join(" · "));

    const probeLeftovers = (await svc.entities.Project.filter({ workspace_id: ws.id }, "created_date", 100)).filter((p) => String(p.name).startsWith("synthtask-probe"));
    const ownerFilesAfter = await svc.entities.ProjectFile.filter({ project_id: owner.id }, "path", 50);
    h.check("11 fixtures are isolated",
      validated.validation.checks.find((c) => c.name === "isolated_executability").ok === true &&
      validated.validation.checks.find((c) => c.name === "no_private_project_data").ok === true &&
      probeLeftovers.length === 0 && ownerFilesAfter.length === before.ownerFiles &&
      taskAValid.fixture.synthetic === true,
      "fixture materialized in a throwaway project that was destroyed; owner project untouched");
    h.check("25 generated tasks are reproducible",
      validated.validation.checks.find((c) => c.name === "deterministic_fingerprint").ok === true &&
      perCategory.every((c) => c.ok) && taskAValid.status === "VALID",
      "re-generation reproduced the stored fingerprint for every validated task");

    // ------------------------------------------------- 13/14/21 rejection paths
    const cloneOf = (task, patch) => svc.entities.SyntheticTask.create({
      ...Object.fromEntries(Object.entries(task).filter(([k]) => !["id", "created_date", "updated_date", "created_by_id"].includes(k))),
      status: "DRAFT", finalized: false, finalized_at: undefined, validation: undefined, ...patch,
    });
    const rowA = await svc.entities.SyntheticTask.get(taskA.task_id);

    const strippedRow = await cloneOf(rowA, { task_key: `${rowA.task_key}_stripped`, acceptance_criteria: { version: GENERATOR_VERSION, check_count: 0, check_types: [], checks: [] } });
    const strippedRes = await validateTask(base44, user, { task_id: strippedRow.id });
    const invalidFinalize = await finalizeTask(base44, user, { task_id: strippedRow.id }).catch((e) => e);
    h.check("13 invalid task is rejected",
      strippedRes.passed === false && strippedRes.validation.failed_checks.includes("acceptance_criteria_completeness") &&
      strippedRes.task.status === "INVALID" && invalidFinalize.code === "TASK_INVALID",
      `INVALID (${strippedRes.validation.failed_checks.join(", ")}) and refused finalization`);

    const ghostRow = await cloneOf(rowA, {
      task_key: `${rowA.task_key}_ghost`,
      acceptance_criteria: { ...rowA.acceptance_criteria, checks: [...rowA.acceptance_criteria.checks, { check_id: "chk_99_file_exists", type: "file_exists", target: "src/pages/Ghost.js", assert: { path: "src/pages/Ghost.js" }, description: "dangling reference" }] },
    });
    const ghostRes = await validateTask(base44, user, { task_id: ghostRow.id });
    h.check("14 unresolved references are rejected",
      ghostRes.passed === false && ghostRes.validation.failed_checks.includes("no_unresolved_references") &&
      ghostRes.validation.checks.find((c) => c.name === "no_unresolved_references").detail.includes("Ghost.js"),
      ghostRes.validation.checks.find((c) => c.name === "no_unresolved_references").detail);

    const secretTask = (await generateTask(base44, user, { project_id: owner.id, template_id: t2.template_id, seed: "seed-secret", parameters: { constraints: [`must authenticate with ${SECRET}`] } })).task;
    const secretValidation = await validateTask(base44, user, { task_id: secretTask.task_id });
    const leakRow = await cloneOf(rowA, { task_key: `${rowA.task_key}_leak`, definition: { ...rowA.definition, goal: `${rowA.definition.goal} Use ${SECRET}.` } });
    const leakRes = await validateTask(base44, user, { task_id: leakRow.id });
    const privateRow = await cloneOf(rowA, {
      task_key: `${rowA.task_key}_private`,
      initial_state: { files: [...(rowA.initial_state.files || []), { path: "src/private/margin.js", content: PRIVATE_FILE }], entities: rowA.initial_state.entities || [] },
    });
    const privateRes = await validateTask(base44, user, { task_id: privateRow.id });
    h.check("21 no secrets/private data enter generated tasks",
      !JSON.stringify(secretTask).includes(SECRET) && JSON.stringify(secretTask.parameters).includes("[REDACTED]") &&
      secretValidation.validation.checks.find((c) => c.name === "no_secret_values").ok === true &&
      leakRes.validation.failed_checks.includes("no_secret_values") &&
      privateRes.validation.failed_checks.includes("no_private_project_data"),
      "credential redacted at generation; a task carrying a raw secret or an owner-project file is refused");

    // ------------------------------------------------------ 15/17 finalize + duplicate
    const finalA = (await finalizeTask(base44, user, { task_id: taskA.task_id })).task;
    await validateTask(base44, user, { task_id: taskB.task_id });
    const finalB = (await finalizeTask(base44, user, { task_id: taskB.task_id })).task;
    h.check("17 generated task preserves generator/template/seed lineage",
      finalA.generator_version === GENERATOR_VERSION && finalA.template_id === t2.template_id && finalA.template_key === "crud-core" &&
      finalA.template_version === 2 && finalA.seed === "seed-alpha" && !!finalA.parameters.difficulty && !!finalA.fingerprint,
      `template crud-core v${finalA.template_version} · seed ${finalA.seed} · generator ${finalA.generator_version} · ${finalA.fingerprint}`);

    const dupRow = await cloneOf(rowA, {});
    const dupErr = await finalizeTask(base44, user, { task_id: dupRow.id }).catch((e) => e);
    const dupAfter = await svc.entities.SyntheticTask.get(dupRow.id);
    h.check("15 duplicate finalized task detection works",
      dupErr.code === "DUPLICATE_TASK" && dupErr.duplicate_of_task_id === finalA.task_id &&
      dupAfter.status === "DUPLICATE" && dupAfter.finalized !== true,
      `an identical fingerprint was recorded as DUPLICATE of ${finalA.task_id} instead of finalized twice`);

    // --------------------------------------------------------- 18/19/20 task sets
    const set1 = (await createTaskSet(base44, user, { project_id: owner.id, name: "core-set", description: "Core synthetic tasks", task_ids: [finalA.task_id] })).task_set;
    const set1Final = (await finalizeTaskSet(base44, user, { task_set_id: set1.task_set_id })).task_set;
    h.check("18 task set creation works",
      set1.version === 1 && set1.item_count === 1 && !!set1.membership_fingerprint && set1Final.status === "FINALIZED" &&
      set1Final.finalized === true && set1Final.members[0].fingerprint === finalA.fingerprint,
      `core-set v1 FINALIZED with checksum ${set1Final.checksum}`);
    await h.expectThrow("19 finalized task set is immutable", () => updateTaskSetMembership(base44, user, { task_set_id: set1.task_set_id, task_ids: [finalA.task_id, finalB.task_id] }), "TASK_SET_FINALIZED");
    await h.expectThrow("19b an unfinalized task cannot join a set", () => createTaskSet(base44, user, { project_id: owner.id, name: "bad-set", task_ids: [strippedRow.id] }), "TASK_NOT_FINALIZED");

    const set2 = (await createTaskSet(base44, user, { project_id: owner.id, name: "core-set", task_ids: [finalA.task_id, finalB.task_id] })).task_set;
    const set2Final = (await finalizeTaskSet(base44, user, { task_set_id: set2.task_set_id })).task_set;
    const setList = (await listTaskSets(base44, user, { project_id: owner.id, name: "core-set" })).task_sets;
    h.check("20 changed membership creates new task-set version",
      set2.version === 2 && set2.item_count === 2 && set2.parent_task_set_id === set1.task_set_id &&
      set2.membership_fingerprint !== set1.membership_fingerprint && setList.length === 2 &&
      (await getTaskSet(base44, user, { task_set_id: set1.task_set_id })).task_set.item_count === 1,
      `v2 chained to v1; v1 still holds its original single member`);

    // ------------------------------------------------------ 12/26 benchmark export
    const bench = (await createBenchmark(base44, user, { project_id: owner.id, name: "synthetic-export-bench", scope: "project" })).benchmark;
    created.benchmarks.push(bench.benchmark_id);
    const exported = await exportTasksToBenchmark(base44, user, { benchmark_id: bench.benchmark_id, task_set_id: set2Final.task_set_id });
    const benchAfter = await getBenchmark(base44, user, { benchmark_id: bench.benchmark_id });
    const exportedTask = benchAfter.tasks.find((t) => t.task_key === finalA.task_key);
    const payload = benchmarkTaskPayload(await svc.entities.SyntheticTask.get(finalA.task_id));
    h.check("12 generated task conforms to BenchmarkTask schema",
      !!exportedTask && exportedTask.task_version === 1 && !!exportedTask.checksum && !!exportedTask.initial_state_fingerprint &&
      exportedTask.definition.goal === finalA.definition.goal && exportedTask.category === finalA.category &&
      exportedTask.difficulty === finalA.difficulty && exportedTask.verification_criteria.expect_entities.length > 0 &&
      ["task_key", "goal", "initial_state", "verification_criteria", "category", "difficulty", "max_steps", "time_budget_ms"].every((k) => k in payload),
      `exported through the existing #23 addBenchmarkTask path (checksum ${exportedTask.checksum})`);
    const refBack = await svc.entities.SyntheticTask.get(finalA.task_id);
    h.check("26 generated tasks can be exported to benchmark",
      exported.exported_count === 2 && benchAfter.tasks.length === 2 && benchAfter.benchmark.task_set_fingerprint &&
      (refBack.benchmark_task_refs || []).some((r) => r.benchmark_id === bench.benchmark_id && r.benchmark_task_id === exportedTask.task_id),
      `${exported.exported_count} task(s) exported; lineage recorded on both sides`);
    await h.expectThrow("26b an unfinalized task cannot be exported", () => exportTasksToBenchmark(base44, user, { benchmark_id: bench.benchmark_id, task_ids: [ghostRow.id] }), "TASK_NOT_FINALIZED");

    // ---------------------------------------------------------- 22/23 authorization
    await h.expectThrow("22 authorization is enforced", () => generateTask(base44, null, { project_id: owner.id, template_id: t2.template_id, seed: "x" }), "AUTH_REQUIRED");
    await h.expectThrow("22b unauthenticated template creation is rejected", () => createTemplate(base44, { id: null }, { project_id: owner.id, template_key: "anon", category: "ui_feature" }), "AUTH_REQUIRED");
    await h.expectThrow("22c unauthenticated validation is rejected", () => validateTask(base44, null, { task_id: taskA.task_id }), "AUTH_REQUIRED");

    const foreignTemplate = await svc.entities.TaskTemplate.create({
      template_key: "foreign-tpl", version: 1, category: "ui_feature", difficulty: "medium", generator_version: GENERATOR_VERSION,
      workspace_id: wsForeign.id, project_id: foreignProject.id, finalized: false, created_at: nowIso(),
    });
    const foreignTask = await svc.entities.SyntheticTask.create({
      task_key: "foreign-task", task_version: 1, template_id: foreignTemplate.id, template_key: "foreign-tpl", template_version: 1,
      generator_version: GENERATOR_VERSION, seed: "s", fingerprint: "stask_foreign", status: "DRAFT",
      workspace_id: wsForeign.id, project_id: foreignProject.id, created_at: nowIso(),
    });
    const foreignSet = await svc.entities.SyntheticTaskSet.create({
      name: "foreign-set", version: 1, status: "DRAFT", generator_version: GENERATOR_VERSION,
      workspace_id: wsForeign.id, project_id: foreignProject.id, created_at: nowIso(),
    });
    await h.expectThrow("23 cross-workspace access is rejected", () => generateTask(base44, user, { project_id: foreignProject.id, template_id: foreignTemplate.id, seed: "s" }), "NOT_A_MEMBER");
    await h.expectThrow("23b cross-workspace task read is rejected", () => getTask(base44, user, { task_id: foreignTask.id }), "NOT_A_MEMBER");
    await h.expectThrow("23c cross-workspace task set read is rejected", () => getTaskSet(base44, user, { task_set_id: foreignSet.id }), "NOT_A_MEMBER");
    await h.expectThrow("23d cross-workspace task listing is rejected", () => listTaskVersions(base44, user, { project_id: foreignProject.id }), "NOT_A_MEMBER");

    // ---------------------------------------------------------------- 24 trace
    const spans = await svc.entities.TraceEvent.filter({ trace_id: trace, project_id: owner.id }, "at", 20);
    const genSpan = spans.find((s) => s.name === "synthetic.task.generated");
    h.check("24 trace_id/generator_version are preserved",
      finalA.trace_id === trace && !!genSpan && genSpan.reference_id === finalA.task_id &&
      genSpan.metadata?.generator_version === GENERATOR_VERSION && genSpan.metadata?.template_key === "crud-core" &&
      genSpan.metadata?.fingerprint === finalA.fingerprint,
      `trace ${trace} carried onto the task and its span, with generator ${GENERATOR_VERSION}`);

    // ------------------------------------------------------- 27-31 no side effects
    const after = {
      bench: snap(await svc.entities.Benchmark.get(controlBench.benchmark_id)),
      benchTasks: (await svc.entities.BenchmarkTask.filter({ benchmark_id: controlBench.benchmark_id }, "task_version", 20)).length,
      datasets: (await svc.entities.Dataset.filter({}, "-created_date", 200).catch(() => [])).length,
      dataset_items: (await svc.entities.DatasetItem.filter({}, "-created_date", 200).catch(() => [])).length,
    };
    const trajAfter = await svc.entities.Trajectory.get(controlTraj.id);
    const evalAfter = await svc.entities.Evaluation.get(controlEval.id);
    const rewardAfter = await svc.entities.Reward.get(controlReward.id);
    const memAfter = await svc.entities.MemoryItem.get(controlMemory.id);
    const runAfter = await svc.entities.AIRun.get(controlRun.id);
    h.check("27 existing Benchmark records remain unchanged",
      after.bench === before.bench && after.benchTasks === before.benchTasks,
      "the control benchmark and its task set are byte-identical; only the export target gained tasks");
    h.check("28 existing Dataset records remain unchanged",
      after.datasets === before.datasets && after.dataset_items === before.dataset_items,
      `${after.datasets} dataset(s) / ${after.dataset_items} item(s) before and after`);
    h.check("29 existing Trajectory/Judge/Reward records remain unchanged",
      snap({ status: trajAfter.status, revision: trajAfter.revision, sealed: trajAfter.sealed, event_count: trajAfter.event_count, outcomes: trajAfter.outcomes }) === before.traj &&
      snap({ id: evalAfter.id, revision: evalAfter.revision, inputs_hash: evalAfter.inputs_hash, scores: evalAfter.scores }) === before.evaluation &&
      snap({ id: rewardAfter.id, status: rewardAfter.status, final_reward: rewardAfter.final_reward, revision: rewardAfter.revision }) === before.reward &&
      (await svc.entities.Evaluation.filter({ project_id: control.id }, "created_date", 20)).length === 1,
      "the control episode, its evaluation and its reward are untouched");
    h.check("30 existing Memory records remain unchanged",
      snap({ id: memAfter.id, status: memAfter.status, statement: memAfter.statement, revision: memAfter.revision, confidence: memAfter.confidence }) === before.memory,
      "no memory was written, superseded or re-scored by the generator");
    const builderRuns = await svc.entities.AIRun.filter({ project_id: owner.id }, "created_date", 20);
    const agentRuns = await svc.entities.AgentRun.filter({ project_id: owner.id }, "created_date", 20);
    h.check("31 existing AI Builder behavior remains unchanged",
      snap({ status: runAfter.status, phase: runAfter.phase ?? null, prompt: runAfter.prompt }) === before.run &&
      builderRuns.length === 0 && agentRuns.length === 0 && probeLeftovers.length === 0,
      "no AI run or agent run was created or altered — generation and validation only, no execution");

    // ------------------------------------------------------------- API surface
    const versions = await listTaskVersions(base44, user, { project_id: owner.id, template_key: "crud-core" });
    h.check("18b operator APIs expose templates, task versions and sets",
      versions.count >= 4 && versions.tasks.every((t) => !!t.fingerprint && !!t.generator_version) &&
      (await listTemplateVersions(base44, user, { project_id: owner.id })).count >= 11,
      `${versions.count} generated task version(s) listed for crud-core`);

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const pid of created.projects) {
      await purgeBy(svc, "SyntheticTask", { project_id: pid });
      await purgeBy(svc, "SyntheticTaskSet", { project_id: pid });
      await purgeBy(svc, "TaskTemplate", { project_id: pid });
    }
    for (const id of created.benchmarks) {
      await purgeBy(svc, "BenchmarkResult", { benchmark_id: id });
      await purgeBy(svc, "BenchmarkTask", { benchmark_id: id });
      await svc.entities.Benchmark.delete(id).catch(() => {});
    }
    for (const pid of created.projects) {
      for (const entity of ["TraceEvent", "TrajectoryEvent", "Trajectory", "Evaluation", "Reward", "MemoryItem", "AIRun", "AgentRun", "ProjectVersion", "ProjectFile", "AppEntity", "Build"]) {
        await purgeBy(svc, entity, { project_id: pid });
      }
      await svc.entities.Project.delete(pid).catch(() => {});
    }
    for (const wid of created.workspaces) {
      await cleanupWorkspace(svc, wid, ["SyntheticTask", "SyntheticTaskSet", "TaskTemplate", "BenchmarkTask", "Benchmark", "AuditLog", "Trajectory", "TrajectoryEvent", "Evaluation", "Reward", "MemoryItem", "Project"]);
    }
  }
}