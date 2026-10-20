// Executable certification for the NexusAI Dataset Builder (#22).
//
// Every check runs against the REAL dataset module, the REAL project authorization path and REAL
// Trajectory / Evaluation / Reward records. Nothing is stubbed, and the suite proves the
// authoritative learning layers are never written to.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError, cleanupWorkspace, purgeBy } from "../../shared/testHarness.ts";
import {
  createDataset, buildDataset, validateDataset, finalizeDataset,
  getDataset, listDatasets, exportDataset, getLineage, datasetPolicies,
  ELIGIBILITY_POLICIES, DATASET_FORMAT_VERSION,
} from "../../shared/dataset.ts";
import { createDatasetEpisode, buildDatasetToFinal } from "../../shared/datasetTestFixtures.ts";

const SECRET = "sk_live_dataset_must_never_leak_7b2c";
const TOKEN = "ghp_datasetcertdummytoken0000000000000";

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  let workspace = null, other = null, proj = null, otherProj = null;
  const stranger = { id: "ds_stranger_user", email: "stranger@example.com" };
  const created = { datasets: [], memory: [] };

  // One authentic episode: run → sealed trajectory → evaluation → active reward.
  // Built by the shared certification fixture module; the deliberate pollution below is what proves
  // the transform strips hidden reasoning and credentials.
  const episode = ({ project, prompt, status = "COMPLETED", scores, reward = null, user_outcome = "accepted", buildStatus = "success", runtimeOk = true }) =>
    createDatasetEpisode(svc, {
      project, prompt, status, scores, reward, user_outcome, buildStatus, runtimeOk,
      pollution: { chain_of_thought: "internal deliberation that must never ship", hidden_reasoning: "private scratchpad", api_key: SECRET },
      toolSummary: `wrote src/pages/Notes.js with token ${TOKEN}`,
    });

  const spec = (overrides = {}) => ({ name: "Cert SFT", dataset_type: "sft", scope: "project", project_id: proj.id, ...overrides });
  const buildToFinal = (payload) => buildDatasetToFinal(base44, caller, payload, created.datasets);

  let caller = null;
  try {
    caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated platform admin" }, { status: 401 });

    workspace = await svc.entities.Workspace.create({ name: "Dataset Cert", owner_id: caller.id, credits_balance: 100 });
    other = await svc.entities.Workspace.create({ name: "Dataset Cert (other)", owner_id: "ds_other_owner", credits_balance: 5 });
    proj = await svc.entities.Project.create({ workspace_id: workspace.id, name: "dataset-project", status: "ready", version_count: 3 });
    otherProj = await svc.entities.Project.create({ workspace_id: other.id, name: "foreign-project", status: "ready", version_count: 1 });

    const good = { task_completion: 0.9, build: 1, runtime: 1, regression: 0.9 };
    const weak = { task_completion: 0.3, build: 0.4, runtime: 0.3, regression: 0.3 };
    const taskA = `Add a notes page and store notes with the key ${SECRET}`;
    const e1 = await episode({ project: proj, prompt: taskA, scores: good, reward: 0.92 });
    const e2 = await episode({ project: proj, prompt: taskA, scores: { task_completion: 0.7, build: 1, runtime: 0.6, regression: 0.7 }, reward: 0.41 });
    const e3 = await episode({ project: proj, prompt: "Add a weather widget to the dashboard", scores: good, reward: 0.81 });
    const e4 = await episode({ project: proj, prompt: "Broken attempt", scores: weak, reward: 0.2 });          // below quality floor
    const e5 = await episode({ project: proj, prompt: "Failed attempt", status: "FAILED", scores: good, reward: 0.3, buildStatus: "failed", runtimeOk: false, user_outcome: null });
    const e6 = await episode({ project: proj, prompt: "Add a weather widget to the dashboard", scores: good, reward: 0.80 }); // margin 0.01 vs e3
    const foreign = await episode({ project: otherProj, prompt: "Foreign project episode", scores: good, reward: 0.95 });
    // Private memory that must never appear in any dataset item.
    created.memory.push((await svc.entities.MemoryItem.create({ scope: "project", memory_type: "fact", statement: "Private project memory that must never enter a dataset.", logical_key: "mk_ds_cert", project_id: proj.id, workspace_id: workspace.id, source_type: "project_state", source_reference: { kind: "entity_schema" }, confidence: 1, verification: "verified", status: "active", created_at: new Date().toISOString() })).id);

    const before = {
      trajectories: JSON.stringify(await svc.entities.Trajectory.filter({ project_id: proj.id }, "created_date", 50)),
      evaluations: JSON.stringify(await svc.entities.Evaluation.filter({ project_id: proj.id }, "created_date", 50)),
      rewards: JSON.stringify(await svc.entities.Reward.filter({ project_id: proj.id }, "created_date", 50)),
      memory: JSON.stringify(await svc.entities.MemoryItem.filter({ project_id: proj.id }, "created_date", 50)),
      runs: JSON.stringify(await svc.entities.AIRun.filter({ project_id: proj.id }, "created_date", 50)),
      project: JSON.stringify(await svc.entities.Project.get(proj.id)),
      events: (await svc.entities.TrajectoryEvent.filter({ project_id: proj.id }, "sequence", 50)).length,
    };

    // ---------- 1 · SFT ----------
    const sft = await buildToFinal(spec());
    const sftDs = (await getDataset(base44, caller, { dataset_id: sft.dataset_id })).dataset;
    const sftItems = (await exportDataset(base44, caller, { dataset_id: sft.dataset_id })).items;
    h.check("1 SFT dataset can be created",
      sftDs.dataset_type === "sft" && sftDs.status === "FINALIZED" && sftDs.item_count === 4 &&
      sftItems.length === 4 && sftItems.every((i) => i.payload.example_type === "sft"),
      `${sftDs.item_count} item(s) from ${sftDs.candidate_count} candidate(s), ${sftDs.excluded_count} excluded`);

    // ---------- 2 · preference ----------
    const pref = await buildToFinal({ name: "Cert Preference", dataset_type: "preference", scope: "project", project_id: proj.id });
    const prefDs = (await getDataset(base44, caller, { dataset_id: pref.dataset_id })).dataset;
    const prefItems = (await exportDataset(base44, caller, { dataset_id: pref.dataset_id })).items;
    h.check("2 preference dataset can be created",
      prefDs.status === "FINALIZED" && prefItems.length === 1 &&
      prefItems[0].payload.preferred.trajectory_id === e1.traj.id && prefItems[0].payload.rejected.trajectory_id === e2.traj.id &&
      prefItems[0].payload.comparison.margin > 0.5,
      `${prefItems.length} pair(s); margin ${prefItems[0]?.payload.comparison.margin}`);

    // ---------- 3 · evaluation ----------
    const evalDsRes = await buildToFinal({ name: "Cert Benchmark", dataset_type: "evaluation", scope: "project", project_id: proj.id });
    const evalDs = (await getDataset(base44, caller, { dataset_id: evalDsRes.dataset_id })).dataset;
    const evalItems = (await exportDataset(base44, caller, { dataset_id: evalDsRes.dataset_id })).items;
    h.check("3 evaluation dataset can be created",
      evalDs.status === "FINALIZED" && evalItems.length === 4 &&
      evalItems.every((i) => i.payload.example_type === "evaluation" && i.payload.criteria?.evaluator_version === "1.0.0" && !!i.payload.expected_outcome),
      `${evalItems.length} benchmark example(s)`);

    // ---------- 4 · policy versioning ----------
    h.check("4 eligibility policy is versioned",
      sftDs.eligibility_policy_version === "1.0.0" && !!sftDs.source_policy_version &&
      sftDs.eligibility.min_quality === ELIGIBILITY_POLICIES["1.0.0"].rules.min_quality &&
      Object.keys(ELIGIBILITY_POLICIES).length >= 2 && datasetPolicies().eligibility_policies.length >= 2 &&
      sftItems.every((i) => i.eligibility_policy_version === "1.0.0" && i.transformation_version === "1.0.0"),
      `policy ${sftDs.eligibility_policy_version} · composite ${sftDs.source_policy_version}`);

    // ---------- 5-7 · lineage ----------
    const item1 = sftItems.find((i) => i.trajectory_id === e1.traj.id);
    h.check("5 trajectory lineage preserved",
      item1 && item1.trajectory_id === e1.traj.id && item1.source_run_id === e1.run.id && item1.source_trace_id === e1.traj.trace_id &&
      item1.source_version_id === `v_${e1.run.id}` && item1.source_version_number === 3 && item1.lineage.trajectory_revision === 1,
      `trajectory ${item1?.trajectory_id} → version ${item1?.source_version_number}`);
    h.check("6 evaluation lineage preserved",
      item1.evaluation_id === e1.evaluation.id && item1.evaluator_version === "1.0.0" && item1.lineage.evaluation_id === e1.evaluation.id,
      `evaluation ${item1.evaluation_id} (evaluator ${item1.evaluator_version})`);
    h.check("7 reward lineage preserved",
      item1.reward_id === e1.reward.id && item1.reward_policy_version === "1.0.0" &&
      prefItems[0].reward_id === e1.reward.id && prefItems[0].lineage.rejected_reward_id === e2.reward.id,
      `reward ${item1.reward_id}; preference keeps both sides' rewards`);

    // ---------- 8-10 · transformation, no CoT, no secrets ----------
    h.check("8 task/context data correctly transformed",
      item1.payload.task.request.includes("Add a notes page") && item1.payload.task.mode === "default" &&
      item1.payload.context.file_count === 12 && item1.payload.context.context_hash === "ctx_cert" &&
      item1.payload.plan.step_count === 3 && item1.payload.plan.file_actions[0].path === "src/pages/Notes.js" &&
      item1.payload.actions.length === 2 && item1.payload.outcome.build_status === "success" && item1.payload.outcome.version_number === 3 &&
      item1.payload.format_version === DATASET_FORMAT_VERSION,
      "task, bounded context, structured plan/actions and authoritative outcome present");

    const serializedAll = JSON.stringify([...sftItems, ...prefItems, ...evalItems]);
    h.check("9 hidden chain-of-thought not included",
      !serializedAll.includes("internal deliberation") && !serializedAll.includes("private scratchpad") &&
      !/chain_of_thought|hidden_reasoning|scratchpad/i.test(serializedAll) &&
      item1.payload.plan.chain_of_thought === undefined,
      "allowlisted plan metadata only — no reasoning trace reached any item");
    h.check("10 secrets fully scrubbed",
      !serializedAll.includes(SECRET) && !serializedAll.includes(TOKEN) &&
      item1.payload.task.request.includes("[REDACTED]") &&
      sft.validation.checks.find((c) => c.name === "secret_scrubbing")?.ok === true,
      "credential values redacted in payloads and verified by the validator");
    h.check("10b private project memory never enters a dataset",
      !serializedAll.includes("Private project memory") && !/memory_items?|private_memory/i.test(serializedAll),
      "memory layer is not a dataset source");

    // ---------- 11-12 · isolation and platform scope ----------
    h.check("11 private project data cannot leak across workspace boundaries",
      !serializedAll.includes(foreign.traj.id) && !serializedAll.includes(otherProj.id) &&
      sftItems.every((i) => i.project_id === proj.id && i.workspace_id === workspace.id),
      "no foreign project id, trajectory or workspace present in any item");

    await h.expectThrow("12 global dataset requires platform authority",
      () => createDataset(base44, stranger, { name: "Cert Global", dataset_type: "sft", scope: "platform", approved_project_ids: [proj.id] }), "NOT_PLATFORM_ADMIN");
    const unapproved = await createDataset(base44, caller, { name: "Cert Global Unapproved", dataset_type: "sft", scope: "platform", approved_project_ids: [] });
    created.datasets.push(unapproved.dataset.dataset_id);
    const unapprovedBuild = await buildDataset(base44, caller, { dataset_id: unapproved.dataset.dataset_id });
    const unapprovedValidation = await validateDataset(base44, caller, { dataset_id: unapproved.dataset.dataset_id });
    const approvedGlobal = await createDataset(base44, caller, { name: "Cert Global Approved", dataset_type: "sft", scope: "platform", approved_project_ids: [proj.id] });
    created.datasets.push(approvedGlobal.dataset.dataset_id);
    const approvedBuild = await buildDataset(base44, caller, { dataset_id: approvedGlobal.dataset.dataset_id });
    h.check("12b platform dataset admits only approved projects",
      unapprovedBuild.item_count === 0 && unapprovedValidation.validation.ok === false &&
      approvedBuild.item_count === 4 && approvedGlobal.dataset.approved_project_ids.includes(proj.id) &&
      !(await exportDataset(base44, caller, { dataset_id: sft.dataset_id })).items.some((i) => i.project_id === otherProj.id),
      `unapproved → ${unapprovedBuild.item_count} items, approved → ${approvedBuild.item_count} items`);
    await h.expectThrow("12c unapproved platform dataset cannot be finalized",
      () => finalizeDataset(base44, caller, { dataset_id: unapproved.dataset.dataset_id }), "DATASET_NOT_VALIDATED");

    // ---------- 13 · duplicates ----------
    const dupHost = await createDataset(base44, caller, spec({ name: "Cert Duplicates" }));
    created.datasets.push(dupHost.dataset.dataset_id);
    await buildDataset(base44, caller, { dataset_id: dupHost.dataset.dataset_id });
    const dupSource = (await svc.entities.DatasetItem.filter({ dataset_id: dupHost.dataset.dataset_id }, "item_key", 5))[0];
    await svc.entities.DatasetItem.create({ ...dupSource, id: undefined, created_at: new Date().toISOString() });
    const dupValidation = await validateDataset(base44, caller, { dataset_id: dupHost.dataset.dataset_id });
    h.check("13 duplicate examples detected/handled",
      dupValidation.validation.ok === false && dupValidation.validation.failed.includes("duplicate_detection") &&
      dupValidation.dataset.status === "BUILT" && !dupValidation.dataset.finalized &&
      sftItems.length === new Set(sftItems.map((i) => i.item_key)).size,
      `duplicate blocked: ${dupValidation.validation.failed.join(", ")}`);
    await h.expectThrow("13b a dataset with duplicates cannot be finalized",
      () => finalizeDataset(base44, caller, { dataset_id: dupHost.dataset.dataset_id }), "DATASET_NOT_VALIDATED");

    // ---------- 14 · grounded preferences only ----------
    const prefExclusions = prefDs.exclusions.map((x) => x.reason);
    h.check("14 preference pairs require sufficient evidence",
      prefItems.length === 1 &&
      !prefItems.some((i) => [e3.traj.id, e6.traj.id].includes(i.trajectory_id)) &&
      prefExclusions.includes("margin_below_threshold") && prefExclusions.includes("tasks_not_comparable") &&
      prefItems[0].payload.comparison.basis.length >= 2,
      `close-reward and non-comparable pairs refused: ${[...new Set(prefExclusions)].join(", ")}`);

    // ---------- 15 · evaluation integrity ----------
    h.check("15 evaluation dataset preserves evaluation integrity",
      evalItems.every((i) => i.labels === null && i.payload.plan === undefined && i.payload.actions === undefined && i.reward_id === null &&
        !!i.payload.references.evaluation_id && Array.isArray(i.payload.criteria.dimensions) && i.payload.criteria.dimensions.length > 0 &&
        i.payload.criteria.thresholds.min_quality === 0.6 && i.payload.criteria.scores === undefined &&
        i.lineage.reward_id === null && i.payload.labels === undefined && i.payload.outcome === undefined),
      "benchmark items carry task, verified outcome and criteria — no plan, actions, reward or score labels");

    // ---------- 16-17, 20-21, 24 · determinism, checksum, idempotency ----------
    const rebuild = await createDataset(base44, caller, spec());
    created.datasets.push(rebuild.dataset.dataset_id);
    const rebuilt = await buildDataset(base44, caller, { dataset_id: rebuild.dataset.dataset_id });
    const rebuiltItems = (await svc.entities.DatasetItem.filter({ dataset_id: rebuild.dataset.dataset_id }, "item_key", 50));
    h.check("16 deterministic transformation works",
      rebuiltItems.map((r) => r.item_key).join("|") === sftItems.map((i) => i.item_key).join("|") &&
      rebuiltItems.every((r) => sftItems.find((i) => i.item_key === r.item_key).item_checksum === r.item_checksum),
      "same sources + same versions → identical item keys and per-item checksums");
    h.check("17 same source + same policy produces same dataset",
      rebuilt.dataset.checksum === sftDs.checksum && rebuilt.dataset.source_fingerprint === sftDs.source_fingerprint &&
      rebuilt.dataset.source_policy_version === sftDs.source_policy_version && rebuilt.dataset.version === sftDs.version + 1,
      `checksum ${rebuilt.dataset.checksum} reproduced at version ${rebuilt.dataset.version}`);
    h.check("20 checksum/hash recorded",
      !!sftDs.checksum && !!sftDs.source_fingerprint && sft.validation.checks.find((c) => c.name === "checksum")?.ok === true &&
      sftItems.every((i) => !!i.item_checksum),
      `dataset ${sftDs.checksum} · fingerprint ${sftDs.source_fingerprint}`);
    h.check("21 dataset item count correct",
      sftDs.item_count === sftItems.length && sftDs.item_count === (await svc.entities.DatasetItem.filter({ dataset_id: sft.dataset_id }, "item_key", 50)).length &&
      sftDs.candidate_count === 6 && sftDs.excluded_count === 2,
      `${sftDs.item_count} included / ${sftDs.excluded_count} excluded of ${sftDs.candidate_count} candidates`);

    await validateDataset(base44, caller, { dataset_id: rebuild.dataset.dataset_id });
    const dupFinal = await finalizeDataset(base44, caller, { dataset_id: rebuild.dataset.dataset_id });
    const activeFinal = (await svc.entities.Dataset.filter({ source_fingerprint: sftDs.source_fingerprint, status: "FINALIZED" }, "version", 10)).length;
    h.check("24 repeated generation is idempotent",
      dupFinal.finalized === false && dupFinal.dataset.status === "DUPLICATE" && dupFinal.duplicate_of.dataset_id === sft.dataset_id && activeFinal === 1,
      `second identical build marked DUPLICATE of ${dupFinal.duplicate_of?.dataset_id}; ${activeFinal} active finalized version`);

    // ---------- 18 · immutability ----------
    const itemsBefore = JSON.stringify(await svc.entities.DatasetItem.filter({ dataset_id: sft.dataset_id }, "item_key", 50));
    await h.expectThrow("18 finalized dataset is immutable (rebuild refused)",
      () => buildDataset(base44, caller, { dataset_id: sft.dataset_id }), "DATASET_FINALIZED");
    await h.expectThrow("18b finalized dataset cannot be re-validated",
      () => validateDataset(base44, caller, { dataset_id: sft.dataset_id }), "DATASET_FINALIZED");
    const refinalize = await finalizeDataset(base44, caller, { dataset_id: sft.dataset_id });
    h.check("18c finalized dataset and items unchanged",
      refinalize.already === true &&
      JSON.stringify(await svc.entities.DatasetItem.filter({ dataset_id: sft.dataset_id }, "item_key", 50)) === itemsBefore &&
      (await getDataset(base44, caller, { dataset_id: sft.dataset_id })).dataset.checksum === sftDs.checksum,
      "re-finalization is a no-op and the item rows are byte-identical");

    // ---------- 19 · changed policy → new version ----------
    const stricter = await buildToFinal(spec({ eligibility_policy_version: "1.1.0" }));
    const stricterDs = (await getDataset(base44, caller, { dataset_id: stricter.dataset_id })).dataset;
    h.check("19 changed policy creates new dataset version",
      stricterDs.status === "FINALIZED" && stricterDs.name === sftDs.name && stricterDs.version > sftDs.version &&
      stricterDs.eligibility_policy_version === "1.1.0" && stricterDs.source_policy_version !== sftDs.source_policy_version &&
      stricterDs.source_fingerprint !== sftDs.source_fingerprint && stricterDs.item_count !== sftDs.item_count &&
      stricterDs.parent_dataset_id === sft.dataset_id &&
      (await getDataset(base44, caller, { dataset_id: sft.dataset_id })).dataset.status === "FINALIZED",
      `v${sftDs.version} (${sftDs.item_count} items, policy 1.0.0) → v${stricterDs.version} (${stricterDs.item_count} items, policy 1.1.0); both retained`);

    // ---------- 22 · incomplete lineage blocks finalization ----------
    const tampered = await createDataset(base44, caller, spec({ name: "Cert Lineage" }));
    created.datasets.push(tampered.dataset.dataset_id);
    await buildDataset(base44, caller, { dataset_id: tampered.dataset.dataset_id });
    const okValidation = await validateDataset(base44, caller, { dataset_id: tampered.dataset.dataset_id });
    const victim = (await svc.entities.DatasetItem.filter({ dataset_id: tampered.dataset.dataset_id }, "item_key", 5))[0];
    await svc.entities.DatasetItem.update(victim.id, { evaluation_id: null });
    let lineageBlock = null;
    try { await finalizeDataset(base44, caller, { dataset_id: tampered.dataset.dataset_id }); } catch (e) { lineageBlock = e; }
    const tamperedAfter = await svc.entities.Dataset.get(tampered.dataset.dataset_id);
    h.check("22 incomplete lineage prevents finalization",
      okValidation.validation.ok === true && lineageBlock?.code === "VALIDATION_FAILED" &&
      tamperedAfter.status === "BUILT" && !tamperedAfter.finalized &&
      tamperedAfter.validation.failed.includes("provenance_completeness"),
      `finalization refused: ${lineageBlock?.message}`);

    // ---------- 23 · failed build cannot finalize ----------
    const failing = await createDataset(base44, caller, spec({ name: "Cert Failed Build" }));
    created.datasets.push(failing.dataset.dataset_id);
    await svc.entities.Dataset.update(failing.dataset.dataset_id, { transformation_version: "9.9.9" });
    let buildErr = null;
    try { await buildDataset(base44, caller, { dataset_id: failing.dataset.dataset_id }); } catch (e) { buildErr = e; }
    const failedDs = await svc.entities.Dataset.get(failing.dataset.dataset_id);
    let finalizeErr = null;
    try { await finalizeDataset(base44, caller, { dataset_id: failing.dataset.dataset_id }); } catch (e) { finalizeErr = e; }
    h.check("23 failed build cannot create finalized dataset",
      buildErr?.code === "UNKNOWN_TRANSFORM" && failedDs.status === "FAILED" && !failedDs.finalized &&
      !failedDs.checksum && finalizeErr?.code === "DATASET_NOT_VALIDATED" &&
      (await svc.entities.DatasetItem.filter({ dataset_id: failing.dataset.dataset_id }, "item_key", 5)).length === 0,
      `build FAILED (${buildErr?.code}); finalization refused (${finalizeErr?.code})`);

    // ---------- 25-26 · authorization ----------
    await h.expectThrow("25 dataset authorization enforced (create)",
      () => createDataset(base44, stranger, spec({ name: "Cert Unauthorized" })), "NOT_A_MEMBER");
    await h.expectThrow("25b dataset authorization enforced (read)",
      () => getDataset(base44, stranger, { dataset_id: sft.dataset_id }), "NOT_A_MEMBER");
    await h.expectThrow("25c dataset authorization enforced (export)",
      () => exportDataset(base44, stranger, { dataset_id: sft.dataset_id }), "NOT_A_MEMBER");
    await h.expectThrow("25d anonymous access rejected",
      () => getDataset(base44, null, { dataset_id: sft.dataset_id }), "AUTH_REQUIRED");
    await h.expectThrow("26 cross-project dataset access rejected",
      () => createDataset(base44, caller, { name: "Cert Foreign", dataset_type: "sft", scope: "project", project_id: otherProj.id }), "NOT_A_MEMBER");
    await h.expectThrow("26b cross-project platform approval rejected",
      () => createDataset(base44, caller, { name: "Cert Foreign Global", dataset_type: "sft", scope: "platform", approved_project_ids: [otherProj.id] }), "NOT_A_MEMBER");

    // ---------- 27-28 · retrieval, export, lineage inspection ----------
    const page = await exportDataset(base44, caller, { dataset_id: sft.dataset_id, limit: 2, offset: 0 });
    const page2 = await exportDataset(base44, caller, { dataset_id: sft.dataset_id, limit: 2, offset: 2 });
    const listed = await listDatasets(base44, caller, { project_id: proj.id, scope: "project" });
    h.check("27 finalized dataset retrieval works",
      page.items.length === 2 && page.has_more === true && page2.items.length === 2 && page2.has_more === false &&
      page.format_version === DATASET_FORMAT_VERSION && page.dataset.status === "FINALIZED" &&
      listed.datasets.some((d) => d.dataset_id === sft.dataset_id) &&
      !JSON.stringify(page).includes(SECRET) && !JSON.stringify(page).includes(TOKEN),
      `paged export ${page.items.length}+${page2.items.length}/${page.total}, ${listed.count} dataset(s) listed`);
    await h.expectThrow("27b unfinalized dataset cannot be exported",
      () => exportDataset(base44, caller, { dataset_id: tampered.dataset.dataset_id }), "DATASET_NOT_FINALIZED");

    const lineage = await getLineage(base44, caller, { dataset_id: sft.dataset_id, item_key: item1.item_key });
    const prefLineage = await getLineage(base44, caller, { dataset_id: pref.dataset_id, item_key: prefItems[0].item_key });
    h.check("28 lineage inspection works",
      lineage.complete === true && lineage.chain.dataset.dataset_id === sft.dataset_id && lineage.chain.item.item_key === item1.item_key &&
      lineage.chain.trajectory.trajectory_id === e1.traj.id && lineage.chain.trajectory.sealed === true &&
      lineage.chain.evaluation.evaluation_id === e1.evaluation.id && lineage.chain.reward.reward_id === e1.reward.id &&
      lineage.chain.source.project_id === proj.id && lineage.chain.source.version_number === 3 &&
      prefLineage.chain.rejected.trajectory_id === e2.traj.id,
      "dataset → version → item → trajectory → evaluation → reward → source project/version resolves");

    // ---------- 29-30 · lifecycle safety ----------
    const lifecycle = await createDataset(base44, caller, spec({ name: "Cert Lifecycle" }));
    created.datasets.push(lifecycle.dataset.dataset_id);
    await h.expectThrow("29 validation before build refused", () => validateDataset(base44, caller, { dataset_id: lifecycle.dataset.dataset_id }), "DATASET_NOT_BUILT");
    await h.expectThrow("29b finalization before validation refused", () => finalizeDataset(base44, caller, { dataset_id: lifecycle.dataset.dataset_id }), "DATASET_NOT_VALIDATED");
    const lcBuilt = await buildDataset(base44, caller, { dataset_id: lifecycle.dataset.dataset_id });
    const lcValidated = await validateDataset(base44, caller, { dataset_id: lifecycle.dataset.dataset_id });
    h.check("29c states transition safely",
      lifecycle.dataset.status === "DRAFT" && lcBuilt.dataset.status === "BUILT" && lcValidated.dataset.status === "VALIDATED" &&
      !lcValidated.dataset.finalized && !!lcValidated.dataset.validated_at,
      "DRAFT → BUILDING → BUILT → VALIDATED, and only VALIDATED may finalize");
    h.check("30 validation runs before finalization",
      Array.isArray(sftDs.validation.checks) && sftDs.validation.checks.length >= 8 && sftDs.validation.ok === true &&
      ["item_count", "provenance_completeness", "lineage_integrity", "authorization", "duplicate_detection", "schema_correctness", "secret_scrubbing", "checksum"].every((n) => sftDs.validation.checks.some((c) => c.name === n)) &&
      !!sftDs.validated_at && sftDs.validated_at <= sftDs.finalized_at,
      `${sftDs.validation.checks.length} checks run, re-verified at finalization`);

    // ---------- 31-35 · source layers untouched ----------
    h.check("31 existing Trajectory records unchanged",
      JSON.stringify(await svc.entities.Trajectory.filter({ project_id: proj.id }, "created_date", 50)) === before.trajectories &&
      (await svc.entities.TrajectoryEvent.filter({ project_id: proj.id }, "sequence", 50)).length === before.events,
      "trajectory rows and event history byte-identical");
    h.check("32 existing Evaluation records unchanged", JSON.stringify(await svc.entities.Evaluation.filter({ project_id: proj.id }, "created_date", 50)) === before.evaluations, "evaluations byte-identical");
    h.check("33 existing Reward records unchanged", JSON.stringify(await svc.entities.Reward.filter({ project_id: proj.id }, "created_date", 50)) === before.rewards, "rewards byte-identical");
    h.check("34 existing Memory records unchanged", JSON.stringify(await svc.entities.MemoryItem.filter({ project_id: proj.id }, "created_date", 50)) === before.memory, "memory items byte-identical");
    h.check("35 existing AI Builder behavior unchanged",
      JSON.stringify(await svc.entities.AIRun.filter({ project_id: proj.id }, "created_date", 50)) === before.runs &&
      JSON.stringify(await svc.entities.Project.get(proj.id)) === before.project,
      "runs and project pointer untouched — the builder is not modified by dataset construction");

    return harnessResponse(h);
  } catch (error) {
    return harnessError(h, error);
  } finally {
    for (const p of [proj, otherProj]) {
      if (!p) continue;
      for (const d of await svc.entities.Dataset.filter({ project_id: p.id }, "created_date", 100).catch(() => [])) {
        await purgeBy(svc, "DatasetItem", { dataset_id: d.id });
        await svc.entities.Dataset.delete(d.id).catch(() => {});
      }
      for (const name of ["MemoryItem", "Reward", "Evaluation", "TrajectoryEvent", "Trajectory", "AIRun", "TraceEvent", "AuditLog"]) {
        await purgeBy(svc, name, { project_id: p.id });
      }
      await svc.entities.Project.delete(p.id).catch(() => {});
    }
    for (const d of await svc.entities.Dataset.filter({ scope: "platform" }, "created_date", 100).catch(() => [])) {
      await purgeBy(svc, "DatasetItem", { dataset_id: d.id });
      await svc.entities.Dataset.delete(d.id).catch(() => {});
    }
    for (const id of created.datasets) {
      await purgeBy(svc, "DatasetItem", { dataset_id: id });
      await svc.entities.Dataset.delete(id).catch(() => {});
    }
    for (const w of [workspace, other]) if (w) await cleanupWorkspace(svc, w.id, ["AuditLog"]);
  }
}