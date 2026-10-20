// Certification for the read-only production learning dry run. Temporary workspace/projects only,
// all deleted at the end. Proves: zero persisted change, unchanged active policy, parity with a real
// cycle on the SAME temporary project (eligibility, checksums, verdict, regression), blocked writes,
// NO_ELIGIBLE_EXAMPLES, and regression against an existing promoted reference.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createHarness, harnessResponse, harnessError } from "../../shared/testHarness.ts";
import { cleanupAndVerify, cleanupDetail } from "../../shared/certCleanup.ts";
import { createDatasetEpisode } from "../../shared/datasetTestFixtures.ts";
import { getActivePolicy } from "../../shared/routingPolicy.ts";
import { MODEL_REGISTRY } from "../../shared/modelGateway.ts";
import { runLearningCycle } from "../../shared/productionLearning.ts";
import { readOnlyDb, lineageIds } from "../../shared/productionLearningDryRun.ts";
import { verifyDryEvalItems } from "../../shared/dryRunEvalParity.ts";
import { computeEvaluation } from "../../shared/evaluation.ts";

const ENTITIES = ["Evaluation", "Reward", "Dataset", "DatasetItem", "CandidateEvaluation", "LearningCycle", "RoutingPolicy", "AuditLog", "TrajectoryEvent"];
const GOOD = { task_completion: 1, build: 1, runtime: 1 };
const BAD = { task_completion: 0, build: 0, runtime: 0 };

export default async function (req) {
  const base44 = createClientFromRequest(req);
  const svc = { entities: base44.asServiceRole.entities, asServiceRole: base44.asServiceRole };
  const h = createHarness();
  // Targeted batches (rate limits): "core" = sections 1-3 + 7, "parity" = sections 1-6, default = all.
  const part = String((await req.json().catch(() => ({})))?.part || "all");
  const created = { workspaces: [], projects: [] };
  let failure = null;
  try {
    const caller = await base44.auth.me().catch(() => null);
    if (!caller) return Response.json({ ok: false, error: "This suite must run as an authenticated workspace owner" }, { status: 401 });
    const model = MODEL_REGISTRY.filter((m) => m.enabled)[0];
    const candidate = { model_id: model.model_id, model_version: "1", routing_policy_version: "1.0.0" };
    const ws = await svc.entities.Workspace.create({ name: `pldr-cert-${Date.now()}`, owner_id: caller.id, credits_balance: 50 });
    created.workspaces.push(ws.id);
    const proj = await svc.entities.Project.create({ workspace_id: ws.id, name: "pldr-project", status: "ready", version_count: 3 });
    const empty = await svc.entities.Project.create({ workspace_id: ws.id, name: "pldr-no-evidence", status: "ready", version_count: 1 });
    created.projects.push(proj.id, empty.id);
    const episode = (project, o = {}) => createDatasetEpisode(svc, {
      project, model_id: model.model_id, model_provider: model.upstream_provider,
      scores: GOOD, reward: 0.9, duration_ms: 40000, ...o,
    });
    await episode(proj, { prompt: "Add a notes page" });
    await episode(proj, { prompt: "Add a weather widget", duration_ms: 38000 });
    await episode(proj, { prompt: "Broken build page", status: "FAILED", buildStatus: "failed", runtimeOk: false, scores: BAD });
    await episode(empty, { prompt: "Only a failure", status: "FAILED", buildStatus: "failed", runtimeOk: false, scores: BAD });

    const snapshot = async (pid) => {
      const counts = {};
      for (const name of ENTITIES) counts[name] = (await svc.entities[name].filter({ project_id: pid }, "created_date", 500)).length;
      const trajs = await svc.entities.Trajectory.filter({ project_id: pid }, "created_date", 100);
      const notes = trajs.map((t) => [t.id, t.event_count || 0, JSON.stringify(t.learning_eligibility || null)]).sort();
      const policy = (await getActivePolicy(svc, { scope: "project", project_id: pid }))?.policy_version || null;
      return JSON.stringify({ counts, notes, policy });
    };
    const same = async (label, pid, fn) => {
      const before = await snapshot(pid);
      const out = await fn();
      const after = await snapshot(pid);
      h.check(label, before === after, before === after ? "no record, note, event or policy changed" : `before ${before} after ${after}`);
      return out;
    };
    const dry = (pid, c = candidate) => runLearningCycle(base44, caller, { project_id: pid, candidate: c, dry_run: true });

    // 1. zero-write dry run before any real cycle
    const dry1 = await same("1 dry run changes no record, eligibility note, event or active policy", proj.id, () => dry(proj.id));
    h.check("1b dry run reports a full simulated verdict", dry1.dry_run === true && dry1.capture?.eligible === 2 && dry1.promotion?.code === "PROMOTE" && dry1.would_promote === true && !dry1.cycle,
      `eligible ${dry1.capture?.eligible}, verdict ${dry1.promotion?.code}, failure ${dry1.failure_code} ${dry1.error || ""}`);

    // 2. blocked writes
    const ro = readOnlyDb(base44);
    for (const [entity, method] of [["Evaluation", "create"], ["RoutingPolicy", "update"], ["DatasetItem", "delete"], ["Reward", "bulkCreate"]]) {
      await h.expectThrow(`2 ${entity}.${method} through the dry-run view is blocked`, async () => ro.entities[entity][method]({}), "DRY_RUN_WRITE_BLOCKED");
    }

    // 3. no eligible examples
    const dryEmpty = await same("3 NO_ELIGIBLE_EXAMPLES dry run writes nothing", empty.id, () => dry(empty.id));
    h.check("3b NO_ELIGIBLE_EXAMPLES is reported", dryEmpty.failure_code === "NO_ELIGIBLE_EXAMPLES", dryEmpty.failure_code);

    if (part !== "parity") {
    // 7. read-only mode guarantees beyond the happy path
    h.check("7a simulation responses are labelled simulation / not persisted", dry1.mode === "simulation" && dry1.persisted === false, `${dry1.mode}/${dry1.persisted}`);
    for (const [root, name] of [["integrations", "Core"], ["functions", "invoke"]]) {
      await h.expectThrow(`7b ${root} through the dry-run view is blocked`, async () => (root === "functions" ? ro.functions.invoke("x", {}) : ro.integrations.Core.InvokeLLM({ prompt: "x" })), "DRY_RUN_WRITE_BLOCKED");
    }
    h.check("7c the service-role escape resolves to the same read-only view", ro.asServiceRole === ro, "");
    const retry = await same("7d a retried simulation writes nothing", proj.id, () => dry(proj.id));
    h.check("7e a retried simulation is deterministic", retry.datasets?.training?.checksum === dry1.datasets?.training?.checksum && retry.promotion?.code === dry1.promotion?.code, `${retry.datasets?.training?.checksum} vs ${dry1.datasets?.training?.checksum}`);
    const foreignWs = await svc.entities.Workspace.create({ name: `pldr-cert-foreign-${Date.now()}`, owner_id: `foreign-${Date.now()}`, credits_balance: 0 });
    created.workspaces.push(foreignWs.id);
    const foreign = await svc.entities.Project.create({ workspace_id: foreignWs.id, name: "pldr-foreign", status: "ready", version_count: 1 });
    created.projects.push(foreign.id);
    await same("7f a refused (unauthorized) simulation writes nothing", foreign.id, async () => {
      let code = null;
      try { await dry(foreign.id); } catch (e) { code = e.code || e.status; }
      h.check("7g a non-member cannot simulate another workspace's project", code !== null, String(code));
    });
    await same("7h a failing simulation (unknown project) writes nothing", proj.id, async () => {
      let code = null;
      try { await dry(`missing-${Date.now()}`); } catch (e) { code = e.code || e.status; }
      h.check("7i a failing simulation surfaces an error, never a partial persisted result", code !== null, String(code));
    });
    const realEmpty = await runLearningCycle(base44, caller, { project_id: empty.id, candidate });
    h.check("7j a persisted run is labelled persisted and keeps normal behavior", realEmpty.mode === "persisted" && realEmpty.persisted === true && !!realEmpty.cycle?.cycle_id, `${realEmpty.mode} ${realEmpty.cycle?.status}`);

    }

    if (part !== "core") {
    // 4. parity with a real cycle on the SAME temporary project
    const real1 = (await runLearningCycle(base44, caller, { project_id: proj.id, candidate })).cycle;
    const prov = real1.dataset_provenance || {};
    h.check("4a eligibility parity", dry1.capture.eligible === real1.capture.eligible && JSON.stringify(dry1.capture.exclusion_reasons) === JSON.stringify(real1.capture.exclusion_reasons),
      `dry ${dry1.capture.eligible}/${JSON.stringify(dry1.capture.exclusion_reasons)} real ${real1.capture.eligible}/${JSON.stringify(real1.capture.exclusion_reasons)}`);
    h.check("4b training dataset checksum + count parity", dry1.datasets.training.checksum === prov.training?.checksum && dry1.datasets.training.item_count === prov.training?.item_count,
      `dry ${dry1.datasets.training.checksum}/${dry1.datasets.training.item_count} real ${prov.training?.checksum}/${prov.training?.item_count}`);
    h.check("4c verdict parity", dry1.promotion.code === real1.promotion?.code && real1.status === "PROMOTED", `dry ${dry1.promotion.code} real ${real1.promotion?.code} (${real1.status} ${real1.error || ""})`);

    // 5. against the now-existing promoted reference (identical candidate) + evaluation checksum parity
    const dry2 = await same("5 dry run with a promoted reference writes nothing", proj.id, () => dry(proj.id));
    // real1's eligibility stamping bumps episode revisions, so dry2 is NOT at real1's state and no real
    // cycle runs from dry2's exact state. Contract: each evaluation id is a stored evaluation whose
    // fingerprint matches the current trajectory, or dryrun_eval_<recomputed fingerprint>; keys + count match real1.
    const dryEval = dry2.datasets.evaluation || {};
    const realKeys = (await svc.entities.DatasetItem.filter({ dataset_id: real1.evaluation_dataset_id }, "item_key", 100)).map((r) => r.item_key);
    const parity = await verifyDryEvalItems(dryEval.items || [], {
      expectedCount: prov.evaluation?.item_count, expectedKeys: realKeys,
      stored: (id) => svc.entities.Evaluation.get(id).catch(() => null),
      recompute: async (tid) => (await computeEvaluation(svc, { trajectory: await svc.entities.Trajectory.get(tid) })).inputs_hash,
    });
    const evalOk = parity.ok && dryEval.item_count === prov.evaluation?.item_count;
    let evalDetail = `dry ${dryEval.item_count} real ${prov.evaluation?.item_count} items${parity.problems.length ? ` | ${parity.problems.join("; ")}` : " | every evaluation id reused-or-placeholder as contracted"}`;
    if (!evalOk) {
      const realRows = await svc.entities.DatasetItem.filter({ dataset_id: real1.evaluation_dataset_id }, "item_key", 100);
      const pick = (r) => r && { item_checksum: r.item_checksum, evaluation_id: r.evaluation_id || null, transformation_version: r.transformation_version, lineage: lineageIds(r.lineage) };
      const keys = [...new Set([...(dryEval.items || []).map((i) => i.item_key), ...realRows.map((r) => r.item_key)])].sort();
      const diffs = keys.map((key) => {
        const d = pick((dryEval.items || []).find((i) => i.item_key === key)), r = pick(realRows.find((x) => x.item_key === key));
        const fields = !d || !r ? ["missing"] : Object.keys(d).filter((f) => JSON.stringify(d[f]) !== JSON.stringify(r[f]));
        return { key, fields, dry: d, real: r };
      }).filter((x) => x.fields.length);
      evalDetail += ` | diffs ${JSON.stringify(diffs).slice(0, 3000)}`;
    }
    h.check("5b evaluation dataset checksum + count parity", evalOk, evalDetail);
    h.check("5c identical candidate passes against the reference", dry2.reference_cycle_id === real1.cycle_id && dry2.regression?.verdict === "PASS" && dry2.promotion?.code === "PROMOTE",
      `${dry2.regression?.verdict} ${dry2.promotion?.code}`);

    // 6. regression comparison against the promoted reference (different candidate), then real parity
    const candidate2 = { ...candidate, model_version: "2" };
    const dry3 = await same("6 regression dry run writes nothing", proj.id, () => dry(proj.id, candidate2));
    const real2 = (await runLearningCycle(base44, caller, { project_id: proj.id, candidate: candidate2 })).cycle;
    h.check("6b regression measured against the reference", dry3.regression?.comparable_metrics > 0, `${dry3.regression?.verdict} over ${dry3.regression?.comparable_metrics} metric(s)`);
    h.check("6c regression + verdict parity with the real cycle", dry3.regression?.verdict === real2.regression?.verdict && dry3.promotion?.code === real2.promotion?.code,
      `dry ${dry3.regression?.verdict}/${dry3.promotion?.code} real ${real2.regression?.verdict}/${real2.promotion?.code} | real2 status ${real2.status} failure_code ${real2.failure_code || null} error ${real2.error || null}`);
    }
  } catch (error) {
    failure = error;
  }
  // Teardown runs fully BEFORE the report is built; its errors are collected, never thrown or hidden.
  // Covers every type the fixture (AIRun, Trajectory, Evaluation, Reward) and the real cycles create.
  const plan = [];
  for (const pid of created.projects) {
    for (const entity of ["CandidateEvaluation", "DatasetItem", "Dataset", "LearningCycle", "RoutingPolicy", "RoutingDecision", "Reward", "Evaluation", "TrajectoryEvent", "Trajectory", "AIRun", "TraceEvent", "AuditLog"]) {
      plan.push({ entity, query: { project_id: pid } });
    }
    plan.push({ entity: "Project", query: { id: pid } });
  }
  for (const wid of created.workspaces) {
    for (const entity of ["AuditLog", "LearningCycle", "RoutingPolicy", "CandidateEvaluation"]) plan.push({ entity, query: { workspace_id: wid } });
    plan.push({ entity: "Workspace", query: { id: wid } });
  }
  const cleanup = await cleanupAndVerify(svc, plan).catch((e) => ({ ok: false, errors: [{ op: "cleanup", error: String(e?.message || e) }], leftovers: [], verifyErrors: [] }));
  h.check("teardown: cleanup deleted and verified every temporary record", cleanup.ok, cleanupDetail(cleanup));
  // Compact report: every check is listed; details are kept only for failures so nothing is truncated.
  const all = h.results || [];
  const failedChecks = all.filter((r) => !r.ok);
  return Response.json({
    ok: !failure && failedChecks.length === 0, passed: all.length - failedChecks.length, failed: failedChecks.length,
    error: failure ? String(failure?.message || failure) : null,
    checks: all.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : ` :: ${r.detail}`}`),
  }, { status: failure ? 500 : 200 });
}